import { describe, it, expect } from "vitest";
import { cn, formatDuration, formatNumber, formatBytes, formatKey, getHarmonicColor } from "./utils";

describe("cn", () => {
    it("merges tailwind class lists, last write wins", () => {
        expect(cn("p-2", "p-4")).toBe("p-4");
        expect(cn("text-red-500", undefined, "font-bold")).toBe("text-red-500 font-bold");
    });

    it("handles conditional clsx-style entries", () => {
        expect(cn("base", { active: true, hidden: false })).toBe("base active");
    });
});

describe("formatDuration", () => {
    it("renders mm:ss padded", () => {
        expect(formatDuration(5)).toBe("0:05");
        expect(formatDuration(65)).toBe("1:05");
        expect(formatDuration(3725)).toBe("62:05");
    });

    it("returns em-dash on null/undefined/0", () => {
        expect(formatDuration()).toBe("—");
        expect(formatDuration(null)).toBe("—");
        expect(formatDuration(0)).toBe("—");
    });
});

describe("formatNumber", () => {
    it("uses en-US thousand separators", () => {
        expect(formatNumber(1234)).toBe("1,234");
        expect(formatNumber(1234567)).toBe("1,234,567");
    });
});

describe("formatBytes", () => {
    it("scales to KB / MB / GB", () => {
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(1024)).toBe("1 KB");
        expect(formatBytes(1536)).toBe("1.5 KB");
        expect(formatBytes(1024 * 1024)).toBe("1 MB");
        expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB");
    });
});

describe("formatKey", () => {
    it("returns em-dash when no key", () => {
        expect(formatKey()).toBe("—");
        expect(formatKey(null)).toBe("—");
    });

    it("returns raw camelot when no notation requested", () => {
        expect(formatKey("8A")).toBe("8A");
    });

    it("translates to anglo+solfège when notations array passed", () => {
        // formatKey delegates to note-notation.ts, where 1A is Am.
        expect(formatKey("1A", ["anglo", "solfege"])).toBe("A / La");
    });
});

describe("getHarmonicColor", () => {
    it("greens identical keys and relative maj/min", () => {
        expect(getHarmonicColor("8A", "8A")).toContain("green");
        expect(getHarmonicColor("8A", "8B")).toContain("green");
    });

    it("yellows adjacent same-letter keys (and 12↔1 wrap)", () => {
        expect(getHarmonicColor("8A", "9A")).toContain("yellow");
        expect(getHarmonicColor("12A", "1A")).toContain("yellow");
    });

    it("reds clashing keys", () => {
        expect(getHarmonicColor("1A", "6B")).toContain("red");
    });

    it("returns empty string when either side is missing", () => {
        expect(getHarmonicColor(null, "8A")).toBe("");
        expect(getHarmonicColor("8A", null)).toBe("");
    });
});
