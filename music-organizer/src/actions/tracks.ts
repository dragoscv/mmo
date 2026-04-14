"use server";

import { db } from "@/db";
import { tracks } from "@/db/schema";
import { eq, sql, and, gte, lte, desc, asc } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export interface TrackFilters {
  genre?: string;
  minBpm?: number;
  maxBpm?: number;
  energy?: number;
  search?: string;
  key?: string;
  isProcessed?: boolean;
  isFavorite?: boolean;
  tag?: string;
  rating?: number;
  album?: string;
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

  if (filters.genre) {
    conditions.push(eq(tracks.genre, filters.genre));
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
    conditions.push(
      sql`(${tracks.keyCamelot} = ${filters.key} OR ${tracks.keyMusical} = ${filters.key})`
    );
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
    const tagPattern = `%"${filters.tag}"%`;
    conditions.push(sql`${tracks.tags} LIKE ${tagPattern}`);
  }
  if (filters.album) {
    const albumTerm = `%${filters.album}%`;
    conditions.push(sql`${tracks.album} LIKE ${albumTerm}`);
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
      } catch {}
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
