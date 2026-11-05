/**
 * Pure clock-sync + drift-correction math for Watch Together (WP16-08).
 * 1:1 port of `server/src/hub/sync-math.ts` (also mirrored in tv-android `data/SyncMath.kt`).
 * Copied, not imported: apps/tv-tizen never imports from server/. Keep the constants identical.
 *   offset = ((t1 - t0) + (t2 - t3)) / 2, RTT = (t3 - t0) - (t2 - t1)
 *   keep the 8 latest samples, trust the lowest RTT, smooth with EMA α = 0.4.
 * No TS parameter properties here: `node --experimental-strip-types` runs this file in tests.
 */

export interface ClockSample { offsetMs: number; rttMs: number }

export function sampleFrom(t0: number, t1: number, t2: number, t3: number): ClockSample {
    return { offsetMs: ((t1 - t0) + (t2 - t3)) / 2, rttMs: Math.max(0, (t3 - t0) - (t2 - t1)) };
}

export const CLOCK_WINDOW = 8;
export const CLOCK_ALPHA = 0.4;

export class ClockEstimator {
    private samples: ClockSample[] = [];
    private ema: number | null = null;
    private readonly window: number;
    private readonly alpha: number;

    constructor(window = CLOCK_WINDOW, alpha = CLOCK_ALPHA) {
        this.window = window;
        this.alpha = alpha;
    }

    add(s: ClockSample): void {
        this.samples.push(s);
        if (this.samples.length > this.window) this.samples.shift();
        const best = this.best();
        if (!best) return;
        this.ema = this.ema === null ? best.offsetMs : this.ema + this.alpha * (best.offsetMs - this.ema);
    }

    best(): ClockSample | null {
        return this.samples.reduce<ClockSample | null>((a, s) => (!a || s.rttMs < a.rttMs ? s : a), null);
    }

    /** serverTime ≈ localTime + offset */
    get offsetMs(): number { return this.ema ?? 0; }
    get rttMs(): number { return this.best()?.rttMs ?? 0; }
    get count(): number { return this.samples.length; }
}

export interface PlaybackAnchor {
    playing: boolean;
    positionSec: number;
    /** Server time (ms) at which `positionSec` was true. */
    atServerMs: number;
    rate?: number;
}

/** Where the media should be at `serverNowMs`. */
export function expectedPosition(a: PlaybackAnchor, serverNowMs: number): number {
    if (!a.playing) return a.positionSec;
    return a.positionSec + Math.max(0, serverNowMs - a.atServerMs) / 1000 * (a.rate ?? 1);
}

export type DriftAction =
    | { kind: "none" }
    | { kind: "rate"; rate: number }
    | { kind: "seek"; positionSec: number };

export const DRIFT_START_MS = 120;
export const DRIFT_STOP_MS = 40;
export const DRIFT_SEEK_MS = 1500;
export const MAX_RATE_DELTA = 0.05;

/**
 * Hysteresis drift correction: start nudging the playback rate above 120 ms,
 * stop below 40 ms, hard-seek above 1.5 s. `drift` = actual - expected (seconds);
 * positive means we are ahead → slow down.
 */
export function driftAction(actualSec: number, expectedSec: number, correcting: boolean): DriftAction {
    const driftMs = (actualSec - expectedSec) * 1000;
    const abs = Math.abs(driftMs);
    if (abs >= DRIFT_SEEK_MS) return { kind: "seek", positionSec: expectedSec };
    if (abs < DRIFT_STOP_MS || (!correcting && abs < DRIFT_START_MS)) return { kind: "none" };
    // Proportional, clamped to ±5 % so the audio pitch change stays inaudible.
    const rate = 1 - Math.max(-MAX_RATE_DELTA, Math.min(MAX_RATE_DELTA, driftMs / 1000 / 4));
    return { kind: "rate", rate: Math.round(rate * 1000) / 1000 };
}

/** Lead time for a scheduled command: slowest member RTT + 150 ms, clamped 150..2000 ms. */
export function leadTimeMs(rtts: number[]): number {
    const max = rtts.length ? Math.max(...rtts) : 0;
    return Math.max(150, Math.min(2000, Math.round(max + 150)));
}
