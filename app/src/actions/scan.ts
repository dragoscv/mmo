"use server";

import { db } from "@/db";
import { tracks, scanLogs } from "@/db/schema";
import { scanFolder } from "@/lib/scanner";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function scanFolderAction(folderPath: string) {
    const result = await scanFolder(folderPath, true);

    let inserted = 0;
    let skipped = 0;

    for (const track of result.tracks) {
        try {
            // Check if track already exists
            const existing = db
                .select()
                .from(tracks)
                .where(eq(tracks.filepath, track.filepath))
                .get();

            if (existing) {
                skipped++;
                continue;
            }

            db.insert(tracks).values(track).run();
            inserted++;

            db.insert(scanLogs)
                .values({
                    action: "added",
                    filepath: track.filepath,
                    details: `Scanned: ${track.artist || "Unknown"} - ${track.title || track.filename}`,
                })
                .run();
        } catch {
            result.errors.push(`DB insert failed for: ${track.filepath}`);
        }
    }

    revalidatePath("/");
    revalidatePath("/library");
    revalidatePath("/scanner");

    return {
        totalFiles: result.totalFiles,
        audioFiles: result.audioFiles,
        inserted,
        skipped,
        errors: result.errors,
    };
}

export async function getRecentScans(limit: number = 20) {
    return db
        .select()
        .from(scanLogs)
        .orderBy(sql`${scanLogs.scannedAt} DESC`)
        .limit(limit)
        .all();
}
