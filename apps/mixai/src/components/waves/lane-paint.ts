/**
 * Canvas painter of one lane of the waves panel. A lane holds one deck (stacked mode) or
 * every deck as a layer (overlay mode: first half of the decks above the centre, the rest
 * below). Everything is expressed on two axes, time (`t`) and amplitude (`a`), so the same
 * code draws horizontal lanes (time = x) and vertical ones (time = y).
 *
 * Tokens only: every colour is a `var(--…)` resolved by the layer's resolver (an element that
 * carries `--deck` and the `dk-wave` class), shaded with `globalAlpha`.
 */
import type { DeckId, DeckState } from "../../bridge/types.ts";
import { beatAt, timeAt, type GridModel } from "../../grid/markers.ts";
import type { BandWave, StemLanes } from "../../state/wave-store.ts";
import type { WaveStrip } from "./strip.ts";
import { layerSpan, playheadAnchor, trackGain, type Span, type WaveTier } from "./wave-math.ts";

export type Resolve = (css: string) => string;

/** What a deck contributes to its lane besides the 30 Hz snapshot. */
export interface LayerData {
    wave: BandWave | null;
    /** Stem lanes, only when the deck plays its stems. */
    stems: StemLanes | null;
    grid: GridModel | null;
    resolve: Resolve;
    /** Letters drawn on the stem sub-lanes (translated). */
    stemLabels: readonly string[];
    /** Cue / tempo flags sit on the far amplitude edge (the header chip is on the near one). */
    flagsAtEnd: boolean;
}

export interface PaintLayer extends LayerData {
    id: DeckId;
    deck: DeckState;
    /** Source position (seconds) under the playhead in this frame. */
    pos: number;
    /** Device-pixel column of the source under the playhead in this frame (`scrollColumn`). */
    col: number;
    /** The layer's pre-rendered waveform. */
    strip: WaveStrip;
}

export interface PaintEnv {
    ctx: CanvasRenderingContext2D;
    /** Canvas size in device pixels. */
    w: number;
    h: number;
    dpr: number;
    vertical: boolean;
    /** Overlay mode: layers grow away from the lane centre instead of being mirrored. */
    halves: boolean;
    windowSec: number;
    tier: WaveTier;
    beatsPerBar: number;
    playedAlpha: number;
    font: string;
}

const BG = "var(--wave-bg, var(--background))";
const GRID = "var(--wave-grid, var(--foreground))";
const DOWNBEAT = "var(--wave-downbeat, var(--foreground))";
const PLAYHEAD = "var(--wave-playhead, var(--foreground))";
const PLAYHEAD_CAP = "var(--wave-playhead-cap, var(--destructive))";
const LOOP = "var(--on, var(--primary))";
const TEMPO_MARK = "var(--warning)";
const FLAG_TEXT = "var(--background)";
const FAINT = "var(--fg-faint, var(--muted-foreground))";
const BANDS = ["var(--wave-low)", "var(--wave-mid)", "var(--wave-high)"] as const;
/** Share of the lane each band may reach (low is drawn first, high on top). */
const BAND_SCALE = [1, 0.72, 0.44] as const;
const CUES = [
    "var(--cue-1, var(--deck))",
    "var(--cue-2, var(--deck))",
    "var(--cue-3, var(--deck))",
    "var(--cue-4, var(--deck))",
    "var(--cue-5, var(--deck))",
    "var(--cue-6, var(--deck))",
    "var(--cue-7, var(--deck))",
    "var(--cue-8, var(--deck))",
] as const;
/** Stem sub-lanes: vocals, drums, bass, melody (each also carries its letter). */
const STEMS = ["var(--cue-6, var(--deck))", "var(--cue-4, var(--deck))", "var(--cue-3, var(--deck))", "var(--cue-5, var(--deck))"] as const;

