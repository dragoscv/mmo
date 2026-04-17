"use server";

import { db } from "@/db";
import { tracks } from "@/db/schema";
import type { Track } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Get stems info for a track ──────────────────────────────────────────────

export async function getTrackStemsInfo(trackId: number): Promise<TrackStemsInfo | null> {
    const track = db.select({
        id: tracks.id,
        stemsStatus: tracks.stemsStatus,
        stemsVocalsPath: tracks.stemsVocalsPath,
        stemsDrumsPath: tracks.stemsDrumsPath,
        stemsBassPath: tracks.stemsBassPath,
        stemsMelodyPath: tracks.stemsMelodyPath,
        stemsAnalyzedAt: tracks.stemsAnalyzedAt,
    }).from(tracks).where(eq(tracks.id, trackId)).get();

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

// ─── Update stems status ─────────────────────────────────────────────────────

export async function updateStemsStatus(
    trackId: number,
    status: StemsStatus,
    paths?: {
        vocalsPath?: string;
        drumsPath?: string;
        bassPath?: string;
        melodyPath?: string;
    }
) {
    const update: Record<string, unknown> = { stemsStatus: status };
    if (status === "ready") {
        update.stemsAnalyzedAt = new Date().toISOString();
    }
    if (paths) {
        if (paths.vocalsPath !== undefined) update.stemsVocalsPath = paths.vocalsPath;
        if (paths.drumsPath !== undefined) update.stemsDrumsPath = paths.drumsPath;
        if (paths.bassPath !== undefined) update.stemsBassPath = paths.bassPath;
        if (paths.melodyPath !== undefined) update.stemsMelodyPath = paths.melodyPath;
    }

    db.update(tracks).set(update).where(eq(tracks.id, trackId)).run();
}

// ─── Queue tracks for stem analysis ──────────────────────────────────────────

export async function queueStemsAnalysis(trackIds: number[]): Promise<{ queued: number }> {
    if (trackIds.length === 0) return { queued: 0 };

    let queued = 0;
    for (const id of trackIds) {
        db.update(tracks)
            .set({ stemsStatus: "pending" })
            .where(eq(tracks.id, id))
            .run();
        queued++;
    }

    return { queued };
}

// ─── Get tracks pending stems analysis ───────────────────────────────────────

export async function getPendingStemsTracks(): Promise<Track[]> {
    return db.select().from(tracks).where(eq(tracks.stemsStatus, "pending")).all();
}

// ─── Reanalyze tracks (configurable) ─────────────────────────────────────────

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
    options: ReanalyzeOptions
): Promise<{ queued: number }> {
    if (trackIds.length === 0) return { queued: 0 };

    // For stems, mark tracks as pending
    if (options.stems) {
        for (const id of trackIds) {
            db.update(tracks)
                .set({ stemsStatus: "pending" })
                .where(eq(tracks.id, id))
                .run();
        }
    }

    // For other analysis types, clear the analyzed timestamp so they get re-processed
    if (options.bpm || options.key || options.metadata || options.artwork || options.lyrics) {
        for (const id of trackIds) {
            db.update(tracks)
                .set({ analyzedAt: null })
                .where(eq(tracks.id, id))
                .run();
        }
    }

    return { queued: trackIds.length };
}

// ─── Get track stems count stats ─────────────────────────────────────────────

export async function getStemsStats(): Promise<{
    total: number;
    ready: number;
    pending: number;
    processing: number;
    error: number;
}> {
    const allTracks = db.select({ stemsStatus: tracks.stemsStatus }).from(tracks).all();
    return {
        total: allTracks.length,
        ready: allTracks.filter(t => t.stemsStatus === "ready").length,
        pending: allTracks.filter(t => t.stemsStatus === "pending").length,
        processing: allTracks.filter(t => t.stemsStatus === "processing").length,
        error: allTracks.filter(t => t.stemsStatus === "error").length,
    };
}
