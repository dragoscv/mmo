/**
 * /media routes for the phone apps (WP16-50). Mounted inside `createMediaRouter`.
 *
 *   GET    /media/bookmarks?profile=&titleKey=     own + shared (age-filtered for kids)
 *   POST   /media/bookmarks?profile=               {kind,tmdbId,season?,episode?,fileId?,sec,label?,shared?}
 *   DELETE /media/bookmarks/:id?profile=           owner only
 *   GET    /media/profiles/:id/usage               minutes today + cap state
 *   GET    /media/stats/family                     weekly minutes per profile
 *   GET    /media/subtitles/search?q=&fileId=&limit=   ≤ 50 hits
 *   POST   /media/subtitles/index {fileId}         index sidecars now; extract embedded tracks in the ffmpeg slot (202)
 *   GET    /media/subtitles/index/:fileId          job + indexed sources
 *   POST   /media/import/plex {serverUrl, token, profileId}
 */

import express from "express";
import type { MediaDb } from "./db";
import type { TmdbClient } from "./tmdb";
import type { ProfileStore } from "./profiles";
import type { ProgressStore } from "./progress";
import type { WatchlistStore } from "./watchlist";
import { BookmarkError, BookmarkStore, type Bookmark, type BookmarkInput } from "./bookmarks";
import { allowedForAge } from "./ratings";
import { capStatus, weeklyUsage } from "./usage";
import type { SubtitleIndex, TitleInfo } from "./subtitles";
import { importFromPlex, PlexImportError, type PlexFetch } from "./plex-import";
import type { MediaKind, MediaLogger } from "./types";

/** Indexing jobs live in the video pillar; the media router only sees this interface. */
export interface SubtitleIndexing {
    request(fileId: string): { state: string; externalCues: number; embeddedCues: number; error: string | null } | null;
    job(fileId: string): { state: string; externalCues: number; embeddedCues: number; error: string | null } | null;
}

export interface PhoneRoutesDeps {
    db: MediaDb;
    tmdb: TmdbClient;
    profiles: ProfileStore;
    progress: ProgressStore;
    watchlist: WatchlistStore;
    bookmarks: BookmarkStore;
    subtitles: SubtitleIndex;
    subtitleIndexing?: () => SubtitleIndexing | null;
    /** fileId → title info (library_index + TMDB cache). */
    titleOfFile: (fileId: string) => TitleInfo;
    resolveProfile: (req: express.Request, res: express.Response, explicit?: string) => { id: string; maxAge: number | null } | null;
    plexFetch?: PlexFetch;
    now?: () => number;
    log: MediaLogger;
}

const qs = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const isKind = (v: unknown): v is MediaKind => v === "movie" || v === "tv";

