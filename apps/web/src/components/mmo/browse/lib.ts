/**
 * Pure helpers for the WP16 browse surfaces (search, library grids, title, season, list, stats, collections).
 * Port of the Tizen `screens/home/{library-data,media-ui}.ts` logic, minus the TV navigation. No React, no DOM.
 */
import type {
    HomeRow, LibraryIndexRow, MediaKind, MediaTitleResponse, ProgressEntry, VersionedFile,
} from "@/lib/mmo/media-types";

// ─── text ────────────────────────────────────────────────────────────────

/** Lower-case, diacritic-insensitive (Romanian ș/ț/ă/â/î included). */
export function fold(s: string): string {
    return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[șş]/g, "s").replace(/[țţ]/g, "t").replace(/[ăâ]/g, "a").replace(/î/g, "i");
}

export function fileBase(path: string): string {
    return (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, "");
}

export function yearOf(date: string | null | undefined): number | null {
    return date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;
}

const NOISE = /\b(19\d{2}|20\d{2}|2160p|1080p|720p|480p|4k|uhd|hdr10\+?|hdr|dv|dovi|bluray|blu-ray|brrip|bdrip|web-?dl|webrip|hdtv|remux|x26[45]|h\.?26[45]|hevc|avc|aac|ac3|eac3|dts(-hd)?|truehd|atmos|10bit|proper|repack|extended|unrated|imax|s\d{1,2}e\d{1,3}|s\d{1,2})\b.*$/i;

/** "The.Matrix.1999.2160p.UHD.mkv" → "The Matrix". */
export function cleanName(raw: string): string {
    const s = raw.replace(/[._]+/g, " ").replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
    const cut = s.replace(NOISE, "").replace(/\s+-\s*$/, "").replace(/\s{2,}/g, " ").trim();
    return cut || s.trim() || raw;
}

export function matchesQuery(name: string, query: string): boolean {
    const q = fold(query.trim());
    return q.length > 0 && fold(name).includes(q);
}

// ─── library grouping ────────────────────────────────────────────────────

export interface LibEntry {
    key: string;
    kind: MediaKind;
    tmdbId: number | null;
    files: LibraryIndexRow[];
    /** Newest file mtime (compared only relatively). */
    addedAt: number;
    /** Title guessed from the file/folder name until TMDB details arrive. */
    guess: string;
    /** "4K" | "1080p" | "720p" | "SD" from file names. */
    res: string;
}

export interface LibDetails {
    title: string;
    posterPath: string | null;
    backdropPath: string | null;
    year: number | null;
    rating: number;
    genres: string[];
}

export function resFromPath(p: string): string {
    if (/2160p|\b4k\b|\buhd\b/i.test(p)) return "4K";
    if (/1080p/i.test(p)) return "1080p";
    if (/720p/i.test(p)) return "720p";
    return "SD";
}

export function rankRes(r: string | null | undefined): number {
    return r === "4K" ? 3 : r === "1080p" ? 2 : r === "720p" ? 1 : 0;
}

function showFolder(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    parts.pop();
    let i = parts.length - 1;
    if (i >= 0 && /^(season|sezon|series|s)\s*\d+$/i.test(parts[i] ?? "")) i--;
    return i >= 0 ? (parts[i] ?? fileBase(path)) : fileBase(path);
}

/** One entry per title: by tmdbId; unmatched movies per file, unmatched shows per show folder. */
export function groupLibrary(rows: LibraryIndexRow[], kind: MediaKind): LibEntry[] {
    const map = new Map<string, LibEntry>();
    for (const r of rows) {
        if (r.kind !== kind) continue;
        const key = r.tmdbId != null ? `${kind}:${r.tmdbId}` : kind === "tv" ? `${kind}:s:${fold(showFolder(r.path))}` : `${kind}:f:${r.serverFileId}`;
        const cur = map.get(key);
        const res = resFromPath(r.path);
        if (cur) {
            cur.files.push(r);
            if (r.mtime > cur.addedAt) cur.addedAt = r.mtime;
            if (rankRes(res) > rankRes(cur.res)) cur.res = res;
        } else {
            map.set(key, {
                key, kind, tmdbId: r.tmdbId, files: [r], addedAt: r.mtime,
                guess: cleanName(kind === "tv" ? showFolder(r.path) : fileBase(r.path)), res,
            });
        }
    }
    return Array.from(map.values());
}

/** Watched = movie with a completed entry; show whose every local episode is completed. */
export function watchedKeys(entries: LibEntry[], progress: ProgressEntry[]): Set<string> {
    const done = new Set(progress.filter((p) => p.completed).map((p) => `${p.kind}:${p.tmdbId}:${p.season}:${p.episode}`));
    const out = new Set<string>();
    for (const e of entries) {
        if (e.tmdbId == null) continue;
        if (e.kind === "movie") {
            if (done.has(`movie:${e.tmdbId}:0:0`)) out.add(e.key);
            continue;
        }
        const eps = e.files.filter((f) => f.season != null && f.episode != null);
        if (eps.length > 0 && eps.every((f) => done.has(`tv:${e.tmdbId}:${f.season}:${f.episode}`))) out.add(e.key);
    }
    return out;
}

