/**
 * Pure music helpers (WP16-40) shared by the web music engine (`web-music-player.ts`) and the music UI:
 * shuffle order, next/previous index per repeat mode, queue reorder/remove index maths, play-count
 * threshold, crossfade / automix planning (same planner as Android `AudioPlan` and iOS MixaiCore, WP17-44),
 * LRC parsing + current-line lookup, clock formatting. No DOM, no React: unit-tested in `music-core.test.ts`.
 */
import type { LyricLine, RepeatMode, TrackCard } from "./media-types";

/** Server play key for a track id (`tr_<n>`). */
export function trackKeyOf(id: string): string {
    return /^tr_\d+$/.test(id) ? id : `tr_${id}`;
}

/** Fisher–Yates; `rand` is injectable for tests. Never mutates the input. */
export function shuffleOrder<T>(items: readonly T[], rand: () => number = Math.random): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = out[i] as T;
        out[i] = out[j] as T;
        out[j] = tmp;
    }
    return out;
}

/** Item at `first` stays at the head, the rest is shuffled behind it (shuffle-on while a track plays). */
export function shuffleKeepFirst<T>(items: readonly T[], first: number, rand: () => number = Math.random): T[] {
    if (items.length === 0) return [];
    const f = Math.max(0, Math.min(first, items.length - 1));
    const head = items[f] as T;
    return [head, ...shuffleOrder(items.filter((_, i) => i !== f), rand)];
}

/**
 * Index to play after `index`. `auto` = the track ended by itself (repeat-one replays it; a manual "next"
 * always advances). `null` = end of queue, stop.
 */
export function nextIndex(index: number, length: number, repeat: RepeatMode, auto: boolean): number | null {
    if (length <= 0) return null;
    if (auto && repeat === "one") return Math.max(0, index);
    const n = index + 1;
    if (n >= length) return repeat === "all" ? 0 : null;
    return n;
}

/** "restart" = seek the current track to 0 (more than 3 s in, or nothing before it). */
export function prevIndex(index: number, length: number, repeat: RepeatMode, positionSec: number): number | "restart" {
    if (positionSec > 3 || length <= 0) return "restart";
    if (index > 0) return index - 1;
    if (repeat === "all" && length > 1) return length - 1;
    return "restart";
}

export function cycleRepeat(r: RepeatMode): RepeatMode {
    return r === "off" ? "all" : r === "all" ? "one" : "off";
}

/** Returns a new array with the item at `from` moved to `to` (both clamped). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
    const out = items.slice();
    if (from < 0 || from >= out.length) return out;
    const t = Math.max(0, Math.min(to, out.length - 1));
    const [it] = out.splice(from, 1);
    out.splice(t, 0, it as T);
    return out;
}

/** Where the playing index ends up after `moveItem(from, to)`. */
export function indexAfterMove(current: number, from: number, to: number): number {
    if (current === from) return to;
    if (from < current && to >= current) return current - 1;
    if (from > current && to <= current) return current + 1;
    return current;
}

/** Playing index after removing `removed` (when it is not the playing one). */
export function indexAfterRemove(current: number, removed: number): number {
    return removed < current ? current - 1 : current;
}

/** A play counts after 30 s or half the track, whichever comes first. */
export function playThresholdSec(durationSec: number): number {
    return durationSec > 0 ? Math.min(30, durationSec * 0.5) : 30;
}

// ─── crossfade + automix (WP17-44) ──────────────────────────────────────────

/** Playback settings of the web music engine (persisted by `web-music-player.ts`). */
export interface MusicPlayback {
    /** Crossfade length between tracks in seconds; 0 = plain gapless transitions. */
    crossfadeSec: number;
    /** Beat-aligned crossfades with tempo match when both tracks have BPM data (only matters with a crossfade). */
    automix: boolean;
}

export const MAX_CROSSFADE_SEC = 12;
/** Crossfade is off until the listener turns it on, as on Android and iOS (D56); automix only acts while it is on. */
export const DEFAULT_PLAYBACK: MusicPlayback = { crossfadeSec: 0, automix: true };