const gains = new WeakMap<BandWave, number>();
function gainOf(wave: BandWave): number {
    let g = gains.get(wave);
    if (g === undefined) {
        let top = 0;
        const { low, mid, high, len } = wave;
        for (let i = 0; i < len; i++) {
            const a = low[i]!;
            const b = mid[i]!;
            const c = high[i]!;
            if (a > top) top = a;
            if (b > top) top = b;
            if (c > top) top = c;
        }
        g = trackGain(top);
        gains.set(wave, g);
    }
    return g;
}

const span: Span = { a0: 0, a1: 0, dir: 0 };
const sub: Span = { a0: 0, a1: 0, dir: 0 };

function rect(env: PaintEnv, t: number, a: number, tl: number, al: number): void {
    if (env.vertical) env.ctx.fillRect(a, t, al, tl);
    else env.ctx.fillRect(t, a, tl, al);
}

function label(env: PaintEnv, text: string, t: number, a: number): void {
    if (env.vertical) env.ctx.fillText(text, a, t);
    else env.ctx.fillText(text, t, a);
}

function drawLayer(env: PaintEnv, layer: PaintLayer, s: Span, anchor: number, pxPerSec: number): void {
    const { ctx, dpr, tier } = env;
    const { deck, resolve } = layer;
    const L = env.vertical ? env.h : env.w;
    const px1 = Math.max(1, Math.round(dpr));
    const thick = s.a1 - s.a0;
    const baseline = s.dir === 0 ? Math.floor((s.a0 + s.a1) / 2) : s.dir < 0 ? s.a1 - px1 : s.a0;
    const dur = deck.duration;
    const loaded = deck.loaded && dur > 0;

    // The wave scrolls by whole device pixels: `first` = source column at the start of the lane.
    const first = layer.col - anchor;
    // Quiet line: the whole lane when the deck is empty, else under the track only.
    const tStart = first / pxPerSec;
    const tEnd = tStart + L / pxPerSec;
    ctx.fillStyle = resolve(GRID);
    ctx.globalAlpha = 0.16;
    if (!loaded) {
        rect(env, 0, baseline, L, px1);
        return;
    }
    const trackFrom = Math.max(0, Math.round((0 - tStart) * pxPerSec));
    const trackTo = Math.min(L, Math.round((dur - tStart) * pxPerSec));
    if (trackTo > trackFrom) rect(env, trackFrom, baseline, trackTo - trackFrom, px1);

    // ── waveform ──
    const stems = layer.stems;
    const strip = layer.strip;
    ctx.globalAlpha = 1;
    if (stems) {
        const lanes = stems.lanes;
        const subT = thick / 4;
        strip.begin(stems, stems.pps, pxPerSec, thick, env.vertical);
        for (let i = 0; i < 4; i++) {
            const lane = lanes[i];
            const g = deck.stemGains[i] ?? 1;
            if (!lane || g <= 0.001) continue;
            const b0 = Math.round(i * subT);
            const b1 = Math.round((i + 1) * subT) - px1;
            strip.part(lane, resolve(STEMS[i]!), (Math.min(1.5, g) / 255) * ((b1 - b0) / 2), b0, b1, 0);
        }
        strip.blit(ctx, first, L, s.a0);
        // The letter is the name of the sub-lane (never the colour alone); grey = silent stem.
        if (tier === "full") {
            const box = Math.round(11 * dpr);
            const along = L - box;
            ctx.font = env.font;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            for (let i = 0; i < 4; i++) {
                sub.a0 = s.a0 + Math.round(i * subT);
                sub.a1 = s.a0 + Math.round((i + 1) * subT) - px1;
                if (sub.a1 - sub.a0 < 9 * dpr) continue;
                const mid = (sub.a0 + sub.a1) / 2;
                ctx.globalAlpha = 0.8;
                ctx.fillStyle = resolve(BG);
                rect(env, along, Math.round(mid - box / 2), box, box);
                ctx.globalAlpha = 1;
                ctx.fillStyle = resolve(lanes[i] && (deck.stemGains[i] ?? 1) > 0.001 ? STEMS[i]! : FAINT);
                label(env, layer.stemLabels[i] ?? "", along + box / 2, mid + px1 / 2);
            }
        }
    } else if (layer.wave) {
        const wave = layer.wave;
        const k = (gainOf(wave) / 255) * (s.dir === 0 ? thick / 2 : thick);
        strip.begin(wave, wave.pps, pxPerSec, thick, env.vertical);
        strip.part(wave.low, resolve(BANDS[0]), k * BAND_SCALE[0], 0, thick, s.dir);
        strip.part(wave.mid, resolve(BANDS[1]), k * BAND_SCALE[1], 0, thick, s.dir);
        strip.part(wave.high, resolve(BANDS[2]), k * BAND_SCALE[2], 0, thick, s.dir);
        strip.blit(ctx, first, L, s.a0);
    }

    // Played part (before the playhead): dimmed towards the backdrop.
    if (anchor > trackFrom) {
        ctx.fillStyle = resolve(BG);
        ctx.globalAlpha = 1 - env.playedAlpha;
        rect(env, trackFrom, s.a0, Math.min(anchor, trackTo) - trackFrom, thick);
    }
    if (tier === "icon") return;

    // ── active loop: tint plus solid edges ──
    if (deck.loopActive && deck.loopEnd > deck.loopStart) {
        const x0 = Math.round((deck.loopStart - tStart) * pxPerSec);
        const x1 = Math.round((deck.loopEnd - tStart) * pxPerSec);
        if (x1 > 0 && x0 < L) {
            ctx.fillStyle = resolve(LOOP);
            ctx.globalAlpha = 0.2;
            rect(env, Math.max(0, x0), s.a0, Math.min(L, x1) - Math.max(0, x0), thick);
            ctx.globalAlpha = 0.95;
            if (x0 >= 0) rect(env, x0, s.a0, px1 * 2, thick);
            if (x1 <= L) rect(env, x1 - px1 * 2, s.a0, px1 * 2, thick);
        }
    }

    // ── beatgrid: ticks + faint line per beat, a strong line per downbeat ──
    const grid = layer.grid;
    if (grid && grid.bpm > 0) {
        const bar = env.beatsPerBar;
        const pxPerBeat = (pxPerSec * 60) / grid.bpm;
        const minPx = 5 * dpr;
        const stepBeats = pxPerBeat >= minPx ? 1 : pxPerBeat * bar >= minPx ? bar : bar * 4;
        const tick = Math.min(Math.round(4 * dpr), Math.floor(thick / 4));
        const from = Math.max(0, tStart);
        const to = Math.min(dur, tEnd);
        let beat = Math.ceil(beatAt(grid, from) / stepBeats - 1e-9) * stepBeats;
        ctx.fillStyle = resolve(GRID);
        const downStyle = resolve(DOWNBEAT);
        const beatStyle = ctx.fillStyle;
        let down = false;
        for (let n = 0; n < 400; n++, beat += stepBeats) {
            const sec = timeAt(grid, beat);
            if (!(sec <= to)) break;
            if (sec < from) continue;
            const x = Math.round((sec - tStart) * pxPerSec);
            const isDown = ((beat % bar) + bar) % bar === 0;
            if (isDown !== down) {
                ctx.fillStyle = isDown ? downStyle : beatStyle;
                down = isDown;
            }
            if (isDown) {
                ctx.globalAlpha = 0.5;
                rect(env, x, s.a0, px1, thick);
            } else {
                ctx.globalAlpha = 0.14;
                rect(env, x, s.a0, px1, thick);
                ctx.globalAlpha = 0.5;
                rect(env, x, s.a0, px1, tick);
                rect(env, x, s.a1 - tick, px1, tick);
            }
        }

        // Tempo changes: a line in the warning colour, a flag and the new BPM.
        if (!grid.fixed && grid.markers.length > 0) {
            ctx.fillStyle = resolve(TEMPO_MARK);
            ctx.font = env.font;
            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";
            const fw = Math.round(5 * dpr);
            const atEnd = layer.flagsAtEnd;
            ctx.textBaseline = atEnd || env.vertical ? "alphabetic" : "top";
            for (const m of grid.markers) {
                if (m.sec < from || m.sec > to) continue;
                const x = Math.round((m.sec - tStart) * pxPerSec);
                ctx.globalAlpha = 0.95;
                rect(env, x, s.a0, px1 * 2, thick);
                rect(env, x, atEnd ? s.a1 - fw : s.a0, fw, fw);
                if (tier === "full" && thick >= 28 * dpr) {
                    if (env.vertical) ctx.fillText(m.bpm.toFixed(1), atEnd ? s.a1 - Math.round(30 * dpr) : s.a0 + Math.round(8 * dpr), x - Math.round(3 * dpr));
                    else ctx.fillText(m.bpm.toFixed(1), x + fw + Math.round(2 * dpr), atEnd ? s.a1 - Math.round(3 * dpr) : s.a0 + Math.round(3 * dpr));
                }
            }
        }
    }

    // ── hot cues: a line and a numbered flag in the cue's own colour ──
    const cues = deck.hotCues;
    const flagT = Math.round(10 * dpr);
    const flagA = Math.round(11 * dpr);
    const numbered = thick >= 22 * dpr;
    const lw = Math.max(2, Math.round(1.5 * dpr));
    for (let i = 0; i < cues.length && i < CUES.length; i++) {
        const c = cues[i];
        if (c == null || c < tStart || c > tEnd) continue;
        const x = Math.round((c - tStart) * pxPerSec);
        ctx.fillStyle = resolve(CUES[i]!);
        ctx.globalAlpha = 1;
        rect(env, x, s.a0, lw, thick);
        const fa = layer.flagsAtEnd ? s.a1 - (numbered ? flagA : Math.round(4 * dpr)) : s.a0;
        if (numbered) {
            rect(env, x, fa, flagT, flagA);
            ctx.fillStyle = resolve(FLAG_TEXT);
            ctx.font = env.font;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            label(env, String(i + 1), x + flagT / 2, fa + flagA / 2 + px1 / 2);
        } else {
            rect(env, x, fa, Math.round(5 * dpr), Math.round(4 * dpr));
        }
    }
}

