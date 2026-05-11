"use server";

/**
 * Recommendation engine — runs entirely against the companion library.
 * We over-fetch a BPM-windowed candidate pool then score in JS using
 * key/BPM/genre proximity (same logic as before; previously baked into
 * SQL ORDER BY, now kept in Node so the companion's API can stay generic).
 */

import { getHarmonicScore } from "@/lib/genre-suggest";
import { companionLibrary, getCompanionLink, type CompanionTrack } from "@/lib/companion-library";

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
        key: number; keyMax: number;
        bpm: number; bpmMax: number;
        genre: number; genreMax: number;
    };
}

export type RadioTrack = CompanionTrack;

function score(t: { keyCamelot: string | null; bpm: number | null; genre: string | null },
    seed: { bpm?: number | null; keyCamelot?: string | null; genre?: string | null }) {
    let keyScore = 0, bpmScore = 0, genreScore = 0;
    const reasons: string[] = [];

    if (seed.keyCamelot && t.keyCamelot) {
        const h = getHarmonicScore(seed.keyCamelot, t.keyCamelot);
        if (h === 0) { keyScore = 30; reasons.push("Same key"); }
        else if (h === 1) { keyScore = 25; reasons.push("Harmonic match"); }
        else if (h === 2) { keyScore = 15; reasons.push("Near key"); }
    }
    if (seed.bpm && t.bpm) {
        const diff = Math.abs(seed.bpm - t.bpm);
        if (diff <= 2) { bpmScore = 20; reasons.push("Same BPM"); }
        else if (diff <= 5) { bpmScore = 15; reasons.push("Similar BPM"); }
        else if (diff <= 10) { bpmScore = 8; reasons.push("Close BPM"); }
    }
    if (seed.genre && t.genre === seed.genre) {
        genreScore = 10; reasons.push("Same genre");
    }

    return {
        score: keyScore + bpmScore + genreScore,
        breakdown: {
            key: keyScore, keyMax: 30,
            bpm: bpmScore, bpmMax: 20,
            genre: genreScore, genreMax: 10,
        },
        reason: reasons.join(" · ") || "Similar track",
    };
}

// Cap the requested page size + the radio-mix length. The engine returns
// O(limit) over a 200-track candidate pool and the radio-mix call expands
// to O(2 * size) full-track fetches in parallel; both are cheap individually
// but a 1M-`limit` would balloon RAM and saturate the companion's HTTP keep-
// alive pool.
const MAX_LIMIT = 200;
const MAX_RADIO_SIZE = 200;

export async function getRecommendedTracks(
    currentTrackId: number,
    genre?: string | null,
    bpm?: number | null,
    keyCamelot?: string | null,
    limit: number = 20,
): Promise<RecommendedTrack[]> {
    const safeLimit = Number.isInteger(limit) && limit > 0
        ? Math.min(limit, MAX_LIMIT) : 20;
    const link = await getCompanionLink();
    if (!link) return [];

    const filters: Parameters<typeof companionLibrary.getTracks>[1] = {
        page: 1, pageSize: 200, sort: "addedAt", order: "desc",
    };
    if (bpm && bpm > 0) {
        filters.minBpm = Math.floor(bpm * 0.85);
        filters.maxBpm = Math.ceil(bpm * 1.15);
    }

    let pool: CompanionTrack[];
    try { pool = (await companionLibrary.getTracks(link, filters)).tracks; }
    catch { return []; }

    const scored: RecommendedTrack[] = pool
        .filter((t) => t.id !== currentTrackId)
        .map((t) => {
            const s = score(t, { bpm, keyCamelot, genre });
            return {
                id: t.id, title: t.title, artist: t.artist,
                bpm: t.bpm, keyCamelot: t.keyCamelot, genre: t.genre,
                duration: t.duration, energy: t.energy, artworkUrl: t.artworkUrl,
                score: s.score, maxScore: 60,
                reason: s.reason, breakdown: s.breakdown,
            };
        });

    scored.sort((a, b) => b.score - a.score);
    return scored.filter((t) => t.score > 0).slice(0, safeLimit);
}

export async function getRadioMix(
    seedTrackId: number,
    size: number = 30,
): Promise<RadioTrack[]> {
    const safeSize = Number.isInteger(size) && size > 0
        ? Math.min(size, MAX_RADIO_SIZE) : 30;
    const link = await getCompanionLink();
    if (!link) return [];

    const seed = await companionLibrary.getTrackById(link, seedTrackId);
    if (!seed) return [];

    const recs = await getRecommendedTracks(
        seedTrackId, seed.genre, seed.bpm, seed.keyCamelot, safeSize * 2,
    );
    if (recs.length === 0) return [seed];

    // Pull full track rows in parallel for the recommended IDs.
    const fullPairs = await Promise.all(
        recs.map(async (r) => [r.id, await companionLibrary.getTrackById(link, r.id)] as const),
    );
    const trackMap = new Map<number, CompanionTrack>();
    for (const [id, t] of fullPairs) if (t) trackMap.set(id, t);

    // Greedy nearest-neighbor ordering for smooth mixing.
    const ordered: CompanionTrack[] = [];
    const remaining = new Map(recs.map((r) => [r.id, r]));
    let currentKey = seed.keyCamelot;
    let currentBpm = seed.bpm;

    while (ordered.length < safeSize && remaining.size > 0) {
        let bestId: number | null = null;
        let bestScore = -1;
        for (const [id, rec] of remaining) {
            let s = rec.breakdown.key;
            if (currentKey && rec.keyCamelot) {
                const h = getHarmonicScore(currentKey, rec.keyCamelot);
                if (h === 0) s = 30;
                else if (h === 1) s = 25;
                else if (h === 2) s = 15;
                else s = 0;
            }
            if (currentBpm && rec.bpm) {
                s += Math.max(0, 20 - Math.abs(currentBpm - rec.bpm) * 2);
            }
            if (s > bestScore) { bestScore = s; bestId = id; }
        }
        if (bestId === null) break;
        remaining.delete(bestId);
        const full = trackMap.get(bestId);
        if (full) {
            ordered.push(full);
            currentKey = full.keyCamelot;
            currentBpm = full.bpm;
        }
    }

    return [seed, ...ordered];
}
