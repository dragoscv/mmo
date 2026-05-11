"use server";

/**
 * Move a track on disk into a per-genre folder, then update the
 * companion's library row to reflect the new path. Filesystem move is
 * still done from this Node process (the web app has direct access to
 * the user's drives via @/lib/organizer); only the DB write is proxied.
 */

import { revalidatePath } from "next/cache";
import { moveTrackToGenreFolder } from "@/lib/organizer";
import { companionLibrary, getCompanionLink } from "@/lib/companion-library";
import { getSetting } from "@/actions/settings";

/** Strip path-traversal characters from a single folder segment. We reject
 *  anything that would escape the configured `musicRoot` (`..`, `/`, `\\`,
 *  drive letters, leading `~`) before it reaches `path.join`. Result is at
 *  most 100 chars and always a single safe folder name. */
function sanitizeGenreSegment(raw: string): string {
    return raw
        .normalize("NFKC")
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
        .replace(/\.\.+/g, "")
        .replace(/^[~.\s]+|[\s.]+$/g, "")
        .slice(0, 100)
        .trim();
}

export async function organizeTrack(trackId: number, genre: string) {
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };

    // Path-traversal guard: `genre` previously flowed straight into
    // `targetFolder = genreFolders[genre] || \`DJ/${genre}\`` and then into
    // `moveTrackToGenreFolder`, which path.joins it under `musicRoot`. A
    // crafted value like `../../../Users/Public` would move tracks out of
    // the configured library root entirely. The override map (`genreFolders`)
    // is admin-configured server-side, so we only sanitise the unmapped
    // path; the mapped one is trusted.
    const sanitizedGenre = sanitizeGenreSegment(genre);
    if (!sanitizedGenre) return { success: false, error: "Invalid genre name" };

    const track = await companionLibrary.getTrackById(link, trackId);
    if (!track) return { success: false, error: "Track not found" };

    const musicRoot = (await getSetting("music_root")) || "H:\\Music";
    let genreFolders: Record<string, string> = {};
    try {
        const raw = await getSetting("genre_folders");
        if (raw) genreFolders = JSON.parse(raw);
    } catch { /* ignore */ }

    const targetFolder = genreFolders[genre] || `DJ/${sanitizedGenre}`;
    const result = moveTrackToGenreFolder(track.filepath, musicRoot, targetFolder);

    if (result.success) {
        await companionLibrary.updateTrack(link, trackId, {
            filepath: result.newPath,
            filename: result.newPath.split(/[\\/]/).pop() || track.filename,
            genre,
            isProcessed: true,
        });
        revalidatePath("/library");
        revalidatePath("/scanner");
        revalidatePath("/");
    }

    return result;
}

export async function organizeMultipleTracks(
    trackIds: number[],
    genre: string,
): Promise<{ moved: number; errors: number }> {
    // Bound the loop. Each call does a companion fetch + filesystem move +
    // companion update; an unbounded array is a multi-second DoS primitive
    // against the user's companion + own disk. 1000 is well above any
    // realistic bulk-organise selection size.
    const MAX_BULK = 1000;
    if (!Array.isArray(trackIds)) return { moved: 0, errors: 0 };
    const ids = trackIds.slice(0, MAX_BULK).filter((n) => Number.isInteger(n) && n > 0);
    let moved = 0;
    let errors = 0;
    for (const id of ids) {
        try {
            const r = await organizeTrack(id, genre);
            if (r.success) moved++;
            else errors++;
        } catch {
            errors++;
        }
    }
    return { moved, errors };
}
