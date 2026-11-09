/**
 * Pure sizing maths for the zero-scroll panels (no React, no DOM) so it can be
 * unit-tested with `node --test`. The mixer measures its own box and asks how
 * big the knobs may be and which optional sections fit inline; everything that
 * does not fit moves into a popover.
 */
import type { Tier } from "../layout/types.ts";

export interface MixerFitInput {
    /** Panel box incl. padding (clientWidth / clientHeight). */
    w: number;
    h: number;
    channels: number;
    tier: Tier;
}

export interface MixerFit {
    /** Knob diameter in CSS px (0 when the tier shows no knobs). */
    knob: number;
    /** Number of knob rows per channel (full 5: trim/hi/mid/low/filter, compact 2: low/filter). */
    knobRows: number;
    /** Height of the label row on top of each channel. */
    labelRow: number;
    faderWidth: number;
    /** Inline headphone/booth knob row at the bottom (full tier only). */
    routingRow: boolean;
    /** Beat FX unit inline at the bottom (full tier, only if it fits). */
    beatFxInline: boolean;
}

/** Layout constants shared with MixerStrip.tsx — keep them in sync. */
export const MIXER = {
    pad: 16, // p-2 on both sides
    gap: 6, // gap-1.5
    colGap: 4,
    labelRow: 14,
    iconLabelRow: 24,
    cueRow: 24,
    /** Knob label line (11px) + the 4px gap inside <Knob>. */
    knobLabel: 15,
    faderMin: { full: 80, compact: 64, icon: 48 } as Record<Tier, number>,
    /** Bottom bar: full = inline routing knobs (26 + label), compact = popover buttons. */
    bottom: { full: 42, compact: 28, icon: 0 } as Record<Tier, number>,
    routingKnob: 26,
    beatFx: 150,
    knobMin: 24,
    knobMax: 64,
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Rows of knobs per channel for a tier. */
export function knobRowsFor(tier: Tier): number {
    return tier === "full" ? 5 : tier === "compact" ? 2 : 0;
}

function knobFor(h: number, rows: number, tier: Tier, colW: number, extra: number): number {
    if (rows === 0) return 0;
    const fixed = MIXER.labelRow + MIXER.cueRow + MIXER.faderMin[tier] + MIXER.gap * (rows + 2);
    const bottom = MIXER.bottom[tier] > 0 ? MIXER.bottom[tier] + MIXER.gap : 0;
    const avail = h - MIXER.pad - bottom - fixed - extra;
    const raw = Math.floor(avail / rows - MIXER.knobLabel);
    return Math.floor(clamp(raw, MIXER.knobMin, Math.max(MIXER.knobMin, Math.min(MIXER.knobMax, colW - 8))));
}

/** Column width of one channel inside the mixer box. */
export function channelWidth(w: number, channels: number): number {
    const n = Math.max(1, channels);
    return (w - MIXER.pad - (n - 1) * MIXER.colGap) / n;
}

export function mixerFit({ w, h, channels, tier }: MixerFitInput): MixerFit {
    const colW = channelWidth(w, channels);
    const rows = knobRowsFor(tier);
    const faderWidth = Math.floor(clamp(colW * 0.4, 18, 36));
    const labelRow = tier === "icon" ? MIXER.iconLabelRow : MIXER.labelRow;
    let beatFxInline = false;
    let knob = knobFor(h, rows, tier, colW, 0);
    if (tier === "full" && w >= 230) {
        const withFx = knobFor(h, rows, tier, colW, MIXER.beatFx + MIXER.gap);
        // Only inline when the knobs stay comfortable AND the stack really fits.
        if (withFx >= 32 && mixerUsedHeight({ knob: withFx, knobRows: rows, labelRow, faderWidth, routingRow: true, beatFxInline: true }, tier) <= h) {
            beatFxInline = true;
            knob = withFx;
        }
    }
    return { knob, knobRows: rows, labelRow, faderWidth, routingRow: tier === "full", beatFxInline };
}

/** Minimum height the rendered stack needs (fader at its minimum). */
export function mixerUsedHeight(fit: MixerFit, tier: Tier): number {
    const knobs = fit.knobRows * (fit.knob + MIXER.knobLabel);
    const gaps = MIXER.gap * (fit.knobRows + 2);
    const bottom = MIXER.bottom[tier] > 0 ? MIXER.bottom[tier] + MIXER.gap : 0;
    const fx = fit.beatFxInline ? MIXER.beatFx + MIXER.gap : 0;
    return MIXER.pad + fit.labelRow + knobs + MIXER.cueRow + MIXER.faderMin[tier] + gaps + bottom + fx;
}
