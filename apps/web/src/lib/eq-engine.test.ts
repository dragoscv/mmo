import { describe, it, expect } from "vitest";
import {
    DEFAULT_BANDS,
    DEFAULT_EFFECTS,
    EQ_PRESETS,
} from "./eq-engine";

describe("eq-engine constants", () => {
    it("DEFAULT_BANDS is a 10-band layout with rising frequencies", () => {
        expect(DEFAULT_BANDS).toHaveLength(10);
        for (let i = 1; i < DEFAULT_BANDS.length; i++) {
            expect(DEFAULT_BANDS[i].frequency).toBeGreaterThan(DEFAULT_BANDS[i - 1].frequency);
        }
        // First band is a low shelf, last is a high shelf, middle are peaking
        expect(DEFAULT_BANDS[0].type).toBe("lowshelf");
        expect(DEFAULT_BANDS[DEFAULT_BANDS.length - 1].type).toBe("highshelf");
        for (let i = 1; i < DEFAULT_BANDS.length - 1; i++) {
            expect(DEFAULT_BANDS[i].type).toBe("peaking");
        }
        // All start flat
        for (const band of DEFAULT_BANDS) {
            expect(band.gain).toBe(0);
            expect(band.Q).toBeGreaterThan(0);
            expect(band.label).toMatch(/\d/);
        }
    });

    it("EQ_PRESETS each have exactly 10 bands and clamped gain values", () => {
        expect(EQ_PRESETS.length).toBeGreaterThan(5);
        const names = new Set<string>();
        for (const preset of EQ_PRESETS) {
            expect(preset.bands).toHaveLength(10);
            for (const g of preset.bands) {
                expect(g).toBeGreaterThanOrEqual(-12);
                expect(g).toBeLessThanOrEqual(12);
                expect(Number.isFinite(g)).toBe(true);
            }
            expect(preset.name.length).toBeGreaterThan(0);
            // Names must be unique
            expect(names.has(preset.name)).toBe(false);
            names.add(preset.name);
        }
    });

    it("EQ_PRESETS contains a 'Flat' preset that is all zeros", () => {
        const flat = EQ_PRESETS.find(p => p.name === "Flat");
        expect(flat).toBeDefined();
        expect(flat!.bands.every(g => g === 0)).toBe(true);
    });

    it("DEFAULT_EFFECTS has sane defaults across compressor/reverb/delay/stereo/bass", () => {
        expect(DEFAULT_EFFECTS.compressorEnabled).toBe(false);
        expect(DEFAULT_EFFECTS.compressorThreshold).toBeLessThan(0);
        expect(DEFAULT_EFFECTS.compressorRatio).toBeGreaterThanOrEqual(1);
        expect(DEFAULT_EFFECTS.compressorAttack).toBeGreaterThan(0);
        expect(DEFAULT_EFFECTS.compressorRelease).toBeGreaterThan(0);

        expect(DEFAULT_EFFECTS.reverbEnabled).toBe(false);
        expect(DEFAULT_EFFECTS.reverbMix).toBeGreaterThanOrEqual(0);
        expect(DEFAULT_EFFECTS.reverbMix).toBeLessThanOrEqual(1);
        expect(DEFAULT_EFFECTS.reverbDecay).toBeGreaterThan(0);

        expect(DEFAULT_EFFECTS.delayEnabled).toBe(false);
        expect(DEFAULT_EFFECTS.delayTime).toBeGreaterThanOrEqual(0);
        expect(DEFAULT_EFFECTS.delayTime).toBeLessThanOrEqual(2);
        expect(DEFAULT_EFFECTS.delayFeedback).toBeLessThan(1); // must avoid runaway
        expect(DEFAULT_EFFECTS.delayMix).toBeLessThanOrEqual(1);

        expect(DEFAULT_EFFECTS.stereoEnabled).toBe(false);
        expect(DEFAULT_EFFECTS.stereoWidth).toBe(1); // 1 = neutral

        expect(DEFAULT_EFFECTS.bassBoostEnabled).toBe(false);
        expect(DEFAULT_EFFECTS.bassBoostAmount).toBeGreaterThanOrEqual(0);
        expect(DEFAULT_EFFECTS.bassBoostAmount).toBeLessThanOrEqual(1);
    });
});
