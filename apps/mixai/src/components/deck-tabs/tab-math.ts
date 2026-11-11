/**
 * Pure helpers of the deck tab bodies (hot cues, loops, stems): labels, loop sizes, stem gains
 * and the render gate of the bodies. No React, no DOM.
 */
import { beatAt, type GridModel } from "../../grid/markers.ts";

// ── hot cues ─────────────────────────────────────────────────────────────────

/** `m:ss` of a cue point (whole seconds, floored). */
export function fmtCueTime(sec: number): string {
    const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── loops ────────────────────────────────────────────────────────────────────

/** `m:ss.t` of a loop boundary. */
export function fmtLoopTime(sec: number): string {
    const tenths = Number.isFinite(sec) && sec > 0 ? Math.floor(sec * 10) : 0;
    const s = Math.floor(tenths / 10);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${tenths % 10}`;
}

/** Beat-loop sizes of the LOOP tab, in beats. */
export const LOOP_SIZES = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32] as const;

/** A beat count as a DJ reads it: `1/8`, `1/2`, `4`, `3.5`. */
export function beatsLabel(beats: number): string {
    if (!Number.isFinite(beats) || !(beats > 0)) return "0";
    if (beats >= 1) return Number.isInteger(beats) ? String(beats) : String(Math.round(beats * 10) / 10);
    const inv = 1 / beats;
    return Math.abs(inv - Math.round(inv)) < 1e-9 ? `1/${Math.round(inv)}` : String(Math.round(beats * 100) / 100);
}

/** Length of the loop `[start, end]` in beats on the deck's grid (null = no loop / no grid). */
export function loopBeats(grid: GridModel | null, start: number, end: number): number | null {
    if (!grid || !(grid.bpm > 0) || !(end > start)) return null;
    const beats = beatAt(grid, end) - beatAt(grid, start);
    return Number.isFinite(beats) && beats > 0 ? beats : null;
}

/** The LOOP tab size a loop of `beats` corresponds to (within `tolerance`, relative), or null. */
export function matchLoopSize(beats: number | null, tolerance = 0.02): number | null {
    if (beats === null || !Number.isFinite(beats)) return null;
    for (const size of LOOP_SIZES) if (Math.abs(beats - size) <= size * tolerance) return size;
    return null;
}

/** Loop length for display: the nearby musical size when there is one, else the measured beats. */
export function loopLabel(beats: number): string {
    const size = matchLoopSize(beats);
    if (size !== null) return beatsLabel(size);
    if (beats > 0 && beats < 1) {
        const inv = Math.round(1 / beats);
        if (Math.abs(beats * inv - 1) <= 0.02) return `1/${inv}`;
    }
    const near = Math.round(beats);
    if (near >= 1 && Math.abs(beats - near) <= near * 0.02) return String(near);
    return beatsLabel(beats);
}

// ── stems ────────────────────────────────────────────────────────────────────

/**
 * First id the development hook (`src/dev/dev-hooks.ts`, `window.__decks.load`) gives a file it
 * loads through the library loader. Those tracks are not in the companion library. Only a
 * development build has that hook: in production every numeric id is a real library id.
 */
export const DEV_TRACK_ID_BASE = 900_000;

/** True in a development build (the dev hooks exist only there); false under `node --test`. */
const DEV_BUILD = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

/**
 * The deck's track is a companion LIBRARY track (the only kind the companion can separate into
 * stems): its id is a positive whole number. Local files carry their path as the id. In a
 * development build (`dev`) the demo tracks loaded by the dev hook, with an id from
 * {@link DEV_TRACK_ID_BASE} up, are not library tracks either; a production library with that
 * many tracks keeps all of them.
 */
export function isLibraryTrackId(trackId: string | null | undefined, dev: boolean = DEV_BUILD): boolean {
    if (!trackId || !/^[0-9]+$/.test(trackId)) return false;
    const id = Number(trackId);
    return Number.isSafeInteger(id) && id > 0 && (!dev || id < DEV_TRACK_ID_BASE);
}

/** A stem at or below this gain counts as muted. */
export const STEM_MUTE_EPS = 0.001;

export type StemGains = [number, number, number, number];

/** The four stem gains [vocals, drums, bass, melody]; missing values are unity. */
export function stemGains(g: readonly number[] | null | undefined): StemGains {
    return [g?.[0] ?? 1, g?.[1] ?? 1, g?.[2] ?? 1, g?.[3] ?? 1];
}

export function stemMuted(gain: number): boolean {
    return gain <= STEM_MUTE_EPS;
}

/**
 * The soloed stem: the only audible one while the other three are muted (null = no solo).
 * Derived from the gains the engine reports, so it survives a tab switch (a local "solo" flag
 * was lost whenever the tab body unmounted, leaving a solo that could not be released).
 */
export function soloIndex(gains: readonly number[]): number | null {
    let audible = -1;
    for (let i = 0; i < 4; i++) {
        if (stemMuted(gains[i] ?? 1)) continue;
        if (audible >= 0) return null;
        audible = i;
    }
    return audible >= 0 ? audible : null;
}

// ── render gating ────────────────────────────────────────────────────────────

function sameValue(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
        return true;
    }
    return false;
}

/**
 * True when `a` and `b` agree on `keys` (arrays compared element by element). The engine
 * snapshot replaces a playing deck's object ~30 times a second (the position moves); a tab
 * body that only shows cues or FX compares the fields it uses and skips those renders.
 */
export function sameFields<T extends object>(a: T, b: T, keys: readonly (keyof T)[]): boolean {
    if (a === b) return true;
    for (const k of keys) if (!sameValue(a[k], b[k])) return false;
    return true;
}

/**
 * `React.memo` comparator for a component with a `deck` prop: every other prop by identity,
 * the deck by the `keys` the component reads.
 */
export function deckPropsEqual<D extends object, P extends { deck: D }>(keys: readonly (keyof D)[]): (a: P, b: P) => boolean {
    return (a, b) => {
        const names = Object.keys(b) as (keyof P)[];
        if (names.length !== Object.keys(a).length) return false;
        for (const k of names) {
            if (k === "deck") continue;
            if (!Object.is(a[k], b[k])) return false;
        }
        return sameFields(a.deck, b.deck, keys);
    };
}
