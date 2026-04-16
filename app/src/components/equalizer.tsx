"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useEQ } from "./eq-context";
import { EQ_PRESETS } from "@/lib/eq-engine";
import {
    Power,
    RotateCcw,
    ChevronDown,
    Sliders,
    Waves,
    Timer,
    Radio,
    Music,
    Volume2,
    Gauge,
    Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Rotary Knob ─────────────────────────────────────────────────────────

function Knob({
    value,
    min,
    max,
    step = 0.01,
    size = 48,
    label,
    unit = "",
    onChange,
    color = "purple",
    disabled = false,
}: {
    value: number;
    min: number;
    max: number;
    step?: number;
    size?: number;
    label: string;
    unit?: string;
    onChange: (v: number) => void;
    color?: "purple" | "blue" | "emerald" | "amber" | "rose";
    disabled?: boolean;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const dragging = useRef(false);
    const startY = useRef(0);
    const startVal = useRef(0);

    const pct = (value - min) / (max - min);
    const angle = -135 + pct * 270; // -135° to +135°

    const colors = {
        purple: { ring: "stroke-purple-500", glow: "rgba(168,85,247,0.3)", text: "text-purple-400" },
        blue: { ring: "stroke-blue-500", glow: "rgba(59,130,246,0.3)", text: "text-blue-400" },
        emerald: { ring: "stroke-emerald-500", glow: "rgba(16,185,129,0.3)", text: "text-emerald-400" },
        amber: { ring: "stroke-amber-500", glow: "rgba(245,158,11,0.3)", text: "text-amber-400" },
        rose: { ring: "stroke-rose-500", glow: "rgba(244,63,94,0.3)", text: "text-rose-400" },
    }[color];

    const circumference = 2 * Math.PI * 18;
    const arcLength = (pct * 270) / 360 * circumference;

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (!dragging.current) return;
            const dy = startY.current - e.clientY;
            const range = max - min;
            const delta = (dy / 150) * range;
            const newVal = Math.min(max, Math.max(min, startVal.current + delta));
            const stepped = Math.round(newVal / step) * step;
            onChange(stepped);
        };
        const onUp = () => { dragging.current = false; };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
    }, [min, max, step, onChange]);

    const displayValue = Math.abs(value) < 10 ? value.toFixed(1) : Math.round(value).toString();

    return (
        <div className="flex flex-col items-center gap-1">
            <div
                ref={ref}
                className={cn("relative cursor-ns-resize select-none", disabled && "opacity-40 pointer-events-none")}
                style={{ width: size, height: size }}
                onMouseDown={(e) => {
                    dragging.current = true;
                    startY.current = e.clientY;
                    startVal.current = value;
                }}
                onDoubleClick={() => onChange((min + max) / 2)}
            >
                {/* Background ring */}
                <svg viewBox="0 0 40 40" className="absolute inset-0 w-full h-full -rotate-90">
                    <circle cx="20" cy="20" r="18" fill="none" stroke="currentColor" strokeWidth="3"
                        className="text-white/5" strokeLinecap="round"
                        strokeDasharray={`${(270 / 360) * circumference} ${circumference}`}
                        strokeDashoffset={0}
                        transform="rotate(-135, 20, 20)"
                    />
                    {/* Active arc */}
                    <circle cx="20" cy="20" r="18" fill="none" strokeWidth="3"
                        className={colors.ring} strokeLinecap="round"
                        strokeDasharray={`${arcLength} ${circumference}`}
                        strokeDashoffset={0}
                        transform="rotate(-135, 20, 20)"
                        style={{ filter: `drop-shadow(0 0 4px ${colors.glow})` }}
                    />
                </svg>
                {/* Center dot / indicator */}
                <div className="absolute inset-0 flex items-center justify-center">
                    <div
                        className="w-[60%] h-[60%] rounded-full bg-white/5 border border-white/10 flex items-center justify-center"
                        style={{ transform: `rotate(${angle}deg)` }}
                    >
                        <div className="absolute top-[2px] w-1 h-2 rounded-full bg-white/60" />
                    </div>
                </div>
            </div>
            <span className={cn("text-[10px] font-mono tabular-nums", colors.text)}>
                {displayValue}{unit}
            </span>
            <span className="text-[9px] text-white/30 uppercase tracking-wider">{label}</span>
        </div>
    );
}

