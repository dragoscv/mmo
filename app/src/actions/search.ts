"use server";

import { db } from "@/db";
import { tracks, playlists } from "@/db/schema";
import { sql } from "drizzle-orm";

export interface SearchResult {
  tracks: {
    id: number;
    title: string | null;
    artist: string | null;
    album: string | null;
    genre: string | null;
    bpm: number | null;
    keyCamelot: string | null;
    energy: number | null;
    duration: number | null;
    artworkUrl: string | null;
  }[];
  artists: {
    name: string;
    trackCount: number;
  }[];
  albums: {
    name: string;
    artist: string | null;
    trackCount: number;
  }[];
  genres: {
    name: string;
    trackCount: number;
  }[];
  playlists: {
    id: number;
    name: string;
    description: string | null;
    trackCount: number;
  }[];
}

export async function globalSearch(query: string): Promise<SearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { tracks: [], artists: [], albums: [], genres: [], playlists: [] };
  }

  const term = `%${trimmed}%`;

  // Search tracks (limit 8)
  const trackResults = db
    .select({
      id: tracks.id,
      title: tracks.title,
      artist: tracks.artist,
      album: tracks.album,
      genre: tracks.genre,
      bpm: tracks.bpm,
      keyCamelot: tracks.keyCamelot,
      energy: tracks.energy,
      duration: tracks.duration,
      artworkUrl: tracks.artworkUrl,
    })
    .from(tracks)
    .where(
      sql`(${tracks.title} LIKE ${term} OR ${tracks.artist} LIKE ${term} OR ${tracks.album} LIKE ${term} OR ${tracks.filename} LIKE ${term})`
    )
    .orderBy(
      // Prioritize title matches, then artist, then album
      sql`CASE 
        WHEN ${tracks.title} LIKE ${term} THEN 1
        WHEN ${tracks.artist} LIKE ${term} THEN 2
        WHEN ${tracks.album} LIKE ${term} THEN 3
        ELSE 4
      END`
    )
    .limit(8)
    .all();

  // Search distinct artists (limit 5)
  const artistResults = db
    .select({
      name: tracks.artist,
      trackCount: sql<number>`COUNT(*)`,
    })
    .from(tracks)
    .where(sql`${tracks.artist} LIKE ${term} AND ${tracks.artist} IS NOT NULL`)
    .groupBy(tracks.artist)
    .orderBy(sql`COUNT(*) DESC`)
    .limit(5)
    .all()
    .filter((a) => a.name) as { name: string; trackCount: number }[];

  // Search distinct albums (limit 5)
  const albumResults = db
    .select({
      name: tracks.album,
      artist: sql<string | null>`MIN(${tracks.artist})`,
      trackCount: sql<number>`COUNT(*)`,
    })
    .from(tracks)
    .where(sql`${tracks.album} LIKE ${term} AND ${tracks.album} IS NOT NULL`)
    .groupBy(tracks.album)
    .orderBy(sql`COUNT(*) DESC`)
    .limit(5)
    .all()
    .filter((a) => a.name) as { name: string; artist: string | null; trackCount: number }[];

  // Search genres (limit 5)
  const genreResults = db
    .select({
      name: tracks.genre,
      trackCount: sql<number>`COUNT(*)`,
    })
    .from(tracks)
    .where(sql`${tracks.genre} LIKE ${term} AND ${tracks.genre} IS NOT NULL`)
    .groupBy(tracks.genre)
    .orderBy(sql`COUNT(*) DESC`)
    .limit(5)
    .all()
    .filter((g) => g.name) as { name: string; trackCount: number }[];

  // Search playlists (limit 5)
  const playlistResults = db
    .select({
      id: playlists.id,
      name: playlists.name,
      description: playlists.description,
      trackCount: sql<number>`(SELECT COUNT(*) FROM playlist_tracks WHERE playlist_tracks.playlist_id = ${playlists.id})`,
    })
    .from(playlists)
    .where(sql`${playlists.name} LIKE ${term}`)
    .orderBy(playlists.name)
    .limit(5)
    .all();

  return {
    tracks: trackResults,
    artists: artistResults,
    albums: albumResults,
    genres: genreResults,
    playlists: playlistResults,
  };
}
