"use server";

import { db } from "@/db";
import { tracks } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
    searchRecordings,
    lookupRecording,
    extractMetadata,
    getArtworkUrl,
    type TrackMetadata,
} from "@/lib/musicbrainz";
import { fetchAllMetadata, getLyrics } from "@/lib/metadata-services";

export interface MetadataSearchResult {
    id: string;
    title: string;
    artist: string;
    album?: string;
    label?: string;
    year?: number;
    score: number;
    releaseMbid?: string;
    artworkUrl?: string;
    tags?: string[];
}

export async function searchTrackMetadata(
    artist: string,
    title: string
): Promise<MetadataSearchResult[]> {
    const recordings = await searchRecordings(artist, title, 8);

    const results: MetadataSearchResult[] = [];
    for (const rec of recordings) {
        const meta = extractMetadata(rec);
        results.push({
            id: rec.id,
            title: rec.title,
            artist: meta.artist || "",
            album: meta.album,
            label: meta.label,
            year: meta.year,
            score: rec.score,
            releaseMbid: meta.releaseMbid,
            tags: meta.tags,
        });
    }

    return results;
}

export async function fetchAndApplyMetadata(
    trackId: number,
    mbRecordingId: string,
    fieldsToApply: string[]
): Promise<{ success: boolean; applied: TrackMetadata }> {
    const recording = await lookupRecording(mbRecordingId);
    if (!recording) {
        return { success: false, applied: {} };
    }

    const meta = extractMetadata(recording);

    // Fetch artwork if release MBID available
    if (meta.releaseMbid) {
        const artUrl = await getArtworkUrl(meta.releaseMbid);
        if (artUrl) meta.artworkUrl = artUrl;
    }

    // Build update object based on selected fields
    const update: Record<string, unknown> = {};
    if (fieldsToApply.includes("title") && meta.title) update.title = meta.title;
    if (fieldsToApply.includes("artist") && meta.artist)
        update.artist = meta.artist;
    if (fieldsToApply.includes("album") && meta.album) update.album = meta.album;
    if (fieldsToApply.includes("label") && meta.label) update.label = meta.label;
    if (fieldsToApply.includes("year") && meta.year) update.year = meta.year;
    if (fieldsToApply.includes("genre") && meta.genre) update.genre = meta.genre;
    if (fieldsToApply.includes("artwork") && meta.artworkUrl)
        update.artworkUrl = meta.artworkUrl;
    if (fieldsToApply.includes("tags") && meta.tags)
        update.tags = JSON.stringify(meta.tags);

    // Always store MusicBrainz IDs
    update.musicbrainzId = meta.musicbrainzId;
    if (meta.releaseMbid) update.releaseMbid = meta.releaseMbid;

    if (Object.keys(update).length > 0) {
        await db.update(tracks).set(update).where(eq(tracks.id, trackId));
    }

    return { success: true, applied: meta };
}

export async function fetchArtworkForTrack(
    trackId: number,
    releaseMbid: string
): Promise<{ success: boolean; artworkUrl?: string }> {
    const artUrl = await getArtworkUrl(releaseMbid);
    if (!artUrl) return { success: false };

    await db
        .update(tracks)
        .set({ artworkUrl: artUrl, releaseMbid })
        .where(eq(tracks.id, trackId));

    return { success: true, artworkUrl: artUrl };
}

// ─── Reanalysis ──────────────────────────────────────────────────────────────

export interface ReanalysisField {
    field: string;
    label: string;
    current: string | null;
    found: string;
    rawValue: string;
    source: string;
    isNew: boolean;
}

