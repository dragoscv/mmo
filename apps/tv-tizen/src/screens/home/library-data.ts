/**
 * Library data (WP16-34): the server index (`/media/library`) grouped into one entry per title (tmdbId; unmatched
 * files by file for movies / by show folder for tv), plus a lazy, session-wide details cache filled in pages with
 * at most 4 concurrent `/media/title` calls. Pure functions + a tiny resolver; no React here.
 */
import type { LibraryIndexRow, MediaKind, ProgressEntry } from "../../lib/media-types";
import type { MediaClient } from "../../lib/media";
import { ApiError } from "../../lib/api";
import { fileBase, fold, yearOf } from "./media-ui";

export interface LibEntry {
    key: string;
    kind: MediaKind;
    tmdbId: number | null;
    files: LibraryIndexRow[];
    /** Newest file mtime (epoch ms or s, compared only relatively). */
    addedAt: number;
    /** Title guessed from the file/folder name until TMDB details arrive. */
    guess: string;
    /** "4K" | "1080p" | "720p" | "SD" from file names (details override). */
    res: string;
}

export interface LibDetails {
    title: string;
    posterPath: string | null;
    backdropPath: string | null;
    year: string | null;
    rating: number;
    genres: string[];
    res: string | null;
}

export type DetailState = LibDetails | "restricted" | "error";

const NOISE = /\b(19\d{2}|20\d{2}|2160p|1080p|720p|480p|4k|uhd|hdr10\+?|hdr|dv|dovi|bluray|blu-ray|brrip|bdrip|web-?dl|webrip|hdtv|remux|x26[45]|h\.?26[45]|hevc|avc|aac|ac3|eac3|dts(-hd)?|truehd|atmos|10bit|proper|repack|extended|unrated|imax|s\d{1,2}e\d{1,3}|s\d{1,2})\b.*$/i;

export function cleanName(raw: string): string {
    const s = raw.replace(/[._]+/g, " ").replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
    const cut = s.replace(NOISE, "").replace(/\s+-\s*$/, "").replace(/\s{2,}/g, " ").trim();
    return cut || s.trim() || raw;
}

export function resFromPath(p: string): string {
    if (/2160p|\b4k\b|\buhd\b/i.test(p)) return "4K";
    if (/1080p/i.test(p)) return "1080p";
    if (/720p/i.test(p)) return "720p";
    return "SD";
}

function showFolder(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    parts.pop();
    let i = parts.length - 1;
    if (i >= 0 && /^(season|sezon|series|s)\s*\d+$/i.test(parts[i]!)) i--;
    return i >= 0 ? parts[i]! : fileBase(path);
}

export function groupLibrary(rows: LibraryIndexRow[], kind: MediaKind): LibEntry[] {
    const map = new Map<string, LibEntry>();
    for (const r of rows) {
        if (r.kind !== kind) continue;
        const key = r.tmdbId != null ? `t:${r.tmdbId}` : kind === "tv" ? `s:${fold(showFolder(r.path))}` : `f:${r.serverFileId}`;
        const cur = map.get(key);
        if (cur) {
            cur.files.push(r);
            if (r.mtime > cur.addedAt) cur.addedAt = r.mtime;
            const res = resFromPath(r.path);
            if (rankRes(res) > rankRes(cur.res)) cur.res = res;
        } else {
            map.set(key, {
                key, kind, tmdbId: r.tmdbId, files: [r], addedAt: r.mtime,
                guess: cleanName(kind === "tv" ? showFolder(r.path) : fileBase(r.path)), res: resFromPath(r.path),
            });
        }
    }
    return Array.from(map.values());
}

export function rankRes(r: string | null): number {
    return r === "4K" ? 3 : r === "1080p" ? 2 : r === "720p" ? 1 : 0;
}

