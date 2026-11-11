/**
 * Pure maths of the waves panel: zoom steps, orientation and tiers, peak bins, seeks, beat
 * cells, phase quantising and the place of each deck layer inside a lane.
 * No React, no DOM: covered by `node --test` (wave-math.test.ts).
 */
import { beatAt, timeAt, type GridModel } from "../../grid/markers.ts";
import { barsBetween, nextCueAhead } from "../../lib/deck-time.ts";
import type { ClockState, DeckId, DeckState } from "../../bridge/types.ts";

/** Visible time windows of a scrolling lane, in seconds (the zoom steps). */
export const WINDOWS = [4, 8, 16, 32] as const;
/** Default window: 8 s. */
export const DEFAULT_WINDOW_INDEX = 1;

/** Next zoom step: `-1` = zoom in (shorter window), `+1` = zoom out. Clamped. */
export function stepWindow(index: number, dir: -1 | 1): number {
    return Math.max(0, Math.min(WINDOWS.length - 1, Math.round(index) + dir));
}

export type WaveTier = "full" | "compact" | "icon";

/** Lanes become columns when the box is clearly taller than wide. */
export function isVertical(w: number, h: number): boolean {
    return w > 0 && h > w * 1.15;
}

/**
 * Tier the panel renders at. Horizontal: the tier the layout solver gave. Vertical: the
 * solver's minimums describe the horizontal form (a 264 px wide column always gets "icon"),
 * so the richness is decided from the column size instead.
 */
export function effectiveTier(tier: WaveTier, w: number, h: number, lanes: number): WaveTier {
    if (!isVertical(w, h)) return tier;
    const col = w / Math.max(1, lanes);
    if (h >= 300 && col >= 96) return "full";
    if (h >= 160 && col >= 60) return "compact";
    return "icon";
}

/** Where the fixed playhead sits along the time axis (0..1): centre, or 1/3 from the top. */
export function playheadAnchor(vertical: boolean): number {
    return vertical ? 1 / 3 : 0.5;
}

/**
 * Height (0..255) of the wave in device-pixel column `column` of the source, for a zoom of
 * `pointsPerPx` source points per column. Zoomed out: the peak of the points the column
 * covers. Zoomed in past the source resolution: a straight line between neighbouring points.
 * Depends only on the column and the zoom, never on the scroll position, so the shape stays
 * fixed to the source while it moves.
 */
export function columnPeak(lane: Uint8Array, column: number, pointsPerPx: number): number {
    const len = lane.length;
    if (len === 0 || column < 0 || !(pointsPerPx > 0) || !Number.isFinite(pointsPerPx)) return 0;
    if (pointsPerPx >= 1) {
        const i0 = Math.floor(column * pointsPerPx);
        if (i0 >= len) return 0;
        let i1 = Math.floor((column + 1) * pointsPerPx);
        if (i1 <= i0) i1 = i0 + 1;
        if (i1 > len) i1 = len;
        let m = 0;
        for (let i = i0; i < i1; i++) {
            const v = lane[i]!;
            if (v > m) m = v;
        }
        return m;
    }
    // Point `i` covers [i, i + 1) / pps: its centre is at i + 0.5.
    const centre = (column + 0.5) * pointsPerPx;
    if (centre >= len) return 0;
    const x = centre - 0.5;
    if (x <= 0) return lane[0]!;
    const i = Math.floor(x);
    if (i >= len - 1) return lane[len - 1]!;
    const f = x - i;
    return lane[i]! * (1 - f) + lane[i + 1]! * f;
}

/**
 * Device-pixel column of the source under the playhead. The wave scrolls by whole columns, so
 * a frame in which no deck crossed a column boundary has nothing to draw.
 */
export function scrollColumn(pos: number, pxPerSec: number): number {
    const c = Math.round(pos * pxPerSec);
    return Number.isFinite(c) ? c : 0;
}

/** Display gain that brings a track whose loudest point is `peak` (0..255) to full height. */
export function trackGain(peak: number): number {
    return peak > 0 ? Math.min(4, 255 / peak) : 1;
}

function clamp01Range(p: number, max: number): number {
    if (!Number.isFinite(p) || p < 0) return 0;
    return p > max ? max : p;
}

/** Keep a seek target inside the track; never on the very end (that would stop the deck). */
export function clampSeek(sec: number, duration: number): number {
    return clamp01Range(sec, Math.max(0, duration - 0.05));
}

/** Position while dragging the wave by `deltaPx` (grab: the content follows the pointer). */
export function dragTarget(startPos: number, deltaPx: number, pxPerSec: number, duration: number): number {
    if (!(pxPerSec > 0)) return clampSeek(startPos, duration);
    return clampSeek(startPos - deltaPx / pxPerSec, duration);
}

/** Position `beats` beats away on the deck's grid (keeps the offset inside the beat). */
export function seekByBeats(grid: GridModel | null, pos: number, beats: number, duration: number): number {
    if (!grid || !(grid.bpm > 0)) return clampSeek(pos + beats * 0.5, duration);
    return clampSeek(timeAt(grid, beatAt(grid, pos) + beats), duration);
}

