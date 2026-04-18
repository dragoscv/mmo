"use client";

/**
 * LiveEqWidget — Beautiful, animated EQ widget for the Live page.
 *
 * Two modes:
 *   - Simple   → 3-band shelf/peak/shelf EQ (uses the existing `eq3` FX type).
 *   - Advanced → 3-band fully parametric EQ (uses the existing `parametricEq` FX
 *                type). Drag the band points directly on the response curve,
 *                or use the per-band Freq/Gain/Q knobs underneath.
 *
 * The widget auto-manages its own EQ insert inside the voice chain. If the
 * voice chain already contains a suitable EQ insert, the widget controls that
 * one; otherwise it inserts one when enabled.
 *
 * The canvas overlays the live spectrum (from the master FFT analyser) behind
 * the calculated EQ frequency response, and shows draggable band markers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLive } from "./live-context";
import { cn } from "@/lib/utils";
import { Power, Settings2, RotateCcw, Sliders, ChevronRight, ChevronDown } from "lucide-react";
import type { FxInsert } from "@/lib/audio-fx-engine";
import { FX_DEFAULTS } from "@/lib/audio-fx-engine";
import { useLiveSettings } from "@/hooks/use-live-settings";
import { useLiveWidgetSlot } from "@/components/live/live-widget-slot";

// ─── Constants ───────────────────────────────────────────────────────────────

const F_MIN = 20;
const F_MAX = 20_000;
const DB_RANGE = 24;          // ±24 dB
const FREQ_LABELS = [50, 100, 200, 500, 1000, 2000, 5000, 10_000];
const DB_LINES = [-18, -12, -6, 0, 6, 12, 18];
const ACCENT_COLORS: Record<string, string> = {
    rose: "#f43f5e",
    violet: "#8b5cf6",
    emerald: "#10b981",
    cyan: "#06b6d4",
    amber: "#f59e0b",
};

// ─── Math helpers ────────────────────────────────────────────────────────────

const log10 = (x: number) => Math.log(x) / Math.LN10;

/** Map frequency to normalized [0,1] x position (logarithmic). */
function freqToX(f: number): number {
    return (log10(f) - log10(F_MIN)) / (log10(F_MAX) - log10(F_MIN));
}
/** Inverse of `freqToX`. */
function xToFreq(x: number): number {
    return Math.pow(10, log10(F_MIN) + x * (log10(F_MAX) - log10(F_MIN)));
}
/** Map dB gain to normalized [0,1] y position (0 = top = +DB_RANGE). */
function dbToY(db: number): number {
    return 1 - (db + DB_RANGE) / (2 * DB_RANGE);
}
function yToDb(y: number): number {
    return (1 - y) * 2 * DB_RANGE - DB_RANGE;
}

/**
 * Compute the magnitude (dB) response of a single biquad filter at a given
 * frequency, sample rate, parameters. Implements the analytic transfer
 * function for the relevant Web Audio biquad types.
 *
 * Reference: Web Audio API spec — BiquadFilterNode.
 */
