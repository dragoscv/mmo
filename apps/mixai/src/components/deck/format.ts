/**
 * Pure helpers of the deck panel (no React, no DOM): readout formatting, overview seeking,
 * ruler density, the platter angle and the size thresholds of the full tier.
 * Covered by `node --test` (format.test.ts).
 */
import type { DeckId } from "../../bridge/types.ts";

export const TEMPO_MIN = 0.5;
export const TEMPO_MAX = 1.5;
/** One nudge of the tempo buttons: 0.1 %. */
export const TEMPO_STEP = 0.001;

/** Box width (px, padding included) from which the full tier uses its wide arrangement. */
export const WIDE_MIN_W = 600;
/** Box height (px, padding included) under which the full tier tightens its rows. */
export const SHORT_MAX_H = 296;
/** Compact tier: PLAY shows its word next to the icon from this box width. */
export const COMPACT_LABEL_MIN_W = 380;

export function clampTempo(v: number): number {
    if (!Number.isFinite(v)) return 1;
    return Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, v));
}

/** Tempo fader position 0..1 (0.5 = original tempo). */
export function tempoPosition(tempo: number): number {
    return (clampTempo(tempo) - TEMPO_MIN) / (TEMPO_MAX - TEMPO_MIN);
}

/** "+1.2%" / "−0.4%": always signed, one decimal, never "−0.0%". */
export function formatTempo(tempo: number): string {
    const tenths = Math.round((clampTempo(tempo) - 1) * 1000);
    return `${tenths < 0 ? "\u2212" : "+"}${(Math.abs(tenths) / 10).toFixed(1)}%`;
}

/** True when the tempo is off the original by at least the display resolution (0.1 %). */
export function tempoShifted(tempo: number): boolean {
    return Math.round((clampTempo(tempo) - 1) * 1000) !== 0;
}

/** 129.2 → { main: "129", frac: "20" } for a two-size readout; null when the tempo is unknown. */
export function splitBpm(bpm: number): { main: string; frac: string } | null {
    if (!Number.isFinite(bpm) || bpm <= 0) return null;
    const hundredths = Math.round(bpm * 100);
    return { main: String(Math.floor(hundredths / 100)), frac: String(hundredths % 100).padStart(2, "0") };
}

/** Tempo the deck plays at: the engine clock's figure when it has one, else grid × fader. */
export function playingBpm(deck: { loaded: boolean; bpm: number; tempo: number }, clockBpm: number | null | undefined): number {
    if (!deck.loaded || !(deck.bpm > 0)) return 0;
    if (typeof clockBpm === "number" && Number.isFinite(clockBpm) && clockBpm > 0) return clockBpm;
    return deck.bpm * (deck.tempo > 0 ? deck.tempo : 1);
}

