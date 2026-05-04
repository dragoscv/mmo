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

export async function organizeTrack(trackId: number, genre: string) {
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };

    const track = await companionLibrary.getTrackById(link, trackId);
    if (!track) return { success: false, error: "Track not found" };

    const musicRoot = (await getSetting("music_root")) || "H:\\Music";
    let genreFolders: Record<string, string> = {};
    try {
        const raw = await getSetting("genre_folders");
        if (raw) genreFolders = JSON.parse(raw);
    } catch { /* ignore */ }

    const targetFolder = genreFolders[genre] || `DJ/${genre}`;
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
    let moved = 0;
    let errors = 0;
    for (const id of trackIds) {
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