function biquadMagnitudeDb(
    type: "lowshelf" | "highshelf" | "peaking",
    freq: number,
    gainDb: number,
    Q: number,
    f: number,
    sampleRate: number,
): number {
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const cosw = Math.cos(w0);
    const sinw = Math.sin(w0);
    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    if (type === "peaking") {
        const alpha = sinw / (2 * Math.max(0.0001, Q));
        b0 = 1 + alpha * A;
        b1 = -2 * cosw;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * cosw;
        a2 = 1 - alpha / A;
    } else if (type === "lowshelf") {
        const S = 1;
        const alpha = (sinw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
        b0 = A * ((A + 1) - (A - 1) * cosw + 2 * Math.sqrt(A) * alpha);
        b1 = 2 * A * ((A - 1) - (A + 1) * cosw);
        b2 = A * ((A + 1) - (A - 1) * cosw - 2 * Math.sqrt(A) * alpha);
        a0 = (A + 1) + (A - 1) * cosw + 2 * Math.sqrt(A) * alpha;
        a1 = -2 * ((A - 1) + (A + 1) * cosw);
        a2 = (A + 1) + (A - 1) * cosw - 2 * Math.sqrt(A) * alpha;
    } else {
        // highshelf
        const S = 1;
        const alpha = (sinw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
        b0 = A * ((A + 1) + (A - 1) * cosw + 2 * Math.sqrt(A) * alpha);
        b1 = -2 * A * ((A - 1) + (A + 1) * cosw);
        b2 = A * ((A + 1) + (A - 1) * cosw - 2 * Math.sqrt(A) * alpha);
        a0 = (A + 1) - (A - 1) * cosw + 2 * Math.sqrt(A) * alpha;
        a1 = 2 * ((A - 1) - (A + 1) * cosw);
        a2 = (A + 1) - (A - 1) * cosw - 2 * Math.sqrt(A) * alpha;
    }
    // Evaluate H(e^jw) at f
    const w = (2 * Math.PI * f) / sampleRate;
    const c1 = Math.cos(w), s1 = Math.sin(w);
    const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const numRe = b0 + b1 * c1 + b2 * c2;
    const numIm = -b1 * s1 - b2 * s2;
    const denRe = a0 + a1 * c1 + a2 * c2;
    const denIm = -a1 * s1 - a2 * s2;
    const numMag = Math.sqrt(numRe * numRe + numIm * numIm);
    const denMag = Math.sqrt(denRe * denRe + denIm * denIm);
    const mag = numMag / Math.max(1e-9, denMag);
    return 20 * log10(Math.max(1e-9, mag));
}

// ─── Band model ──────────────────────────────────────────────────────────────

/** Maximum bands in advanced mode (= 3 stacked parametricEq inserts). */
const MAX_BANDS = 9;
/** Minimum bands in advanced mode (so the EQ stays useful). */
const MIN_BANDS = 3;

/** Band marker hues — cycled when count > defaults. */
const BAND_PALETTE = [
    "#ef4444", // red    (low)
    "#10b981", // green  (mid)
    "#3b82f6", // blue   (high)
    "#f59e0b", // amber
    "#8b5cf6", // violet
    "#ec4899", // pink
    "#06b6d4", // cyan
    "#84cc16", // lime
    "#f97316", // orange
];

interface Band {
    type: "lowshelf" | "highshelf" | "peaking";
    freq: number;
    gain: number;
    q: number;
    label: string;
    /** Color hue for the band marker. */
    color: string;
}

function defaultAdvancedBands(): Band[] {
    return [
        { type: "peaking", freq: 200, gain: 0, q: 1, label: "B1", color: BAND_PALETTE[0] },
        { type: "peaking", freq: 1000, gain: 0, q: 1, label: "B2", color: BAND_PALETTE[1] },
        { type: "peaking", freq: 5000, gain: 0, q: 1, label: "B3", color: BAND_PALETTE[2] },
    ];
}

function defaultSimpleBands(): Band[] {
    return [
        { type: "lowshelf", freq: 320, gain: 0, q: 0.7, label: "Low", color: BAND_PALETTE[0] },
        { type: "peaking", freq: 1000, gain: 0, q: 0.7, label: "Mid", color: BAND_PALETTE[1] },
        { type: "highshelf", freq: 3200, gain: 0, q: 0.7, label: "High", color: BAND_PALETTE[2] },
    ];
}

/**
 * Derive the band list from one or more EQ inserts. Multiple parametricEq
 * inserts are concatenated into a single logical band list, allowing >3 bands
 * via stacking (each parametricEq carries 3 peaking bands).
 */
function bandsFromInserts(inserts: FxInsert[], mode: "simple" | "advanced"): Band[] {
    if (inserts.length === 0) {
        return mode === "simple" ? defaultSimpleBands() : defaultAdvancedBands();
    }
    if (mode === "simple") {
        // Simple mode is always backed by a single eq3 insert.
        const eq3 = inserts.find(i => i.type === "eq3") ?? inserts[0];
        if (eq3.type === "eq3") {
            return [
                { type: "lowshelf", freq: 320, gain: eq3.params.low ?? 0, q: 0.7, label: "Low", color: BAND_PALETTE[0] },
                { type: "peaking", freq: 1000, gain: eq3.params.mid ?? 0, q: 0.7, label: "Mid", color: BAND_PALETTE[1] },
                { type: "highshelf", freq: 3200, gain: eq3.params.high ?? 0, q: 0.7, label: "High", color: BAND_PALETTE[2] },
            ];
        }
        return defaultSimpleBands();
    }
    // Advanced: flatten all parametricEq inserts in order.
    const out: Band[] = [];
    let idx = 0;
    for (const insert of inserts) {
        if (insert.type !== "parametricEq") continue;
        for (let bandN = 1; bandN <= 3; bandN++) {
            const f = insert.params[`freq${bandN}`];
            const g = insert.params[`gain${bandN}`];
            const q = insert.params[`q${bandN}`];
            // Skip neutral filler bands beyond MIN_BANDS only if user has actively
            // added more — heuristic: if freq matches default exactly, treat
            // it as present anyway (user might have it neutral on purpose).
            out.push({
                type: "peaking",
                freq: f ?? 1000,
                gain: g ?? 0,
                q: q ?? 1,
                label: `B${idx + 1}`,
                color: BAND_PALETTE[idx % BAND_PALETTE.length],
            });
            idx++;
        }
    }
    if (out.length === 0) return defaultAdvancedBands();
    return out;
}

// ─── Tiny knob ───────────────────────────────────────────────────────────────

function MiniKnob({ value, min, max, color, label, format, onChange, onReset }: {
    value: number; min: number; max: number; color: string; label: string;
    format?: (v: number) => string;
    onChange: (v: number) => void;
    onReset?: () => void;
}) {
    const startRef = useRef<{ y: number; v: number } | null>(null);
    const norm = (value - min) / (max - min);
    const angle = -135 + norm * 270;
    const size = 36;
    const r = size * 0.4;
    const c = size / 2;
    const circ = 2 * Math.PI * r;
    return (
        <div className="flex flex-col items-center gap-0.5 select-none touch-none">
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="cursor-ns-resize"
                onPointerDown={e => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); startRef.current = { y: e.clientY, v: value }; }}
                onPointerMove={e => {
                    if (!startRef.current) return;
                    const dy = startRef.current.y - e.clientY;
                    const delta = (dy / 120) * (max - min);
                    onChange(Math.max(min, Math.min(max, startRef.current.v + delta)));
                }}
                onPointerUp={() => { startRef.current = null; }}
                onDoubleClick={onReset}>
                <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="2"
                    strokeDasharray={`${circ * 0.75} ${circ}`} strokeLinecap="round"
                    transform={`rotate(135 ${c} ${c})`} />
                <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth="2"
                    strokeDasharray={`${circ * 0.75 * norm} ${circ}`} strokeLinecap="round"
                    transform={`rotate(135 ${c} ${c})`}
                    style={{ filter: `drop-shadow(0 0 3px ${color}80)` }} />
                <line x1={c} y1={c} x2={c} y2={c - r * 0.85} stroke={color} strokeWidth="2" strokeLinecap="round"
                    transform={`rotate(${angle} ${c} ${c})`} />
            </svg>
            <span className="text-[8px] text-white/40 uppercase tracking-wider leading-none">{label}</span>
            <span className="text-[9px] text-white/60 tabular-nums leading-none">{format ? format(value) : value.toFixed(1)}</span>
        </div>
    );
}

