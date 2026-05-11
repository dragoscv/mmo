/**
 * GET /api/export/rekordbox?scope=all|playlist&playlistId=N
 *
 * Streams a rekordbox-compatible `DJ_PLAYLISTS` XML for the user's
 * library. Auth is enforced by `getCompanionLink()`. The XML is
 * generated in-memory and capped at 100k tracks.
 *
 * Optional querystring:
 *   - `scope=playlist` + `playlistId=N` — export a single playlist
 *   - `groupBy=genre|none` — for `scope=all` only; default `genre`
 */

import { NextResponse } from "next/server";
import { generateRekordboxXml } from "@/lib/rekordbox-xml";
import { companionLibrary, getCompanionLink, type CompanionTrack } from "@/lib/companion-library";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

const MAX = 100_000;
const PAGE = 1000;

async function fetchAllTracks(link: NonNullable<Awaited<ReturnType<typeof getCompanionLink>>>): Promise<CompanionTrack[]> {
    const all: CompanionTrack[] = [];
    let page = 1;
    while (all.length < MAX) {
        const r = await companionLibrary.getTracks(link, { page, pageSize: PAGE, sort: "genre", order: "asc" });
        all.push(...r.tracks);
        if (page >= r.totalPages || r.tracks.length === 0) break;
        page++;
    }
    return all;
}

export async function GET(req: Request) {
    const link = await getCompanionLink();
    if (!link) {
        return NextResponse.json({ error: "Companion not connected" }, { status: 401 });
    }
    const url = new URL(req.url);
    const scope = url.searchParams.get("scope") ?? "all";
    const groupBy = url.searchParams.get("groupBy") ?? "genre";

    let tracks: CompanionTrack[] = [];
    let playlists: { name: string; trackIds: number[] }[] = [];
    let filenameSuffix = "library";

    try {
        if (scope === "playlist") {
            const playlistId = Number(url.searchParams.get("playlistId"));
            if (!Number.isInteger(playlistId) || playlistId <= 0) {
                return NextResponse.json({ error: "Invalid playlistId" }, { status: 400 });
            }
            const summary = (await companionLibrary.getPlaylists(link)).find((p) => p.id === playlistId);
            if (!summary) return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
            // Fetch all pages of the playlist's tracks (capped at MAX).
            let page = 1;
            while (tracks.length < MAX) {
                const r = await companionLibrary.getPlaylistTracks(link, playlistId, page, PAGE);
                tracks.push(...r.tracks);
                if (page >= r.totalPages || r.tracks.length === 0) break;
                page++;
            }
            playlists = [{ name: summary.name, trackIds: tracks.map((t) => t.id) }];
            filenameSuffix = sanitizeFilename(summary.name) || `playlist-${playlistId}`;
        } else {
            tracks = await fetchAllTracks(link);
            if (groupBy === "genre") {
                const map = new Map<string, number[]>();
                for (const t of tracks) {
                    const g = t.genre || "Uncategorized";
                    if (!map.has(g)) map.set(g, []);
                    map.get(g)!.push(t.id);
                }
                playlists = Array.from(map.entries()).map(([name, trackIds]) => ({ name, trackIds }));
            }
        }
    } catch (err) {
        log.error("export.rekordbox failed", err, { scope });
        return NextResponse.json({ error: err instanceof Error ? err.message : "Export failed" }, { status: 500 });
    }

    const xml = generateRekordboxXml(
        tracks as unknown as Parameters<typeof generateRekordboxXml>[0],
        playlists,
    );

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `mmo-rekordbox-${filenameSuffix}-${stamp}.xml`;

    return new NextResponse(xml, {
        status: 200,
        headers: {
            "content-type": "application/xml; charset=utf-8",
            "content-disposition": `attachment; filename="${filename}"`,
            "cache-control": "no-store",
        },
    });
}

function sanitizeFilename(input: string): string {
    return input.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).toLowerCase();
}
