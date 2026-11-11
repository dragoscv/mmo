import { memo, useEffect, useMemo, useRef } from "react";
import { cn } from "@mmo/ui";
import { engine } from "@/bridge/engine";
import type { DeckId, DeckState } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { usePerfStore } from "@/state/perf-store";
import { lanePeak, useWaveStore, type BandWave } from "@/state/wave-store";
import { useT, type MessageKey } from "@/i18n";
import { gridFromDeck, timeAt, type GridModel } from "@/grid/markers";
import { useDeckGrid } from "@/grid/grid-store";
import { detectPhrases, phraseAt, type Phrase, type PhraseKind } from "@/lib/phrases";
import { makeColorResolver, type ColorResolver } from "@/look/canvas-colors";
import { readLookNumber, useLookVersion } from "@/look/look";
import { clampSeek, formatClock, keySeekTarget, rulerBeats, seekFraction, stripChanged, type StripFields } from "./deck/format";
import { deckNow, useDeckValue } from "./deck/use-deck";

/**
 * Canvas colours. Tokens only: the canvas has no CSS, so each one is resolved through the
 * element's computed `color` (`makeColorResolver`) and shaded with `globalAlpha`, never a
 * hand-written colour literal (the guard in `src/grid/tokens-i18n.test.ts` covers this file).
 * `--wave-*` come from the `dk-wave` class, `--phrase-*` from `.deck-overview` (deck.css).
 */
const WAVE_LOW = "var(--wave-low)";
const WAVE_MID = "var(--wave-mid)";
const WAVE_HIGH = "var(--wave-high)";
const WAVE_BG = "var(--wave-bg, var(--background))";
const RULER = "var(--wave-grid, var(--foreground))";
const PLAYHEAD = "var(--wave-playhead, var(--foreground))";
const LOOP = "var(--on, var(--primary))";
const TEMPO_MARK = "var(--warning)";
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
const PHRASE_COLOR: Record<PhraseKind, string> = {
    intro: "var(--phrase-intro)",
    break: "var(--phrase-break)",
    build: "var(--phrase-build)",
    main: "var(--phrase-main)",
    outro: "var(--phrase-outro)",
};
const PHRASE_NAME = {
    intro: "deckui.phraseIntro",
    break: "deckui.phraseBreak",
    build: "deckui.phraseBuild",
    main: "deckui.phraseMain",
    outro: "deckui.phraseOutro",
} as const satisfies Record<PhraseKind, MessageKey>;

/** Height of the phrase band along the bottom edge, CSS px. */
const PHRASE_PX = 4;
/** Share of the half height each band may reach (low is drawn first, high on top). */
const LANE_SCALE = { low: 1, mid: 0.72, high: 0.44 } as const;
/** A quiet track is scaled up to fill the strip, but never by more than this. */
const MAX_GAIN = 3;

interface WaveformProps {
    deckId: DeckId;
    /** The deck colour as a CSS value (`var(--deck-a)`); set as `--deck` on the strip. */
    accent: string;
    className?: string;
    /** Accessible name of the seek control (defaults to "Track position, deck X"). */
    label?: string;
    /**
     * Badge shown when the deck's grid is fixed. Defaults to `t("grid.fixed")`; pass it only
     * to override.
     */
    fixedLabel?: string;
}

/** Everything one frame is drawn from: replaced on every render, `deck` refreshed by the painter. */
interface Scene {
    deck: DeckState;
    wave: BandWave | null;
    peaks: number[];
    model: GridModel | null;
    phrases: Phrase[];
    playedAlpha: number;
    beatsPerBar: number;
    look: number;
}

interface Painter {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    /** The waveform itself, drawn once per (track, size, look) and blitted every frame. */
    layer: HTMLCanvasElement;
    lctx: CanvasRenderingContext2D | null;
    resolve: ColorResolver;
    built: { wave: BandWave | null; peaks: number[]; w: number; h: number; look: number; has: boolean } | null;
    font: string;
    fontKey: string;
}

