/**
 * Pure-helper unit tests for `lib/duplicates-helpers.ts`.
 *
 * Locks down the heuristics that drive the duplicates pipeline:
 * `normaliseString`, `durationBucket`, `quality`. These deserve
 * coverage because a future refactor of the heuristic could silently
 * change which copy is picked as the "keeper" or which candidates
 * collapse into the same fuzzy bucket.
 */
import { describe, it, expect } from "vitest";
import {
    normaliseString,
    durationBucket,
    quality,
    type DuplicateTrackBasic,
} from "./duplicates-helpers";

function track(over: Partial<DuplicateTrackBasic> = {}): DuplicateTrackBasic {
    return {
        bitrate: 320,
        format: "mp3",
        rating: 0,
        addedAt: null,
        ...over,
    };
}

describe("normaliseString", () => {
    it("returns empty for nullish input", () => {
        expect(normaliseString(null)).toBe("");
        expect(normaliseString(undefined)).toBe("");
        expect(normaliseString("")).toBe("");
    });

    it("lowercases and strips diacritics", () => {
        expect(normaliseString("Călin Mănăilă")).toBe("calin manaila");
    });

    it("drops bracketed annotations", () => {
        expect(normaliseString("Sandstorm (Original Mix)")).toBe("sandstorm");
        expect(normaliseString("Track [Remix] Name")).toBe("track name");
    });

    it("drops dash-separated suffixes", () => {
        expect(normaliseString("Song Name - Radio Edit")).toBe("song name");
        expect(normaliseString("Song Name - Extended Mix")).toBe("song name");
    });

    it("collapses non-alphanumerics to single spaces", () => {
        expect(normaliseString("a!@#b   c")).toBe("a b c");
    });

    it("matches across casing/punctuation differences", () => {
        // The whole point: two titles that should collide in the fuzzy bucket.
        expect(normaliseString("CHARLOTTE DE WITTE - Doppler"))
            .toBe(normaliseString("charlotte.de.witte - doppler"));
    });
});

describe("durationBucket", () => {
    it("returns '0' for nullish or non-positive durations", () => {
        expect(durationBucket(null)).toBe("0");
        expect(durationBucket(0)).toBe("0");
        expect(durationBucket(-5)).toBe("0");
    });

    it("rounds to the nearest 5-second bucket", () => {
        expect(durationBucket(200)).toBe("40");   // 200/5 = 40
        expect(durationBucket(201)).toBe("40");   // 40.2 → 40
        expect(durationBucket(203)).toBe("41");   // 40.6 → 41
    });

    it("groups close durations into the same bucket", () => {
        // 200 vs 202 vs 198 — all within ~5s → same bucket.
        const a = durationBucket(200);
        const b = durationBucket(202);
        const c = durationBucket(198);
        expect(a).toBe(b);
        expect(a).toBe(c);
    });
});

describe("quality", () => {
    it("prefers higher bitrate", () => {
        const lo = track({ bitrate: 192 });
        const hi = track({ bitrate: 320 });
        expect(quality(hi)).toBeGreaterThan(quality(lo));
    });

    it("strongly prefers lossless formats", () => {
        const lossy = track({ bitrate: 320, format: "mp3" });
        const flac = track({ bitrate: 1000, format: "flac" });
        // Lossless +5000 dwarfs the bitrate gap.
        expect(quality(flac)).toBeGreaterThan(quality(lossy));
    });

    it("recognises wav / aiff / alac as lossless", () => {
        const mp3 = track({ format: "mp3" });
        for (const fmt of ["wav", "aiff", "alac", "FLAC", "ALAC"]) {
            const lossless = track({ format: fmt, bitrate: 0 });
            expect(quality(lossless)).toBeGreaterThan(quality(mp3));
        }
    });

    it("uses rating as a tiebreaker (~100 per star)", () => {
        const a = track({ bitrate: 320, rating: 5 });
        const b = track({ bitrate: 320, rating: 0 });
        expect(quality(a) - quality(b)).toBe(500);
    });

    it("breaks ties by recency when addedAt is set", () => {
        const newer = track({ bitrate: 320, addedAt: new Date().toISOString() });
        const older = track({ bitrate: 320, addedAt: "2010-01-01T00:00:00Z" });
        expect(quality(newer)).toBeGreaterThan(quality(older));
    });

    it("handles all-null fields without throwing", () => {
        const empty = track({
            bitrate: null,
            format: null,
            rating: null,
            addedAt: null,
        });
        expect(quality(empty)).toBe(0);
    });
});