/** Stored value → valid settings (whole seconds 0..12; anything unreadable falls back to the default). */
export function normalizePlayback(raw: unknown): MusicPlayback {
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const c = o.crossfadeSec;
    const crossfadeSec = typeof c === "number" && Number.isFinite(c)
        ? Math.max(0, Math.min(MAX_CROSSFADE_SEC, Math.round(c)))
        : DEFAULT_PLAYBACK.crossfadeSec;
    return { crossfadeSec, automix: typeof o.automix === "boolean" ? o.automix : DEFAULT_PLAYBACK.automix };
}

/** What the planner reads from a track. */
export type MixTrack = Pick<TrackCard, "durationSec" | "albumId" | "track" | "disc" | "bpm" | "bpmConfidence" | "firstBeatSec">;

/** How the transition outgoing → incoming runs. */
export interface MixPlan {
    /** `beat` = tempo-matched and bar-aligned, `plain` = time-based crossfade, `none` = gapless, no overlap. */
    mode: "beat" | "plain" | "none";
    /** Playback rate of the INCOMING track during the overlap (1 = native); it glides back to 1 afterwards. */
    rate: number;
    /** Where the incoming track starts (its first downbeat), seconds. */
    inStartSec: number;
    /** Position in the OUTGOING track where the fade starts, seconds. */
    fadeStartSec: number;
    /** Fade length (whole bars of the outgoing tempo in `beat` mode), seconds. */
    fadeSec: number;
    /** Length of the glide of `rate` back to 1 after the fade, seconds (0 when the rate is already 1). */
    glideSec: number;
}

interface MixOptions {
    /** `false` = always a plain crossfade (the "Automix" setting is off). */
    automix?: boolean;
    /** Measured duration of the outgoing track (the `<audio>` element), when it differs from the card. */
    durationSec?: number;
}

/** The incoming tempo is changed by at most this much (percent). */
const MIX_MAX_RATE_PCT = 6;
const MIX_MIN_BPM_CONFIDENCE = 0.5;
/** Never skip more than this into the incoming track to reach its first downbeat. */
const MIX_MAX_LEAD_IN_SEC = 8;
/** After the handoff the matched tempo returns to native speed over this long. */
const MIX_GLIDE_SEC = 8;
const MIX_MIN_FADE_SEC = 1;

const ms = (sec: number): number => Math.round(sec * 1000) / 1000;
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

function usableBpm(t: Pick<MixTrack, "bpm" | "bpmConfidence"> | null | undefined): number | null {
    const b = t?.bpm;
    if (!finite(b) || b < 40 || b > 260) return null;
    const c = t?.bpmConfidence;
    return finite(c) && c < MIX_MIN_BPM_CONFIDENCE ? null : b;
}

/**
 * Rate for the incoming track so its tempo matches the outgoing one (half / double tempo folded), or `null`
 * when either BPM is unknown / unreliable or the change would exceed ±`MIX_MAX_RATE_PCT` %.
 */
export function rateFor(
    cur: Pick<MixTrack, "bpm" | "bpmConfidence"> | null | undefined,
    next: Pick<MixTrack, "bpm" | "bpmConfidence"> | null | undefined,
): number | null {
    const a = usableBpm(cur);
    let b = usableBpm(next);
    if (a === null || b === null) return null;
    while (b < a / 1.5) b *= 2;
    while (b > a * 1.5) b /= 2;
    const rate = a / b;
    return Math.abs(rate - 1) * 100 <= MIX_MAX_RATE_PCT ? rate : null;
}

