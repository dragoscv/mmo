"use server";

import { db } from "@/db";
import { tracks, scanLogs, settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { moveTrackToGenreFolder } from "@/lib/organizer";
import { revalidatePath } from "next/cache";

export async function organizeTrack(trackId: number, genre: string) {
    const track = db.select().from(tracks).where(eq(tracks.id, trackId)).get();
    if (!track) return { success: false, error: "Track not found" };

    // Get music root and genre folders from settings
    const musicRootSetting = db
        .select()
        .from(settings)
        .where(eq(settings.key, "music_root"))
        .get();
    const genreFoldersSetting = db
        .select()
        .from(settings)
        .where(eq(settings.key, "genre_folders"))
        .get();

    const musicRoot = musicRootSetting?.value || "H:\\Music";
    const genreFolders: Record<string, string> = genreFoldersSetting?.value
        ? JSON.parse(genreFoldersSetting.value)
        : {};

    const targetFolder = genreFolders[genre] || `DJ/${genre}`;
    const result = moveTrackToGenreFolder(track.filepath, musicRoot, targetFolder);

    if (result.success) {
        // Update track in DB
        db.update(tracks)
            .set({
                filepath: result.newPath,
                filename: result.newPath.split(/[\\/]/).pop() || track.filename,
                genre,
                isProcessed: true,
            })
            .where(eq(tracks.id, trackId))
            .run();

        db.insert(scanLogs)
            .values({
                action: "moved",
                filepath: result.newPath,
                details: `Moved to ${targetFolder}: ${track.artist || "Unknown"} - ${track.title || track.filename}`,
            })
            .run();

        revalidatePath("/library");
        revalidatePath("/scanner");
        revalidatePath("/");
    }

    return result;
}

export async function organizeMultipleTracks(
    trackIds: number[],
    genre: string
) {
    const results = [];
    for (const id of trackIds) {
        const result = await organizeTrack(id, genre);
        results.push({ id, ...result });
    }
    return results;
}