// ─── sorting / A–Z ───────────────────────────────────────────────────────

export const SORTS = ["recent", "az", "year", "rating"] as const;
export type SortKey = (typeof SORTS)[number];

export interface SortInfo { name: string; year: number | null; rating: number | null }

export function sortEntries<T extends { key: string; addedAt: number }>(list: readonly T[], sort: SortKey, info: (e: T) => SortInfo): T[] {
    const cache = new Map<string, SortInfo & { folded: string }>();
    const get = (e: T) => {
        let v = cache.get(e.key);
        if (!v) { const i = info(e); v = { ...i, folded: fold(i.name) }; cache.set(e.key, v); }
        return v;
    };
    const byName = (a: T, b: T) => get(a).folded.localeCompare(get(b).folded);
    const out = list.slice();
    if (sort === "recent") out.sort((a, b) => b.addedAt - a.addedAt || byName(a, b));
    else if (sort === "az") out.sort(byName);
    else if (sort === "year") out.sort((a, b) => (get(b).year ?? -1) - (get(a).year ?? -1) || byName(a, b));
    else out.sort((a, b) => (get(b).rating ?? -1) - (get(a).rating ?? -1) || byName(a, b));
    return out;
}

export const LETTERS = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"] as const;

/** Jump-bar bucket: first letter A–Z (diacritics folded, leading "The "/"A " kept), everything else "#". */
export function letterOf(name: string): string {
    const c = fold(name.trim()).charAt(0).toUpperCase();
    return c >= "A" && c <= "Z" ? c : "#";
}

/** First index of each bucket in an (already A–Z sorted) list of names. */
export function letterIndex(names: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    names.forEach((n, i) => { const l = letterOf(n); if (!out.has(l)) out.set(l, i); });
    return out;
}

/** Genre names present in the resolved details, most common first. */
export function genreList(details: readonly (LibDetails | null | undefined)[]): string[] {
    const n = new Map<string, number>();
    for (const d of details) for (const g of d?.genres ?? []) n.set(g, (n.get(g) ?? 0) + 1);
    return Array.from(n.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g);
}

// ─── play targets / links ────────────────────────────────────────────────

export interface PlayTarget {
    file: VersionedFile;
    season: number;
    episode: number;
    /** Seconds; 0 = from the start. */
    resumeSec: number;
    /** Minutes left when resuming (null when unknown). */
    leftMin: number | null;
}

export function isEpisodeFile(f: { season: number | null; episode: number | null }): boolean {
    return (f.season ?? 0) > 0 || (f.episode ?? 0) > 0;
}

/** Preferred file when still present, else the best version (`version.rank`). */
export function bestFile(files: readonly VersionedFile[], preferredId?: string | null): VersionedFile | null {
    if (preferredId) {
        const p = files.find((f) => f.serverFileId === preferredId);
        if (p) return p;
    }
    let best: VersionedFile | null = null;
    for (const f of files) if (!best || (f.version?.rank ?? 0) > (best.version?.rank ?? 0)) best = f;
    return best;
}

export function resumeOf(p: ProgressEntry | null | undefined): { sec: number; left: number | null } {
    if (!p || p.completed || p.positionSec <= 0) return { sec: 0, left: null };
    const left = p.durationSec > p.positionSec ? Math.max(1, Math.round((p.durationSec - p.positionSec) / 60)) : null;
    return { sec: p.positionSec, left };
}

export function episodeTarget(season: number, episode: number, files: readonly VersionedFile[], progress: ProgressEntry | null | undefined, preferredId?: string | null): PlayTarget | null {
    const f = bestFile(files, preferredId);
    if (!f) return null;
    const r = resumeOf(progress);
    return { file: f, season, episode, resumeSec: r.sec, leftMin: r.left };
}

const epOrder = (a: VersionedFile, b: VersionedFile) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0);

