/**
 * Phrase band: a coarse map of a track's structure (intro / break / build / main / outro),
 * estimated from the three-band waveform and the beatgrid. Drawn as a thin strip on the
 * overview so the DJ sees where the energy changes without listening ahead.
 *
 * Method (deterministic, no ML): cut the track into blocks of `barsPerBlock` bars on the grid,
 * take each block's mean level (all bands) and mean bass level, scale both by the track's own
 * loud level (90th percentile of the blocks), then label:
 *   - main  : loud and bass-heavy
 *   - break : bass (nearly) gone
 *   - build : in between and rising into a `main` block
 *   - intro / outro : the quiet run at the very start / end
 * Neighbouring blocks with the same label merge into one phrase.
 *
 * Pure (no React, no DOM): covered by `node --test`.
 */
import { timeAt, type GridModel } from "../grid/markers.ts";

export type PhraseKind = "intro" | "break" | "build" | "main" | "outro";

export interface Phrase {
    kind: PhraseKind;
    fromSec: number;
    toSec: number;
}

export interface PhraseInput {
    /** Points per second of the lanes. */
    pps: number;
    low: Uint8Array;
    mid: Uint8Array;
    high: Uint8Array;
}

/** Bass share (of the track's loud bass level) under which a block has "no bass". */
export const BASS_GONE = 0.35;
/** Level share (of the track's loud level) from which a block is "loud". */
export const LOUD = 0.72;

function mean(lane: Uint8Array, from: number, to: number): number {
    const a = Math.max(0, Math.floor(from));
    const b = Math.min(lane.length, Math.ceil(to));
    if (b <= a) return 0;
    let s = 0;
    for (let i = a; i < b; i++) s += lane[i]!;
    return s / (b - a);
}

function percentile(values: readonly number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((x, y) => x - y);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!;
}

/**
 * Phrases of a track. Empty when there is no usable grid or wave, or the track is shorter than
 * two blocks (nothing to tell apart).
 */
export function detectPhrases(wave: PhraseInput | null, grid: GridModel | null, durationSec: number, beatsPerBar = 4, barsPerBlock = 8): Phrase[] {
    if (!wave || !grid || !(grid.bpm > 0) || !(durationSec > 0) || wave.pps <= 0 || wave.low.length === 0) return [];
    const blockBeats = Math.max(1, Math.round(beatsPerBar)) * Math.max(1, Math.round(barsPerBlock));
    // Block edges on the grid, starting at the first beat; audio before it joins the first block.
    const edges: number[] = [0];
    for (let n = 1; n < 4000; n++) {
        const t = timeAt(grid, n * blockBeats);
        if (!Number.isFinite(t) || t >= durationSec) break;
        if (t > edges[edges.length - 1]! + 0.5) edges.push(t);
    }
    edges.push(durationSec);
    const count = edges.length - 1;
    if (count < 2) return [];

    const level: number[] = [];
    const bass: number[] = [];
    for (let i = 0; i < count; i++) {
        const from = edges[i]! * wave.pps;
        const to = edges[i + 1]! * wave.pps;
        const lo = mean(wave.low, from, to);
        bass.push(lo);
        level.push((lo + mean(wave.mid, from, to) + mean(wave.high, from, to)) / 3);
    }
    const loudLevel = percentile(level, 0.9);
    const loudBass = percentile(bass, 0.9);
    if (!(loudLevel > 0)) return [];

    const rel = level.map((v) => v / loudLevel);
    const relBass = bass.map((v) => (loudBass > 0 ? v / loudBass : 0));
    const kinds: PhraseKind[] = rel.map((v, i) => (relBass[i]! < BASS_GONE ? "break" : v >= LOUD ? "main" : "build"));
    // "build" only when it actually leads into a main block; otherwise it is a calmer main part.
    for (let i = 0; i < count; i++) {
        if (kinds[i] !== "build") continue;
        const next = kinds[i + 1];
        const rising = i + 1 < count && rel[i + 1]! > rel[i]!;
        if (!(next === "main" && rising) && !(next === "build")) kinds[i] = rel[i]! >= LOUD * 0.8 ? "main" : "break";
    }
    for (let i = count - 2; i >= 0; i--) if (kinds[i] === "build" && kinds[i + 1] !== "build" && kinds[i + 1] !== "main") kinds[i] = "break";
    // The quiet run at the start is the intro, at the end the outro (never the whole track).
    // A build keeps its name: it is the part the DJ wants to see coming.
    for (let i = 0; i < count - 1 && kinds[i] === "break"; i++) kinds[i] = "intro";
    for (let i = count - 1; i > 0 && kinds[i] === "break"; i--) kinds[i] = "outro";

    const out: Phrase[] = [];
    for (let i = 0; i < count; i++) {
        const last = out[out.length - 1];
        if (last && last.kind === kinds[i]) last.toSec = edges[i + 1]!;
        else out.push({ kind: kinds[i]!, fromSec: edges[i]!, toSec: edges[i + 1]! });
    }
    return out;
}

/** The phrase that contains `sec`, or null. */
export function phraseAt(phrases: readonly Phrase[], sec: number): Phrase | null {
    for (const p of phrases) if (sec >= p.fromSec && sec < p.toSec) return p;
    return null;
}
