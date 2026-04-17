import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { db } from "@/db";
import { tracks, scanLogs, downloads } from "@/db/schema";
import { eq, like } from "drizzle-orm";
import { readAudioMetadata } from "@/lib/audio";
import { fetchAllMetadata } from "@/lib/metadata-services";
import NodeID3 from "node-id3";

// ─── Write source info to ID3 tags ──────────────────────────────────────

function writeSourceToID3(filePath: string, sourceUrl?: string, sourcePlatform?: string) {
    if (!sourceUrl && !sourcePlatform) return;
    const ext = path.extname(filePath).toLowerCase();
    // node-id3 only supports mp3
    if (ext !== ".mp3") return;

    try {
        const existing = NodeID3.read(filePath);
        const tags: NodeID3.Tags = {};

        // Write source URL to WOAF (Official Audio File URL) and comment
        if (sourceUrl) {
            tags.fileUrl = sourceUrl;
            tags.userDefinedUrl = [{ description: "Source URL", url: sourceUrl }];
            // Only set comment if not already set by yt-dlp
            if (!existing.comment?.text) {
                tags.comment = { language: "eng", text: sourceUrl };
            }
        }

        // Write platform to publisher field
        if (sourcePlatform) {
            tags.publisher = sourcePlatform;
        }

        // Use update to preserve existing tags
        NodeID3.update(tags, filePath);
    } catch {
        // ID3 write failure is non-fatal
    }
}

// ─── Variant detection & linking ─────────────────────────────────────────

const VARIANT_KEYWORDS = [
    "remix", "radio edit", "radio version", "extended mix", "extended version",
    "original mix", "club mix", "dub mix", "instrumental", "acoustic",
    "vip mix", "vip", "bootleg", "rework", "remaster", "remastered",
    "live", "live version", "edit", "flip", "mashup", "mash-up",
    "acapella", "a cappella", "stripped",
];

function extractBaseTitle(title: string): string {
    let base = title.toLowerCase().trim();
    base = base.replace(/[\(\[][^\)\]]*(?:remix|radio edit|radio version|extended|original mix|club mix|dub mix|instrumental|acoustic|vip|bootleg|rework|remaster|live|edit|flip|mashup|mash-up|acapella|a cappella|stripped)[^\)\]]*[\)\]]/gi, "");
    base = base.replace(/\s*[-–—]\s*(?:radio edit|radio version|extended mix|extended version|original mix|club mix|dub mix|instrumental|acoustic|vip mix|vip|bootleg|rework|remaster|remastered|live|live version|edit|flip|mashup|mash-up|acapella|a cappella|stripped)\s*$/i, "");
    base = base.replace(/\s+/g, " ").trim();
    return base;
}

function isVariantTitle(title: string): boolean {
    const lower = title.toLowerCase();
    return VARIANT_KEYWORDS.some(kw => lower.includes(kw));
}

function linkVariantTrack(trackId: number, title?: string | null, artist?: string | null): void {
    if (!title) return;
    if (!isVariantTitle(title)) return;

    const baseTitle = extractBaseTitle(title);
    if (!baseTitle || baseTitle.length < 2) return;

    try {
        const searchPattern = `%${baseTitle.replace(/[%_]/g, "")}%`;
        const candidates = db
            .select({ id: tracks.id, title: tracks.title, artist: tracks.artist })
            .from(tracks)
            .where(like(tracks.title, searchPattern))
            .limit(20)
            .all();

        for (const candidate of candidates) {
            if (candidate.id === trackId) continue;

            const candidateBase = extractBaseTitle(candidate.title || "");
            if (candidateBase !== baseTitle) continue;

            // Check artist overlap if both are available
            if (artist && candidate.artist) {
                const artistLower = artist.toLowerCase();
                const candidateArtistLower = candidate.artist.toLowerCase();
                if (!artistLower.includes(candidateArtistLower) && !candidateArtistLower.includes(artistLower)) {
                    continue;
                }
            }

            // Found a match — link this track as a variant of the candidate
            db.update(tracks).set({ relatedTrackId: candidate.id }).where(eq(tracks.id, trackId)).run();
            return;
        }
    } catch {
        // Non-fatal
    }
}

// ─── Analyze & add a single file ────────────────────────────────────────