/** Watched = movie with a completed entry; show whose every local episode is completed. */
export function watchedKeys(entries: LibEntry[], progress: ProgressEntry[]): Set<string> {
    const done = new Set(progress.filter((p) => p.completed).map((p) => `${p.kind}:${p.tmdbId}:${p.season}:${p.episode}`));
    const out = new Set<string>();
    for (const e of entries) {
        if (e.tmdbId == null) continue;
        if (e.kind === "movie") { if (done.has(`movie:${e.tmdbId}:0:0`)) out.add(e.key); continue; }
        const eps = e.files.filter((f) => f.season != null && f.episode != null);
        if (eps.length > 0 && eps.every((f) => done.has(`tv:${e.tmdbId}:${f.season}:${f.episode}`))) out.add(e.key);
    }
    return out;
}

// ─── details cache + resolver ─────────────────────────────────────────────

const cache = new Map<string, DetailState>();
const MAX_CONCURRENT = 4;
export const PAGE = 30;

export function cacheKey(media: MediaClient, kind: MediaKind, tmdbId: number): string {
    return `${media.profile}|${kind}:${tmdbId}`;
}

export function detailsOf(media: MediaClient, e: LibEntry): DetailState | undefined {
    return e.tmdbId == null ? undefined : cache.get(cacheKey(media, e.kind, e.tmdbId));
}

/** FIFO of entries to resolve; `onBatch` fires (throttled) when results land. */
export class DetailResolver {
    private queue: LibEntry[] = [];
    private queued = new Set<string>();
    private running = 0;
    private dead = false;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    resolved = 0;

    constructor(private readonly media: MediaClient, private readonly onBatch: () => void) {}

    /** Enqueue (front when `urgent`) entries that are not cached yet. */
    want(list: LibEntry[], urgent = false): void {
        const add: LibEntry[] = [];
        for (const e of list) {
            if (e.tmdbId == null) continue;
            const k = cacheKey(this.media, e.kind, e.tmdbId);
            if (cache.has(k) || this.queued.has(k)) continue;
            this.queued.add(k);
            add.push(e);
        }
        if (add.length === 0) return;
        this.queue = urgent ? add.concat(this.queue) : this.queue.concat(add);
        this.pump();
    }

    get pending(): number { return this.queue.length + this.running; }

    private pump(): void {
        while (!this.dead && this.running < MAX_CONCURRENT && this.queue.length > 0) {
            const e = this.queue.shift()!;
            this.running++;
            void this.one(e).then(() => { this.running--; this.resolved++; this.scheduleFlush(); this.pump(); });
        }
    }

    private async one(e: LibEntry): Promise<void> {
        const k = cacheKey(this.media, e.kind, e.tmdbId!);
        try {
            const d = await this.media.mediaTitle(e.kind, e.tmdbId!);
            if (!d) { cache.set(k, "error"); return; }
            let res: string | null = null;
            for (const f of d.files) {
                const r = f.version?.resolution === "2160p" ? "4K" : f.version?.resolution ?? null;
                if (r && rankRes(r) > rankRes(res)) res = r;
            }
            cache.set(k, {
                title: d.title.title, posterPath: d.title.posterPath, backdropPath: d.title.backdropPath,
                year: yearOf(d.title.releaseDate), rating: d.title.voteAverage ?? 0,
                genres: (d.title.genres ?? []).map((g) => g.name).filter(Boolean), res,
            });
        } catch (err) {
            cache.set(k, err instanceof ApiError && err.status === 403 ? "restricted" : "error");
        } finally {
            this.queued.delete(k);
        }
    }

    private scheduleFlush(): void {
        if (this.flushTimer || this.dead) return;
        this.flushTimer = setTimeout(() => { this.flushTimer = null; if (!this.dead) this.onBatch(); }, this.pending === 0 ? 0 : 350);
    }

    dispose(): void {
        this.dead = true;
        this.queue = [];
        if (this.flushTimer) clearTimeout(this.flushTimer);
    }
}
