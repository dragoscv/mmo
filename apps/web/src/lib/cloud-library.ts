/**
 * Cloud library reads (server-side only).
 *
 * Cloud Postgres is the SOURCE OF TRUTH for library metadata. The companion
 * pushes its local SQLite library up via `/api/sync`; this module reads it
 * back so the web app shows the full library on ANY device, even when no
 * companion is currently reachable.
 *
 * Writes still go through the companion (see `actions/tracks.ts`) — only the
 * actual audio files and mutations live there. Reads are cloud-first.
 *
 * Row → `CompanionTrack` mapping notes:
 *  - The UI/write actions identify a track by the companion's local numeric
 *    id. Cloud rows carry that as `companionTrackId`; we expose it as `id`
 *    (falling back to the cloud serial id for rows synced before the column
 *    existed) so favorite/rating/tag writes still target the right row.
 *  - `duration` is in SECONDS (companion's native unit), matching the UI.
 */

import { and, asc, desc, eq, ilike, inArray, or, sql, count } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { unstable_cache } from "next/cache";
import { db } from "@/db";
import { tracks, playlists, trackSources, devices } from "@/db/schema";
import { auth } from "@/auth";
import {
    EMPTY_PAGINATED_TRACKS,
    EMPTY_STATS,
    type CompanionTrack,
    type DashboardStats,
    type PaginatedTracks,
    type TrackFilters,
} from "@/lib/companion-library";

type TrackRow = typeof tracks.$inferSelect;

/** Resolve the signed-in user's id, or null when not authenticated. */
async function getUserId(): Promise<string | null> {
    const session = await auth();
    return session?.user?.id ?? null;
}

function toIso(v: Date | string | null | undefined): string | null {
    if (v == null) return null;
    return v instanceof Date ? v.toISOString() : String(v);
}

/** Map a cloud Postgres track row to the `CompanionTrack` shape the UI expects. */
export function rowToCompanionTrack(r: TrackRow): CompanionTrack {
    return {
        id: r.companionTrackId ?? r.id,
        userId: r.userId,
        filepath: r.filepath ?? "",
        filename: r.filename ?? "",
        artist: r.artist,
        title: r.title,
        album: r.album,
        remix: r.remix,
        label: r.label,
        bpm: r.bpm,
        keyCamelot: r.keyCamelot,
        keyMusical: r.keyMusical,
        duration: r.duration,
        energy: r.energy,
        genre: r.genre,
        subgenre: r.subgenre,
        mood: r.mood,
        color: r.color,
        vocalType: r.vocalType,
        setPosition: r.setPosition,
        mixability: r.mixability,
        isProcessed: r.isProcessed,
        fileSize: r.fileSize,
        format: r.format,
        bitrate: r.bitrate,
        sampleRate: r.sampleRate,
        addedAt: toIso(r.addedAt),
        analyzedAt: toIso(r.analyzedAt),
        rating: r.rating,
        isFavorite: r.isFavorite,
        tags: r.tags,
        artworkUrl: r.artworkUrl,
        musicbrainzId: r.musicbrainzId,
        releaseMbid: r.releaseMbid,
        isrc: r.isrc,
        year: r.year,
        comment: r.comment,
        lyrics: r.lyrics,
        syncedLyrics: r.syncedLyrics,
        isHidden: r.isHidden,
        sourceUrl: r.sourceUrl,
        sourcePlatform: r.sourcePlatform,
        sourceId: r.sourceId,
        relatedTrackId: r.relatedTrackId,
        deviceId: r.deviceId,
        isOfflineAvailable: r.isOfflineAvailable,
        stemsStatus: r.stemsStatus,
        stemsVocalsPath: r.stemsVocalsPath,
        stemsDrumsPath: r.stemsDrumsPath,
        stemsBassPath: r.stemsBassPath,
        stemsMelodyPath: r.stemsMelodyPath,
        stemsAnalyzedAt: toIso(r.stemsAnalyzedAt),
        stemsModel: r.stemsModel,
        stemsError: r.stemsError,
        loudnessLufs: r.loudnessLufs,
        loudnessTruePeakDbfs: r.loudnessTruePeakDbfs,
        loudnessRangeLu: r.loudnessRangeLu,
        acoustidFingerprint: r.acoustidFingerprint,
        acoustidId: r.acoustidId,
        bpmConfidence: r.bpmConfidence,
        keyConfidence: r.keyConfidence,
        beats: r.beats,
        downbeats: r.downbeats,
        chordProgression: r.chordProgression,
        structureSegments: r.structureSegments,
        dspAnalyzedAt: toIso(r.dspAnalyzedAt),
        sha256: r.sha256,
    };
}

