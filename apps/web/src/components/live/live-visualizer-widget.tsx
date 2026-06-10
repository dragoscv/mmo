"use client";

/**
 * LiveVisualizerWidget — multi-mode audio visualization for the master bus.
 *
 * Twelve view modes you can switch between or stack 2x / 4x:
 *   bars        — classic FFT spectrum bars (with peak hold)
 *   mirror      — bars mirrored top + bottom
 *   wave        — oscilloscope (time-domain)
 *   waveFilled  — filled waveform with gradient
 *   stereoWave  — split L/R waveform
 *   radial      — radial spectrum (circular bars)
 *   ring        — pulsing ring (energy by band)
 *   blob        — fluid blob distorted by bass/mids/treble
 *   particles   — audio-reactive particle field
 *   vu          — analog dual VU meters
 *   peakRms     — vertical peak + RMS bars
 *   lissajous   — stereo phase scope (host only — needs raw L/R)
 *
 * Two render modes:
 *   - Host (Live page): pulls data from the engine's hi-res AnalyserNode at 60fps.
 *   - Remote: reads compact `spectrum` / `waveform` byte arrays from the
 *     broadcast snapshot. Same renderers, different data source.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
    BarChart3, AudioLines, Activity, Radar, CircleDot, Waves, Sparkles,
    Gauge, ArrowUpDown, Layers, Grid2x2, Square as SquareIcon, ChevronDown, ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useRenderCount } from "@/lib/dev-debugger";
import { useLiveOptional } from "@/components/live/live-context";
import { useLiveSettings } from "@/hooks/use-live-settings";
import { useLiveWidgetSlot } from "@/components/live/live-widget-slot";
import { subscribeRaf, getSharedFrequencyData } from "@/lib/raf-scheduler";

// ─── Public types ────────────────────────────────────────────────────────

export type VizMode =
    | "bars" | "mirror" | "wave" | "waveFilled" | "stereoWave"
    | "radial" | "ring" | "blob" | "particles" | "vu" | "peakRms" | "lissajous";

export type VizLayout = "single" | "split2" | "grid4";

interface VizMeta { id: VizMode; label: string; icon: typeof BarChart3; remoteOk: boolean; }

const VIZ_MODES: VizMeta[] = [
    { id: "bars", label: "Spectrum", icon: BarChart3, remoteOk: true },
    { id: "mirror", label: "Mirror", icon: ArrowUpDown, remoteOk: true },
    { id: "wave", label: "Oscilloscope", icon: AudioLines, remoteOk: true },
    { id: "waveFilled", label: "Wave Filled", icon: Waves, remoteOk: true },
    { id: "stereoWave", label: "Stereo Wave", icon: Activity, remoteOk: true },
    { id: "radial", label: "Radial", icon: Radar, remoteOk: true },
    { id: "ring", label: "Ring", icon: CircleDot, remoteOk: true },
    { id: "blob", label: "Blob", icon: Sparkles, remoteOk: true },
    { id: "particles", label: "Particles", icon: Sparkles, remoteOk: true },
    { id: "vu", label: "VU", icon: Gauge, remoteOk: true },
    { id: "peakRms", label: "Peak/RMS", icon: BarChart3, remoteOk: true },
    { id: "lissajous", label: "Lissajous", icon: Activity, remoteOk: false },
];

const STORAGE_KEY = "live-visualizer-config-v1";

interface VizConfig {
    layout: VizLayout;
    modes: VizMode[]; // length 1, 2, or 4 depending on layout
    /** Number of spectrum bars/segments for bar/mirror/radial/blob renderers. */
    barCount: number;
}

const BAR_COUNT_MIN = 16;
const BAR_COUNT_MAX = 128;
const BAR_COUNT_DEFAULT = 64;

const DEFAULT_CONFIG: VizConfig = {
    layout: "single",
    modes: ["bars", "wave", "radial", "blob"],
    barCount: BAR_COUNT_DEFAULT,
};

function loadConfig(): VizConfig {
    if (typeof window === "undefined") return DEFAULT_CONFIG;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const p = JSON.parse(raw) as Partial<VizConfig>;
            const bc = typeof p.barCount === "number" && Number.isFinite(p.barCount)
                ? Math.max(BAR_COUNT_MIN, Math.min(BAR_COUNT_MAX, Math.round(p.barCount)))
                : DEFAULT_CONFIG.barCount;
            return {
                layout: p.layout ?? DEFAULT_CONFIG.layout,
                modes: Array.isArray(p.modes) && p.modes.length === 4 ? p.modes : DEFAULT_CONFIG.modes,
                barCount: bc,
            };
        }
    } catch { /* ignore */ }
    return DEFAULT_CONFIG;
}

