"use server";

import { z } from "zod";
import { log } from "@/lib/logger";
import { revalidatePath } from "next/cache";
import { quality, normaliseString, durationBucket } from "@/lib/duplicates-helpers";
import { decodeFingerprint, fingerprintSimilarity } from "@/lib/chromaprint";
import { clusterByPredicate } from "@/lib/cluster";
import {
    companionLibrary,
    getCompanionLink,
    type CompanionTrack,
} from "@/lib/companion-library";

/**
 * Duplicate detection — three orthogonal strategies:
 *
 *   1. Exact   — same SHA-256 (byte-identical files). Cheap, decisive.
 *   2. Fuzzy   — normalised title + artist + duration bucket. Catches
 *                re-rips, transcodes, slightly retagged copies.
 *   3. Audio   — Chromaprint fingerprint similarity. Catches re-encodes
 *                across formats and minor edits. Requires the companion
 *                analyzer to have run with `fingerprint: true` (see
 *                analyzer.ts). Tracks without a fingerprint are skipped.
 *
 * Each strategy returns a list of GROUPS; every group is N≥2 tracks the
 * heuristic considers "the same song". We never auto-resolve — the UI
 * shows the groups and the user decides what to do with each.
 */

export interface DuplicateTrack {
    id: number;
    title: string | null;
    artist: string | null;
    album: string | null;
    duration: number | null;
    bitrate: number | null;
    fileSize: number | null;
    format: string | null;
    sha256: string | null;
    artworkUrl: string | null;
    rating: number | null;
    addedAt: string | null;
    isHidden: boolean | null;
}

export interface DuplicateGroup {
    /** Stable key for the group (sha prefix / fuzzy hash / fp prefix). */
    key: string;
    /** Tracks in this group; sorted with the "best" candidate first. */
    tracks: DuplicateTrack[];
    /** Diagnostic — what made this a group (e.g. "sha256:abc12…"). */
    reason: string;
}

export interface DuplicateReport {
    groups: DuplicateGroup[];
    /** Total tracks scanned. */
    scanned: number;
    /** Total tracks involved in any group. */
    duplicates: number;
}

const EMPTY: DuplicateReport = { groups: [], scanned: 0, duplicates: 0 };

// ─── Helpers ────────────────────────────────────────────────────────────────

const FETCH_PAGE_SIZE = 500;
const MAX_PAGES = 40; // 20 000 tracks is well past any realistic library

/** Pulls every (non-hidden) track from the companion in 500-row pages. */
async function fetchAllTracks(): Promise<CompanionTrack[]> {
    const link = await getCompanionLink();
    if (!link) return [];
    const out: CompanionTrack[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await companionLibrary.getTracks(link, {
            page,
            pageSize: FETCH_PAGE_SIZE,
            isHidden: false,
        });
        out.push(...res.tracks);
        if (res.tracks.length < FETCH_PAGE_SIZE || out.length >= res.total) break;
    }
    return out;
}

function pick(t: CompanionTrack): DuplicateTrack {
    return {
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration: t.duration,
        bitrate: t.bitrate,
        fileSize: t.fileSize,
        format: t.format,
        sha256: t.sha256 ?? null,
        artworkUrl: t.artworkUrl,
        rating: t.rating,
        addedAt: t.addedAt,
        isHidden: t.isHidden,
    };
}

/** Sort a copy of the array best-quality-first, leaving the input untouched. */
function sortByQuality<T extends DuplicateTrack>(arr: T[]): T[] {
    return [...arr].sort((a, b) => quality(b) - quality(a));
}

// ─── Strategy 1: Exact (sha256) ────────────────────────────────────────────

