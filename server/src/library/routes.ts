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
import { tracks, playlists, playlistTracks, scanLogs, downloads, savedDrives } from "./schema";
import type { NewTrack } from "./schema";
import { analyzer, type AnalyzeOptions } from "./analyzer";
import { enqueueSyncChange } from "../sync";
import { listConnectedDrives } from "./drives";
import { inspectRekordboxDrive, cleanRekordboxDrive } from "./rekordbox-drive";
import { validateCopyRequest, resolveTrackTarget } from "./usb-copy";
import { runExport, type ManifestTrack, type ManifestPlaylist, type TranscodePolicy } from "./rekordbox-export";
import { createReadStream, statSync, existsSync } from "node:fs";
import { copyFile, mkdir, stat as statAsync } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ─── Sync helpers ───────────────────────────────────────────────────────────
//
// Every local mutation that should round-trip to cloud Postgres calls
// `pushTrackChange(...)` (or its playlist/cuepoint cousin). The helper is
// a thin wrapper around `enqueueSyncChange()` so the route handlers stay
// readable. We use the track's `sha256` if present (preferred — stable
// across devices); otherwise we fall back to `<userId>:<localId>` so the
// cloud at least gets an idempotent key for the upsert.
//
// Failure to enqueue must NEVER fail the route — local writes are the
// authoritative store; sync is best-effort.

function pushTrackChange(
    op: "upsert" | "delete",
    row: { id: number; userId: string; sha256?: string | null } & Record<string, unknown>,
    extraPayload?: Record<string, unknown>,
) {
    try {
        const sha = (row.sha256 ?? "") as string;
        const entityId = sha || `${row.userId}:${row.id}`;
        enqueueSyncChange({
            entity: "tracks",
            entityId,
            op,
            // `companionTrackId` lets the cloud round-trip the companion's
            // local row id, so the web app's write actions (rating, tags…)
            // can target the right companion track even when reads now come
            // from cloud Postgres.
            payload: { sha256: sha || undefined, ...row, companionTrackId: row.id, ...extraPayload },
            updatedAt: new Date().toISOString(),
        });
    } catch {
        // Sync subsystem may not be initialised yet (e.g. unpaired device).
        // The local write already happened; nothing else to do.
    }
}

function pushPlaylistChange(
    op: "upsert" | "delete",
    row: { id: number; userId: string } & Record<string, unknown>,
) {
    try {
        // Playlists are keyed in cloud by externalId (UUID). Older rows
        // without one fall back to a deterministic synthetic id so the
        // cloud can still upsert; the next pull will rehydrate the proper
        // externalId once the cloud assigns one.
        const ext = (row.externalId as string | undefined) || `${row.userId}:pl:${row.id}`;
        enqueueSyncChange({
            entity: "playlists",
            entityId: ext,
            op,
            payload: { externalId: ext, ...row },
            updatedAt: new Date().toISOString(),
        });
    } catch { /* see pushTrackChange */ }
}

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

/**
 * Group exportable tracks into auto-crates ("By Genre" / "By BPM" / "By Key")
 * for the rekordbox export. Each requested dimension yields one playlist per
 * distinct bucket value. BPM is bucketed into 10-wide ranges. Tracks with no
 * value for a dimension are skipped for that crate only.
 */
