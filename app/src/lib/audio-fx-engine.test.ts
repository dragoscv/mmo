import { describe, it, expect } from "vitest";
import {
    NOTE_NAMES,
    FX_DEFAULTS,
    FX_CATEGORIES,
    MUSICAL_SCALES,
    type FxType,
} from "./audio-fx-engine";

describe("audio-fx-engine constants", () => {
    it("NOTE_NAMES is the 12-tone chromatic with sharps", () => {
        expect(NOTE_NAMES).toHaveLength(12);
        expect(NOTE_NAMES[0]).toBe("C");
        expect(NOTE_NAMES[9]).toBe("A");
        expect(NOTE_NAMES.filter(n => n.includes("b"))).toHaveLength(0); // sharps only
    });

    it("FX_DEFAULTS provides params for every FxType referenced in FX_CATEGORIES", () => {
        const seen = new Set<string>();
        for (const cat of Object.values(FX_CATEGORIES)) {
            for (const t of cat.types) {
                seen.add(t);
                expect(FX_DEFAULTS).toHaveProperty(t);
                expect(typeof FX_DEFAULTS[t]).toBe("object");
            }
        }
        // Every key in FX_DEFAULTS should be reachable from at least one category
        // (otherwise the FX would never appear in the picker UI).
        for (const k of Object.keys(FX_DEFAULTS) as FxType[]) {
            expect(seen.has(k)).toBe(true);
        }
    });

    it("FX_DEFAULTS values are all finite numbers in plausible ranges", () => {
        for (const [type, params] of Object.entries(FX_DEFAULTS)) {
            for (const [name, val] of Object.entries(params)) {
                expect(Number.isFinite(val)).toBe(true);
                // Spot-check known ranges
                if (name === "mix") {
                    expect(val).toBeGreaterThanOrEqual(0);
                    expect(val).toBeLessThanOrEqual(1);
                }
                if (name === "ratio") {
                    expect(val).toBeGreaterThanOrEqual(1);
                }
                if (name === "feedback") {
                    expect(val).toBeLessThan(1); // avoid runaway
                }
                if (name === "threshold" && type !== "gate") {
                    expect(val).toBeLessThanOrEqual(0); // dB threshold should be ≤ 0
                }
            }
        }
    });

    it("FX_CATEGORIES has unique labels and unique fx types across categories", () => {
        const labels = new Set<string>();
        const types = new Set<string>();
        for (const cat of Object.values(FX_CATEGORIES)) {
            expect(labels.has(cat.label)).toBe(false);
            labels.add(cat.label);
            for (const t of cat.types) {
                expect(types.has(t)).toBe(false); // each FX appears in one category only
                types.add(t);
            }
        }
    });

    it("MUSICAL_SCALES intervals are sorted, non-negative, and < 12", () => {
        for (const [, scale] of Object.entries(MUSICAL_SCALES)) {
            expect(scale.intervals.length).toBeGreaterThan(0);
            for (let i = 0; i < scale.intervals.length; i++) {
                expect(scale.intervals[i]).toBeGreaterThanOrEqual(0);
                expect(scale.intervals[i]).toBeLessThan(12);
                if (i > 0) expect(scale.intervals[i]).toBeGreaterThan(scale.intervals[i - 1]);
            }
        }
        // Chromatic must be all 12 semitones
        expect(MUSICAL_SCALES[0].intervals).toHaveLength(12);
    });
});