function saveConfig(c: VizConfig) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(c)); } catch { /* ignore */ }
}

// ─── Accent palette (mirrors Live settings) ──────────────────────────────

const ACCENT_HEX: Record<string, { primary: string; secondary: string; tertiary: string }> = {
    rose: { primary: "#f43f5e", secondary: "#a855f7", tertiary: "#06b6d4" },
    violet: { primary: "#a855f7", secondary: "#06b6d4", tertiary: "#f43f5e" },
    emerald: { primary: "#10b981", secondary: "#06b6d4", tertiary: "#a855f7" },
    cyan: { primary: "#06b6d4", secondary: "#10b981", tertiary: "#f43f5e" },
    amber: { primary: "#f59e0b", secondary: "#f43f5e", tertiary: "#a855f7" },
};

// ─── Public props ────────────────────────────────────────────────────────

interface Props {
    /** When provided, the widget renders from broadcast data instead of an
     *  AnalyserNode (used on the remote view). Both arrays are 32 bytes. */
    remoteSnapshot?: { spectrum?: number[]; waveform?: number[]; peakL: number; peakR: number; isLimiting: boolean };
    className?: string;
}

// ─── Component ───────────────────────────────────────────────────────────

export function LiveVisualizerWidget({ remoteSnapshot, className }: Props) {
    useRenderCount("LiveVisualizerWidget");
    const live = useLiveOptional();
    const settings = useLiveSettings();
    const accent = ACCENT_HEX[settings.accent] ?? ACCENT_HEX.rose;
    const slot = useLiveWidgetSlot();

    const [config, setConfig] = useState<VizConfig>(loadConfig);
    const [pickerSlot, setPickerSlot] = useState<number | null>(null);

    // Persist on every change. The lazy initializer above already returns
    // DEFAULT_CONFIG on the SSR pass, so the first client effect run will
    // either re-save the same defaults (no-op write) or save the just-loaded
    // user config (idempotent). Cheap, no hydration flag needed.
    useEffect(() => { saveConfig(config); }, [config]);

    const slotsCount = config.layout === "single" ? 1 : config.layout === "split2" ? 2 : 4;
    const visibleModes = config.modes.slice(0, slotsCount);

    const setLayout = useCallback((layout: VizLayout) => {
        setConfig(c => ({ ...c, layout }));
    }, []);
    const setBarCount = useCallback((n: number) => {
        const clamped = Math.max(BAR_COUNT_MIN, Math.min(BAR_COUNT_MAX, Math.round(n)));
        setConfig(c => (c.barCount === clamped ? c : { ...c, barCount: clamped }));
    }, []);
    const setSlotMode = useCallback((slot: number, mode: VizMode) => {
        setConfig(c => {
            const next = [...c.modes];
            next[slot] = mode;
            return { ...c, modes: next };
        });
        setPickerSlot(null);
    }, []);

    const isRemote = remoteSnapshot !== undefined;

    return (
        <div className={cn(
            "rounded-xl border border-white/[0.06] bg-gradient-to-br from-black/40 via-black/20 to-black/40 backdrop-blur-sm overflow-hidden flex flex-col h-full",
            className,
        )}>
            {/* Header with mode pills + layout switcher */}
            <div
                className={cn(
                    "flex items-center gap-2 px-2.5 py-1.5 border-b border-white/[0.06] bg-black/30 shrink-0",
                    slot?.dragHandleClass,
                    slot?.dragHandleClass && "cursor-grab active:cursor-grabbing select-none",
                )}
                style={slot?.dragHandleClass ? { touchAction: "none" } : undefined}
            >
                <div className="flex items-center gap-1.5 min-w-0 pointer-events-none">
                    <Layers className="w-3 h-3 text-white/40 shrink-0" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-white/60">Visualizer</span>
                </div>

                <div className="ml-auto flex items-center gap-1" data-no-drag>
                    <div
                        className="hidden md:flex items-center gap-1.5 px-1.5 py-0.5 rounded-md bg-white/[0.03] border border-white/[0.06] mr-1"
                        title={`Spectrum bars: ${config.barCount}`}
                    >
                        <BarChart3 className="w-3 h-3 text-white/40" />
                        <input
                            type="range"
                            min={BAR_COUNT_MIN}
                            max={BAR_COUNT_MAX}
                            step={4}
                            value={config.barCount}
                            onChange={e => setBarCount(parseInt(e.target.value, 10))}
                            className="w-16 accent-white/70 cursor-pointer"
                            aria-label="Spectrum bar count"
                        />
                        <span className="text-[9px] text-white/50 tabular-nums w-5 text-right">{config.barCount}</span>
                    </div>
                    <LayoutButton active={config.layout === "single"} onClick={() => setLayout("single")} title="Single view">
                        <SquareIcon className="w-3 h-3" />
                    </LayoutButton>
                    <LayoutButton active={config.layout === "split2"} onClick={() => setLayout("split2")} title="2 views">
                        <div className="flex gap-0.5"><div className="w-1 h-3 bg-current rounded-sm" /><div className="w-1 h-3 bg-current rounded-sm" /></div>
                    </LayoutButton>
                    <LayoutButton active={config.layout === "grid4"} onClick={() => setLayout("grid4")} title="2x2 grid">
                        <Grid2x2 className="w-3 h-3" />
                    </LayoutButton>
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

            {/* Canvas grid */}
            {!slot?.collapsed && (
                <div className={cn(
                    "flex-1 grid gap-1 p-1 min-h-0",
                    config.layout === "single" && "grid-cols-1 grid-rows-1",
                    config.layout === "split2" && "grid-cols-2 grid-rows-1",
                    config.layout === "grid4" && "grid-cols-2 grid-rows-2",
                )}>
                    {visibleModes.map((mode, i) => (
                        <VizSlot
                            key={i}
                            mode={mode}
                            accent={accent}
                            barCount={config.barCount}
                            isRemote={isRemote}
                            remoteSnapshot={remoteSnapshot}
                            engine={live?.engine ?? null}
                            onPickerOpen={() => setPickerSlot(i)}
                            showPicker={pickerSlot === i}
                            onModeChange={(m) => setSlotMode(i, m)}
                            onPickerClose={() => setPickerSlot(null)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function LayoutButton({ active, onClick, title, children }: {
    active: boolean; onClick: () => void; title: string; children: React.ReactNode;
}) {
    return (
        <button onClick={onClick} title={title}
            className={cn(
                "h-6 w-6 rounded flex items-center justify-center transition-colors cursor-pointer",
                active ? "bg-white/15 text-white/85" : "text-white/30 hover:text-white/60 hover:bg-white/5",
            )}>
            {children}
        </button>
    );
}

// ─── Single canvas slot ──────────────────────────────────────────────────

interface SlotProps {
    mode: VizMode;
    accent: { primary: string; secondary: string; tertiary: string };
    barCount: number;
    isRemote: boolean;
    remoteSnapshot?: Props["remoteSnapshot"];
    engine: NonNullable<ReturnType<typeof useLiveOptional>>["engine"] | null;
    onPickerOpen: () => void;
    showPicker: boolean;
    onModeChange: (m: VizMode) => void;
    onPickerClose: () => void;
}

function VizSlot({ mode, accent, barCount, isRemote, remoteSnapshot, engine, onPickerOpen, showPicker, onModeChange, onPickerClose }: SlotProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const stateRef = useRef<VizRenderState>({ particles: [], spectroIdx: 0, peakHold: new Float32Array(64), peakHoldDecay: 0 });

    // Stable refs for the inner rAF closure, so swapping mode/accent doesn't
    // tear down and re-create the loop. Mirrored *after* commit.
    const modeRef = useRef(mode);
    const accentRef = useRef(accent);
    const barCountRef = useRef(barCount);
    const remoteRef = useRef(remoteSnapshot);
    const engineRef = useRef(engine);
    const isRemoteRef = useRef(isRemote);
    useEffect(() => {
        modeRef.current = mode;
        accentRef.current = accent;
        barCountRef.current = barCount;
        remoteRef.current = remoteSnapshot;
        engineRef.current = engine;
        isRemoteRef.current = isRemote;
    });

    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // ResizeObserver to keep canvas sized to its container at DPR.
        const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        const ro = new ResizeObserver(entries => {
            for (const e of entries) {
                const { width, height } = e.contentRect;
                canvas.width = Math.max(1, Math.floor(width * dpr));
                canvas.height = Math.max(1, Math.floor(height * dpr));
                canvas.style.width = `${width}px`;
                canvas.style.height = `${height}px`;
            }
        });
        ro.observe(container);

        // Reusable scratch buffers for host mode.
        let freqBuf: Uint8Array<ArrayBuffer> | null = null;
        let timeBuf: Uint8Array<ArrayBuffer> | null = null;
        let timeBufL: Uint8Array<ArrayBuffer> | null = null;
        let timeBufR: Uint8Array<ArrayBuffer> | null = null;

        let running = true;

        const tick = () => {
            if (!running) return;

            const w = canvas.width;
            const h = canvas.height;
            if (w === 0 || h === 0) return;

            // Pull data ────────────────────────────────────────────
            let spectrum: Uint8Array | number[] = [];
            let waveform: Uint8Array | number[] = [];
            let waveformL: Uint8Array | number[] = [];
            let waveformR: Uint8Array | number[] = [];
            let peakL = 0, peakR = 0, isLimiting = false;

            if (isRemoteRef.current) {
                const snap = remoteRef.current;
                spectrum = snap?.spectrum ?? [];
                waveform = snap?.waveform ?? [];
                peakL = snap?.peakL ?? 0;
                peakR = snap?.peakR ?? 0;
                isLimiting = snap?.isLimiting ?? false;
            } else {
                const eng = engineRef.current;
                if (eng) {
                    const ana = eng.masterAnalyser;
                    // Shared analyser cache: if any other visualiser already
                    // pulled this analyser this frame, we re-use the buffer.
                    spectrum = getSharedFrequencyData(ana);
                    if (!timeBuf || timeBuf.length !== ana.fftSize) timeBuf = new Uint8Array(new ArrayBuffer(ana.fftSize));
                    ana.getByteTimeDomainData(timeBuf);
                    waveform = timeBuf;
                    void freqBuf;
                    // Stereo for stereoWave / lissajous
                    const lr = eng.masterAnalyserNodes;
                    if (modeRef.current === "stereoWave" || modeRef.current === "lissajous") {
                        if (!timeBufL || timeBufL.length !== lr.L.fftSize) timeBufL = new Uint8Array(new ArrayBuffer(lr.L.fftSize));
                        if (!timeBufR || timeBufR.length !== lr.R.fftSize) timeBufR = new Uint8Array(new ArrayBuffer(lr.R.fftSize));
                        lr.L.getByteTimeDomainData(timeBufL);
                        lr.R.getByteTimeDomainData(timeBufR);
                        waveformL = timeBufL;
                        waveformR = timeBufR;
                    }
                    peakL = eng.state.masterPeakL;
                    peakR = eng.state.masterPeakR;
                    isLimiting = eng.state.isLimiting;
                }
            }

            // Clear
            ctx.clearRect(0, 0, w, h);

            // Render selected view
            const args: RenderArgs = {
                ctx, w, h,
                spectrum, waveform, waveformL, waveformR,
                peakL, peakR, isLimiting,
                accent: accentRef.current,
                barCount: barCountRef.current,
                state: stateRef.current,
            };
            switch (modeRef.current) {
                case "bars": drawBars(args); break;
                case "mirror": drawMirror(args); break;
                case "wave": drawWave(args); break;
                case "waveFilled": drawWaveFilled(args); break;
                case "stereoWave": drawStereoWave(args); break;
                case "radial": drawRadial(args); break;
                case "ring": drawRing(args); break;
                case "blob": drawBlob(args); break;
                case "particles": drawParticles(args); break;
                case "vu": drawVU(args); break;
                case "peakRms": drawPeakRms(args); break;
                case "lissajous": drawLissajous(args); break;
            }
        };

        // Subscribe via the shared scheduler so we share frame budget with
        // every other visualiser. 60 fps for fluid motion; falls to 0 cost
        // when the tab is hidden (we unsubscribe on visibilitychange).
        let unsub: (() => void) | null = subscribeRaf(tick, { fps: 60 });

        const onVisibility = () => {
            if (document.hidden) {
                running = false;
                if (unsub) { unsub(); unsub = null; }
            } else if (!running) {
                running = true;
                if (!unsub) unsub = subscribeRaf(tick, { fps: 60 });
            }
        };
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            running = false;
            document.removeEventListener("visibilitychange", onVisibility);
            if (unsub) unsub();
            ro.disconnect();
        };
    }, []);

    const meta = VIZ_MODES.find(m => m.id === mode) ?? VIZ_MODES[0];
    const Icon = meta.icon;

    return (
        <div ref={containerRef} className="relative rounded-lg bg-black/40 overflow-hidden border border-white/[0.04] min-h-[80px]">
            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />

            {/* Slot mode picker */}
            <button onClick={onPickerOpen}
                className="absolute top-1 left-1 z-10 flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-black/50 backdrop-blur text-white/70 hover:text-white border border-white/[0.06] cursor-pointer transition-colors">
                <Icon className="w-2.5 h-2.5" />
                <span className="uppercase tracking-wider">{meta.label}</span>
                <ChevronDown className="w-2.5 h-2.5 opacity-60" />
            </button>

            {showPicker && (
                <>
                    <div className="absolute inset-0 z-20 bg-black/60 backdrop-blur-sm" onClick={onPickerClose} />
                    <div className="absolute inset-x-1 top-7 z-30 max-h-[calc(100%-2rem)] overflow-y-auto rounded-md bg-[oklch(0.13_0.01_260)] border border-white/15 shadow-2xl p-1 grid grid-cols-2 gap-0.5">
                        {VIZ_MODES.map(m => {
                            const disabled = isRemote && !m.remoteOk;
                            const M = m.icon;
                            return (
                                <button key={m.id}
                                    disabled={disabled}
                                    onClick={() => onModeChange(m.id)}
                                    title={disabled ? `${m.label} (host only)` : m.label}
                                    className={cn(
                                        "flex items-center gap-1.5 px-2 py-1.5 rounded text-[10px] transition-colors text-left",
                                        m.id === mode && "bg-white/15 text-white",
                                        m.id !== mode && !disabled && "text-white/65 hover:bg-white/10 hover:text-white cursor-pointer",
                                        disabled && "opacity-30 text-white/40 cursor-not-allowed",
                                    )}>
                                    <M className="w-3 h-3 shrink-0" />
                                    <span className="truncate">{m.label}</span>
                                </button>
                            );
                        })}
                    </div>
                </>
            )}

            {/* Limiter indicator */}
            {/* (intentionally subtle — visible top-right) */}
            <div className={cn(
                "absolute top-1 right-1 z-10 px-1.5 py-0.5 rounded text-[8px] uppercase tracking-wider font-bold transition-opacity pointer-events-none",
                isRemote && remoteSnapshot?.isLimiting ? "bg-red-500/30 text-red-200 opacity-100" : "opacity-0",
            )}>LIM</div>
        </div>
    );
}

// ─── Render state ────────────────────────────────────────────────────────

interface Particle { x: number; y: number; vx: number; vy: number; life: number; hue: number; }
interface VizRenderState {
    particles: Particle[];
    spectroIdx: number;
    peakHold: Float32Array;
    peakHoldDecay: number;
}

interface RenderArgs {
    ctx: CanvasRenderingContext2D;
    w: number; h: number;
    spectrum: Uint8Array | number[];
    waveform: Uint8Array | number[];
    waveformL: Uint8Array | number[];
    waveformR: Uint8Array | number[];
    peakL: number; peakR: number; isLimiting: boolean;
    accent: { primary: string; secondary: string; tertiary: string };
    /** User-configured spectrum bar/segment count (16..128). */
    barCount: number;
    state: VizRenderState;
}

// Helpers ----------------------------------------------------------------

function rgb(hex: string, alpha = 1) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function bandEnergy(spectrum: Uint8Array | number[], from: number, to: number): number {
    const len = spectrum.length;
    const lo = Math.max(0, Math.floor(from * len));
    const hi = Math.min(len, Math.ceil(to * len));
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += spectrum[i];
    return hi > lo ? sum / (hi - lo) / 255 : 0;
}

// ─── Renderers ───────────────────────────────────────────────────────────

function drawBars({ ctx, w, h, spectrum, accent, barCount, state }: RenderArgs) {
    const N = Math.min(barCount, spectrum.length);
    const bw = w / N;
    if (state.peakHold.length !== N) state.peakHold = new Float32Array(N);
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, rgb(accent.primary, 1));
    grad.addColorStop(0.5, rgb(accent.secondary, 0.9));
    grad.addColorStop(1, rgb(accent.tertiary, 0.7));
    for (let i = 0; i < N; i++) {
        const v = (spectrum[Math.floor(i * spectrum.length / N)] || 0) / 255;
        const bh = v * h;
        ctx.fillStyle = grad;
        ctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
        // Peak hold
        const ph = state.peakHold[i] = Math.max(state.peakHold[i] * 0.96, v);
        ctx.fillStyle = rgb("#ffffff", 0.85);
        ctx.fillRect(i * bw + 1, h - ph * h - 2, bw - 2, 2);
    }
}

function drawMirror({ ctx, w, h, spectrum, accent, barCount }: RenderArgs) {
    const N = Math.min(barCount, spectrum.length);
    const bw = w / N;
    const cy = h / 2;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, rgb(accent.primary, 0.3));
    grad.addColorStop(0.5, rgb(accent.primary, 1));
    grad.addColorStop(1, rgb(accent.tertiary, 0.3));
    for (let i = 0; i < N; i++) {
        const v = (spectrum[Math.floor(i * spectrum.length / N)] || 0) / 255;
        const bh = v * cy;
        ctx.fillStyle = grad;
        ctx.fillRect(i * bw + 1, cy - bh, bw - 2, bh);
        ctx.fillRect(i * bw + 1, cy, bw - 2, bh);
    }
    ctx.strokeStyle = rgb("#ffffff", 0.1);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();
}

function drawWave({ ctx, w, h, waveform, accent }: RenderArgs) {
    const N = waveform.length;
    if (N === 0) return;
    ctx.strokeStyle = accent.primary;
    ctx.lineWidth = 2;
    ctx.shadowBlur = 8;
    ctx.shadowColor = accent.primary;
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
        const v = (waveform[i] - 128) / 128;
        const x = (i / (N - 1)) * w;
        const y = h / 2 + v * (h / 2 - 4);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
}

function drawWaveFilled({ ctx, w, h, waveform, accent }: RenderArgs) {
    const N = waveform.length;
    if (N === 0) return;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, rgb(accent.primary, 0.6));
    grad.addColorStop(0.5, rgb(accent.secondary, 0.4));
    grad.addColorStop(1, rgb(accent.primary, 0.6));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    for (let i = 0; i < N; i++) {
        const v = (waveform[i] - 128) / 128;
        const x = (i / (N - 1)) * w;
        const y = h / 2 + v * (h / 2 - 4);
        ctx.lineTo(x, y);
    }
    for (let i = N - 1; i >= 0; i--) {
        const v = (waveform[i] - 128) / 128;
        const x = (i / (N - 1)) * w;
        const y = h / 2 - v * (h / 2 - 4);
        ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
}

function drawStereoWave({ ctx, w, h, waveform, waveformL, waveformR, accent }: RenderArgs) {
    // Fall back to mono on remote / when stereo bufs aren't populated.
    const L = waveformL.length > 0 ? waveformL : waveform;
    const R = waveformR.length > 0 ? waveformR : waveform;
    const upH = h / 2;
    const drawCh = (buf: Uint8Array | number[], yOff: number, color: string) => {
        const N = buf.length;
        if (N === 0) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < N; i++) {
            const v = (buf[i] - 128) / 128;
            const x = (i / (N - 1)) * w;
            const y = yOff + upH / 2 + v * (upH / 2 - 4);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
    };
    drawCh(L, 0, accent.primary);
    drawCh(R, upH, accent.secondary);
    ctx.strokeStyle = rgb("#ffffff", 0.08);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, upH); ctx.lineTo(w, upH); ctx.stroke();
}

function drawRadial({ ctx, w, h, spectrum, accent, barCount }: RenderArgs) {
    const N = Math.min(barCount, spectrum.length);
    const cx = w / 2, cy = h / 2;
    const r0 = Math.min(w, h) * 0.18;
    const rMax = Math.min(w, h) * 0.45;
    for (let i = 0; i < N; i++) {
        const v = (spectrum[Math.floor(i * spectrum.length / N)] || 0) / 255;
        const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
        const r1 = r0 + v * (rMax - r0);
        const x0 = cx + Math.cos(angle) * r0;
        const y0 = cy + Math.sin(angle) * r0;
        const x1 = cx + Math.cos(angle) * r1;
        const y1 = cy + Math.sin(angle) * r1;
        const t = i / N;
        const color = t < 0.33 ? accent.primary : t < 0.66 ? accent.secondary : accent.tertiary;
        ctx.strokeStyle = rgb(color, 0.85);
        ctx.lineWidth = Math.max(1, (Math.PI * 2 * r0) / N - 1);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    // Inner ring glow
    const gl = ctx.createRadialGradient(cx, cy, 0, cx, cy, r0);
    gl.addColorStop(0, rgb(accent.primary, 0.18));
    gl.addColorStop(1, rgb(accent.primary, 0));
    ctx.fillStyle = gl;
    ctx.fillRect(0, 0, w, h);
}

function drawRing({ ctx, w, h, spectrum, accent }: RenderArgs) {
    const cx = w / 2, cy = h / 2;
    const bass = bandEnergy(spectrum, 0, 0.1);
    const mid = bandEnergy(spectrum, 0.1, 0.4);
    const treb = bandEnergy(spectrum, 0.4, 1);
    const minD = Math.min(w, h);
    const drawRingCircle = (radius: number, energy: number, color: string, lineW: number) => {
        ctx.strokeStyle = rgb(color, 0.4 + energy * 0.6);
        ctx.lineWidth = lineW + energy * 6;
        ctx.shadowBlur = energy * 24;
        ctx.shadowColor = color;
        ctx.beginPath(); ctx.arc(cx, cy, radius * (1 + energy * 0.15), 0, Math.PI * 2); ctx.stroke();
    };
    drawRingCircle(minD * 0.18, bass, accent.primary, 4);
    drawRingCircle(minD * 0.28, mid, accent.secondary, 2);
    drawRingCircle(minD * 0.38, treb, accent.tertiary, 1);
    ctx.shadowBlur = 0;
}

function drawBlob({ ctx, w, h, spectrum, accent, barCount }: RenderArgs) {
    const N = Math.max(16, Math.min(barCount, spectrum.length));
    const cx = w / 2, cy = h / 2;
    const baseR = Math.min(w, h) * 0.25;
    const bass = bandEnergy(spectrum, 0, 0.1);
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
        const angle = (i / N) * Math.PI * 2;
        const v = (spectrum[Math.floor((i % N) * spectrum.length / N)] || 0) / 255;
        const r = baseR * (1 + bass * 0.4) + v * baseR * 0.6;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseR * 1.5);
    grad.addColorStop(0, rgb(accent.primary, 0.7));
    grad.addColorStop(0.6, rgb(accent.secondary, 0.4));
    grad.addColorStop(1, rgb(accent.tertiary, 0));
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = rgb("#ffffff", 0.3);
    ctx.lineWidth = 1;
    ctx.stroke();
}

function drawParticles({ ctx, w, h, spectrum, accent, state }: RenderArgs) {
    const bass = bandEnergy(spectrum, 0, 0.1);
    const mid = bandEnergy(spectrum, 0.1, 0.4);
    const treb = bandEnergy(spectrum, 0.4, 1);
    // Spawn proportional to energy (cap to keep canvas snappy)
    const spawnCount = Math.min(8, Math.floor((bass + mid + treb) * 6));
    for (let i = 0; i < spawnCount; i++) {
        const energy = bass > mid && bass > treb ? bass : mid > treb ? mid : treb;
        const hueChoice = Math.random();
        state.particles.push({
            x: w / 2, y: h / 2,
            vx: (Math.random() - 0.5) * (4 + energy * 8),
            vy: (Math.random() - 0.5) * (4 + energy * 8),
            life: 1,
            hue: hueChoice < 0.33 ? 0 : hueChoice < 0.66 ? 1 : 2,
        });
    }
    if (state.particles.length > 200) state.particles.splice(0, state.particles.length - 200);
    // Gentle motion-blur trail
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(0, 0, w, h);
    for (let i = state.particles.length - 1; i >= 0; i--) {
        const p = state.particles[i];
        p.x += p.vx; p.y += p.vy;
        p.vx *= 0.97; p.vy *= 0.97;
        p.life -= 0.018;
        if (p.life <= 0 || p.x < 0 || p.x > w || p.y < 0 || p.y > h) {
            state.particles.splice(i, 1); continue;
        }
        const color = p.hue === 0 ? accent.primary : p.hue === 1 ? accent.secondary : accent.tertiary;
        ctx.fillStyle = rgb(color, p.life);
        ctx.beginPath(); ctx.arc(p.x, p.y, 2 + p.life * 2, 0, Math.PI * 2); ctx.fill();
    }
}

function drawVU({ ctx, w, h, peakL, peakR, accent }: RenderArgs) {
    const drawNeedle = (cx: number, cy: number, r: number, value: number, label: string) => {
        // Arc
        ctx.strokeStyle = rgb("#ffffff", 0.15);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, Math.PI * 2); ctx.stroke();
        // Red zone
        ctx.strokeStyle = rgb("#ef4444", 0.6);
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI * 1.75, Math.PI * 2); ctx.stroke();
        // Ticks
        for (let i = 0; i <= 10; i++) {
            const a = Math.PI + (i / 10) * Math.PI;
            ctx.strokeStyle = rgb("#ffffff", 0.4);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6));
            ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
            ctx.stroke();
        }
        // Needle
        const v = Math.min(1, value);
        const a = Math.PI + v * Math.PI;
        const overload = v > 0.85;
        ctx.strokeStyle = overload ? "#ef4444" : accent.primary;
        ctx.lineWidth = 2;
        ctx.shadowBlur = 6;
        ctx.shadowColor = overload ? "#ef4444" : accent.primary;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4));
        ctx.stroke();
        ctx.shadowBlur = 0;
        // Label
        ctx.fillStyle = rgb("#ffffff", 0.5);
        ctx.font = "bold 8px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(label, cx, cy - 4);
        // Hub
        ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2); ctx.fill();
    };
    const r = Math.min(w / 4, h * 0.7);
    drawNeedle(w * 0.27, h * 0.85, r, peakL, "L");
    drawNeedle(w * 0.73, h * 0.85, r, peakR, "R");
}