/** Beats per bar of the clock, 1..8 (4 when unknown). */
export function beatsPerBar(clock: Pick<ClockState, "beatsPerBar"> | null): number {
    const n = clock?.beatsPerBar;
    return n && n > 0 ? Math.min(8, Math.max(1, Math.round(n))) : 4;
}

/** Index of the lit beat cell of `deck` (0 = downbeat), or -1 when the deck has no beat. */
export function cellIndex(clock: Pick<ClockState, "beatsPerBar" | "decks"> | null, deck: DeckId): number {
    if (!clock) return -1;
    const bpb = beatsPerBar(clock);
    for (const dc of clock.decks) {
        if (dc.id !== deck) continue;
        if (!(dc.bpm > 0)) return -1;
        const pos = dc.barPhase ?? ((dc.beat % bpb) + bpb) % bpb;
        return Number.isFinite(pos) ? Math.min(bpb - 1, Math.max(0, Math.floor(pos))) : -1;
    }
    return -1;
}

/** Offsets closer than this to the master beat (in beats) read as "in phase". */
export const PHASE_LOCK = 0.03;

/**
 * Phase offset (beats, [-0.5, 0.5)) as the scale of the phase bar: -1..1, half a beat = the
 * whole half-track. Quantised so the DOM is only written when the bar would visibly move;
 * `coarse` (reduced motion) moves it in 1/16-beat steps instead of sweeping.
 */
export function phaseScale(offset: number, coarse: boolean): number {
    if (!Number.isFinite(offset)) return 0;
    const v = Math.max(-1, Math.min(1, offset * 2));
    const q = coarse ? 8 : 200;
    const r = Math.round(v * q) / q;
    return r === 0 ? 0 : r;
}

/** Extent of one deck layer on the amplitude axis and how its wave grows. */
export interface Span {
    a0: number;
    a1: number;
    /** 0 = mirrored around the centre; -1 = grows from `a1` towards `a0`; 1 = from `a0` to `a1`. */
    dir: -1 | 0 | 1;
}

/**
 * Layer `index` of `count` in a lane `thickness` px thick. With `halves` (overlay mode) the
 * first half of the decks grow away from the lane centre upwards and the rest downwards
 * ("stacked halves": deck A above the centre line, deck B below it).
 */
export function layerSpan(out: Span, index: number, count: number, thickness: number, halves: boolean): Span {
    const n = Math.max(1, count);
    out.a0 = Math.round((index * thickness) / n);
    out.a1 = Math.round(((index + 1) * thickness) / n);
    out.dir = !halves || n === 1 ? 0 : index < n / 2 ? -1 : 1;
    return out;
}

/** A predicted position that ran past the end of an active loop continues from its start. */
export function wrapLoop(p: number, from: number, active: boolean, loopStart: number, loopEnd: number): number {
    const len = loopEnd - loopStart;
    if (!active || !(len > 0) || from >= loopEnd || p < loopEnd) return p;
    return loopStart + ((p - loopEnd) % len);
}

/**
 * "Bars to the next hot cue" as a compact key `cue|bars|beat` (`cue` = 1..8, or 0 when the
 * count runs to the end of the track), "" when there is nothing to show. A string so a store
 * selector can return it and re-render only when the readout changes (once per beat).
 */
export function barsReadout(
    deck: Pick<DeckState, "loaded" | "duration" | "position" | "hotCues">,
    grid: GridModel | null,
    beatsPerBarCount = 4,
): string {
    if (!deck.loaded || !grid || !(deck.duration > 0)) return "";
    const cue = nextCueAhead(deck.hotCues, deck.position);
    const b = barsBetween(grid, deck.position, cue ? cue.sec : deck.duration, beatsPerBarCount);
    if (!b) return "";
    return `${cue ? cue.slot + 1 : 0}|${b.bars}|${b.beat}`;
}

export function parseBars(key: string): { cue: number; bars: number; beat: number } | null {
    const p = key.split("|");
    if (p.length !== 3) return null;
    const cue = Number(p[0]);
    const bars = Number(p[1]);
    const beat = Number(p[2]);
    return Number.isFinite(cue) && Number.isFinite(bars) && Number.isFinite(beat) ? { cue, bars, beat } : null;
}

function sameList(a: readonly (number | null)[], b: readonly (number | null)[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * Did anything the lane draws change between two snapshots of a deck? (A snapshot also
 * changes for the VU meter, a fader or an EQ knob: those must not repaint the waveform.)
 */
export function visualChanged(a: DeckState, b: DeckState): boolean {
    return a.position !== b.position || marksChanged(a, b);
}

/**
 * Did anything a lane draws besides the scroll position change? The position alone repaints a
 * lane only when it moved the wave by a whole device pixel (the frame loop checks that).
 */
export function marksChanged(a: DeckState, b: DeckState): boolean {
    return (
        a.loaded !== b.loaded ||
        a.trackId !== b.trackId ||
        a.duration !== b.duration ||
        a.bpm !== b.bpm ||
        a.firstBeat !== b.firstBeat ||
        a.loopActive !== b.loopActive ||
        a.loopStart !== b.loopStart ||
        a.loopEnd !== b.loopEnd ||
        a.stemsActive !== b.stemsActive ||
        !sameList(a.hotCues, b.hotCues) ||
        !sameList(a.stemGains, b.stemGains)
    );
}
