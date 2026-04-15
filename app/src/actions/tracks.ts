"use server";

import { db } from "@/db";
import { tracks, playlists } from "@/db/schema";
import { eq, sql, and, gte, lte, desc, asc, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export interface TrackFilters {
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
    page?: number;
    pageSize?: number;
    sort?: string;
    order?: "asc" | "desc";
}

export interface PaginatedTracks {
    tracks: (typeof tracks.$inferSelect)[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

function buildConditions(filters: TrackFilters) {
    const conditions = [];

    // By default exclude hidden tracks; only show hidden when explicitly requested
    if (filters.isHidden === true) {
        conditions.push(eq(tracks.isHidden, true));
    } else if (filters.isHidden !== undefined) {
        conditions.push(sql`(${tracks.isHidden} IS NULL OR ${tracks.isHidden} = 0)`);
    } else {
        // Default: exclude hidden
        conditions.push(sql`(${tracks.isHidden} IS NULL OR ${tracks.isHidden} = 0)`);
    }

    if (filters.genre) {
        const genres = filters.genre.split(",").map((g) => g.trim()).filter(Boolean);
        if (genres.length === 1) {
            conditions.push(eq(tracks.genre, genres[0]));
        } else if (genres.length > 1) {
            conditions.push(inArray(tracks.genre, genres));
        }
    }
    if (filters.minBpm) {
        conditions.push(gte(tracks.bpm, filters.minBpm));
    }
    if (filters.maxBpm) {
        conditions.push(lte(tracks.bpm, filters.maxBpm));
    }
    if (filters.energy) {
        conditions.push(eq(tracks.energy, filters.energy));
    }
    if (filters.key) {
        const keys = filters.key.split(",").map((k) => k.trim()).filter(Boolean);
        if (keys.length === 1) {
            conditions.push(
                sql`(${tracks.keyCamelot} = ${keys[0]} OR ${tracks.keyMusical} = ${keys[0]})`
            );
        } else if (keys.length > 1) {
            conditions.push(
                sql`(${tracks.keyCamelot} IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)}) OR ${tracks.keyMusical} IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)}))`
            );
        }
    }
    if (filters.search) {
        const term = `%${filters.search}%`;
        conditions.push(
            sql`(${tracks.artist} LIKE ${term} OR ${tracks.title} LIKE ${term} OR ${tracks.filename} LIKE ${term})`
        );
    }
    if (filters.isProcessed !== undefined) {
        conditions.push(eq(tracks.isProcessed, filters.isProcessed));
    }
    if (filters.isFavorite) {
        conditions.push(eq(tracks.isFavorite, true));
    }
    if (filters.rating) {
        conditions.push(eq(tracks.rating, filters.rating));
    }
    if (filters.tag) {
        const tags = filters.tag.split(",").map((t) => t.trim()).filter(Boolean);
        if (tags.length === 1) {
            const tagPattern = `%"${tags[0]}"%`;
            conditions.push(sql`${tracks.tags} LIKE ${tagPattern}`);
        } else if (tags.length > 1) {
            const tagConditions = tags.map((t) => {
                const pattern = `%"${t}"%`;
                return sql`${tracks.tags} LIKE ${pattern}`;
            });
            conditions.push(sql`(${sql.join(tagConditions, sql` OR `)})`);
        }
    }
    if (filters.album) {
        const albumTerm = `%${filters.album}%`;
        conditions.push(sql`${tracks.album} LIKE ${albumTerm}`);
    }
    if (filters.artist) {
        conditions.push(eq(tracks.artist, filters.artist));
    }
    if (filters.year) {
        conditions.push(eq(tracks.year, filters.year));
    }
    if (filters.label) {
        conditions.push(eq(tracks.label, filters.label));
    }
    if (filters.subgenre) {
        conditions.push(eq(tracks.subgenre, filters.subgenre));
    }
    if (filters.mood) {
        conditions.push(eq(tracks.mood, filters.mood));
    }

    return conditions;
}

function buildOrderBy(sort?: string, order?: "asc" | "desc") {
    const dir = order === "asc" ? asc : desc;
    switch (sort) {
        case "artist":
            return dir(tracks.artist);
        case "title":
            return dir(tracks.title);
        case "bpm":
            return dir(tracks.bpm);
        case "key":
            return dir(tracks.keyCamelot);
        case "genre":
            return dir(tracks.genre);
        case "energy":
            return dir(tracks.energy);
        case "duration":
            return dir(tracks.duration);
        case "rating":
            return dir(tracks.rating);
        case "favorite":
            return dir(tracks.isFavorite);
        case "bitrate":
            return dir(tracks.bitrate);
        case "year":
            return dir(tracks.year);
        case "addedAt":
        default:
            return dir(tracks.addedAt);
    }
}

export async function getTracks(
    filters?: TrackFilters
): Promise<PaginatedTracks> {
    const page = filters?.page || 1;
    const pageSize = filters?.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const conditions = filters ? buildConditions(filters) : [];
    const orderBy = buildOrderBy(filters?.sort, filters?.order);
    const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

    const totalResult = db
        .select({ count: sql<number>`COUNT(*)` })
        .from(tracks)
        .where(whereClause)
        .get();

    const total = totalResult?.count ?? 0;

    const result = db
        .select()
        .from(tracks)
        .where(whereClause)
        .orderBy(orderBy)
        .limit(pageSize)
        .offset(offset)
        .all();

    return {
        tracks: result,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
    };
}

export async function getTrackById(id: number) {
    return db.select().from(tracks).where(eq(tracks.id, id)).get();
}

export async function updateTrack(
    id: number,
    data: {
        artist?: string;
        title?: string;
        album?: string;
        genre?: string;
        subgenre?: string;
        energy?: number;
        mood?: string;
        color?: string;
        vocalType?: string;
        setPosition?: string;
        mixability?: number;
        bpm?: number;
        keyCamelot?: string;
        keyMusical?: string;
        isProcessed?: boolean;
        rating?: number | null;
        isFavorite?: boolean;
        tags?: string;
        label?: string;
        remix?: string;
        year?: number | null;
        comment?: string;
        artworkUrl?: string;
    }
) {
    db.update(tracks).set(data).where(eq(tracks.id, id)).run();
    revalidatePath("/library");
    revalidatePath("/");
    return { success: true };
}

export async function toggleFavorite(id: number) {
    const track = db.select().from(tracks).where(eq(tracks.id, id)).get();
    if (!track) return { success: false };
    const newValue = !track.isFavorite;
    db.update(tracks)
        .set({ isFavorite: newValue })
        .where(eq(tracks.id, id))
        .run();
    revalidatePath("/library");
    return { success: true, isFavorite: newValue };
}

export async function setTrackRating(id: number, rating: number | null) {
    db.update(tracks)
        .set({ rating: rating || null })
        .where(eq(tracks.id, id))
        .run();
    revalidatePath("/library");
    return { success: true };
}

export async function updateTrackTags(id: number, tags: string[]) {
    db.update(tracks)
        .set({ tags: JSON.stringify(tags) })
        .where(eq(tracks.id, id))
        .run();
    revalidatePath("/library");
    return { success: true };
}

export async function getAllTags(): Promise<string[]> {
    const rows = db
        .select({ tags: tracks.tags })
        .from(tracks)
        .where(sql`${tracks.tags} IS NOT NULL AND ${tracks.tags} != '[]'`)
        .all();
    const tagSet = new Set<string>();
    for (const row of rows) {
        if (row.tags) {
            try {
                const parsed = JSON.parse(row.tags) as string[];
                parsed.forEach((t) => tagSet.add(t));
            } catch { }
        }
    }
    return Array.from(tagSet).sort();
}

export async function deleteTrack(id: number) {
    db.delete(tracks).where(eq(tracks.id, id)).run();
    revalidatePath("/library");
    revalidatePath("/");
    return { success: true };
}

export async function getTrackStats() {
    const total = db
        .select({ count: sql<number>`COUNT(*)` })
        .from(tracks)
        .get();

    const processed = db
        .select({ count: sql<number>`COUNT(*)` })
        .from(tracks)
        .where(eq(tracks.isProcessed, true))
        .get();

    const genreStats = db
        .select({
            genre: tracks.genre,
            count: sql<number>`COUNT(*)`,
        })
        .from(tracks)
        .groupBy(tracks.genre)
        .orderBy(sql`COUNT(*) DESC`)
        .all();

    const avgBpm = db
        .select({ avg: sql<number>`AVG(${tracks.bpm})` })
        .from(tracks)
        .where(sql`${tracks.bpm} IS NOT NULL`)
        .get();

    return {
        total: total?.count ?? 0,
        processed: processed?.count ?? 0,
        unprocessed: (total?.count ?? 0) - (processed?.count ?? 0),
        genreStats: genreStats.map((g) => ({
            genre: g.genre || "Unknown",
            count: g.count,
        })),
        avgBpm: avgBpm?.avg ? Math.round(avgBpm.avg) : 0,
    };
}

export async function getGenres() {
    const genres = db
        .select({ genre: tracks.genre })
        .from(tracks)
        .groupBy(tracks.genre)
        .orderBy(tracks.genre)
        .all();
    return genres.map((g) => g.genre).filter(Boolean) as string[];
}

export async function getKeys(): Promise<string[]> {
    const keys = db
        .select({ key: tracks.keyCamelot })
        .from(tracks)
        .where(sql`${tracks.keyCamelot} IS NOT NULL`)
        .groupBy(tracks.keyCamelot)
        .orderBy(tracks.keyCamelot)
        .all();
    return keys.map((k) => k.key).filter(Boolean) as string[];
}

export interface DashboardStats {
    total: number;
    processed: number;
    unprocessed: number;
    analyzed: number;
    favorites: number;
    avgBpm: number;
    totalDuration: number;
    totalSize: number;
    playlistCount: number;
    genreStats: { genre: string; count: number }[];
    energyStats: { energy: number; count: number }[];
    bpmRanges: { range: string; count: number }[];
    keyStats: { key: string; count: number }[];
    formatStats: { format: string; count: number }[];
    health: {
        total: number;
        missingGenre: number;
        missingBpm: number;
        missingKey: number;
        missingEnergy: number;
        missingArtwork: number;
    };
    recentTracks: {
        id: number;
        title: string | null;
        artist: string | null;
        genre: string | null;
        bpm: number | null;
        keyCamelot: string | null;
        energy: number | null;
        rating: number | null;
        artworkUrl: string | null;
        addedAt: string | null;
        duration: number | null;
        isFavorite: boolean | null;
    }[];
    topRated: {
        id: number;
        title: string | null;
        artist: string | null;
        rating: number | null;
        artworkUrl: string | null;
    }[];
}

export async function getDashboardStats(): Promise<DashboardStats> {
    const total = db.select({ count: sql<number>`COUNT(*)` }).from(tracks).get();
    const processed = db.select({ count: sql<number>`COUNT(*)` }).from(tracks).where(eq(tracks.isProcessed, true)).get();
    const analyzed = db.select({ count: sql<number>`COUNT(*)` }).from(tracks).where(sql`${tracks.analyzedAt} IS NOT NULL`).get();
    const favorites = db.select({ count: sql<number>`COUNT(*)` }).from(tracks).where(eq(tracks.isFavorite, true)).get();
    const avgBpm = db.select({ avg: sql<number>`AVG(${tracks.bpm})` }).from(tracks).where(sql`${tracks.bpm} IS NOT NULL`).get();
    const totalDuration = db.select({ sum: sql<number>`COALESCE(SUM(${tracks.duration}), 0)` }).from(tracks).get();
    const totalSize = db.select({ sum: sql<number>`COALESCE(SUM(${tracks.fileSize}), 0)` }).from(tracks).get();
    const playlistCount = db.select({ count: sql<number>`COUNT(*)` }).from(playlists).get();

    const rawGenreStats = db
        .select({ genre: tracks.genre, count: sql<number>`COUNT(*)` })
        .from(tracks)
        .groupBy(tracks.genre)
        .orderBy(sql`COUNT(*) DESC`)
        .all();

    // Normalize genre data: merge Unknown variants, take first genre from comma-separated
    const UNKNOWN_PATTERNS = ["unknown", "unknowngenre", "unknown genre", "various", "other", "none", "n/a"];
    const genreMap = new Map<string, number>();
    for (const g of rawGenreStats) {
        const raw = (g.genre || "").trim();
        const lower = raw.toLowerCase();
        let normalized: string;
        if (!raw || UNKNOWN_PATTERNS.includes(lower)) {
            normalized = "Unknown";
        } else if (raw.includes(",")) {
            normalized = raw.split(",")[0].trim();
        } else {
            normalized = raw;
        }
        genreMap.set(normalized, (genreMap.get(normalized) || 0) + g.count);
    }
    const genreStats = Array.from(genreMap, ([genre, count]) => ({ genre, count }))
        .sort((a, b) => {
            if (a.genre === "Unknown") return 1;
            if (b.genre === "Unknown") return -1;
            return b.count - a.count;
        });

    const energyStats = db
        .select({ energy: tracks.energy, count: sql<number>`COUNT(*)` })
        .from(tracks)
        .where(sql`${tracks.energy} IS NOT NULL`)
        .groupBy(tracks.energy)
        .orderBy(tracks.energy)
        .all();

    const bpmRanges = db
        .select({
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
        })
        .from(tracks)
        .where(sql`${tracks.bpm} IS NOT NULL`)
        .groupBy(sql`1`)
        .orderBy(sql`MIN(${tracks.bpm})`)
        .all();

    const keyStats = db
        .select({ key: tracks.keyCamelot, count: sql<number>`COUNT(*)` })
        .from(tracks)
        .where(sql`${tracks.keyCamelot} IS NOT NULL AND ${tracks.keyCamelot} != ''`)
        .groupBy(tracks.keyCamelot)
        .orderBy(sql`COUNT(*) DESC`)
        .all();

    const formatStats = db
        .select({ format: sql<string>`UPPER(${tracks.format})`, count: sql<number>`COUNT(*)` })
        .from(tracks)
        .where(sql`${tracks.format} IS NOT NULL`)
        .groupBy(sql`UPPER(${tracks.format})`)
        .orderBy(sql`COUNT(*) DESC`)
        .all();

    const missingGenre = db.select({ count: sql<number>`COUNT(*)` }).from(tracks).where(sql`${tracks.genre} IS NULL OR ${tracks.genre} = ''`).get();
    const missingBpm = db.select({ count: sql<number>`COUNT(*)` }).from(tracks).where(sql`${tracks.bpm} IS NULL`).get();
    const missingKey = db.select({ count: sql<number>`COUNT(*)` }).from(tracks).where(sql`${tracks.keyCamelot} IS NULL OR ${tracks.keyCamelot} = ''`).get();
    const missingEnergy = db.select({ count: sql<number>`COUNT(*)` }).from(tracks).where(sql`${tracks.energy} IS NULL`).get();
    const missingArtwork = db.select({ count: sql<number>`COUNT(*)` }).from(tracks).where(sql`${tracks.artworkUrl} IS NULL OR ${tracks.artworkUrl} = ''`).get();

    const recentTracks = db
        .select({
            id: tracks.id,
            title: tracks.title,
            artist: tracks.artist,
            genre: tracks.genre,
            bpm: tracks.bpm,
            keyCamelot: tracks.keyCamelot,
            energy: tracks.energy,
            rating: tracks.rating,
            artworkUrl: tracks.artworkUrl,
            addedAt: tracks.addedAt,
            duration: tracks.duration,
            isFavorite: tracks.isFavorite,
        })
        .from(tracks)
        .orderBy(desc(tracks.addedAt))
        .limit(8)
        .all();

    const topRated = db
        .select({
            id: tracks.id,
            title: tracks.title,
            artist: tracks.artist,
            rating: tracks.rating,
            artworkUrl: tracks.artworkUrl,
        })
        .from(tracks)
        .where(sql`${tracks.rating} IS NOT NULL AND ${tracks.rating} >= 4`)
        .orderBy(desc(tracks.rating), desc(tracks.addedAt))
        .limit(5)
        .all();

    const totalCount = total?.count ?? 0;

    return {
        total: totalCount,
        processed: processed?.count ?? 0,
        unprocessed: totalCount - (processed?.count ?? 0),
        analyzed: analyzed?.count ?? 0,
        favorites: favorites?.count ?? 0,
        avgBpm: avgBpm?.avg ? Math.round(avgBpm.avg) : 0,
        totalDuration: totalDuration?.sum ?? 0,
        totalSize: totalSize?.sum ?? 0,
        playlistCount: playlistCount?.count ?? 0,
        genreStats,
        energyStats: energyStats.map((e) => ({ energy: e.energy ?? 0, count: e.count })),
        bpmRanges,
        keyStats: keyStats.map((k) => ({ key: k.key || "Unknown", count: k.count })),
        formatStats: formatStats.map((f) => ({ format: f.format || "Unknown", count: f.count })),
        health: {
            total: totalCount,
            missingGenre: missingGenre?.count ?? 0,
            missingBpm: missingBpm?.count ?? 0,
            missingKey: missingKey?.count ?? 0,
            missingEnergy: missingEnergy?.count ?? 0,
            missingArtwork: missingArtwork?.count ?? 0,
        },
        recentTracks,
        topRated,
    };
}

export async function hideTracks(ids: number[]) {
    if (ids.length === 0) return { success: true, count: 0 };
    db.update(tracks)
        .set({ isHidden: true })
        .where(inArray(tracks.id, ids))
        .run();
    revalidatePath("/library");
    revalidatePath("/");
    return { success: true, count: ids.length };
}

export async function unhideTracks(ids: number[]) {
    if (ids.length === 0) return { success: true, count: 0 };
    db.update(tracks)
        .set({ isHidden: false })
        .where(inArray(tracks.id, ids))
        .run();
    revalidatePath("/library");
    revalidatePath("/library/hidden");
    revalidatePath("/");
    return { success: true, count: ids.length };
}

export async function getHiddenTracks(
    filters?: Pick<TrackFilters, "page" | "pageSize" | "search" | "sort" | "order">
): Promise<PaginatedTracks> {
    const page = filters?.page || 1;
    const pageSize = filters?.pageSize || 50;
    const offset = (page - 1) * pageSize;
    const orderBy = buildOrderBy(filters?.sort, filters?.order);

    const conditions = [eq(tracks.isHidden, true)];

    if (filters?.search) {
        const term = `%${filters.search}%`;
        conditions.push(
            sql`(${tracks.artist} LIKE ${term} OR ${tracks.title} LIKE ${term} OR ${tracks.filename} LIKE ${term})`
        );
    }

    const whereClause = and(...conditions);

    const totalResult = db
        .select({ count: sql<number>`COUNT(*)` })
        .from(tracks)
        .where(whereClause)
        .get();

    const result = db
        .select()
        .from(tracks)
        .where(whereClause)
        .orderBy(orderBy)
        .limit(pageSize)
        .offset(offset)
        .all();

    return {
        tracks: result,
        total: totalResult?.count ?? 0,
        page,
        pageSize,
        totalPages: Math.ceil((totalResult?.count ?? 0) / pageSize),
    };
}
