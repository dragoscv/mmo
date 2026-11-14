/**
 * The pitch ribbon: the main visual of the performance screen (WP21-20, direction A). A scrolling
 * trace of how far the voice is from the note the correction is aiming at, over the last few
 * seconds, over an in-tune band — so the singer reads the shape, not a number. The exact figures
 * stay in the tuner strip beside it. Reads `meters.tune` on the shared render loop.
 */
import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import { frameLoop } from "../lib/meter-bus";
import { onPaletteChange, type Palette } from "../lib/palette";
import { noteName } from "../lib/protocol";

/** Seconds shown across the width. */
const WINDOW_S = 4;
/** Cents at the top and bottom edge; deeper errors pin to the edge. */
const RANGE = 60;
/** One sample per this many milliseconds, so the time axis does not depend on the frame rate. */
const STEP_MS = 1000 / 40;
const CAP = Math.ceil((WINDOW_S * 1000) / STEP_MS);

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function PitchRibbon() {
    const t = useT();
    const ref = useRef<HTMLCanvasElement>(null);
    const ariaRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        let pal: Palette = { track: "", ok: "", warn: "", hot: "", rms: "", text: "", border: "", card: "" };
        const off = onPaletteChange(canvas, (p) => (pal = p));
        const ro = new ResizeObserver(() => {
            const dpr = window.devicePixelRatio || 1;
            canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
            canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
        });
        ro.observe(canvas);

        // Ring buffer of input error and of what is left after the correction. `NaN` = unvoiced.
        const err = new Float32Array(CAP).fill(NaN);
        const left = new Float32Array(CAP).fill(NaN);
        let head = 0;
        let acc = STEP_MS;
        let lastLabel = "";

        const y = (h: number, cents: number) => h / 2 - (clamp(cents, -RANGE, RANGE) / RANGE) * (h / 2 - 6);

        const stop = frameLoop((m, dtMs) => {
            const dpr = window.devicePixelRatio || 1;
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;
            const tune = m?.tune;
            const voiced = !!tune && tune.freq > 0 && tune.midi > 0;

            acc += dtMs;
            while (acc >= STEP_MS) {
                acc -= STEP_MS;
                err[head] = voiced ? tune.cents : NaN;
                left[head] = voiced ? tune.cents + tune.correction_cents : NaN;
                head = (head + 1) % CAP;
            }

            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const band = (cents: number, fill: string) => {
                ctx.fillStyle = fill;
                const top = y(h, cents);
                ctx.fillRect(0, top, w, y(h, -cents) - top);
            };
            band(20, `color-mix(in oklab, ${pal.warn} 10%, transparent)`);
            band(5, `color-mix(in oklab, ${pal.ok} 16%, transparent)`);
            ctx.strokeStyle = pal.border;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, y(h, 0));
            ctx.lineTo(w, y(h, 0));
            ctx.stroke();

            const line = (data: Float32Array, width: number, alpha: number, colourAt: (v: number) => string) => {
                ctx.lineWidth = width;
                let px = 0;
                let py = 0;
                let has = false;
                for (let i = 0; i < CAP; i++) {
                    const v = data[(head + i) % CAP] ?? NaN;
                    if (Number.isNaN(v)) {
                        has = false;
                        continue;
                    }
                    const x = (i / (CAP - 1)) * w;
                    const yy = y(h, v);
                    if (has) {
                        ctx.globalAlpha = alpha;
                        ctx.strokeStyle = colourAt(Math.abs(v));
                        ctx.beginPath();
                        ctx.moveTo(px, py);
                        ctx.lineTo(x, yy);
                        ctx.stroke();
                    }
                    px = x;
                    py = yy;
                    has = true;
                }
                ctx.globalAlpha = 1;
            };
            // What is left after the correction first (dimmer), then how far the singer is.
            line(left, 1, 0.55, () => pal.text);
            line(err, 2, 1, (c) => (c < 5 ? pal.ok : c < 20 ? pal.warn : pal.hot));

            // The live point.
            if (voiced) {
                const c = tune.cents;
                ctx.fillStyle = Math.abs(c) < 5 ? pal.ok : Math.abs(c) < 20 ? pal.warn : pal.hot;
                ctx.beginPath();
                ctx.arc(w - 3, y(h, c), 3.5, 0, Math.PI * 2);
                ctx.fill();
            }

            const label = voiced
                ? `${noteName(tune.midi)} · ${Math.round(tune.cents)} ¢`
                : t("pitch.idle");
            if (label !== lastLabel && ariaRef.current) {
                lastLabel = label;
                ariaRef.current.textContent = label;
            }
        });
        return () => {
            stop();
            ro.disconnect();
            off();
        };
    }, [t]);

    return (
        <section
            aria-label={t("pitch.title")}
            className="surface relative min-h-40 flex-1 overflow-hidden rounded-2xl"
        >
            <canvas ref={ref} className="block h-full w-full" />
            <div className="pointer-events-none absolute end-3 top-2 text-right">
                <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                    {t("pitch.title")}
                </span>
                <div ref={ariaRef} className="font-heading text-lg font-semibold tabular-nums" aria-live="off">
                    {t("pitch.idle")}
                </div>
            </div>
        </section>
    );
}
