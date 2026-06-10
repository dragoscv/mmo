"use server";

/**
 * Export the user's full library as a rekordbox-compatible XML.
 * Tracks are pulled from the companion in pages, then grouped by genre
 * for the playlists section.
 */

import fs from "node:fs";
import path from "node:path";
import { auth } from "@/auth";
import { generateRekordboxXml } from "@/lib/rekordbox-xml";
import { companionLibrary, getCompanionLink } from "@/lib/companion-library";

export async function exportRekordboxXml(outputPath?: string) {
    // Auth required: action accepts a caller-supplied `outputPath` and writes
    // the entire library XML there via `fs.mkdirSync` + `fs.writeFileSync`.
    // Without an auth gate this is an unauthenticated arbitrary-file-write
    // primitive (and unauthenticated full-library exfiltration via choosing
    // a path under `public/` that the web server serves back).
    const session = await auth();
    if (!session?.user?.id) {
        return {
            success: false,
            error: "Not authenticated",
            outputPath: null,
            count: 0,
        };
    }
    const link = await getCompanionLink();
    if (!link) {
        return {
            success: false,
            error: "Companion not connected",
            outputPath: null,
            count: 0,
        };
    }

    // Pull all tracks (paged). Cap at 100k to keep memory bounded.
    const PAGE = 1000;
    const MAX = 100_000;
    const all: Awaited<ReturnType<typeof companionLibrary.getTracks>>["tracks"] = [];
    let page = 1;
    while (all.length < MAX) {
        const r = await companionLibrary.getTracks(link, {
            page, pageSize: PAGE, sort: "genre", order: "asc",
        });
        all.push(...r.tracks);
        if (page >= r.totalPages || r.tracks.length === 0) break;
        page++;
    }

    const genreMap = new Map<string, number[]>();
    for (const t of all) {
        const g = t.genre || "Uncategorized";
        if (!genreMap.has(g)) genreMap.set(g, []);
        genreMap.get(g)!.push(t.id);
    }
    const playlists = Array.from(genreMap.entries()).map(([name, trackIds]) => ({
        name, trackIds,
    }));

    // generateRekordboxXml expects the legacy Track shape; cast carefully.
    const xml = generateRekordboxXml(all as unknown as Parameters<typeof generateRekordboxXml>[0], playlists);

    const output = outputPath || path.join(process.cwd(), "data", "rekordbox-export.xml");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, xml, "utf-8");

    return { success: true, outputPath: output, count: all.length };
}
