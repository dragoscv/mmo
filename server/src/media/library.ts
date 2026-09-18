/**
 * `library_index` — which local video files map to which TMDB title.
 *
 * Fed by the video scan (full snapshot per root) and by the chokidar
 * watcher (incremental add/remove). Every write bumps `meta.library_etag`
 * (a revision counter) and stamps the touched rows, so clients can ask
 * `GET /media/library?since=<etag>` and get only the delta. Removed files
 * leave a tombstone so the delta can carry deletions.
 *
 * TMDB matching is best-effort: `matchTitle()` runs `search/multi` once per
 * (title, year) and caches the answer in `recs_cache` (`match:` keys), so a
 * 2000-file library costs a few hundred TMDB calls once, not per scan.
 */

import type { MediaDb } from "./db";
import { cacheGet, cacheSet, getMeta, setMeta } from "./db";
import type { TmdbClient } from "./tmdb";
import type { LibraryIndexRow, MediaKind, MediaLogger, TitleCard } from "./types";

const MATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;

/** Same hash as `video-routes.ts#makeFileId` — the id `/video/direct/:fileId` expects. */
export function makeServerFileId(absPath: string): string {
    let hash = 0;
    for (let i = 0; i < absPath.length; i++) {
        hash = ((hash << 5) - hash) + absPath.charCodeAt(i);
        hash |= 0;
    }
    return `f${(hash >>> 0).toString(36)}`;
}

export interface LibraryFileInput {
    path: string;
    size: number;
    mtime: number;
    /** Parsed title (basename heuristics) — used for TMDB matching. */
    title: string;
    year: number | null;
    season: number | null;
    episode: number | null;
    /** Show-name hint from the folder layout; preferred over `title` for tv. */
    showHint?: string | null;
    /** Explicit kind; defaults to `tv` when season/episode are present. */
    kind?: MediaKind;
    /** Already-known TMDB id (skips matching). */
    tmdbId?: number | null;
}

export interface LibraryDelta {
    revision: number;
    full: boolean;
    items: LibraryIndexRow[];
    removed: string[];
}

type Row = {
    server_file_id: string; kind: MediaKind; tmdb_id: number | null; season: number | null; episode: number | null;
    path: string; size: number; mtime: number; updated_at: number; rev: number;
};

const rowToItem = (r: Row): LibraryIndexRow => ({
    serverFileId: r.server_file_id, kind: r.kind, tmdbId: r.tmdb_id, season: r.season, episode: r.episode,
    path: r.path, size: r.size, mtime: r.mtime, updatedAt: r.updated_at, rev: r.rev,
});

export function kindFor(input: { season: number | null; episode: number | null; kind?: MediaKind }): MediaKind {
    if (input.kind) return input.kind;
    return input.season !== null || input.episode !== null ? "tv" : "movie";
}

export class LibraryIndex {
    constructor(
        private readonly db: MediaDb,
        private readonly tmdb: TmdbClient | null = null,
        private readonly log?: MediaLogger,
        private readonly now: () => number = Date.now,
    ) {}

    getEtag(): number {
        return Number(getMeta(this.db, "library_etag") ?? "0");
    }

    private bumpEtag(): number {
        const next = this.getEtag() + 1;
        setMeta(this.db, "library_etag", String(next));
        return next;
    }

    count(): number {
        return (this.db.prepare("SELECT COUNT(*) AS n FROM library_index").get() as { n: number }).n;
    }

    /** Best-effort TMDB match, cached (hit 30 d, miss 24 h). Null when unmatched / unconfigured. */
    async matchTitle(title: string, year: number | null, kind: MediaKind): Promise<number | null> {
        if (!this.tmdb?.configured) return null;
        const q = title.trim().toLowerCase();
        if (!q) return null;
        const key = `match:${kind}:${q}:${year ?? ""}`;
        const hit = cacheGet<{ tmdbId: number | null }>(this.db, key, MATCH_TTL_MS, this.now());
        if (hit && (hit.tmdbId !== null || this.isFreshMiss(key))) return hit.tmdbId;
        let page;
        try { page = await this.tmdb.search(q); } catch (err) { this.log?.warn("[media/library] match failed", { title: q }, err); return null; }
        const pick = pickMatch(page.results, q, year, kind);
        cacheSet(this.db, key, { tmdbId: pick }, this.now());
        return pick;
    }

    private isFreshMiss(key: string): boolean {
        return cacheGet<unknown>(this.db, key, MISS_TTL_MS, this.now()) !== null;
    }

