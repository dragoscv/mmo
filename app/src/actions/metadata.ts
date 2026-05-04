"use server";

/**
 * Track-level metadata enrichment (MusicBrainz lookup, lyrics, artwork).
 * Reads/writes go through the companion library; the third-party HTTP
 * lookups themselves still happen here on the web app server.
 */

import {
    searchRecordings,
    lookupRecording,
    extractMetadata,
    getArtworkUrl,
    type TrackMetadata,
} from "@/lib/musicbrainz";
import { fetchAllMetadata, getLyrics } from "@/lib/metadata-services";
import { companionLibrary, getCompanionLink, type CompanionTrack } from "@/lib/companion-library";

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
    title: string,
): Promise<MetadataSearchResult[]> {
    const recordings = await searchRecordings(artist, title, 8);
    return recordings.map((rec) => {
        const meta = extractMetadata(rec);
        return {
            id: rec.id,
            title: rec.title,
            artist: meta.artist || "",
            album: meta.album,
            label: meta.label,
            year: meta.year,
            score: rec.score,
            releaseMbid: meta.releaseMbid,
            tags: meta.tags,
        };
    });
}

export async function fetchAndApplyMetadata(
    trackId: number,
    mbRecordingId: string,
    fieldsToApply: string[],
): Promise<{ success: boolean; applied: TrackMetadata }> {
    const link = await getCompanionLink();
    if (!link) return { success: false, applied: {} };

    const recording = await lookupRecording(mbRecordingId);
    if (!recording) return { success: false, applied: {} };

    const meta = extractMetadata(recording);

    if (meta.releaseMbid) {
        const artUrl = await getArtworkUrl(meta.releaseMbid);
        if (artUrl) meta.artworkUrl = artUrl;
    }

    const update: Partial<CompanionTrack> = {};
    const u = update as Record<string, unknown>;
    if (fieldsToApply.includes("title") && meta.title) u.title = meta.title;
    if (fieldsToApply.includes("artist") && meta.artist) u.artist = meta.artist;
    if (fieldsToApply.includes("album") && meta.album) u.album = meta.album;
    if (fieldsToApply.includes("label") && meta.label) u.label = meta.label;
    if (fieldsToApply.includes("year") && meta.year) u.year = meta.year;
    if (fieldsToApply.includes("genre") && meta.genre) u.genre = meta.genre;
    if (fieldsToApply.includes("artwork") && meta.artworkUrl) u.artworkUrl = meta.artworkUrl;
    if (fieldsToApply.includes("tags") && meta.tags) u.tags = JSON.stringify(meta.tags);

    u.musicbrainzId = meta.musicbrainzId;
    if (meta.releaseMbid) u.releaseMbid = meta.releaseMbid;

    if (Object.keys(u).length > 0) {
        await companionLibrary.updateTrack(link, trackId, update);
    }
    return { success: true, applied: meta };
}

