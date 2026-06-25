"use server";

/**
 * Unified, companion-side scan orchestrator (multi-companion aware).
 *
 * Replaces the legacy `scanFolderAction` which walked the WEB-APP HOST's
 * filesystem (broken on Vercel/Cloud Run → "Folder not found: H:\Music").
 *
 * The real scan runs ON the companion: POST /scan → poll /scan/jobs/:id
 * until complete → ingest the parsed tracks into the companion library →
 * ack. Every call targets a SPECIFIC deviceId so users with multiple
 * companions scan the right machine.
 */

import { auth } from "@/auth";
import { companionControl, type FolderKind } from "@/lib/companion-control";
import { startCompanionScan, ingestCompanionScanJob } from "@/actions/devices";
import { getAllCompanionLinks } from "@/lib/companion-library";

export interface ScanProgress {
    deviceId: string;
    jobId: string;
    status: string;
    discovered: number;
    scanned: number;
    errored: number;
    currentFile: string | null;
}

export interface ScanFinalResult {
    success: boolean;
    deviceId: string;
    folder: string;
    inserted: number;
    skipped: number;
    total: number;
    error?: string;
}

const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 1200; // ~30 min ceiling for very large folders

/**
 * Scan a folder on a specific companion and ingest the results. Polls the
 * companion's scan job to completion server-side, then ingests + acks.
 * Returns once the library has been populated (or on error).
 */
export async function scanAndIngestFolder(
    deviceId: string,
    folderPath: string,
    kind?: FolderKind,
): Promise<ScanFinalResult> {
    const session = await auth();
    if (!session?.user?.id) {
        return { success: false, deviceId, folder: folderPath, inserted: 0, skipped: 0, total: 0, error: "Not signed in" };
    }

    const started = await startCompanionScan(deviceId, folderPath, kind);
    if ("error" in started) {
        return { success: false, deviceId, folder: folderPath, inserted: 0, skipped: 0, total: 0, error: started.error };
    }
    const jobId = started.job.id;

    for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        let job;
        try {
            job = await companionControl.getScanJob(deviceId, jobId);
        } catch (e) {
            return { success: false, deviceId, folder: folderPath, inserted: 0, skipped: 0, total: 0, error: e instanceof Error ? e.message : String(e) };
        }
        if (job.status === "error") {
            return { success: false, deviceId, folder: folderPath, inserted: 0, skipped: 0, total: 0, error: job.error ?? "Scan failed on companion" };
        }
        if (job.status === "complete") {
            const ing = await ingestCompanionScanJob(deviceId, jobId);
            if ("error" in ing) {
                return { success: false, deviceId, folder: folderPath, inserted: 0, skipped: 0, total: 0, error: ing.error };
            }
            return { success: true, deviceId, folder: folderPath, inserted: ing.inserted, skipped: ing.skipped, total: ing.total };
        }
    }
    return { success: false, deviceId, folder: folderPath, inserted: 0, skipped: 0, total: 0, error: "Scan timed out" };
}

/** Poll a single in-flight job's progress (for live UI). */
export async function getScanProgress(deviceId: string, jobId: string): Promise<ScanProgress | { error: string }> {
    const session = await auth();
    if (!session?.user?.id) return { error: "Not signed in" };
    try {
        const job = await companionControl.getScanJob(deviceId, jobId);
        return {
            deviceId,
            jobId,
            status: job.status,
            discovered: job.discovered ?? 0,
            scanned: job.scanned ?? 0,
            errored: job.errored ?? 0,
            currentFile: job.currentFile ?? null,
        };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

/** Kick a scan and return the jobId immediately (non-blocking); the client
 *  polls getScanProgress, then calls ingestCompanionScanJob on completion. */
export async function beginScan(
    deviceId: string,
    folderPath: string,
    kind?: FolderKind,
): Promise<{ jobId: string } | { error: string }> {
    const session = await auth();
    if (!session?.user?.id) return { error: "Not signed in" };
    const started = await startCompanionScan(deviceId, folderPath, kind);
    if ("error" in started) return { error: started.error };
    return { jobId: started.job.id };
}

/** Scan EVERY watched folder across ALL of the user's online companions.
 *  Used by the Scanner "Scan everything" action. Sequential per folder to
 *  avoid hammering a single disk. */
export async function scanAllCompanions(): Promise<ScanFinalResult[]> {
    const session = await auth();
    if (!session?.user?.id) return [];
    const links = await getAllCompanionLinks();
    const out: ScanFinalResult[] = [];
    for (const link of links.filter((l) => l.online)) {
        let folders;
        try { folders = await companionControl.listFolders(link.deviceId); }
        catch { continue; }
        for (const f of folders) {
            out.push(await scanAndIngestFolder(link.deviceId, f.path, f.kind));
        }
    }
    return out;
}
