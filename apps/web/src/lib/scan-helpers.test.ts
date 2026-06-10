/**
 * Tests for `bucketGrowth` — the deterministic core of the dashboard
 * library-growth chart. Decoupled from the companion / network layer
 * so we can lock down the bucketing math without any mocks.
 */
import { describe, it, expect } from "vitest";
import { bucketGrowth } from "./scan-helpers";

const FIXED_NOW = new Date("2025-01-30T12:00:00Z");

describe("bucketGrowth", () => {
    it("pre-seeds the requested window with zeros", () => {
        const out = bucketGrowth([], 7, FIXED_NOW);
        expect(out).toHaveLength(7);
        expect(out.every((d) => d.added === 0)).toBe(true);
    });

    it("returns oldest day first, newest day last", () => {
        const out = bucketGrowth([], 5, FIXED_NOW);
        expect(out[0].date).toBe("2025-01-26");
        expect(out[out.length - 1].date).toBe("2025-01-30");
    });

    it("counts only entries with action === 'added'", () => {
        const out = bucketGrowth(
            [
                { action: "added", scannedAt: "2025-01-30T08:00:00Z" },
                { action: "removed", scannedAt: "2025-01-30T09:00:00Z" },
                { action: "updated", scannedAt: "2025-01-30T10:00:00Z" },
            ],
            7,
            FIXED_NOW,
        );
        const today = out.find((d) => d.date === "2025-01-30")!;
        expect(today.added).toBe(1);
    });

    it("ignores entries with null scannedAt", () => {
        const out = bucketGrowth(
            [
                { action: "added", scannedAt: null },
                { action: "added", scannedAt: "2025-01-30T08:00:00Z" },
            ],
            7,
            FIXED_NOW,
        );
        const today = out.find((d) => d.date === "2025-01-30")!;
        expect(today.added).toBe(1);
    });

    it("drops entries older than the requested window", () => {
        const out = bucketGrowth(
            [
                { action: "added", scannedAt: "2024-12-01T08:00:00Z" }, // way out of window
                { action: "added", scannedAt: "2025-01-29T08:00:00Z" }, // in window
            ],
            7,
            FIXED_NOW,
        );
        const total = out.reduce((acc, d) => acc + d.added, 0);
        expect(total).toBe(1);
    });

    it("aggregates multiple entries into the same day bucket", () => {
        const out = bucketGrowth(
            [
                { action: "added", scannedAt: "2025-01-28T01:00:00Z" },
                { action: "added", scannedAt: "2025-01-28T05:00:00Z" },
                { action: "added", scannedAt: "2025-01-28T23:59:00Z" },
            ],
            7,
            FIXED_NOW,
        );
        const that = out.find((d) => d.date === "2025-01-28")!;
        expect(that.added).toBe(3);
    });

    it("handles a 30-day default-style window without duplicates", () => {
        const out = bucketGrowth([], 30, FIXED_NOW);
        const dates = new Set(out.map((d) => d.date));
        expect(dates.size).toBe(30);
        expect(out).toHaveLength(30);
    });
});
