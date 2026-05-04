"use server";

/**
 * Stem-separation orchestration. Stems metadata (status, paths) lives on
 * each track row in the companion. This action surface is a thin proxy.
 */

import { companionLibrary, getCompanionLink, type CompanionTrack } from "@/lib/companion-library";

export type StemsStatus = "pending" | "processing" | "ready" | "error";

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
    const link = await getCompanionLink();
    if (!link) return;

    const update: Partial<CompanionTrack> = { stemsStatus: status };
    if (status === "ready") update.stemsAnalyzedAt = new Date().toISOString();
    if (paths) {
        if (paths.vocalsPath !== undefined) update.stemsVocalsPath = paths.vocalsPath;
        if (paths.drumsPath !== undefined) update.stemsDrumsPath = paths.drumsPath;
        if (paths.bassPath !== undefined) update.stemsBassPath = paths.bassPath;
        if (paths.melodyPath !== undefined) update.stemsMelodyPath = paths.melodyPath;
    }
    await companionLibrary.updateTrack(link, trackId, update);
}

export async function queueStemsAnalysis(trackIds: number[]): Promise<{ queued: number }> {
    if (trackIds.length === 0) return { queued: 0 };
    const link = await getCompanionLink();
    if (!link) return { queued: 0 };

    let queued = 0;
    for (const id of trackIds) {
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
    if (trackIds.length === 0) return { queued: 0 };
    const link = await getCompanionLink();
    if (!link) return { queued: 0 };

    for (const id of trackIds) {
        const update: Partial<CompanionTrack> = {};
        if (options.stems) update.stemsStatus = "pending";
        if (options.bpm || options.key || options.metadata || options.artwork || options.lyrics) {
            update.analyzedAt = null;
        }
        if (Object.keys(update).length > 0) {
            try { await companionLibrary.updateTrack(link, id, update); } catch { /* skip */ }
        }
    }
    return { queued: trackIds.length };
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
        // Companion /stats doesn't expose stems counts; pull a large page.
        const r = await companionLibrary.getTracks(link, { page: 1, pageSize: 1000 });
        const all = r.tracks;
        return {
            total: all.length,
            ready: all.filter((t) => t.stemsStatus === "ready").length,
            pending: all.filter((t) => t.stemsStatus === "pending").length,
            processing: all.filter((t) => t.stemsStatus === "processing").length,
            error: all.filter((t) => t.stemsStatus === "error").length,
        };
    } catch {
        return { total: 0, ready: 0, pending: 0, processing: 0, error: 0 };
    }
}
