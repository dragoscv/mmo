/**
 * Spectrum of the main bus, from the engine's own analysis.
 *
 * The engine's audio callback only *taps* the mono main bus into a lock-free ring; the FFT runs on
 * the engine's control thread and arrives here as one byte per bin (0 = -90 dB, 255 = 0 dB) at
 * ~15 Hz, on the meter bus rather than through React state. Drawn as bars on a log frequency axis,
 * with the levels coloured by the same tokens as the meters.
 */
import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import { frameLoop, meterBus } from "../lib/meter-bus";
import { onPaletteChange, type Palette } from "../lib/palette";
import { useStore } from "../store";

/** The engine's published bin count; a frame with another length is drawn as far as it goes. */
const BINS = 128;
/** The engine maps its bins from -90 dB, which is a wide, mostly empty range on screen. Drawn from
 *  here up instead, so ordinary programme material reads as bars rather than a hairline (the
 *  rendered pass showed a voice-like fixture sitting at -60..-45 dB and barely visible). */
const FLOOR_DB = -70;
/** Grid lines, in Hz: what a performer actually reads (100 Hz, 1 kHz, 10 kHz). */
const GRID_HZ = [100, 1000, 10000];

/** A published byte (0 = -90 dB, 255 = 0 dB) as the height of its bar, 0..1. */
function barHeight(byte: number): number {
    const db = (byte / 255) * 90 - 90;
    return Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
}

export function Spectrum() {
    const t = useT();
    const ref = useRef<HTMLCanvasElement>(null);
    const sampleRate = useStore((s) => s.start?.info?.sample_rate ?? 48000);

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

        // Bin -> x on a log axis: bin `b` covers `b * nyquist / BINS` .. the next one.
        const nyquist = () => sampleRate / 2;
        const xOf = (hz: number, w: number) => (Math.log10(Math.max(20, hz) / 20) / Math.log10(nyquist() / 20)) * w;

        const stop = frameLoop(() => {
            const dpr = window.devicePixelRatio || 1;
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            // Grid first, so the bars sit on top of it.
            ctx.strokeStyle = pal.border;
            ctx.fillStyle = pal.text;
            ctx.font = "10px var(--font-mono, monospace)";
            ctx.textBaseline = "top";
            for (const hz of GRID_HZ) {
                if (hz >= nyquist()) continue;
                const x = xOf(hz, w);
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, h);
                ctx.stroke();
                ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 3, 2);
            }

            const bins = meterBus.spectrum;
            if (!bins || bins.length === 0) return;
            const grad = ctx.createLinearGradient(0, h, 0, 0);
            grad.addColorStop(0, pal.ok);
            grad.addColorStop(0.72, pal.ok);
            grad.addColorStop(0.88, pal.warn);
            grad.addColorStop(1, pal.hot);
            ctx.fillStyle = grad;
            const n = Math.min(bins.length, BINS);
            for (let i = 0; i < n; i++) {
                const x0 = xOf((i * nyquist()) / n, w);
                const x1 = xOf(((i + 1) * nyquist()) / n, w);
                const bar = Math.max(1, x1 - x0 - 1);
                const v = barHeight(bins[i] ?? 0);
                if (v <= 0) continue;
                ctx.fillRect(x0, h - v * h, bar, v * h);
            }
        });
        return () => {
            stop();
            ro.disconnect();
            off();
        };
    }, [sampleRate]);

    return (
        <section
            aria-label={t("spectrum.title")}
            className="surface relative min-h-24 flex-1 overflow-hidden rounded-2xl"
        >
            <canvas ref={ref} className="block h-full w-full" />
            <span className="pointer-events-none absolute end-3 top-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {t("spectrum.title")}
            </span>
        </section>
    );
}
