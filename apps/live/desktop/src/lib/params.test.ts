import { describe, expect, it } from "vitest";
import { clamp, controlKind, formatValue, fromNormalized, nudge, parseCatalogue, toNormalized, voiceParam, type ParamSpec } from "./params";

const spec = (over: Partial<ParamSpec>): ParamSpec => ({
    id: "x",
    min: 0,
    max: 1,
    default: 0.5,
    unit: "none",
    curve: "linear",
    choices: [],
    ...over,
});

describe("normalisation (mirrors live_dsp ParamSpec)", () => {
    const freq = spec({ id: "frequency", min: 20, max: 20000, default: 1000, unit: "hz", curve: "log" });

    it("log curve: geometric midpoint at 0.5 and exact round trip", () => {
        expect(fromNormalized(freq, 0.5)).toBeCloseTo(Math.sqrt(20 * 20000), 3);
        for (const v of [20, 100, 1000, 8000, 20000]) expect(fromNormalized(freq, toNormalized(freq, v))).toBeCloseTo(v, 3);
        expect(toNormalized(freq, 5)).toBe(0);
        expect(fromNormalized(freq, 2)).toBe(20000);
    });

    it("linear curve and non-finite inputs", () => {
        const gain = spec({ min: -24, max: 24, default: 0, unit: "db" });
        expect(toNormalized(gain, 0)).toBe(0.5);
        expect(fromNormalized(gain, 0.25)).toBe(-12);
        expect(clamp(gain, Number.NaN)).toBe(0);
        expect(fromNormalized(gain, Number.NaN)).toBe(-24);
    });

    it("discrete units round", () => {
        const choice = spec({ unit: "choice", min: 0, max: 2, choices: ["tape", "tube", "soft_clip"] });
        expect(clamp(choice, 1.4)).toBe(1);
        expect(controlKind(choice)).toBe("choice");
        expect(controlKind(spec({ unit: "toggle" }))).toBe("toggle");
        expect(controlKind(spec({ unit: "db" }))).toBe("knob");
    });

    it("nudges integer params by whole steps", () => {
        const interval = spec({ id: "v1_interval", min: -12, max: 12, default: 2, unit: "none" });
        expect(nudge(interval, 2, 0.01)).toBe(3);
        expect(nudge(interval, 12, 0.01)).toBe(12);
        const mix = spec({ unit: "percent" });
        expect(nudge(mix, 0.5, 0.1)).toBeCloseTo(0.6);
    });
});

describe("formatting", () => {
    it("formats units", () => {
        expect(formatValue(spec({ unit: "db" }), 3)).toBe("+3 dB");
        expect(formatValue(spec({ unit: "hz" }), 2500)).toBe("2.5 kHz");
        expect(formatValue(spec({ unit: "hz" }), 120)).toBe("120 Hz");
        expect(formatValue(spec({ unit: "ms" }), 375)).toBe("375 ms");
        expect(formatValue(spec({ unit: "ratio" }), 4)).toBe("4:1");
        expect(formatValue(spec({ unit: "percent" }), 0.35)).toBe("35%");
        expect(formatValue(spec({ unit: "pan" }), -0.3)).toBe("L30");
        expect(formatValue(spec({ unit: "semitones" }), -12)).toBe("-12 st");
    });

    it("splits harmonizer voice ids", () => {
        expect(voiceParam("v3_level")).toEqual({ voice: 3, base: "level" });
        expect(voiceParam("mix")).toBeNull();
    });
});

describe("parseCatalogue", () => {
    it("keeps valid entries and defaults missing fields", () => {
        const cat = parseCatalogue([
            { id: "eq", params: [{ id: "low_gain", min: -18, max: 18, default: 0, unit: "db", curve: "linear", choices: [] }] },
            { id: "broken" },
            { id: "limiter", params: [{ id: "ceiling", min: -12, max: 0 }, { nope: true }] },
        ]);
        expect(cat.map((f) => f.id)).toEqual(["eq", "limiter"]);
        expect(cat[1]?.params).toEqual([{ id: "ceiling", min: -12, max: 0, default: -12, unit: "none", curve: "linear", choices: [] }]);
        expect(parseCatalogue("x")).toEqual([]);
    });
});