// ─── EQ Canvas ───────────────────────────────────────────────────────────────

interface EqCanvasProps {
    bands: Band[];
    enabled: boolean;
    accent: string;
    /** AnalyserNode to draw spectrum from (master fft). May be null. */
    analyser: AnalyserNode | null;
    sampleRate: number;
    /** Called when a band's freq/gain is dragged. */
    onBandChange: (idx: number, patch: Partial<Pick<Band, "freq" | "gain" | "q">>) => void;
    /** Selected band index (drives knob color highlight). */
    selectedBand: number;
    onSelectBand: (idx: number) => void;
    /**
     * Right-click on empty canvas area → add a new band at the click point.
     * Right-click on an existing band → remove it (caller may reject if at min).
     * Pass `null` to disable (e.g. simple mode).
     */
    onAddBand: ((freq: number, gain: number) => void) | null;
    onRemoveBand: ((idx: number) => void) | null;
}

function EqCanvas({ bands, enabled, accent, analyser, sampleRate, onBandChange, selectedBand, onSelectBand, onAddBand, onRemoveBand }: EqCanvasProps) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const sizeRef = useRef({ w: 0, h: 0 });
    const dragRef = useRef<{ idx: number; mode: "move" | "q" } | null>(null);
    const bandsRef = useRef(bands);
    const enabledRef = useRef(enabled);
    const accentRef = useRef(accent);
    const selRef = useRef(selectedBand);
    bandsRef.current = bands;
    enabledRef.current = enabled;
    accentRef.current = accent;
    selRef.current = selectedBand;

    // Smoothed spectrum buffer for nicer animation.
    const spectrumSmoothRef = useRef<Float32Array | null>(null);

    // ── ResizeObserver + DPR-aware sizing
    useEffect(() => {
        const wrap = wrapRef.current;
        const canvas = canvasRef.current;
        if (!wrap || !canvas) return;
        const ro = new ResizeObserver(() => {
            const dpr = window.devicePixelRatio || 1;
            const w = wrap.clientWidth;
            const h = wrap.clientHeight;
            sizeRef.current = { w, h };
            canvas.width = Math.max(1, Math.floor(w * dpr));
            canvas.height = Math.max(1, Math.floor(h * dpr));
            canvas.style.width = `${w}px`;
            canvas.style.height = `${h}px`;
            const ctx = canvas.getContext("2d");
            if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        });
        ro.observe(wrap);
        return () => ro.disconnect();
    }, []);

    // ── Render loop
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx2 = canvas.getContext("2d");
        if (!ctx2) return;
        let raf = 0;
        let alive = true;

        const draw = () => {
            if (!alive) return;
            const { w, h } = sizeRef.current;
            if (w === 0 || h === 0) {
                raf = requestAnimationFrame(draw);
                return;
            }
            const padL = 28, padR = 8, padT = 8, padB = 16;
            const innerW = Math.max(1, w - padL - padR);
            const innerH = Math.max(1, h - padT - padB);

            // Clear
            ctx2.clearRect(0, 0, w, h);

            // Background gradient
            const bg = ctx2.createLinearGradient(0, 0, 0, h);
            bg.addColorStop(0, "rgba(255,255,255,0.015)");
            bg.addColorStop(1, "rgba(0,0,0,0.25)");
            ctx2.fillStyle = bg;
            ctx2.fillRect(padL, padT, innerW, innerH);

            // Grid: dB lines
            ctx2.strokeStyle = "rgba(255,255,255,0.05)";
            ctx2.lineWidth = 1;
            ctx2.font = "9px ui-sans-serif, system-ui";
            ctx2.fillStyle = "rgba(255,255,255,0.25)";
            ctx2.textAlign = "right";
            ctx2.textBaseline = "middle";
            for (const db of DB_LINES) {
                const y = padT + dbToY(db) * innerH;
                ctx2.beginPath();
                ctx2.moveTo(padL, y);
                ctx2.lineTo(padL + innerW, y);
                ctx2.stroke();
                if (db === 0) {
                    ctx2.strokeStyle = "rgba(255,255,255,0.13)";
                    ctx2.beginPath();
                    ctx2.moveTo(padL, y);
                    ctx2.lineTo(padL + innerW, y);
                    ctx2.stroke();
                    ctx2.strokeStyle = "rgba(255,255,255,0.05)";
                }
                ctx2.fillText(`${db > 0 ? "+" : ""}${db}`, padL - 3, y);
            }

            // Grid: freq lines + labels
            ctx2.textAlign = "center";
            ctx2.textBaseline = "top";
            ctx2.fillStyle = "rgba(255,255,255,0.25)";
            for (const f of FREQ_LABELS) {
                const x = padL + freqToX(f) * innerW;
                ctx2.strokeStyle = "rgba(255,255,255,0.04)";
                ctx2.beginPath();
                ctx2.moveTo(x, padT);
                ctx2.lineTo(x, padT + innerH);
                ctx2.stroke();
                const label = f >= 1000 ? `${f / 1000}k` : `${f}`;
                ctx2.fillText(label, x, padT + innerH + 2);
            }

            // ── Spectrum (background fill)
            if (analyser) {
                const bins = analyser.frequencyBinCount;
                const buf = new Uint8Array(new ArrayBuffer(bins));
                analyser.getByteFrequencyData(buf);
                if (!spectrumSmoothRef.current || spectrumSmoothRef.current.length !== bins) {
                    spectrumSmoothRef.current = new Float32Array(bins);
                }
                const smooth = spectrumSmoothRef.current;
                // Smooth (attack faster than release)
                for (let i = 0; i < bins; i++) {
                    const target = buf[i] / 255;
                    smooth[i] = target > smooth[i] ? smooth[i] * 0.5 + target * 0.5 : smooth[i] * 0.85 + target * 0.15;
                }
                // Build path along log frequency
                ctx2.beginPath();
                ctx2.moveTo(padL, padT + innerH);
                const N = 96;
                for (let i = 0; i <= N; i++) {
                    const xn = i / N;
                    const f = xToFreq(xn);
                    const bin = Math.min(bins - 1, Math.max(0, Math.round((f / (sampleRate / 2)) * bins)));
                    const v = smooth[bin] || 0;
                    const x = padL + xn * innerW;
                    const y = padT + innerH - v * innerH * 0.85;
                    ctx2.lineTo(x, y);
                }
                ctx2.lineTo(padL + innerW, padT + innerH);
                ctx2.closePath();
                const grad = ctx2.createLinearGradient(0, padT, 0, padT + innerH);
                grad.addColorStop(0, accentRef.current + "55");
                grad.addColorStop(0.5, accentRef.current + "20");
                grad.addColorStop(1, accentRef.current + "08");
                ctx2.fillStyle = grad;
                ctx2.fill();
            }

            // ── EQ response curve
            const N = 256;
            const curve: number[] = new Array(N + 1);
            for (let i = 0; i <= N; i++) {
                const xn = i / N;
                const f = xToFreq(xn);
                let totalDb = 0;
                if (enabledRef.current) {
                    for (const b of bandsRef.current) {
                        totalDb += biquadMagnitudeDb(b.type, b.freq, b.gain, b.q, f, sampleRate);
                    }
                }
                curve[i] = totalDb;
            }

            // Glow under curve (filled)
            ctx2.beginPath();
            ctx2.moveTo(padL, padT + dbToY(0) * innerH);
            for (let i = 0; i <= N; i++) {
                const x = padL + (i / N) * innerW;
                const y = padT + dbToY(curve[i]) * innerH;
                ctx2.lineTo(x, y);
            }
            ctx2.lineTo(padL + innerW, padT + dbToY(0) * innerH);
            ctx2.closePath();
            const fillGrad = ctx2.createLinearGradient(0, padT, 0, padT + innerH);
            fillGrad.addColorStop(0, accentRef.current + (enabledRef.current ? "30" : "10"));
            fillGrad.addColorStop(0.5, accentRef.current + (enabledRef.current ? "10" : "05"));
            fillGrad.addColorStop(1, "transparent");
            ctx2.fillStyle = fillGrad;
            ctx2.fill();

            // Stroke
            ctx2.beginPath();
            for (let i = 0; i <= N; i++) {
                const x = padL + (i / N) * innerW;
                const y = padT + dbToY(curve[i]) * innerH;
                if (i === 0) ctx2.moveTo(x, y); else ctx2.lineTo(x, y);
            }
            ctx2.strokeStyle = enabledRef.current ? accentRef.current : "rgba(255,255,255,0.25)";
            ctx2.lineWidth = 2;
            ctx2.shadowColor = enabledRef.current ? accentRef.current : "transparent";
            ctx2.shadowBlur = enabledRef.current ? 6 : 0;
            ctx2.stroke();
            ctx2.shadowBlur = 0;

            // Band markers
            for (let i = 0; i < bandsRef.current.length; i++) {
                const b = bandsRef.current[i];
                const x = padL + freqToX(b.freq) * innerW;
                const y = padT + dbToY(b.gain) * innerH;
                const isSel = selRef.current === i;
                const r = isSel ? 7 : 5;
                ctx2.beginPath();
                ctx2.arc(x, y, r + 4, 0, Math.PI * 2);
                ctx2.fillStyle = b.color + "22";
                ctx2.fill();
                ctx2.beginPath();
                ctx2.arc(x, y, r, 0, Math.PI * 2);
                ctx2.fillStyle = enabledRef.current ? b.color : "#555";
                ctx2.shadowColor = b.color;
                ctx2.shadowBlur = isSel ? 8 : 4;
                ctx2.fill();
                ctx2.shadowBlur = 0;
                // Label above
                ctx2.fillStyle = "rgba(255,255,255,0.55)";
                ctx2.font = "9px ui-sans-serif, system-ui";
                ctx2.textAlign = "center";
                ctx2.textBaseline = "bottom";
                ctx2.fillText(b.label, x, y - r - 3);
            }

            raf = requestAnimationFrame(draw);
        };
        raf = requestAnimationFrame(draw);

        const onVis = () => {
            if (document.hidden) {
                cancelAnimationFrame(raf);
            } else {
                raf = requestAnimationFrame(draw);
            }
        };
        document.addEventListener("visibilitychange", onVis);

        return () => {
            alive = false;
            cancelAnimationFrame(raf);
            document.removeEventListener("visibilitychange", onVis);
        };
    }, [analyser, sampleRate]);

    // ── Pointer interaction: drag bands
    const pickBandAt = useCallback((cx: number, cy: number): number => {
        const { w, h } = sizeRef.current;
        const padL = 28, padR = 8, padT = 8, padB = 16;
        const innerW = Math.max(1, w - padL - padR);
        const innerH = Math.max(1, h - padT - padB);
        let best = -1;
        let bestDist = 22; // px hit radius
        for (let i = 0; i < bandsRef.current.length; i++) {
            const b = bandsRef.current[i];
            const x = padL + freqToX(b.freq) * innerW;
            const y = padT + dbToY(b.gain) * innerH;
            const d = Math.hypot(cx - x, cy - y);
            if (d < bestDist) { bestDist = d; best = i; }
        }
        return best;
    }, []);

    const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const idx = pickBandAt(cx, cy);
        if (idx === -1) return;
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        const mode: "move" | "q" = e.shiftKey ? "q" : "move";
        dragRef.current = { idx, mode };
        onSelectBand(idx);
    }, [pickBandAt, onSelectBand]);

    const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!dragRef.current) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const { w, h } = sizeRef.current;
        const padL = 28, padR = 8, padT = 8, padB = 16;
        const innerW = Math.max(1, w - padL - padR);
        const innerH = Math.max(1, h - padT - padB);
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const xn = Math.max(0, Math.min(1, (cx - padL) / innerW));
        const yn = Math.max(0, Math.min(1, (cy - padT) / innerH));
        const f = Math.max(F_MIN, Math.min(F_MAX, xToFreq(xn)));
        const db = Math.max(-DB_RANGE, Math.min(DB_RANGE, yToDb(yn)));
        const { idx, mode } = dragRef.current;
        if (mode === "q") {
            const b = bandsRef.current[idx];
            // Map vertical drag to Q: top = high Q, bottom = low Q
            const qVal = Math.max(0.1, Math.min(20, 0.1 + (1 - yn) * 19.9));
            onBandChange(idx, { q: qVal });
            void b;
        } else {
            const b = bandsRef.current[idx];
            // Shelves: only allow gain changes (freq fixed by design)
            if (b.type === "lowshelf" || b.type === "highshelf") {
                onBandChange(idx, { gain: db });
            } else {
                onBandChange(idx, { freq: f, gain: db });
            }
        }
    }, [onBandChange]);

    const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (canvas && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        dragRef.current = null;
    }, []);

    const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const idx = pickBandAt(cx, cy);
        if (idx === -1) return;
        e.preventDefault();
        const b = bandsRef.current[idx];
        const delta = e.deltaY > 0 ? -1 : 1;
        const newQ = Math.max(0.1, Math.min(20, b.q * (1 + delta * 0.1)));
        onBandChange(idx, { q: newQ });
        onSelectBand(idx);
    }, [pickBandAt, onBandChange, onSelectBand]);

    const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        e.preventDefault();
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const idx = pickBandAt(cx, cy);
        if (idx !== -1) {
            // Right-click on a band → remove it.
            onRemoveBand?.(idx);
            return;
        }
        if (!onAddBand) return;
        // Compute click position in plot coords → add band there.
        const { w, h } = sizeRef.current;
        const padL = 28, padR = 8, padT = 8, padB = 16;
        const innerW = Math.max(1, w - padL - padR);
        const innerH = Math.max(1, h - padT - padB);
        const xn = Math.max(0, Math.min(1, (cx - padL) / innerW));
        const yn = Math.max(0, Math.min(1, (cy - padT) / innerH));
        const f = Math.max(F_MIN, Math.min(F_MAX, xToFreq(xn)));
        const db = Math.max(-DB_RANGE, Math.min(DB_RANGE, yToDb(yn)));
        onAddBand(f, db);
    }, [pickBandAt, onAddBand, onRemoveBand]);

    return (
        <div ref={wrapRef} className="relative w-full h-full rounded-xl border border-white/[0.06] bg-black/40 overflow-hidden">
            <canvas
                ref={canvasRef}
                className="block w-full h-full touch-none cursor-crosshair"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onWheel={handleWheel}
                onContextMenu={handleContextMenu}
            />
            {!enabled && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <span className="text-[10px] uppercase tracking-widest text-white/30">EQ Bypassed</span>
                </div>
            )}
        </div>
    );
}

