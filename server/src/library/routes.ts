/**
 * /library/* HTTP API.
 *
 * All routes require:
 *   1. Device token (`X-Device-Token`) — same auth as the rest of the
 *      companion's authenticated routes.
 *   2. User id (`X-User-Id`) — sent by the web app from the active
 *      Auth.js session. Every read & write is scoped to this user; no
 *      route ever returns rows belonging to another user.
 *
 * Error model: every endpoint returns JSON. On failure: HTTP 4xx/5xx
 * with `{ error: string }`.
 */

import express from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getLibraryDb } from "./db";
import { tracks, playlists, playlistTracks, scanLogs, downloads } from "./schema";
import type { NewTrack } from "./schema";
import { analyzer, type AnalyzeOptions } from "./analyzer";
import { createReadStream, statSync, existsSync } from "node:fs";
import path from "node:path";

// ─── Auth helpers ────────────────────────────────────────────────────────────

interface AuthedRequest extends express.Request {
    userId: string;
}

function requireUser(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
) {
    const userId = (req.headers["x-user-id"] as string | undefined)?.trim();
    if (!userId) {
        res.status(400).json({ error: "Missing X-User-Id header" });
        return;
    }
    (req as AuthedRequest).userId = userId;
    next();
}

// ─── Filter parsing ──────────────────────────────────────────────────────────

interface ParsedFilters {
    genre?: string;
    subgenre?: string;
    minBpm?: number;
    maxBpm?: number;
    energy?: number;
    search?: string;
    key?: string;
    isProcessed?: boolean;
    isFavorite?: boolean;
    isHidden?: boolean;
    tag?: string;
    rating?: number;
    album?: string;
    artist?: string;
    year?: number;
    label?: string;
    mood?: string;
    page: number;
    pageSize: number;
    sort: string;
    order: "asc" | "desc";
}

function parseFilters(q: express.Request["query"]): ParsedFilters {
    const num = (v: unknown) => {
        const n = parseInt(String(v ?? ""), 10);
        return Number.isFinite(n) ? n : undefined;
    };
    const bool = (v: unknown) => (v === "true" ? true : v === "false" ? false : undefined);
    return {
        genre: (q.genre as string) || undefined,
        subgenre: (q.subgenre as string) || undefined,
        minBpm: num(q.minBpm),
        maxBpm: num(q.maxBpm),
        energy: num(q.energy),
        search: (q.search as string) || undefined,
        key: (q.key as string) || undefined,
        isProcessed: bool(q.isProcessed),
        isFavorite: bool(q.isFavorite),
        isHidden: bool(q.isHidden),
        tag: (q.tag as string) || undefined,
        rating: num(q.rating),
        album: (q.album as string) || undefined,
        artist: (q.artist as string) || undefined,
        year: num(q.year),
        label: (q.label as string) || undefined,
        mood: (q.mood as string) || undefined,
        page: num(q.page) ?? 1,
        pageSize: Math.min(num(q.pageSize) ?? 50, 500),
        sort: (q.sort as string) || "addedAt",
        order: (q.order === "asc" ? "asc" : "desc") as "asc" | "desc",
    };
}

function buildConditions(userId: string, f: ParsedFilters) {
    const c: ReturnType<typeof eq>[] = [eq(tracks.userId, userId)];

    if (f.isHidden === true) c.push(eq(tracks.isHidden, true));
    else c.push(sql`(${tracks.isHidden} IS NULL OR ${tracks.isHidden} = 0)` as never);

    if (f.genre) {
        const list = f.genre.split(",").map((g) => g.trim()).filter(Boolean);
        if (list.length === 1) c.push(eq(tracks.genre, list[0]));
        else if (list.length > 1) c.push(inArray(tracks.genre, list) as never);
    }
    if (f.minBpm !== undefined) c.push(sql`${tracks.bpm} >= ${f.minBpm}` as never);
    if (f.maxBpm !== undefined) c.push(sql`${tracks.bpm} <= ${f.maxBpm}` as never);
    if (f.energy !== undefined) c.push(eq(tracks.energy, f.energy));
    if (f.key) {
        const list = f.key.split(",").map((k) => k.trim()).filter(Boolean);
        if (list.length === 1) {
            c.push(sql`(${tracks.keyCamelot} = ${list[0]} OR ${tracks.keyMusical} = ${list[0]})` as never);
        } else if (list.length > 1) {
            c.push(sql`(${tracks.keyCamelot} IN (${sql.join(list.map((k) => sql`${k}`), sql`, `)}) OR ${tracks.keyMusical} IN (${sql.join(list.map((k) => sql`${k}`), sql`, `)}))` as never);
        }
    }
    if (f.search) {
        const term = `%${f.search}%`;
        c.push(sql`(${tracks.artist} LIKE ${term} OR ${tracks.title} LIKE ${term} OR ${tracks.filename} LIKE ${term})` as never);
    }
    if (f.isProcessed !== undefined) c.push(eq(tracks.isProcessed, f.isProcessed));
    if (f.isFavorite) c.push(eq(tracks.isFavorite, true));
    if (f.rating !== undefined) c.push(eq(tracks.rating, f.rating));
    if (f.tag) {
        const list = f.tag.split(",").map((t) => t.trim()).filter(Boolean);
        if (list.length > 0) {
            const conds = list.map((t) => sql`${tracks.tags} LIKE ${`%"${t}"%`}`);
            c.push(sql`(${sql.join(conds, sql` OR `)})` as never);
        }
    }
    if (f.album) c.push(sql`${tracks.album} LIKE ${`%${f.album}%`}` as never);
    if (f.artist) c.push(eq(tracks.artist, f.artist));
    if (f.year !== undefined) c.push(eq(tracks.year, f.year));
    if (f.label) c.push(eq(tracks.label, f.label));
    if (f.subgenre) c.push(eq(tracks.subgenre, f.subgenre));
    if (f.mood) c.push(eq(tracks.mood, f.mood));

    return c;
}