export function registerPhoneRoutes(router: express.Router, deps: PhoneRoutesDeps): void {
    const now = deps.now ?? Date.now;
    const { db, tmdb, profiles, bookmarks } = deps;

    // ── bookmarks ─────────────────────────────────────────────────────────
    const allowSharedFor = (maxAge: number | null) => (b: Bookmark): boolean => {
        if (maxAge === null) return true;
        if (!b.kind || !b.tmdbId) return false; // untagged local files: no rating → hidden from kids
        const t = tmdb.getCachedTitle(b.kind, b.tmdbId);
        return allowedForAge(t?.age, maxAge, t?.genreIds ?? []);
    };

    router.get("/bookmarks", (req, res) => {
        const prof = deps.resolveProfile(req, res);
        if (!prof) return;
        const titleKey = qs(req.query.titleKey)?.slice(0, 80);
        const items = bookmarks.listVisible(prof.id, { titleKey, allowShared: allowSharedFor(prof.maxAge) });
        const names = new Map(profiles.list().map((p) => [p.id, p.name]));
        res.json({ bookmarks: items.map((b) => ({ ...b, mine: b.profileId === prof.id, profileName: names.get(b.profileId) ?? null })) });
    });

    router.post("/bookmarks", (req, res) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const prof = deps.resolveProfile(req, res, qs(b.profileId));
        if (!prof) return;
        const input: BookmarkInput = {
            kind: isKind(b.kind) ? b.kind : undefined,
            tmdbId: typeof b.tmdbId === "number" ? b.tmdbId : undefined,
            season: typeof b.season === "number" ? b.season : undefined,
            episode: typeof b.episode === "number" ? b.episode : undefined,
            fileId: qs(b.fileId)?.slice(0, 64),
            sec: Number(b.sec),
            label: typeof b.label === "string" ? b.label : undefined,
            shared: b.shared === true,
        };
        try {
            res.status(201).json({ bookmark: bookmarks.add(prof.id, input) });
        } catch (err) {
            if (err instanceof BookmarkError) { res.status(400).json({ error: err.message }); return; }
            throw err;
        }
    });

    router.delete("/bookmarks/:id", (req, res) => {
        const prof = deps.resolveProfile(req, res);
        if (!prof) return;
        const r = bookmarks.remove(prof.id, String(req.params.id));
        if (r === "not_found") { res.status(404).json({ error: "bookmark not found" }); return; }
        if (r === "forbidden") { res.status(403).json({ error: "not your bookmark" }); return; }
        res.status(204).end();
    });

    // ── usage + family stats ──────────────────────────────────────────────
    router.get("/profiles/:id/usage", (req, res) => {
        const id = String(req.params.id);
        const p = profiles.get(id);
        if (!p) { res.status(404).json({ error: "Profile not found" }); return; }
        res.json({ ...capStatus(db, p, id, now()), week: weeklyUsage(db, id, now()) });
    });

    router.get("/stats/family", (_req, res) => {
        const t = now();
        res.json({
            generatedAt: t,
            profiles: profiles.list().map((p) => {
                const w = weeklyUsage(db, p.id, t);
                const c = capStatus(db, p, p.id, t);
                return {
                    profileId: p.id, name: p.name, kind: p.kind, avatar: p.avatar, color: p.color,
                    days: w.days, watchMin: w.watchMin, listenMin: w.listenMin, weeklyWatchMin: w.totalWatchMin, weeklyListenMin: w.totalListenMin,
                    todayWatchMin: c.watchMin, dailyCapMin: c.dailyCapMin, overCap: c.overCap,
                };
            }),
        });
    });

    // ── subtitle text search ──────────────────────────────────────────────
    router.get("/subtitles/search", (req, res) => {
        const q = qs(req.query.q)?.slice(0, 200);
        if (!q || q.trim().length < 2) { res.status(400).json({ error: "q must be at least 2 characters" }); return; }
        const prof = deps.resolveProfile(req, res);
        if (!prof) return;
        const fileId = qs(req.query.fileId)?.slice(0, 64);
        const limit = Number(req.query.limit);
        let hits = deps.subtitles.search(q, { fileId, limit: Number.isFinite(limit) ? limit : undefined, titleOf: deps.titleOfFile });
        if (prof.maxAge !== null) {
            hits = hits.filter((h) => {
                if (!isKind(h.kind) || !h.tmdbId) return false;
                const t = tmdb.getCachedTitle(h.kind, h.tmdbId);
                return allowedForAge(t?.age, prof.maxAge, t?.genreIds ?? []);
            });
        }
        res.json({ q, hits, indexedFiles: fileId ? deps.subtitles.sources(fileId).length > 0 : undefined });
    });

    router.post("/subtitles/index", (req, res) => {
        const fileId = qs((req.body as Record<string, unknown> | undefined)?.fileId)?.slice(0, 64);
        if (!fileId) { res.status(400).json({ error: "fileId required" }); return; }
        const indexing = deps.subtitleIndexing?.();
        if (!indexing) { res.status(503).json({ error: "subtitle indexing unavailable" }); return; }
        const job = indexing.request(fileId);
        if (!job) { res.status(404).json({ error: "unknown fileId" }); return; }
        res.status(job.state === "done" ? 200 : 202).json({ fileId, ...job, sources: deps.subtitles.sources(fileId) });
    });

    router.get("/subtitles/index/:fileId", (req, res) => {
        const fileId = String(req.params.fileId);
        const job = deps.subtitleIndexing?.()?.job(fileId) ?? null;
        const sources = deps.subtitles.sources(fileId);
        if (!job && sources.length === 0) { res.status(404).json({ error: "not indexed" }); return; }
        res.json({ fileId, job, sources });
    });

    // ── Plex importer ─────────────────────────────────────────────────────
    router.post("/import/plex", async (req, res) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const serverUrl = qs(b.serverUrl);
        const token = qs(b.token);
        if (!serverUrl || !token) { res.status(400).json({ error: "serverUrl and token required" }); return; }
        const prof = deps.resolveProfile(req, res, qs(b.profileId) ?? "default");
        if (!prof) return;
        if (!profiles.get(prof.id)) { res.status(404).json({ error: "Profile not found" }); return; }
        try {
            const result = await importFromPlex({
                db, progress: deps.progress, watchlist: deps.watchlist, fetch: deps.plexFetch, now,
                findByImdb: async (imdbId, kind) => {
                    const j = await tmdb.getJson<{ movie_results?: { id: number }[]; tv_results?: { id: number }[] }>(`/find/${imdbId}`, { external_source: "imdb_id" });
                    const list = kind === "movie" ? j?.movie_results : j?.tv_results;
                    return list?.[0]?.id ?? null;
                },
            }, { serverUrl, token, profileId: prof.id });
            deps.log.info("[media/plex] import done", { profileId: prof.id, movies: result.watchedMovies, episodes: result.watchedEpisodes, watchlist: result.watchlist });
            res.json(result);
        } catch (err) {
            if (err instanceof PlexImportError) { res.status(err.status).json({ error: err.message }); return; }
            deps.log.error("[media/plex] import failed", err);
            if (!res.headersSent) res.status(500).json({ error: "Internal error" });
        }
    });
}
