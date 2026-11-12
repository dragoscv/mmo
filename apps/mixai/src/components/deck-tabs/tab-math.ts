/**
 * Pure helpers of the deck tab bodies (hot cues, loops, stems): labels, loop sizes, stem gains
 * and the render gate of the bodies. No React, no DOM.
 */
import { beatAt, type GridModel } from "../../grid/markers.ts";
import { pluralCategory } from "../../library/track-view.ts";

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

/** Plural form of a counted word, as the catalogues name it (`<key>.one` / `.few` / `.other`). */
export type PluralForm = "one" | "few" | "other";

/**
 * Plural form of "beat" after a beat count as it is SHOWN ({@link beatsLabel} / {@link loopLabel}).
 * A fraction of a beat (`1/2`, `1/8`) reads as one: "1/2 beat", "1/2 bătaie". Everything else
 * follows the language's own rule (the same one as the track count and the Copilot's bars):
 * English "1 beat", "2 beats"; Romanian "1 bătaie", "2 bătăi", "20 de bătăi", "101 bătăi".
 */
export function beatsPlural(label: string, locale: string): PluralForm {
    if (label.includes("/")) return "one";
    const n = Number(label);
    return Number.isFinite(n) ? pluralCategory(n, locale) : "other";
}

// ── armed pad actions (clear a cue, cue loops) ───────────────────────────────

/** What an armed "loop on a cue" button does to the next pad: store the running loop on it, or take its stored loop off. */
export type CueLoopMode = "save" | "remove";
/** An armed pad action: the next pad pressed is cleared, gets the running loop, or loses its loop. */
export type PadArmKind = "clear" | CueLoopMode;

/** The deck state the armed pad actions depend on. */
export interface PadArmContext {
    loaded: boolean;
    /** A loop is running. */
    loopActive: boolean;
    /** A shown hot cue carries a loop. */
    anyCueLoop: boolean;
    /** A shown hot cue is set. */
    anySet: boolean;
}

/** What the "loop on a cue" button offers right now: store the running loop, take a stored loop off, or nothing. */
export function cueLoopOffer(c: Pick<PadArmContext, "loaded" | "loopActive" | "anyCueLoop">): CueLoopMode | null {
    if (!c.loaded) return null;
    if (c.loopActive) return "save";
    return c.anyCueLoop ? "remove" : null;
}

/** An armed pad action, with the track it was armed on. The kind is fixed when the button is pressed. */
export interface PadArm {
    kind: PadArmKind;
    trackId: string | null;
}

/**
 * The armed action that still stands, or null when it must be dropped: another track is on the
 * deck, or the deck is no longer in the state the action was armed in ("save" needs the loop to
 * be running still, "remove" needs no loop running and a cue loop to take off, "clear" needs a
 * set cue). Without this an armed "save" outlived its loop and silently became something else:
 * a "remove" on the next cue-loop pad, or a "save" of some later loop on a pad pressed to jump.
 */
export function padArmLive(arm: PadArm | null, trackId: string | null, c: PadArmContext): PadArmKind | null {
    if (!arm || arm.trackId !== trackId) return null;
    if (arm.kind === "clear") return c.loaded && c.anySet ? "clear" : null;
    return cueLoopOffer(c) === arm.kind ? arm.kind : null;
}

/** What a press on a hot-cue pad does. */
export type PadPress = "clear" | "saveLoop" | "removeLoop" | "jump" | "set";

export interface PadPressInput {
    /** The pad's cue is set. */
    isSet: boolean;
    /** The pad's cue carries a loop. */
    hasLoop: boolean;
    shift: boolean;
    alt: boolean;
    /** The armed action that still stands ({@link padArmLive}). */
    arm: PadArmKind | null;
    /** A loop is running. */
    loopActive: boolean;
}

/**
 * The action of a pad press. Shift (or an armed clear on a set pad) clears; an armed "save"
 * stores the running loop on any pad; an armed "remove" takes the loop off a pad that has one;
 * Alt stores the running loop in one step; otherwise a set pad jumps and an empty one is set.
 * "save" and "remove" are checked against the loop state once more here, so a stale arm can
 * never turn a jump into the opposite action.
 */
