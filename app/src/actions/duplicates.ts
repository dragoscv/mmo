"use server";

import { z } from "zod";
import { log } from "@/lib/logger";
import { revalidatePath } from "next/cache";
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

/** Score a candidate so the "best" copy floats to the top of a group.
 *  Higher bitrate + lossless format + higher rating + more recent. */
function quality(t: DuplicateTrack): number {
    let s = 0;
    s += t.bitrate ?? 0;
    if (t.format && /flac|alac|wav|aiff/i.test(t.format)) s += 5000;
    s += (t.rating ?? 0) * 100;
    if (t.addedAt) s += Math.min(1000, Math.floor(Date.parse(t.addedAt) / 1e10));
    return s;
}

function sortByQuality<T extends DuplicateTrack>(arr: T[]): T[] {
    return [...arr].sort((a, b) => quality(b) - quality(a));
}

function normaliseString(s: string | null | undefined): string {
    if (!s) return "";
    return s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        // Drop bracketed annotations: (Original Mix), [feat. X], etc.
        .replace(/[\(\[].*?[\)\]]/g, " ")
        // Strip common dash-separated suffixes ("- Radio Edit")
        .replace(/\s-\s.*$/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

/** Round to nearest 5-second bucket so 03:21 ≈ 03:23. */
function durationBucket(seconds: number | null): string {
    if (!seconds || seconds <= 0) return "0";
    return String(Math.round(seconds / 5));
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

/** Quick prefix-bucket fingerprint match. Two fingerprints are
 *  considered "close enough" if they share their first PREFIX_LEN chars
 *  (Chromaprint's compressed string is positional, so a shared prefix
 *  ≈ shared opening seconds of the song). This is intentionally loose —
 *  the UI shows the group and the user confirms. A future iteration can
 *  upgrade to a Hamming-distance comparison on the raw fingerprint
 *  bytes once the companion exposes them. */
const FP_PREFIX_LEN = 24;

export async function findAudioDuplicates(): Promise<DuplicateReport> {
    try {
        const all = await fetchAllTracks();
        const buckets = new Map<string, CompanionTrack[]>();
        let withFp = 0;
        for (const t of all) {
            const fp = t.acoustidFingerprint;
            if (!fp || fp.length < FP_PREFIX_LEN) continue;
            withFp++;
            const key = fp.slice(0, FP_PREFIX_LEN);
            const arr = buckets.get(key) ?? [];
            arr.push(t);
            buckets.set(key, arr);
        }
        const groups: DuplicateGroup[] = [];
        let dupCount = 0;
        for (const [key, ts] of buckets) {
            if (ts.length < 2) continue;
            // Skip groups already covered by sha256 (strategy 1).
            const shas = new Set(ts.map(t => t.sha256).filter(Boolean));
            if (shas.size <= 1 && ts.every(t => t.sha256)) continue;
            const picked = sortByQuality(ts.map(pick));
            groups.push({
                key: `fp:${key}`,
                tracks: picked,
                reason: `fingerprint prefix ${key.slice(0, 8)}…`,
            });
            dupCount += picked.length;
        }
        groups.sort((a, b) => b.tracks.length - a.tracks.length);
        return { groups, scanned: withFp, duplicates: dupCount };
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