/** Next track continues the same album in order (incl. a disc change): stays gapless, never crossfaded. */
export function isAlbumContinuation(
    cur: Pick<MixTrack, "albumId" | "track" | "disc"> | null | undefined,
    next: Pick<MixTrack, "albumId" | "track" | "disc"> | null | undefined,
): boolean {
    if (!cur || !next || !cur.albumId || cur.albumId !== next.albumId) return false;
    const a = cur.track;
    const b = next.track;
    if (!finite(a) || !finite(b)) return false;
    const curDisc = cur.disc ?? 1;
    const nextDisc = next.disc ?? 1;
    return (curDisc === nextDisc && b === a + 1) || (nextDisc === curDisc + 1 && b === 1);
}

/** Fade length for cur → next; 0 = plain gapless. Never more than a third of either track. */
export function crossfadeFor(crossfadeSec: number, curDurSec: number, cur: MixTrack | null | undefined, next: MixTrack | null | undefined): number {
    if (!(crossfadeSec > 0) || !(curDurSec > 0) || isAlbumContinuation(cur, next)) return 0;
    let f = Math.min(crossfadeSec, curDurSec / 3);
    if (next && next.durationSec > 0) f = Math.min(f, next.durationSec / 3);
    return f < MIX_MIN_FADE_SEC ? 0 : f;
}

/** `fadeSec` cut down to whole 4-beat bars at `bpm`; shorter than one bar → unchanged (never longer than asked). */
export function wholeBarsSec(fadeSec: number, bpm: number): number {
    const bar = (4 * 60) / bpm;
    const bars = Math.floor(fadeSec / bar + 1e-9);
    return bars >= 1 ? ms(bars * bar) : fadeSec;
}

/**
 * Position in the outgoing track where the fade starts: `duration - fade`, moved back to the previous downbeat
 * when the tempo and first downbeat of that track are known (so the incoming downbeat lands on one).
 */
export function fadeStartSec(curDurSec: number, cur: Pick<MixTrack, "bpm" | "bpmConfidence" | "firstBeatSec"> | null | undefined, fadeSec: number): number {
    const plain = ms(curDurSec - fadeSec);
    const bpm = usableBpm(cur);
    const first = cur?.firstBeatSec;
    if (bpm === null || !finite(first) || first < 0 || plain <= first) return plain;
    const bar = (4 * 60) / bpm;
    return ms(first + Math.floor((plain - first) / bar + 1e-9) * bar);
}

/** Rate during the glide back to native speed: linear from `from` to 1 over `glideSec`. */
export function glideRate(from: number, elapsedSec: number, glideSec: number): number {
    if (!(glideSec > 0) || elapsedSec >= glideSec) return 1;
    return from + (1 - from) * Math.max(0, elapsedSec / glideSec);
}

/** Equal-power curves (constant perceived loudness through the overlap), `t` in 0..1. */
export function fadeOutGain(t: number): number { return Math.cos((Math.max(0, Math.min(1, t)) * Math.PI) / 2); }
export function fadeInGain(t: number): number { return Math.sin((Math.max(0, Math.min(1, t)) * Math.PI) / 2); }

/**
 * Transition plan outgoing → incoming for a crossfade of `crossfadeSec` (the user setting).
 *  - `none`: setting off, album continuation, or a track too short to overlap.
 *  - `beat`: both tracks have a usable BPM within ±6 % (half / double tempo folded): the incoming track plays at
 *    the outgoing tempo from its first downbeat, the fade starts on an outgoing downbeat and lasts whole bars.
 *  - `plain`: no tempo data (or automix off): time-based crossfade into the start of the next track.
 */