export function padPress(p: PadPressInput): PadPress {
    if (p.shift || (p.arm === "clear" && p.isSet)) return "clear";
    if (p.arm === "save" && p.loopActive) return "saveLoop";
    if (p.arm === "remove" && !p.loopActive && p.hasLoop) return "removeLoop";
    if (p.alt && p.loopActive) return "saveLoop";
    return p.isSet ? "jump" : "set";
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

/** One command the engine needs after the stem gains went from `prev` to `next`. */
export interface StemChange {
    idx: number;
    /** `mute` / `unmute` = the stem crossed the mute threshold (the engine's mute FX hooks on these); `gain` = a level move. */
    kind: "mute" | "unmute" | "gain";
    gain: number;
}

/**
 * What changed between two sets of stem gains, as engine commands: a stem that became silent
 * is a MUTE (so the mute FX can leave its echo tail), one that came back is an UNMUTE, any
 * other difference is a level move. Unchanged stems give nothing.
 */
export function stemChanges(prev: readonly number[], next: readonly number[]): StemChange[] {
    const out: StemChange[] = [];
    for (let idx = 0; idx < 4; idx++) {
        const a = prev[idx] ?? 1;
        const b = next[idx] ?? 1;
        if (a === b) continue;
        const was = stemMuted(a);
        const is = stemMuted(b);
        if (is && !was) out.push({ idx, kind: "mute", gain: 0 });
        else if (was && !is && b === 1) out.push({ idx, kind: "unmute", gain: 1 });
        else out.push({ idx, kind: "gain", gain: b });
    }
    return out;
}

// ── stem crossfader ──────────────────────────────────────────────────────────

/** The stem crossfader control runs −100..100 in steps of 5 (0 = centre: the stem follows the deck). */
export const XF_SLIDER_MAX = 100;
export const XF_SLIDER_STEP = 5;
/** A pointer drag that ends this close to the centre snaps to it (the centre detent). */
export const XF_MAGNET = 10;

function clampXf(pos: number): number {
    return Number.isFinite(pos) ? Math.min(1, Math.max(-1, pos)) : 0;
}

/** The four stem crossfader positions (−1 = side A .. +1 = side B); missing or junk values are the centre. */
export function stemXfValues(xf: readonly number[] | null | undefined): StemGains {
    return [clampXf(xf?.[0] ?? 0), clampXf(xf?.[1] ?? 0), clampXf(xf?.[2] ?? 0), clampXf(xf?.[3] ?? 0)];
}

/** Engine position (−1..1) → control value (−100..100, whole numbers). */
export function xfToSlider(pos: number): number {
    const v = Math.round(clampXf(pos) * XF_SLIDER_MAX);
    return v === 0 ? 0 : v;
}

/**
 * Control value → engine position. `magnet` > 0 (a pointer drag) snaps values that close to
 * the centre onto it; the keyboard passes 0, or its steps could never leave the centre.
 */
export function xfFromSlider(raw: number, magnet = 0): number {
    if (!Number.isFinite(raw)) return 0;
    const v = Math.min(XF_SLIDER_MAX, Math.max(-XF_SLIDER_MAX, raw));
    return Math.abs(v) <= magnet ? 0 : v / XF_SLIDER_MAX;
}

/** What the control says: the side it leans to (null = centre) and how far, in percent. */
export function xfReadout(pos: number): { side: "a" | "b" | null; pct: number } {
    const pct = Math.abs(xfToSlider(pos));
    return { side: pct === 0 ? null : pos < 0 ? "a" : "b", pct };
}

/** Where the thumb sits along the track, 0 (side A) .. 1 (side B). */
export function xfThumb(pos: number): number {
    return (clampXf(pos) + 1) / 2;
}

// ── stem mute FX ─────────────────────────────────────────────────────────────

/** Echo times of the stem mute FX, in beats. */
export const MUTE_FX_BEATS = [0.25, 0.5, 1, 2] as const;
/** Echo time used until the engine reports one. */
export const MUTE_FX_DEFAULT_BEATS = 0.5;

/** The listed echo time `beats` stands for, or −1 when it is none of them (no cell selected). */
export function muteFxChoice(beats: number | null | undefined): number {
    const b = beats ?? MUTE_FX_DEFAULT_BEATS;
    return MUTE_FX_BEATS.find((v) => Math.abs(b - v) < 1e-6) ?? -1;
}

// ── cue loops ────────────────────────────────────────────────────────────────

/** Loop length in beats stored on hot cue `slot` (null = a plain cue, or an engine that has no cue loops). */
export function cueLoopBeats(loops: readonly (number | null | undefined)[] | null | undefined, slot: number): number | null {
    const b = loops?.[slot];
    return typeof b === "number" && Number.isFinite(b) && b > 0 ? b : null;
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
