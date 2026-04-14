"use server";

import { db } from "@/db";
import { tracks } from "@/db/schema";
import type { Track } from "@/db/schema";
import { count, eq, isNull, or, sql } from "drizzle-orm";
import { fetchAllMetadata } from "@/lib/metadata-services";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AnalysisChange {
    trackId: number;
    trackArtist: string;
    trackTitle: string;
    field: string;
    fieldLabel: string;
    oldValue: string | null;
    newValue: string;
    source: string;
    checked: boolean;
}

export interface AnalysisBatchResult {
    changes: AnalysisChange[];
    processed: number;
    total: number;
    currentTrack: string;
    errors: string[];
}

export interface AnalysisScope {
    total: number;
    missingArtwork: number;
    missingLyrics: number;
    missingGenre: number;
    missingBpm: number;
    missingYear: number;
    missingLabel: number;
}

// ─── Get Analysis Scope ──────────────────────────────────────────────────────

export async function getAnalysisScope(): Promise<AnalysisScope> {
    const [totalResult] = await db.select({ value: count() }).from(tracks);
    const [artworkResult] = await db
        .select({ value: count() })
        .from(tracks)
        .where(or(isNull(tracks.artworkUrl), sql`${tracks.artworkUrl} = ''`));
    const [lyricsResult] = await db
        .select({ value: count() })
        .from(tracks)
        .where(isNull(tracks.lyrics));
    const [genreResult] = await db
        .select({ value: count() })
        .from(tracks)
        .where(or(isNull(tracks.genre), sql`${tracks.genre} = ''`));
    const [bpmResult] = await db
        .select({ value: count() })
        .from(tracks)
        .where(or(isNull(tracks.bpm), sql`${tracks.bpm} = 0`));
    const [yearResult] = await db
        .select({ value: count() })
        .from(tracks)
        .where(isNull(tracks.year));
    const [labelResult] = await db
        .select({ value: count() })
        .from(tracks)
        .where(or(isNull(tracks.label), sql`${tracks.label} = ''`));

    return {
        total: totalResult.value,
        missingArtwork: artworkResult.value,
        missingLyrics: lyricsResult.value,
        missingGenre: genreResult.value,
        missingBpm: bpmResult.value,
        missingYear: yearResult.value,
        missingLabel: labelResult.value,
    };
}

// ─── Analyze a batch of tracks ───────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
    artworkUrl: "Artwork",
    genre: "Genre",
    album: "Album",
    year: "Year",
    label: "Label",
    bpm: "BPM",
    isrc: "ISRC",
    lyrics: "Lyrics",
    syncedLyrics: "Synced Lyrics",
    musicbrainzId: "MusicBrainz ID",
    releaseMbid: "Release MBID",
};

