"use server";

import { log } from "@/lib/logger";

/**
 * Folder scan → ingest into companion library DB.
 *
 * The scanning itself still runs in this Node process via @/lib/scanner
 * (it walks the filesystem the web server has access to). The resulting
 * track rows are pushed to the companion's /library/tracks/ingest
 * endpoint instead of the local SQLite. Scan logs also live on the
 * companion now.
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { scanFolder } from "@/lib/scanner";
import {
    companionLibrary,
    getCompanionLink,
    type ScanLogEntry,
} from "@/lib/companion-library";

export interface ScanResult {
    totalFiles: number;
    audioFiles: number;
    inserted: number;
    skipped: number;
    errors: string[];
}

export async function scanFolderAction(folderPath: string): Promise<ScanResult> {
    // Auth required: `scanFolder` walks the *web-app host's* filesystem with
    // `fs.readdir`, recursively. Without a session check this was an
    // arbitrary-directory enumeration primitive against the host (try
    // `/etc`, `C:\\Users\\Public`, etc.) returning file counts and
    // surfacing parse errors that leak filenames.
    const session = await auth();
    if (!session?.user?.id) {
        return {
            totalFiles: 0, audioFiles: 0, inserted: 0, skipped: 0,
            errors: ["Not authenticated"],
        };
    }
    const link = await getCompanionLink();
    if (!link) {
        return {
            totalFiles: 0, audioFiles: 0, inserted: 0, skipped: 0,
            errors: ["No companion connected. Sign in and link a companion to scan folders."],
        };
    }

    const result = await scanFolder(folderPath, true);
    const errors = [...result.errors];

    let inserted = 0;
    let skipped = 0;

    if (result.tracks.length > 0) {
        try {
            const r = await companionLibrary.ingestTracks(link, result.tracks);
            inserted = r.inserted;
            skipped = r.skipped;
        } catch (err) {
            errors.push(`Companion ingest failed: ${err instanceof Error ? err.message : "unknown"}`);
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
        errors,
    };
}

export async function getRecentScans(limit = 20): Promise<ScanLogEntry[]> {
    const link = await getCompanionLink();
    if (!link) return [];
    try { return await companionLibrary.getScanLogs(link, limit); }
    catch (err) {
        log.warn("scan.getRecentScans failed", undefined, err);
        return [];
    }
}

/** Aggregate the recent scan log into a per-day "tracks added" series
 *  for the dashboard growth chart. The companion exposes the latest 200
 *  log rows, which on a typical library covers a few weeks; we bucket
 *  by local day and pad missing days with 0 so the chart x-axis stays
 *  continuous. Returns oldest-first. */
export async function getLibraryGrowth(
    days: number = 30,
): Promise<Array<{ date: string; added: number }>> {
    const link = await getCompanionLink();
    if (!link) return [];
    try {
        const logs = await companionLibrary.getScanLogs(link, 200);
        const buckets = new Map<string, number>();
        const now = new Date();
        // Pre-seed the last `days` days at zero so the chart shows the
        // full requested window even when there's been no recent activity.
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            buckets.set(d.toISOString().slice(0, 10), 0);
        }
        for (const entry of logs) {
            if (entry.action !== "added" || !entry.scannedAt) continue;
            const day = entry.scannedAt.slice(0, 10); // YYYY-MM-DD
            if (!buckets.has(day)) continue; // Older than the window — skip.
            buckets.set(day, (buckets.get(day) ?? 0) + 1);
        }
        return Array.from(buckets.entries()).map(([date, added]) => ({ date, added }));
    } catch (err) {
        log.warn("scan.getLibraryGrowth failed", undefined, err);
        return [];
    }
}
