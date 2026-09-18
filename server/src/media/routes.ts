/**
 * /media/* — Media Home API (NOT mounted here; see WP10-07 in the tracker).
 *
 *   GET  /media/status                          configured flags, region, revision
 *   GET  /media/home?profile=&region=&providers= HomeRow[]
 *   GET  /media/title/:kind/:tmdbId?region=&profile=  title + availability + local files + progress
 *   GET  /media/search?q=
 *   GET  /media/progress?profile=&kind=&tmdbId=&since=
 *   PUT  /media/progress                         body: ProgressInput
 *   POST /media/plays                            body: {profile, trackKey, durationSec, completed}
 *   GET  /media/plays?profile=&limit=
 *   GET  /media/etag                             {revision, libraryEtag}
 *   GET  /media/providers?region=                live catalog merged with launch data
 *
 * Auth is the caller's concern (mount behind authMiddleware). JSON only.
 */

import express from "express";
import type { MediaDb } from "./db";
import { getMeta } from "./db";
import type { TmdbClient } from "./tmdb";
import type { ProviderRegistry } from "./providers";
import type { AvailabilityResolver } from "./availability";
import { buildHomeRows, stripToCard, type ContinueItem, type LibraryItem } from "./recs";
import { ProgressStore, type ProgressInput } from "./progress";
import type { HistoryEntry, LibraryIndexRow, MediaKind, MediaLogger } from "./types";

export interface MediaRouterDeps {
    db: MediaDb;
    tmdb: TmdbClient;
    registry: ProviderRegistry;
    availability: AvailabilityResolver;
    progress?: ProgressStore;
    region: string;
    log: MediaLogger;
    /** Optional server id for multi-server attribution. */
    getServerId?: () => string;
}

const isKind = (v: unknown): v is MediaKind => v === "movie" || v === "tv";
const qs = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const qint = (v: unknown): number | undefined => {
    const s = qs(v);
    if (!s) return undefined;
    const n = Number(s);
    return Number.isInteger(n) ? n : undefined;
};
const region = (v: unknown, fallback: string) => (qs(v) ?? fallback).toUpperCase().slice(0, 2);

export function libraryRows(db: MediaDb, kind?: MediaKind, tmdbId?: number): LibraryIndexRow[] {
    const rows = (kind && tmdbId !== undefined
        ? db.prepare("SELECT * FROM library_index WHERE kind = ? AND tmdb_id = ? ORDER BY season, episode").all(kind, tmdbId)
        : db.prepare("SELECT * FROM library_index WHERE tmdb_id IS NOT NULL ORDER BY updated_at DESC").all()) as {
            server_file_id: string; kind: MediaKind; tmdb_id: number | null; season: number | null; episode: number | null;
            path: string; size: number; mtime: number; updated_at: number;
        }[];
    return rows.map((r) => ({
        serverFileId: r.server_file_id, kind: r.kind, tmdbId: r.tmdb_id, season: r.season, episode: r.episode,
        path: r.path, size: r.size, mtime: r.mtime, updatedAt: r.updated_at,
    }));
}

/** progress rows → HistoryEntry (one per title, best completion). */
export function historyFromProgress(store: ProgressStore, profileId: string): HistoryEntry[] {
    const byTitle = new Map<string, HistoryEntry>();
    for (const p of store.getProgress(profileId, { limit: 1000 })) {
        const key = `${p.kind}:${p.tmdbId}`;
        const completion = p.completed ? 1 : p.durationSec > 0 ? Math.min(1, p.positionSec / p.durationSec) : 0;
        const prev = byTitle.get(key);
        if (!prev || completion > prev.completion || p.updatedAt > prev.watchedAt) {
            byTitle.set(key, {
                kind: p.kind, tmdbId: p.tmdbId, watchedAt: Math.max(p.updatedAt, prev?.watchedAt ?? 0),
                completion: Math.max(completion, prev?.completion ?? 0),
            });
        }
    }
    return [...byTitle.values()];
}