export async function findExactDuplicates(): Promise<DuplicateReport> {
    try {
        const all = await fetchAllTracks();
        const buckets = new Map<string, CompanionTrack[]>();
        for (const t of all) {
            const sha = t.sha256;
            if (!sha) continue;
            const arr = buckets.get(sha) ?? [];
            arr.push(t);
            buckets.set(sha, arr);
        }
        const groups: DuplicateGroup[] = [];
        let dupCount = 0;
        for (const [sha, ts] of buckets) {
            if (ts.length < 2) continue;
            const picked = sortByQuality(ts.map(pick));
            groups.push({
                key: `sha:${sha.slice(0, 12)}`,
                tracks: picked,
                reason: `sha256 ${sha.slice(0, 12)}…`,
            });
            dupCount += picked.length;
        }
        groups.sort((a, b) => b.tracks.length - a.tracks.length);
        return { groups, scanned: all.length, duplicates: dupCount };
    } catch (err) {
        log.warn("duplicates.exact failed", undefined, err);
        return EMPTY;
    }
}

// ─── Strategy 2: Fuzzy (title+artist+duration) ─────────────────────────────

export async function findFuzzyDuplicates(): Promise<DuplicateReport> {
    try {
        const all = await fetchAllTracks();
        const buckets = new Map<string, CompanionTrack[]>();
        for (const t of all) {
            const title = normaliseString(t.title);
            const artist = normaliseString(t.artist);
            // Need at least a title or artist or it's a junk row.
            if (!title && !artist) continue;
            const dur = durationBucket(t.duration);
            const key = `${artist}|${title}|${dur}`;
            const arr = buckets.get(key) ?? [];
            arr.push(t);
            buckets.set(key, arr);
        }
        const groups: DuplicateGroup[] = [];
        let dupCount = 0;
        for (const [key, ts] of buckets) {
            if (ts.length < 2) continue;
            // De-dupe by sha256 first — exact dups are reported by strategy 1.
            const distinctShas = new Set(ts.map(t => t.sha256).filter(Boolean));
            if (distinctShas.size <= 1 && ts.every(t => t.sha256)) continue;
            const picked = sortByQuality(ts.map(pick));
            groups.push({
                key: `fz:${key.slice(0, 64)}`,
                tracks: picked,
                reason: "title+artist+duration match",
            });
            dupCount += picked.length;
        }
        groups.sort((a, b) => b.tracks.length - a.tracks.length);
        return { groups, scanned: all.length, duplicates: dupCount };
    } catch (err) {
        log.warn("duplicates.fuzzy failed", undefined, err);
        return EMPTY;
    }
}

// ─── Strategy 3: Audio fingerprint (chromaprint) ───────────────────────────

/** Bucket key length used for O(n) candidate generation. The compressed
 *  Chromaprint header byte plus the next ~9 base64 chars cover the
 *  algorithm version + the first few sub-fingerprints. We deliberately
 *  use a short prefix here (vs. the previous 24) — the Hamming-distance
 *  pass below is what actually decides whether two tracks match, so the
 *  bucket only needs to be loose enough to put true duplicates in the
 *  same group, not strict enough to be its own answer. */
const FP_BUCKET_LEN = 10;

/** Minimum bit-level similarity for two decoded fingerprints to be
 *  considered the same recording. Empirically: identical files score
 *  1.00, the same song re-encoded at a different bitrate scores
 *  ~0.90–0.99, unrelated tracks sit below 0.55. 0.85 is the safe floor
 *  that catches mastering / loudness-normalised re-encodes without
 *  generating false positives across genre-related (but distinct)
 *  recordings. */
const FP_SIMILARITY_THRESHOLD = 0.85;

