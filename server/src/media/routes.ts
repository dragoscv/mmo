/**
 * /media/* — Media Home API (mounted behind authMiddleware in server.ts, WP10-07).
 *
 *   GET  /media/status                          configured flags, region, revision, serverId/serverName
 *   GET  /media/home?profile=&region=&providers= HomeRow[]
 *   GET  /media/title/:kind/:tmdbId?region=&profile=  title + availability + local files + progress
 *   GET  /media/search?q=&page=&profile=         TMDB multi search, filtered by the profile's max age
 *   GET  /media/library?since=<libraryEtag>&profile=  {revision, full, items[], removed[]}
 *   GET  /media/progress?profile=&kind=&tmdbId=&since=<revision>
 *   PUT  /media/progress                         body: ProgressInput | ProgressInput[]
 *   POST /media/plays                            body: {profile, trackKey, durationSec, completed}
 *   GET  /media/plays?profile=&limit=
 *   GET  /media/etag                             {revision, libraryEtag}
 *   GET  /media/providers?region=                live catalog merged with launch data
 *   GET  /media/profiles                         Profile[] (+ revision)
 *   POST /media/profiles                         create {name, avatar, color, kind, maxAge, pin}
 *   PATCH/DELETE /media/profiles/:id
 *   POST /media/profiles/:id/unlock              {pin} → {token, expiresAt} (x-profile-token)
 *   GET  /media/title/tv/:tmdbId/season/:n?profile=   episodes + local files + progress
 *   GET  /media/watchlist?profile=               cards; PUT/DELETE /media/watchlist/:kind/:tmdbId?profile=
 *
 * Profiles with a PIN require `x-profile-token` (from unlock) on profile-scoped reads/writes;
 * profiles with a max age get every card list and the library index filtered by it. Ages of titles
 * nobody opened yet are looked up first (`age-lookup.ts`); what is still unknown stays hidden.
 *
 * Auth is the caller's concern (mount behind authMiddleware). JSON only.
 */

import express from "express";
import os from "node:os";
import type { MediaDb } from "./db";
import type { TmdbClient } from "./tmdb";
import type { ProviderRegistry } from "./providers";
import type { AvailabilityResolver } from "./availability";
import { buildHomeRows, stripToCard, type ContinueItem, type LibraryItem } from "./recs";
import { ProgressStore, type ProgressInput } from "./progress";
import { LibraryIndex } from "./library";
import type { MediaSyncClient } from "./sync-client";
import { ProfileError, ProfileStore, type ProfileInput } from "./profiles";
import { WatchlistStore } from "./watchlist";
import { allowedForAge, filterCardsForAge } from "./ratings";
import { AgeLookup, type TitleRating } from "./age-lookup";
import { parseVersion } from "./versions";
import { MusicService } from "./music";
import { createMusicRouter } from "./music-routes";
import { createStatsHandler } from "./stats";
import { BookmarkStore } from "./bookmarks";
import { SubtitleIndex } from "./subtitles";
import { registerPhoneRoutes, type SubtitleIndexing } from "./phone-routes";
import { weeklyUsage } from "./usage";
import type { PlexFetch } from "./plex-import";
import type { HistoryEntry, LibraryIndexRow, MediaKind, MediaLogger, ProgressEntry, TitleCard, TitleDetails } from "./types";

export interface MediaRouterDeps {
    db: MediaDb;
    tmdb: TmdbClient;
    registry: ProviderRegistry;
    availability: AvailabilityResolver;
    progress?: ProgressStore;
    library?: LibraryIndex;
    profiles?: ProfileStore;
    watchlist?: WatchlistStore;
    /** Music browse (`/media/music/*`); omitted in tests that don't need it. */
    music?: MusicService;
    /** When present, every progress/plays write schedules a debounced push. */
    sync?: Pick<MediaSyncClient, "schedule" | "lastResult" | "getLastPushedRevision">;
    region: string;
    log: MediaLogger;
    /** Optional server id for multi-server attribution. */
    getServerId?: () => string;
    /** Human label for the server (defaults to the OS hostname). */
    getServerName?: () => string;
    bookmarks?: BookmarkStore;
    subtitles?: SubtitleIndex;
    /** Embedded-track indexing jobs (video pillar); absent in tests that don't need it. */
    subtitleIndexing?: () => SubtitleIndexing | null;
    plexFetch?: PlexFetch;
    now?: () => number;
    /** Age lookups for profiles with an age limit; one shared instance by default. */
    ages?: AgeLookup;
}