/** Draw the whole-track waveform into the cached layer. False when there is nothing to draw. */
function buildWaveLayer(p: Painter, s: Scene, w: number, h: number): boolean {
    const g = p.lctx;
    if (!g) return false;
    if (p.layer.width !== w || p.layer.height !== h) {
        p.layer.width = w;
        p.layer.height = h;
    } else {
        g.clearRect(0, 0, w, h);
    }
    g.globalAlpha = 1;
    const half = h / 2;
    const wave = s.wave;
    if (wave && wave.len > 0) {
        const len = wave.len;
        let top = 1;
        for (let i = 0; i < len; i++) {
            const a = wave.low[i]!;
            const b = wave.mid[i]!;
            const c = wave.high[i]!;
            if (a > top) top = a;
            if (b > top) top = b;
            if (c > top) top = c;
        }
        const gain = Math.min(MAX_GAIN, 255 / top) / 255;
        const lanes = [
            [wave.low, WAVE_LOW, LANE_SCALE.low],
            [wave.mid, WAVE_MID, LANE_SCALE.mid],
            [wave.high, WAVE_HIGH, LANE_SCALE.high],
        ] as const;
        for (const [lane, color, scale] of lanes) {
            g.fillStyle = p.resolve(color);
            const k = gain * scale * half;
            for (let x = 0; x < w; x++) {
                const amp = lanePeak(lane, (x * len) / w, ((x + 1) * len) / w) * k;
                if (amp >= 0.5) g.fillRect(x, half - amp, 1, amp * 2);
            }
        }
        return true;
    }
    // No band data (older engine, browser preview): the mono overview peaks, one tone.
    const peaks = s.peaks;
    if (peaks.length > 0) {
        const n = peaks.length;
        let top = 0;
        for (let i = 0; i < n; i++) if (peaks[i]! > top) top = peaks[i]!;
        if (!(top > 0)) return false;
        const k = Math.min(MAX_GAIN, 1 / top) * half;
        g.fillStyle = p.resolve(WAVE_MID);
        for (let x = 0; x < w; x++) {
            const from = Math.floor((x * n) / w);
            const to = Math.max(from + 1, Math.ceil(((x + 1) * n) / w));
            let m = 0;
            for (let i = from; i < to && i < n; i++) if (peaks[i]! > m) m = peaks[i]!;
            const amp = m * k;
            if (amp >= 0.5) g.fillRect(x, half - amp, 1, amp * 2);
        }
        return true;
    }
    return false;
}