/** Build the WHERE conditions for a track query (mirrors companion logic). */
function buildConditions(userId: string, f: TrackFilters | undefined) {
    const c = [eq(tracks.userId, userId)];
    if (!f) {
        c.push(sql`(${tracks.isHidden} IS NULL OR ${tracks.isHidden} = false)`);
        return c;
    }

    if (f.isHidden === true) c.push(eq(tracks.isHidden, true));
    else c.push(sql`(${tracks.isHidden} IS NULL OR ${tracks.isHidden} = false)`);

    if (f.genre) {
        const list = f.genre.split(",").map((g) => g.trim()).filter(Boolean);
        if (list.length === 1) c.push(eq(tracks.genre, list[0]));
        else if (list.length > 1) c.push(inArray(tracks.genre, list));
    }
    if (f.minBpm !== undefined) c.push(sql`${tracks.bpm} >= ${f.minBpm}`);
    if (f.maxBpm !== undefined) c.push(sql`${tracks.bpm} <= ${f.maxBpm}`);
    if (f.energy !== undefined) c.push(eq(tracks.energy, f.energy));
    if (f.key) {
        const list = f.key.split(",").map((k) => k.trim()).filter(Boolean);
        if (list.length === 1) {
            c.push(or(eq(tracks.keyCamelot, list[0]), eq(tracks.keyMusical, list[0]))!);
        } else if (list.length > 1) {
            c.push(or(inArray(tracks.keyCamelot, list), inArray(tracks.keyMusical, list))!);
        }
    }
    if (f.search) {
        const term = `%${f.search}%`;
        c.push(or(
            ilike(tracks.artist, term),
            ilike(tracks.title, term),
            ilike(tracks.filename, term),
        )!);
    }
    if (f.isProcessed !== undefined) c.push(eq(tracks.isProcessed, f.isProcessed));
    if (f.isFavorite) c.push(eq(tracks.isFavorite, true));
    if (f.rating !== undefined) c.push(eq(tracks.rating, f.rating));
    if (f.tag) {
        const list = f.tag.split(",").map((t) => t.trim()).filter(Boolean);
        if (list.length > 0) {
            c.push(or(...list.map((t) => ilike(tracks.tags, `%"${t}"%`)))!);
        }
    }
    if (f.album) c.push(ilike(tracks.album, `%${f.album}%`));
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

export async function getTracksFromCloud(filters?: TrackFilters): Promise<PaginatedTracks> {
    const userId = await getUserId();
    if (!userId) return EMPTY_PAGINATED_TRACKS;

    const page = Math.max(1, filters?.page ?? 1);
    const pageSize = Math.min(Math.max(1, filters?.pageSize ?? 50), 500);
    const sort = filters?.sort || "addedAt";
    const order = filters?.order === "asc" ? "asc" : "desc";

    const conds = buildConditions(userId, filters);
    const where = and(...conds);
    const offset = (page - 1) * pageSize;

    const [totalRow] = await db.select({ c: count() }).from(tracks).where(where);
    const total = totalRow?.c ?? 0;

    const rows = await db.select().from(tracks).where(where)
        .orderBy(buildOrderBy(sort, order))
        .limit(pageSize).offset(offset);

    const mapped = rows.map(rowToCompanionTrack);

    // Stamp availability (connected/disconnected) from track_sources +
    // device heartbeat. Keyed by the cloud serial id.
    const avail = await getTrackAvailability(rows.map((r) => r.id));
    for (let i = 0; i < mapped.length; i++) {
        const a = avail.get(rows[i].id);
        mapped[i].availabilityState = a?.state ?? "disconnected";
        mapped[i].sourceCount = a?.sourceCount ?? 0;
        mapped[i].sourceDeviceNames = a?.deviceNames ?? [];
    }

    return {
        tracks: mapped,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
    };
}

export async function getTrackByIdFromCloud(id: number): Promise<CompanionTrack | null> {
    const userId = await getUserId();
    if (!userId) return null;
    // Prefer the companion's id (what the UI passes); fall back to serial id.
    const rows = await db.select().from(tracks)
        .where(and(
            eq(tracks.userId, userId),
            or(eq(tracks.companionTrackId, id), eq(tracks.id, id))!,
        ))
        .limit(1);
    return rows[0] ? rowToCompanionTrack(rows[0]) : null;
}

// Filter-option lists (genres / keys / tags) change only when the library is
// re-synced, but were previously re-scanned on EVERY /library load
// (full-table SELECT DISTINCT + a whole-column tags scan). They're cached
// per-user and invalidated by `revalidateTag(libraryFacetsTag(userId))` from
// the sync apply path. See `libraryFacetsTag`.
export function libraryFacetsTag(userId: string): string {
    return `library-facets:${userId}`;
}

function cachedFacet<T>(
    userId: string,
    name: string,
    fn: () => Promise<T>,
): Promise<T> {
    return unstable_cache(fn, ["library-facet", name, userId], {
        revalidate: 300,
        tags: [libraryFacetsTag(userId)],
    })();
}

export async function getGenresFromCloud(): Promise<string[]> {
    const userId = await getUserId();
    if (!userId) return [];
    return cachedFacet(userId, "genres", async () => {
        const rows = await db.selectDistinct({ genre: tracks.genre }).from(tracks)
            .where(and(eq(tracks.userId, userId), sql`${tracks.genre} IS NOT NULL AND ${tracks.genre} <> ''`))
            .orderBy(asc(tracks.genre));
        return rows.map((r) => r.genre).filter((g): g is string => !!g);
    });
}

export async function getKeysFromCloud(): Promise<string[]> {
    const userId = await getUserId();
    if (!userId) return [];
    return cachedFacet(userId, "keys", async () => {
        const rows = await db.selectDistinct({ key: tracks.keyCamelot }).from(tracks)
            .where(and(eq(tracks.userId, userId), sql`${tracks.keyCamelot} IS NOT NULL AND ${tracks.keyCamelot} <> ''`))
            .orderBy(asc(tracks.keyCamelot));
        return rows.map((r) => r.key).filter((k): k is string => !!k);
    });
}

export async function getAllTagsFromCloud(): Promise<string[]> {
    const userId = await getUserId();
    if (!userId) return [];
    return cachedFacet(userId, "tags", async () => {
        const rows = await db.select({ tags: tracks.tags }).from(tracks)
            .where(and(eq(tracks.userId, userId), sql`${tracks.tags} IS NOT NULL AND ${tracks.tags} <> ''`));
        const set = new Set<string>();
        for (const r of rows) {
            if (!r.tags) continue;
            try {
                const arr = JSON.parse(r.tags);
                if (Array.isArray(arr)) for (const t of arr) if (typeof t === "string" && t) set.add(t);
            } catch { /* ignore malformed tag json */ }
        }
        return [...set].sort((a, b) => a.localeCompare(b));
    });
}

/**
 * Counts of tracks missing each analyzable field — computed from cloud
 * Postgres (the source of truth). Drives the analyze modal's scope panel
 * and lets the analyzer target only-missing tracks.
 */
export interface CloudAnalysisScope {
    total: number;
    missingArtwork: number;
    missingLyrics: number;
    missingGenre: number;
    missingBpm: number;
    missingYear: number;
    missingLabel: number;
    recentlyAnalyzed: number;
}

export async function getAnalysisScopeFromCloud(): Promise<CloudAnalysisScope> {
    const empty: CloudAnalysisScope = {
        total: 0, missingArtwork: 0, missingLyrics: 0, missingGenre: 0,
        missingBpm: 0, missingYear: 0, missingLabel: 0, recentlyAnalyzed: 0,
    };
    const userId = await getUserId();
    if (!userId) return empty;

    const visible = and(
        eq(tracks.userId, userId),
        sql`(${tracks.isHidden} IS NULL OR ${tracks.isHidden} = false)`,
    );

    const blank = (c: AnyPgColumn) =>
        sql<number>`COUNT(*) FILTER (WHERE ${c} IS NULL OR ${c} = '')`;

    const [r] = await db.select({
        total: count(),
        missingArtwork: blank(tracks.artworkUrl),
        missingLyrics: sql<number>`COUNT(*) FILTER (WHERE (${tracks.lyrics} IS NULL OR ${tracks.lyrics} = '') AND (${tracks.syncedLyrics} IS NULL OR ${tracks.syncedLyrics} = ''))`,
        missingGenre: blank(tracks.genre),
        missingBpm: sql<number>`COUNT(*) FILTER (WHERE ${tracks.bpm} IS NULL)`,
        missingYear: sql<number>`COUNT(*) FILTER (WHERE ${tracks.year} IS NULL)`,
        missingLabel: blank(tracks.label),
        recentlyAnalyzed: sql<number>`COUNT(*) FILTER (WHERE ${tracks.analyzedAt} >= NOW() - INTERVAL '7 days')`,
    }).from(tracks).where(visible);

    return {
        total: Number(r?.total ?? 0),
        missingArtwork: Number(r?.missingArtwork ?? 0),
        missingLyrics: Number(r?.missingLyrics ?? 0),
        missingGenre: Number(r?.missingGenre ?? 0),
        missingBpm: Number(r?.missingBpm ?? 0),
        missingYear: Number(r?.missingYear ?? 0),
        missingLabel: Number(r?.missingLabel ?? 0),
        recentlyAnalyzed: Number(r?.recentlyAnalyzed ?? 0),
    };
}

export async function getStatsFromCloud(): Promise<DashboardStats> {
    const userId = await getUserId();
    if (!userId) return EMPTY_STATS;

    const visible = and(
        eq(tracks.userId, userId),
        sql`(${tracks.isHidden} IS NULL OR ${tracks.isHidden} = false)`,
    );

    const [agg] = await db.select({
        total: count(),
        processed: sql<number>`COUNT(*) FILTER (WHERE ${tracks.isProcessed} = true)`,
        analyzed: sql<number>`COUNT(*) FILTER (WHERE ${tracks.analyzedAt} IS NOT NULL)`,
        favorites: sql<number>`COUNT(*) FILTER (WHERE ${tracks.isFavorite} = true)`,
        avgBpm: sql<number>`COALESCE(AVG(${tracks.bpm}), 0)`,
        totalDuration: sql<number>`COALESCE(SUM(${tracks.duration}), 0)`,
        totalSize: sql<number>`COALESCE(SUM(${tracks.fileSize}), 0)`,
        missingGenre: sql<number>`COUNT(*) FILTER (WHERE ${tracks.genre} IS NULL OR ${tracks.genre} = '')`,
        missingBpm: sql<number>`COUNT(*) FILTER (WHERE ${tracks.bpm} IS NULL)`,
        missingKey: sql<number>`COUNT(*) FILTER (WHERE ${tracks.keyCamelot} IS NULL OR ${tracks.keyCamelot} = '')`,
        missingEnergy: sql<number>`COUNT(*) FILTER (WHERE ${tracks.energy} IS NULL)`,
        missingArtwork: sql<number>`COUNT(*) FILTER (WHERE ${tracks.artworkUrl} IS NULL OR ${tracks.artworkUrl} = '')`,
    }).from(tracks).where(visible);

    const total = Number(agg?.total ?? 0);
    const processed = Number(agg?.processed ?? 0);

    const [{ playlistCount } = { playlistCount: 0 }] = await db
        .select({ playlistCount: count() }).from(playlists).where(eq(playlists.userId, userId));

    const genreStats = (await db.select({
        genre: tracks.genre, c: count(),
    }).from(tracks).where(and(visible, sql`${tracks.genre} IS NOT NULL AND ${tracks.genre} <> ''`))
        .groupBy(tracks.genre).orderBy(desc(count())).limit(20))
        .map((r) => ({ genre: r.genre ?? "", count: Number(r.c) }));

    const keyStats = (await db.select({
        key: tracks.keyCamelot, c: count(),
    }).from(tracks).where(and(visible, sql`${tracks.keyCamelot} IS NOT NULL AND ${tracks.keyCamelot} <> ''`))
        .groupBy(tracks.keyCamelot).orderBy(desc(count())))
        .map((r) => ({ key: r.key ?? "", count: Number(r.c) }));

    const formatStats = (await db.select({
        format: tracks.format, c: count(),
    }).from(tracks).where(and(visible, sql`${tracks.format} IS NOT NULL AND ${tracks.format} <> ''`))
        .groupBy(tracks.format).orderBy(desc(count())))
        .map((r) => ({ format: r.format ?? "", count: Number(r.c) }));

    const energyStats = (await db.select({
        energy: tracks.energy, c: count(),
    }).from(tracks).where(and(visible, sql`${tracks.energy} IS NOT NULL`))
        .groupBy(tracks.energy).orderBy(asc(tracks.energy)))
        .map((r) => ({ energy: Number(r.energy ?? 0), count: Number(r.c) }));

    const bpmBuckets = await db.select({
        range: sql<string>`
            CASE
                WHEN ${tracks.bpm} < 90 THEN '<90'
                WHEN ${tracks.bpm} < 110 THEN '90-110'
                WHEN ${tracks.bpm} < 128 THEN '110-128'
                WHEN ${tracks.bpm} < 140 THEN '128-140'
                ELSE '140+'
            END`,
        c: count(),
    }).from(tracks).where(and(visible, sql`${tracks.bpm} IS NOT NULL`))
        .groupBy(sql`1`);
    const bpmRanges = bpmBuckets.map((r) => ({ range: r.range, count: Number(r.c) }));

    const recentTracks = (await db.select().from(tracks).where(visible)
        .orderBy(desc(tracks.addedAt)).limit(10))
        .map((r) => {
            const t = rowToCompanionTrack(r);
            return {
                id: t.id, title: t.title, artist: t.artist, genre: t.genre,
                bpm: t.bpm, keyCamelot: t.keyCamelot, energy: t.energy,
                rating: t.rating, artworkUrl: t.artworkUrl, addedAt: t.addedAt,
                duration: t.duration, isFavorite: t.isFavorite,
            };
        });

    const topRated = (await db.select().from(tracks)
        .where(and(visible, sql`${tracks.rating} IS NOT NULL`))
        .orderBy(desc(tracks.rating)).limit(10))
        .map((r) => {
            const t = rowToCompanionTrack(r);
            return { id: t.id, title: t.title, artist: t.artist, rating: t.rating, artworkUrl: t.artworkUrl };
        });

    return {
        total,
        processed,
        unprocessed: total - processed,
        analyzed: Number(agg?.analyzed ?? 0),
        favorites: Number(agg?.favorites ?? 0),
        avgBpm: Math.round(Number(agg?.avgBpm ?? 0)),
        totalDuration: Number(agg?.totalDuration ?? 0),
        totalSize: Number(agg?.totalSize ?? 0),
        playlistCount: Number(playlistCount ?? 0),
        genreStats,
        energyStats,
        bpmRanges,
        keyStats,
        formatStats,
        health: {
            total,
            missingGenre: Number(agg?.missingGenre ?? 0),
            missingBpm: Number(agg?.missingBpm ?? 0),
            missingKey: Number(agg?.missingKey ?? 0),
            missingEnergy: Number(agg?.missingEnergy ?? 0),
            missingArtwork: Number(agg?.missingArtwork ?? 0),
        },
        recentTracks,
        topRated,
    };
}

// ─── Availability ───────────────────────────────────────────────────────────

/** How long after a device's last heartbeat we still treat it as online. */
const DEVICE_ONLINE_WINDOW_MS = 90_000;

export type AvailabilityState = "connected" | "disconnected";

export interface TrackAvailability {
    /** "connected" when ≥1 source device is online; else "disconnected".
     *  The browser overlays "offline" on top when the track is IDB-pinned. */
    state: AvailabilityState;
    /** Online device ids holding this track (for stream resolution). */
    onlineDeviceIds: string[];
    /** All device ids holding this track (online or not). */
    deviceIds: string[];
    /** Display names of all source devices, online first, for the UI
     *  tooltip (e.g. "On 2 devices: Studio PC, Laptop"). */
    deviceNames: string[];
    /** Count of distinct source devices (online or not). */
    sourceCount: number;
}

/**
 * Resolve availability for a set of cloud track ids (the serial `tracks.id`,
 * NOT the companion id). Returns a map keyed by track id. A track is
 * "connected" when at least one device that holds it has a heartbeat within
 * the online window.
 */
export async function getTrackAvailability(
    trackIds: number[],
): Promise<Map<number, TrackAvailability>> {
    const out = new Map<number, TrackAvailability>();
    const userId = await getUserId();
    if (!userId || trackIds.length === 0) return out;

    const cutoff = new Date(Date.now() - DEVICE_ONLINE_WINDOW_MS);

    const rows = await db
        .select({
            trackId: trackSources.trackId,
            deviceId: trackSources.deviceId,
            deviceName: devices.name,
            lastSeenAt: devices.lastSeenAt,
        })
        .from(trackSources)
        .innerJoin(devices, eq(devices.id, trackSources.deviceId))
        .where(and(eq(trackSources.userId, userId), inArray(trackSources.trackId, trackIds)));

    // Collect online + offline device names separately so we can list
    // online devices first in the UI tooltip.
    const onlineNames = new Map<number, string[]>();
    const offlineNames = new Map<number, string[]>();
    const pushName = (map: Map<number, string[]>, trackId: number, name: string) => {
        const list = map.get(trackId);
        if (list) list.push(name);
        else map.set(trackId, [name]);
    };
    for (const r of rows) {
        let entry = out.get(r.trackId);
        if (!entry) {
            entry = { state: "disconnected", onlineDeviceIds: [], deviceIds: [], deviceNames: [], sourceCount: 0 };
            out.set(r.trackId, entry);
        }
        entry.deviceIds.push(r.deviceId);
        const online = r.lastSeenAt != null && new Date(r.lastSeenAt) >= cutoff;
        const name = r.deviceName?.trim() || "Unknown device";
        if (online) {
            entry.onlineDeviceIds.push(r.deviceId);
            entry.state = "connected";
            pushName(onlineNames, r.trackId, name);
        } else {
            pushName(offlineNames, r.trackId, name);
        }
    }

    // Finalize: online device names first, then offline; dedupe; count.
    for (const [trackId, entry] of out) {
        const names = [...(onlineNames.get(trackId) ?? []), ...(offlineNames.get(trackId) ?? [])];
        entry.deviceNames = [...new Set(names)];
        entry.sourceCount = new Set(entry.deviceIds).size;
    }

    return out;
}

/**
 * Resolve the best streamable source for a track, identified by EITHER the
 * cloud serial id or the companion track id (the UI uses the latter). Prefers
 * a device that's currently online; falls back to any known source so the
 * caller can still attempt a proxy. Returns null when no source is known.
 */
export interface StreamSource {
    deviceId: string;
    filepath: string | null;
    online: boolean;
}

export async function resolveStreamSource(trackId: number): Promise<StreamSource | null> {
    const userId = await getUserId();
    if (!userId) return null;

    const cutoff = new Date(Date.now() - DEVICE_ONLINE_WINDOW_MS);
    const rows = await db
        .select({
            deviceId: trackSources.deviceId,
            filepath: trackSources.filepath,
            lastSeenAt: devices.lastSeenAt,
        })
        .from(trackSources)
        .innerJoin(tracks, eq(tracks.id, trackSources.trackId))
        .innerJoin(devices, eq(devices.id, trackSources.deviceId))
        .where(and(
            eq(trackSources.userId, userId),
            // Match either the cloud serial id or the companion-local id the UI passes.
            or(eq(trackSources.trackId, trackId), eq(tracks.companionTrackId, trackId))!,
        ));

    if (rows.length === 0) return null;
    // Prefer an online device.
    const online = rows.find((r) => r.lastSeenAt != null && new Date(r.lastSeenAt) >= cutoff);
    const pick = online ?? rows[0];
    return {
        deviceId: pick.deviceId,
        filepath: pick.filepath,
        online: pick === online,
    };
}

// ─── Apply analysis changes (write to cloud) ────────────────────────────────

/** Analysis fields that may be written, mapped to their Drizzle columns. */
const APPLIABLE_FIELDS: Record<string, AnyPgColumn> = {
    genre: tracks.genre,
    album: tracks.album,
    year: tracks.year,
    label: tracks.label,
    bpm: tracks.bpm,
    isrc: tracks.isrc,
    artworkUrl: tracks.artworkUrl,
    lyrics: tracks.lyrics,
    syncedLyrics: tracks.syncedLyrics,
    musicbrainzId: tracks.musicbrainzId,
    releaseMbid: tracks.releaseMbid,
    mood: tracks.mood,
    keyCamelot: tracks.keyCamelot,
    keyMusical: tracks.keyMusical,
    energy: tracks.energy,
};

/**
 * Apply analysis field changes for one track to cloud Postgres (the source of
 * truth). Matches the track by companion id OR cloud serial id. Bumps
 * sync_version + per-field versions so the companion's next pull picks them up
 * under last-write-wins. Returns true when a row was updated.
 */
export async function applyTrackFieldsToCloud(
    trackId: number,
    changes: { field: string; newValue: string }[],
): Promise<boolean> {
    const userId = await getUserId();
    if (!userId) return false;

    const rows = await db
        .select({ id: tracks.id, fv: tracks.fieldVersions, sv: tracks.syncVersion })
        .from(tracks)
        .where(and(
            eq(tracks.userId, userId),
            or(eq(tracks.companionTrackId, trackId), eq(tracks.id, trackId))!,
        ))
        .limit(1);
    const row = rows[0];
    if (!row) return false;

    const set: Record<string, unknown> = {};
    const now = new Date();
    const nowIso = now.toISOString();
    const fv: Record<string, string> = { ...(row.fv ?? {}) };

    for (const { field, newValue } of changes) {
        const col = APPLIABLE_FIELDS[field];
        if (!col) continue;
        if (field === "bpm") {
            const n = parseFloat(newValue);
            if (Number.isFinite(n)) { set.bpm = n; fv[field] = nowIso; }
        } else if (field === "year" || field === "energy") {
            const n = parseInt(newValue, 10);
            if (Number.isFinite(n)) { set[field] = n; fv[field] = nowIso; }
        } else {
            set[field] = newValue;
            fv[field] = nowIso;
        }
    }

    if (Object.keys(set).length === 0) return false;

    set.analyzedAt = now;
    set.fieldVersions = fv;
    set.syncVersion = (row.sv ?? 0) + 1;
    set.updatedAt = now;

    await db.update(tracks).set(set).where(eq(tracks.id, row.id));
    return true;
}