export async function fetchArtworkForTrack(
    trackId: number,
    releaseMbid: string,
): Promise<{ success: boolean; artworkUrl?: string }> {
    const link = await getCompanionLink();
    if (!link) return { success: false };

    const artUrl = await getArtworkUrl(releaseMbid);
    if (!artUrl) return { success: false };

    await companionLibrary.updateTrack(link, trackId, { artworkUrl: artUrl, releaseMbid });
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
    const link = await getCompanionLink();
    if (!link) return { fields: [], errors: ["Companion not connected"] };

    const track = await companionLibrary.getTrackById(link, trackId);
    if (!track) return { fields: [], errors: ["Track not found"] };

    try {
        const metadata = await fetchAllMetadata(
            track.artist || "",
            track.title || track.filename,
            track.album || null,
            track.duration || null,
            { metadata: true, artwork: true, lyrics: true, bpmKey: true },
        );

        const fields: ReanalysisField[] = [];
        const push = (
            field: string, label: string,
            found: string | number | null,
            current: string | null, sourceKey: string,
            displayOverride?: string,
        ) => {
            if (found == null) return;
            const raw = String(found);
            fields.push({
                field, label, current,
                found: displayOverride || raw,
                rawValue: raw,
                source: metadata.sources[sourceKey] || "Multiple sources",
                isNew: !current,
            });
        };

        push("artist", "Artist", metadata.artist, track.artist, "artist");
        push("title", "Title", metadata.title, track.title, "title");
        push("album", "Album", metadata.album, track.album, "album");
        push("year", "Year", metadata.year, track.year?.toString() || null, "year");
        push("label", "Label", metadata.label, track.label, "label");
        push("genre", "Genre", metadata.genre, track.genre, "genre");
        push("bpm", "BPM", metadata.bpm, track.bpm?.toString() || null, "bpm");
        push("isrc", "ISRC", metadata.isrc, track.isrc, "isrc");
        push("artworkUrl", "Artwork", metadata.artworkUrl,
            track.artworkUrl ? "Has artwork" : null, "artworkUrl", "Found artwork");
        push("lyrics", "Lyrics", metadata.lyrics,
            track.lyrics ? "Has lyrics" : null, "lyrics",
            `Found lyrics (${metadata.lyrics?.split("\n").length || 0} lines)`);
        push("syncedLyrics", "Synced Lyrics", metadata.syncedLyrics,
            track.syncedLyrics ? "Has synced lyrics" : null, "syncedLyrics", "Found synced lyrics");
        if (metadata.musicbrainzId)
            push("musicbrainzId", "MusicBrainz ID", metadata.musicbrainzId, track.musicbrainzId, "musicbrainzId");
        if (metadata.releaseMbid)
            push("releaseMbid", "Release MBID", metadata.releaseMbid, track.releaseMbid, "releaseMbid");

        return { fields, errors: [] };
    } catch (error) {
        return { fields: [], errors: [error instanceof Error ? error.message : String(error)] };
    }
}

export async function applyReanalysisFields(
    trackId: number,
    fieldsToApply: Record<string, string>,
): Promise<{ success: boolean; applied: number }> {
    const link = await getCompanionLink();
    if (!link) return { success: false, applied: 0 };

    const ALLOWED = new Set([
        "artist", "title", "album", "year", "label", "genre", "bpm",
        "isrc", "artworkUrl", "lyrics", "syncedLyrics", "musicbrainzId", "releaseMbid",
    ]);

    const update: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(fieldsToApply)) {
        if (!ALLOWED.has(field)) continue;
        if (field === "year") update[field] = parseInt(value, 10);
        else if (field === "bpm") update[field] = parseFloat(value);
        else update[field] = value;
    }
    update.analyzedAt = new Date().toISOString();

    if (Object.keys(update).length > 1) {
        await companionLibrary.updateTrack(link, trackId, update as Partial<CompanionTrack>);
    }
    return { success: true, applied: Object.keys(fieldsToApply).length };
}

// ─── Lyrics ──────────────────────────────────────────────────────────────────

export async function fetchLyricsForTrack(trackId: number): Promise<{
    success: boolean;
    plainLyrics: string | null;
    syncedLyrics: string | null;
}> {
    const link = await getCompanionLink();
    if (!link) return { success: false, plainLyrics: null, syncedLyrics: null };

    const track = await companionLibrary.getTrackById(link, trackId);
    if (!track) return { success: false, plainLyrics: null, syncedLyrics: null };

    try {
        const result = await getLyrics(
            track.artist || "",
            track.title || track.filename,
            track.album,
            track.duration,
        );
        if (!result || (!result.plainLyrics && !result.syncedLyrics)) {
            return { success: false, plainLyrics: null, syncedLyrics: null };
        }
        const update: Partial<CompanionTrack> = {};
        if (result.plainLyrics) update.lyrics = result.plainLyrics;
        if (result.syncedLyrics) update.syncedLyrics = result.syncedLyrics;
        if (Object.keys(update).length > 0) {
            await companionLibrary.updateTrack(link, trackId, update);
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
