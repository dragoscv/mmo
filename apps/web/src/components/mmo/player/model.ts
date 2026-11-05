/**
 * Pure player logic (no DOM, no React): stream URLs, file/version picking, resume position, Watch Together
 * decisions, keyboard map, scrubber sprite mapping, formatting. Mirrors tv-tizen `screens/player/model.ts`
 * + `prefs.ts` and tv-android `player/PlayerData.kt`. Unit-tested in `model.test.ts`.
 */
import type { HubMedia, MediaKind, Profile, ProgressEntry, SeasonEpisode, VersionedFile } from "@/lib/mmo/media-types";
import { driftAction, expectedPosition, type DriftAction, type PlaybackAnchor } from "@/lib/mmo/sync-math";

// ─── auth + URLs ─────────────────────────────────────────────────────────────

/** Paired browser (device token) or Watch Together guest (invite; the server maps it to the room's file only). */
export type StreamAuth =
    | { kind: "token"; token: string; userId: string }
    | { kind: "invite"; invite: string };

const enc = encodeURIComponent;
const trimBase = (b: string): string => b.replace(/\/+$/, "");

/** Query for URLs consumed by <video>/hls.js/<img> (no custom headers possible). */
export function authQuery(a: StreamAuth): string {
    if (a.kind === "invite") return `inv=${enc(a.invite)}`;
    const parts = [`t=${enc(a.token)}`];
    if (a.userId) parts.push(`u=${enc(a.userId)}`);
    return parts.join("&");
}

/** Headers for JSON routes that do not read `?t=` (file info, markers). Guests authenticate by `?inv=`. */
export function authHeaders(a: StreamAuth): Record<string, string> {
    if (a.kind === "invite") return {};
    const h: Record<string, string> = { "x-device-token": a.token };
    if (a.userId) h["x-user-id"] = a.userId;
    return h;
}

/** `path` + `?inv=` for guests (header auth is used otherwise). */
export function guestPath(path: string, a: StreamAuth): string {
    if (a.kind !== "invite") return path;
    return `${path}${path.includes("?") ? "&" : "?"}inv=${enc(a.invite)}`;
}

export interface HlsOpts {
    /** Absolute start (s); the element clock is relative to it. */
    startSec?: number;
    /** `0:a:<n>` ordinal (server ≥ 3.7). 0 = file default. */
    audio?: number;
    caps?: readonly string[];
    /** Server ignores anything but "original" unless the owner enabled video transcoding. */
    quality?: "original" | "1080p" | "720p" | "480p";
}

/** `GET /video/stream/:fileId?q=&start=&caps=&audio=&t=&u=` (or `&inv=` for guests). */
export function hlsUrl(baseUrl: string, fileId: string, auth: StreamAuth, o: HlsOpts = {}): string {
    const q = new URLSearchParams();
    q.set("q", o.quality ?? "original");
    const start = Math.max(0, Math.floor(o.startSec ?? 0));
    if (start > 0) q.set("start", String(start));
    if (o.caps && o.caps.length > 0) q.set("caps", o.caps.join(","));
    const audio = Math.max(0, Math.floor(o.audio ?? 0));
    if (audio > 0) q.set("audio", String(audio));
    return `${trimBase(baseUrl)}/video/stream/${enc(fileId)}?${q.toString()}&${authQuery(auth)}`;
}

export function subtitleUrl(baseUrl: string, fileId: string, track: number, auth: StreamAuth): string {
    return `${trimBase(baseUrl)}/video/subs/${enc(fileId)}/${track}?${authQuery(auth)}`;
}

export function spriteUrl(baseUrl: string, fileId: string, auth: StreamAuth): string {
    return `${trimBase(baseUrl)}/video/thumbs/${enc(fileId)}/sprite.jpg?${authQuery(auth)}`;
}

/** One 640 px keyframe ~10 % into the file (server caches it); card placeholder art. */
export function stillUrl(baseUrl: string, fileId: string, auth: StreamAuth): string {
    return `${trimBase(baseUrl)}/video/thumbs/${enc(fileId)}/still.jpg?${authQuery(auth)}`;
}

export function pauseStreamUrl(baseUrl: string, fileId: string, auth: StreamAuth): string {
    return `${trimBase(baseUrl)}/video/stream/${enc(fileId)}/pause?${authQuery(auth)}`;
}