    /** Insert/update one file. Returns the row; bumps the etag only when something changed. */
    upsert(input: LibraryFileInput): LibraryIndexRow {
        const id = makeServerFileId(input.path);
        const kind = kindFor(input);
        const tmdbId = input.tmdbId ?? null;
        const existing = this.db.prepare("SELECT * FROM library_index WHERE server_file_id = ?").get(id) as Row | undefined;
        const unchanged = existing && existing.path === input.path && existing.size === input.size && existing.mtime === input.mtime
            && existing.kind === kind && existing.tmdb_id === tmdbId && existing.season === input.season && existing.episode === input.episode;
        if (unchanged) return rowToItem(existing);
        const rev = this.bumpEtag();
        this.db.prepare(
            `INSERT INTO library_index (server_file_id, kind, tmdb_id, season, episode, path, size, mtime, updated_at, rev)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(server_file_id) DO UPDATE SET kind = excluded.kind, tmdb_id = excluded.tmdb_id, season = excluded.season,
               episode = excluded.episode, path = excluded.path, size = excluded.size, mtime = excluded.mtime,
               updated_at = excluded.updated_at, rev = excluded.rev`,
        ).run(id, kind, tmdbId, input.season, input.episode, input.path, input.size, input.mtime, this.now(), rev);
        this.db.prepare("DELETE FROM library_tombstones WHERE server_file_id = ?").run(id);
        return rowToItem(this.db.prepare("SELECT * FROM library_index WHERE server_file_id = ?").get(id) as Row);
    }

    /** Upsert with TMDB matching (uses `showHint` for tv). */
    async upsertMatched(input: LibraryFileInput): Promise<LibraryIndexRow> {
        const kind = kindFor(input);
        const title = kind === "tv" ? (input.showHint?.trim() || input.title) : input.title;
        const tmdbId = input.tmdbId ?? (await this.matchTitle(title, kind === "tv" ? null : input.year, kind));
        return this.upsert({ ...input, kind, tmdbId });
    }

    /** Remove by path(s). Leaves tombstones; bumps the etag once per call when anything was removed. */
    removePaths(paths: string[]): string[] {
        const removed: string[] = [];
        const tx = this.db.transaction(() => {
            const rev = this.getEtag() + 1;
            for (const p of paths) {
                const id = makeServerFileId(p);
                const r = this.db.prepare("DELETE FROM library_index WHERE server_file_id = ?").run(id);
                if (r.changes > 0) {
                    this.db.prepare("INSERT INTO library_tombstones (server_file_id, rev) VALUES (?, ?) ON CONFLICT(server_file_id) DO UPDATE SET rev = excluded.rev").run(id, rev);
                    removed.push(id);
                }
            }
            if (removed.length > 0) setMeta(this.db, "library_etag", String(rev));
        });
        tx();
        return removed;
    }

    /** After a full scan of `root`: drop rows under it whose paths are not in `keepPaths`. */
    pruneUnder(root: string, keepPaths: Iterable<string>): string[] {
        const keep = new Set(keepPaths);
        const prefix = root.replace(/[\\/]+$/, "");
        const rows = this.db.prepare("SELECT path FROM library_index").all() as { path: string }[];
        const gone = rows.map((r) => r.path).filter((p) => isUnder(p, prefix) && !keep.has(p));
        return gone.length > 0 ? this.removePaths(gone) : [];
    }

    /** Full list or delta since `since` (library etag). */
    list(since?: number): LibraryDelta {
        const revision = this.getEtag();
        if (since === undefined || since <= 0 || since > revision) {
            const rows = this.db.prepare("SELECT * FROM library_index ORDER BY updated_at DESC").all() as Row[];
            return { revision, full: true, items: rows.map(rowToItem), removed: [] };
        }
        const rows = this.db.prepare("SELECT * FROM library_index WHERE rev > ? ORDER BY rev ASC").all(since) as Row[];
        const tomb = this.db.prepare("SELECT server_file_id FROM library_tombstones WHERE rev > ?").all(since) as { server_file_id: string }[];
        return { revision, full: false, items: rows.map(rowToItem), removed: tomb.map((t) => t.server_file_id) };
    }

    /** Drop tombstones older than `olderThanRev` (housekeeping). */
    pruneTombstones(olderThanRev: number): number {
        return this.db.prepare("DELETE FROM library_tombstones WHERE rev <= ?").run(olderThanRev).changes;
    }
}

function isUnder(p: string, prefix: string): boolean {
    const a = p.toLowerCase().replace(/\//g, "\\");
    const b = prefix.toLowerCase().replace(/\//g, "\\");
    return a === b || a.startsWith(b + "\\");
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Pick the best search hit: kind must match; exact normalised title + year first, then popularity. */
export function pickMatch(results: TitleCard[], query: string, year: number | null, kind: MediaKind): number | null {
    const q = norm(query);
    const cands = results.filter((r) => r.kind === kind);
    if (cands.length === 0) return null;
    const scored = cands.map((c) => {
        let s = 0;
        const t = norm(c.title);
        const o = c.originalTitle ? norm(c.originalTitle) : "";
        if (t === q || o === q) s += 10;
        else if (t.startsWith(q) || q.startsWith(t)) s += 4;
        const y = c.releaseDate ? Number(c.releaseDate.slice(0, 4)) : null;
        if (year && y) s += Math.abs(y - year) <= 1 ? 5 : -3;
        s += Math.min(3, (c.popularity ?? 0) / 100);
        return { id: c.tmdbId, s };
    });
    scored.sort((a, b) => b.s - a.s);
    return scored[0]!.s > 0 ? scored[0]!.id : null;
}
