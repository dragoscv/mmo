import { describe, it, expect } from "vitest";
import {
    shiftKeyName,
    getKeyCompatibility,
    calculateTransitionScore,
    DEFAULT_DECK_STATE,
    BEAT_FX_TYPES,
    FILTER_TYPES,
    COLOR_FX_TYPES,
} from "./mixer-engine";

describe("mixer-engine pure functions", () => {
    describe("shiftKeyName", () => {
        it("shifts Camelot notation forward without crossing letter", () => {
            expect(shiftKeyName("8A", 0)).toBe("8A");
            expect(shiftKeyName("8A", 1)).toBe("9A");
            expect(shiftKeyName("11B", 1)).toBe("12B");
        });

        it("wraps Camelot notation across the 12 → 1 boundary", () => {
            expect(shiftKeyName("12A", 1)).toBe("1A");
            expect(shiftKeyName("1A", -1)).toBe("12A");
            expect(shiftKeyName("1A", -12)).toBe("1A");
            expect(shiftKeyName("8A", 12)).toBe("8A");
        });

        it("shifts standard notation preserving major/minor", () => {
            expect(shiftKeyName("C", 2)).toBe("D");
            expect(shiftKeyName("Cm", 2)).toBe("Dm");
            expect(shiftKeyName("F#", 1)).toBe("G");
            expect(shiftKeyName("B", 1)).toBe("C");
            expect(shiftKeyName("C", -1)).toBe("B");
        });

        it("returns input unchanged for empty or unparseable strings", () => {
            expect(shiftKeyName("", 5)).toBe("");
            expect(shiftKeyName("???", 3)).toBe("???");
        });
    });

    describe("getKeyCompatibility", () => {
        it("returns 'perfect' for identical keys", () => {
            expect(getKeyCompatibility("8A", "8A")).toBe("perfect");
        });

        it("returns 'compatible' when target is on the Camelot neighbour list", () => {
            // 8A's neighbours include 7A, 9A, 8B
            expect(getKeyCompatibility("8A", "7A")).toBe("compatible");
            expect(getKeyCompatibility("8A", "9A")).toBe("compatible");
            expect(getKeyCompatibility("8A", "8B")).toBe("compatible");
        });

        it("returns 'energy-boost' for +2 or +7 semitone jumps within the wheel", () => {
            expect(getKeyCompatibility("8A", "10A")).toBe("energy-boost");
        });

        it("returns 'clash' when the target is far away on the wheel", () => {
            expect(getKeyCompatibility("8A", "2A")).toBe("clash");
        });

        it("returns 'compatible' when either key is missing", () => {
            expect(getKeyCompatibility("", "8A")).toBe("compatible");
            expect(getKeyCompatibility("8A", "")).toBe("compatible");
        });
    });

    describe("calculateTransitionScore", () => {
        it("rewards same BPM + perfect key + matching energy with a near-max score", () => {
            const { score } = calculateTransitionScore(128, "8A", 7, 128, "8A", 7);
            expect(score).toBeGreaterThanOrEqual(95);
            expect(score).toBeLessThanOrEqual(100);
        });

        it("penalises clashing key + large BPM gap + energy jump", () => {
            const { score, reason } = calculateTransitionScore(128, "8A", 4, 174, "2A", 9);
            expect(score).toBeLessThan(50);
            expect(reason).toMatch(/clash|Large BPM/);
        });

        it("clamps score to 0-100", () => {
            for (let i = 0; i < 5; i++) {
                const { score } = calculateTransitionScore(120, "1A", 1, 200, "7A", 10);
                expect(score).toBeGreaterThanOrEqual(0);
                expect(score).toBeLessThanOrEqual(100);
            }
        });

        it("returns a non-empty reason string", () => {
            const { reason } = calculateTransitionScore(128, "8A", 5, 130, "9A", 6);
            expect(reason.length).toBeGreaterThan(0);
        });
    });

    describe("constants", () => {
        it("DEFAULT_DECK_STATE is a complete deck spec", () => {
            expect(DEFAULT_DECK_STATE.trackId).toBeNull();
            expect(DEFAULT_DECK_STATE.isPlaying).toBe(false);
            expect(DEFAULT_DECK_STATE.volume).toBeGreaterThanOrEqual(0);
            expect(DEFAULT_DECK_STATE.eqLow).toBe(0);
            expect(DEFAULT_DECK_STATE.eqMid).toBe(0);
            expect(DEFAULT_DECK_STATE.eqHi).toBe(0);
            expect(DEFAULT_DECK_STATE.hotCues).toHaveLength(8);
            expect(DEFAULT_DECK_STATE.hotCues.every(c => c === null)).toBe(true);
        });

        it("BEAT_FX_TYPES / FILTER_TYPES / COLOR_FX_TYPES have unique ids", () => {
            for (const list of [BEAT_FX_TYPES, FILTER_TYPES, COLOR_FX_TYPES]) {
                const ids = new Set(list.map(t => t.id));
                expect(ids.size).toBe(list.length);
            }
        });
    });
});
