/**
 * Frame loop of the waves panel: one `requestAnimationFrame` loop for every lane.
 *
 * - The engine reports positions ~30 times a second; a playing deck is extrapolated between
 *   reports (`predict`) and corrected softly (`correct`), so the wave scrolls at the display
 *   rate without stutter or drift.
 * - Idle is free: the loop only runs while a deck plays. Otherwise one frame is requested when
 *   something a lane shows changed (seek, cue, loop, zoom, size, look, wave data).
 * - A frame is cheap: the wave of each layer is pre-rendered (`strip.ts`) and only blitted; it
 *   scrolls by whole device pixels, and a lane whose decks did not cross a pixel since its last
 *   paint is not drawn at all.
 *
 * No React here: the panel registers canvases and feeds per-deck data; nothing re-renders
 * per frame.
 */
import type { DeckId, DeckState } from "../../bridge/types.ts";
import { correct, predict, type Playhead } from "../../lib/deck-time.ts";
import { useMixerStore } from "../../state/mixer-store.ts";
import { paintLane, type LayerData, type PaintEnv, type PaintLayer } from "./lane-paint.ts";
import { WaveStrip } from "./strip.ts";
import { marksChanged, scrollColumn, wrapLoop, type WaveTier } from "./wave-math.ts";

export interface StageOptions {
    windowSec: number;
    tier: WaveTier;
    vertical: boolean;
    halves: boolean;
    beatsPerBar: number;
    playedAlpha: number;
    /** Font family of the canvas labels. */
    fontFamily: string;
}

interface Lane {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    decks: readonly DeckId[];
    layers: PaintLayer[];
    /** Scroll column of each layer at the last paint. */
    cols: number[];
}

/** Dev counters (`window.__wavesStat`): frames of the loop, lanes painted, time spent painting. */
interface StageStat {
    frames: number;
    paints: number;
    ms: number;
    /** Reports that were too far from the prediction and replaced it (a seek, or a wrong rate). */
    snaps?: number;
}
const stat: StageStat | null = import.meta.env?.DEV && typeof window !== "undefined" ? ((window as unknown as { __wavesStat?: StageStat }).__wavesStat ??= { frames: 0, paints: 0, ms: 0 }) : null;

/** Source seconds per second of a deck: 0 when it does not move, negative while it plays in reverse. */
const rateOf = (d: DeckState, reverse: boolean): number => (d.loaded && d.playing ? (d.tempo > 0 ? d.tempo : 1) * (reverse ? -1 : 1) : 0);

export class WaveStage {
    private lanes = new Set<Lane>();
    private byCanvas = new Map<Element, Lane>();
    private data: Partial<Record<DeckId, LayerData>> = {};
    private cur: Partial<Record<DeckId, DeckState>> = {};
    private heads: Partial<Record<DeckId, Playhead>> = {};
    /** Decks playing in reverse (REV is not in the engine snapshot: the panel feeds it). */
    private rev: Partial<Record<DeckId, boolean>> = {};
    private opts: StageOptions = { windowSec: 8, tier: "full", vertical: false, halves: false, beatsPerBar: 4, playedAlpha: 0.4, fontFamily: "sans-serif" };
    private env: PaintEnv | null = null;
    private raf = 0;
    private dirty = true;
    private running = false;
    private unsub: (() => void) | null = null;
    private ro: ResizeObserver | null = null;

    /** Start listening to the engine snapshots. Returns the stop function. */
    start(): () => void {
        this.running = true;
        this.ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver((entries) => this.onResize(entries)) : null;
        for (const lane of this.lanes) this.ro?.observe(lane.canvas);
        this.sync(useMixerStore.getState().decks, performance.now());
        this.unsub = useMixerStore.subscribe((s, prev) => {
            // Every snapshot replaces `decks`; a deck's own object changes only when it changed.
            if (s.decks !== prev.decks) this.sync(s.decks, performance.now());
        });
        const onVisible = () => {
            if (!document.hidden) this.invalidate();
        };
        document.addEventListener("visibilitychange", onVisible);
        this.invalidate();
        return () => {
            this.running = false;
            this.unsub?.();
            this.unsub = null;
            this.ro?.disconnect();
            this.ro = null;
            document.removeEventListener("visibilitychange", onVisible);
            if (this.raf) cancelAnimationFrame(this.raf);
            this.raf = 0;
        };
    }

    configure(next: StageOptions): void {
        this.opts = next;
        this.env = null;
        this.invalidate();
    }

    /** Per-deck drawing data (wave, grid, colours); null when the deck left the panel. */
    setLayer(id: DeckId, layer: LayerData | null): void {
        if (layer) this.data[id] = layer;
        else delete this.data[id];
        this.invalidate();
    }

    /** REV on / off for `id`: the lane extrapolates backward between reports while it is on. */
    setReverse(id: DeckId, on: boolean): void {
        if ((this.rev[id] ?? false) === on) return;
        const now = performance.now();
        // Re-anchor on what the lane shows now, so the direction flips without a jump.
        if (this.cur[id]) this.heads[id] = { pos: this.positionOf(id, now), at: now };
        this.rev[id] = on;
        this.schedule();
    }

    /** Register a lane canvas showing `decks` (one deck, or several in overlay mode). */
    addLane(canvas: HTMLCanvasElement, decks: readonly DeckId[]): () => void {
        const ctx = canvas.getContext("2d");
        if (!ctx) return () => undefined;
        const lane: Lane = { canvas, ctx, decks, layers: [], cols: [] };
        this.lanes.add(lane);
        this.byCanvas.set(canvas, lane);
        this.ro?.observe(canvas);
        this.fit(lane, 0, 0);
        this.invalidate();
        return () => {
            this.lanes.delete(lane);
            this.byCanvas.delete(canvas);
            this.ro?.unobserve(canvas);
        };
    }

