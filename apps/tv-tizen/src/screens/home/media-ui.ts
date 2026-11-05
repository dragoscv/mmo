/**
 * Shared media helpers for Home / Title / Season / Library / Search (WP16-32/33). Port of the Android
 * `ui/title/MediaUi.kt`: play-target resolution (movie best version, series `nextUp` → season endpoint →
 * earliest unwatched local episode), play/resume labels, age + format chips, trailer URL, error kinds.
 */
import { ApiError } from "../../lib/api";
import type { MediaTitleResponse, ProgressEntry, TitleCard, TitleDetails, VersionedFile } from "../../lib/media-types";
import type { TitleRef } from "../../lib/progress-sync";
import type { ScreenCtx } from "../../nav/ctx";
import { t } from "../../i18n/messages";

/** What a Play button plays: one server file, its TMDB identity and where to start. */
export interface PlayTarget {
    file: VersionedFile;
    ref: TitleRef;
    /** Seconds; 0 = from the start / local resume store. */
    resumeSec: number;
    /** Minutes left when resuming (null when unknown). */
    leftMin: number | null;
}

export const cardKey = (c: { kind: string; tmdbId: number }): string => `${c.kind}:${c.tmdbId}`;

export function isEpisodeFile(f: { season: number | null; episode: number | null }): boolean {
    return (f.season ?? 0) > 0 || (f.episode ?? 0) > 0;
}

/** Preferred file when still present, else the best version (`version.rank`). */
export function bestFile(files: VersionedFile[], preferredId?: string | null): VersionedFile | null {
    if (preferredId) {
        const p = files.find((f) => f.serverFileId === preferredId);
        if (p) return p;
    }
    let best: VersionedFile | null = null;
    for (const f of files) if (!best || (f.version?.rank ?? 0) > (best.version?.rank ?? 0)) best = f;
    return best;
}

function resumeOf(p: ProgressEntry | null | undefined): { sec: number; left: number | null } {
    if (!p || p.completed || p.positionSec <= 0) return { sec: 0, left: null };
    const left = p.durationSec > p.positionSec ? Math.max(1, Math.round((p.durationSec - p.positionSec) / 60)) : null;
    return { sec: p.positionSec, left };
}

export function episodeTarget(tmdbId: number, season: number, episode: number, files: VersionedFile[], progress: ProgressEntry | null | undefined, preferredId?: string | null): PlayTarget | null {
    const f = bestFile(files, preferredId);
    if (!f) return null;
    const r = resumeOf(progress);
    return { file: f, ref: { kind: "tv", tmdbId, season, episode }, resumeSec: r.sec, leftMin: r.left };
}

export function movieTarget(d: MediaTitleResponse, preferredId?: string | null): PlayTarget | null {
    const movies = d.files.filter((f) => !isEpisodeFile(f));
    const f = bestFile(movies.length > 0 ? movies : d.files, preferredId);
    if (!f) return null;
    const r = resumeOf(d.progress.find((p) => p.season === 0 && p.episode === 0));
    return { file: f, ref: { kind: d.title.kind === "tv" ? "tv" : "movie", tmdbId: d.title.tmdbId }, resumeSec: r.sec, leftMin: r.left };
}

const epOrder = (a: VersionedFile, b: VersionedFile) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0);

/** Synchronous target from the title files only (labels before a click; no season fetch). */
export function previewTarget(d: MediaTitleResponse, preferredId?: string | null): PlayTarget | null {
    if (d.title.kind !== "tv") return movieTarget(d, preferredId);
    const id = d.title.tmdbId;
    const eps = d.files.filter(isEpisodeFile);
    const nu = d.nextUp;
    if (nu && nu.season > 0) {
        const files = eps.filter((f) => f.season === nu.season && f.episode === nu.episode);
        if (files.length > 0) {
            const tg = episodeTarget(id, nu.season, nu.episode, files, d.progress.find((p) => p.season === nu.season && p.episode === nu.episode), preferredId);
            if (tg && tg.resumeSec <= 0 && nu.positionSec > 0) tg.resumeSec = nu.positionSec;
            return tg;
        }
    }
    if (eps.length === 0) return null;
    const done = new Set(d.progress.filter((p) => p.completed).map((p) => `${p.season}:${p.episode}`));
    const sorted = [...eps].sort(epOrder);
    const pick = sorted.find((f) => !done.has(`${f.season ?? 0}:${f.episode ?? 0}`)) ?? sorted[0]!;
    const s = pick.season ?? 0;
    const e = pick.episode ?? 0;
    return episodeTarget(id, s, e, eps.filter((f) => f.season === pick.season && f.episode === pick.episode), d.progress.find((p) => p.season === s && p.episode === e));
}

/** Full resolution: like `previewTarget`, plus the season endpoint when `nextUp` is not in the title files. */
export async function resolveTarget(ctx: ScreenCtx, d: MediaTitleResponse, preferredId?: string | null): Promise<PlayTarget | null> {
    if (d.title.kind === "tv" && d.nextUp && d.nextUp.season > 0) {
        const nu = d.nextUp;
        const local = d.files.some((f) => f.season === nu.season && f.episode === nu.episode);
        if (!local) {
            try {
                const season = await ctx.media.season(d.title.tmdbId, nu.season);
                const ep = season?.episodes.find((x) => x.episodeNumber === nu.episode);
                if (ep && ep.files.length > 0) {
                    const tg = episodeTarget(d.title.tmdbId, nu.season, nu.episode, ep.files, ep.progress, preferredId);
                    if (tg && tg.resumeSec <= 0 && nu.positionSec > 0) tg.resumeSec = nu.positionSec;
                    if (tg) return tg;
                }
            } catch { /* fall back to local files */ }
        }
    }
    return previewTarget(d, preferredId);
}

