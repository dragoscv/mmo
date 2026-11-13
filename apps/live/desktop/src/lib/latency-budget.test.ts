import { describe, expect, it } from "vitest";
import { latencyBudget } from "./latency-budget";
import type { Meters, RunningInfo } from "./protocol";

const info = (over: Partial<RunningInfo> = {}): RunningInfo => ({
    host: "WASAPI Exclusive",
    input: "in",
    output: "out",
    sample_rate: 48000,
    buffer_frames: 128,
    input_channels: 2,
    output_channels: 2,
    nominal_latency_ms: 8,
    input_period_frames: 128,
    cushion_frames: 128,
    output_period_frames: 128,
    notes: [],
    ...over,
});

const meters = (chain: number, ears: number): Meters => ({
    in_peak: 0,
    in_rms: 0,
    out_peak: [0, 0],
    out_rms: [0, 0],
    gr: [],
    dsp_load: 0,
    dsp_load_max: 0,
    xruns: 0,
    clipped: false,
    tune: null,
    latency_probe: "idle",
    chain_latency_samples: chain,
    monitor_chain_latency_samples: ears,
});

/** 128 frames at 48 kHz is 2.667 ms; 256 samples of chain is 5.333 ms. */
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

describe("latencyBudget", () => {
    it("adds the three buffer terms and the chain, and shows the probe's remainder", () => {
        const b = latencyBudget(info(), meters(256, 256), 15.4);
        expect(b.rows.map((r) => r.id)).toEqual(["Input", "Cushion", "Output", "Chain"]);
        for (const r of b.rows) expect(near(r.ms, 2.6667) || near(r.ms, 5.3333)).toBe(true);
        expect(near(b.declaredMs, 8 + 5.3333)).toBe(true);
        expect(b.measuredMs).toBe(15.4);
        expect(near(b.restMs ?? 0, 15.4 - 13.3333)).toBe(true);
    });

    it("adds the ears' row only when the ears really differ", () => {
        const on = latencyBudget(info(), meters(256, 0), 12);
        expect(on.rows.map((r) => r.id)).toEqual(["Input", "Cushion", "Output", "Chain", "ChainEars"]);
        expect(on.rows.find((r) => r.id === "ChainEars")?.ms).toBe(0);
        // The ears' chain REPLACES the main one on that path, so it is a second figure, not an
        // addition: the audience's path still costs 8 + 5.333 ms.
        expect(near(on.declaredMs, 8 + 5.3333)).toBe(true);
        expect(near(on.declaredEarsMs, 8)).toBe(true);
        // Off, or an engine that does not report it: no extra row.
        expect(latencyBudget(info(), meters(256, 256), 12).rows).toHaveLength(4);
        expect(latencyBudget(info(), { ...meters(256, 256), monitor_chain_latency_samples: undefined }, 12).rows).toHaveLength(4);
    });

    it("without a measurement the declared figure stands alone", () => {
        const b = latencyBudget(info(), meters(0, 0), null);
        expect(near(b.declaredMs, 8)).toBe(true);
        expect(b.measuredMs).toBeNull();
        expect(b.restMs).toBeNull();
    });

    it("falls back to the buffer size when an older engine sends no buffer terms", () => {
        const old = info({
            input_period_frames: undefined,
            cushion_frames: undefined,
            output_period_frames: undefined,
        });
        const b = latencyBudget(old, undefined, null);
        // buffer 128 = 2.667 ms each for the input and output periods; the cushion is unknown -> 0.
        expect(b.rows.map((r) => r.ms).map((m) => Math.round(m * 100) / 100)).toEqual([2.67, 0, 2.67, 0]);
        expect(near(b.declaredMs, 5.3333)).toBe(true);
    });

    it("ignores a zero or negative measurement and a missing engine", () => {
        expect(latencyBudget(info(), null, 0).measuredMs).toBeNull();
        const none = latencyBudget(null, null, 9);
        expect(none.measuredMs).toBe(9);
        // No engine: nothing declared at all (not a guessed buffer size), and the whole measurement
        // shows up as the part outside the engine.
        expect(none.declaredMs).toBe(0);
        expect(none.rows.map((r) => r.ms)).toEqual([0, 0, 0, 0]);
        expect(none.restMs).toBe(9);
    });
});