/** A title page waits this long for the ages of its recommendations; the rest appear on a later visit. */
const TITLE_LISTS_AGE_BUDGET_MS = 1500;

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

/** Next episode to play for a show, from the profile's progress and the season list. */
export function nextUp(entries: ProgressEntry[], title: Pick<TitleDetails, "seasons">): { season: number; episode: number; positionSec: number } | null {
    const eps = entries.filter((e) => e.season > 0 && e.episode > 0).sort((a, b) => b.updatedAt - a.updatedAt);
    const last = eps[0];
    if (!last) return null;
    if (!last.completed) return { season: last.season, episode: last.episode, positionSec: last.positionSec };
    const seasons = (title.seasons ?? []).filter((s) => s.seasonNumber > 0).sort((a, b) => a.seasonNumber - b.seasonNumber);
    const cur = seasons.find((s) => s.seasonNumber === last.season);
    if (cur && last.episode < cur.episodeCount) return { season: last.season, episode: last.episode + 1, positionSec: 0 };
    const nextSeason = seasons.find((s) => s.seasonNumber > last.season && s.episodeCount > 0);
    return nextSeason ? { season: nextSeason.seasonNumber, episode: 1, positionSec: 0 } : null;
}

function parseProfileInput(b: Record<string, unknown>): ProfileInput {
    const out: ProfileInput = {};
    if (typeof b.name === "string") out.name = b.name;
    if (typeof b.avatar === "string" || b.avatar === null) out.avatar = b.avatar as string | null;
    if (typeof b.color === "string" || b.color === null) out.color = b.color as string | null;
    if (b.kind === "adult" || b.kind === "kid") out.kind = b.kind;
    if (typeof b.maxAge === "number" || b.maxAge === null) out.maxAge = b.maxAge as number | null;
    if (typeof b.pin === "string" || b.pin === null) out.pin = b.pin as string | null;
    if (b.prefs && typeof b.prefs === "object" && !Array.isArray(b.prefs)) out.prefs = b.prefs as Record<string, unknown>;
    if (typeof b.sort === "number") out.sort = b.sort;
    return out;
}