/** One frame of the overview. Cheap: two blits of the cached layer plus a few rectangles. */
function paintOverview(p: Painter, s: Scene): void {
    const { canvas, ctx, resolve } = p;
    const w = canvas.width;
    const h = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    const px1 = Math.max(1, Math.round(dpr));
    const { deck } = s;
    const dur = deck.duration > 0 ? deck.duration : 0;
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);

    const strip = s.phrases.length > 0 && dur > 0 ? Math.max(2, Math.round(PHRASE_PX * dpr)) : 0;
    const waveH = Math.max(1, h - (strip > 0 ? strip + px1 : 0));
    const b = p.built;
    if (!b || b.wave !== s.wave || b.peaks !== s.peaks || b.w !== w || b.h !== waveH || b.look !== s.look) {
        p.built = { wave: s.wave, peaks: s.peaks, w, h: waveH, look: s.look, has: buildWaveLayer(p, s, w, waveH) };
    }
    const playedX = dur > 0 ? Math.min(w, Math.max(0, Math.round((deck.position / dur) * w))) : 0;

    if (p.built?.has) {
        if (playedX > 0) {
            ctx.globalAlpha = s.playedAlpha;
            ctx.drawImage(p.layer, 0, 0, playedX, waveH, 0, 0, playedX, waveH);
        }
        if (playedX < w) {
            ctx.globalAlpha = 1;
            ctx.drawImage(p.layer, playedX, 0, w - playedX, waveH, playedX, 0, w - playedX, waveH);
        }
    } else {
        // Empty deck, or a track still loading: a centre hairline keeps the strip readable.
        ctx.fillStyle = resolve(RULER);
        ctx.globalAlpha = 0.18;
        ctx.fillRect(0, Math.floor(waveH / 2), w, px1);
    }

    const model = s.model;
    // Bar ruler: short ticks on the top edge at the finest bar multiple that stays readable.
    if (model && dur > 0) {
        const step = rulerBeats(((w / dpr) * 60) / (dur * model.bpm), s.beatsPerBar);
        if (step > 0) {
            ctx.fillStyle = resolve(RULER);
            ctx.globalAlpha = 0.4;
            const tick = Math.round(3 * dpr);
            for (let beat = 0, n = 0; n < 600; beat += step, n++) {
                const sec = timeAt(model, beat);
                if (!(sec <= dur)) break;
                if (sec >= 0) ctx.fillRect(Math.round((sec / dur) * w), 0, px1, tick);
            }
        }
    }

    // Active loop: tint plus solid edges (shape, not colour only).
    if (deck.loopActive && dur > 0 && deck.loopEnd > deck.loopStart) {
        const x0 = Math.round((deck.loopStart / dur) * w);
        const x1 = Math.max(x0 + px1, Math.round((deck.loopEnd / dur) * w));
        ctx.fillStyle = resolve(LOOP);
        ctx.globalAlpha = 0.24;
        ctx.fillRect(x0, 0, x1 - x0, waveH);
        ctx.globalAlpha = 0.95;
        ctx.fillRect(x0, 0, px1, waveH);
        ctx.fillRect(x1 - px1, 0, px1, waveH);
    }

    // Phrase band: one tone per kind, a 1 px gap between phrases, the played part dimmed.
    if (strip > 0) {
        const y = h - strip;
        for (const ph of s.phrases) {
            const x0 = Math.round((ph.fromSec / dur) * w);
            const x1 = Math.round((ph.toSec / dur) * w) - px1;
            if (x1 <= x0) continue;
            ctx.fillStyle = resolve(PHRASE_COLOR[ph.kind]);
            const cut = Math.min(x1, Math.max(x0, playedX));
            if (cut > x0) {
                ctx.globalAlpha = 0.45;
                ctx.fillRect(x0, y, cut - x0, strip);
            }
            if (x1 > cut) {
                ctx.globalAlpha = 1;
                ctx.fillRect(cut, y, x1 - cut, strip);
            }
        }
    }

    // Tempo-change markers: the warning colour, a flag and the new BPM.
    if (model && dur > 0 && model.markers.length > 0) {
        const fontKey = `${s.look}|${dpr}`;
        if (p.fontKey !== fontKey) {
            p.fontKey = fontKey;
            p.font = `600 ${Math.round(9 * dpr)}px ${getComputedStyle(canvas).fontFamily || "sans-serif"}`;
        }
        ctx.font = p.font;
        ctx.textBaseline = "top";
        ctx.fillStyle = resolve(TEMPO_MARK);
        ctx.globalAlpha = model.fixed ? 0.35 : 0.95;
        for (const m of model.markers) {
            if (m.sec < 0 || m.sec > dur) continue;
            const x = Math.round((m.sec / dur) * w);
            ctx.fillRect(x, 0, px1, waveH);
            ctx.fillRect(x, 0, Math.round(5 * dpr), Math.round(3 * dpr));
            ctx.fillText(m.bpm.toFixed(1), x + Math.round(3 * dpr), Math.round(4 * dpr));
        }
    }

    // Hot cues: a line and a flag in the cue's own colour.
    if (dur > 0) {
        const lw = Math.max(1, Math.round(1.5 * dpr));
        const flagW = Math.round(5 * dpr);
        const flagH = Math.round(4 * dpr);
        ctx.globalAlpha = 1;
        for (let i = 0; i < deck.hotCues.length && i < CUES.length; i++) {
            const c = deck.hotCues[i];
            if (c == null || c < 0 || c > dur) continue;
            const x = Math.round((c / dur) * w);
            ctx.fillStyle = resolve(CUES[i]!);
            ctx.fillRect(x, 0, lw, waveH);
            ctx.fillRect(x, 0, flagW, flagH);
        }
    }

    // Playhead: a line in the playhead colour on a dark edge, so it reads on a bright wave too.
    if (dur > 0) {
        const lw = Math.max(2, Math.round(2 * dpr));
        const x = Math.min(w - lw, Math.max(0, playedX - Math.floor(lw / 2)));
        ctx.fillStyle = resolve(WAVE_BG);
        ctx.globalAlpha = 0.6;
        ctx.fillRect(x - px1, 0, lw + 2 * px1, h);
        ctx.fillStyle = resolve(PLAYHEAD);
        ctx.globalAlpha = 1;
        ctx.fillRect(x, 0, lw, h);
    }
    ctx.globalAlpha = 1;
}

