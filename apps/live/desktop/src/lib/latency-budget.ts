/**
 * Latency budget: what the engine declares, per stage, against what the probe actually measures.
 *
 * The stages are the ones named in docs/live/latency.md: the input period, the frames kept queued
 * between input and output, the output period, and the effect chain. Their sum is the declared
 * figure; the probe's round trip is always larger, and the difference is everything outside the
 * engine (the driver's own buffering, the OS, the cable or routing). Showing the two side by side is
 * the point: a number that is declared and a number that is measured, never one presented as the
 * other.
 */
import type { Meters, RunningInfo } from "./protocol";

export interface BudgetRow {
    /** i18n key suffix, `setup.budget<Id>`. */
    id: "Input" | "Cushion" | "Output" | "Chain" | "ChainEars";
    ms: number;
}

export interface LatencyBudget {
    /** The stages the engine can account for, in signal order. */
    rows: BudgetRow[];
    /** Input + cushion + output + the main chain (the audience's path). */
    declaredMs: number;
    /** The same, with the ears' chain: equal to `declaredMs` unless the ears-untuned option is on. */
    declaredEarsMs: number;
    /** The probe's round trip, or null when it was never run. */
    measuredMs: number | null;
    /** Measured − declared: the driver, the OS and the routing. Null without a measurement. */
    restMs: number | null;
}

const ms = (frames: number | undefined, rate: number): number =>
    frames && rate > 0 ? (frames * 1000) / rate : 0;
const chainMs = (samples: number | undefined, rate: number): number => ms(samples, rate);

/**
 * `measured` is what `measure_latency` returned (its `round_trip_ms`), null when the user has not run
 * the probe. `meters` carries the two chain figures; without them the chain term is 0 and the budget
 * is the buffer alone, which is what an engine older than the latency slice can tell.
 */
export function latencyBudget(
    info: RunningInfo | null | undefined,
    meters: Meters | null | undefined,
    measuredRoundTripMs: number | null,
): LatencyBudget {
    const rate = info?.sample_rate ?? 48000;
    const mainChainMs = chainMs(meters?.chain_latency_samples, rate);
    const rows: BudgetRow[] = [
        { id: "Input", ms: ms(info?.input_period_frames ?? info?.buffer_frames, rate) },
        { id: "Cushion", ms: ms(info?.cushion_frames, rate) },
        { id: "Output", ms: ms(info?.output_period_frames ?? info?.buffer_frames, rate) },
        { id: "Chain", ms: mainChainMs },
    ];
    const ears = chainMs(meters?.monitor_chain_latency_samples, rate);
    // Only worth a row when the ears really differ (the both-chains option is on).
    if (meters?.monitor_chain_latency_samples != null && ears !== mainChainMs) {
        rows.push({ id: "ChainEars", ms: ears });
    }
    // The buffer stages once, then each chain as an alternative: the ears' chain does not add to the
    // main one, it replaces it on the monitor bus.
    const buffer = rows.slice(0, 3).reduce((s, r) => s + r.ms, 0);
    const declaredMs = buffer + mainChainMs;
    const declaredEarsMs = buffer + ears;
    const measuredMs = measuredRoundTripMs != null && measuredRoundTripMs > 0 ? measuredRoundTripMs : null;
    return {
        rows,
        declaredMs,
        declaredEarsMs,
        measuredMs,
        restMs: measuredMs == null ? null : measuredMs - declaredMs,
    };
}