/** Movie: best (or chosen) version + resume. Series: `nextUp` → earliest unwatched local episode. */
export function previewTarget(d: MediaTitleResponse, preferredId?: string | null): PlayTarget | null {
    if (d.title.kind !== "tv") {
        const movies = d.files.filter((f) => !isEpisodeFile(f));
        const f = bestFile(movies.length > 0 ? movies : d.files, preferredId);
        if (!f) return null;
        const r = resumeOf(d.progress.find((p) => p.season === 0 && p.episode === 0));
        return { file: f, season: 0, episode: 0, resumeSec: r.sec, leftMin: r.left };
    }
    const eps = d.files.filter(isEpisodeFile);
    const nu = d.nextUp;
    if (nu && nu.season > 0) {
        const files = eps.filter((f) => f.season === nu.season && f.episode === nu.episode);
        if (files.length > 0) {
            const tg = episodeTarget(nu.season, nu.episode, files, d.progress.find((p) => p.season === nu.season && p.episode === nu.episode), preferredId);
            if (tg && tg.resumeSec <= 0 && nu.positionSec > 0) tg.resumeSec = nu.positionSec;
            return tg;
        }
    }
    if (eps.length === 0) return null;
    const done = new Set(d.progress.filter((p) => p.completed).map((p) => `${p.season}:${p.episode}`));
    const sorted = [...eps].sort(epOrder);
    const pick = sorted.find((f) => !done.has(`${f.season ?? 0}:${f.episode ?? 0}`)) ?? sorted[0];
    if (!pick) return null;
    const s = pick.season ?? 0;
    const e = pick.episode ?? 0;
    return episodeTarget(s, e, eps.filter((f) => f.season === pick.season && f.episode === pick.episode), d.progress.find((p) => p.season === s && p.episode === e));
}

/** `/media/play/{kind}/{tmdbId}` (+ `file` for an explicit version, `s`/`e` for episodes). */
export function playHref(kind: MediaKind, tmdbId: number, opts: { file?: string | null; season?: number; episode?: number } = {}): string {
    const q = new URLSearchParams();
    if (opts.file) q.set("file", opts.file);
    if (opts.season && opts.season > 0) {
        q.set("s", String(opts.season));
        q.set("e", String(opts.episode ?? 1));
    }
    const qs = q.toString();
    return `/media/play/${kind}/${tmdbId}${qs ? `?${qs}` : ""}`;
}

export function targetHref(kind: MediaKind, tmdbId: number, tg: PlayTarget | null, chosenFile?: string | null): string {
    return playHref(kind, tmdbId, { file: chosenFile ?? null, season: tg?.season, episode: tg?.episode });
}

/** 0..1, 1 when completed, null when never started. */
export function progressRatio(p: ProgressEntry | null | undefined): number | null {
    if (!p) return null;
    if (p.completed) return 1;
    return p.durationSec > 0 && p.positionSec > 0 ? Math.min(1, p.positionSec / p.durationSec) : null;
}

/** Technical chips from local versions (never localised). */
export function formatChips(files: readonly VersionedFile[]): string[] {
    const out: string[] = [];
    if (files.some((f) => f.version?.resolution === "2160p")) out.push("4K");
    else if (files.some((f) => f.version?.resolution === "1080p")) out.push("HD");
    if (files.some((f) => f.version?.hdr === "DV")) out.push("DV");
    if (files.some((f) => f.version?.hdr === "HDR" || f.version?.hdr === "HDR10+")) out.push("HDR");
    return out;
}

/** Unique versions of the movie files, best first (dedupes identical labels). */
export function versionChoices(files: readonly VersionedFile[]): VersionedFile[] {
    const movies = files.filter((f) => !isEpisodeFile(f));
    return [...(movies.length > 0 ? movies : files)].sort((a, b) => (b.version?.rank ?? 0) - (a.version?.rank ?? 0));
}

// ─── stats / collections ─────────────────────────────────────────────────

export function hoursLabel(h: number, locale: string): string {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: h >= 100 ? 0 : 1 }).format(h);
}

export function yearsBack(current: number, n: number): number[] {
    return Array.from({ length: n }, (_, i) => current - i);
}

/** Bar heights 0..1 relative to the max (all 0 when empty). */
export function barScale(values: readonly number[]): number[] {
    const max = Math.max(0, ...values);
    return values.map((v) => (max > 0 ? Math.max(0, v) / max : 0));
}

/** Home rows the server builds from TMDB collections (`collection:<id>`). */
export function collectionRows(rows: readonly HomeRow[]): HomeRow[] {
    return rows.filter((r) => r.id.startsWith("collection") && r.items.length > 0);
}

// ─── grid keyboard ───────────────────────────────────────────────────────

/** Next index in a `cols`-wide grid for an arrow/Home/End key; null = key not handled / no move. */
export function gridMove(index: number, key: string, cols: number, count: number): number | null {
    if (count <= 0 || index < 0) return null;
    const c = Math.max(1, cols);
    let n: number;
    switch (key) {
        case "ArrowRight": n = index + 1; break;
        case "ArrowLeft": n = index - 1; break;
        case "ArrowDown": n = index + c; break;
        case "ArrowUp": n = index - c; break;
        case "Home": n = 0; break;
        case "End": n = count - 1; break;
        default: return null;
    }
    if (n < 0 || n >= count) return key === "ArrowDown" && index < count - 1 && Math.floor(index / c) < Math.floor((count - 1) / c) ? count - 1 : null;
    return n === index ? null : n;
}
