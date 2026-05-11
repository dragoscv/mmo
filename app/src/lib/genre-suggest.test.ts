import { describe, it, expect } from "vitest";
import {
    suggestGenre,
    musicalKeyToCamelot,
    camelotToMusicalKey,
    getHarmonicScore,
    getCompatibleKeys,
} from "./genre-suggest";

describe("suggestGenre", () => {
    it("classifies high-BPM bands", () => {
        expect(suggestGenre(155)).toBe("Bounce");
        expect(suggestGenre(146)).toBe("Psytrance");
        expect(suggestGenre(132)).toBe("Techno");
        expect(suggestGenre(123)).toBe("Tech House");
    });

    it("falls back to 'Other' below tech-house threshold", () => {
        expect(suggestGenre(100)).toBe("Other");
        expect(suggestGenre(80)).toBe("Other");
    });
});

describe("musicalKeyToCamelot", () => {
    it("maps major + minor key strings", () => {
        expect(musicalKeyToCamelot("Am")).toBe("8A");
        expect(musicalKeyToCamelot("C")).toBe("8B");
        expect(musicalKeyToCamelot("F#m")).toBe("11A");
    });

    it("normalises 'Major' / 'minor' suffixes", () => {
        expect(musicalKeyToCamelot("A minor")).toBe("8A");
        expect(musicalKeyToCamelot("C major")).toBe("8B");
    });

    it("rejects unknown keys with null", () => {
        expect(musicalKeyToCamelot("Hm")).toBeNull();
        expect(musicalKeyToCamelot("")).toBeNull();
    });

    it("round-trips through camelotToMusicalKey", () => {
        expect(camelotToMusicalKey("8A")).toBe("Am");
        expect(camelotToMusicalKey("8B")).toBe("C");
    });
});

describe("getHarmonicScore", () => {
    it("returns 0 for identical keys, 1 for relative maj/min", () => {
        expect(getHarmonicScore("8A", "8A")).toBe(0);
        expect(getHarmonicScore("8A", "8B")).toBe(1);
    });

    it("returns 1 for adjacent same-letter keys (perfect fifth)", () => {
        expect(getHarmonicScore("8A", "9A")).toBe(1);
        expect(getHarmonicScore("8A", "7A")).toBe(1);
    });

    it("returns 3 (clash) for distant unrelated keys", () => {
        expect(getHarmonicScore("1A", "6B")).toBe(3);
    });

    it("returns -1 when input is missing or malformed", () => {
        expect(getHarmonicScore(null, "8A")).toBe(-1);
        expect(getHarmonicScore("8A", "nope")).toBe(-1);
    });
});

describe("getCompatibleKeys", () => {
    it("includes self, relative, and adjacent fifths", () => {
        const compat = getCompatibleKeys("8A");
        expect(compat).toContain("8A");
        expect(compat).toContain("8B");
        expect(compat).toContain("9A");
        expect(compat).toContain("7A");
    });

    it("wraps around 12→1 on the wheel", () => {
        const compat = getCompatibleKeys("12A");
        expect(compat).toContain("1A");
    });

    it("returns [] for malformed input", () => {
        expect(getCompatibleKeys("nope")).toEqual([]);
    });
});
