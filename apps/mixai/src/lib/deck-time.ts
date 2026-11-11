/**
 * Pure time / bar maths shared by the deck header, the waveform panel and the overview:
 * end-of-track warning levels, "12.3 bars" counters and a smoothed playhead.
 * No React, no DOM: covered by `node --test`.
 */
import { beatAt, type GridModel } from "../grid/markers.ts";

/** Remaining play time (seconds, at the current tempo) at which the time readout warns. */
export const WARN_SOON_SEC = 30;
export const WARN_NOW_SEC = 15;

export type RemainWarn = "none" | "soon" | "now";

/** Real seconds until the end of the track at the current tempo (0 when unknown). */
export function remainingSec(deck: { duration: number; position: number; tempo: number }): number {
    if (!(deck.duration > 0)) return 0;
    const tempo = deck.tempo > 0 ? deck.tempo : 1;
    return Math.max(0, (deck.duration - deck.position) / tempo);
}

/** Warning level of the remaining-time readout. Only a playing deck warns. */
export function remainWarn(deck: { loaded: boolean; playing: boolean; duration: number; position: number; tempo: number }): RemainWarn {
    if (!deck.loaded || !deck.playing || !(deck.duration > 0)) return "none";
    const left = remainingSec(deck);
    if (left <= WARN_NOW_SEC) return "now";
    if (left <= WARN_SOON_SEC) return "soon";
    return "none";
}

/** `m:ss` plus tenths, split so the fraction can be drawn smaller. Negative / NaN = 0. */
export function splitTime(sec: number): { main: string; frac: string } {
    const s = Number.isFinite(sec) && sec > 0 ? sec : 0;
    const tenths = Math.floor(s * 10);
    const m = Math.floor(tenths / 600);
    const ss = Math.floor((tenths % 600) / 10);
    return { main: `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`, frac: String(tenths % 10) };
}

/** Whole bars and the beat inside the next bar between two source times, on the deck's grid. */
export function barsBetween(grid: GridModel | null, fromSec: number, toSec: number, beatsPerBar = 4): { bars: number; beat: number } | null {
    if (!grid || !(grid.bpm > 0)) return null;
    const bar = Math.max(1, Math.round(beatsPerBar));
    const beats = beatAt(grid, toSec) - beatAt(grid, fromSec);
    if (!Number.isFinite(beats) || beats < 0) return null;
    const bars = Math.floor(beats / bar);
    return { bars, beat: Math.min(bar, Math.floor(beats - bars * bar) + 1) };
}

/** "12.3" = 12 bars and into beat 3. */
export function formatBars(b: { bars: number; beat: number }): string {
    return `${b.bars}.${b.beat}`;
}

/** The first hot cue ahead of the playhead: `{ slot, sec }`, or null. */
export function nextCueAhead(hotCues: readonly (number | null)[], position: number): { slot: number; sec: number } | null {
    let best: { slot: number; sec: number } | null = null;
    hotCues.forEach((c, slot) => {
        if (c == null || !(c > position + 0.05)) return;
        if (!best || c < best.sec) best = { slot, sec: c };
    });
    return best;
}

// ── smoothed playhead ────────────────────────────────────────────────────────
// The engine reports the position ~30 times a second. A waveform that scrolls at the display
// rate extrapolates between reports and corrects softly, so it neither stutters nor drifts.

export interface Playhead {
    /** Source position in seconds at `at`. */
    pos: number;
    /** `performance.now()` of `pos`. */
    at: number;
}

/** A report further away than this from the prediction is a seek: snap to it. */
export const SNAP_SEC = 0.12;
/** Share of the remaining error removed per report. */
export const CORRECTION = 0.2;

/** Position predicted at `now` (ms) for a deck moving at `rate` source-seconds per second. */
export function predict(h: Playhead, now: number, rate: number): number {
    return h.pos + ((now - h.at) / 1000) * rate;
}

/** Fold a fresh engine report into the playhead. */
export function correct(h: Playhead | null, reported: number, now: number, rate: number): Playhead {
    if (!h) return { pos: reported, at: now };
    const predicted = predict(h, now, rate);
    const err = reported - predicted;
    if (!Number.isFinite(err) || Math.abs(err) > SNAP_SEC) return { pos: reported, at: now };
    return { pos: predicted + err * CORRECTION, at: now };
}

/** Signed phase difference of two fractional beat numbers, in beats, within [-0.5, 0.5). */
export function phaseOffset(beat: number, masterBeat: number): number {
    const d = (beat - masterBeat) % 1;
    const r = d < -0.5 ? d + 1 : d >= 0.5 ? d - 1 : d;
    // `%` keeps the sign of the dividend, so an exact match can come out as -0.
    return r === 0 ? 0 : r;
}
