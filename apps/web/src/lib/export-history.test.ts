/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
    diffExport,
    getExportSnapshot,
    recordExportSnapshot,
    getExportDiff,
} from "./export-history";

describe("diffExport (pure)", () => {
    it("treats no-previous as full add", () => {
        const d = diffExport(null, [1, 2, 3]);
        expect(d.added).toEqual([1, 2, 3]);
        expect(d.removed).toEqual([]);
        expect(d.unchanged).toEqual([]);
        expect(d.hasPrevious).toBe(false);
        expect(d.previousAt).toBeNull();
    });

    it("partitions into added / removed / unchanged", () => {
        const d = diffExport(
            { trackIds: [1, 2, 3, 4], exportedAt: "2025-01-01T00:00:00Z" },
            [2, 3, 5, 6],
        );
        expect(d.added.sort()).toEqual([5, 6]);
        expect(d.removed.sort()).toEqual([1, 4]);
        expect(d.unchanged.sort()).toEqual([2, 3]);
        expect(d.hasPrevious).toBe(true);
        expect(d.previousAt).toBe("2025-01-01T00:00:00Z");
    });

    it("empty current with previous = full removed", () => {
        const d = diffExport(
            { trackIds: [1, 2, 3], exportedAt: "2025-01-01T00:00:00Z" },
            [],
        );
        expect(d.added).toEqual([]);
        expect(d.removed.sort()).toEqual([1, 2, 3]);
        expect(d.unchanged).toEqual([]);
    });

    it("identical sets = all unchanged", () => {
        const d = diffExport(
            { trackIds: [1, 2, 3], exportedAt: "2025-01-01T00:00:00Z" },
            [1, 2, 3],
        );
        expect(d.added).toEqual([]);
        expect(d.removed).toEqual([]);
        expect(d.unchanged.sort()).toEqual([1, 2, 3]);
    });
});

describe("export-history (localStorage round-trip)", () => {
    beforeEach(() => {
        // jsdom localStorage is shared across tests in the file; reset it.
        window.localStorage.clear();
    });

    it("round-trips a snapshot", () => {
        recordExportSnapshot("xml", 42, [10, 20, 30]);
        const snap = getExportSnapshot("xml", 42);
        expect(snap?.trackIds).toEqual([10, 20, 30]);
        expect(snap?.exportedAt).toMatch(/T.*Z$/);
    });

    it("scopes by format", () => {
        recordExportSnapshot("xml", 1, [1, 2]);
        recordExportSnapshot("crate", 1, [3, 4]);
        expect(getExportSnapshot("xml", 1)?.trackIds).toEqual([1, 2]);
        expect(getExportSnapshot("crate", 1)?.trackIds).toEqual([3, 4]);
    });

    it("getExportDiff against a recorded snapshot is identical to diffExport", () => {
        recordExportSnapshot("xml", 7, [1, 2, 3]);
        const d = getExportDiff("xml", 7, [2, 3, 4]);
        expect(d.added).toEqual([4]);
        expect(d.removed).toEqual([1]);
        expect(d.unchanged.sort()).toEqual([2, 3]);
        expect(d.hasPrevious).toBe(true);
    });

    it("returns hasPrevious=false when no snapshot exists yet", () => {
        const d = getExportDiff("xml", 999, [1, 2]);
        expect(d.hasPrevious).toBe(false);
        expect(d.added).toEqual([1, 2]);
    });

    it("survives malformed JSON in storage by falling back to empty", () => {
        window.localStorage.setItem("mmo:export-history:xml", "{not json");
        const snap = getExportSnapshot("xml", 1);
        expect(snap).toBeNull();
    });

    it("filters out malformed entries inside an otherwise valid map", () => {
        window.localStorage.setItem(
            "mmo:export-history:xml",
            JSON.stringify({
                "1": { trackIds: [1, 2], exportedAt: "2025-01-01T00:00:00Z" },
                "2": { trackIds: ["bad"], exportedAt: "2025-01-01T00:00:00Z" },
                "3": "not an object",
            }),
        );
        expect(getExportSnapshot("xml", 1)?.trackIds).toEqual([1, 2]);
        expect(getExportSnapshot("xml", 2)).toBeNull();
        expect(getExportSnapshot("xml", 3)).toBeNull();
    });
});