export async function findAudioDuplicates(): Promise<DuplicateReport> {
    try {
        const all = await fetchAllTracks();

        // 1) Decode every fingerprint exactly once and keep tracks
        //    that produced a usable Uint32Array.
        type Decoded = { track: CompanionTrack; data: Uint32Array; fp: string };
        const decoded: Decoded[] = [];
        for (const t of all) {
            const fp = t.acoustidFingerprint;
            if (!fp || fp.length < FP_BUCKET_LEN) continue;
            const d = decodeFingerprint(fp);
            if (!d || d.data.length === 0) continue;
            decoded.push({ track: t, data: d.data, fp });
        }

        // 2) Loose prefix bucketing → O(n) candidate groups.
        const buckets = new Map<string, Decoded[]>();
        for (const d of decoded) {
            const key = d.fp.slice(0, FP_BUCKET_LEN);
            const arr = buckets.get(key) ?? [];
            arr.push(d);
            buckets.set(key, arr);
        }

        // 3) For each candidate bucket, run union-find over pairwise
        //    Hamming similarity. Connected components ≥ 2 are emitted.
        const groups: DuplicateGroup[] = [];
        let dupCount = 0;
        for (const [key, items] of buckets) {
            if (items.length < 2) continue;
            const clusters = clusterByPredicate(items, (a, b) =>
                fingerprintSimilarity(a.data, b.data) >= FP_SIMILARITY_THRESHOLD,
            );
            for (const cluster of clusters) {
                if (cluster.length < 2) continue;
                // Skip clusters already covered by sha256 (strategy 1).
                const shas = new Set(cluster.map((c) => c.track.sha256).filter(Boolean));
                if (shas.size <= 1 && cluster.every((c) => c.track.sha256)) continue;
                const picked = sortByQuality(cluster.map((c) => pick(c.track)));
                // Average pairwise similarity for the group's display reason.
                let pairs = 0;
                let sum = 0;
                for (let i = 0; i < cluster.length; i++) {
                    for (let j = i + 1; j < cluster.length; j++) {
                        sum += fingerprintSimilarity(cluster[i].data, cluster[j].data);
                        pairs++;
                    }
                }
                const avg = pairs > 0 ? sum / pairs : 1;
                groups.push({
                    key: `fp:${key}:${picked[0]?.id ?? 0}`,
                    tracks: picked,
                    reason: `audio similarity ${(avg * 100).toFixed(1)}%`,
                });
                dupCount += picked.length;
            }
        }
        groups.sort((a, b) => b.tracks.length - a.tracks.length);
        return { groups, scanned: decoded.length, duplicates: dupCount };
    } catch (err) {
        log.warn("duplicates.audio failed", undefined, err);
        return EMPTY;
    }
}

// ─── Resolve actions ───────────────────────────────────────────────────────
//
// "Resolve" means: pick a winner in a group, then either hide or delete
// the losers. The UI passes us the IDs to act on directly — there's no
// auto-pick on the server side.

const idsSchema = z.array(z.number().int().positive()).min(1);

export async function resolveDuplicatesHide(
    ids: number[],
): Promise<{ ok: boolean; count: number; error?: string }> {
    const parsed = idsSchema.safeParse(ids);
    if (!parsed.success) return { ok: false, count: 0, error: "invalid ids" };
    const link = await getCompanionLink();
    if (!link) return { ok: false, count: 0, error: "companion not linked" };
    try {
        for (const id of parsed.data) {
            await companionLibrary.updateTrack(link, id, { isHidden: true });
        }
        revalidatePath("/library/duplicates");
        revalidatePath("/library");
        return { ok: true, count: parsed.data.length };
    } catch (err) {
        log.warn("duplicates.resolve.hide failed", undefined, err);
        return { ok: false, count: 0, error: "companion error" };
    }
}

export async function resolveDuplicatesDelete(
    ids: number[],
): Promise<{ ok: boolean; count: number; error?: string }> {
    const parsed = idsSchema.safeParse(ids);
    if (!parsed.success) return { ok: false, count: 0, error: "invalid ids" };
    const link = await getCompanionLink();
    if (!link) return { ok: false, count: 0, error: "companion not linked" };
    try {
        for (const id of parsed.data) {
            await companionLibrary.deleteTrack(link, id);
        }
        revalidatePath("/library/duplicates");
        revalidatePath("/library");
        return { ok: true, count: parsed.data.length };
    } catch (err) {
        log.warn("duplicates.resolve.delete failed", undefined, err);
        return { ok: false, count: 0, error: "companion error" };
    }
}