function buildAutoCrates(
    manifestTracks: ManifestTrack[],
    rows: Array<{ id: number; bpm: number | null; genre: string | null; keyCamelot: string | null; keyMusical: string | null }>,
    dims: Array<"genre" | "bpm" | "key">,
): Array<{ name: string; trackIds: number[] }> {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const order = manifestTracks.map((t) => t.id);
    const out: Array<{ name: string; trackIds: number[] }> = [];

    const collect = (label: (r: NonNullable<ReturnType<typeof byId.get>>) => string | null, prefix: string) => {
        const buckets = new Map<string, number[]>();
        for (const id of order) {
            const r = byId.get(id);
            if (!r) continue;
            const key = label(r);
            if (!key) continue;
            const arr = buckets.get(key) ?? [];
            arr.push(id);
            buckets.set(key, arr);
        }
        for (const [name, trackIds] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            out.push({ name: `${prefix} ${name}`, trackIds });
        }
    };

    for (const d of dims) {
        if (d === "genre") collect((r) => r.genre?.trim() || null, "Genre:");
        else if (d === "key") collect((r) => (r.keyCamelot || r.keyMusical)?.trim() || null, "Key:");
        else if (d === "bpm") {
            collect((r) => {
                if (r.bpm == null) return null;
                const lo = Math.floor(r.bpm / 10) * 10;
                return `${lo}-${lo + 9}`;
            }, "BPM:");
        }
    }
    return out;
}

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
        // Re-read the row so the sync payload includes whatever shape the
        // cloud needs, including any sha256 / external columns we don't
        // touch in this PATCH.
        const row = db.select().from(tracks)
            .where(and(eq(tracks.id, id), eq(tracks.userId, userId))).get();
        if (row) pushTrackChange("upsert", row);
        res.json({ success: true });
    });

    // ── Tracks: delete ───────────────────────────────────────────────────
    router.delete("/tracks/:id(\\d+)", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const db = getLibraryDb();
        const row = db.select().from(tracks)
            .where(and(eq(tracks.id, id), eq(tracks.userId, userId))).get();
        db.delete(tracks).where(and(eq(tracks.id, id), eq(tracks.userId, userId))).run();
        if (row) pushTrackChange("delete", row);
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
        const full = db.select().from(tracks)
            .where(and(eq(tracks.id, id), eq(tracks.userId, userId))).get();
        if (full) pushTrackChange("upsert", full);
        res.json({ success: true, isFavorite: next });
    });

    // ── Tracks: set rating ───────────────────────────────────────────────
    router.post("/tracks/:id(\\d+)/rating", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const { rating } = req.body as { rating: unknown };
        // Accept integer 1-5 or null/0 (clear). Reject everything else;
        // Drizzle would otherwise pass strings/NaN straight to SQLite.
        let nextRating: number | null;
        if (rating == null || rating === 0) nextRating = null;
        else if (typeof rating === "number" && Number.isInteger(rating) && rating >= 1 && rating <= 5) nextRating = rating;
        else { res.status(400).json({ error: "rating must be 1-5 or null" }); return; }
        const db = getLibraryDb();
        db.update(tracks).set({ rating: nextRating })
            .where(and(eq(tracks.id, id), eq(tracks.userId, userId))).run();
        const full = db.select().from(tracks)
            .where(and(eq(tracks.id, id), eq(tracks.userId, userId))).get();
        if (full) pushTrackChange("upsert", full);
        res.json({ success: true });
    });

    // ── Tracks: set tags ─────────────────────────────────────────────────
    router.post("/tracks/:id(\\d+)/tags", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const { tags: newTags } = req.body as { tags: unknown };
        // Strict shape: array of short strings. Without this any JSON
        // shape lands in the column verbatim and breaks downstream
        // readers that assume `string[]`.
        if (!Array.isArray(newTags)) { res.status(400).json({ error: "tags must be string[]" }); return; }
        if (newTags.length > 64) { res.status(413).json({ error: "too many tags (max 64)" }); return; }
        const safeTags: string[] = [];
        for (const t of newTags) {
            if (typeof t !== "string" || t.length === 0 || t.length > 64) {
                res.status(400).json({ error: "each tag must be a non-empty string ≤ 64 chars" });
                return;
            }
            safeTags.push(t);
        }
        const db = getLibraryDb();
        db.update(tracks).set({ tags: JSON.stringify(safeTags) })
            .where(and(eq(tracks.id, id), eq(tracks.userId, userId))).run();
        const full = db.select().from(tracks)
            .where(and(eq(tracks.id, id), eq(tracks.userId, userId))).get();
        if (full) pushTrackChange("upsert", full);
        res.json({ success: true });
    });

    // ── Tracks: bulk hide / unhide ───────────────────────────────────────
    router.post("/tracks/hide", (req, res) => {
        const { userId } = req as AuthedRequest;
        const { ids, hidden } = req.body as { ids: unknown; hidden: unknown };
        if (!Array.isArray(ids) || ids.length === 0) {
            res.json({ success: true, count: 0 });
            return;
        }
        // Cap + integer-coerce. Without the cap a 1M-id payload builds
        // a 1M-placeholder SQL statement and locks the SQLite writer.
        if (ids.length > 5000) {
            res.status(413).json({ error: "too many ids (max 5000)" });
            return;
        }
        const intIds: number[] = [];
        for (const v of ids) {
            if (typeof v === "number" && Number.isInteger(v) && v > 0) intIds.push(v);
        }
        if (intIds.length === 0) { res.json({ success: true, count: 0 }); return; }
        const db = getLibraryDb();
        db.update(tracks).set({ isHidden: !!hidden })
            .where(and(eq(tracks.userId, userId), inArray(tracks.id, intIds))).run();
        // Enqueue one sync event per affected row so per-field LWW can
        // converge on the cloud side.
        const rows = db.select().from(tracks)
            .where(and(eq(tracks.userId, userId), inArray(tracks.id, intIds))).all();
        for (const row of rows) pushTrackChange("upsert", row);
        res.json({ success: true, count: intIds.length });
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
        // Cap per-request batch size. The route already has a 64MB body
        // limit; this protects the event loop from a single legit-sized
        // body that still contains hundreds of thousands of small rows.
        if (incoming.length > 10_000) {
            res.status(413).json({ error: "too many tracks per batch (max 10000)" });
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

    // ── Connected drives ─────────────────────────────────────────────────
    //
    // GET /library/drives
    // Returns the list of physical drives currently mounted on the
    // companion's host machine. The web app surfaces these in the Drive
    // Manager so the user can pick a target for USB-export of a CDJ
    // library. Drives are *local* by definition (the user's hardware) so
    // the companion is the only place this can run truthfully.
    //
    // Per-user scoping does not apply (drive enumeration is host-wide),
    // but the route still requires `requireUser` so an unauthenticated
    // browser can't probe the user's filesystem.
    router.get("/drives", (_req, res) => {
        try {
            const drives = listConnectedDrives();
            // Annotate each drive with its rekordbox library status so the
            // Drives manager can show track counts / variants without a
            // second round-trip.
            const annotated = drives.map((d) => {
                try {
                    return { ...d, rekordbox: inspectRekordboxDrive(d.path) };
                } catch {
                    return { ...d, rekordbox: null };
                }
            });
            res.json({ drives: annotated });
        } catch (err) {
            res.status(500).json({
                error: err instanceof Error ? err.message : "Failed to enumerate drives",
            });
        }
    });

    // GET /library/drives/watch  (SSE)
    // Pushes the annotated drive list whenever the set of mounted drives
    // changes (plug/unplug) or their rekordbox status changes. The companion
    // polls enumeration internally on a short interval and only emits when
    // the serialized snapshot differs, so the browser gets push-style updates
    // without any native OS hooks. A `drives` event is sent immediately on
    // connect, then on every change, plus a periodic `ping` to keep the
    // connection alive through proxies.
    router.get("/drives/watch", (_req, res) => {
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-store");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        const snapshot = () => {
            const drives = listConnectedDrives().map((d) => {
                try {
                    return { ...d, rekordbox: inspectRekordboxDrive(d.path) };
                } catch {
                    return { ...d, rekordbox: null };
                }
            });
            return drives;
        };

        let lastJson = "";
        const tick = () => {
            let drives;
            try {
                drives = snapshot();
            } catch {
                return;
            }
            const json = JSON.stringify(drives);
            if (json !== lastJson) {
                lastJson = json;
                res.write(`event: drives\ndata: ${json}\n\n`);
            }
        };

        // Emit the initial snapshot, then poll for changes.
        tick();
        const poll = setInterval(tick, 3000);
        const ping = setInterval(() => res.write(`event: ping\ndata: {}\n\n`), 25000);
        const stop = () => {
            clearInterval(poll);
            clearInterval(ping);
        };
        res.on("close", stop);
    });

    // POST /library/drives/rekordbox/clean
    // Body: { drive: string, includeOneLibrary?: boolean, includeContents?: boolean }
    //
    // Removes the rekordbox database + analysis files from a connected drive
    // so it can be re-exported cleanly. Audio under `Contents/` is preserved
    // unless `includeContents` is set. The encrypted OneLibrary is preserved
    // unless `includeOneLibrary` is set.
    //
    // SECURITY: `drive` MUST be an absolute path; deletion is confined to
    // `<drive>/PIONEER/rekordbox`, `<drive>/PIONEER/USBANLZ` and (opt-in)
    // `<drive>/Contents`.
    router.post("/drives/rekordbox/clean", (req, res) => {
        const body = (req.body ?? {}) as {
            drive?: unknown;
            includeOneLibrary?: unknown;
            includeContents?: unknown;
        };
        const drive = typeof body.drive === "string" ? body.drive.trim() : "";
        if (!drive || !path.isAbsolute(drive)) {
            res.status(400).json({ error: "drive: absolute path required" });
            return;
        }
        if (!existsSync(drive)) {
            res.status(400).json({ error: "drive does not exist" });
            return;
        }
        try {
            const result = cleanRekordboxDrive(drive, {
                includeOneLibrary: body.includeOneLibrary === true,
                includeContents: body.includeContents === true,
            });
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({
                error: err instanceof Error ? err.message : "Failed to clean drive",
            });
        }
    });

    // ── USB audio copy ───────────────────────────────────────────────────
    //
    // POST /library/usb/copy
    // Body: { trackIds: number[], destination: string, musicSubdir?: string,
    //         stream?: boolean }
    //
    // Copies the audio files for the given track ids onto the destination
    // drive at `<destination>/<musicSubdir>/<basename>`. Streams progress
    // via SSE by default. The Serato / Rekordbox crate writers (which
    // only emit metadata) live elsewhere — this endpoint moves the bytes.
    //
    // SECURITY: the destination MUST be an absolute path; the subdir is
    // normalised and rejected if it tries to escape the destination root
    // via `..`. The source filepath is reduced to its basename so a
    // tampered tracks row can't influence target placement. Per-user
    // scoping ensures a track id from another user produces a 404, not
    // an unauthorised copy.
    router.post("/usb/copy", async (req, res) => {
        const { userId } = req as AuthedRequest;
        const body = (req.body ?? {}) as {
            trackIds?: unknown;
            destination?: unknown;
            musicSubdir?: unknown;
            stream?: unknown;
        };

        const ids = Array.isArray(body.trackIds)
            ? body.trackIds.filter((n): n is number => Number.isInteger(n) && n > 0)
            : [];
        if (ids.length === 0) {
            res.status(400).json({ error: "trackIds: non-empty array of positive integers required" });
            return;
        }
        if (ids.length > 5000) {
            res.status(400).json({ error: "trackIds: at most 5000 per request" });
            return;
        }

        const v = validateCopyRequest({
            destination: body.destination,
            musicSubdir: body.musicSubdir,
        });
        if (!v.ok) { res.status(400).json({ error: v.error }); return; }

        if (!existsSync(v.destination)) {
            res.status(400).json({ error: "destination does not exist" });
            return;
        }

        // Look up rows scoped to the authed user. Drizzle's `inArray`
        // with a 5000-item cap above keeps the SQL parameter count
        // well under SQLite's 32766 limit.
        const db = getLibraryDb();
        const rows = db
            .select({ id: tracks.id, filepath: tracks.filepath, title: tracks.title })
            .from(tracks)
            .where(and(eq(tracks.userId, userId), inArray(tracks.id, ids)))
            .all();

        // Ensure the target subdir exists (recursive — covers Music/2025).
        try {
            await mkdir(v.targetDir, { recursive: true });
        } catch (err) {
            res.status(500).json({
                error: err instanceof Error ? err.message : "Failed to create target dir",
            });
            return;
        }

        const useStream = body.stream !== false;
        if (useStream) {
            res.status(200);
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");
            const send = (event: string, data: unknown) => {
                res.write(`event: ${event}\n`);
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };
            let copied = 0;
            let skipped = 0;
            let errors = 0;
            const total = rows.length;
            send("start", { total, targetDir: v.targetDir });
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (!row.filepath) {
                    errors++;
                    send("progress", { index: i + 1, total, status: "error", error: "no filepath", trackId: row.id });
                    continue;
                }
                try {
                    let target: string;
                    try {
                        target = resolveTrackTarget(v.targetDir, row.filepath);
                    } catch (e) {
                        errors++;
                        send("progress", {
                            index: i + 1, total, status: "error",
                            error: e instanceof Error ? e.message : "bad source filename",
                            trackId: row.id,
                        });
                        continue;
                    }
                    if (!existsSync(row.filepath)) {
                        errors++;
                        send("progress", {
                            index: i + 1, total, status: "error",
                            error: "source missing", trackId: row.id, file: row.filepath,
                        });
                        continue;
                    }
                    // Skip when target already exists with the same size
                    // (cheap idempotency — full sha verification would
                    // double the I/O for a feature users run repeatedly).
                    if (existsSync(target)) {
                        const [src, dst] = await Promise.all([
                            statAsync(row.filepath),
                            statAsync(target),
                        ]);
                        if (src.size === dst.size) {
                            skipped++;
                            send("progress", {
                                index: i + 1, total, status: "skipped",
                                trackId: row.id, file: target, size: dst.size,
                            });
                            continue;
                        }
                    }
                    await copyFile(row.filepath, target);
                    const final = await statAsync(target);
                    copied++;
                    send("progress", {
                        index: i + 1, total, status: "copied",
                        trackId: row.id, file: target, size: final.size,
                    });
                } catch (e) {
                    errors++;
                    send("progress", {
                        index: i + 1, total, status: "error",
                        error: e instanceof Error ? e.message : String(e),
                        trackId: row.id,
                    });
                }
            }
            send("done", { copied, skipped, errors, total });
            res.end();
            return;
        }

        // Non-streaming fallback.
        let copied = 0, skipped = 0, errors = 0;
        for (const row of rows) {
            if (!row.filepath || !existsSync(row.filepath)) { errors++; continue; }
            try {
                const target = resolveTrackTarget(v.targetDir, row.filepath);
                if (existsSync(target)) {
                    const [src, dst] = await Promise.all([
                        statAsync(row.filepath), statAsync(target),
                    ]);
                    if (src.size === dst.size) { skipped++; continue; }
                }
                await copyFile(row.filepath, target);
                copied++;
            } catch { errors++; }
        }
        res.json({ copied, skipped, errors, total: rows.length });
    });

    // POST /library/rekordbox/export
    // Body: { trackIds?: number[], playlistIds?: number[], destination: string,
    //         autoCrates?: ("genre"|"bpm"|"key")[], transcode?: TranscodePolicy,
    //         writeAnlz?: boolean }
    //
    // Writes a true plug-and-play CDJ/XDJ USB at `destination` via the native
    // `rbexport` sidecar: Contents/ audio + export.pdb + exportExt.pdb +
    // USBANLZ analysis (beatgrid, cues, color waveforms). Progress streams
    // over SSE. Track rows are scoped to the authed user.
    router.post("/rekordbox/export", async (req, res) => {
        const { userId } = req as AuthedRequest;
        const body = (req.body ?? {}) as {
            trackIds?: unknown;
            playlistIds?: unknown;
            destination?: unknown;
            autoCrates?: unknown;
            transcode?: unknown;
            writeAnlz?: unknown;
        };

        const destination = typeof body.destination === "string" ? body.destination.trim() : "";
        if (!destination || !path.isAbsolute(destination)) {
            res.status(400).json({ error: "destination: absolute path required" });
            return;
        }
        if (!existsSync(destination)) {
            res.status(400).json({ error: "destination does not exist" });
            return;
        }

        const explicitIds = Array.isArray(body.trackIds)
            ? body.trackIds.filter((n): n is number => Number.isInteger(n) && n > 0)
            : [];
        const playlistIds = Array.isArray(body.playlistIds)
            ? body.playlistIds.filter((n): n is number => Number.isInteger(n) && n > 0)
            : [];
        const transcode = (["none", "incompatible", "all"] as const).includes(body.transcode as TranscodePolicy)
            ? (body.transcode as TranscodePolicy)
            : "incompatible";
        const autoCrates = Array.isArray(body.autoCrates)
            ? body.autoCrates.filter((c): c is "genre" | "bpm" | "key" =>
                c === "genre" || c === "bpm" || c === "key")
            : [];

        const db = getLibraryDb();

        // Resolve the track id set: explicit ids ∪ all ids in the chosen
        // playlists. Always scoped to the authed user.
        const idSet = new Set<number>(explicitIds);
        for (const pid of playlistIds) {
            const owned = db.select({ id: playlists.id }).from(playlists)
                .where(and(eq(playlists.id, pid), eq(playlists.userId, userId))).get();
            if (!owned) continue;
            const pts = db.select({ trackId: playlistTracks.trackId }).from(playlistTracks)
                .where(eq(playlistTracks.playlistId, pid)).all();
            for (const r of pts) idSet.add(r.trackId);
        }
        // No explicit selection → export the whole library.
        let ids = [...idSet];
        if (ids.length === 0 && playlistIds.length === 0) {
            const all = db.select({ id: tracks.id }).from(tracks)
                .where(eq(tracks.userId, userId)).all();
            ids = all.map((r) => r.id);
        }
        if (ids.length === 0) {
            res.status(400).json({ error: "no tracks to export" });
            return;
        }
        if (ids.length > 20000) {
            res.status(400).json({ error: "too many tracks (max 20000)" });
            return;
        }

        const rows = db.select().from(tracks)
            .where(and(eq(tracks.userId, userId), inArray(tracks.id, ids)))
            .all();

        const manifestTracks: ManifestTrack[] = rows
            .filter((r) => r.filepath && existsSync(r.filepath))
            .map((r) => ({
                id: r.id,
                source_path: r.filepath,
                title: r.title ?? undefined,
                artist: r.artist ?? undefined,
                album: r.album ?? undefined,
                genre: r.genre ?? undefined,
                label: r.label ?? undefined,
                key: r.keyMusical ?? r.keyCamelot ?? undefined,
                bpm: r.bpm ?? undefined,
                duration_sec: r.duration ?? undefined,
            }));

        if (manifestTracks.length === 0) {
            res.status(400).json({ error: "no exportable tracks (sources missing on disk)" });
            return;
        }

        // Build the playlist tree: explicit playlists first, then any
        // requested auto-crates (By Genre / By BPM / By Key).
        const manifestPlaylists: ManifestPlaylist[] = [];
        const exportable = new Set(manifestTracks.map((t) => t.id));
        let nextPlaylistId = 1_000_000; // synthetic ids for auto-crates
        for (const pid of playlistIds) {
            const pl = db.select({ id: playlists.id, name: playlists.name }).from(playlists)
                .where(and(eq(playlists.id, pid), eq(playlists.userId, userId))).get();
            if (!pl) continue;
            const pts = db.select({ trackId: playlistTracks.trackId, position: playlistTracks.position })
                .from(playlistTracks).where(eq(playlistTracks.playlistId, pid))
                .orderBy(playlistTracks.position).all();
            manifestPlaylists.push({
                id: pl.id, name: pl.name, parent: 0, is_folder: false,
                track_ids: pts.map((p) => p.trackId).filter((t) => exportable.has(t)),
            });
        }
        if (autoCrates.length > 0) {
            const buckets = buildAutoCrates(manifestTracks, rows, autoCrates);
            for (const b of buckets) {
                manifestPlaylists.push({
                    id: nextPlaylistId++, name: b.name, parent: 0,
                    is_folder: false, track_ids: b.trackIds,
                });
            }
        }

        res.status(200);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        const send = (event: string, data: unknown) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const ac = new AbortController();
        // Abort only when the *response* connection drops (client navigated
        // away / closed the stream). NOT `req.on("close")` — for a buffered
        // POST body that fires as soon as the body is received, which would
        // kill the export immediately.
        res.on("close", () => ac.abort());

        send("start", {
            tracks: manifestTracks.length,
            playlists: manifestPlaylists.length,
            destination,
        });
        try {
            for await (const ev of runExport({
                destination,
                options: {
                    write_pdb: true,
                    write_ext: true,
                    write_anlz: body.writeAnlz !== false,
                    auto_cue: true,
                    transcode,
                },
                tracks: manifestTracks,
                playlists: manifestPlaylists,
            }, { signal: ac.signal })) {
                send(ev.kind, ev);
            }
        } catch (e) {
            send("error", { error: e instanceof Error ? e.message : String(e) });
        }
        send("done", {});
        res.end();
    });

    // Saved-drive metadata (user-given labels for "My CDJ USB" etc.).
    router.get("/drives/saved", (req, res) => {
        const { userId } = req as AuthedRequest;
        const db = getLibraryDb();
        const rows = db.select().from(savedDrives)
            .where(eq(savedDrives.userId, userId))
            .orderBy(desc(savedDrives.createdAt)).all();
        res.json({ drives: rows });
    });

    router.post("/drives/saved", (req, res) => {
        const { userId } = req as AuthedRequest;
        const body = req.body as { path?: unknown; label?: unknown; type?: unknown; format?: unknown };
        const path = typeof body.path === "string" ? body.path.trim() : "";
        const label = typeof body.label === "string" ? body.label.trim() : "";
        if (!path || !label) { res.status(400).json({ error: "path and label required" }); return; }
        const type = typeof body.type === "string" ? body.type : "removable";
        const format = typeof body.format === "string" ? body.format : null;
        const db = getLibraryDb();
        try {
            const row = db.insert(savedDrives).values({
                userId, path, label, type, format, isActive: true,
            }).returning().get();
            res.json({ drive: row });
        } catch (err) {
            // UNIQUE(user_id, path) — flip to "update label" semantics
            // so the user can rename without delete-then-add.
            const existing = db.select().from(savedDrives)
                .where(and(eq(savedDrives.userId, userId), eq(savedDrives.path, path))).get();
            if (existing) {
                const updated = db.update(savedDrives)
                    .set({ label, type, format })
                    .where(eq(savedDrives.id, existing.id))
                    .returning().get();
                res.json({ drive: updated });
            } else {
                res.status(500).json({ error: err instanceof Error ? err.message : "Insert failed" });
            }
        }
    });

    router.delete("/drives/saved/:id(\\d+)", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const db = getLibraryDb();
        const row = db.select({ id: savedDrives.id }).from(savedDrives)
            .where(and(eq(savedDrives.id, id), eq(savedDrives.userId, userId))).get();
        if (!row) { res.status(404).json({ error: "Not found" }); return; }
        db.delete(savedDrives).where(eq(savedDrives.id, id)).run();
        res.json({ success: true });
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
        if (row) pushPlaylistChange("upsert", row);
        res.json({ playlist: row });
    });

    router.patch("/playlists/:id(\\d+)", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const data = req.body as { name?: string; description?: string };
        const db = getLibraryDb();
        db.update(playlists).set(data)
            .where(and(eq(playlists.id, id), eq(playlists.userId, userId))).run();
        const full = db.select().from(playlists)
            .where(and(eq(playlists.id, id), eq(playlists.userId, userId))).get();
        if (full) pushPlaylistChange("upsert", full);
        res.json({ success: true });
    });

    router.delete("/playlists/:id(\\d+)", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const db = getLibraryDb();
        // Only delete if owned by user
        const owned = db.select().from(playlists)
            .where(and(eq(playlists.id, id), eq(playlists.userId, userId))).get();
        if (!owned) { res.status(404).json({ error: "Not found" }); return; }
        db.delete(playlistTracks).where(eq(playlistTracks.playlistId, id)).run();
        db.delete(playlists).where(eq(playlists.id, id)).run();
        pushPlaylistChange("delete", owned);
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
        const { trackIds } = req.body as { trackIds: unknown };
        if (!Array.isArray(trackIds) || trackIds.length === 0) {
            res.json({ success: true, added: 0 });
            return;
        }
        if (trackIds.length > 5000) {
            res.status(413).json({ error: "too many trackIds (max 5000)" });
            return;
        }
        const intIds: number[] = [];
        for (const v of trackIds) {
            if (typeof v === "number" && Number.isInteger(v) && v > 0) intIds.push(v);
        }
        if (intIds.length === 0) { res.json({ success: true, added: 0 }); return; }
        const db = getLibraryDb();
        const owned = db.select({ id: playlists.id }).from(playlists)
            .where(and(eq(playlists.id, id), eq(playlists.userId, userId))).get();
        if (!owned) { res.status(404).json({ error: "Not found" }); return; }

        // Only allow track ids that belong to this user
        const valid = db.select({ id: tracks.id }).from(tracks)
            .where(and(eq(tracks.userId, userId), inArray(tracks.id, intIds))).all().map((r) => r.id);

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

    // POST /playlists/:id/reorder
    //   body: { trackIds: number[] }  // full ordered list, authoritative
    //   Atomically rewrites position 1..N for the given track ids. Any
    //   ids in the body that are not currently in the playlist are
    //   ignored; any tracks in the playlist not present in the body are
    //   appended at the end (preserving their relative order). This
    //   keeps drag-and-drop and "move up/down" both as one round trip.
    router.post("/playlists/:id(\\d+)/reorder", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const body = req.body as { trackIds?: unknown };
        const incoming = Array.isArray(body.trackIds)
            ? body.trackIds.filter((x): x is number => typeof x === "number" && Number.isInteger(x))
            : null;
        if (!incoming) { res.status(400).json({ error: "trackIds (number[]) required" }); return; }

        const db = getLibraryDb();
        const owned = db.select({ id: playlists.id }).from(playlists)
            .where(and(eq(playlists.id, id), eq(playlists.userId, userId))).get();
        if (!owned) { res.status(404).json({ error: "Not found" }); return; }

        const current = db.select({ trackId: playlistTracks.trackId, position: playlistTracks.position })
            .from(playlistTracks)
            .where(eq(playlistTracks.playlistId, id))
            .orderBy(playlistTracks.position).all();
        const currentIds = new Set(current.map((r) => r.trackId));

        const ordered: number[] = [];
        const seen = new Set<number>();
        for (const tid of incoming) {
            if (currentIds.has(tid) && !seen.has(tid)) { ordered.push(tid); seen.add(tid); }
        }
        // Anything that was already in the playlist but missing from the
        // request goes to the tail in its original order — protects
        // against an out-of-date client racing a concurrent add.
        for (const r of current) {
            if (!seen.has(r.trackId)) { ordered.push(r.trackId); seen.add(r.trackId); }
        }

        db.transaction((tx) => {
            for (let i = 0; i < ordered.length; i++) {
                tx.update(playlistTracks)
                    .set({ position: i + 1 })
                    .where(and(eq(playlistTracks.playlistId, id), eq(playlistTracks.trackId, ordered[i])))
                    .run();
            }
        });

        res.json({ success: true, count: ordered.length });
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
        const { trackIds, options, batchId, batchLabel } = req.body as {
            trackIds?: number[]; options?: AnalyzeOptions;
            batchId?: string; batchLabel?: string;
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
            metadata: options?.metadata ?? false,
            metaFields: options?.metaFields,
        };
        // One logical batch per /analyze call so the UI groups a whole run
        // into a single job. Callers may pass a shared batchId across paged
        // calls to keep a large run in one batch.
        const batch = (batchId && typeof batchId === "string")
            ? { id: batchId, label: typeof batchLabel === "string" ? batchLabel : "Analysis" }
            : { id: randomUUID(), label: typeof batchLabel === "string" ? batchLabel : "Analysis" };
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
            const job = analyzer.enqueue(row.id, row.filepath, opts, batch);
            enqueued.push({ id: job.id, trackId: row.id });
        }
        res.json({ jobs: enqueued, batchId: batch.id });
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

    // GET /analyze/batches — one row per "Start analysis" run (a logical job
    // containing many item sub-jobs) with live aggregate progress. This is the
    // canonical jobs list for the /analysis page.
    router.get("/analyze/batches", (req, res) => {
        const limitRaw = req.query.limit;
        const limit = typeof limitRaw === "string" ? Number.parseInt(limitRaw, 10) : 50;
        res.json({ batches: analyzer.batches(Number.isFinite(limit) ? limit : 50) });
    });

    // POST /analyze/resync — re-enqueue a cloud sync upsert for every track
    // that already has analysis results, WITHOUT recomputing anything. Use
    // after upgrading to a companion that fixes a sync gap so previously
    // analyzed tracks (BPM/key/genre/artwork/lyrics…) finally reach the cloud
    // library. Scoped to the calling user; best-effort per row.
    router.post("/analyze/resync", (req, res) => {
        const { userId } = req as AuthedRequest;
        const db = getLibraryDb();
        // "Has analysis results" = any analyzer stamp or computed field set.
        const rows = db
            .select()
            .from(tracks)
            .where(and(
                eq(tracks.userId, userId),
                sql`(
                    ${tracks.analyzedAt} IS NOT NULL OR
                    ${tracks.dspAnalyzedAt} IS NOT NULL OR
                    ${tracks.stemsAnalyzedAt} IS NOT NULL OR
                    ${tracks.bpm} IS NOT NULL OR
                    ${tracks.acoustidFingerprint} IS NOT NULL OR
                    ${tracks.genre} IS NOT NULL OR
                    ${tracks.artworkUrl} IS NOT NULL
                )`,
            ))
            .all() as Array<{ id: number; userId: string; sha256?: string | null } & Record<string, unknown>>;
        let queued = 0;
        for (const row of rows) {
            try { pushTrackChange("upsert", row); queued++; } catch { /* best-effort */ }
        }
        res.json({ queued, total: rows.length });
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

    // ── Track audio serving ──────────────────────────────────────────
    //
    // GET /tracks/:id/audio — streams the raw source file for the
    // track. Ownership-scoped. Supports HTTP range so the web client
    // can use it both as <audio src=…> and as a sequential read for
    // training-dataset materialization (web app pulls each file and
    // re-uploads to GCS).
    router.get("/tracks/:id(\\d+)/audio", (req, res) => {
        const { userId } = req as AuthedRequest;
        const id = parseInt(req.params.id, 10);
        const db = getLibraryDb();
        const row = db.select({ filepath: tracks.filepath, format: tracks.format })
            .from(tracks)
            .where(and(eq(tracks.id, id), eq(tracks.userId, userId)))
            .get();
        if (!row) { res.status(404).json({ error: "Not found" }); return; }
        if (!row.filepath || !existsSync(row.filepath)) {
            res.status(404).json({ error: "File missing on disk" });
            return;
        }
        const stat = statSync(row.filepath);
        const ext = (row.format ?? path.extname(row.filepath).slice(1) ?? "mp3").toLowerCase();
        const mime = ext === "wav" ? "audio/wav"
            : ext === "flac" ? "audio/flac"
            : ext === "m4a" || ext === "aac" ? "audio/aac"
            : ext === "ogg" ? "audio/ogg"
            : "audio/mpeg";
        res.setHeader("Content-Type", mime);
        res.setHeader("Accept-Ranges", "bytes");
        const range = req.headers.range;
        if (range) {
            const m = /^bytes=(\d+)-(\d*)$/.exec(range);
            if (m) {
                const start = parseInt(m[1], 10);
                const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
                res.status(206);
                res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
                res.setHeader("Content-Length", String(end - start + 1));
                createReadStream(row.filepath, { start, end }).pipe(res);
                return;
            }
        }
        res.setHeader("Content-Length", String(stat.size));
        createReadStream(row.filepath).pipe(res);
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

    // ── Waveform overview peaks ──────────────────────────────────────
    //
    // GET /tracks/:id/peaks — serves the binary Int16 LE interleaved
    // [min0,max0,min1,max1,…] sidecar generated by the analyzer. The
    // browser decodes with `new Int16Array(arrayBuffer)`. ~8 KB per
    // track (2000 pairs × 4 bytes). Cached for an hour by the client
    // since peak data is immutable for a given trackId+content.
    router.get("/tracks/:id(\\d+)/peaks", (req, res) => {
        const { userId } = req as AuthedRequest;
        const trackId = parseInt(req.params.id, 10);
        const db = getLibraryDb();
        const row = db.select({ id: tracks.id }).from(tracks)
            .where(and(eq(tracks.id, trackId), eq(tracks.userId, userId)))
            .get();
        if (!row) { res.status(404).json({ error: "Not found" }); return; }
        const file = analyzer.waveformPeaksPath(trackId);
        if (!existsSync(file)) {
            res.status(404).json({ error: "Peaks not yet generated" });
            return;
        }
        const stat = statSync(file);
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Cache-Control", "private, max-age=3600");
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
