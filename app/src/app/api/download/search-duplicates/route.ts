import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { like } from "drizzle-orm";

/** Variant keywords that indicate a version of a track */
const VARIANT_KEYWORDS = [
    "remix", "radio edit", "radio version", "extended mix", "extended version",
    "original mix", "club mix", "dub mix", "instrumental", "acoustic",
    "vip mix", "vip", "bootleg", "rework", "remaster", "remastered",
    "live", "live version", "edit", "flip", "mashup", "mash-up",
    "acapella", "a cappella", "stripped",
];

/** 
 * Extract the "base title" by removing variant suffixes/parentheticals.
 * e.g. "Levels (Radio Edit)" → "levels"
 *      "Greyhound - Extended Mix" → "greyhound"
 */
function extractBaseTitle(title: string): string {
    let base = title.toLowerCase().trim();

    // Remove common parenthetical/bracket suffixes: (Radio Edit), [Extended Mix], etc.
    base = base.replace(/[\(\[][^\)\]]*(?:remix|radio edit|radio version|extended|original mix|club mix|dub mix|instrumental|acoustic|vip|bootleg|rework|remaster|live|edit|flip|mashup|mash-up|acapella|a cappella|stripped)[^\)\]]*[\)\]]/gi, "");

    // Remove dash-separated suffixes: " - Radio Edit", " - Extended Mix"
    base = base.replace(/\s*[-–—]\s*(?:radio edit|radio version|extended mix|extended version|original mix|club mix|dub mix|instrumental|acoustic|vip mix|vip|bootleg|rework|remaster|remastered|live|live version|edit|flip|mashup|mash-up|acapella|a cappella|stripped)\s*$/i, "");

    // Clean up extra whitespace
    base = base.replace(/\s+/g, " ").trim();

    return base;
}

/** Check if a title contains any variant keyword */
function isVariantTitle(title: string): boolean {
    const lower = title.toLowerCase();
    return VARIANT_KEYWORDS.some(kw => lower.includes(kw));
}

interface SearchDupeItem {
    id: string;
    title: string;
    uploader?: string;
}

export interface SearchDupeResult {
    /** Exact or near-exact duplicate in library */
    inLibrary?: { trackId: number; title: string; artist: string };
    /** This search result is a variant (remix/edit/etc.) of a track in library */
    isVariantOf?: { trackId: number; title: string; artist: string };
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const items: SearchDupeItem[] = body?.items;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return NextResponse.json({ results: {} });
        }

        const results: Record<string, SearchDupeResult> = {};

        // Get all unique base titles for searching
        const searchTerms = new Map<string, SearchDupeItem[]>();
        for (const item of items) {
            if (!item.title || item.title.trim().length < 2) continue;
            const base = extractBaseTitle(item.title);
            if (base.length < 2) continue;
            const existing = searchTerms.get(base) || [];
            existing.push(item);
            searchTerms.set(base, existing);
        }

        // For each unique base title, search the library
        for (const [baseTitle, matchItems] of searchTerms) {
            // Use LIKE to find potential matches (searches by base title)
            const searchPattern = `%${baseTitle.replace(/[%_]/g, "")}%`;
            const dbMatches = db
                .select({
                    id: tracks.id,
                    title: tracks.title,
                    artist: tracks.artist,
                })
                .from(tracks)
                .where(like(tracks.title, searchPattern))
                .limit(20)
                .all();

            if (dbMatches.length === 0) continue;

            for (const item of matchItems) {
                const itemTitleLower = item.title.toLowerCase().trim();
                const itemUploaderLower = (item.uploader || "").toLowerCase();
                const itemIsVariant = isVariantTitle(item.title);

                for (const match of dbMatches) {
                    const matchTitleLower = (match.title || "").toLowerCase().trim();
                    const matchArtistLower = (match.artist || "").toLowerCase();
                    const matchBaseTitle = extractBaseTitle(match.title || "");

                    // Check artist overlap (at least one direction)
                    const artistOverlap = !itemUploaderLower || !matchArtistLower ||
                        matchArtistLower.includes(itemUploaderLower) ||
                        itemUploaderLower.includes(matchArtistLower);

                    // Exact title match = duplicate
                    if (matchTitleLower === itemTitleLower && artistOverlap) {
                        results[item.id] = {
                            inLibrary: { trackId: match.id, title: match.title || "", artist: match.artist || "" },
                        };
                        break;
                    }

                    // If search result is a variant and base title matches a library track
                    if (itemIsVariant && matchBaseTitle === baseTitle && artistOverlap) {
                        // The search result is a variant (e.g. "Song - Radio Edit")
                        // and the library has the base version (e.g. "Song")
                        if (!results[item.id]?.inLibrary) {
                            results[item.id] = {
                                ...results[item.id],
                                isVariantOf: { trackId: match.id, title: match.title || "", artist: match.artist || "" },
                            };
                        }
                    }

                    // If library track is a variant but search result is the "clean" version
                    if (!itemIsVariant && isVariantTitle(match.title || "") && matchBaseTitle === baseTitle && artistOverlap) {
                        // We have the variant in library, search result is the original — still mark as in library (close match)
                        if (!results[item.id]) {
                            results[item.id] = {
                                isVariantOf: { trackId: match.id, title: match.title || "", artist: match.artist || "" },
                            };
                        }
                    }
                }
            }
        }

        return NextResponse.json({ results });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Check failed" },
            { status: 500 },
        );
    }
}
