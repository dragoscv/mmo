"use server";

/**
 * Stem-separation orchestration. Stems metadata (status, paths) lives on
 * each track row in the companion. This action surface is a thin proxy.
 */

import { z } from "zod";
import { companionLibrary, getCompanionLink, type CompanionTrack } from "@/lib/companion-library";

export type StemsStatus = "pending" | "processing" | "ready" | "error";

// Cap unbounded loops to prevent N-companion-call DoS amplification.
// Real stems jobs are O(10) selected tracks; the cap is generous but bounded.
const MAX_BULK_TRACKS = 5000;
const stemsStatusSchema = z.enum(["pending", "processing", "ready", "error"]);
const trackIdSchema = z.number().int().positive();
const trackIdsSchema = z.array(trackIdSchema).max(MAX_BULK_TRACKS);
// Stem paths come from the analyzer sidecar (companion-side) and round-trip
// through this action only on completion callbacks. Validate shape so a
// rogue caller can't poison companion DB rows with multi-MB blobs or
// control-byte filenames that downstream readers assume are clean strings.
const stemPathSchema = z.string().min(1).max(4096).refine(
    (p) => !/[\x00-\x1f]/.test(p),
    { message: "path must not contain control characters" },
);
const stemsPathsSchema = z.object({
    vocalsPath: stemPathSchema.optional(),
    drumsPath: stemPathSchema.optional(),
    bassPath: stemPathSchema.optional(),
    melodyPath: stemPathSchema.optional(),
}).strict().partial();

export interface TrackStemsInfo {
    trackId: number;
    status: string | null;
    vocalsPath: string | null;
    drumsPath: string | null;
    bassPath: string | null;
    melodyPath: string | null;
    analyzedAt: string | null;
}

export async function getTrackStemsInfo(trackId: number): Promise<TrackStemsInfo | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    const track = await companionLibrary.getTrackById(link, trackId);
    if (!track) return null;
    return {
        trackId: track.id,
        status: track.stemsStatus,
        vocalsPath: track.stemsVocalsPath,
        drumsPath: track.stemsDrumsPath,
        bassPath: track.stemsBassPath,
        melodyPath: track.stemsMelodyPath,
        analyzedAt: track.stemsAnalyzedAt,
    };
}

export async function updateStemsStatus(
    trackId: number,
    status: StemsStatus,
    paths?: {
        vocalsPath?: string;
        drumsPath?: string;
        bassPath?: string;
        melodyPath?: string;
    },
) {
    if (!trackIdSchema.safeParse(trackId).success) return;
    if (!stemsStatusSchema.safeParse(status).success) return;
    const pathsCheck = paths ? stemsPathsSchema.safeParse(paths) : { success: true as const, data: undefined };
    if (!pathsCheck.success) return;
    const link = await getCompanionLink();
    if (!link) return;

    const update: Partial<CompanionTrack> = { stemsStatus: status };
    if (status === "ready") update.stemsAnalyzedAt = new Date().toISOString();
    const safePaths = pathsCheck.data;
    if (safePaths) {
        if (safePaths.vocalsPath !== undefined) update.stemsVocalsPath = safePaths.vocalsPath;
        if (safePaths.drumsPath !== undefined) update.stemsDrumsPath = safePaths.drumsPath;
        if (safePaths.bassPath !== undefined) update.stemsBassPath = safePaths.bassPath;
        if (safePaths.melodyPath !== undefined) update.stemsMelodyPath = safePaths.melodyPath;
    }
    await companionLibrary.updateTrack(link, trackId, update);
}

export async function queueStemsAnalysis(trackIds: number[]): Promise<{ queued: number }> {
    const idsCheck = trackIdsSchema.safeParse(trackIds);
    if (!idsCheck.success) return { queued: 0 };
    const ids = idsCheck.data;
    if (ids.length === 0) return { queued: 0 };
    const link = await getCompanionLink();
    if (!link) return { queued: 0 };

    let queued = 0;
    for (const id of ids) {
        try {
            await companionLibrary.updateTrack(link, id, { stemsStatus: "pending" });
            queued++;
        } catch { /* skip */ }
    }
    return { queued };
}

export async function getPendingStemsTracks(): Promise<CompanionTrack[]> {
    const link = await getCompanionLink();
    if (!link) return [];
    // Companion has no dedicated /tracks?stemsStatus filter; pull a wide
    // page and filter in JS. Pending queue is expected to be small.
    try {
        const r = await companionLibrary.getTracks(link, { page: 1, pageSize: 500 });
        return r.tracks.filter((t) => t.stemsStatus === "pending");
    } catch { return []; }
}

export interface ReanalyzeOptions {
    bpm: boolean;
    key: boolean;
    stems: boolean;
    metadata: boolean;
    artwork: boolean;
    lyrics: boolean;
}

export async function reanalyzeTracks(
    trackIds: number[],
    options: ReanalyzeOptions,
): Promise<{ queued: number }> {
    const idsCheck = trackIdsSchema.safeParse(trackIds);
    if (!idsCheck.success) return { queued: 0 };
    const ids = idsCheck.data;
    if (ids.length === 0) return { queued: 0 };
    const link = await getCompanionLink();
    if (!link) return { queued: 0 };

    for (const id of ids) {
        const update: Partial<CompanionTrack> = {};
        if (options.stems) update.stemsStatus = "pending";
        if (options.bpm || options.key || options.metadata || options.artwork || options.lyrics) {
            update.analyzedAt = null;
        }
        if (Object.keys(update).length > 0) {
            try { await companionLibrary.updateTrack(link, id, update); } catch { /* skip */ }
        }
    }
    return { queued: ids.length };
}

export async function getStemsStats(): Promise<{
    total: number;
    ready: number;
    pending: number;
    processing: number;
    error: number;
}> {
    const link = await getCompanionLink();
    if (!link) return { total: 0, ready: 0, pending: 0, processing: 0, error: 0 };
    try {
        // Companion /stats doesn't expose stems counts. Page through the
        // library so libraries > 1000 tracks aren't undercounted (the
        // previous single-page read silently capped totals at 1000).
        const PAGE_SIZE = 1000;
        const HARD_CAP_PAGES = 200; // 200k tracks is well above any real DJ library
        const counts = { total: 0, ready: 0, pending: 0, processing: 0, error: 0 };
        for (let page = 1; page <= HARD_CAP_PAGES; page++) {
            const r = await companionLibrary.getTracks(link, { page, pageSize: PAGE_SIZE });
            counts.total += r.tracks.length;
            for (const t of r.tracks) {
                if (t.stemsStatus === "ready") counts.ready++;
                else if (t.stemsStatus === "pending") counts.pending++;
                else if (t.stemsStatus === "processing") counts.processing++;
                else if (t.stemsStatus === "error") counts.error++;
            }
            if (r.tracks.length < PAGE_SIZE) break;
        }
        return counts;
    } catch {
        return { total: 0, ready: 0, pending: 0, processing: 0, error: 0 };
    }
}

export type StemKind = "vocals" | "drums" | "bass" | "other";

/** Build authenticated stem URLs for a track. Returns null when not paired. */
export async function getStemUrls(stemTrackId: number): Promise<Record<StemKind, string> | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    const kinds: StemKind[] = ["vocals", "drums", "bass", "other"];
    const out = {} as Record<StemKind, string>;
    for (const k of kinds) {
        const u = new URL(`${link.apiUrl}/library/stems/${stemTrackId}/${k}.wav`);
        u.searchParams.set("t", link.token);
        u.searchParams.set("u", link.userId);
        out[k] = u.toString();
    }
    return out;
}
