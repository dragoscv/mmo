import os from "node:os";
import { listAllScanJobs } from "./library/scan-jobs.js";
import { listWatcherStatuses } from "./library/watcher.js";
import { listConnectedDrives } from "./library/drives.js";

/**
 * Companion-internal metrics aggregator.
 *
 * Pure-ish snapshot builder: pulls live state from in-memory registries
 * (scan jobs, watchers) and a cross-platform syscall (drives) into a
 * flat counter/gauge object. Returned shape is JSON, **not** Prometheus
 * exposition format — this endpoint feeds the local web UI's "is the
 * companion healthy?" panel and our own debugging, not an external
 * scraper. Switching to Prometheus later is a one-page refactor if
 * needed.
 *
 * Why not Prometheus today? Prometheus assumes a pull model with a
 * scrape host that holds tokens; the companion runs on the user's
 * laptop behind device-token auth and there's nothing to scrape from.
 * The web app pulls JSON over the same authenticated channel as every
 * other companion call.
 *
 * No PII: drive paths and folder paths are NOT included. Only counts,
 * timestamps, and process-level metrics. The only borderline field is
 * the OS hostname, which is already exposed by `/info`.
 */

export interface CompanionMetrics {
    /** ISO timestamp the snapshot was built. */
    capturedAt: string;
    /** SemVer of the running companion. */
    version: string;
    /** Process uptime in seconds (whole number). */
    uptimeSeconds: number;
    /** OS-reported total memory in bytes. */
    memoryTotalBytes: number;
    /** OS-reported free memory in bytes. */
    memoryFreeBytes: number;
    /** Process RSS in bytes (Node measurement, not OS). */
    processRssBytes: number;
    /** Number of CPU cores reported by `os.cpus().length`. */
    cpuCount: number;
    /** Platform hint ("win32" | "darwin" | "linux"). */
    platform: NodeJS.Platform;
    /** Connected drive count from `listConnectedDrives()`. Excludes paths. */
    drivesConnected: number;
    /** Scan-job aggregates. */
    scanJobs: {
        /** Active = `pending|discovering|scanning`. */
        active: number;
        /** All-time recorded jobs in this process's memory (bounded by GC). */
        total: number;
        /** Jobs that finished (`complete`) since process start. */
        completed: number;
        /** Jobs that errored (`error`). */
        failed: number;
        /** Average scan duration in seconds across completed jobs (0 if none). */
        averageDurationSeconds: number;
        /** Sum of `discovered` files across completed jobs. */
        filesDiscovered: number;
        /** Sum of `scanned` files across completed jobs. */
        filesScanned: number;
        /** Sum of `errored` files across completed jobs. */
        filesErrored: number;
    };
    /** Watcher (chokidar) aggregates. */
    watchers: {
        /** Number of folders being watched. */
        active: number;
        /** Sum of `eventsSeen` across all watchers. */
        eventsTotal: number;
    };
}

export async function buildCompanionMetrics(version: string): Promise<CompanionMetrics> {
    const jobs = listAllScanJobs();
    const watchers = listWatcherStatuses();
    // listConnectedDrives shells out on Windows / macOS / Linux. Tolerate
    // failure (e.g. denied diskutil call on a freshly-locked Mac) so a
    // metrics scrape never propagates into a 500.
    let driveCount = 0;
    try {
        driveCount = (await listConnectedDrives()).length;
    } catch {
        driveCount = -1;
    }

    const completed = jobs.filter((j) => j.status === "complete");
    const failed = jobs.filter((j) => j.status === "error");
    const active = jobs.filter(
        (j) => j.status === "pending" || j.status === "discovering" || j.status === "scanning",
    );

    let totalDurationMs = 0;
    let durationSamples = 0;
    let discovered = 0;
    let scanned = 0;
    let errored = 0;
    for (const j of completed) {
        if (j.startedAt && j.finishedAt) {
            totalDurationMs += j.finishedAt - j.startedAt;
            durationSamples++;
        }
        discovered += j.discovered ?? 0;
        scanned += j.scanned ?? 0;
        errored += j.errored ?? 0;
    }
    const averageDurationSeconds =
        durationSamples > 0 ? Math.round((totalDurationMs / durationSamples) / 100) / 10 : 0;

    const eventsTotal = watchers.reduce((sum, w) => sum + (w.eventsSeen ?? 0), 0);

    const mem = process.memoryUsage();

    return {
        capturedAt: new Date().toISOString(),
        version,
        uptimeSeconds: Math.round(process.uptime()),
        memoryTotalBytes: os.totalmem(),
        memoryFreeBytes: os.freemem(),
        processRssBytes: mem.rss,
        cpuCount: os.cpus().length,
        platform: process.platform,
        drivesConnected: driveCount,
        scanJobs: {
            active: active.length,
            total: jobs.length,
            completed: completed.length,
            failed: failed.length,
            averageDurationSeconds,
            filesDiscovered: discovered,
            filesScanned: scanned,
            filesErrored: errored,
        },
        watchers: {
            active: watchers.filter((w) => w.active).length,
            eventsTotal,
        },
    };
}
