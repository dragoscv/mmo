/**
 * Pure sizing model of the zero-scroll mixer (no React, no DOM), unit-tested with `node --test`.
 *
 * The mixer measures its own box and asks this module what fits; MixerStrip.tsx renders exactly
 * what the answer says and mixer.css uses the same numbers (keep the three in sync). Whatever
 * does not fit inline is reachable in a popover: per channel, or the master column's "More".
 *
 * Layout: [left channels] [master column] [right channels], one row.
 *   channel  = head (id label, or a 24 px button that opens the channel popover)
 *              / body (knobs + fader + level meter) / foot (CUE [+ channel popover button])
 *   master   = label / master knob / master meter / cue mix + phones knobs / More
 */
import type { Tier } from "../layout/types.ts";

export type KnobId = "trim" | "hi" | "mid" | "low" | "filter";
/** Where the channel knobs sit: beside the fader, stacked above it, or only in the popover. */
export type ChannelMode = "side" | "stack" | "none";

export interface MixerFitInput {
    /** Panel box incl. padding (clientWidth / clientHeight). */
    w: number;
    h: number;
    channels: number;
    tier: Tier;
}

export interface MixerFit {
    tier: Tier;
    channels: number;
    pad: number;
    masterW: number;
    /** Width of one channel column. */
    channelW: number;
    mode: ChannelMode;
    /** Knobs shown inline, top to bottom (the channel popover always holds all five). */
    knobs: KnobId[];
    /** Knob diameter (0 when no knob is inline). */
    knob: number;
    /** "label" = 12 px id; "button" = 24 px id button that opens the channel popover; "none" = icon tier. */
    header: "label" | "button" | "none";
    faderW: number;
    /** Level meter width (0 = no meter in the strip; the channel popover has one). */
    vuW: number;
    vuGap: number;
    /** CUE shows a headphones icon instead of the word (narrow channels). */
    cueIcon: boolean;
    master: {
        /** Label + master knob inline (else in the More popover). */
        knob: boolean;
        /** Send knobs inline: 0, 2 (cue mix, phones) or 3 (+ booth); the More popover always has all three. */
        sends: 0 | 2 | 3;
    };
}