// ─── Main widget ─────────────────────────────────────────────────────────────

type EqMode = "simple" | "advanced";

interface Props {
    className?: string;
}

export function LiveEqWidget({ className }: Props) {
    const live = useLive();
    const settings = useLiveSettings();
    const accent = ACCENT_COLORS[settings.accent] ?? ACCENT_COLORS.rose;
    const slot = useLiveWidgetSlot();

    // Find ALL EQ inserts in the chain (eq3 + parametricEq).
    // Multiple parametricEq inserts together form one logical N-band EQ.
    const eqInserts = useMemo(() => {
        return live.voiceChain.filter(i => i.type === "eq3" || i.type === "parametricEq");
    }, [live.voiceChain]);
    const hasEq = eqInserts.length > 0;
    const firstEq = hasEq ? eqInserts[0] : null;

    // Determine mode: tracks the first EQ insert when present, otherwise
    // remembers the user's last choice.
    const [modePref, setModePref] = useState<EqMode>(() => {
        try {
            const raw = localStorage.getItem("live-eq-mode");
            if (raw === "simple" || raw === "advanced") return raw;
        } catch { /* ignore */ }
        return "simple";
    });
    const mode: EqMode = firstEq
        ? (firstEq.type === "eq3" ? "simple" : "advanced")
        : modePref;

    useEffect(() => {
        try { localStorage.setItem("live-eq-mode", modePref); } catch { /* ignore */ }
    }, [modePref]);

    // Enabled if every EQ insert is enabled (or no EQ at all but user has
    // not yet configured — treat as off).
    const enabled = hasEq && eqInserts.every(i => i.enabled);
    const bands = bandsFromInserts(eqInserts, mode);
    const [selectedBand, setSelectedBand] = useState(0);

    const sampleRate = live.engine?.ctx.sampleRate ?? 48000;
    const analyser = live.engine?.masterAnalyser ?? null;

    // ── Helpers to write back to the chain
    const writeBands = useCallback((nextBands: Band[], opts?: { switchTo?: EqMode }) => {
        const currentMode: EqMode = opts?.switchTo ?? mode;
        const otherInserts = live.voiceChain.filter(
            i => i.type !== "eq3" && i.type !== "parametricEq",
        );
        const wasEnabled = hasEq ? enabled : true;

        if (currentMode === "simple") {
            const params = {
                low: nextBands[0]?.gain ?? 0,
                mid: nextBands[1]?.gain ?? 0,
                high: nextBands[2]?.gain ?? 0,
            };
            const eqInsert: FxInsert = {
                id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                type: "eq3",
                enabled: wasEnabled,
                params,
            };
            live.voiceLoadPreset([eqInsert, ...otherInserts]);
        } else {
            // Pack bands into ceil(N/3) parametricEq inserts (3 peaking bands each).
            const count = Math.max(MIN_BANDS, Math.min(MAX_BANDS, nextBands.length));
            const padded: Band[] = nextBands.slice(0, count);
            while (padded.length < count) {
                // Should not occur (we cap inputs) but defensive.
                padded.push({
                    type: "peaking", freq: 1000, gain: 0, q: 1,
                    label: `B${padded.length + 1}`,
                    color: BAND_PALETTE[padded.length % BAND_PALETTE.length],
                });
            }
            const groups = Math.ceil(count / 3);
            const newInserts: FxInsert[] = [];
            for (let g = 0; g < groups; g++) {
                const a = padded[g * 3 + 0];
                const b = padded[g * 3 + 1];
                const c = padded[g * 3 + 2];
                // For incomplete final groups, fill missing slots with neutral
                // peaking bands (gain=0, freq spaced) so the biquad chain is valid.
                const safeA = a ?? { freq: 200, gain: 0, q: 1 };
                const safeB = b ?? { freq: 1000, gain: 0, q: 1 };
                const safeC = c ?? { freq: 5000, gain: 0, q: 1 };
                newInserts.push({
                    id: `${Date.now()}_${g}_${Math.random().toString(36).slice(2, 8)}`,
                    type: "parametricEq",
                    enabled: wasEnabled,
                    params: {
                        freq1: safeA.freq, gain1: safeA.gain, q1: safeA.q,
                        freq2: safeB.freq, gain2: safeB.gain, q2: safeB.q,
                        freq3: safeC.freq, gain3: safeC.gain, q3: safeC.q,
                    },
                });
            }
            live.voiceLoadPreset([...newInserts, ...otherInserts]);
        }
    }, [mode, live, hasEq, enabled]);

    const handleBandChange = useCallback((idx: number, patch: Partial<Pick<Band, "freq" | "gain" | "q">>) => {
        const next = bands.map((b, i) => i === idx ? { ...b, ...patch } : b);
        writeBands(next);
    }, [bands, writeBands]);

    const handleAddBand = useCallback((freq: number, gain: number) => {
        if (mode === "simple") return; // 3 fixed bands in simple mode
        if (bands.length >= MAX_BANDS) return;
        const next: Band[] = [...bands, {
            type: "peaking",
            freq,
            gain,
            q: 1,
            label: `B${bands.length + 1}`,
            color: BAND_PALETTE[bands.length % BAND_PALETTE.length],
        }];
        writeBands(next);
        setSelectedBand(next.length - 1);
    }, [mode, bands, writeBands]);

    const handleRemoveBand = useCallback((idx: number) => {
        if (mode === "simple") return; // Can't remove in simple mode
        if (bands.length <= MIN_BANDS) return;
        const next = bands.filter((_, i) => i !== idx);
        writeBands(next);
        setSelectedBand(b => Math.max(0, Math.min(b, next.length - 1)));
    }, [mode, bands, writeBands]);

    const handleEnableToggle = useCallback(() => {
        if (hasEq) {
            // Toggle every EQ insert in lockstep.
            for (const insert of eqInserts) {
                live.voiceToggleEffect(insert.id);
            }
        } else {
            // Insert a default EQ of the current mode.
            writeBands(mode === "simple" ? defaultSimpleBands() : defaultAdvancedBands(), { switchTo: mode });
        }
    }, [hasEq, eqInserts, live, writeBands, mode]);

    const handleModeSwitch = useCallback((next: EqMode) => {
        setModePref(next);
        if (hasEq) {
            // Convert: keep gains, lose freq/q nuance going simple→advanced or vice-versa.
            // When switching to simple, only first 3 bands' gains survive (mapped to low/mid/high).
            writeBands(bands.slice(0, next === "simple" ? 3 : MAX_BANDS), { switchTo: next });
        }
    }, [hasEq, bands, writeBands]);

    const handleReset = useCallback(() => {
        const flat = mode === "simple" ? defaultSimpleBands() : defaultAdvancedBands();
        writeBands(flat);
    }, [writeBands, mode]);

    const handleRemove = useCallback(() => {
        if (!hasEq) return;
        for (const insert of eqInserts) {
            live.voiceRemoveEffect(insert.id);
        }
    }, [hasEq, eqInserts, live]);

    // ── Render
    return (
        <div className={cn("flex flex-col h-full rounded-2xl border border-white/[0.04] bg-white/[0.015] backdrop-blur overflow-hidden", className)}>
            {/* Header */}
            <div
                className={cn(
                    "flex items-center gap-2 px-3 py-2 border-b border-white/[0.04] shrink-0",
                    slot?.dragHandleClass,
                    slot?.dragHandleClass && "cursor-grab active:cursor-grabbing select-none hover:bg-white/[0.03] transition-colors",
                )}
                style={slot?.dragHandleClass ? { touchAction: "none" } : undefined}
            >
                <div className={cn("w-6 h-6 rounded-lg flex items-center justify-center transition-all pointer-events-none",
                    enabled ? "shadow-[0_0_8px_rgba(244,63,94,0.25)]" : "")}
                    style={{ background: enabled ? accent + "33" : "rgba(255,255,255,0.04)", color: enabled ? accent : "rgba(255,255,255,0.3)" }}>
                    <Sliders className="w-3 h-3" />
                </div>
                <span className="text-[11px] font-bold uppercase tracking-wider pointer-events-none"
                    style={{ color: enabled ? accent : "rgba(255,255,255,0.5)" }}>
                    Equalizer
                </span>

                <div className="ml-auto flex items-center gap-1" data-no-drag>
                    {/* Mode switcher */}
                    <div className="flex bg-black/40 rounded-lg p-0.5 border border-white/[0.06]">
                        <button onClick={() => handleModeSwitch("simple")}
                            className={cn("px-2 py-0.5 rounded-md text-[9px] uppercase tracking-wider transition-all cursor-pointer",
                                mode === "simple" ? "text-white/90 bg-white/10" : "text-white/40 hover:text-white/70")}>
                            Simple
                        </button>
                        <button onClick={() => handleModeSwitch("advanced")}
                            className={cn("px-2 py-0.5 rounded-md text-[9px] uppercase tracking-wider transition-all cursor-pointer",
                                mode === "advanced" ? "text-white/90 bg-white/10" : "text-white/40 hover:text-white/70")}>
                            Advanced
                        </button>
                    </div>

                    <button onClick={handleReset} title="Reset to flat"
                        className="w-6 h-6 rounded flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/5 cursor-pointer">
                        <RotateCcw className="w-3 h-3" />
                    </button>

                    <button onClick={handleEnableToggle}
                        title={enabled ? "Bypass EQ" : "Enable EQ"}
                        className={cn("px-2 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1 border",
                            enabled
                                ? "border-rose-500/30 text-rose-400 bg-rose-500/10 shadow-[0_0_8px_rgba(244,63,94,0.15)]"
                                : "border-white/[0.06] text-white/40 bg-white/[0.04] hover:bg-white/[0.08]")}
                        style={enabled ? { borderColor: accent + "55", color: accent, background: accent + "1a" } : undefined}>
                        <Power className="w-2.5 h-2.5" />
                        {enabled ? "On" : "Off"}
                    </button>
                    {slot?.onToggleCollapse && (
                        <button
                            onClick={slot.onToggleCollapse}
                            title={slot.collapsed ? "Expand" : "Collapse"}
                            className="w-6 h-6 flex items-center justify-center rounded text-white/30 hover:text-white/70 hover:bg-white/[0.06] transition-colors cursor-pointer"
                        >
                            {slot.collapsed
                                ? <ChevronRight className="w-3.5 h-3.5" />
                                : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>
                    )}
                </div>
            </div>

            {!slot?.collapsed && (
            <>
            {/* Canvas */}
            <div className="flex-1 min-h-[120px] p-2">
                <EqCanvas
                    bands={bands}
                    enabled={enabled}
                    accent={accent}
                    analyser={analyser}
                    sampleRate={sampleRate}
                    onBandChange={handleBandChange}
                    selectedBand={selectedBand}
                    onSelectBand={setSelectedBand}
                    onAddBand={mode === "advanced" ? handleAddBand : null}
                    onRemoveBand={mode === "advanced" ? handleRemoveBand : null}
                />
            </div>

            {/* Knobs row */}
            <div className="px-3 pb-3">
                {mode === "simple" ? (
                    <SimpleKnobs bands={bands} onChange={handleBandChange} accent={accent} disabled={!enabled} />
                ) : (
                    <AdvancedKnobs
                        bands={bands}
                        onChange={handleBandChange}
                        selectedBand={selectedBand}
                        onSelectBand={setSelectedBand}
                        accent={accent}
                        disabled={!enabled}
                    />
                )}
                <div className="mt-1 flex items-center gap-2 text-[8.5px] text-white/25">
                    <ChevronRight className="w-2.5 h-2.5" />
                    <span>
                        {mode === "advanced"
                            ? `Drag points • Shift+drag = Q • Wheel = Q • Right-click empty = add band (max ${MAX_BANDS}) • Right-click band = remove (min ${MIN_BANDS})`
                            : "Drag points on the curve. Shift+drag adjusts Q. Wheel over a point also tweaks Q."}
                    </span>
                    {hasEq && (
                        <button onClick={handleRemove} className="ml-auto text-white/30 hover:text-red-400/70 cursor-pointer text-[9px]">
                            Remove from chain
                        </button>
                    )}
                </div>
            </div>
            </>
            )}
        </div>
    );
}

// ─── Knob rows ───────────────────────────────────────────────────────────────

function SimpleKnobs({ bands, onChange, accent, disabled }: {
    bands: Band[]; onChange: (idx: number, patch: Partial<Band>) => void; accent: string; disabled: boolean;
}) {
    return (
        <div className={cn("grid grid-cols-3 gap-3 transition-opacity", disabled ? "opacity-50" : "")}>
            {bands.map((b, i) => (
                <div key={i} className="flex flex-col items-center gap-1 rounded-xl border border-white/[0.04] bg-black/20 p-2">
                    <span className="text-[9px] uppercase tracking-widest" style={{ color: b.color }}>{b.label}</span>
                    <MiniKnob
                        value={b.gain} min={-DB_RANGE} max={DB_RANGE} color={b.color} label="Gain"
                        format={v => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`}
                        onChange={v => onChange(i, { gain: v })}
                        onReset={() => onChange(i, { gain: 0 })}
                    />
                    <span className="text-[8px] text-white/25 tabular-nums">
                        {b.freq >= 1000 ? `${(b.freq / 1000).toFixed(1)}k` : `${Math.round(b.freq)}`} Hz
                    </span>
                </div>
            ))}
            <span className="hidden">{accent}</span>
        </div>
    );
}

function AdvancedKnobs({ bands, onChange, selectedBand, onSelectBand, accent, disabled }: {
    bands: Band[]; onChange: (idx: number, patch: Partial<Band>) => void;
    selectedBand: number; onSelectBand: (i: number) => void;
    accent: string; disabled: boolean;
}) {
    return (
        <div className={cn("space-y-1.5 transition-opacity", disabled ? "opacity-50" : "")}>
            {/* Band selector */}
            <div className="flex flex-wrap gap-1">
                {bands.map((b, i) => (
                    <button key={i} onClick={() => onSelectBand(i)}
                        className={cn("flex-1 min-w-[36px] px-2 py-1 rounded-lg text-[9px] uppercase tracking-wider transition-all cursor-pointer border",
                            selectedBand === i ? "bg-white/10 text-white/90" : "bg-black/20 text-white/40 hover:bg-white/[0.04] border-white/[0.04]")}
                        style={selectedBand === i ? { borderColor: b.color + "66", color: b.color } : undefined}>
                        {b.label}
                    </button>
                ))}
            </div>
            {/* Knobs for the selected band */}
            <div className="rounded-xl border border-white/[0.06] bg-black/30 p-2">
                {(() => {
                    const b = bands[selectedBand];
                    if (!b) return null;
                    return (
                        <div className="flex items-center justify-around gap-2">
                            <MiniKnob value={b.freq} min={F_MIN} max={F_MAX} color={b.color} label="Freq"
                                format={v => v >= 1000 ? `${(v / 1000).toFixed(2)}k` : `${Math.round(v)}`}
                                onChange={v => onChange(selectedBand, { freq: v })} />
                            <MiniKnob value={b.gain} min={-DB_RANGE} max={DB_RANGE} color={b.color} label="Gain"
                                format={v => `${v > 0 ? "+" : ""}${v.toFixed(1)}`}
                                onChange={v => onChange(selectedBand, { gain: v })}
                                onReset={() => onChange(selectedBand, { gain: 0 })} />
                            <MiniKnob value={b.q} min={0.1} max={20} color={b.color} label="Q"
                                format={v => v.toFixed(2)}
                                onChange={v => onChange(selectedBand, { q: v })}
                                onReset={() => onChange(selectedBand, { q: 1 })} />
                        </div>
                    );
                })()}
            </div>
            <span className="hidden">{accent}</span>
        </div>
    );
}
