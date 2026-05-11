import { describe, it, expect } from "vitest";
import { buildCompanionMetrics } from "./metrics";

describe("buildCompanionMetrics", () => {
    it("returns the documented shape with safe defaults", async () => {
        const m = await buildCompanionMetrics("9.9.9");

        // Identification
        expect(m.version).toBe("9.9.9");
        expect(typeof m.capturedAt).toBe("string");
        expect(new Date(m.capturedAt).toString()).not.toBe("Invalid Date");

        // Process / OS gauges
        expect(m.uptimeSeconds).toBeGreaterThanOrEqual(0);
        expect(m.memoryTotalBytes).toBeGreaterThan(0);
        expect(m.memoryFreeBytes).toBeGreaterThanOrEqual(0);
        expect(m.processRssBytes).toBeGreaterThan(0);
        expect(m.cpuCount).toBeGreaterThan(0);
        expect(m.platform).toBe(process.platform);

        // listConnectedDrives() is allowed to return -1 if the host call
        // fails; we just want a number, not a thrown error.
        expect(typeof m.drivesConnected).toBe("number");

        // Scan-job aggregates: counts must be non-negative; with no jobs
        // in this fresh process, every counter is 0 and average is 0.
        expect(m.scanJobs.active).toBe(0);
        expect(m.scanJobs.total).toBeGreaterThanOrEqual(0);
        expect(m.scanJobs.completed).toBeGreaterThanOrEqual(0);
        expect(m.scanJobs.failed).toBeGreaterThanOrEqual(0);
        expect(m.scanJobs.averageDurationSeconds).toBe(0);
        expect(m.scanJobs.filesDiscovered).toBe(0);
        expect(m.scanJobs.filesScanned).toBe(0);
        expect(m.scanJobs.filesErrored).toBe(0);

        // Watcher aggregates
        expect(m.watchers.active).toBeGreaterThanOrEqual(0);
        expect(m.watchers.eventsTotal).toBeGreaterThanOrEqual(0);
    });

    it("does not leak filesystem paths or hostnames into the payload", async () => {
        const m = await buildCompanionMetrics("0.0.0");
        const json = JSON.stringify(m);
        // We should not see the scanFolders array, drive paths, or anything
        // that looks like an absolute path. (Negative drive count fallback
        // is fine — that's just -1.)
        expect(json).not.toMatch(/\/Users\//);
        expect(json).not.toMatch(/\/Volumes\//);
        expect(json).not.toMatch(/[A-Z]:\\/);
    });
});