export function createMediaRouter(deps: MediaRouterDeps): express.Router {
    const { db, tmdb, registry, availability, log } = deps;
    const progress = deps.progress ?? new ProgressStore(db);
    const library = deps.library ?? new LibraryIndex(db, tmdb, log);
    const profiles = deps.profiles ?? new ProfileStore(db);
    const watchlist = deps.watchlist ?? new WatchlistStore(db, progress);
    const ages = deps.ages ?? new AgeLookup(tmdb);
    const defaultRegion = deps.region.toUpperCase();
    const serverId = () => deps.getServerId?.() ?? null;
    const serverName = () => deps.getServerName?.() ?? os.hostname();
    const router = express.Router();
    router.use(express.json({ limit: "512kb" }));

    /**
     * Resolves the profile of a request. Returns null (and answers 403) when the profile has a PIN
     * and no valid `x-profile-token` for it was sent.
     */
    const profileOf = (req: express.Request, res: express.Response, explicit?: string): { id: string; maxAge: number | null } | null => {
        const id = explicit ?? qs(req.query.profile) ?? "default";
        const p = profiles.get(id);
        if (p?.hasPin) {
            const tok = req.header("x-profile-token") ?? qs(req.query.pt);
            if (profiles.verifyToken(tok) !== id) {
                res.status(403).json({ error: "profile_locked", profileId: id });
                return null;
            }
        }
        return { id, maxAge: p?.maxAge ?? null };
    };
    const ageOf = (c: TitleCard) => tmdb.getCachedTitle(c.kind, c.tmdbId)?.age;
    const withAge = (c: TitleCard): TitleCard => {
        const a = c.age !== undefined ? c.age : ageOf(c);
        return a === undefined ? c : { ...c, age: a };
    };
    const profileIdOf = (req: express.Request, res: express.Response) => profileOf(req, res)?.id ?? null;

    if (deps.music) router.use("/music", createMusicRouter({ music: deps.music, resolveProfile: profileIdOf, log }));
    const statsHandler = createStatsHandler({
        db, lookupTitle: (k, id) => tmdb.getCachedTitle(k, id), resolveProfile: profileIdOf, log,
        extra: (profileId) => ({ weekly: weeklyUsage(db, profileId, (deps.now ?? Date.now)()) }),
    });
    router.get("/stats", statsHandler);

    const titleOfFile = (fileId: string) => {
        const r = db.prepare("SELECT kind, tmdb_id, season, episode, path FROM library_index WHERE server_file_id = ?").get(fileId) as
            { kind: MediaKind; tmdb_id: number | null; season: number | null; episode: number | null; path: string } | undefined;
        if (!r) return { kind: null, tmdbId: null, season: null, episode: null, title: fileId };
        const t = r.tmdb_id ? tmdb.getCachedTitle(r.kind, r.tmdb_id) : null;
        const base = r.path.split(/[\\/]/).pop() ?? r.path;
        return { kind: r.kind, tmdbId: r.tmdb_id, season: r.season, episode: r.episode, title: t?.title ?? base.replace(/\.[^.]+$/, "") };
    };
    registerPhoneRoutes(router, {
        db, tmdb, profiles, progress, watchlist, log, titleOfFile,
        bookmarks: deps.bookmarks ?? new BookmarkStore(db),
        subtitles: deps.subtitles ?? new SubtitleIndex(db),
        subtitleIndexing: deps.subtitleIndexing,
        resolveProfile: profileOf,
        plexFetch: deps.plexFetch,
        now: deps.now,
    });

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
            libraryEtag: library.getEtag(),
            libraryCount: library.count(),
            serverId: serverId(),
            serverName: serverName(),
            sync: deps.sync
                ? { lastPushedRevision: deps.sync.getLastPushedRevision(), last: deps.sync.lastResult }
                : null,
        });
    });

    router.get("/etag", (_req, res) => {
        res.json({ revision: progress.getRevision(), libraryEtag: library.getEtag() });
    });

    router.get("/library", wrap(async (req, res) => {
        const since = qint(req.query.since);
        // Clients older than 3.15 send no profile here and keep the whole index. A profile (named in the query, or
        // the one the profile token belongs to) with an age limit gets only the files of titles it may watch.
        const profileId = qs(req.query.profile) ?? profiles.verifyToken(req.header("x-profile-token") ?? qs(req.query.pt)) ?? undefined;
        const prof = profileId ? profileOf(req, res, profileId) : { id: "default", maxAge: null };
        if (!prof) return;
        if (prof.maxAge === null) {
            res.json({ ...library.list(since), serverId: serverId(), serverName: serverName() });
            return;
        }
        // Always the full filtered index: a delta could not say which rows this profile lost or gained.
        const all = library.list();
        const matched = all.items.filter((r) => r.tmdbId !== null);
        await ages.resolve(matched.map((r) => ({ kind: r.kind, tmdbId: r.tmdbId! })));
        const ratings = new Map<string, TitleRating>();
        const ratingOf = (kind: MediaKind, tmdbId: number): TitleRating => {
            const key = `${kind}:${tmdbId}`;
            let r = ratings.get(key);
            if (!r) { r = ages.rating(kind, tmdbId); ratings.set(key, r); }
            return r;
        };
        const items = matched.filter((r) => {
            const rating = ratingOf(r.kind, r.tmdbId!);
            return allowedForAge(rating.age, prof.maxAge, rating.genreIds);
        });
        res.json({ revision: all.revision, full: true, items, removed: [], serverId: serverId(), serverName: serverName() });
    }));

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
        const prof = profileOf(req, res);
        if (!prof) return;
        const profileId = prof.id;
        const r = region(req.query.region, defaultRegion);
        const providersPreferred = (qs(req.query.providers) ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
        const force = req.query.force === "1";
        const history = historyFromProgress(progress, profileId);
        const lib = libraryRows(db);
        const libraryItems: LibraryItem[] = lib.filter((l) => l.tmdbId !== null).map((l) => ({ kind: l.kind, tmdbId: l.tmdbId!, updatedAt: l.updatedAt }));

        const continueItems: ContinueItem[] = [];
        for (const p of progress.listContinue(profileId)) {
            const t = tmdb.getCachedTitle(p.kind, p.tmdbId) ?? (await tmdb.getTitle(p.kind, p.tmdbId));
            const card = t ? stripToCard(t) : { kind: p.kind, tmdbId: p.tmdbId, title: `#${p.tmdbId}`, posterPath: null, backdropPath: null, genreIds: [] };
            continueItems.push({
                ...card,
                progress: p.durationSec > 0 ? p.positionSec / p.durationSec : 0,
                ...(p.season > 0 ? { nextEpisode: { season: p.season, episode: p.episode, positionSec: p.positionSec } } : {}),
            });
        }
        // Up next: shows whose latest watched episode is complete and a following episode exists.
        const contKeys = new Set(continueItems.map((c) => `${c.kind}:${c.tmdbId}`));
        const showIds = [...new Set(progress.getProgress(profileId, { kind: "tv", limit: 300 }).map((e) => e.tmdbId))].slice(0, 20);
        for (const id of showIds) {
            if (contKeys.has(`tv:${id}`)) continue;
            const t = tmdb.getCachedTitle("tv", id);
            if (!t) continue;
            const nu = nextUp(progress.getProgress(profileId, { kind: "tv", tmdbId: id }), t);
            if (nu && nu.positionSec === 0) continueItems.push({ ...stripToCard(t), progress: 0, nextEpisode: nu, reason: "up_next" });
        }

        let rows = await buildHomeRows({ db, tmdb, log }, { profileId, history, library: libraryItems, continueItems, region: r, providersPreferred, force });

        // Watchlist row (after continue) + franchise row from the latest watched movie in a collection.
        const wl = watchlist.list(profileId, 40)
            .map((w) => tmdb.getCachedTitle(w.kind, w.tmdbId))
            .filter((t): t is TitleDetails => t !== null)
            .map(stripToCard);
        const extra: typeof rows = [];
        if (wl.length > 0) extra.push({ id: "watchlist", title: { ro: "Lista mea", en: "My list" }, kind: "mixed", items: wl });
        const lastInCollection = [...history].sort((a, b) => b.watchedAt - a.watchedAt)
            .map((h) => tmdb.getCachedTitle(h.kind, h.tmdbId))
            .find((t) => t?.collectionId);
        if (lastInCollection?.collectionId) {
            const col = await tmdb.getCollection(lastInCollection.collectionId);
            if (col && col.parts.length > 1) {
                extra.push({ id: `collection:${col.id}`, title: { ro: col.name, en: col.name }, kind: "movie", items: col.parts, reason: `collection:${col.id}` });
            }
        }
        const contIdx = rows.findIndex((x) => x.id === "continue");
        rows = [...rows.slice(0, contIdx + 1), ...extra, ...rows.slice(contIdx + 1)];

        const libKeys = new Set(libraryItems.map((l) => `${l.kind}:${l.tmdbId}`));
        if (prof.maxAge !== null) await ages.resolve(rows.flatMap((row) => row.items));
        rows = rows
            .map((row) => ({
                ...row,
                items: filterCardsForAge(row.items.map(withAge), prof.maxAge, ageOf)
                    .map((c) => (libKeys.has(`${c.kind}:${c.tmdbId}`) ? { ...c, inLibrary: true } : c)),
            }))
            .filter((row) => row.items.length > 0);
        res.json({
            region: r, profile: profileId, configured: tmdb.configured, revision: progress.getRevision(),
            libraryEtag: library.getEtag(), serverId: serverId(), serverName: serverName(), rows,
        });
    }));

    router.get("/title/:kind/:tmdbId", wrap(async (req, res) => {
        const kind = req.params.kind;
        const tmdbId = qint(req.params.tmdbId);
        if (!isKind(kind) || !tmdbId) { res.status(400).json({ error: "kind must be movie|tv and tmdbId an integer" }); return; }
        const prof = profileOf(req, res);
        if (!prof) return;
        const r = region(req.query.region, defaultRegion);
        const profileId = prof.id;
        let title = await tmdb.getTitle(kind, tmdbId);
        // Cached before certifications were stored: ask again rather than guess for a restricted profile.
        if (title && prof.maxAge !== null && title.age === undefined) title = (await tmdb.getTitle(kind, tmdbId, { force: true })) ?? title;
        if (!title) {
            res.status(tmdb.configured ? 404 : 503).json({ error: tmdb.configured ? "Title not found" : "TMDB not configured" });
            return;
        }
        if (!allowedForAge(title.age, prof.maxAge, title.genreIds)) {
            res.status(403).json({ error: "age_restricted", age: title.age ?? null, maxAge: prof.maxAge });
            return;
        }
        const [avail] = await Promise.all([availability.getAvailability(kind, tmdbId, r)]);
        const entries = progress.getProgress(profileId, { kind, tmdbId });
        const files = libraryRows(db, kind, tmdbId).map((f) => ({ ...f, version: parseVersion(f.path) }));
        if (prof.maxAge !== null) await ages.resolve([...title.recommendations, ...title.similar], TITLE_LISTS_AGE_BUDGET_MS);
        const filtered = (cards: TitleCard[]) => filterCardsForAge(cards.map(withAge), prof.maxAge, ageOf);
        res.json({
            title: { ...title, recommendations: filtered(title.recommendations), similar: filtered(title.similar) },
            availability: avail,
            files,
            progress: entries,
            nextUp: kind === "tv" ? nextUp(entries, title) : null,
            inWatchlist: watchlist.has(profileId, kind, tmdbId),
            serverId: serverId(),
            serverName: serverName(),
        });
    }));

    router.get("/title/tv/:tmdbId/season/:n", wrap(async (req, res) => {
        const tmdbId = qint(req.params.tmdbId);
        const n = qint(req.params.n);
        if (!tmdbId || n === undefined || n < 0) { res.status(400).json({ error: "tmdbId and season must be integers" }); return; }
        const prof = profileOf(req, res);
        if (!prof) return;
        const title = tmdb.getCachedTitle("tv", tmdbId) ?? (await tmdb.getTitle("tv", tmdbId));
        // A show whose rating cannot be checked (no TMDB data) stays closed for a profile with an age limit.
        if (prof.maxAge !== null && (!title || !allowedForAge(title.age, prof.maxAge, title.genreIds))) {
            res.status(403).json({ error: "age_restricted" });
            return;
        }
        const season = await tmdb.getSeason(tmdbId, n);
        const files = libraryRows(db, "tv", tmdbId).filter((f) => f.season === n);
        const prog = progress.getProgress(prof.id, { kind: "tv", tmdbId }).filter((p) => p.season === n);
        if (!season && files.length === 0) {
            res.status(tmdb.configured ? 404 : 503).json({ error: tmdb.configured ? "Season not found" : "TMDB not configured" });
            return;
        }
        // Episodes known only from local files (no TMDB data) still appear.
        const episodes = season?.episodes ?? [];
        const known = new Set(episodes.map((e) => e.episodeNumber));
        for (const f of files) {
            if (f.episode && !known.has(f.episode)) {
                episodes.push({ seasonNumber: n, episodeNumber: f.episode, name: "", stillPath: null });
                known.add(f.episode);
            }
        }
        episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
        res.json({
            tmdbId, seasonNumber: n, name: season?.name ?? "", overview: season?.overview, posterPath: season?.posterPath ?? null,
            episodes: episodes.map((e) => ({
                ...e,
                files: files.filter((f) => f.episode === e.episodeNumber).map((f) => ({ ...f, version: parseVersion(f.path) })),
                progress: prog.find((p) => p.episode === e.episodeNumber) ?? null,
            })),
            serverId: serverId(),
        });
    }));

    // ── profiles ──────────────────────────────────────────────────────────
    router.get("/profiles", (_req, res) => {
        res.json({ revision: profiles.getRevision(), profiles: profiles.list() });
    });

    router.post("/profiles", (req, res) => {
        try {
            res.status(201).json({ profile: profiles.create(parseProfileInput((req.body ?? {}) as Record<string, unknown>)) });
        } catch (err) {
            if (err instanceof ProfileError) { res.status(400).json({ error: err.message }); return; }
            throw err;
        }
    });

    /** Changing a PIN-protected profile needs its token (or the default adult profile's token when it has a PIN). */
    router.patch("/profiles/:id", (req, res) => {
        const id = String(req.params.id);
        if (!profileOf(req, res, id)) return;
        try {
            const p = profiles.update(id, parseProfileInput((req.body ?? {}) as Record<string, unknown>));
            if (!p) { res.status(404).json({ error: "Profile not found" }); return; }
            res.json({ profile: p });
        } catch (err) {
            if (err instanceof ProfileError) { res.status(400).json({ error: err.message }); return; }
            throw err;
        }
    });

    router.delete("/profiles/:id", (req, res) => {
        const id = String(req.params.id);
        if (!profileOf(req, res, id)) return;
        try {
            res.status(profiles.remove(id) ? 204 : 404).end();
        } catch (err) {
            if (err instanceof ProfileError) { res.status(400).json({ error: err.message }); return; }
            throw err;
        }
    });

    router.post("/profiles/:id/unlock", (req, res) => {
        const r = profiles.unlock(String(req.params.id), (req.body as Record<string, unknown> | undefined)?.pin);
        if (r.ok) { res.json({ token: r.token, expiresAt: r.expiresAt }); return; }
        if (r.reason === "not_found") { res.status(404).json({ error: "Profile not found" }); return; }
        if (r.reason === "locked") {
            res.setHeader("Retry-After", String(Math.ceil((r.retryAfterMs ?? 0) / 1000)));
            res.status(429).json({ error: "locked", retryAfterMs: r.retryAfterMs });
            return;
        }
        res.status(401).json({ error: "wrong_pin", triesLeft: r.triesLeft });
    });

    // ── watchlist ─────────────────────────────────────────────────────────
    router.get("/watchlist", wrap(async (req, res) => {
        const prof = profileOf(req, res);
        if (!prof) return;
        const entries = watchlist.list(prof.id);
        const items: TitleCard[] = [];
        for (const w of entries) {
            const t = tmdb.getCachedTitle(w.kind, w.tmdbId) ?? (await tmdb.getTitle(w.kind, w.tmdbId));
            items.push(t ? stripToCard(t) : { kind: w.kind, tmdbId: w.tmdbId, title: `#${w.tmdbId}`, posterPath: null, backdropPath: null, genreIds: [] });
        }
        res.json({ revision: progress.getRevision(), entries, items: filterCardsForAge(items.map(withAge), prof.maxAge, ageOf) });
    }));

    router.put("/watchlist/:kind/:tmdbId", (req, res) => {
        const kind = req.params.kind;
        const tmdbId = qint(req.params.tmdbId);
        if (!isKind(kind) || !tmdbId) { res.status(400).json({ error: "kind must be movie|tv and tmdbId an integer" }); return; }
        const prof = profileOf(req, res);
        if (!prof) return;
        const entry = watchlist.add(prof.id, kind, tmdbId);
        void tmdb.getTitle(kind, tmdbId).catch(() => undefined);
        deps.sync?.schedule();
        res.json({ entry, revision: progress.getRevision() });
    });

    router.delete("/watchlist/:kind/:tmdbId", (req, res) => {
        const kind = req.params.kind;
        const tmdbId = qint(req.params.tmdbId);
        if (!isKind(kind) || !tmdbId) { res.status(400).json({ error: "kind must be movie|tv and tmdbId an integer" }); return; }
        const prof = profileOf(req, res);
        if (!prof) return;
        const removed = watchlist.remove(prof.id, kind, tmdbId);
        deps.sync?.schedule();
        res.json({ removed, revision: progress.getRevision() });
    });

    router.get("/search", wrap(async (req, res) => {
        const q = qs(req.query.q);
        if (!q) { res.status(400).json({ error: "q required" }); return; }
        const prof = profileOf(req, res);
        if (!prof) return;
        const page = await tmdb.search(q.slice(0, 200), qint(req.query.page) ?? 1);
        const libKeys = new Set(libraryRows(db).map((l) => `${l.kind}:${l.tmdbId}`));
        // TMDB search results carry no certification: look the unknown ones up before filtering.
        if (prof.maxAge !== null) await ages.resolve(page.results);
        const results = filterCardsForAge(page.results.map(withAge), prof.maxAge, ageOf)
            .map((c) => (libKeys.has(`${c.kind}:${c.tmdbId}`) ? { ...c, inLibrary: true } : c));
        res.json({ ...page, results });
    }));

    router.get("/progress", (req, res) => {
        if (!qs(req.query.profile)) { res.status(400).json({ error: "profile required" }); return; }
        const prof = profileOf(req, res);
        if (!prof) return;
        const profileId = prof.id;
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
        const fallback = qs(req.query.profile);
        if (Array.isArray(req.body)) {
            if (req.body.length === 0 || req.body.length > 500) { res.status(400).json({ error: "batch must contain 1..500 entries" }); return; }
            const inputs: ProgressInput[] = [];
            for (let i = 0; i < req.body.length; i++) {
                const parsed = parseProgressBody(req.body[i], fallback);
                if ("error" in parsed) { res.status(400).json({ error: `entries[${i}]: ${parsed.error}` }); return; }
                inputs.push(parsed);
            }
            const entries = progress.putProgressBatch(inputs);
            deps.sync?.schedule();
            res.json({ entries, revision: progress.getRevision() });
            return;
        }
        const parsed = parseProgressBody(req.body, fallback);
        if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }
        const entry = progress.putProgress(parsed);
        deps.sync?.schedule();
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
        deps.sync?.schedule();
        res.status(201).json({ play, revision: progress.getRevision() });
    });

    router.get("/plays", (req, res) => {
        const profileId = qs(req.query.profile);
        if (!profileId) { res.status(400).json({ error: "profile required" }); return; }
        res.json({ plays: progress.listRecentPlays(profileId, qint(req.query.limit) ?? 50) });
    });

    return router;
}
