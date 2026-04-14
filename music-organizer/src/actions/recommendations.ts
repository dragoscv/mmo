"use server";

import { db } from "@/db";
import { tracks } from "@/db/schema";
import { sql, and, ne } from "drizzle-orm";
import { getHarmonicScore } from "@/lib/genre-suggest";

interface RecommendedTrack {
  id: number;
  title: string | null;
  artist: string | null;
  bpm: number | null;
  keyCamelot: string | null;
  genre: string | null;
  duration: number | null;
  score: number;
  reason: string;
}

export async function getRecommendedTracks(
  currentTrackId: number,
  genre?: string | null,
  bpm?: number | null,
  keyCamelot?: string | null,
  limit: number = 10
): Promise<RecommendedTrack[]> {
  // Find candidates with similar genre, BPM, or compatible keys
  const conditions = [ne(tracks.id, currentTrackId)];

  // Prefer same genre
  if (genre) {
    conditions.push(sql`${tracks.genre} = ${genre}`);
  }

  // BPM range: ±15%
  if (bpm && bpm > 0) {
    const minBpm = Math.floor(bpm * 0.85);
    const maxBpm = Math.ceil(bpm * 1.15);
    conditions.push(sql`${tracks.bpm} BETWEEN ${minBpm} AND ${maxBpm}`);
  }

  const candidates = db
    .select({
      id: tracks.id,
      title: tracks.title,
      artist: tracks.artist,
      bpm: tracks.bpm,
      keyCamelot: tracks.keyCamelot,
      genre: tracks.genre,
      duration: tracks.duration,
    })
    .from(tracks)
    .where(and(...conditions))
    .limit(50)
    .all();

  // Score and sort candidates
  const scored: RecommendedTrack[] = candidates.map((t) => {
    let score = 0;
    const reasons: string[] = [];

    // Key compatibility (highest weight)
    if (keyCamelot && t.keyCamelot) {
      const harmonic = getHarmonicScore(keyCamelot, t.keyCamelot);
      if (harmonic === 0) {
        score += 30;
        reasons.push("Same key");
      } else if (harmonic === 1) {
        score += 25;
        reasons.push("Harmonic match");
      } else if (harmonic === 2) {
        score += 15;
        reasons.push("Near key");
      }
    }

    // BPM proximity
    if (bpm && t.bpm) {
      const diff = Math.abs(bpm - t.bpm);
      if (diff <= 2) {
        score += 20;
        reasons.push("Same BPM");
      } else if (diff <= 5) {
        score += 15;
        reasons.push("Similar BPM");
      } else if (diff <= 10) {
        score += 8;
        reasons.push("Close BPM");
      }
    }

    // Same genre bonus
    if (genre && t.genre === genre) {
      score += 10;
      reasons.push("Same genre");
    }

    return {
      ...t,
      score,
      reason: reasons.join(" · ") || "Similar track",
    };
  });

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