/** `m:ss` (whole seconds) for spoken values. */
export function formatClock(sec: number): string {
    const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The deck a key is compared with: A↔B, C↔D. */
export function oppositeDeck(id: DeckId): DeckId {
    return id === "a" ? "b" : id === "b" ? "a" : id === "c" ? "d" : "c";
}

/** A seek never lands on the very last samples (that would end the track at once). */
export const SEEK_END_GUARD_SEC = 0.05;

export function clampSeek(sec: number, duration: number): number {
    if (!(duration > 0) || !Number.isFinite(sec)) return 0;
    return Math.min(Math.max(0, duration - SEEK_END_GUARD_SEC), Math.max(0, sec));
}

/** Pointer x → fraction of the track (0..1) inside a box that starts at `left` and is `width` wide. */
export function seekFraction(clientX: number, left: number, width: number): number {
    if (!(width > 0)) return 0;
    return Math.min(1, Math.max(0, (clientX - left) / width));
}

/**
 * Keyboard seeking on the overview (slider keys): arrows ±1 % of the track, Page keys ±10 %,
 * Home = start. Returns the new position, or null for a key the overview does not handle.
 */
export function keySeekTarget(key: string, position: number, duration: number): number | null {
    if (!(duration > 0)) return null;
    const step = duration / 100;
    switch (key) {
        case "ArrowLeft":
        case "ArrowDown":
            return clampSeek(position - step, duration);
        case "ArrowRight":
        case "ArrowUp":
            return clampSeek(position + step, duration);
        case "PageDown":
            return clampSeek(position - 10 * step, duration);
        case "PageUp":
            return clampSeek(position + 10 * step, duration);
        case "Home":
            return 0;
        default:
            return null;
    }
}

/**
 * Beats between two ticks of the overview ruler: the finest of beat / bar / 4 / 8 / 16 / 32 / 64
 * bars whose ticks are at least `minPx` apart. 0 = even the coarsest is too dense (no ruler).
 */
export function rulerBeats(pxPerBeat: number, beatsPerBar = 4, minPx = 12): number {
    if (!(pxPerBeat > 0)) return 0;
    const bar = Math.max(1, Math.round(beatsPerBar));
    for (const step of [1, bar, 4 * bar, 8 * bar, 16 * bar, 32 * bar, 64 * bar]) if (pxPerBeat * step >= minPx) return step;
    return 0;
}

/** Degrees per second of a 33⅓ rpm record. */
export const PLATTER_DEG_PER_SEC = (100 / 3 / 60) * 360;

/** Rotation of the platter marker at a track position, 0..360. */
export function platterAngle(positionSec: number): number {
    if (!Number.isFinite(positionSec)) return 0;
    const a = (positionSec * PLATTER_DEG_PER_SEC) % 360;
    return a < 0 ? a + 360 : a;
}

/** Track progress 0..1. */
export function progressOf(deck: { position: number; duration: number }): number {
    return deck.duration > 0 ? Math.min(1, Math.max(0, deck.position / deck.duration)) : 0;
}

function sameField(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
}

/**
 * True when two deck snapshots differ at most in the `ignore`d fields (arrays compare by
 * element: every engine snapshot brings fresh arrays).
 */
export function sameDeckExcept<D extends object>(a: D, b: D, ignore: readonly (keyof D)[]): boolean {
    if (a === b) return true;
    const keys = Object.keys(b) as (keyof D)[];
    if (keys.length !== Object.keys(a).length) return false;
    for (const k of keys) {
        if (ignore.includes(k)) continue;
        if (!sameField(a[k], b[k])) return false;
    }
    return true;
}

/** The deck fields the overview strip draws: a new frame is needed only when one of them changed. */
export interface StripFields {
    position: number;
    duration: number;
    loaded: boolean;
    loopActive: boolean;
    loopStart: number;
    loopEnd: number;
    hotCues: readonly (number | null)[];
}

export function stripChanged(a: StripFields, b: StripFields): boolean {
    return (
        a.position !== b.position ||
        a.duration !== b.duration ||
        a.loaded !== b.loaded ||
        a.loopActive !== b.loopActive ||
        a.loopStart !== b.loopStart ||
        a.loopEnd !== b.loopEnd ||
        !sameField(a.hotCues, b.hotCues)
    );
}

/**
 * Touch mode (44 px targets). Box heights (px, padding included) from which an arrangement fits:
 *   full    16 pad + header 44 + overview 26 + three 44 px rows + body 91 + 5 gaps of 2 = 319
 *   compact 16 pad + header 22 + overview 24 + two 44 px rows + body 92 + 4 gaps of 2 = 250
 * A lower box uses the "bare" compact arrangement: header, overview, transport and one row of
 * tab buttons whose bodies open as popovers (nothing is removed). Row budgets: deck.css.
 */
export const TOUCH_FULL_MIN_H = 319;
export const TOUCH_COMPACT_MIN_H = 250;

export type DeckArrangement = "full" | "compact" | "bare" | "icon";

/**
 * What the deck renders for a tier. Without touch mode that is the tier itself; in touch mode a
 * box too low for the tier's 44 px rows steps down (the panel minimums are not touch-aware).
 * `boxH` 0 = not measured yet: the tier's own arrangement.
 */
export function deckArrangement(tier: "full" | "compact" | "icon", touch: boolean, boxH: number): DeckArrangement {
    if (tier === "icon") return "icon";
    if (!touch || !(boxH > 0)) return tier;
    if (tier === "full" && boxH >= TOUCH_FULL_MIN_H) return "full";
    return boxH >= TOUCH_COMPACT_MIN_H ? "compact" : "bare";
}