// ─── Vertical Slider (for EQ bands) ──────────────────────────────────────

function BandSlider({
    value,
    label,
    frequency,
    onChange,
    disabled,
}: {
    value: number;
    label: string;
    frequency: number;
    onChange: (v: number) => void;
    disabled?: boolean;
}) {
    const sliderRef = useRef<HTMLDivElement>(null);
    const min = -12;
    const max = 12;
    const pct = ((value - min) / (max - min)) * 100;
    const isPositive = value > 0.5;
    const isNegative = value < -0.5;

    const handleInteraction = useCallback((clientY: number) => {
        const el = sliderRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const y = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        const v = min + y * (max - min);
        onChange(Math.round(v * 2) / 2); // snap to 0.5 dB
    }, [onChange, min, max]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        handleInteraction(e.clientY);
        const onMove = (me: MouseEvent) => handleInteraction(me.clientY);
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, [handleInteraction]);

    return (
        <div className={cn("flex flex-col items-center gap-1", disabled && "opacity-40 pointer-events-none")}>
            <span className="text-[9px] font-mono text-white/40 tabular-nums h-3">
                {value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1)}
            </span>
            <div
                ref={sliderRef}
                className="relative w-6 h-32 rounded-full bg-white/5 cursor-pointer group"
                onMouseDown={handleMouseDown}
                onDoubleClick={() => onChange(0)}
            >
                {/* Center line */}
                <div className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-px bg-white/10" />
                {/* Zero line */}
                <div className="absolute left-0 right-0 top-1/2 h-px bg-white/20" />

                {/* Fill bar */}
                <div className="absolute left-1 right-1 rounded-full overflow-hidden" style={{
                    top: isPositive ? `${100 - pct}%` : "50%",
                    bottom: isNegative ? `${pct}%` : "50%",
                    height: isPositive ? `${pct - 50}%` : isNegative ? `${50 - pct}%` : "0%",
                }}>
                    <div className={cn(
                        "w-full h-full rounded-full",
                        isPositive ? "bg-gradient-to-t from-purple-500/60 to-purple-400/40" : "bg-gradient-to-b from-blue-500/60 to-blue-400/40"
                    )} />
                </div>

                {/* Thumb */}
                <div
                    className="absolute left-1/2 -translate-x-1/2 w-5 h-2.5 rounded-sm bg-white/90 shadow-lg group-hover:bg-white transition-colors"
                    style={{ top: `calc(${100 - pct}% - 5px)` }}
                >
                    <div className="absolute inset-x-[3px] top-1/2 -translate-y-1/2 h-px bg-black/20" />
                </div>
            </div>
            <span className="text-[9px] text-white/30 font-mono">{label}</span>
        </div>
    );
}

// ─── Toggle Switch ───────────────────────────────────────────────────────

function Toggle({ enabled, onChange, label, color = "purple" }: {
    enabled: boolean;
    onChange: (v: boolean) => void;
    label: string;
    color?: string;
}) {
    return (
        <button
            onClick={() => onChange(!enabled)}
            className="flex items-center gap-2 cursor-pointer group"
        >
            <div className={cn(
                "relative w-8 h-4 rounded-full transition-colors",
                enabled ? "bg-purple-500/40" : "bg-white/10"
            )}>
                <div className={cn(
                    "absolute top-0.5 w-3 h-3 rounded-full transition-all shadow-sm",
                    enabled ? "left-[18px] bg-purple-400" : "left-0.5 bg-white/40"
                )} />
            </div>
            <span className={cn(
                "text-[10px] uppercase tracking-wider transition-colors",
                enabled ? "text-purple-400" : "text-white/30"
            )}>{label}</span>
        </button>
    );
}

// ─── Spectrum Analyzer (mini) ────────────────────────────────────────────