function parseProgressBody(body: unknown, fallbackProfile?: string): ProgressInput | { error: string } {
    if (!body || typeof body !== "object") return { error: "body must be an object" };
    const b = body as Record<string, unknown>;
    const profileId = qs(b.profileId) ?? qs(b.profile) ?? fallbackProfile;
    if (!profileId) return { error: "profileId required" };
    if (!isKind(b.kind)) return { error: "kind must be movie|tv" };
    const tmdbId = typeof b.tmdbId === "number" ? b.tmdbId : qint(b.tmdbId);
    if (!tmdbId || tmdbId <= 0) return { error: "tmdbId must be a positive integer" };
    const positionSec = Number(b.positionSec);
    const durationSec = Number(b.durationSec ?? 0);
    if (!Number.isFinite(positionSec) || positionSec < 0) return { error: "positionSec must be >= 0" };
    if (!Number.isFinite(durationSec) || durationSec < 0) return { error: "durationSec must be >= 0" };
    const season = b.season === undefined ? 0 : Number(b.season);
    const episode = b.episode === undefined ? 0 : Number(b.episode);
    if (!Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 0) return { error: "season/episode must be non-negative integers" };
    const completed = typeof b.completed === "boolean" ? b.completed : undefined;
    const updatedAt = typeof b.updatedAt === "number" && Number.isFinite(b.updatedAt) ? b.updatedAt : undefined;
    return { profileId, kind: b.kind, tmdbId, season, episode, positionSec, durationSec, completed, updatedAt };
}

