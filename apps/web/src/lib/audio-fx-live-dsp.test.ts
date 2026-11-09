import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
    deEsserSettings,
    FX_DEFAULTS,
    gateWorkletParams,
    stereoWidthMatrix,
    VOCODER_MAX_HZ,
    VOCODER_MIN_HZ,
    vocoderBands,
    vocoderEnvelopeHz,
} from "./audio-fx-engine";

describe("stereoWidthMatrix (mid/side)", () => {
    const apply = (w: number, l: number, r: number) => {
        const { direct, cross } = stereoWidthMatrix(w);
        return [direct * l + cross * r, cross * l + direct * r];
    };
    it("width 1 is the identity", () => {
        expect(apply(1, 0.7, -0.2)).toEqual([0.7, -0.2]);
    });
    it("width 0 folds to mono (mid on both sides)", () => {
        const [l, r] = apply(0, 1, 0);
        expect(l).toBeCloseTo(0.5);
        expect(r).toBeCloseTo(0.5);
    });
    it("width 2 doubles the side and keeps the mid", () => {
        const [l, r] = apply(2, 1, 0); // mid 0.5, side 0.5 -> side 1
        expect(l).toBeCloseTo(1.5);
        expect(r).toBeCloseTo(-0.5);
        expect((l + r) / 2).toBeCloseTo(0.5);
    });
    it("clamps out-of-range and non-finite widths", () => {
        expect(stereoWidthMatrix(9)).toEqual(stereoWidthMatrix(2));
        expect(stereoWidthMatrix(-1)).toEqual(stereoWidthMatrix(0));
        expect(stereoWidthMatrix(Number.NaN)).toEqual(stereoWidthMatrix(1));
    });
});

describe("deEsserSettings", () => {
    it("keeps the existing param names and defaults", () => {
        expect(deEsserSettings(FX_DEFAULTS.deEsser)).toEqual({ crossoverHz: 6000, threshold: -20, ratio: 4 });
    });
    it("clamps the crossover to the sibilance range", () => {
        expect(deEsserSettings({ frequency: 100 }).crossoverHz).toBe(2000);
        expect(deEsserSettings({ frequency: 40000 }).crossoverHz).toBe(16000);
        expect(deEsserSettings({}).ratio).toBe(4);
    });
});

describe("vocoderBands", () => {
    it("lays out log-spaced bands inside the vocoder range", () => {
        const { centers, q } = vocoderBands(16);
        expect(centers).toHaveLength(16);
        expect(centers[0]).toBeGreaterThan(VOCODER_MIN_HZ);
        expect(centers[15]).toBeLessThan(VOCODER_MAX_HZ);
        const r1 = centers[1] / centers[0];
        const r2 = centers[15] / centers[14];
        expect(r2).toBeCloseTo(r1, 9);
        expect(q).toBeGreaterThan(2);
        expect(q).toBeLessThan(5);
    });
    it("clamps the band count to 4..32", () => {
        expect(vocoderBands(1).centers).toHaveLength(4);
        expect(vocoderBands(99).centers).toHaveLength(32);
    });
    it("narrower bands get a higher Q", () => {
        expect(vocoderBands(32).q).toBeGreaterThan(vocoderBands(8).q);
    });
    it("maps attack/release to a bounded envelope cutoff", () => {
        expect(vocoderEnvelopeHz(0.005, 0.02)).toBeGreaterThan(5);
        expect(vocoderEnvelopeHz(0.005, 0.02)).toBeLessThan(200);
        expect(vocoderEnvelopeHz(0, 0)).toBe(200);
        expect(vocoderEnvelopeHz(2, 2)).toBe(5);
    });
});

describe("gateWorkletParams", () => {
    it("gate is a hard gate with a deep range", () => {
        const g = gateWorkletParams("gate", FX_DEFAULTS.gate);
        expect(g).toMatchObject({ threshold: -40, ratio: 20, range: -80, attack: 0.001, release: 0.1 });
    });
    it("noiseSuppression is an expander floored at -reduction dB", () => {
        const g = gateWorkletParams("noiseSuppression", FX_DEFAULTS.noiseSuppression);
        expect(g).toMatchObject({ threshold: -40, ratio: 4, range: -20 });
    });
});

// ─── The worklet itself (real algorithm, evaluated outside a browser) ───

type Proc = {
    process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
};

function loadGate(sr: number): { make: () => Proc; defaults: Record<string, number> } {
    const src = readFileSync(new URL("../../public/worklets/live-gate-processor.js", import.meta.url), "utf8");
    let ctor: (new () => Proc) | null = null;
    class Base {}
    runInNewContext(src, {
        AudioWorkletProcessor: Base,
        registerProcessor: (name: string, c: new () => Proc) => { if (name === "live-gate") ctor = c; },
        sampleRate: sr,
        Float32Array,
        Math,
    });
    if (!ctor) throw new Error("live-gate not registered");
    const C = ctor as unknown as { new (): Proc; parameterDescriptors: { name: string; defaultValue: number }[] };
    const defaults = Object.fromEntries(C.parameterDescriptors.map((d) => [d.name, d.defaultValue]));
    return { make: () => new C(), defaults };
}

function runGate(amplitude: number, overrides: Record<string, number>, seconds = 0.5): number {
    const sr = 48000;
    const { make, defaults } = loadGate(sr);
    const proc = make();
    const params = Object.fromEntries(
        Object.entries({ ...defaults, ...overrides }).map(([k, v]) => [k, new Float32Array([v])]),
    );
    let peakOut = 0;
    const blocks = Math.ceil((seconds * sr) / 128);
    for (let b = 0; b < blocks; b++) {
        const inp = new Float32Array(128);
        for (let i = 0; i < 128; i++) inp[i] = amplitude * Math.sin((2 * Math.PI * 440 * (b * 128 + i)) / sr);
        const out = new Float32Array(128);
        proc.process([[inp]], [[out]], params);
        if (b >= blocks - 40) for (const v of out) peakOut = Math.max(peakOut, Math.abs(v));
    }
    return peakOut;
}

describe("live-gate worklet", () => {
    it("passes a signal above the threshold untouched", () => {
        expect(runGate(0.5, { threshold: -40 })).toBeCloseTo(0.5, 2); // -6 dBFS
    });
    it("closes on a signal below the threshold down to the range floor", () => {
        // -60 dBFS input, -40 dB threshold, hard gate with -80 dB range: output is at the floor.
        const out = runGate(0.001, { threshold: -40, ratio: 20, range: -80 });
        expect(out).toBeLessThan(0.001 * 10 ** (-60 / 20));
    });
    it("expander mode stops at the range (noise suppression floor)", () => {
        const out = runGate(0.001, { threshold: -40, ratio: 4, range: -20 });
        expect(out).toBeGreaterThan(0.001 * 10 ** (-21 / 20));
        expect(out).toBeLessThan(0.001 * 10 ** (-19 / 20));
    });
});
