/**
 * Flexible beatgrid maths (WP19-37), shared by the waveform and the grid editor.
 *
 * A grid is a first beat, a starting tempo and a list of **tempo-change markers**
 * `{sec, bpm}` ("from here on the tempo is bpm"), mirroring Rust
 * `mixai_core::beatgrid` and the library's `GridAnchor`s. `fixed` means the markers
 * are kept but ignored: the grid behaves as the constant `bpm` + first-beat grid.
 *
 * Pure functions only (no React, no Tauri) so `node --test` can cover them.
 */

import type { BeatGrid, GridAnchor } from "../bridge/types.ts";

/** One tempo change: from `sec` on, the tempo is `bpm`. */
export interface TempoMarker {
    sec: number;
    bpm: number;
}

/** A track's editable grid. */
export interface GridModel {
    /** Tempo from `firstBeat` to the first marker. */
    bpm: number;
    firstBeat: number;
    /** Markers in time order, each a real tempo change. */
    markers: TempoMarker[];
    /** Fixed-grid toggle: markers kept, grid constant. */
    fixed: boolean;
}

/** Two tempos closer than this (relative) are the same tempo. */
export const BPM_TOLERANCE = 0.0005;
/** Two markers closer than this (seconds) are the same marker. */
export const MARKER_EPSILON = 1e-3;

const MIN_BPM = 20;
const MAX_BPM = 400;

export function sameTempo(a: number, b: number): boolean {
    return Math.abs(a - b) <= BPM_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
}

export function isValidBpm(bpm: number): boolean {
    return Number.isFinite(bpm) && bpm >= MIN_BPM && bpm <= MAX_BPM;
}

/**
 * Sort by time, keep the last of markers at the same time, drop every marker that does not
 * change the running tempo (starting at `bpm`) and anything non-finite / out of range.
 */
export function mergeMarkers(bpm: number, markers: readonly TempoMarker[]): TempoMarker[] {
    const sorted = markers.filter((m) => Number.isFinite(m.sec) && isValidBpm(m.bpm)).sort((a, b) => a.sec - b.sec);
    const unique: TempoMarker[] = [];
    for (const m of sorted) {
        const last = unique.at(-1);
        if (last && Math.abs(m.sec - last.sec) < MARKER_EPSILON) unique[unique.length - 1] = m;
        else unique.push(m);
    }
    const out: TempoMarker[] = [];
    let cur = bpm;
    for (const m of unique) {
        if (!sameTempo(m.bpm, cur)) {
            out.push(m);
            cur = m.bpm;
        }
    }
    return out;
}

/** Normalise a model: valid starting tempo, non-negative first beat, merged markers. */
export function normaliseGrid(g: GridModel): GridModel {
    let bpm = g.bpm;
    let firstBeat = Math.max(0, Number.isFinite(g.firstBeat) ? g.firstBeat : 0);
    // A marker at (or before) the first beat is the starting tempo, not a change.
    const rest: TempoMarker[] = [];
    for (const m of [...g.markers].sort((a, b) => a.sec - b.sec)) {
        if (!Number.isFinite(m.sec) || !isValidBpm(m.bpm)) continue;
        if (m.sec <= firstBeat + 1e-9) bpm = m.bpm;
        else rest.push(m);
    }
    if (!isValidBpm(bpm)) bpm = MIN_BPM;
    return { bpm, firstBeat, markers: mergeMarkers(bpm, rest), fixed: g.fixed };
}

/** Tempo in force at source time `sec` (the constant tempo when `fixed`). */
export function bpmAt(g: GridModel, sec: number): number {
    if (g.fixed) return g.bpm;
    let bpm = g.bpm;
    for (const m of g.markers) {
        if (m.sec > sec) break;
        bpm = m.bpm;
    }
    return bpm;
}

/** Fractional beat number at source time `sec` (beat 0 = `firstBeat`). */
export function beatAt(g: GridModel, sec: number): number {
    if (g.fixed || g.markers.length === 0) return ((sec - g.firstBeat) * g.bpm) / 60;
    let t = g.firstBeat;
    let beat = 0;
    let bpm = g.bpm;
    for (const m of g.markers) {
        if (m.sec >= sec) break;
        beat += ((m.sec - t) * bpm) / 60;
        t = m.sec;
        bpm = m.bpm;
    }
    return beat + ((sec - t) * bpm) / 60;
}

/** Source time of (fractional) beat `beat`. */
export function timeAt(g: GridModel, beat: number): number {
    if (g.fixed || g.markers.length === 0) return g.firstBeat + (beat * 60) / g.bpm;
    let t = g.firstBeat;
    let b = 0;
    let bpm = g.bpm;
    for (const m of g.markers) {
        const next = b + ((m.sec - t) * bpm) / 60;
        if (next >= beat) break;
        b = next;
        t = m.sec;
        bpm = m.bpm;
    }
    return t + ((beat - b) * 60) / bpm;
}

/** Time of the beat nearest to `sec` (used to snap a new marker to the grid). */
export function snapToBeat(g: GridModel, sec: number): number {
    return timeAt(g, Math.round(beatAt(g, sec)));
}

/** Tempo step of the editor's ± controls. */
export const BPM_STEP = 0.1;

/**
 * Starting tempo of a marker added at `sec`: one step above the running tempo, because a
 * marker at the same tempo is not a change and would be merged away.
 */
export function newMarkerBpm(g: GridModel, sec: number): number {
    return Math.min(MAX_BPM, Math.round((bpmAt(g, sec) + BPM_STEP) * 1000) / 1000);
}