function drawPeakRms({ ctx, w, h, peakL, peakR, accent }: RenderArgs) {
    const drawBar = (x: number, bw: number, value: number) => {
        const v = Math.min(1, value);
        const bh = v * h;
        const grad = ctx.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, "#10b981");
        grad.addColorStop(0.7, "#eab308");
        grad.addColorStop(0.95, "#ef4444");
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(x, 0, bw, h);
        ctx.fillStyle = grad;
        ctx.fillRect(x, h - bh, bw, bh);
        // dB ticks
        for (let i = 1; i < 6; i++) {
            const ty = (i / 6) * h;
            ctx.fillStyle = rgb("#000", 0.4);
            ctx.fillRect(x, ty, bw, 1);
        }
    };
    const margin = 10;
    const barW = (w - margin * 3) / 2;
    drawBar(margin, barW, peakL);
    drawBar(margin * 2 + barW, barW, peakR);
    // Labels
    ctx.fillStyle = rgb("#ffffff", 0.4);
    ctx.font = "bold 8px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("L", margin + barW / 2, h - 2);
    ctx.fillText("R", margin * 2 + barW * 1.5, h - 2);
    // Subtle accent border
    ctx.strokeStyle = rgb(accent.primary, 0.15);
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

function drawLissajous({ ctx, w, h, waveformL, waveformR, accent }: RenderArgs) {
    if (waveformL.length === 0 || waveformR.length === 0) {
        // Fallback message — remote can't draw this.
        ctx.fillStyle = rgb("#ffffff", 0.3);
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Lissajous needs raw L/R (host only)", w / 2, h / 2);
        return;
    }
    const cx = w / 2, cy = h / 2;
    const scale = Math.min(w, h) / 2 - 8;
    ctx.strokeStyle = rgb(accent.primary, 0.85);
    ctx.lineWidth = 1;
    ctx.shadowBlur = 8;
    ctx.shadowColor = accent.primary;
    ctx.beginPath();
    const N = Math.min(waveformL.length, waveformR.length);
    for (let i = 0; i < N; i++) {
        const x = cx + ((waveformL[i] - 128) / 128) * scale;
        const y = cy - ((waveformR[i] - 128) / 128) * scale;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    // Cross-hairs
    ctx.strokeStyle = rgb("#ffffff", 0.08);
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
    ctx.moveTo(0, cy); ctx.lineTo(w, cy);
    ctx.stroke();
}
