import { useEffect, useRef } from "react";
import type { DeckState } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { useT } from "@/i18n";
import { beatLines, gridFromDeck, type GridModel } from "@/grid/markers";
import { useDeckGrid } from "@/grid/grid-store";

/**
 * Canvas colours. Design tokens only (packages/design-tokens): the canvas has no CSS, so each
 * one is resolved through the element's computed `color` and shaded with `globalAlpha` —
 * never a hand-written colour literal (the repo hex-gate only sees `#rrggbb`, so the guard in
 * `src/grid/tokens-i18n.test.ts` covers the function forms too).
 */
const FOREGROUND = "var(--fg)";
const WARNING = "var(--warning)";
const BACKGROUND = "var(--bg)";

interface WaveformProps {
    deck: DeckState;
    accent: string;
    className?: string;
    /** Accessible name; the canvas is decorative (aria-hidden) when omitted. */
    label?: string;
    /**
     * Badge drawn when the deck's grid is fixed. The canvas cannot call `useT()`, so the
     * translated word is resolved in the component and handed to the draw loop through a ref.
     * Defaults to `t("grid.fixed")`; pass it only to override.
     */
    fixedLabel?: string;
}

/**
 * Waveform overview. Renders real downsampled peaks computed at decode time
 * (stored per deck in the mixer store) with a played/unplayed split, the loop
 * region, hot-cue markers, and a playhead. The beatgrid follows the deck's tempo
 * markers (WP19-37): a tempo change is drawn in the warning colour with its BPM,
 * and a fixed grid gets a "FIXED" badge. Falls back to a faint procedural pattern
 * when no track is loaded so the layout reads during design.
 *
 * Fills its parent box (the deck gives it the flexible row), follows size
 * changes with a ResizeObserver, and runs ONE animation loop that reads the
 * latest deck snapshot from a ref (no effect teardown on every 30 Hz update).
 */