function SpectrumAnalyzer({ getAnalyser }: { getAnalyser: () => AnalyserNode | null }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number>(0);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // Reusable buffer — allocated once
        let dataBuffer: Uint8Array<ArrayBuffer> | null = null;

        const draw = () => {
            rafRef.current = requestAnimationFrame(draw);
            const analyser = getAnalyser();
            if (!analyser) return;

            const dpr = window.devicePixelRatio || 1;
            const w = canvas.offsetWidth;
            const h = canvas.offsetHeight;
            canvas.width = w * dpr;
            canvas.height = h * dpr;
            ctx.scale(dpr, dpr);

            const bufferLength = analyser.frequencyBinCount;
            if (!dataBuffer || dataBuffer.length !== bufferLength) {
                dataBuffer = new Uint8Array(bufferLength) as Uint8Array<ArrayBuffer>;
            }
            analyser.getByteFrequencyData(dataBuffer);

            ctx.clearRect(0, 0, w, h);

            const barCount = 32;
            const gap = 1;
            const barWidth = (w - gap * (barCount - 1)) / barCount;

            // Single gradient for all bars — avoid creating per bar per frame
            const gradient = ctx.createLinearGradient(0, h, 0, 0);
            gradient.addColorStop(0, "rgba(168, 85, 247, 0.6)");
            gradient.addColorStop(1, "rgba(59, 130, 246, 0.3)");
            ctx.fillStyle = gradient;

            for (let i = 0; i < barCount; i++) {
                // Map to frequency range (logarithmic)
                const freqIdx = Math.floor(Math.pow(i / barCount, 2) * bufferLength * 0.5);
                const val = dataBuffer[freqIdx] / 255;
                const barH = val * h;

                const x = i * (barWidth + gap);

                ctx.beginPath();
                ctx.roundRect(x, h - barH, barWidth, barH, barWidth / 2);
                ctx.fill();
            }
        };

        draw();
        return () => cancelAnimationFrame(rafRef.current);
    }, [getAnalyser]);

    return (
        <canvas ref={canvasRef} className="w-full h-16 rounded-lg bg-white/[0.02]" />
    );
}

// ─── EQ Curve Visualizer ─────────────────────────────────────────────────

function EQCurve({ bands, enabled }: { bands: { frequency: number; gain: number }[]; enabled: boolean }) {
    const w = 300;
    const h = 60;
    const midY = h / 2;

    // Build SVG path from EQ bands
    const points: string[] = [];
    const minFreq = Math.log10(20);
    const maxFreq = Math.log10(20000);

    for (let px = 0; px <= w; px += 2) {
        const freq = Math.pow(10, minFreq + (px / w) * (maxFreq - minFreq));
        let totalGain = 0;
        for (const band of bands) {
            const dist = Math.log2(freq / band.frequency);
            const influence = Math.exp(-dist * dist * 2);
            totalGain += band.gain * influence;
        }
        const y = midY - (totalGain / 12) * midY * 0.8;
        points.push(`${px},${y}`);
    }

    const pathD = "M" + points.join(" L");

    return (
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-16" preserveAspectRatio="none">
            {/* Grid lines */}
            <line x1="0" y1={midY} x2={w} y2={midY} stroke="white" strokeOpacity="0.1" strokeWidth="0.5" />
            {/* +6dB */}
            <line x1="0" y1={midY / 2} x2={w} y2={midY / 2} stroke="white" strokeOpacity="0.05" strokeWidth="0.5" strokeDasharray="4 4" />
            {/* -6dB */}
            <line x1="0" y1={midY + midY / 2} x2={w} y2={midY + midY / 2} stroke="white" strokeOpacity="0.05" strokeWidth="0.5" strokeDasharray="4 4" />

            {/* Band frequency markers */}
            {bands.map((band, i) => {
                const x = ((Math.log10(band.frequency) - minFreq) / (maxFreq - minFreq)) * w;
                return (
                    <line key={i} x1={x} y1="0" x2={x} y2={h} stroke="white" strokeOpacity="0.05" strokeWidth="0.5" />
                );
            })}

            {/* Fill area */}
            <path
                d={`${pathD} L${w},${midY} L0,${midY} Z`}
                fill="url(#eqFill)"
                opacity={enabled ? 0.3 : 0.1}
            />
            {/* Curve line */}
            <path
                d={pathD}
                fill="none"
                stroke={enabled ? "rgb(168, 85, 247)" : "rgba(255,255,255,0.2)"}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <defs>
                <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgb(168, 85, 247)" stopOpacity="0.4" />
                    <stop offset="100%" stopColor="rgb(168, 85, 247)" stopOpacity="0" />
                </linearGradient>
            </defs>
        </svg>
    );
}


