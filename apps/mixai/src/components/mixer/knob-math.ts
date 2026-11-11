/**
 * Pure geometry of the rotary knob (no React, no DOM): tested with `node --test`.
 *
 * A knob sweeps 270°: −135° (min) … +135° (max), 0° = 12 o'clock. Its travel is the
 * "position" 0..1. A bipolar knob (EQ, trim, filter, cue mix) has its `center` value at
 * exactly 12 o'clock even when the range is lopsided (EQ −26..+6 dB), so each half of the
 * travel maps linearly onto its own side of the range.
 */

export interface KnobScale {
    min: number;
    max: number;
    /** Detent value (double click / Enter resets to it). */
    center?: number | undefined;
    /** Force a one-sided knob although `center` is inside the range (wet/dry, levels). */
    bipolar?: boolean | undefined;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** True when the knob has a 12 o'clock detent with travel on both sides of it. */
export function isBipolar({ min, max, center, bipolar }: KnobScale): boolean {
    if (center === undefined || !(center > min && center < max)) return false;
    return bipolar ?? true;
}

/** Value → travel 0..1. */
export function valueToPos(value: number, scale: KnobScale): number {
    const { min, max } = scale;
    if (!(max > min)) return 0;
    const v = clamp(value, min, max);
    if (isBipolar(scale)) {
        const c = scale.center as number;
        return v <= c ? (0.5 * (v - min)) / (c - min) : 0.5 + (0.5 * (v - c)) / (max - c);
    }
    return (v - min) / (max - min);
}

/** Travel 0..1 → value. The detent and both ends come back exact. */
export function posToValue(pos: number, scale: KnobScale): number {
    const { min, max } = scale;
    const p = clamp(pos, 0, 1);
    if (p === 0) return min;
    if (p === 1) return max;
    if (isBipolar(scale)) {
        const c = scale.center as number;
        if (p === 0.5) return c;
        return p < 0.5 ? min + (p / 0.5) * (c - min) : c + ((p - 0.5) / 0.5) * (max - c);
    }
    return min + p * (max - min);
}

/** Travel → pointer angle in degrees (0 = 12 o'clock, clockwise positive). */
export function posToAngle(pos: number): number {
    return -135 + clamp(pos, 0, 1) * 270;
}

/** The lit part of the ring as [from, to] travel: from the detent when bipolar, else from the minimum. */
export function arcRange(pos: number, bipolar: boolean): [number, number] {
    const p = clamp(pos, 0, 1);
    return bipolar ? [Math.min(0.5, p), Math.max(0.5, p)] : [0, p];
}

/** Width of the pointer-drag detent around 12 o'clock, as travel. */
export const DETENT = 0.02;

/** Travel after a vertical drag of `dy` px (up = positive) from `startPos`; Shift = fine, no detent. */
export function dragPos(startPos: number, dy: number, fine: boolean, bipolar: boolean): number {
    const p = clamp(startPos + dy / (fine ? 600 : 180), 0, 1);
    return bipolar && !fine && Math.abs(p - 0.5) < DETENT ? 0.5 : p;
}

/**
 * Keyboard steps, in VALUE units (dB for an EQ): the default is 1 % of the range per arrow,
 * 0.25 % with Shift, and about 10 % per page (a whole number of steps).
 */
export interface KnobSteps {
    step: number;
    fine: number;
    page: number;
}

export function knobSteps(scale: KnobScale, step?: number, fine?: number): KnobSteps {
    const range = Math.max(0, scale.max - scale.min);
    const s = step !== undefined && step > 0 ? step : range / 100;
    const f = fine !== undefined && fine > 0 ? fine : s / 4;
    return { step: s, fine: f, page: s > 0 ? Math.max(1, Math.round(range / 10 / s)) * s : 0 };
}

/**
 * Value after a key press, or null when the key is not a knob key.
 *
 * Steps are equal in value on both sides of the detent (a lopsided EQ, −26..+6 dB, used to move
 * 0.52 dB per press below 0 and 0.12 dB above, because the keys stepped the travel). The value
 * moves to the next line of a grid anchored at the detent (at the minimum for a one-sided knob),
 * so the detent and round values come back exactly, also after a free pointer drag.
 * Arrows one step (Shift = fine), PageUp / PageDown one page, Home / End the ends.
 */
export function keyValue(value: number, key: string, shift: boolean, scale: KnobScale, steps: KnobSteps = knobSteps(scale)): number | null {
    const { min, max } = scale;
    let dir = 0;
    let size = shift ? steps.fine : steps.step;
    switch (key) {
        case "ArrowUp":
        case "ArrowRight":
            dir = 1;
            break;
        case "ArrowDown":
        case "ArrowLeft":
            dir = -1;
            break;
        case "PageUp":
            dir = 1;
            size = steps.page;
            break;
        case "PageDown":
            dir = -1;
            size = steps.page;
            break;
        case "Home":
            return min;
        case "End":
            return max;
        default:
            return null;
    }
    if (!(max > min) || !(size > 0)) return clamp(value, min, max);
    const anchor = isBipolar(scale) ? (scale.center as number) : min;
    const v = clamp(value, min, max);
    // Grid lines are anchor + k·size. Up: the first line above v; down: the first line below it.
    const k = (v - anchor) / size;
    const line = dir > 0 ? Math.floor(k + 1e-6) + 1 : Math.ceil(k - 1e-6) - 1;
    return clamp(Number((anchor + line * size).toFixed(9)), min, max);
}

const f = (n: number) => Number(n.toFixed(2));

/** SVG path of a clockwise arc of radius `r` around (cx, cy) between two pointer angles. */
export function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
    const pt = (deg: number) => {
        const a = (deg * Math.PI) / 180;
        return `${f(cx + r * Math.sin(a))} ${f(cy - r * Math.cos(a))}`;
    };
    return `M ${pt(fromDeg)} A ${f(r)} ${f(r)} 0 ${toDeg - fromDeg > 180 ? 1 : 0} 1 ${pt(toDeg)}`;
}