/** Resolves the file (`/video/file/{id}/info`, re-registers after a server restart) and pushes the Player. */
export async function startPlayback(ctx: ScreenCtx, tg: PlayTarget, fromStart = false): Promise<void> {
    const video = await ctx.client.resolveVideo(tg.file.serverFileId, tg.file.path);
    ctx.nav.push({ name: "player", item: { kind: "video", video, ref: tg.ref, resumeSec: fromStart ? 0 : tg.resumeSec } });
}

/** Fetches the title, resolves its play target and starts it; false when nothing local can play. */
export async function playTitle(ctx: ScreenCtx, kind: "movie" | "tv", tmdbId: number): Promise<boolean> {
    const d = await ctx.media.mediaTitle(kind, tmdbId);
    if (!d) return false;
    const tg = await resolveTarget(ctx, d);
    if (!tg) return false;
    await startPlayback(ctx, tg);
    return true;
}

/** "Play" / "Play S1E1" / "Resume S2E4" + sub "12 min left". */
export function playLabel(tg: PlayTarget | null): { label: string; sub?: string } {
    if (!tg) return { label: t("wh.play") };
    const s = tg.ref.season ?? 0;
    const e = tg.ref.episode ?? 0;
    const ep = s > 0 && e > 0;
    const sub = tg.resumeSec > 0 && tg.leftMin != null ? t("wh.minLeft", { n: tg.leftMin }) : undefined;
    if (tg.resumeSec > 0) return { label: ep ? t("wh.resumeEp", { s, e }) : t("wh.resume"), sub };
    return { label: ep ? t("wh.playEp", { s, e }) : t("wh.play") };
}

/** Age chip: `12+`, `AG` (all ages); falls back to the raw certification. */
export function ageLabel(age: number | null | undefined, certification?: string | null): string | null {
    if (age != null) return age <= 0 ? t("wh.ageAll") : `${age}+`;
    if (!certification) return null;
    if (/^\d+$/.test(certification)) return certification === "0" ? t("wh.ageAll") : `${certification}+`;
    return certification;
}

/** Technical chips from local versions (never localised). */
export function formatChips(files: VersionedFile[]): string[] {
    const out: string[] = [];
    if (files.some((f) => f.version?.resolution === "2160p")) out.push("4K");
    else if (files.some((f) => f.version?.resolution === "1080p")) out.push("HD");
    if (files.some((f) => f.version?.hdr === "DV")) out.push("DV");
    if (files.some((f) => f.version?.hdr === "HDR" || f.version?.hdr === "HDR10+")) out.push("HDR");
    return out;
}

export function yearOf(date: string | null | undefined): string | null {
    return date && /^\d{4}/.test(date) ? date.slice(0, 4) : null;
}

export function runtimeLabel(min: number | null | undefined): string | null {
    if (!min || min <= 0) return null;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h > 0 ? t("wh.runtimeHm", { h, m }) : t("wh.runtimeM", { m });
}

/** Chips: year · age · runtime/seasons · formats. */
export function titleChips(card: TitleCard | null | undefined, d: MediaTitleResponse | null | undefined): string[] {
    const det: TitleDetails | undefined = d?.title;
    const src = det ?? card;
    if (!src) return [];
    const out: string[] = [];
    const y = yearOf(src.releaseDate);
    if (y) out.push(y);
    const age = ageLabel(src.age, det?.certification);
    if (age) out.push(age);
    if (det?.kind === "tv" && det.numberOfSeasons) out.push(det.numberOfSeasons === 1 ? t("wh.season1") : t("wh.seasons", { n: det.numberOfSeasons }));
    else {
        const rt = runtimeLabel(det?.runtime);
        if (rt) out.push(rt);
    }
    if (d) out.push(...formatChips(d.files));
    return out;
}

/** YouTube URL of the best trailer (official Trailer first). */
export function trailerUrl(det: TitleDetails | null | undefined): string | null {
    const yt = (det?.videos ?? []).filter((v) => /youtube/i.test(v.site) && v.key);
    const v = yt.find((x) => x.type === "Trailer") ?? yt[0];
    return v ? `https://www.youtube.com/watch?v=${encodeURIComponent(v.key)}` : null;
}

export type TitleErrorKind = "age" | "tmdb" | "other";

export function errorKind(e: unknown): TitleErrorKind {
    const s = e instanceof ApiError ? e.status : 0;
    return s === 403 ? "age" : s === 503 ? "tmdb" : "other";
}

/** Lower-case, diacritic-free (ș/ş, ț/ţ, ă, â, î …) for client-side matching. */
export function fold(s: string): string {
    let out = s.toLowerCase();
    try { out = out.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch { /* old engines */ }
    return out.replace(/[șş]/g, "s").replace(/[țţ]/g, "t").replace(/[ăâ]/g, "a").replace(/î/g, "i");
}

export function fileBase(path: string): string {
    return (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, "");
}

/** Debounce helper bound to a component lifetime (call `cancel` on unmount). */
export function debouncer(ms: number): { run: (fn: () => void) => void; cancel: () => void } {
    let h: ReturnType<typeof setTimeout> | null = null;
    return {
        run(fn) { if (h) clearTimeout(h); h = setTimeout(() => { h = null; fn(); }, ms); },
        cancel() { if (h) clearTimeout(h); h = null; },
    };
}