function buildOrderBy(sort: string, order: "asc" | "desc") {
    const dir = order === "asc" ? asc : desc;
    switch (sort) {
        case "artist": return dir(tracks.artist);
        case "title": return dir(tracks.title);
        case "bpm": return dir(tracks.bpm);
        case "key": return dir(tracks.keyCamelot);
        case "genre": return dir(tracks.genre);
        case "energy": return dir(tracks.energy);
        case "duration": return dir(tracks.duration);
        case "rating": return dir(tracks.rating);
        case "favorite": return dir(tracks.isFavorite);
        case "bitrate": return dir(tracks.bitrate);
        case "year": return dir(tracks.year);
        case "addedAt":
        default: return dir(tracks.addedAt);
    }
}

// ─── Router ──────────────────────────────────────────────────────────────────

export function createLibraryRouter(authMiddleware: express.RequestHandler): express.Router {
    const router = express.Router();

    // All library routes require both device token AND user id.
    router.use(authMiddleware);
    router.use(requireUser);

    // ── Tracks: list ─────────────────────────────────────────────────────
    router.get("/tracks", (req, res) => {
        const { userId } = req as AuthedRequest;
        const f = parseFilters(req.query);
        const db = getLibraryDb();
        const conds = buildConditions(userId, f);
        const where = and(...conds);
        const offset = (f.page - 1) * f.pageSize;

        const totalRow = db.select({ c: sql<number>`COUNT(*)` }).from(tracks).where(where).get();
        const total = totalRow?.c ?? 0;
        const rows = db.select().from(tracks).where(where)
            .orderBy(buildOrderBy(f.sort, f.order))
            .limit(f.pageSize).offset(offset).all();

        res.json({
            tracks: rows,
            total,
            page: f.page,
            pageSize: f.pageSize,
            totalPages: Math.ceil(total / f.pageSize),
        });
    });

    // ── Tracks: get one ──────────────────────────────────────────────────
    router.get("/tracks/:id(\\d+)", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const db = getLibraryDb();
        const row = db.select().from(tracks)
            .where(and(eq(tracks.id, id), eq(tracks.userId, userId))).get();
        if (!row) { res.status(404).json({ error: "Not found" }); return; }
        res.json({ track: row });
    });

    // ── Tracks: update (PATCH) ───────────────────────────────────────────
    router.patch("/tracks/:id(\\d+)", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const data = req.body as Partial<NewTrack>;
        // Strip sensitive / immutable fields
        delete data.id; delete data.userId; delete data.filepath;
        const db = getLibraryDb();
        db.update(tracks).set(data).where(and(eq(tracks.id, id), eq(tracks.userId, userId))).run();
        res.json({ success: true });
    });

    // ── Tracks: delete ───────────────────────────────────────────────────
    router.delete("/tracks/:id(\\d+)", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const db = getLibraryDb();
        db.delete(tracks).where(and(eq(tracks.id, id), eq(tracks.userId, userId))).run();
        res.json({ success: true });
    });

    // ── Tracks: toggle favorite ──────────────────────────────────────────
    router.post("/tracks/:id(\\d+)/favorite", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const db = getLibraryDb();
        const row = db.select({ f: tracks.isFavorite }).from(tracks)
            .where(and(eq(tracks.id, id), eq(tracks.userId, userId))).get();
        if (!row) { res.status(404).json({ error: "Not found" }); return; }
        const next = !row.f;
        db.update(tracks).set({ isFavorite: next })
            .where(and(eq(tracks.id, id), eq(tracks.userId, userId))).run();
        res.json({ success: true, isFavorite: next });
    });

    // ── Tracks: set rating ───────────────────────────────────────────────
    router.post("/tracks/:id(\\d+)/rating", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const { rating } = req.body as { rating: number | null };
        const db = getLibraryDb();
        db.update(tracks).set({ rating: rating || null })
            .where(and(eq(tracks.id, id), eq(tracks.userId, userId))).run();
        res.json({ success: true });
    });

    // ── Tracks: set tags ─────────────────────────────────────────────────
    router.post("/tracks/:id(\\d+)/tags", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const { tags } = req.body as { tags: string[] };
        const db = getLibraryDb();
        db.update(tracks).set({ tags: JSON.stringify(tags || []) })
            .where(and(eq(tracks.id, id), eq(tracks.userId, userId))).run();
        res.json({ success: true });
    });

    // ── Tracks: bulk hide / unhide ───────────────────────────────────────
    router.post("/tracks/hide", (req, res) => {
        const { userId } = req as AuthedRequest;
        const { ids, hidden } = req.body as { ids: number[]; hidden: boolean };
        if (!Array.isArray(ids) || ids.length === 0) {
            res.json({ success: true, count: 0 });
            return;
        }
        const db = getLibraryDb();
        db.update(tracks).set({ isHidden: !!hidden })
            .where(and(eq(tracks.userId, userId), inArray(tracks.id, ids))).run();
        res.json({ success: true, count: ids.length });
    });

    // ── Tracks: ingest scanned tracks ────────────────────────────────────
    // Body: { tracks: NewTrack[] (without id/userId) }. Uses UPSERT on
    // (user_id, filepath) so re-scanning a folder is idempotent.
    router.post("/tracks/ingest", (req, res) => {
        const { userId } = req as AuthedRequest;
        const incoming = (req.body?.tracks ?? []) as Array<Omit<NewTrack, "id" | "userId">>;
        if (!Array.isArray(incoming)) {
            res.status(400).json({ error: "tracks must be an array" });
            return;
        }
        const db = getLibraryDb();
        let inserted = 0;
        let skipped = 0;
        for (const t of incoming) {
            if (!t?.filepath || !t?.filename) { skipped++; continue; }
            try {
                db.insert(tracks).values({ ...t, userId }).run();
                inserted++;
                db.insert(scanLogs).values({
                    userId,
                    action: "added",
                    filepath: t.filepath,
                    details: `Scanned: ${t.artist || "Unknown"} - ${t.title || t.filename}`,
                }).run();
            } catch {
                skipped++; // UNIQUE(user_id, filepath) collision = already exists
            }
        }
        res.json({ success: true, inserted, skipped, total: incoming.length });
    });

    // ── Genres / Keys / Tags ─────────────────────────────────────────────
    router.get("/genres", (req, res) => {
        const { userId } = req as AuthedRequest;
        const db = getLibraryDb();
        const rows = db.select({ g: tracks.genre }).from(tracks)
            .where(eq(tracks.userId, userId))
            .groupBy(tracks.genre).orderBy(tracks.genre).all();
        res.json({ genres: rows.map((r) => r.g).filter(Boolean) });
    });

    router.get("/keys", (req, res) => {
        const { userId } = req as AuthedRequest;
        const db = getLibraryDb();
        const rows = db.select({ k: tracks.keyCamelot }).from(tracks)
            .where(and(eq(tracks.userId, userId), sql`${tracks.keyCamelot} IS NOT NULL`))
            .groupBy(tracks.keyCamelot).orderBy(tracks.keyCamelot).all();
        res.json({ keys: rows.map((r) => r.k).filter(Boolean) });
    });

    router.get("/tags", (req, res) => {
        const { userId } = req as AuthedRequest;
        const db = getLibraryDb();
        const rows = db.select({ t: tracks.tags }).from(tracks)
            .where(and(eq(tracks.userId, userId), sql`${tracks.tags} IS NOT NULL AND ${tracks.tags} != '[]'`)).all();
        const set = new Set<string>();
        for (const r of rows) {
            if (!r.t) continue;
            try { (JSON.parse(r.t) as string[]).forEach((x) => set.add(x)); } catch { /* ignore */ }
        }
        res.json({ tags: Array.from(set).sort() });
    });

    // ── Dashboard stats ──────────────────────────────────────────────────
    router.get("/stats", (req, res) => {
        const { userId } = req as AuthedRequest;
        const db = getLibraryDb();
        const u = eq(tracks.userId, userId);

        const total = db.select({ c: sql<number>`COUNT(*)` }).from(tracks).where(u).get()?.c ?? 0;
        const processed = db.select({ c: sql<number>`COUNT(*)` }).from(tracks).where(and(u, eq(tracks.isProcessed, true))).get()?.c ?? 0;
        const analyzed = db.select({ c: sql<number>`COUNT(*)` }).from(tracks).where(and(u, sql`${tracks.analyzedAt} IS NOT NULL`)).get()?.c ?? 0;
        const favorites = db.select({ c: sql<number>`COUNT(*)` }).from(tracks).where(and(u, eq(tracks.isFavorite, true))).get()?.c ?? 0;
        const avgBpm = db.select({ a: sql<number>`AVG(${tracks.bpm})` }).from(tracks).where(and(u, sql`${tracks.bpm} IS NOT NULL`)).get()?.a ?? 0;
        const totalDuration = db.select({ s: sql<number>`COALESCE(SUM(${tracks.duration}),0)` }).from(tracks).where(u).get()?.s ?? 0;
        const totalSize = db.select({ s: sql<number>`COALESCE(SUM(${tracks.fileSize}),0)` }).from(tracks).where(u).get()?.s ?? 0;
        const playlistCount = db.select({ c: sql<number>`COUNT(*)` }).from(playlists).where(eq(playlists.userId, userId)).get()?.c ?? 0;

        const rawGenreStats = db.select({ genre: tracks.genre, count: sql<number>`COUNT(*)` })
            .from(tracks).where(u).groupBy(tracks.genre).orderBy(sql`COUNT(*) DESC`).all();
        const energyStats = db.select({ energy: tracks.energy, count: sql<number>`COUNT(*)` })
            .from(tracks).where(and(u, sql`${tracks.energy} IS NOT NULL`))
            .groupBy(tracks.energy).orderBy(tracks.energy).all();
        const bpmRanges = db.select({
            range: sql<string>`CASE
                WHEN ${tracks.bpm} < 100 THEN '<100'
                WHEN ${tracks.bpm} < 120 THEN '100-119'
                WHEN ${tracks.bpm} < 130 THEN '120-129'
                WHEN ${tracks.bpm} < 140 THEN '130-139'
                WHEN ${tracks.bpm} < 150 THEN '140-149'
                WHEN ${tracks.bpm} < 160 THEN '150-159'
                ELSE '160+'
            END`,
            count: sql<number>`COUNT(*)`,
        }).from(tracks).where(and(u, sql`${tracks.bpm} IS NOT NULL`))
            .groupBy(sql`1`).orderBy(sql`MIN(${tracks.bpm})`).all();
        const keyStats = db.select({ key: tracks.keyCamelot, count: sql<number>`COUNT(*)` })
            .from(tracks).where(and(u, sql`${tracks.keyCamelot} IS NOT NULL AND ${tracks.keyCamelot} != ''`))
            .groupBy(tracks.keyCamelot).orderBy(sql`COUNT(*) DESC`).all();
        const formatStats = db.select({ format: sql<string>`UPPER(${tracks.format})`, count: sql<number>`COUNT(*)` })
            .from(tracks).where(and(u, sql`${tracks.format} IS NOT NULL`))
            .groupBy(sql`UPPER(${tracks.format})`).orderBy(sql`COUNT(*) DESC`).all();

        const missingGenre = db.select({ c: sql<number>`COUNT(*)` }).from(tracks).where(and(u, sql`${tracks.genre} IS NULL OR ${tracks.genre} = ''`)).get()?.c ?? 0;
        const missingBpm = db.select({ c: sql<number>`COUNT(*)` }).from(tracks).where(and(u, sql`${tracks.bpm} IS NULL`)).get()?.c ?? 0;
        const missingKey = db.select({ c: sql<number>`COUNT(*)` }).from(tracks).where(and(u, sql`${tracks.keyCamelot} IS NULL OR ${tracks.keyCamelot} = ''`)).get()?.c ?? 0;
        const missingEnergy = db.select({ c: sql<number>`COUNT(*)` }).from(tracks).where(and(u, sql`${tracks.energy} IS NULL`)).get()?.c ?? 0;
        const missingArtwork = db.select({ c: sql<number>`COUNT(*)` }).from(tracks).where(and(u, sql`${tracks.artworkUrl} IS NULL OR ${tracks.artworkUrl} = ''`)).get()?.c ?? 0;

        const recentTracks = db.select({
            id: tracks.id, title: tracks.title, artist: tracks.artist,
            genre: tracks.genre, bpm: tracks.bpm, keyCamelot: tracks.keyCamelot,
            energy: tracks.energy, rating: tracks.rating, artworkUrl: tracks.artworkUrl,
            addedAt: tracks.addedAt, duration: tracks.duration, isFavorite: tracks.isFavorite,
        }).from(tracks).where(u).orderBy(desc(tracks.addedAt)).limit(8).all();

        const topRated = db.select({
            id: tracks.id, title: tracks.title, artist: tracks.artist,
            rating: tracks.rating, artworkUrl: tracks.artworkUrl,
        }).from(tracks).where(and(u, sql`${tracks.rating} IS NOT NULL AND ${tracks.rating} >= 4`))
            .orderBy(desc(tracks.rating), desc(tracks.addedAt)).limit(5).all();

        // Genre normalization (mirrors web app logic)
        const UNKNOWN_PATTERNS = ["unknown", "unknowngenre", "unknown genre", "various", "other", "none", "n/a"];
        const genreMap = new Map<string, number>();
        for (const g of rawGenreStats) {
            const raw = (g.genre || "").trim();
            const lower = raw.toLowerCase();
            const normalized = !raw || UNKNOWN_PATTERNS.includes(lower)
                ? "Unknown"
                : raw.includes(",") ? raw.split(",")[0].trim() : raw;
            genreMap.set(normalized, (genreMap.get(normalized) || 0) + g.count);
        }
        const genreStats = Array.from(genreMap, ([genre, count]) => ({ genre, count }))
            .sort((a, b) => {
                if (a.genre === "Unknown") return 1;
                if (b.genre === "Unknown") return -1;
                return b.count - a.count;
            });

        res.json({
            total,
            processed,
            unprocessed: total - processed,
            analyzed,
            favorites,
            avgBpm: avgBpm ? Math.round(avgBpm) : 0,
            totalDuration,
            totalSize,
            playlistCount,
            genreStats,
            energyStats: energyStats.map((e) => ({ energy: e.energy ?? 0, count: e.count })),
            bpmRanges,
            keyStats: keyStats.map((k) => ({ key: k.key || "Unknown", count: k.count })),
            formatStats: formatStats.map((f) => ({ format: f.format || "Unknown", count: f.count })),
            health: {
                total,
                missingGenre, missingBpm, missingKey, missingEnergy, missingArtwork,
            },
            recentTracks,
            topRated,
        });
    });

    // ── Recent scans ─────────────────────────────────────────────────────
    router.get("/scan-logs", (req, res) => {
        const { userId } = req as AuthedRequest;
        const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 200);
        const db = getLibraryDb();
        const rows = db.select().from(scanLogs).where(eq(scanLogs.userId, userId))
            .orderBy(desc(scanLogs.scannedAt)).limit(limit).all();
        res.json({ logs: rows });
    });

    // ── Playlists ────────────────────────────────────────────────────────
    router.get("/playlists", (req, res) => {
        const { userId } = req as AuthedRequest;
        const db = getLibraryDb();
        const rows = db.select({
            id: playlists.id, name: playlists.name, description: playlists.description,
            type: playlists.type, createdAt: playlists.createdAt,
            trackCount: sql<number>`(SELECT COUNT(*) FROM playlist_tracks WHERE playlist_tracks.playlist_id = playlists.id)`.mapWith(Number),
        }).from(playlists).where(eq(playlists.userId, userId)).orderBy(playlists.name).all();
        res.json({ playlists: rows });
    });

    router.post("/playlists", (req, res) => {
        const { userId } = req as AuthedRequest;
        const { name, description } = req.body as { name: string; description?: string };
        if (!name) { res.status(400).json({ error: "name required" }); return; }
        const db = getLibraryDb();
        const row = db.insert(playlists).values({
            userId, name, description: description || null, type: "manual",
        }).returning().get();
        res.json({ playlist: row });
    });

    router.patch("/playlists/:id(\\d+)", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const data = req.body as { name?: string; description?: string };
        const db = getLibraryDb();
        db.update(playlists).set(data)
            .where(and(eq(playlists.id, id), eq(playlists.userId, userId))).run();
        res.json({ success: true });
    });

    router.delete("/playlists/:id(\\d+)", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const db = getLibraryDb();
        // Only delete if owned by user
        const owned = db.select({ id: playlists.id }).from(playlists)
            .where(and(eq(playlists.id, id), eq(playlists.userId, userId))).get();
        if (!owned) { res.status(404).json({ error: "Not found" }); return; }
        db.delete(playlistTracks).where(eq(playlistTracks.playlistId, id)).run();
        db.delete(playlists).where(eq(playlists.id, id)).run();
        res.json({ success: true });
    });

    router.get("/playlists/:id(\\d+)/tracks", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const page = Math.max(parseInt(String(req.query.page ?? "1"), 10), 1);
        const pageSize = Math.min(parseInt(String(req.query.pageSize ?? "50"), 10), 500);
        const offset = (page - 1) * pageSize;
        const db = getLibraryDb();

        const owned = db.select({ id: playlists.id }).from(playlists)
            .where(and(eq(playlists.id, id), eq(playlists.userId, userId))).get();
        if (!owned) { res.status(404).json({ error: "Not found" }); return; }

        const total = db.select({ c: sql<number>`COUNT(*)` }).from(playlistTracks)
            .where(eq(playlistTracks.playlistId, id)).get()?.c ?? 0;

        const rows = db.select({
            track: tracks,
            position: playlistTracks.position,
        }).from(playlistTracks)
            .innerJoin(tracks, and(eq(playlistTracks.trackId, tracks.id), eq(tracks.userId, userId)))
            .where(eq(playlistTracks.playlistId, id))
            .orderBy(playlistTracks.position)
            .limit(pageSize).offset(offset).all();

        res.json({
            tracks: rows.map((r) => ({ ...r.track, position: r.position })),
            total, page, pageSize,
            totalPages: Math.ceil(total / pageSize),
        });
    });

    router.post("/playlists/:id(\\d+)/tracks", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const { trackIds } = req.body as { trackIds: number[] };
        if (!Array.isArray(trackIds) || trackIds.length === 0) {
            res.json({ success: true, added: 0 });
            return;
        }
        const db = getLibraryDb();
        const owned = db.select({ id: playlists.id }).from(playlists)
            .where(and(eq(playlists.id, id), eq(playlists.userId, userId))).get();
        if (!owned) { res.status(404).json({ error: "Not found" }); return; }

        // Only allow track ids that belong to this user
        const valid = db.select({ id: tracks.id }).from(tracks)
            .where(and(eq(tracks.userId, userId), inArray(tracks.id, trackIds))).all().map((r) => r.id);

        const maxPos = db.select({ m: sql<number>`COALESCE(MAX(position), 0)` })
            .from(playlistTracks).where(eq(playlistTracks.playlistId, id)).get()?.m ?? 0;

        const existing = db.select({ trackId: playlistTracks.trackId }).from(playlistTracks)
            .where(and(eq(playlistTracks.playlistId, id), inArray(playlistTracks.trackId, valid))).all()
            .map((r) => r.trackId);

        const toAdd = valid.filter((tid) => !existing.includes(tid));
        let position = maxPos + 1;
        for (const trackId of toAdd) {
            db.insert(playlistTracks).values({ playlistId: id, trackId, position }).run();
            position++;
        }
        res.json({ success: true, added: toAdd.length });
    });

    router.delete("/playlists/:id(\\d+)/tracks/:trackId(\\d+)", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const trackId = parseInt(req.params.trackId, 10);
        const db = getLibraryDb();
        const owned = db.select({ id: playlists.id }).from(playlists)
            .where(and(eq(playlists.id, id), eq(playlists.userId, userId))).get();
        if (!owned) { res.status(404).json({ error: "Not found" }); return; }
        db.delete(playlistTracks)
            .where(and(eq(playlistTracks.playlistId, id), eq(playlistTracks.trackId, trackId))).run();
        res.json({ success: true });
    });

    // ── Downloads (history) ──────────────────────────────────────────────
    router.get("/downloads", (req, res) => {
        const { userId } = req as AuthedRequest;
        const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
        const db = getLibraryDb();
        const rows = db.select().from(downloads).where(eq(downloads.userId, userId))
            .orderBy(desc(downloads.downloadedAt)).limit(limit).all();
        res.json({ downloads: rows });
    });

    router.post("/downloads", (req, res) => {
        const { userId } = req as AuthedRequest;
        const data = req.body as Partial<typeof downloads.$inferInsert>;
        if (!data.url) { res.status(400).json({ error: "url required" }); return; }
        const db = getLibraryDb();
        const row = db.insert(downloads).values({
            ...data, userId, status: data.status ?? "pending", url: data.url,
        }).returning().get();
        res.json({ download: row });
    });

    // ── Analyzer (DSP + source separation) ───────────────────────────────
    //
    // POST /analyze
    //   body: { trackIds: number[], options: AnalyzeOptions }
    //   returns: { jobs: Array<{ id, trackId }> }
    //   Enqueues one analyzer job per track. The analyzer is a Python
    //   sidecar (see ./analyzer.ts) that runs Essentia/audio-separator
    //   off the main thread. Per-track results are persisted to the
    //   tracks row when the job completes (see the once("complete")
    //   wiring at the bottom of this function).
    router.post("/analyze", async (req, res) => {
        const { userId } = req as AuthedRequest;
        const { trackIds, options } = req.body as {
            trackIds?: number[]; options?: AnalyzeOptions;
        };
        if (!Array.isArray(trackIds) || trackIds.length === 0) {
            res.status(400).json({ error: "trackIds required" });
            return;
        }
        const opts: AnalyzeOptions = {
            dsp: options?.dsp ?? true,
            stems: options?.stems ?? false,
            fingerprint: options?.fingerprint ?? false,
            stemsModel: options?.stemsModel,
        };
        const db = getLibraryDb();
        // Resolve absolute file paths (filtered by ownership).
        const rows = db.select({ id: tracks.id, filepath: tracks.filepath })
            .from(tracks)
            .where(and(eq(tracks.userId, userId), inArray(tracks.id, trackIds)))
            .all();
        const enqueued: Array<{ id: string; trackId: number }> = [];
        for (const row of rows) {
            if (!row.filepath || !existsSync(row.filepath)) continue;
            // Mark stems status so the UI can show "queued" badges.
            if (opts.stems) {
                db.update(tracks).set({ stemsStatus: "queued" })
                    .where(eq(tracks.id, row.id)).run();
            }
            const job = analyzer.enqueue(row.id, row.filepath, opts);
            enqueued.push({ id: job.id, trackId: row.id });
        }
        res.json({ jobs: enqueued });
    });

    // GET /analyze/status?since=<ms> — current + queued + recently
    // completed jobs. The optional `since` query param asks the
    // server to also return total finished/errored counts at-or-after
    // that timestamp from sqlite — the UI uses this for the batch
    // progress counter, which would otherwise be capped by the
    // in-memory completed ring buffer (max 128 entries).
    router.get("/analyze/status", (req, res) => {
        const sinceRaw = req.query.since;
        const since = typeof sinceRaw === "string" ? Number.parseInt(sinceRaw, 10) : undefined;
        res.json(analyzer.status(Number.isFinite(since) ? since : undefined));
    });

    // GET /analyze/job/:id — single-job snapshot (for polling).
    router.get("/analyze/job/:id", (req, res) => {
        const job = analyzer.findJob(req.params.id);
        if (!job) { res.status(404).json({ error: "Not found" }); return; }
        res.json({ job });
    });

    // POST /analyze/cancel/:id — drop from queue or kill the in-flight
    // python child (which automatically resets back to "queued" via
    // the analyzer's failCurrentJob path).
    router.post("/analyze/cancel/:id", (req, res) => {
        const ok = analyzer.cancel(req.params.id);
        res.json({ canceled: ok });
    });

    // POST /analyze/retry/:id — re-enqueue a completed (or queued)
    // job using its original path + options. Useful for transient
    // failures like "python exited (SIGTERM)".
    router.post("/analyze/retry/:id", (req, res) => {
        const job = analyzer.retry(req.params.id);
        if (!job) {
            res.status(404).json({ error: "Job not found or source missing" });
            return;
        }
        res.json({ job: { id: job.id, trackId: job.trackId } });
    });

    // POST /analyze/queue/clear — drop queued (not-yet-started) jobs.
    // Body `{ category?: "dsp"|"stems"|"fingerprint"|"all" }` to scope
    // to one lane. Default: all lanes. Doesn't touch in-flight work.
    router.post("/analyze/queue/clear", (req, res) => {
        const cat = (req.body?.category ?? "all") as
            "dsp" | "stems" | "fingerprint" | "all";
        const removed = analyzer.clearQueue(cat);
        res.json({ removed, category: cat });
    });

    // POST /analyze/pause — pause one lane or all lanes. Currently
    // running sub-job continues; new work is held until resume.
    // Body: `{ category?: "dsp"|"stems"|"fingerprint"|"all" }`.
    router.post("/analyze/pause", (req, res) => {
        const cat = (req.body?.category ?? "all") as
            "dsp" | "stems" | "fingerprint" | "all";
        analyzer.pause(cat);
        res.json({ paused: true, category: cat });
    });

    // POST /analyze/resume — counterpart to /analyze/pause.
    router.post("/analyze/resume", (req, res) => {
        const cat = (req.body?.category ?? "all") as
            "dsp" | "stems" | "fingerprint" | "all";
        analyzer.resume(cat);
        res.json({ paused: false, category: cat });
    });

    // DELETE /analyze/completed/:id — drop one entry from the
    // recently-completed ring buffer (UI cleanup only).
    router.delete("/analyze/completed/:id", (req, res) => {
        const ok = analyzer.removeCompleted(req.params.id);
        res.json({ removed: ok });
    });

    // POST /analyze/completed/clear?filter=all|errored|done — clear
    // the ring buffer. Default: all.
    router.post("/analyze/completed/clear", (req, res) => {
        const f = String(req.query.filter ?? "all");
        const filter = f === "errored" || f === "done" ? f : "all";
        const removed = analyzer.clearCompleted(filter);
        res.json({ removed, filter });
    });

    // POST /analyze/retry-failed — bulk retry every errored entry in
    // the recently-completed buffer. Returns the freshly-enqueued ids.
    router.post("/analyze/retry-failed", (_req, res) => {
        const status = analyzer.status();
        const ids = (status.completed ?? [])
            .filter((j) => !!j.error)
            .map((j) => j.id);
        const enqueued: Array<{ id: string; trackId: number }> = [];
        for (const id of ids) {
            const job = analyzer.retry(id);
            if (job) enqueued.push({ id: job.id, trackId: job.trackId });
        }
        res.json({ enqueued: enqueued.length, jobs: enqueued });
    });

    // GET /analyze/health — Python availability + installed deps. Lets
    // the Reanalyze modal hide unavailable options instead of failing.
    router.get("/analyze/health", async (_req, res) => {
        const h = await analyzer.health();
        res.json(h);
    });

    // POST /analyze/gpu/install — pip-install GPU acceleration packages
    // into the user's python interpreter and restart the sidecar.
    // Body: { target?: "onnx" | "torch" | "all" }  (default "onnx")
    router.post("/analyze/gpu/install", async (req, res) => {
        const target = (req.body?.target ?? "onnx") as "onnx" | "torch" | "all";
        if (!["onnx", "torch", "all"].includes(target)) {
            res.status(400).json({ error: `invalid target: ${target}` });
            return;
        }
        try {
            const result = await analyzer.installGpu(target);
            res.json(result);
        } catch (e) {
            res.status(500).json({
                error: e instanceof Error ? e.message : String(e),
            });
        }
    });

    // POST /analyze/restart — manually restart the python sidecar.
    // Useful after the user installs deps via terminal and wants the
    // companion to re-detect them without restarting the whole app.
    router.post("/analyze/restart", async (req, res) => {
        const force = req.body?.force === true;
        try {
            await analyzer.restartSidecar({ force });
            const h = await analyzer.health();
            res.json({ ok: true, health: h });
        } catch (e) {
            res.status(409).json({
                error: e instanceof Error ? e.message : String(e),
            });
        }
    });

    // GET /analyze/logs?since=<seq>&limit=<n> — append-only log feed
    // for the Analysis page. Returns entries with seq > since.
    router.get("/analyze/logs", (req, res) => {
        const since = parseInt(String(req.query.since ?? "0"), 10) || 0;
        const limit = Math.min(1000, parseInt(String(req.query.limit ?? "500"), 10) || 500);
        res.json({ logs: analyzer.getLogs(since, limit) });
    });

    // ── Stems serving ────────────────────────────────────────────────
    //
    // GET /stems/:trackId/:stem — serves the cached stem WAV produced
    // by the analyzer. `stem` is one of vocals|drums|bass|other|
    // instrumental|guitar|piano. Validates ownership before opening
    // the file. Supports HTTP range so the web client can use it as a
    // <audio src=…> for previews.
    router.get("/stems/:trackId(\\d+)/:stem([a-z]+\\.wav)", (req, res) => {
        const { userId } = req as AuthedRequest;
        const trackId = parseInt(req.params.trackId, 10);
        const stem = req.params.stem;
        const db = getLibraryDb();
        const row = db.select({ id: tracks.id }).from(tracks)
            .where(and(eq(tracks.id, trackId), eq(tracks.userId, userId)))
            .get();
        if (!row) { res.status(404).json({ error: "Not found" }); return; }
        const file = path.join(analyzer.stemsDirFor(trackId), stem);
        if (!existsSync(file)) {
            res.status(404).json({ error: "Stem not yet generated" });
            return;
        }
        const stat = statSync(file);
        const range = req.headers.range;
        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Accept-Ranges", "bytes");
        if (range) {
            const m = /^bytes=(\d+)-(\d*)$/.exec(range);
            if (m) {
                const start = parseInt(m[1], 10);
                const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
                res.status(206);
                res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
                res.setHeader("Content-Length", String(end - start + 1));
                createReadStream(file, { start, end }).pipe(res);
                return;
            }
        }
        res.setHeader("Content-Length", String(stat.size));
        createReadStream(file).pipe(res);
    });

    // ── Persist analyzer results back to the tracks table ────────────
    //
    // Persistence wire-up lives in `analyzer.ts` itself (in the
    // Analyzer constructor) so the listener attaches BEFORE the
    // rehydrate microtask can fire any "complete" event on a fresh
    // restart. Keeping it there also makes the analyzer module a
    // single source of truth — no risk of routes.ts being imported
    // late (or twice) and missing/duplicating writes.

    return router;
}