/**
 * Beat times in `[from, to]` for drawing, each with its beat number and whether it is a
 * downbeat (`beat % beatsPerBar === 0`). Capped at `limit` lines so a wild BPM cannot hang
 * the canvas.
 */
export function beatLines(
    g: GridModel,
    from: number,
    to: number,
    beatsPerBar = 4,
    limit = 4096,
): { sec: number; beat: number; downbeat: boolean }[] {
    const out: { sec: number; beat: number; downbeat: boolean }[] = [];
    if (!isValidBpm(g.bpm) || !(to > from)) return out;
    const bar = Math.max(1, Math.round(beatsPerBar));
    let beat = Math.ceil(beatAt(g, from) - 1e-9);
    while (out.length < limit) {
        const sec = timeAt(g, beat);
        if (sec > to) break;
        if (sec >= from) out.push({ sec, beat, downbeat: ((beat % bar) + bar) % bar === 0 });
        beat += 1;
    }
    return out;
}

/** Add (or replace) a tempo change. A marker at the first beat changes the starting tempo. */
export function addMarker(g: GridModel, sec: number, bpm: number): GridModel {
    if (!Number.isFinite(sec) || !isValidBpm(bpm)) return g;
    const at = Math.max(0, sec);
    if (at <= g.firstBeat + 1e-9) return normaliseGrid({ ...g, bpm });
    const markers = g.markers.filter((m) => Math.abs(m.sec - at) > MARKER_EPSILON);
    markers.push({ sec: at, bpm });
    return normaliseGrid({ ...g, markers });
}

/** Index of the marker nearest to `sec` within `tolerance`, or −1. */
export function markerIndexNear(g: GridModel, sec: number, tolerance: number): number {
    let best = -1;
    let bestD = Math.abs(tolerance);
    g.markers.forEach((m, i) => {
        const d = Math.abs(m.sec - sec);
        if (d <= bestD) {
            best = i;
            bestD = d;
        }
    });
    return best;
}

/** Move and/or retune marker `index`. */
export function moveMarker(g: GridModel, index: number, sec: number, bpm?: number): GridModel {
    const m = g.markers[index];
    if (!m) return g;
    const next = { sec: Math.max(0, Number.isFinite(sec) ? sec : m.sec), bpm: bpm !== undefined && isValidBpm(bpm) ? bpm : m.bpm };
    const markers = g.markers.map((x, i) => (i === index ? next : x));
    return normaliseGrid({ ...g, markers });
}

/** Nudge marker `index` by `deltaSec` (keyboard editing). */
export function nudgeMarker(g: GridModel, index: number, deltaSec: number): GridModel {
    const m = g.markers[index];
    return m ? moveMarker(g, index, m.sec + deltaSec) : g;
}

/** Change only the tempo of marker `index`. */
export function retuneMarker(g: GridModel, index: number, bpm: number): GridModel {
    const m = g.markers[index];
    return m ? moveMarker(g, index, m.sec, bpm) : g;
}

export function removeMarker(g: GridModel, index: number): GridModel {
    if (!g.markers[index]) return g;
    return normaliseGrid({ ...g, markers: g.markers.filter((_, i) => i !== index) });
}

export function setFixed(g: GridModel, fixed: boolean): GridModel {
    return { ...g, fixed };
}

// ---- bridge conversions ----------------------------------------------------

/** Grid model from a deck snapshot (constant grid: BPM + first beat). */
export function gridFromDeck(bpm: number, firstBeat: number, markers: readonly TempoMarker[] = [], fixed = false): GridModel {
    return normaliseGrid({ bpm: isValidBpm(bpm) ? bpm : MIN_BPM, firstBeat, markers: [...markers], fixed });
}

/** Engine `BeatGrid` (time → beat anchors) for `deck_set_beatgrid`. */
export function toBeatGrid(g: GridModel, downbeat: number | null = 0, beatsPerBar = 4): BeatGrid {
    const anchors: GridAnchor[] = [];
    if (!g.fixed && g.markers.length > 0) {
        anchors.push({ time: g.firstBeat, beat: 0 });
        let t = g.firstBeat;
        let beat = 0;
        let bpm = g.bpm;
        for (const m of g.markers) {
            beat += ((m.sec - t) * bpm) / 60;
            t = m.sec;
            bpm = m.bpm;
            anchors.push({ time: t, beat });
        }
        // Trailing anchor so the last segment keeps its tempo past the last marker.
        anchors.push({ time: t + 60 / bpm, beat: beat + 1 });
    }
    return { bpm: g.bpm, firstBeat: g.firstBeat, downbeat, beatsPerBar, anchors };
}

/** Grid model from an engine `BeatGrid` (inverse of {@link toBeatGrid}). */
export function fromBeatGrid(grid: BeatGrid, fixed = false): GridModel {
    const anchors = [...(grid.anchors ?? [])].sort((a, b) => a.time - b.time);
    const firstBeat = grid.firstBeat ?? 0;
    if (anchors.length < 2) return gridFromDeck(grid.bpm, firstBeat, [], fixed);
    const segBpm = (i: number) => ((anchors[i + 1]!.beat - anchors[i]!.beat) / (anchors[i + 1]!.time - anchors[i]!.time)) * 60;
    const markers: TempoMarker[] = [];
    let prev = segBpm(0);
    for (let i = 1; i < anchors.length - 1; i++) {
        const bpm = segBpm(i);
        if (!sameTempo(bpm, prev)) {
            markers.push({ sec: anchors[i]!.time, bpm });
            prev = bpm;
        }
    }
    return normaliseGrid({ bpm: segBpm(0), firstBeat: anchors[0]!.time, markers, fixed });
}