export async function analyzeTrackBatch(
    offset: number,
    batchSize: number,
    mode: "quick" | "full",
    options: {
        metadata: boolean;
        artwork: boolean;
        lyrics: boolean;
        bpmKey: boolean;
    }
): Promise<AnalysisBatchResult> {
    // Fetch the batch of tracks
    let query;
    if (mode === "quick") {
        // Only tracks missing key info
        query = db
            .select()
            .from(tracks)
            .where(
                or(
                    isNull(tracks.artworkUrl),
                    sql`${tracks.artworkUrl} = ''`,
                    isNull(tracks.lyrics),
                    isNull(tracks.genre),
                    sql`${tracks.genre} = ''`,
                    or(isNull(tracks.bpm), sql`${tracks.bpm} = 0`),
                    isNull(tracks.year),
                    isNull(tracks.label),
                    sql`${tracks.label} = ''`
                )
            )
            .limit(batchSize)
            .offset(offset);
    } else {
        query = db.select().from(tracks).limit(batchSize).offset(offset);
    }

    const batchTracks = await query;

    // Count total for the selected mode
    let totalCount: number;
    if (mode === "quick") {
        const [result] = await db
            .select({ value: count() })
            .from(tracks)
            .where(
                or(
                    isNull(tracks.artworkUrl),
                    sql`${tracks.artworkUrl} = ''`,
                    isNull(tracks.lyrics),
                    isNull(tracks.genre),
                    sql`${tracks.genre} = ''`,
                    or(isNull(tracks.bpm), sql`${tracks.bpm} = 0`),
                    isNull(tracks.year),
                    isNull(tracks.label),
                    sql`${tracks.label} = ''`
                )
            );
        totalCount = result.value;
    } else {
        const [result] = await db.select({ value: count() }).from(tracks);
        totalCount = result.value;
    }

    const changes: AnalysisChange[] = [];
    const errors: string[] = [];
    let currentTrack = "";

    for (const track of batchTracks) {
        const artist = track.artist || "Unknown";
        const title = track.title || track.filename;
        currentTrack = `${artist} — ${title}`;

        if (!track.artist || !track.title) {
            // Can't search without artist+title
            continue;
        }

        try {
            const metadata = await fetchAllMetadata(
                track.artist,
                track.title,
                track.album,
                track.duration,
                options
            );

            // Compare and generate changes
            const compareField = (
                field: keyof Track & string,
                newVal: string | number | null | undefined,
                source: string
            ) => {
                if (newVal == null || newVal === "") return;
                const newStr = String(newVal);
                const oldVal = track[field];
                const oldStr = oldVal != null ? String(oldVal) : null;

                // Only suggest if empty/null OR different value
                const isEmpty =
                    oldStr == null || oldStr === "" || oldStr === "0" || oldStr === "null";

                if (isEmpty || (oldStr !== newStr && mode === "full")) {
                    changes.push({
                        trackId: track.id,
                        trackArtist: artist,
                        trackTitle: title,
                        field,
                        fieldLabel: FIELD_LABELS[field] || field,
                        oldValue: isEmpty ? null : oldStr,
                        newValue: newStr,
                        source,
                        checked: isEmpty, // Auto-check only if field was empty
                    });
                }
            };

            if (metadata.genre && metadata.sources.genre) {
                compareField("genre", metadata.genre, metadata.sources.genre);
            }
            if (metadata.album && metadata.sources.album) {
                compareField("album", metadata.album, metadata.sources.album);
            }
            if (metadata.year && metadata.sources.year) {
                compareField("year", metadata.year, metadata.sources.year);
            }
            if (metadata.label && metadata.sources.label) {
                compareField("label", metadata.label, metadata.sources.label);
            }
            if (metadata.bpm && metadata.sources.bpm) {
                compareField("bpm", metadata.bpm, metadata.sources.bpm);
            }
            if (metadata.isrc && metadata.sources.isrc) {
                compareField("isrc", metadata.isrc, metadata.sources.isrc);
            }
            if (metadata.artworkUrl && metadata.sources.artworkUrl) {
                compareField("artworkUrl", metadata.artworkUrl, metadata.sources.artworkUrl);
            }
            if (metadata.lyrics && metadata.sources.lyrics) {
                // For lyrics, show "Found (X lines)" instead of full text
                const lineCount = metadata.lyrics.split("\n").length;
                changes.push({
                    trackId: track.id,
                    trackArtist: artist,
                    trackTitle: title,
                    field: "lyrics",
                    fieldLabel: "Lyrics",
                    oldValue: track.lyrics ? `${track.lyrics.split("\n").length} lines` : null,
                    newValue: metadata.lyrics,
                    source: metadata.sources.lyrics,
                    checked: !track.lyrics,
                });
            }
            if (metadata.syncedLyrics && metadata.sources.syncedLyrics) {
                const lineCount = metadata.syncedLyrics.split("\n").length;
                changes.push({
                    trackId: track.id,
                    trackArtist: artist,
                    trackTitle: title,
                    field: "syncedLyrics",
                    fieldLabel: "Synced Lyrics",
                    oldValue: track.syncedLyrics
                        ? `${track.syncedLyrics.split("\n").length} lines`
                        : null,
                    newValue: metadata.syncedLyrics,
                    source: metadata.sources.syncedLyrics,
                    checked: !track.syncedLyrics,
                });
            }
            if (metadata.musicbrainzId && metadata.sources.musicbrainzId) {
                compareField("musicbrainzId", metadata.musicbrainzId, metadata.sources.musicbrainzId);
            }
            if (metadata.releaseMbid && metadata.sources.releaseMbid) {
                compareField("releaseMbid", metadata.releaseMbid, metadata.sources.releaseMbid);
            }
        } catch (err) {
            errors.push(`${currentTrack}: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
    }

    return {
        changes,
        processed: offset + batchTracks.length,
        total: totalCount,
        currentTrack,
        errors,
    };
}

// ─── Apply selected changes to the database ──────────────────────────────────

interface ChangeToApply {
    trackId: number;
    field: string;
    newValue: string;
}

export async function applyAnalysisChanges(
    changesToApply: ChangeToApply[]
): Promise<{ applied: number; errors: number }> {
    let applied = 0;
    let errorCount = 0;

    // Group changes by trackId for efficient updates
    const grouped = new Map<number, ChangeToApply[]>();
    for (const change of changesToApply) {
        const existing = grouped.get(change.trackId) ?? [];
        existing.push(change);
        grouped.set(change.trackId, existing);
    }

    for (const [trackId, trackChanges] of grouped) {
        try {
            const updateObj: Record<string, unknown> = {};
            for (const change of trackChanges) {
                // Map field name to appropriate type
                if (change.field === "bpm") {
                    updateObj.bpm = parseFloat(change.newValue);
                } else if (change.field === "year") {
                    updateObj.year = parseInt(change.newValue, 10);
                } else {
                    updateObj[change.field] = change.newValue;
                }
            }

            updateObj.analyzedAt = new Date().toISOString();

            await db.update(tracks).set(updateObj).where(eq(tracks.id, trackId));
            applied += trackChanges.length;
        } catch {
            errorCount += trackChanges.length;
        }
    }

    return { applied, errors: errorCount };
}