/**
 * Codecs this browser decodes through MSE (sent as `caps` so the server remuxes instead of converting audio).
 * Video is never re-encoded either way; audio the browser lacks becomes AAC stereo server-side.
 */
export function browserCaps(isSupported: (mime: string) => boolean): string[] {
    const caps = ["h264", "aac", "mp3"];
    const probe = (mime: string) => { try { return isSupported(mime); } catch { return false; } };
    if (probe('video/mp4; codecs="hvc1.1.6.L120.90"') || probe('video/mp4; codecs="hev1.1.6.L120.90"')) caps.splice(1, 0, "hevc");
    if (probe('audio/mp4; codecs="ac-3"')) caps.push("ac3");
    if (probe('audio/mp4; codecs="ec-3"')) caps.push("eac3");
    return caps;
}

// ─── routes / links ──────────────────────────────────────────────────────────

export interface PlayTarget {
    kind: MediaKind;
    tmdbId: number;
    file?: string | null;
    season?: number | null;
    episode?: number | null;
    startSec?: number | null;
    room?: string | null;
}

/** `/media/play/<kind>/<tmdbId>?file=&s=&e=&t=&room=` */
export function playHref(p: PlayTarget): string {
    const q = new URLSearchParams();
    if (p.file) q.set("file", p.file);
    if (p.season != null) q.set("s", String(p.season));
    if (p.episode != null) q.set("e", String(p.episode));
    if (p.startSec != null && p.startSec > 0) q.set("t", String(Math.floor(p.startSec)));
    if (p.room) q.set("room", p.room);
    const qs = q.toString();
    return `/media/play/${p.kind}/${p.tmdbId}${qs ? `?${qs}` : ""}`;
}

/** Guest join link (same format the TVs encode in their QR codes). */
export function inviteLink(origin: string, serverBaseUrl: string, invite: string): string {
    return `${trimBase(origin)}/together?server=${enc(trimBase(serverBaseUrl))}&inv=${enc(invite)}`;
}

/** Validates the `server` query of the guest page: http(s) origin (+ optional path), no credentials. */
export function parseServerUrl(raw: string | null | undefined): string | null {
    if (!raw) return null;
    let u: URL;
    try { u = new URL(raw.trim()); } catch { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password || !u.hostname) return null;
    return trimBase(`${u.origin}${u.pathname === "/" ? "" : u.pathname}`);
}

/** Invites are `<roomId>.<expMs>.<mac>`; null when malformed or already expired (server still decides). */
export function inviteExpiry(invite: string): number | null {
    const parts = invite.split(".");
    if (parts.length !== 3 || !parts[0] || !parts[2]) return null;
    const exp = Number(parts[1]);
    return Number.isFinite(exp) && exp > 0 ? exp : null;
}