export async function reanalyzeSingleTrack(trackId: number): Promise<{
    fields: ReanalysisField[];
    errors: string[];
}> {
    const [track] = await db
        .select()
        .from(tracks)
        .where(eq(tracks.id, trackId))
        .limit(1);
    if (!track) return { fields: [], errors: ["Track not found"] };

    try {
        const metadata = await fetchAllMetadata(
            track.artist || "",
            track.title || track.filename,
            track.album || null,
            track.duration || null,
            { metadata: true, artwork: true, lyrics: true, bpmKey: true }
        );

        const fields: ReanalysisField[] = [];

        const push = (
            field: string,
            label: string,
            found: string | number | null,
            current: string | null,
            sourceKey: string,
            displayOverride?: string
        ) => {
            if (found == null) return;
            const raw = String(found);
            fields.push({
                field,
                label,
                current,
                found: displayOverride || raw,
                rawValue: raw,
                source: metadata.sources[sourceKey] || "Multiple sources",
                isNew: !current,
            });
        };

        push("artist", "Artist", metadata.artist, track.artist, "artist");
        push("title", "Title", metadata.title, track.title, "title");
        push("album", "Album", metadata.album, track.album, "album");
        push(
            "year",
            "Year",
            metadata.year,
            track.year?.toString() || null,
            "year"
        );
        push("label", "Label", metadata.label, track.label, "label");
        push("genre", "Genre", metadata.genre, track.genre, "genre");
        push(
            "bpm",
            "BPM",
            metadata.bpm,
            track.bpm?.toString() || null,
            "bpm"
        );
        push("isrc", "ISRC", metadata.isrc, track.isrc, "isrc");
        push(
            "artworkUrl",
            "Artwork",
            metadata.artworkUrl,
            track.artworkUrl ? "Has artwork" : null,
            "artworkUrl",
            "Found artwork"
        );
        push(
            "lyrics",
            "Lyrics",
            metadata.lyrics,
            track.lyrics ? "Has lyrics" : null,
            "lyrics",
            `Found lyrics (${metadata.lyrics?.split("\n").length || 0} lines)`
        );
        push(
            "syncedLyrics",
            "Synced Lyrics",
            metadata.syncedLyrics,
            track.syncedLyrics ? "Has synced lyrics" : null,
            "syncedLyrics",
            "Found synced lyrics"
        );
        if (metadata.musicbrainzId) {
            push(
                "musicbrainzId",
                "MusicBrainz ID",
                metadata.musicbrainzId,
                track.musicbrainzId,
                "musicbrainzId"
            );
        }
        if (metadata.releaseMbid) {
            push(
                "releaseMbid",
                "Release MBID",
                metadata.releaseMbid,
                track.releaseMbid,
                "releaseMbid"
            );
        }

        return { fields, errors: [] };
    } catch (error) {
        return {
            fields: [],
            errors: [error instanceof Error ? error.message : String(error)],
        };
    }
}

export async function applyReanalysisFields(
    trackId: number,
    fieldsToApply: Record<string, string>
): Promise<{ success: boolean; applied: number }> {
    const ALLOWED = new Set([
        "artist",
        "title",
        "album",
        "year",
        "label",
        "genre",
        "bpm",
        "isrc",
        "artworkUrl",
        "lyrics",
        "syncedLyrics",
        "musicbrainzId",
        "releaseMbid",
    ]);

    const update: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(fieldsToApply)) {
        if (!ALLOWED.has(field)) continue;
        if (field === "year") {
            update[field] = parseInt(value);
        } else if (field === "bpm") {
            update[field] = parseFloat(value);
        } else {
            update[field] = value;
        }
    }

    update.analyzedAt = new Date().toISOString();

    if (Object.keys(update).length > 1) {
        await db.update(tracks).set(update).where(eq(tracks.id, trackId));
    }

    return { success: true, applied: Object.keys(fieldsToApply).length };
}

// ─── Lyrics ──────────────────────────────────────────────────────────────────

export async function fetchLyricsForTrack(trackId: number): Promise<{
    success: boolean;
    plainLyrics: string | null;
    syncedLyrics: string | null;
}> {
    const [track] = await db
        .select()
        .from(tracks)
        .where(eq(tracks.id, trackId))
        .limit(1);
    if (!track)
        return { success: false, plainLyrics: null, syncedLyrics: null };

    try {
        const result = await getLyrics(
            track.artist || "",
            track.title || track.filename,
            track.album,
            track.duration
        );

        if (!result || (!result.plainLyrics && !result.syncedLyrics)) {
            return { success: false, plainLyrics: null, syncedLyrics: null };
        }

        const update: Record<string, unknown> = {};
        if (result.plainLyrics) update.lyrics = result.plainLyrics;
        if (result.syncedLyrics) update.syncedLyrics = result.syncedLyrics;

        if (Object.keys(update).length > 0) {
            await db
                .update(tracks)
                .set(update)
                .where(eq(tracks.id, trackId));
        }

        return {
            success: true,
            plainLyrics: result.plainLyrics,
            syncedLyrics: result.syncedLyrics,
        };
    } catch {
        return { success: false, plainLyrics: null, syncedLyrics: null };
    }
}
