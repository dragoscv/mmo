import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tracks, downloads } from "@/db/schema";
import { or, eq, and, like, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";

interface CheckItem {
    id: string;       // playlist entry id
    title: string;
    uploader?: string;
    url?: string;
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const items: CheckItem[] = body?.items;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return NextResponse.json({ duplicates: {} });
        }

        const duplicates: Record<string, { trackId: number; reason: string; filePath?: string; downloadId?: number }> = {};

        // 1. Check by source URL in tracks table
        const urls = items.map(i => i.url).filter(Boolean) as string[];
        if (urls.length > 0) {
            const bySourceUrl = db
                .select({ id: tracks.id, sourceUrl: tracks.sourceUrl, filepath: tracks.filepath })
                .from(tracks)
                .where(inArray(tracks.sourceUrl, urls))
                .all();

            for (const row of bySourceUrl) {
                const item = items.find(i => i.url === row.sourceUrl);
                if (item) {
                    duplicates[item.id] = { trackId: row.id, reason: "Source URL match — in library", filePath: row.filepath };
                }
            }
        }

        // 2. Check by source URL in downloads table (status = 'added' or 'complete')
        if (urls.length > 0) {
            const byDownloadUrl = db
                .select({
                    id: downloads.id,
                    url: downloads.url,
                    trackId: downloads.trackId,
                    status: downloads.status,
                    filePath: downloads.filePath,
                })
                .from(downloads)
                .where(and(
                    inArray(downloads.url, urls),
                    or(eq(downloads.status, "added"), eq(downloads.status, "complete"))
                ))
                .all();

            for (const row of byDownloadUrl) {
                const item = items.find(i => i.url === row.url);
                if (item && !duplicates[item.id]) {
                    duplicates[item.id] = {
                        trackId: row.trackId || 0,
                        reason: row.status === "added" ? "Already downloaded & in library" : "Already downloaded",
                        filePath: row.filePath || undefined,
                        downloadId: row.id,
                    };
                }
            }
        }

        // 3. Check by source ID in tracks table
        const sourceIds = items.map(i => i.id).filter(Boolean);
        if (sourceIds.length > 0) {
            const bySourceId = db
                .select({ id: tracks.id, sourceId: tracks.sourceId, filepath: tracks.filepath })
                .from(tracks)
                .where(inArray(tracks.sourceId, sourceIds))
                .all();

            for (const row of bySourceId) {
                const item = items.find(i => i.id === row.sourceId);
                if (item && !duplicates[item.id]) {
                    duplicates[item.id] = { trackId: row.id, reason: "Source ID match — in library", filePath: row.filepath };
                }
            }
        }

        // 4. Fuzzy match by title (for items not yet matched)
        const unmatched = items.filter(i => !duplicates[i.id]);
        for (const item of unmatched) {
            if (!item.title) continue;
            // Normalize title for comparison
            const normalizedTitle = item.title.trim().toLowerCase();
            if (normalizedTitle.length < 3) continue;

            // Search by similar title using LIKE
            const matches = db
                .select({ id: tracks.id, title: tracks.title, artist: tracks.artist })
                .from(tracks)
                .where(like(tracks.title, `%${normalizedTitle.replace(/[%_]/g, "")}%`))
                .limit(5)
                .all();

            for (const match of matches) {
                const matchTitle = (match.title || "").toLowerCase();
                const matchArtist = (match.artist || "").toLowerCase();
                const uploaderLower = (item.uploader || "").toLowerCase();

                // Exact title match
                if (matchTitle === normalizedTitle) {
                    duplicates[item.id] = { trackId: match.id, reason: "Title match — in library" };
                    break;
                }

                // Title contains and artist/uploader overlaps
                if (uploaderLower && matchArtist &&
                    (matchArtist.includes(uploaderLower) || uploaderLower.includes(matchArtist))) {
                    duplicates[item.id] = { trackId: match.id, reason: "Title + artist match — in library" };
                    break;
                }
            }
        }

        // 5. Also check download history for pending/downloading entries (to avoid double-downloads)
        const stillUnmatched = items.filter(i => !duplicates[i.id]);
        if (stillUnmatched.length > 0) {
            const pendingUrls = stillUnmatched.map(i => i.url).filter(Boolean) as string[];
            if (pendingUrls.length > 0) {
                const pending = db
                    .select({ url: downloads.url, status: downloads.status })
                    .from(downloads)
                    .where(and(
                        inArray(downloads.url, pendingUrls),
                        eq(downloads.status, "downloading")
                    ))
                    .all();

                for (const row of pending) {
                    const item = stillUnmatched.find(i => i.url === row.url);
                    if (item) {
                        duplicates[item.id] = { trackId: 0, reason: "Currently downloading" };
                    }
                }
            }
        }

        return NextResponse.json({
            duplicates,
            checkedCount: items.length,
            duplicateCount: Object.keys(duplicates).length,
        });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Check failed" },
            { status: 500 }
        );
    }
}
