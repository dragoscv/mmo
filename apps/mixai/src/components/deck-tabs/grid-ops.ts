/**
 * Whole-grid operations of the GRID tab that `src/grid/markers.ts` (per-marker edits) does not
 * have: shift the grid, move the downbeat, halve / double the tempo, tap tempo, plus the undo
 * stack and the paging of the marker list. Pure (no React, no engine).
 */
import { beatAt, isValidBpm, normaliseGrid, retuneMarker, timeAt, type GridModel } from "../../grid/markers.ts";

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** Same grid by value. */
export function sameGrid(a: GridModel, b: GridModel): boolean {
    if (a === b) return true;
    if (a.bpm !== b.bpm || a.firstBeat !== b.firstBeat || a.fixed !== b.fixed || a.markers.length !== b.markers.length) return false;
    for (let i = 0; i < a.markers.length; i++) {
        const x = a.markers[i]!;
        const y = b.markers[i]!;
        if (x.sec !== y.sec || x.bpm !== y.bpm) return false;
    }
    return true;
}

/**
 * Move the whole grid (first beat and every tempo marker) by `deltaSec`. A constant grid that
 * would start before the file wraps to the same grid one or more beats later; a grid with
 * markers is left alone in that case (wrapping would move it across a tempo change).
 */
export function shiftGrid(g: GridModel, deltaSec: number): GridModel {
    if (!Number.isFinite(deltaSec) || deltaSec === 0) return g;
    let first = g.firstBeat + deltaSec;
    if (first < 0) {
        if (g.markers.length > 0 || !isValidBpm(g.bpm)) return g;
        const period = 60 / g.bpm;
        first += Math.ceil(-first / period) * period;
    }
    return normaliseGrid({
        ...g,
        firstBeat: round6(first),
        markers: g.markers.map((m) => ({ sec: round6(m.sec + deltaSec), bpm: m.bpm })),
    });
}

/**
 * Make the beat nearest to `sec` a downbeat. The UI counts bars from the first beat (beat 0 is
 * bar 1, beat 1), so this moves the first beat along the existing beats: no beat line moves,
 * only which of them starts the bar. A constant grid keeps the earliest such beat in the file.
 */
export function downbeatAt(g: GridModel, sec: number, beatsPerBar = 4): GridModel {
    if (!Number.isFinite(sec) || !isValidBpm(g.bpm)) return g;
    const bar = Math.max(1, Math.round(beatsPerBar));
    const beat = Math.round(beatAt(g, sec));
    const k = ((beat % bar) + bar) % bar;
    if (k === 0) return g;
    let first = timeAt(g, k);
    if (g.fixed || g.markers.length === 0) {
        const barSec = (bar * 60) / g.bpm;
        first -= Math.floor(first / barSec) * barSec;
    } else if (g.markers.some((m) => m.sec <= first + 1e-9)) {
        // The new first beat would pass a tempo marker, which would turn that marker into the
        // starting tempo and move every beat after it: leave the grid alone.
        return g;
    }
    if (!(first >= 0)) return g;
    return normaliseGrid({ ...g, firstBeat: round6(first) });
}

/** Every tempo of the grid times `factor` stays a tempo the engine accepts. */
export function canScaleTempo(g: GridModel, factor: number): boolean {
    return isValidBpm(g.bpm * factor) && g.markers.every((m) => isValidBpm(m.bpm * factor));
}

/** Multiply every tempo of the grid (×2, ÷2). Unchanged when a tempo would leave 20..400. */
export function scaleTempo(g: GridModel, factor: number): GridModel {
    if (!canScaleTempo(g, factor)) return g;
    return normaliseGrid({ ...g, bpm: g.bpm * factor, markers: g.markers.map((m) => ({ sec: m.sec, bpm: m.bpm * factor })) });
}

/** Set the tempo in force at `sec`: the marker that governs it, or the starting tempo. */
export function retuneAt(g: GridModel, sec: number, bpm: number): GridModel {
    if (!isValidBpm(bpm)) return g;
    if (!g.fixed) {
        let index = -1;
        g.markers.forEach((m, i) => {
            if (m.sec <= sec) index = i;
        });
        if (index >= 0) return retuneMarker(g, index, bpm);
    }
    return normaliseGrid({ ...g, bpm });
}

// ── tap tempo ────────────────────────────────────────────────────────────────

/** A pause longer than this starts a new tap run. */
export const TAP_RESET_MS = 2000;
/** Taps needed before a tempo is trusted. */
export const TAP_MIN_TAPS = 4;
/** Faster than 400 BPM is a key repeat or a bounce, not a tap. */
export const TAP_MIN_INTERVAL_MS = 150;
/** Taps kept for the average. */
export const TAP_KEEP = 9;

/** The tap run after a tap at `now` (ms). */
export function addTap(taps: readonly number[], now: number): number[] {
    const last = taps.at(-1);
    if (last === undefined || now - last > TAP_RESET_MS) return [now];
    if (now - last < TAP_MIN_INTERVAL_MS) return [...taps];
    return [...taps, now].slice(-TAP_KEEP);
}

/** Tempo of a tap run, to 0.1 BPM (null = too few taps or not a tempo). */
export function tapBpm(taps: readonly number[]): number | null {
    if (taps.length < TAP_MIN_TAPS) return null;
    const span = taps.at(-1)! - taps[0]!;
    if (!(span > 0)) return null;
    const bpm = Math.round(((60000 * (taps.length - 1)) / span) * 10) / 10;
    return isValidBpm(bpm) ? bpm : null;
}

// ── undo ─────────────────────────────────────────────────────────────────────

export interface UndoEntry {
    /** The grid before the edit. */
    grid: GridModel;
    /** What kind of edit followed (`shift`, `tap`, `nudge:2`…); equal tags close together merge. */
    tag: string;
    at: number;
}

export const UNDO_DEPTH = 32;
/** Edits with the same tag closer than this are one undo step (held arrow key, tap run). */
export const UNDO_MERGE_MS = 1000;

/** Record `grid` as the state before an edit tagged `tag` at `now` (ms). */
export function pushUndo(
    stack: readonly UndoEntry[],
    grid: GridModel,
    tag: string,
    now: number,
    mergeMs = UNDO_MERGE_MS,
): { stack: UndoEntry[]; pushed: boolean } {
    const top = stack.at(-1);
    if (top && tag !== "" && top.tag === tag && now - top.at < mergeMs) {
        return { stack: [...stack.slice(0, -1), { ...top, at: now }], pushed: false };
    }
    return { stack: [...stack, { grid, tag, at: now }].slice(-UNDO_DEPTH), pushed: true };
}

// ── marker list ──────────────────────────────────────────────────────────────

/** Markers per page in the marker popover (a list never scrolls). */
export const MARKER_PAGE = 6;

export function pageCount(n: number, size = MARKER_PAGE): number {
    return Math.max(1, Math.ceil(n / size));
}