export function Waveform({ deck, accent, className, label, fixedLabel }: WaveformProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const peaks = useMixerStore((s) => s.waveforms[deck.id]);
    const grid = useDeckGrid(deck.id, deck.trackId);
    const t = useT();
    // The 30 Hz draw loop reads the latest values from a ref, so the translated badge is
    // resolved here (hooks only run in the component) and never inside `draw`.
    const badge = fixedLabel ?? t("grid.fixed");
    const live = useRef({ deck, peaks, accent, grid, badge });
    live.current = { deck, peaks, accent, grid, badge };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        let dpr = window.devicePixelRatio || 1;
        // Canvas cannot parse a CSS variable or an oklch colour: every colour is resolved
        // through the element's computed `color`, so all of them come from the design tokens
        // and follow the theme.
        const resolved = new Map<string, string>();
        const resolve = (css: string): string => {
            const hit = resolved.get(css);
            if (hit !== undefined) return hit;
            const before = canvas.style.color;
            canvas.style.color = css;
            const value = getComputedStyle(canvas).color || css;
            canvas.style.color = before;
            resolved.set(css, value);
            return value;
        };
        /** A token colour at `alpha` — opacity through `globalAlpha`, never baked into the colour. */
        const paint = (css: string, alpha: number) => {
            ctx.fillStyle = resolve(css);
            ctx.globalAlpha = alpha;
        };
        // Theme changes (mode / accent / skin) invalidate every resolved colour.
        const themeObserver =
            typeof MutationObserver !== "undefined"
                ? new MutationObserver(() => resolved.clear())
                : null;
        themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-accent", "style", "class"] });
        const resize = () => {
            dpr = window.devicePixelRatio || 1;
            const { clientWidth, clientHeight } = canvas;
            canvas.width = Math.max(1, Math.round(clientWidth * dpr));
            canvas.height = Math.max(1, Math.round(clientHeight * dpr));
        };
        resize();

        let raf = 0;
        const draw = () => {
            const { deck, peaks, grid, badge } = live.current;
            const accent = resolve(live.current.accent);
            const w = canvas.width;
            const h = canvas.height;
            ctx.clearRect(0, 0, w, h);
            ctx.globalAlpha = 1;

            const mid = h / 2;
            const progress = deck.duration > 0 ? deck.position / deck.duration : 0;

            // Loop region shading.
            if (deck.loopActive && deck.duration > 0 && deck.loopEnd > deck.loopStart) {
                const x0 = (deck.loopStart / deck.duration) * w;
                const x1 = (deck.loopEnd / deck.duration) * w;
                paint(WARNING, 0.16);
                ctx.fillRect(x0, 0, x1 - x0, h);
            }

            const hasPeaks = peaks && peaks.length > 0;
            const bars = Math.floor(w / (3 * dpr));

            // Beatgrid: the deck's tempo markers when it has them, else a constant grid.
            const model: GridModel | null =
                deck.bpm > 0 && deck.duration > 0
                    ? (grid ?? gridFromDeck(deck.bpm, deck.firstBeat))
                    : null;
            if (model) {
                for (const line of beatLines(model, 0, deck.duration)) {
                    if (line.sec < 0) continue;
                    const x = (line.sec / deck.duration) * w;
                    paint(FOREGROUND, line.downbeat ? 0.22 : 0.08);
                    ctx.fillRect(x, 0, (line.downbeat ? 1.4 : 0.8) * dpr, h);
                }
            }

            for (let i = 0; i < bars; i++) {
                const x = i * 3 * dpr;
                const t = i / bars;
                let norm: number;
                if (hasPeaks) {
                    const idx = Math.min(peaks.length - 1, Math.floor(t * peaks.length));
                    norm = peaks[idx] ?? 0;
                } else {
                    const seed = Math.sin(i * 0.35) * 0.5 + Math.sin(i * 0.11) * 0.5;
                    norm = (0.25 + Math.abs(seed) * 0.7) * (deck.loaded ? 0.5 : 0.12);
                }
                const amp = Math.max(norm * mid, dpr);
                const played = t < progress;
                if (played) {
                    ctx.fillStyle = accent;
                    ctx.globalAlpha = 1;
                } else {
                    paint(FOREGROUND, 0.22);
                }
                ctx.fillRect(x, mid - amp, 2 * dpr, amp * 2);
            }

            // Hot-cue markers.
            if (deck.duration > 0) {
                for (const c of deck.hotCues) {
                    if (c == null) continue;
                    const x = (c / deck.duration) * w;
                    paint(FOREGROUND, 0.85);
                    ctx.fillRect(x - dpr * 0.5, 0, dpr, h);
                    ctx.fillStyle = accent;
                    ctx.globalAlpha = 1;
                    ctx.fillRect(x - dpr * 1.5, 0, dpr * 3, dpr * 4);
                }
            }

            // Tempo-change markers: a distinct colour plus the new BPM.
            if (model && deck.duration > 0 && model.markers.length > 0) {
                const dim = model.fixed;
                ctx.font = `${Math.round(9 * dpr)}px system-ui, sans-serif`;
                ctx.textBaseline = "top";
                for (const m of model.markers) {
                    if (m.sec < 0 || m.sec > deck.duration) continue;
                    const x = (m.sec / deck.duration) * w;
                    paint(WARNING, dim ? 0.3 : 0.95);
                    ctx.fillRect(x - dpr * 0.5, 0, 1.6 * dpr, h);
                    ctx.fillRect(x - dpr * 2.5, 0, dpr * 5, dpr * 3);
                    ctx.fillText(m.bpm.toFixed(1), x + 3 * dpr, 4 * dpr);
                }
            }

            // Fixed-grid badge (translated: `grid.fixed`, resolved in the component).
            if (model?.fixed && badge) {
                ctx.font = `${Math.round(9 * dpr)}px system-ui, sans-serif`;
                ctx.textBaseline = "top";
                const text = badge;
                const tw = ctx.measureText(text).width;
                paint(BACKGROUND, 0.55);
                ctx.fillRect(w - tw - 10 * dpr, 3 * dpr, tw + 7 * dpr, 13 * dpr);
                paint(WARNING, 0.95);
                ctx.fillText(text, w - tw - 6 * dpr, 5 * dpr);
            }

            // Playhead.
            paint(FOREGROUND, 0.9);
            ctx.fillRect(progress * w - dpr, 0, 2 * dpr, h);
            ctx.globalAlpha = 1;

            raf = requestAnimationFrame(draw);
        };
        draw();

        const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
        ro?.observe(canvas);
        window.addEventListener("resize", resize);
        return () => {
            cancelAnimationFrame(raf);
            ro?.disconnect();
            themeObserver?.disconnect();
            window.removeEventListener("resize", resize);
        };
    }, []);

    return (
        <canvas
            ref={canvasRef}
            aria-hidden={label ? undefined : true}
            role={label ? "img" : undefined}
            aria-label={label}
            className={className}
            style={{
                width: "100%",
                height: "100%",
                minHeight: 0,
                display: "block",
                borderRadius: 10,
                background: "var(--bg-elev)",
                border: "1px solid var(--border)",
            }}
        />
    );
}