/**
 * Overview of the whole track (the big scrolling waveforms live in the waves panel): the
 * three-band waveform in tones of the deck colour (mono peaks as a fallback), the played part
 * dimmed, hot cues, the active loop, tempo-change markers, a bar ruler and the phrase band
 * (intro / break / build / main / outro) along the bottom.
 *
 * It is also the seek control: click or drag to move the playhead, arrow keys move it by 1 %
 * of the track (Page Up / Down 10 %, Home = start).
 *
 * Render cost: the playhead does NOT go through React. The canvas listens to the mixer store
 * itself and asks for one frame when a field it draws changed (`stripChanged`); the component
 * renders only for what its markup shows (the spoken position, once a second; the phrase name).
 * Idle is free: nothing runs per frame, and the waveform itself is cached in an off-screen
 * layer, so a frame is two blits and a few rects.
 */
export const Waveform = memo(function Waveform({ deckId, accent, className, label, fixedLabel }: WaveformProps) {
    const t = useT();
    const rootRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const trackId = useDeckValue(deckId, (d) => d.trackId);
    const loaded = useDeckValue(deckId, (d) => d.loaded);
    const duration = useDeckValue(deckId, (d) => d.duration);
    const bpm = useDeckValue(deckId, (d) => d.bpm);
    const firstBeat = useDeckValue(deckId, (d) => d.firstBeat);
    const peaks = useMixerStore((s) => s.waveforms[deckId]);
    const bands = useWaveStore((s) => s.bands[deckId]);
    const stored = useDeckGrid(deckId, trackId);
    const beatsPerBar = usePerfStore((s) => (s.clock && s.clock.beatsPerBar > 0 ? s.clock.beatsPerBar : 4));
    const look = useLookVersion();
    // Read once per look change: a computed-style read on every render would not be free.
    const playedAlpha = useMemo(() => {
        void look;
        return Math.min(1, Math.max(0.1, readLookNumber("--wave-played-alpha", 0.4)));
    }, [look]);
    // The badge is the translated word (hooks only run in the component).
    const badge = fixedLabel ?? t("grid.fixed");

    // Between a load and the end of its decode the store may still hold the previous track's wave.
    const wave = bands && bands.trackId === trackId ? bands : null;
    const model = useMemo<GridModel | null>(() => (bpm > 0 && duration > 0 ? (stored ?? gridFromDeck(bpm, firstBeat)) : null), [stored, bpm, firstBeat, duration]);
    const phrases = useMemo(() => detectPhrases(wave, model, duration, beatsPerBar), [wave, model, duration, beatsPerBar]);

    // What the markup says about the position: whole seconds and the phrase under the playhead.
    const canSeek = loaded && duration > 0;
    const pos = useDeckValue(deckId, (d) => formatClock(d.position));
    const valueNow = useDeckValue(deckId, (d) => Math.max(0, Math.round(d.position)));
    const phraseKind = useDeckValue(deckId, (d) => (d.loaded && d.duration > 0 ? (phraseAt(phrases, d.position)?.kind ?? null) : null));

    const scene = useRef<Scene | null>(null);
    scene.current = { deck: scene.current?.deck ?? deckNow(deckId), wave, peaks, model, phrases, playedAlpha, beatsPerBar, look };
    const requestDraw = useRef<(() => void) | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const root = rootRef.current;
        if (!canvas || !root) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const layer = document.createElement("canvas");
        const painter: Painter = { canvas, ctx, layer, lctx: layer.getContext("2d"), resolve: makeColorResolver(canvas), built: null, font: "", fontKey: "" };
        let raf = 0;
        const paint = () => {
            raf = 0;
            const s = scene.current;
            if (!s) return;
            // The deck as it is when the frame is drawn (not as it was at the last render).
            s.deck = deckNow(deckId);
            paintOverview(painter, s);
        };
        const schedule = () => {
            if (!raf) raf = requestAnimationFrame(paint);
        };
        requestDraw.current = schedule;
        const resize = () => {
            const dpr = window.devicePixelRatio || 1;
            const w = Math.max(1, Math.round(root.clientWidth * dpr));
            const h = Math.max(1, Math.round(root.clientHeight * dpr));
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }
            schedule();
        };
        resize();
        const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
        ro?.observe(root);
        // One frame when (and only when) a deck field the strip draws changed. An unchanged deck
        // keeps its object in the store, so an idle deck costs one identity check per snapshot.
        let shown: StripFields = deckNow(deckId);
        const unsubscribe = useMixerStore.subscribe((s) => {
            const d = s.deck(deckId);
            if (d === shown) return;
            if (stripChanged(shown, d)) schedule();
            shown = d;
        });
        // A frame requested while the window was hidden never ran: draw again when it shows.
        const onVisible = () => {
            if (!document.hidden) schedule();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            requestDraw.current = null;
            if (raf) cancelAnimationFrame(raf);
            ro?.disconnect();
            unsubscribe();
            document.removeEventListener("visibilitychange", onVisible);
            painter.resolve.dispose();
        };
    }, [deckId]);

    // The inputs that come through React (track data, grid, look): one frame when they change.
    useEffect(() => {
        requestDraw.current?.();
    }, [wave, peaks, model, phrases, playedAlpha, beatsPerBar, look]);

    // ── seeking ──────────────────────────────────────────────────────────────
    const drag = useRef<{ pointer: number; x: number; raf: number } | null>(null);
    const seekTo = (sec: number) => {
        const d = deckNow(deckId);
        if (!d.loaded || !(d.duration > 0)) return;
        const next = clampSeek(sec, d.duration);
        useMixerStore.getState().patchDeck(deckId, { position: next });
        void engine.seek(deckId, next);
    };
    const seekAtX = (clientX: number) => {
        const el = rootRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        seekTo(seekFraction(clientX, r.left, r.width) * deckNow(deckId).duration);
    };
    const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d || d.pointer !== e.pointerId) return;
        if (d.raf) {
            cancelAnimationFrame(d.raf);
            seekAtX(d.x);
        }
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    };
    useEffect(
        () => () => {
            if (drag.current?.raf) cancelAnimationFrame(drag.current.raf);
        },
        [],
    );

    const phraseName = phraseKind ? t(PHRASE_NAME[phraseKind]) : null;
    const total = formatClock(duration);
    const id = deckId.toUpperCase();

    return (
        <div
            ref={rootRef}
            role="slider"
            tabIndex={canSeek ? 0 : -1}
            aria-label={label ?? t("deckui.seekAria", { id })}
            aria-orientation="horizontal"
            aria-disabled={canSeek ? undefined : true}
            aria-valuemin={0}
            aria-valuemax={Math.max(0, Math.round(duration))}
            aria-valuenow={valueNow}
            aria-valuetext={phraseName ? t("deckui.seekValuePhrase", { pos, total, phrase: phraseName }) : t("deckui.seekValue", { pos, total })}
            title={canSeek ? t("deckui.seekHint") : undefined}
            className={cn("dk-wave deck-overview", className)}
            data-seekable={canSeek ? "true" : "false"}
            style={{ ["--deck" as string]: accent }}
            onPointerDown={(e) => {
                if (e.button !== 0 || !canSeek) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { pointer: e.pointerId, x: e.clientX, raf: 0 };
                seekAtX(e.clientX);
            }}
            onPointerMove={(e) => {
                const d = drag.current;
                if (!d || d.pointer !== e.pointerId) return;
                d.x = e.clientX;
                // At most one seek per frame, however fast the pointer reports.
                if (!d.raf)
                    d.raf = requestAnimationFrame(() => {
                        d.raf = 0;
                        if (drag.current === d) seekAtX(d.x);
                    });
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={(e) => {
                if (!canSeek || e.ctrlKey || e.metaKey || e.altKey) return;
                const now = deckNow(deckId);
                const next = keySeekTarget(e.key, now.position, now.duration);
                if (next === null) return;
                // The arrows are also global deck shortcuts: here they belong to the strip.
                e.preventDefault();
                e.stopPropagation();
                seekTo(next);
            }}
        >
            <canvas ref={canvasRef} aria-hidden className="deck-overview-canvas" />
            {(phraseName || model?.fixed) && (
                <span aria-hidden className="deck-overview-tags">
                    {model?.fixed && <span className="dk-label deck-overview-fixed">{badge}</span>}
                    {phraseName && <span className="dk-label">{phraseName}</span>}
                </span>
            )}
        </div>
    );
});