// ═══════════════════════════════════════════════════════════════════════════
// ─── Main EQ Component ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

export function Equalizer({ getAnalyser }: { getAnalyser: () => AnalyserNode | null }) {
    const eq = useEQ();
    const [activeEffectsTab, setActiveEffectsTab] = useState<"compressor" | "reverb" | "delay" | "enhance">("compressor");

    return (
        <div className="flex flex-col gap-4 h-full overflow-y-auto pr-1 custom-scrollbar">
            {/* Header: power + mode switch + reset */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <button
                        onClick={eq.toggle}
                        className={cn(
                            "flex h-8 w-8 items-center justify-center rounded-lg transition-all cursor-pointer",
                            eq.enabled
                                ? "bg-purple-500/20 text-purple-400 shadow-[0_0_12px_rgba(168,85,247,0.2)]"
                                : "bg-white/5 text-white/30 hover:text-white/50"
                        )}
                    >
                        <Power className="h-4 w-4" />
                    </button>
                    <span className={cn(
                        "text-sm font-semibold tracking-tight transition-colors",
                        eq.enabled ? "text-white" : "text-white/30"
                    )}>
                        Equalizer
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    {/* Mode switch */}
                    <div className="flex items-center bg-white/5 rounded-md p-0.5">
                        <button
                            onClick={() => eq.setMode("easy")}
                            className={cn(
                                "px-2.5 py-1 text-[10px] font-medium rounded transition-colors cursor-pointer",
                                eq.mode === "easy" ? "bg-white/10 text-white" : "text-white/30 hover:text-white/50"
                            )}
                        >Easy</button>
                        <button
                            onClick={() => eq.setMode("advanced")}
                            className={cn(
                                "px-2.5 py-1 text-[10px] font-medium rounded transition-colors cursor-pointer",
                                eq.mode === "advanced" ? "bg-white/10 text-white" : "text-white/30 hover:text-white/50"
                            )}
                        >Advanced</button>
                    </div>
                    <button
                        onClick={eq.resetAll}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-white/20 hover:text-white/50 hover:bg-white/5 transition-colors cursor-pointer"
                        title="Reset"
                    >
                        <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>

            {/* EQ Curve visualization */}
            <div className="rounded-xl bg-white/[0.02] border border-white/5 overflow-hidden">
                <EQCurve bands={eq.bands} enabled={eq.enabled} />
            </div>

            {eq.mode === "easy" ? (
                <EasyMode />
            ) : (
                <AdvancedMode
                    getAnalyser={getAnalyser}
                    activeEffectsTab={activeEffectsTab}
                    setActiveEffectsTab={setActiveEffectsTab}
                />
            )}
        </div>
    );
}

// ─── Easy Mode ───────────────────────────────────────────────────────────

function EasyMode() {
    const eq = useEQ();
    const bass = eq.getEasyBass();
    const mid = eq.getEasyMid();
    const treble = eq.getEasyTreble();

    return (
        <>
            {/* 3-band knobs */}
            <div className="flex items-center justify-center gap-8 py-4">
                <Knob value={bass} min={-12} max={12} step={0.5} size={64} label="Bass" unit="dB"
                    onChange={eq.setEasyBass} color="purple" disabled={!eq.enabled} />
                <Knob value={mid} min={-12} max={12} step={0.5} size={64} label="Mid" unit="dB"
                    onChange={eq.setEasyMid} color="blue" disabled={!eq.enabled} />
                <Knob value={treble} min={-12} max={12} step={0.5} size={64} label="Treble" unit="dB"
                    onChange={eq.setEasyTreble} color="emerald" disabled={!eq.enabled} />
            </div>

            {/* Presets grid */}
            <div>
                <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Presets</p>
                <div className="grid grid-cols-4 gap-1.5">
                    {EQ_PRESETS.map((preset) => (
                        <button
                            key={preset.name}
                            onClick={() => eq.applyPreset(preset.name)}
                            className={cn(
                                "flex flex-col items-center gap-0.5 py-2 px-1 rounded-lg text-[10px] transition-all cursor-pointer",
                                eq.activePreset === preset.name
                                    ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                                    : "bg-white/[0.03] text-white/40 hover:bg-white/[0.06] hover:text-white/60 border border-transparent"
                            )}
                        >
                            <span className="text-base">{preset.icon}</span>
                            <span className="truncate w-full text-center">{preset.name}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Quick effects */}
            <div className="border-t border-white/5 pt-3 space-y-2">
                <p className="text-[10px] text-white/30 uppercase tracking-wider">Quick Effects</p>
                <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-2 rounded-lg bg-white/[0.02] p-3 border border-white/5">
                        <Toggle enabled={eq.effects.bassBoostEnabled} onChange={(v) => eq.setEffect("bassBoostEnabled", v)} label="Bass Boost" />
                        {eq.effects.bassBoostEnabled && (
                            <input
                                type="range" min="0" max="1" step="0.05"
                                value={eq.effects.bassBoostAmount}
                                onChange={(e) => eq.setEffect("bassBoostAmount", parseFloat(e.target.value))}
                                className="w-full h-1 accent-purple-500"
                            />
                        )}
                    </div>
                    <div className="flex flex-col gap-2 rounded-lg bg-white/[0.02] p-3 border border-white/5">
                        <Toggle enabled={eq.effects.compressorEnabled} onChange={(v) => eq.setEffect("compressorEnabled", v)} label="Compressor" />
                    </div>
                    <div className="flex flex-col gap-2 rounded-lg bg-white/[0.02] p-3 border border-white/5">
                        <Toggle enabled={eq.effects.reverbEnabled} onChange={(v) => eq.setEffect("reverbEnabled", v)} label="Reverb" />
                        {eq.effects.reverbEnabled && (
                            <input
                                type="range" min="0" max="1" step="0.05"
                                value={eq.effects.reverbMix}
                                onChange={(e) => eq.setEffect("reverbMix", parseFloat(e.target.value))}
                                className="w-full h-1 accent-purple-500"
                            />
                        )}
                    </div>
                    <div className="flex flex-col gap-2 rounded-lg bg-white/[0.02] p-3 border border-white/5">
                        <Toggle enabled={eq.effects.delayEnabled} onChange={(v) => eq.setEffect("delayEnabled", v)} label="Delay" />
                        {eq.effects.delayEnabled && (
                            <input
                                type="range" min="0" max="1" step="0.05"
                                value={eq.effects.delayMix}
                                onChange={(e) => eq.setEffect("delayMix", parseFloat(e.target.value))}
                                className="w-full h-1 accent-purple-500"
                            />
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}

// ─── Advanced Mode ───────────────────────────────────────────────────────

function AdvancedMode({
    getAnalyser,
    activeEffectsTab,
    setActiveEffectsTab,
}: {
    getAnalyser: () => AnalyserNode | null;
    activeEffectsTab: "compressor" | "reverb" | "delay" | "enhance";
    setActiveEffectsTab: (t: "compressor" | "reverb" | "delay" | "enhance") => void;
}) {
    const eq = useEQ();

    return (
        <>
            {/* Preamp + 10-band graphic EQ */}
            <div className="rounded-xl bg-white/[0.02] border border-white/5 p-3">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] text-white/30 uppercase tracking-wider">10-Band Graphic EQ</span>
                    <span className="text-[9px] text-white/20">
                        {eq.activePreset ? `Preset: ${eq.activePreset}` : "Custom"}
                    </span>
                </div>

                <div className="flex items-end gap-1 justify-center">
                    {/* Pre-gain */}
                    <div className="mr-2 border-r border-white/10 pr-2">
                        <BandSlider
                            value={eq.preGain}
                            label="Pre"
                            frequency={0}
                            onChange={eq.setPreGain}
                            disabled={!eq.enabled}
                        />
                    </div>
                    {/* 10 bands */}
                    {eq.bands.map((band, i) => (
                        <BandSlider
                            key={band.frequency}
                            value={band.gain}
                            label={band.label}
                            frequency={band.frequency}
                            onChange={(v) => eq.setBandGain(i, v)}
                            disabled={!eq.enabled}
                        />
                    ))}
                </div>
            </div>

            {/* Presets (compact) */}
            <div className="flex gap-1 flex-wrap">
                {EQ_PRESETS.map((preset) => (
                    <button
                        key={preset.name}
                        onClick={() => eq.applyPreset(preset.name)}
                        className={cn(
                            "px-2 py-1 rounded text-[10px] transition-all cursor-pointer",
                            eq.activePreset === preset.name
                                ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                                : "bg-white/[0.03] text-white/30 hover:text-white/50 border border-transparent"
                        )}
                    >
                        {preset.icon} {preset.name}
                    </button>
                ))}
            </div>

            {/* Spectrum analyzer */}
            <div className="rounded-xl bg-white/[0.02] border border-white/5 p-2">
                <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Spectrum</p>
                <SpectrumAnalyzer getAnalyser={getAnalyser} />
            </div>

            {/* Effects panel */}
            <div className="rounded-xl bg-white/[0.02] border border-white/5 overflow-hidden">
                {/* Effects tabs */}
                <div className="flex border-b border-white/5">
                    {([
                        { key: "compressor" as const, icon: Gauge, label: "Compressor" },
                        { key: "reverb" as const, icon: Waves, label: "Reverb" },
                        { key: "delay" as const, icon: Timer, label: "Delay" },
                        { key: "enhance" as const, icon: Zap, label: "Enhance" },
                    ]).map(({ key, icon: Icon, label }) => (
                        <button
                            key={key}
                            onClick={() => setActiveEffectsTab(key)}
                            className={cn(
                                "flex-1 flex items-center justify-center gap-1.5 py-2 text-[10px] transition-colors cursor-pointer relative",
                                activeEffectsTab === key ? "text-purple-400" : "text-white/30 hover:text-white/50"
                            )}
                        >
                            <Icon className="h-3 w-3" />
                            <span className="hidden sm:inline">{label}</span>
                            {/* Active dot */}
                            {((key === "compressor" && eq.effects.compressorEnabled) ||
                                (key === "reverb" && eq.effects.reverbEnabled) ||
                                (key === "delay" && eq.effects.delayEnabled) ||
                                (key === "enhance" && (eq.effects.bassBoostEnabled || eq.effects.stereoEnabled))
                            ) && (
                                    <span className="absolute top-1 right-2 w-1.5 h-1.5 rounded-full bg-purple-400" />
                                )}
                        </button>
                    ))}
                </div>

                <div className="p-3">
                    {activeEffectsTab === "compressor" && <CompressorPanel />}
                    {activeEffectsTab === "reverb" && <ReverbPanel />}
                    {activeEffectsTab === "delay" && <DelayPanel />}
                    {activeEffectsTab === "enhance" && <EnhancePanel />}
                </div>
            </div>
        </>
    );
}

// ─── Effect Panels ───────────────────────────────────────────────────────

function CompressorPanel() {
    const eq = useEQ();
    const e = eq.effects;

    return (
        <div className="space-y-3">
            <Toggle enabled={e.compressorEnabled} onChange={(v) => eq.setEffect("compressorEnabled", v)} label="Compressor" />
            <div className="flex items-center justify-center gap-4 flex-wrap">
                <Knob value={e.compressorThreshold} min={-60} max={0} step={1} size={48} label="Threshold" unit="dB"
                    onChange={(v) => eq.setEffect("compressorThreshold", v)} color="amber" disabled={!e.compressorEnabled} />
                <Knob value={e.compressorKnee} min={0} max={40} step={1} size={48} label="Knee" unit="dB"
                    onChange={(v) => eq.setEffect("compressorKnee", v)} color="amber" disabled={!e.compressorEnabled} />
                <Knob value={e.compressorRatio} min={1} max={20} step={0.5} size={48} label="Ratio" unit=":1"
                    onChange={(v) => eq.setEffect("compressorRatio", v)} color="amber" disabled={!e.compressorEnabled} />
                <Knob value={e.compressorAttack * 1000} min={0} max={1000} step={1} size={48} label="Attack" unit="ms"
                    onChange={(v) => eq.setEffect("compressorAttack", v / 1000)} color="amber" disabled={!e.compressorEnabled} />
                <Knob value={e.compressorRelease * 1000} min={10} max={1000} step={10} size={48} label="Release" unit="ms"
                    onChange={(v) => eq.setEffect("compressorRelease", v / 1000)} color="amber" disabled={!e.compressorEnabled} />
            </div>
        </div>
    );
}

function ReverbPanel() {
    const eq = useEQ();
    const e = eq.effects;

    return (
        <div className="space-y-3">
            <Toggle enabled={e.reverbEnabled} onChange={(v) => eq.setEffect("reverbEnabled", v)} label="Reverb" />
            <div className="flex items-center justify-center gap-6">
                <Knob value={e.reverbMix * 100} min={0} max={100} step={1} size={56} label="Mix" unit="%"
                    onChange={(v) => eq.setEffect("reverbMix", v / 100)} color="blue" disabled={!e.reverbEnabled} />
                <Knob value={e.reverbDecay} min={0.1} max={10} step={0.1} size={56} label="Decay" unit="s"
                    onChange={(v) => eq.setEffect("reverbDecay", v)} color="blue" disabled={!e.reverbEnabled} />
            </div>
        </div>
    );
}

function DelayPanel() {
    const eq = useEQ();
    const e = eq.effects;

    return (
        <div className="space-y-3">
            <Toggle enabled={e.delayEnabled} onChange={(v) => eq.setEffect("delayEnabled", v)} label="Delay" />
            <div className="flex items-center justify-center gap-4">
                <Knob value={e.delayTime * 1000} min={10} max={2000} step={10} size={52} label="Time" unit="ms"
                    onChange={(v) => eq.setEffect("delayTime", v / 1000)} color="emerald" disabled={!e.delayEnabled} />
                <Knob value={e.delayFeedback * 100} min={0} max={90} step={1} size={52} label="Feedback" unit="%"
                    onChange={(v) => eq.setEffect("delayFeedback", v / 100)} color="emerald" disabled={!e.delayEnabled} />
                <Knob value={e.delayMix * 100} min={0} max={100} step={1} size={52} label="Mix" unit="%"
                    onChange={(v) => eq.setEffect("delayMix", v / 100)} color="emerald" disabled={!e.delayEnabled} />
            </div>
        </div>
    );
}

function EnhancePanel() {
    const eq = useEQ();
    const e = eq.effects;

    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <Toggle enabled={e.bassBoostEnabled} onChange={(v) => eq.setEffect("bassBoostEnabled", v)} label="Bass Boost" />
                {e.bassBoostEnabled && (
                    <div className="flex justify-center">
                        <Knob value={e.bassBoostAmount * 100} min={0} max={100} step={1} size={52} label="Amount" unit="%"
                            onChange={(v) => eq.setEffect("bassBoostAmount", v / 100)} color="rose" />
                    </div>
                )}
            </div>
            <div className="border-t border-white/5 pt-3 space-y-2">
                <Toggle enabled={e.stereoEnabled} onChange={(v) => eq.setEffect("stereoEnabled", v)} label="Stereo Width" />
                {e.stereoEnabled && (
                    <div className="flex justify-center">
                        <Knob value={e.stereoWidth} min={0} max={2} step={0.05} size={52} label="Width" unit="x"
                            onChange={(v) => eq.setEffect("stereoWidth", v)} color="rose" />
                    </div>
                )}
            </div>
        </div>
    );
}