    /** Ask for one frame (something visible changed). */
    invalidate(): void {
        this.dirty = true;
        this.schedule();
    }

    /** Source position under the playhead of `id` right now (what the lane shows). */
    positionOf(id: DeckId, now = performance.now()): number {
        const d = this.cur[id];
        if (!d) return 0;
        const h = this.heads[id];
        const rate = this.rate(d);
        if (!h || rate === 0) return d.position;
        const p = wrapLoop(predict(h, now, rate), h.pos, d.loopActive, d.loopStart, d.loopEnd);
        return p < 0 ? 0 : d.duration > 0 && p > d.duration ? d.duration : p;
    }

    private rate(d: DeckState): number {
        return rateOf(d, this.rev[d.id] ?? false);
    }

    private schedule(): void {
        if (!this.running || this.raf || typeof requestAnimationFrame === "undefined") return;
        this.raf = requestAnimationFrame(this.frame);
    }

    private sync(decks: readonly DeckState[], now: number): void {
        let changed = false;
        let moved = false;
        for (const d of decks) {
            const prev = this.cur[d.id];
            if (prev === d) continue;
            this.cur[d.id] = d;
            const marks = !prev || marksChanged(prev, d) || prev.playing !== d.playing || prev.tempo !== d.tempo;
            if (!marks && prev.position === d.position) continue;
            const rate = this.rate(d);
            const head = this.heads[d.id];
            // The old head is extrapolated at the old rate up to now, then pulled to the report.
            const next = rate !== 0 && prev && head && prev.trackId === d.trackId ? correct(head, d.position, now, this.rate(prev)) : { pos: d.position, at: now };
            if (stat && rate !== 0 && head && next.pos === d.position) stat.snaps = (stat.snaps ?? 0) + 1;
            this.heads[d.id] = next;
            if (marks) changed = true;
            else moved = true;
        }
        // A new position alone repaints a lane only when it moved the wave by a pixel (see `frame`).
        if (changed) this.invalidate();
        else if (moved) this.schedule();
    }

    private onResize(entries: ResizeObserverEntry[]): void {
        let any = false;
        for (const e of entries) {
            const lane = this.byCanvas.get(e.target);
            if (!lane) continue;
            const box = e.devicePixelContentBoxSize?.[0];
            if (this.fit(lane, box?.inlineSize ?? 0, box?.blockSize ?? 0)) any = true;
        }
        if (any) {
            this.env = null;
            this.invalidate();
        }
    }

    private fit(lane: Lane, dw: number, dh: number): boolean {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, dw > 0 ? dw : Math.round(lane.canvas.clientWidth * dpr));
        const h = Math.max(1, dh > 0 ? dh : Math.round(lane.canvas.clientHeight * dpr));
        if (lane.canvas.width === w && lane.canvas.height === h) return false;
        lane.canvas.width = w;
        lane.canvas.height = h;
        return true;
    }

    private frame = (now: number): void => {
        this.raf = 0;
        if (!this.running) return;
        const dirty = this.dirty;
        this.dirty = false;
        const o = this.opts;
        const dpr = window.devicePixelRatio || 1;
        let env = this.env;
        if (!env || env.dpr !== dpr) {
            env = this.env = {
                ctx: null as unknown as CanvasRenderingContext2D,
                w: 0,
                h: 0,
                dpr,
                vertical: o.vertical,
                halves: o.halves,
                windowSec: o.windowSec,
                tier: o.tier,
                beatsPerBar: o.beatsPerBar,
                playedAlpha: o.playedAlpha,
                font: `700 ${Math.round(9 * dpr)}px ${o.fontFamily}`,
            };
        }
        let moving = false;
        const t0 = stat ? performance.now() : 0;
        for (const lane of this.lanes) {
            let laneMoving = false;
            let scrolled = false;
            let n = 0;
            const pxPerSec = (o.vertical ? lane.canvas.height : lane.canvas.width) / o.windowSec;
            for (const id of lane.decks) {
                const deck = this.cur[id];
                const data = this.data[id];
                if (!deck || !data) continue;
                if (this.rate(deck) !== 0) laneMoving = true;
                let layer = lane.layers[n];
                if (!layer) layer = lane.layers[n] = { id, deck, pos: 0, col: 0, strip: new WaveStrip(), ...data };
                layer.id = id;
                layer.deck = deck;
                layer.pos = this.positionOf(id, now);
                layer.col = scrollColumn(layer.pos, pxPerSec);
                if (lane.cols[n] !== layer.col) {
                    lane.cols[n] = layer.col;
                    scrolled = true;
                }
                layer.wave = data.wave;
                layer.stems = data.stems;
                layer.grid = data.grid;
                layer.resolve = data.resolve;
                layer.stemLabels = data.stemLabels;
                layer.flagsAtEnd = data.flagsAtEnd;
                n++;
            }
            if (lane.layers.length !== n) {
                lane.layers.length = n;
                lane.cols.length = n;
                scrolled = true;
            }
            if (laneMoving) moving = true;
            if (!dirty && !scrolled) continue;
            env.ctx = lane.ctx;
            env.w = lane.canvas.width;
            env.h = lane.canvas.height;
            paintLane(env, lane.layers);
            if (stat) stat.paints++;
        }
        if (stat) {
            stat.frames++;
            stat.ms += performance.now() - t0;
        }
        if (moving) this.schedule();
    };
}
