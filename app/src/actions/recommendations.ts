"use server";

import { db } from "@/db";
import { tracks } from "@/db/schema";
import { sql, and, ne } from "drizzle-orm";
import { getHarmonicScore } from "@/lib/genre-suggest";

export interface RecommendedTrack {
    id: number;
    title: string | null;
    artist: string | null;
    bpm: number | null;
    keyCamelot: string | null;
    genre: string | null;
    duration: number | null;
    energy: number | null;
    artworkUrl: string | null;
    score: number;
    maxScore: number;
    reason: string;
    breakdown: {
        key: number;
        keyMax: number;
        bpm: number;
        bpmMax: number;
        genre: number;
        genreMax: number;
    };
}

export async function getRecommendedTracks(
    currentTrackId: number,
    genre?: string | null,
    bpm?: number | null,
    keyCamelot?: string | null,
    limit: number = 20
): Promise<RecommendedTrack[]> {
    // Find candidates with similar BPM range (don't hard-filter on genre for broader results)
    const conditions = [ne(tracks.id, currentTrackId)];

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
            energy: tracks.energy,
            artworkUrl: tracks.artworkUrl,
        })
        .from(tracks)
        .where(and(...conditions))
        .limit(100)
        .all();

    // Score and sort candidates
    const scored: RecommendedTrack[] = candidates.map((t) => {
        let keyScore = 0;
        let bpmScore = 0;
        let genreScore = 0;
        const reasons: string[] = [];

        // Key compatibility (highest weight)
        if (keyCamelot && t.keyCamelot) {
            const harmonic = getHarmonicScore(keyCamelot, t.keyCamelot);
            if (harmonic === 0) {
                keyScore = 30;
                reasons.push("Same key");
            } else if (harmonic === 1) {
                keyScore = 25;
                reasons.push("Harmonic match");
            } else if (harmonic === 2) {
                keyScore = 15;
                reasons.push("Near key");
            }
        }

        // BPM proximity
        if (bpm && t.bpm) {
            const diff = Math.abs(bpm - t.bpm);
            if (diff <= 2) {
                bpmScore = 20;
                reasons.push("Same BPM");
            } else if (diff <= 5) {
                bpmScore = 15;
                reasons.push("Similar BPM");
            } else if (diff <= 10) {
                bpmScore = 8;
                reasons.push("Close BPM");
            }
        }

        // Same genre bonus
        if (genre && t.genre === genre) {
            genreScore = 10;
            reasons.push("Same genre");
        }

        const score = keyScore + bpmScore + genreScore;

        return {
            ...t,
            score,
            maxScore: 60,
            reason: reasons.join(" · ") || "Similar track",
            breakdown: {
                key: keyScore,
                keyMax: 30,
                bpm: bpmScore,
                bpmMax: 20,
                genre: genreScore,
                genreMax: 10,
            },
        };
    });

    // Sort by score descending, take top N
    scored.sort((a, b) => b.score - a.score);
    return scored.filter((t) => t.score > 0).slice(0, limit);
}