export function mixPlan(outgoing: MixTrack | null | undefined, incoming: MixTrack | null | undefined, crossfadeSec: number, opts: MixOptions = {}): MixPlan {
    const dur = finite(opts.durationSec) && opts.durationSec > 0 ? opts.durationSec : outgoing?.durationSec ?? 0;
    const base = outgoing && incoming ? crossfadeFor(crossfadeSec, dur, outgoing, incoming) : 0;
    if (base <= 0 || !outgoing || !incoming) return { mode: "none", rate: 1, inStartSec: 0, fadeStartSec: ms(Math.max(0, dur)), fadeSec: 0, glideSec: 0 };
    const rate = opts.automix === false ? null : rateFor(outgoing, incoming);
    const bpm = usableBpm(outgoing);
    if (rate === null || bpm === null) return { mode: "plain", rate: 1, inStartSec: 0, fadeStartSec: ms(dur - base), fadeSec: ms(base), glideSec: 0 };
    const lead = incoming.firstBeatSec;
    const fadeSec = wholeBarsSec(base, bpm);
    return {
        mode: "beat",
        rate,
        inStartSec: finite(lead) && lead >= 0 && lead <= MIX_MAX_LEAD_IN_SEC ? lead : 0,
        fadeStartSec: fadeStartSec(dur, outgoing, fadeSec),
        fadeSec: ms(fadeSec),
        glideSec: rate === 1 ? 0 : MIX_GLIDE_SEC,
    };
}

// ─── LRC ────────────────────────────────────────────────────────────────────

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET_TAG = /^\[offset:\s*([+-]?\d+)\s*\]$/i;

export function looksLikeLrc(text: string | null | undefined): boolean {
    if (!text) return false;
    return /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(text);
}

/**
 * Parses LRC (`[mm:ss.xx]text`, several time tags per line, `[offset:±ms]`); metadata tags are ignored.
 * Returns lines sorted by time; empty text is kept (instrumental gap).
 */
export function parseLrc(text: string): LyricLine[] {
    const out: LyricLine[] = [];
    let offset = 0;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        const off = OFFSET_TAG.exec(line);
        if (off) { offset = Number(off[1]); continue; }
        const times: number[] = [];
        TIME_TAG.lastIndex = 0;
        let m: RegExpExecArray | null;
        let end = 0;
        while ((m = TIME_TAG.exec(line)) && m.index === end) {
            const min = Number(m[1]);
            const sec = Number(m[2]);
            const frac = m[3] ? Number(m[3].padEnd(3, "0")) : 0;
            times.push(min * 60_000 + sec * 1000 + frac);
            end = TIME_TAG.lastIndex;
        }
        if (times.length === 0) continue;
        const body = line.slice(end).trim();
        for (const t of times) out.push({ timeMs: Math.max(0, t - offset), text: body });
    }
    return out.sort((a, b) => a.timeMs - b.timeMs);
}

/** Index of the line active at `ms` (binary search; -1 before the first line). */
export function currentLineIndex(lines: readonly LyricLine[], ms: number): number {
    let lo = 0;
    let hi = lines.length - 1;
    let ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((lines[mid] as LyricLine).timeMs <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
}

// ─── formatting ─────────────────────────────────────────────────────────────

/** `m:ss` / `h:mm:ss`. */
export function fmtClock(sec: number): string {
    const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export function totalSeconds(tracks: readonly Pick<TrackCard, "durationSec">[]): number {
    return tracks.reduce((s, t) => s + (t.durationSec || 0), 0);
}

/** Next may hand route params over still percent-encoded; decode once, tolerating a literal `%`. */
export function safeDecode(v: string): string {
    try { return decodeURIComponent(v); } catch { return v; }
}

/** A–Z index used by the artist/album tabs (`#` = digits and symbols, matching the server). */
export const MUSIC_LETTERS: readonly string[] = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** Groups tracks by disc, preserving order; single-disc albums return one group with `disc: null`. */
export function discGroups(tracks: readonly TrackCard[]): { disc: number | null; items: { track: TrackCard; index: number }[] }[] {
    const discs = new Set(tracks.map((t) => t.disc ?? 1));
    if (discs.size <= 1) return [{ disc: null, items: tracks.map((track, index) => ({ track, index })) }];
    const groups: { disc: number | null; items: { track: TrackCard; index: number }[] }[] = [];
    tracks.forEach((track, index) => {
        const d = track.disc ?? 1;
        let g = groups[groups.length - 1];
        if (!g || g.disc !== d) { g = { disc: d, items: [] }; groups.push(g); }
        g.items.push({ track, index });
    });
    return groups;
}
