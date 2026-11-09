/**
 * Big input/output level meters on canvas, driven by the shared rAF loop (60 fps, ~10 fps with
 * reduced motion). Colours are read from design-token CSS variables at draw time.
 */
import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import { dbToPos, frameLoop } from "../lib/meter-bus";
import { linToDb } from "../lib/protocol";

interface Palette {
    track: string;
    ok: string;
    warn: string;
    hot: string;
    rms: string;
    text: string;
}

function readPalette(el: HTMLElement): Palette {
    const cs = getComputedStyle(el);
    const v = (name: string) => cs.getPropertyValue(name).trim();
    return {
        track: v("--muted"),
        ok: v("--success"),
        warn: v("--warning"),
        hot: v("--destructive"),
        rms: v("--primary"),
        text: v("--muted-foreground"),
    };
}

interface Channel {
    peak: number;
    rms: number;
    hold: number;
    holdAge: number;
}

const fresh = (): Channel => ({ peak: 0, rms: 0, hold: 0, holdAge: 0 });

/** Ballistics: instant attack, ~20 dB/s release (time-based so it is frame-rate independent). */
function follow(ch: Channel, peakDb: number, rmsDb: number, dt: number) {
    const p = dbToPos(peakDb);
    const r = dbToPos(rmsDb);
    const fall = dt * (20 / 66);
    ch.peak = p > ch.peak ? p : Math.max(p, ch.peak - fall);
    ch.rms = r > ch.rms ? r : Math.max(r, ch.rms - fall);
    if (p >= ch.hold) {
        ch.hold = p;
        ch.holdAge = 0;
    } else {
        ch.holdAge += dt;
        if (ch.holdAge > 1.2) ch.hold = Math.max(p, ch.hold - fall * 1.5);
    }
}

function drawBar(ctx: CanvasRenderingContext2D, x: number, w: number, h: number, ch: Channel, pal: Palette) {
    const radius = Math.min(6, w / 2);
    ctx.fillStyle = pal.track;
    ctx.beginPath();
    ctx.roundRect(x, 0, w, h, radius);
    ctx.fill();
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, pal.ok);
    grad.addColorStop(dbToPos(-12), pal.ok);
    grad.addColorStop(dbToPos(-6), pal.warn);
    grad.addColorStop(dbToPos(0), pal.hot);
    grad.addColorStop(1, pal.hot);
    const ph = ch.peak * h;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, 0, w, h, radius);
    ctx.clip();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = grad;
    ctx.fillRect(x, h - ph, w, ph);
    ctx.globalAlpha = 1;
    const rh = ch.rms * h;
    ctx.fillRect(x + w * 0.18, h - rh, w * 0.64, rh);
    const hy = h - ch.hold * h;
    ctx.fillStyle = ch.hold >= dbToPos(0) ? pal.hot : pal.text;
    ctx.fillRect(x, Math.max(0, hy - 1), w, 2);
    ctx.restore();
}

function drawScale(ctx: CanvasRenderingContext2D, x: number, h: number, pal: Palette) {
    ctx.fillStyle = pal.text;
    ctx.font = "10px var(--font-mono, monospace)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const db of [6, 0, -6, -12, -24, -36, -48, -60]) {
        const y = h - dbToPos(db) * h;
        ctx.fillText(String(db), x, Math.min(h - 6, Math.max(6, y)));
    }
}

export function LevelMeters() {
    const t = useT();
    const ref = useRef<HTMLCanvasElement>(null);
    const clipRef = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        let pal = readPalette(canvas);
        const chans = [fresh(), fresh(), fresh()];
        const ro = new ResizeObserver(() => {
            const dpr = window.devicePixelRatio || 1;
            canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
            canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
            pal = readPalette(canvas);
        });
        ro.observe(canvas);
        const mo = new MutationObserver(() => (pal = readPalette(canvas)));
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-accent", "data-surface"] });
        let clipUntil = 0;
        const stop = frameLoop((m, dt) => {
            const [inp, l, r] = chans as [Channel, Channel, Channel];
            follow(inp, linToDb(m?.in_peak ?? 0), linToDb(m?.in_rms ?? 0), dt);
            follow(l, linToDb(m?.out_peak[0] ?? 0), linToDb(m?.out_rms[0] ?? 0), dt);
            follow(r, linToDb(m?.out_peak[1] ?? 0), linToDb(m?.out_rms[1] ?? 0), dt);
            const dpr = window.devicePixelRatio || 1;
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const scaleW = 26;
            const gap = 10;
            const bar = Math.max(10, (w - scaleW - gap * 3) / 3);
            drawScale(ctx, scaleW - 4, h, pal);
            drawBar(ctx, scaleW + gap * 0.5, bar, h, inp, pal);
            drawBar(ctx, scaleW + gap * 2 + bar, bar, h, l, pal);
            drawBar(ctx, scaleW + gap * 2.5 + bar * 2, bar, h, r, pal);
            const now = performance.now();
            if (m?.clipped) clipUntil = now + 1500;
            if (clipRef.current) clipRef.current.dataset.on = now < clipUntil ? "true" : "false";
        });
        return () => {
            stop();
            ro.disconnect();
            mo.disconnect();
        };
    }, []);

    return (
        <section aria-label={t("meters.group")} className="surface flex h-full min-h-0 flex-col gap-2 rounded-2xl p-3">
            <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                <span className="ps-8">{t("meters.input")}</span>
                <span>
                    {t("meters.output")} {t("meters.left")}/{t("meters.right")}
                </span>
                <span
                    ref={clipRef}
                    data-on="false"
                    className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors duration-(--dur-fast) data-[on=true]:bg-destructive data-[on=true]:text-destructive-foreground data-[on=false]:bg-muted data-[on=false]:text-muted-foreground"
                >
                    {t("meters.clip")}
                </span>
            </div>
            <div className="min-h-0 flex-1">
                <canvas ref={ref} className="meter-canvas" aria-hidden />
            </div>
        </section>
    );
}

/** Small horizontal gain-reduction bar for an insert card (0..24 dB). */
export function GrBar({ index, label }: { index: number; label: string }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let v = 0;
        return frameLoop((m, dt) => {
            const gr = Math.max(0, Math.abs(m?.gr[index] ?? 0));
            const target = Math.min(1, gr / 24);
            v = target > v ? target : Math.max(target, v - dt * 0.8);
            if (ref.current) ref.current.style.transform = `scaleX(${v})`;
        });
    }, [index]);
    return (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={label}>
            <div ref={ref} className="h-full origin-right bg-warning" style={{ transform: "scaleX(0)" }} />
        </div>
    );
}