/** Query param → finite non-negative integer, else null. */
export function intParam(v: string | null | undefined): number | null {
    if (v == null || v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

// ─── file / version picking ──────────────────────────────────────────────────

/** Best version: the requested file when present, else highest `version.rank`, then the larger file. */
export function pickFile(files: readonly VersionedFile[], wanted?: string | null): VersionedFile | null {
    const usable = files.filter((f) => !!f.serverFileId);
    if (wanted) {
        const hit = usable.find((f) => f.serverFileId === wanted);
        if (hit) return hit;
    }
    let best: VersionedFile | null = null;
    for (const f of usable) {
        if (!best) { best = f; continue; }
        const r = (f.version?.rank ?? 0) - (best.version?.rank ?? 0);
        if (r > 0 || (r === 0 && f.size > best.size)) best = f;
    }
    return best;
}

/** Versions for the menu, best first. */
export function sortVersions(files: readonly VersionedFile[]): VersionedFile[] {
    return [...files].filter((f) => !!f.serverFileId)
        .sort((a, b) => (b.version?.rank ?? 0) - (a.version?.rank ?? 0) || b.size - a.size);
}

/** Files of one episode from a title-level file list. */
export function episodeFiles(files: readonly VersionedFile[], season: number, episode: number): VersionedFile[] {
    return files.filter((f) => f.season === season && f.episode === episode);
}

/** First episode (season, episode) that has a local file, ordered by season then episode. */
export function firstEpisodeWithFile(files: readonly VersionedFile[]): { season: number; episode: number } | null {
    const eps = files.filter((f) => f.season != null && f.episode != null && f.serverFileId)
        .sort((a, b) => (a.season! - b.season!) || (a.episode! - b.episode!));
    const f = eps[0];
    return f ? { season: f.season!, episode: f.episode! } : null;
}

/** Next playable episode after `episode`: later in this season, else the first of the following season. */
export function nextPlayable(
    current: readonly SeasonEpisode[], season: number, episode: number, following: readonly SeasonEpisode[] | null,
): { season: number; episode: number; ep: SeasonEpisode; file: VersionedFile } | null {
    const later = current.filter((x) => x.episodeNumber > episode).sort((a, b) => a.episodeNumber - b.episodeNumber);
    for (const ep of later) {
        const file = pickFile(ep.files ?? []);
        if (file) return { season, episode: ep.episodeNumber, ep, file };
    }
    for (const ep of [...(following ?? [])].sort((a, b) => a.episodeNumber - b.episodeNumber)) {
        const file = pickFile(ep.files ?? []);
        if (file) return { season: season + 1, episode: ep.episodeNumber, ep, file };
    }
    return null;
}

// ─── resume ──────────────────────────────────────────────────────────────────

export const RESUME_MIN_SEC = 10;
export const FINISHED_RATIO = 0.95;

/** Progress entry for a movie (s/e 0) or one episode. */
export function progressFor(entries: readonly ProgressEntry[], kind: MediaKind, season?: number | null, episode?: number | null): ProgressEntry | null {
    const s = kind === "tv" ? season ?? 0 : 0;
    const e = kind === "tv" ? episode ?? 0 : 0;
    return entries.find((p) => p.kind === kind && (p.season ?? 0) === s && (p.episode ?? 0) === e) ?? null;
}

/**
 * Start position: an explicit `t` wins (0 = from the start); else the saved progress when it is past 10 s,
 * not completed and not in the last 5 % / 30 s; else 0.
 */
export function resumePosition(o: { explicit?: number | null; progress?: ProgressEntry | null; durationSec?: number | null }): number {
    if (o.explicit != null && Number.isFinite(o.explicit) && o.explicit >= 0) return Math.floor(o.explicit);
    const p = o.progress;
    if (!p || p.completed || !(p.positionSec >= RESUME_MIN_SEC)) return 0;
    const dur = o.durationSec && o.durationSec > 0 ? o.durationSec : p.durationSec;
    if (dur > 0 && (p.positionSec >= dur * FINISHED_RATIO || p.positionSec >= dur - 30)) return 0;
    return Math.floor(p.positionSec);
}

/** Progress payload completion flag (≥ 95 % watched). */
export function isCompleted(positionSec: number, durationSec: number): boolean {
    return durationSec > 0 && positionSec / durationSec >= FINISHED_RATIO;
}

// ─── Watch Together ──────────────────────────────────────────────────────────

/** Follower drift step: rate nudge (±5 %) under 1.5 s, hard seek above (constants in sync-math.ts). */
export function followerAction(actualSec: number, anchor: PlaybackAnchor, serverNowMs: number, correcting: boolean): DriftAction {
    return driftAction(actualSec, expectedPosition(anchor, serverNowMs), correcting);
}

export type RoomApply =
    | { kind: "schedule"; seekTo: number | null; delayMs: number }
    | { kind: "play"; seekTo: number | null }
    | { kind: "pause"; seekTo: number | null };

/**
 * What a member does when `room:state` arrives (port of tv-tizen `useRoomSync`): a future play anchor is
 * scheduled at `atServerMs` (seek first if > 0.3 s off), a running one is joined (seek if > 1 s off), a
 * paused one pauses (seek if > 0.5 s off).
 */
export function roomApply(playing: boolean, anchor: PlaybackAnchor, serverNowMs: number, actualSec: number): RoomApply {
    if (playing && anchor.playing) {
        if (anchor.atServerMs > serverNowMs + 30) {
            return { kind: "schedule", seekTo: Math.abs(actualSec - anchor.positionSec) > 0.3 ? anchor.positionSec : null, delayMs: anchor.atServerMs - serverNowMs };
        }
        const exp = expectedPosition(anchor, serverNowMs);
        return { kind: "play", seekTo: Math.abs(actualSec - exp) > 1 ? exp : null };
    }
    return { kind: "pause", seekTo: Math.abs(actualSec - anchor.positionSec) > 0.5 ? anchor.positionSec : null };
}

export function hubMediaOf(o: {
    fileId: string; kind?: MediaKind; tmdbId?: number; season?: number | null; episode?: number | null;
    title: string; posterPath?: string | null; durationSec?: number | null;
}): HubMedia {
    const m: HubMedia = { fileId: o.fileId, title: o.title };
    if (o.kind) m.kind = o.kind;
    if (o.tmdbId) m.tmdbId = o.tmdbId;
    if (o.season != null) m.season = o.season;
    if (o.episode != null) m.episode = o.episode;
    if (o.posterPath) m.posterPath = o.posterPath;
    if (o.durationSec && o.durationSec > 0) m.durationSec = Math.round(o.durationSec);
    return m;
}

/** `cmd play` args the TVs accept (tv-tizen App.tsx / tv-android MainActivity: fileId required). */
export function playCommandArgs(o: {
    fileId: string; kind: MediaKind; tmdbId: number; season?: number | null; episode?: number | null;
    startSec?: number | null; title?: string;
}): Record<string, unknown> {
    const a: Record<string, unknown> = { fileId: o.fileId, kind: o.kind, tmdbId: o.tmdbId };
    if (o.season != null) a.season = o.season;
    if (o.episode != null) a.episode = o.episode;
    if (o.startSec != null && o.startSec > 0) a.startSec = Math.floor(o.startSec);
    if (o.title) a.title = o.title;
    return a;
}

// ─── keyboard ────────────────────────────────────────────────────────────────

export type PlayerKey =
    | { type: "toggle" }
    | { type: "seekBy"; delta: number }
    | { type: "seekPercent"; pct: number }
    | { type: "volumeBy"; delta: number }
    | { type: "mute" }
    | { type: "fullscreen" }
    | { type: "subtitles" }
    | { type: "back" };

export const SEEK_STEP = 10;
export const VOLUME_STEP = 0.1;

export interface KeyLike { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }

/** Space/K play-pause, ←/→ and J/L ±10 s, ↑/↓ volume, M mute, F fullscreen, C subtitles, Esc back, 0–9 jump. */
export function keyAction(e: KeyLike): PlayerKey | null {
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    switch (e.key) {
        case " ": case "Spacebar": case "k": case "K": case "MediaPlayPause": return { type: "toggle" };
        case "ArrowLeft": case "j": case "J": return { type: "seekBy", delta: -SEEK_STEP };
        case "ArrowRight": case "l": case "L": return { type: "seekBy", delta: SEEK_STEP };
        case "ArrowUp": return { type: "volumeBy", delta: VOLUME_STEP };
        case "ArrowDown": return { type: "volumeBy", delta: -VOLUME_STEP };
        case "m": case "M": return { type: "mute" };
        case "f": case "F": return { type: "fullscreen" };
        case "c": case "C": return { type: "subtitles" };
        case "Escape": return { type: "back" };
    }
    if (/^[0-9]$/.test(e.key)) return { type: "seekPercent", pct: Number(e.key) * 10 };
    return null;
}

/** Keys that must reach a focused control instead (button activation, slider arrows, text input). */
export function keyBelongsToControl(key: string, tag: string, role: string | null, editable: boolean): boolean {
    const t = tag.toUpperCase();
    if (editable || t === "INPUT" || t === "TEXTAREA" || t === "SELECT") return key !== "Escape";
    const isButton = t === "BUTTON" || t === "A" || role === "button" || role === "radio" || role === "menuitem" || role === "menuitemradio" || role === "tab";
    if (isButton && (key === " " || key === "Enter")) return true;
    const nav = key.startsWith("Arrow") || key === "Home" || key === "End" || key === "PageUp" || key === "PageDown";
    if (role === "slider" || role === "radiogroup" || role === "radio" || role === "menuitemradio" || role === "tab") return nav;
    return false;
}

// ─── scrubber sprite (server ensureSprite: 12×12 tiles of 160×90) ───────────

export const SPRITE_GRID = 12;
export interface SpriteGrid { intervalSec: number; cells: number }

/** interval = max(2, ceil(duration / 144)) s, cells = min(144, ceil(duration / interval)). */
export function spriteGrid(durationSec: number): SpriteGrid | null {
    if (!(durationSec >= 30)) return null;
    const target = SPRITE_GRID * SPRITE_GRID;
    const intervalSec = Math.max(2, Math.ceil(durationSec / target));
    return { intervalSec, cells: Math.max(1, Math.min(target, Math.ceil(durationSec / intervalSec))) };
}

export function spriteTile(g: SpriteGrid, positionSec: number): number {
    return Math.max(0, Math.min(g.cells - 1, Math.floor(Math.max(0, positionSec) / g.intervalSec)));
}

/** Percent `background-position` (background-size must be 1200% 1200%). */
export function tilePosition(tile: number): string {
    const pct = (n: number) => `${(n / (SPRITE_GRID - 1)) * 100}%`;
    return `${pct(tile % SPRITE_GRID)} ${pct(Math.floor(tile / SPRITE_GRID))}`;
}

// ─── formatting ──────────────────────────────────────────────────────────────

/** 83 → "1:23", 3723 → "1:02:03". */
export function formatTime(sec: number): string {
    const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
    return `${h > 0 ? `${h}:` : ""}${mm}:${String(r).padStart(2, "0")}`;
}

export function endsAtDate(remainingSec: number, rate: number, now: number): Date {
    return new Date(now + Math.max(0, remainingSec) / (rate > 0 ? rate : 1) * 1000);
}

export function channelsLabel(ch: number): string {
    if (ch >= 8) return "7.1";
    if (ch >= 6) return "5.1";
    if (ch === 2) return "2.0";
    if (ch === 1) return "1.0";
    return `${ch}ch`;
}

export function resolutionLabel(w: number | null | undefined, h: number | null | undefined): string {
    if (!w || !h) return "";
    if (w >= 3800 || h >= 2100) return `2160p (${w}×${h})`;
    if (w >= 1900 || h >= 1060) return `1080p (${w}×${h})`;
    if (w >= 1260 || h >= 700) return `720p (${w}×${h})`;
    return `${h}p (${w}×${h})`;
}

export function bitrateLabel(sizeBytes: number | null | undefined, durationSec: number | null | undefined): string {
    if (!durationSec || durationSec <= 0 || !sizeBytes) return "";
    return `${((sizeBytes * 8) / durationSec / 1e6).toFixed(1)} Mb/s`;
}

export function inSpan(s: { start: number; end: number } | null, t: number): boolean {
    return !!s && t >= s.start && t < s.end - 1;
}

// ─── tracks + profile prefs (same keys as the TVs) ──────────────────────────

export interface AudioTrack { index: number; codec: string; channels: number; lang: string | null; title: string | null }
export interface SubtitleTrack { index: number; codec: string; lang: string | null; title: string | null; forced: boolean }

/** `GET /video/file/:fileId/info` (subset). */
export interface FileInfo {
    fileId: string;
    path?: string;
    sizeBytes?: number;
    container: string | null;
    videoCodec: string | null;
    audioCodec: string | null;
    width: number | null;
    height: number | null;
    durationSec: number | null;
    hdr: string | null;
    audioTracks: AudioTrack[];
    subtitleTracks: SubtitleTrack[];
}

const IMAGE_SUBS = new Set(["hdmv_pgs_subtitle", "pgssub", "dvd_subtitle", "dvdsub", "dvb_subtitle", "xsub"]);

/** Text subtitle tracks only (bitmap tracks cannot become WebVTT); forced first, then file order. Values are ordinals. */
export function subtitleOrder(subs: readonly SubtitleTrack[]): number[] {
    const idx = subs.map((_, i) => i).filter((i) => !IMAGE_SUBS.has((subs[i]!.codec ?? "").toLowerCase()));
    return [...idx.filter((i) => subs[i]!.forced), ...idx.filter((i) => !subs[i]!.forced)];
}

export type SubSize = "small" | "medium" | "large" | "xlarge";
export type SubBg = "none" | "shadow" | "box";
export const SUB_SIZES: readonly SubSize[] = ["small", "medium", "large", "xlarge"];
export const SUB_BGS: readonly SubBg[] = ["none", "shadow", "box"];

export interface PlayerPrefs {
    autoplayNext: boolean;
    skipIntro: boolean;
    audioLang: string;
    subLang: string;
    subForcedOnly: boolean;
    subSize: SubSize;
    subBg: SubBg;
}

export const DEFAULT_PREFS: PlayerPrefs = {
    autoplayNext: true, skipIntro: false, audioLang: "", subLang: "", subForcedOnly: false, subSize: "medium", subBg: "shadow",
};

export function readPlayerPrefs(p: Pick<Profile, "prefs"> | null | undefined): PlayerPrefs {
    const prefs = p?.prefs ?? {};
    const legacy = prefs.autoplayNext === undefined && typeof prefs.autoplay === "boolean" ? prefs.autoplay : undefined;
    const b = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    const size = s(prefs.subSize), bg = s(prefs.subBg);
    return {
        autoplayNext: legacy ?? b(prefs.autoplayNext, true),
        skipIntro: b(prefs.skipIntro, false),
        audioLang: s(prefs.audioLang),
        subLang: s(prefs.subLang),
        subForcedOnly: b(prefs.subForcedOnly, false),
        subSize: (SUB_SIZES as readonly string[]).includes(size) ? (size as SubSize) : DEFAULT_PREFS.subSize,
        subBg: (SUB_BGS as readonly string[]).includes(bg) ? (bg as SubBg) : DEFAULT_PREFS.subBg,
    };
}

const ISO3: Record<string, string> = {
    ron: "ro", rum: "ro", eng: "en", fre: "fr", fra: "fr", ger: "de", deu: "de", spa: "es", ita: "it", hun: "hu",
    por: "pt", dut: "nl", nld: "nl", pol: "pl", tur: "tr", jpn: "ja", kor: "ko", rus: "ru", ukr: "uk", chi: "zh", zho: "zh",
};

/** "ron" / "ro-RO" / "RUM" → "ro". */
export function normLang(l: string | null | undefined): string {
    const s = (l ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
    return ISO3[s] ?? s;
}

/** Audio ordinal for the preferred language; 0 = file default. */
export function pickAudio(tracks: readonly AudioTrack[], prefs: PlayerPrefs): number {
    const want = normLang(prefs.audioLang);
    if (!want) return 0;
    const i = tracks.findIndex((a) => normLang(a.lang) === want);
    return i >= 0 ? i : 0;
}

/** Subtitle ordinal or -1 (forced-only / preferred language / forced track when no preference). */
export function pickSubtitle(info: Pick<FileInfo, "audioTracks" | "subtitleTracks">, prefs: PlayerPrefs, audioIdx: number): number {
    const subs = info.subtitleTracks;
    const usable = new Set(subtitleOrder(subs));
    if (usable.size === 0) return -1;
    const audioLang = normLang(info.audioTracks[audioIdx]?.lang);
    const forcedIn = (lang: string) => subs.findIndex((s, i) => usable.has(i) && s.forced && (!lang || normLang(s.lang) === lang));
    if (prefs.subForcedOnly) {
        const a = forcedIn(audioLang);
        return a >= 0 ? a : forcedIn("");
    }
    const want = normLang(prefs.subLang);
    if (want) {
        const full = subs.findIndex((s, i) => usable.has(i) && !s.forced && normLang(s.lang) === want);
        if (full >= 0) return full;
        const forced = forcedIn(want);
        if (forced >= 0) return forced;
    }
    return forcedIn("");
}

// ─── misc constants ──────────────────────────────────────────────────────────

export const SPEEDS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];
export type Fit = "contain" | "cover" | "zoom";
export const FITS: readonly Fit[] = ["contain", "cover", "zoom"];
/** Minutes; -1 = end of the current episode/film. */
export const SLEEP_OPTIONS: readonly number[] = [0, 15, 30, 60, 90, -1];
export const OSD_IDLE_MS = 3000;
export const UP_NEXT_LEAD_SEC = 30;
export const UP_NEXT_COUNTDOWN = 10;
export const STILL_WATCHING_AFTER = 3;
export const PROGRESS_INTERVAL_MS = 10_000;
/** Pause this long → tell the server to drop the ffmpeg session; resume reloads at the same position. */
export const PAUSE_KILL_MS = 30_000;
/** Reactions are content sent to other members (same set as the TVs). */
export const REACTIONS: readonly string[] = ["\u{1F602}", "\u{1F62E}", "\u{1F44F}", "\u{1F525}", "\u2764\uFE0F"];