async function addSingleFile(filePath: string, downloadId?: number, sourceInfo?: {
    sourceUrl?: string;
    sourcePlatform?: string;
    sourceId?: string;
}): Promise<{
    success: boolean;
    trackId?: number;
    track?: Record<string, unknown>;
    error?: string;
    alreadyExists?: boolean;
}> {
    const resolved = path.resolve(filePath);

    if (!fs.existsSync(resolved)) {
        return { success: false, error: "File not found" };
    }

    // Check if already in library
    const existing = db.select().from(tracks).where(eq(tracks.filepath, resolved)).get();
    if (existing) {
        if (downloadId) {
            db.update(downloads).set({ status: "added", trackId: existing.id }).where(eq(downloads.id, downloadId)).run();
        }
        return { success: true, trackId: existing.id, alreadyExists: true };
    }

    // Parse metadata
    const trackData = await readAudioMetadata(resolved);
    if (!trackData) {
        return { success: false, error: "Failed to read audio metadata" };
    }

    // Resolve source info from download record if not provided
    let srcUrl = sourceInfo?.sourceUrl;
    let srcPlatform = sourceInfo?.sourcePlatform;
    let srcId = sourceInfo?.sourceId;
    if ((!srcUrl || !srcPlatform) && downloadId) {
        const dlRecord = db.select().from(downloads).where(eq(downloads.id, downloadId)).get();
        if (dlRecord) {
            srcUrl = srcUrl || dlRecord.url || undefined;
            srcPlatform = srcPlatform || dlRecord.extractor || undefined;
        }
    }

    const result = db.insert(tracks).values({
        ...trackData,
        sourceUrl: srcUrl || null,
        sourcePlatform: srcPlatform || null,
        sourceId: srcId || null,
    }).run();
    const trackId = Number(result.lastInsertRowid);

    // Check if this is a variant (remix, radio edit, etc.) of an existing track
    linkVariantTrack(trackId, trackData.title, trackData.artist);

    db.insert(scanLogs).values({
        action: "added",
        filepath: resolved,
        details: `Downloaded: ${trackData.artist || "Unknown"} - ${trackData.title}`,
    }).run();

    // Write source info to file ID3 tags
    writeSourceToID3(resolved, srcUrl, srcPlatform);

    if (downloadId) {
        db.update(downloads).set({ status: "added", trackId }).where(eq(downloads.id, downloadId)).run();
    }

    // Run full metadata analysis (artwork, BPM, lyrics, genre, etc.)
    const artist = trackData.artist;
    const title = trackData.title;
    if (artist && title) {
        try {
            const metadata = await fetchAllMetadata(
                artist, title,
                trackData.album || null,
                trackData.duration || null,
                { metadata: true, artwork: true, lyrics: true, bpmKey: true }
            );

            const updates: Record<string, unknown> = {};
            if (metadata.artworkUrl) updates.artworkUrl = metadata.artworkUrl;
            if (metadata.genre) updates.genre = metadata.genre;
            if (metadata.album && !trackData.album) updates.album = metadata.album;
            if (metadata.year) updates.year = metadata.year;
            if (metadata.label) updates.label = metadata.label;
            if (metadata.bpm && !trackData.bpm) updates.bpm = metadata.bpm;
            if (metadata.isrc) updates.isrc = metadata.isrc;
            if (metadata.lyrics) updates.lyrics = metadata.lyrics;
            if (metadata.syncedLyrics) updates.syncedLyrics = metadata.syncedLyrics;
            if (metadata.musicbrainzId) updates.musicbrainzId = metadata.musicbrainzId;
            if (metadata.releaseMbid) updates.releaseMbid = metadata.releaseMbid;

            if (Object.keys(updates).length > 0) {
                updates.analyzedAt = new Date().toISOString();
                db.update(tracks).set(updates).where(eq(tracks.id, trackId)).run();
            }
        } catch {
            // Analysis failure is non-fatal
        }
    }

    const finalTrack = db.select().from(tracks).where(eq(tracks.id, trackId)).get();
    return { success: true, trackId, track: finalTrack as unknown as Record<string, unknown> };
}

// ─── Route Handler ────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();

        // Batch mode
        if (body.files && Array.isArray(body.files)) {
            const results: { filePath: string; success: boolean; trackId?: number; error?: string; alreadyExists?: boolean }[] = [];

            for (const file of body.files) {
                try {
                    const res = await addSingleFile(file.filePath, file.downloadId, {
                        sourceUrl: file.sourceUrl,
                        sourcePlatform: file.sourcePlatform,
                        sourceId: file.sourceId,
                    });
                    results.push({
                        filePath: file.filePath,
                        success: res.success,
                        trackId: res.trackId,
                        error: res.error,
                        alreadyExists: res.alreadyExists,
                    });
                } catch (err) {
                    results.push({
                        filePath: file.filePath,
                        success: false,
                        error: err instanceof Error ? err.message : "Unknown error",
                    });
                }
            }

            const added = results.filter(r => r.success && !r.alreadyExists).length;
            const existing = results.filter(r => r.alreadyExists).length;
            const failed = results.filter(r => !r.success).length;

            return NextResponse.json({ success: true, added, existing, failed, results });
        }

        // Single file mode (backward compatible)
        const { filePath, downloadId, sourceUrl, sourcePlatform, sourceId } = body as {
            filePath?: string; downloadId?: number;
            sourceUrl?: string; sourcePlatform?: string; sourceId?: string;
        };

        if (!filePath || typeof filePath !== "string") {
            return NextResponse.json({ error: "Missing file path" }, { status: 400 });
        }

        const result = await addSingleFile(filePath, downloadId, { sourceUrl, sourcePlatform, sourceId });

        if (!result.success) {
            return NextResponse.json({ error: result.error }, { status: 500 });
        }

        if (result.alreadyExists) {
            return NextResponse.json({ error: "Track already in library", trackId: result.trackId }, { status: 409 });
        }

        return NextResponse.json({ success: true, trackId: result.trackId, track: result.track });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