/** Layout constants shared with MixerStrip.tsx and mixer.css. */
export const MIXER = {
    pad: { full: 6, compact: 6, icon: 4 } as Record<Tier, number>,
    /** Vertical gap between the blocks of a column, and between knobs / fader / meter. */
    gap: 3,
    colGap: 4,
    headLabel: 12,
    headButton: 24,
    foot: 24,
    knobMin: 24,
    knobMax: 34,
    stackKnobMax: 28,
    /** Legend line under a knob. */
    knobLabel: 10,
    knobGap: 2,
    /** Knob column = knob + this (room for the legend). */
    knobColPad: 4,
    faderMinW: 24,
    faderMaxW: 28,
    faderMinH: 48,
    /** Shortest fader that is still worth stacking knobs above. */
    stackFaderMinH: 64,
    vuW: 8,
    vuNarrowW: 6,
    /** A channel at least this wide gets the knobs beside the fader and a popover button in the foot. */
    wideChannel: 66,
    /** A channel narrower than this has no meter in the strip. */
    vuMinChannel: 32,
    cueWordMin: 36,
    masterW: { full: 48, compact: 44, icon: 24 } as Record<Tier, number>,
    masterKnob: 28,
    masterVuMin: 36,
    more: 24,
    sendKnob: 26,
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Which knobs are inline when `n` fit (display order top to bottom). */
export function knobsFor(n: number): KnobId[] {
    if (n >= 5) return ["trim", "hi", "mid", "low", "filter"];
    if (n === 4) return ["hi", "mid", "low", "filter"];
    if (n === 3) return ["hi", "mid", "low"];
    if (n === 2) return ["low", "filter"];
    if (n === 1) return ["filter"];
    return [];
}

const knobRow = (knob: number) => knob + MIXER.knobLabel;
const knobsHeight = (n: number, knob: number) => (n > 0 ? n * knobRow(knob) + (n - 1) * MIXER.knobGap : 0);

function headHeight(header: MixerFit["header"]): number {
    return header === "label" ? MIXER.headLabel : header === "button" ? MIXER.headButton : 0;
}

/** Height of `n` inline send knobs with their legends. */
const sendsHeight = (n: number) => (n > 0 ? n * (MIXER.sendKnob + MIXER.knobLabel) + (n - 1) * MIXER.gap : 0);
/** Extra meter length wanted before the third send knob (booth) takes room from the master meter. */
const BOOTH_COMFORT = 24;

export function mixerFit({ w, h, channels, tier }: MixerFitInput): MixerFit {
    const n = Math.max(1, channels);
    const pad = MIXER.pad[tier];
    const innerW = Math.max(0, w - 2 * pad);
    const innerH = Math.max(0, h - 2 * pad);
    const masterW = MIXER.masterW[tier];
    const channelW = Math.max(0, Math.floor((innerW - masterW - n * MIXER.colGap) / n));
    const wide = channelW >= MIXER.wideChannel;
    const header: MixerFit["header"] = tier === "icon" ? "none" : wide ? "label" : "button";
    const head = headHeight(header);
    const bodyH = Math.max(0, innerH - head - MIXER.foot - (head > 0 ? 2 : 1) * MIXER.gap);

    const vuW = channelW >= MIXER.vuMinChannel ? (channelW >= MIXER.vuMinChannel + 3 ? MIXER.vuW : MIXER.vuNarrowW) : 0;
    const vuGap = vuW === MIXER.vuW ? MIXER.gap : 2;
    const vuSpace = vuW > 0 ? vuW + vuGap : 0;

    let mode: ChannelMode = "none";
    let rows = 0;
    let knob = 0;
    if (tier !== "icon" && wide) {
        // Knobs in a column beside the fader, spread over the body height.
        rows = Math.min(5, Math.floor((bodyH + MIXER.knobGap) / (knobRow(MIXER.knobMin) + MIXER.knobGap)));
        if (rows >= 1) {
            mode = "side";
            const byHeight = Math.floor((bodyH - (rows - 1) * MIXER.knobGap) / rows) - MIXER.knobLabel;
            const byWidth = channelW - MIXER.knobColPad - MIXER.gap - MIXER.faderMinW - vuSpace;
            knob = clamp(Math.min(byHeight, byWidth), MIXER.knobMin, MIXER.knobMax);
        }
    } else if (tier !== "icon" && channelW >= MIXER.knobMin + 2) {
        // Narrow channel: knobs stacked above a shorter fader, when at least two fit.
        const room = bodyH - MIXER.stackFaderMinH - MIXER.gap;
        rows = Math.min(5, Math.floor((room + MIXER.knobGap) / (knobRow(MIXER.knobMin) + MIXER.knobGap)));
        if (rows >= 2) {
            mode = "stack";
            const byHeight = Math.floor((room - (rows - 1) * MIXER.knobGap) / rows) - MIXER.knobLabel;
            knob = clamp(Math.min(byHeight, channelW - 8), MIXER.knobMin, MIXER.stackKnobMax);
        } else rows = 0;
    }

    const faderRoom = mode === "side" ? channelW - (knob + MIXER.knobColPad) - MIXER.gap - vuSpace : channelW - vuSpace;
    const faderW = clamp(Math.floor(faderRoom), MIXER.faderMinW, MIXER.faderMaxW);

    const masterBase = MIXER.headLabel + MIXER.masterKnob + MIXER.masterVuMin + MIXER.more + 3 * MIXER.gap;
    return {
        tier,
        channels: n,
        pad,
        masterW,
        channelW,
        mode,
        knobs: knobsFor(rows),
        knob,
        header,
        faderW,
        vuW,
        vuGap,
        cueIcon: channelW < MIXER.cueWordMin,
        master: {
            knob: tier !== "icon",
            sends:
                tier === "icon" ? 0
                : innerH >= masterBase + sendsHeight(3) + MIXER.gap + BOOTH_COMFORT ? 3
                : innerH >= masterBase + sendsHeight(2) + MIXER.gap ? 2
                : 0,
        },
    };
}

/** The smallest box that holds what `fit` renders (fader and meters at their minimum). */
export function mixerUsed(fit: MixerFit): { w: number; h: number } {
    const vuSpace = fit.vuW > 0 ? fit.vuW + fit.vuGap : 0;
    const knobCol = fit.knob + MIXER.knobColPad;
    const channelMinW =
        fit.mode === "side"
            ? Math.max(MIXER.wideChannel, knobCol + MIXER.gap + MIXER.faderMinW + vuSpace)
            : Math.max(MIXER.faderMinW + vuSpace, fit.mode === "stack" ? fit.knob + 2 : 0, fit.header === "label" ? MIXER.wideChannel : 0);
    const kh = knobsHeight(fit.knobs.length, fit.knob);
    const bodyMinH = fit.mode === "side" ? Math.max(kh, MIXER.faderMinH) : fit.mode === "stack" ? kh + MIXER.gap + MIXER.stackFaderMinH : MIXER.faderMinH;
    const head = headHeight(fit.header);
    const channelH = head + (head > 0 ? MIXER.gap : 0) + bodyMinH + MIXER.gap + MIXER.foot;
    const masterH = fit.master.knob
        ? MIXER.headLabel + MIXER.masterKnob + MIXER.masterVuMin + MIXER.more + 3 * MIXER.gap + (fit.master.sends > 0 ? sendsHeight(fit.master.sends) + MIXER.gap : 0)
        : MIXER.masterVuMin + MIXER.gap + MIXER.more;
    return {
        w: 2 * fit.pad + fit.masterW + fit.channels * (MIXER.colGap + channelMinW),
        h: 2 * fit.pad + Math.max(channelH, masterH),
    };
}