/** Draw one whole lane. `layers` in deck order; positions already predicted for this frame. */
export function paintLane(env: PaintEnv, layers: readonly PaintLayer[]): void {
    const { ctx, w, h, dpr, vertical } = env;
    const L = vertical ? h : w;
    const T = vertical ? w : h;
    const pxPerSec = L / env.windowSec;
    const anchor = Math.round(playheadAnchor(vertical) * L);
    const px1 = Math.max(1, Math.round(dpr));
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);
    const n = layers.length;
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
        layerSpan(span, i, n, T, env.halves);
        drawLayer(env, layers[i]!, span, anchor, pxPerSec);
    }
    const resolve = layers[0]!.resolve;
    // Layers of one lane are told apart by a hairline (overlay mode).
    if (n > 1) {
        ctx.fillStyle = resolve(GRID);
        ctx.globalAlpha = 0.3;
        for (let i = 1; i < n; i++) rect(env, 0, Math.round((i * T) / n), L, px1);
    }
    // Playhead: a line on a dark edge (readable on a bright wave), caps at both ends.
    const lw = Math.max(2, Math.round(2 * dpr));
    const x = anchor - Math.floor(lw / 2);
    ctx.fillStyle = resolve(BG);
    ctx.globalAlpha = 0.6;
    rect(env, x - px1, 0, lw + 2 * px1, T);
    ctx.fillStyle = resolve(PLAYHEAD);
    ctx.globalAlpha = 1;
    rect(env, x, 0, lw, T);
    if (env.tier !== "icon") {
        const capT = Math.round(3 * dpr);
        const capA = Math.min(Math.round(3 * dpr), Math.floor(T / 6));
        ctx.fillStyle = resolve(PLAYHEAD_CAP);
        rect(env, x - capT, 0, lw + 2 * capT, capA);
        rect(env, x - capT, T - capA, lw + 2 * capT, capA);
    }
    ctx.globalAlpha = 1;
}