export function createMediaRouter(deps: MediaRouterDeps): express.Router {
    const { db, tmdb, registry, availability, log } = deps;
    const progress = deps.progress ?? new ProgressStore(db);
    const defaultRegion = deps.region.toUpperCase();
    const router = express.Router();
    router.use(express.json({ limit: "64kb" }));

    const wrap = (fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler =>
        (req, res) => {
            fn(req, res).catch((err: unknown) => {
                log.error("[media] handler failed", err, { path: req.path });
                if (!res.headersSent) res.status(500).json({ error: "Internal error" });
            });
        };

    router.get("/status", (_req, res) => {
        res.json({
            configured: tmdb.configured,
            tmdb: tmdb.configured,
            motn: availability.motnConfigured,
            region: defaultRegion,
            language: tmdb.language,
            revision: progress.getRevision(),
            libraryEtag: getMeta(db, "library_etag") ?? "0",
            serverId: deps.getServerId?.() ?? null,
        });
    });

    router.get("/etag", (_req, res) => {
        res.json({ revision: progress.getRevision(), libraryEtag: getMeta(db, "library_etag") ?? "0" });
    });

    router.get("/providers", wrap(async (req, res) => {
        const r = region(req.query.region, defaultRegion);
        const catalog = await registry.refreshProviderCatalog(r);
        res.json({
            region: r,
            fetchedAt: catalog.fetchedAt,
            providers: catalog.entries.map((e) => {
                const p = registry.resolveProvider(e.provider_id);
                return {
                    providerId: e.provider_id, key: p.key, name: p.name, logo: p.logo, displayPriority: p.displayPriority,
                    launch: p.launch("movie", 0, ""),
                };
            }),
        });
    }));

    router.get("/home", wrap(async (req, res) => {
        const profileId = qs(req.query.profile) ?? "default";
        const r = region(req.query.region, defaultRegion);
        const providersPreferred = (qs(req.query.providers) ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
        const force = req.query.force === "1";
        const history = historyFromProgress(progress, profileId);
        const lib = libraryRows(db);
        const library: LibraryItem[] = lib.filter((l) => l.tmdbId !== null).map((l) => ({ kind: l.kind, tmdbId: l.tmdbId!, updatedAt: l.updatedAt }));

        const continueItems: ContinueItem[] = [];
        for (const p of progress.listContinue(profileId)) {
            const t = tmdb.getCachedTitle(p.kind, p.tmdbId) ?? (await tmdb.getTitle(p.kind, p.tmdbId));
            const card = t ? stripToCard(t) : { kind: p.kind, tmdbId: p.tmdbId, title: `#${p.tmdbId}`, posterPath: null, backdropPath: null, genreIds: [] };
            continueItems.push({ ...card, progress: p.durationSec > 0 ? p.positionSec / p.durationSec : 0 });
        }

        const rows = await buildHomeRows({ db, tmdb, log }, { profileId, history, library, continueItems, region: r, providersPreferred, force });
        res.json({ region: r, profile: profileId, configured: tmdb.configured, revision: progress.getRevision(), rows });
    }));

    router.get("/title/:kind/:tmdbId", wrap(async (req, res) => {
        const kind = req.params.kind;
        const tmdbId = qint(req.params.tmdbId);
        if (!isKind(kind) || !tmdbId) { res.status(400).json({ error: "kind must be movie|tv and tmdbId an integer" }); return; }
        const r = region(req.query.region, defaultRegion);
        const profileId = qs(req.query.profile) ?? "default";
        const title = await tmdb.getTitle(kind, tmdbId);
        if (!title) {
            res.status(tmdb.configured ? 404 : 503).json({ error: tmdb.configured ? "Title not found" : "TMDB not configured" });
            return;
        }
        const [avail] = await Promise.all([availability.getAvailability(kind, tmdbId, r)]);
        res.json({
            title,
            availability: avail,
            files: libraryRows(db, kind, tmdbId),
            progress: progress.getProgress(profileId, { kind, tmdbId }),
            serverId: deps.getServerId?.() ?? null,
        });
    }));

    router.get("/search", wrap(async (req, res) => {
        const q = qs(req.query.q);
        if (!q) { res.status(400).json({ error: "q required" }); return; }
        const page = await tmdb.search(q.slice(0, 200), qint(req.query.page) ?? 1);
        const libKeys = new Set(libraryRows(db).map((l) => `${l.kind}:${l.tmdbId}`));
        res.json({ ...page, results: page.results.map((c) => (libKeys.has(`${c.kind}:${c.tmdbId}`) ? { ...c, inLibrary: true } : c)) });
    }));

    router.get("/progress", (req, res) => {
        const profileId = qs(req.query.profile);
        if (!profileId) { res.status(400).json({ error: "profile required" }); return; }
        const kind = req.query.kind;
        res.json({
            revision: progress.getRevision(),
            entries: progress.getProgress(profileId, {
                kind: isKind(kind) ? kind : undefined,
                tmdbId: qint(req.query.tmdbId),
                since: qint(req.query.since),
                limit: qint(req.query.limit),
            }),
        });
    });

    router.put("/progress", (req, res) => {
        const parsed = parseProgressBody(req.body, qs(req.query.profile));
        if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }
        const entry = progress.putProgress(parsed);
        res.json({ entry, revision: progress.getRevision() });
    });

    router.post("/plays", (req, res) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const profileId = qs(b.profileId) ?? qs(b.profile) ?? qs(req.query.profile);
        const trackKey = qs(b.trackKey);
        if (!profileId || !trackKey) { res.status(400).json({ error: "profileId and trackKey required" }); return; }
        const durationSec = Number(b.durationSec ?? 0);
        if (!Number.isFinite(durationSec) || durationSec < 0) { res.status(400).json({ error: "durationSec must be >= 0" }); return; }
        const playedAt = typeof b.playedAt === "number" && Number.isFinite(b.playedAt) ? b.playedAt : undefined;
        const play = progress.recordPlay(profileId, trackKey.slice(0, 512), durationSec, b.completed === true, playedAt);
        res.status(201).json({ play, revision: progress.getRevision() });
    });

    router.get("/plays", (req, res) => {
        const profileId = qs(req.query.profile);
        if (!profileId) { res.status(400).json({ error: "profile required" }); return; }
        res.json({ plays: progress.listRecentPlays(profileId, qint(req.query.limit) ?? 50) });
    });

    return router;
}
