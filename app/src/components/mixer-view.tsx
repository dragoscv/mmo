"use client";

import { useCallback, useRef, useEffect, useState, useReducer, useMemo, memo, Fragment } from "react";
import { useMixer, useMixerActions } from "./mixer-context";
import { usePlayer } from "./player-context";
import { DeckTrackPicker } from "./deck-track-picker";
import { MixerWaveforms, CUE_COLORS } from "./mixer-waveforms";
import { MixerSettingsModal } from "./mixer-settings-modal";
import { MixerBrowserModal } from "./mixer-browser-modal-v2";
import { SamplePickerModal } from "./sample-picker-modal";
import { TrackContextMenu } from "./track-actions";
import type { MidiActionHandler } from "@/lib/midi-engine";
import { useMidi, useMidiMessages } from "@/hooks/use-midi";
import { subscribeRaf, getSharedFrequencyData, getSharedTimeDomainData } from "@/lib/raf-scheduler";
import { useDeckCurrentTime } from "@/lib/mixer-time-store";
import { usePersonalization } from "@/hooks/use-personalization";
import { CircuitTracksPanel, CircuitTracksBadge } from "./circuit-tracks-panel";
import { PerformancePanel } from "./performance-stats";
import { JogWheel } from "./jog-wheel";
import { cn, formatDuration, formatBytes, formatKey } from "@/lib/utils";
import { useRenderCount } from "@/lib/dev-debugger";
import type { DeckState } from "@/lib/mixer-engine";
import { useDAWSettings } from "@/hooks/use-daw-settings";
import {
    FILTER_TYPES, COLOR_FX_TYPES, BEAT_FX_TYPES,
    type FilterType, type ColorFxType, type BeatFxType, type PadMode,
    type CrossfaderAssign, type WaveformMode, type AutomixMode,
    type DeckSide, type DeckMode, DECK_COLORS,
} from "@/lib/mixer-engine";
import type { Track } from "@/db/schema";
import {
    Play,
    Pause,
    Power,
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    Settings2,
    Headphones,
    Circle,
    Lock,
    Magnet,
    Layers,
    Disc,
    Undo2,
    Repeat,
    Zap,
    Grid3X3,
    ArrowLeftRight,
    Lightbulb,
    Target,
    ArrowBigUp,
    X,
    Link2,
    Unlink2,
    Gauge,
    Square,
    Maximize2,
    Minimize2,
    Mic,
    Drum,
    Music2,
    Piano,
    Volume2,
    VolumeX,
} from "lucide-react";
import { useFocusMode } from "./focus-mode-context";
import {
    type StemType,
    STEM_TYPES,
    STEM_LABELS,
    STEM_COLORS,
    createDefaultStemConfigs,
    type RealtimeStemProcessor,
} from "@/lib/stems-engine";

// ─── Utilities ───────────────────────────────────────────────────────────

type DeckProps = { side: DeckSide; deck: DeckState; color: string; analyser: AnalyserNode | null };

function formatTime(s: number): string {
    if (!s || !isFinite(s)) return "0:00";
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatTimeRemaining(current: number, duration: number): string {
    const rem = Math.max(0, duration - current);
    return `-${formatTime(rem)}`;
}

// ─── Knob Component ──────────────────────────────────────────────────────

interface KnobProps {
    value: number;
    min: number;
    max: number;
    onChange: (v: number) => void;
    size?: number;
    label?: string;
    color?: string;
    isKilled?: boolean;
    onDoubleClick?: () => void;
    showValue?: boolean;
    centerValue?: number; // When set, arc is bi-directional from this value
    valueFormatter?: (v: number) => string;
}

const Knob = memo(function Knob({
    value,
    min,
    max,
    onChange,
    size = 44,
    label,
    color = "rgb(168,85,247)",
    isKilled,
    onDoubleClick,
    showValue,
    centerValue,
    valueFormatter,
}: KnobProps) {
    const dragging = useRef(false);
    const startY = useRef(0);
    const startVal = useRef(0);

    const range = max - min;
    const normalized = (value - min) / range;

    // When centerValue is set, map it to 12 o'clock (0°)
    // Left half (-135° to 0°) covers min→center, right half (0° to +135°) covers center→max
    let angle: number;
    if (centerValue !== undefined) {
        if (value <= centerValue) {
            const leftRange = centerValue - min;
            const leftNorm = leftRange > 0 ? (value - min) / leftRange : 0;
            angle = -135 + leftNorm * 135;
        } else {
            const rightRange = max - centerValue;
            const rightNorm = rightRange > 0 ? (value - centerValue) / rightRange : 0;
            angle = rightNorm * 135;
        }
    } else {
        angle = -135 + normalized * 270;
    }

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        dragging.current = true;
        startY.current = e.clientY;
        startVal.current = value;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }, [value]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!dragging.current) return;
        const dy = startY.current - e.clientY;
        const sensitivity = range / 150;
        const newVal = Math.max(min, Math.min(max, startVal.current + dy * sensitivity));
        onChange(Math.round(newVal * 10) / 10);
    }, [min, max, range, onChange]);

    const handlePointerUp = useCallback(() => {
        dragging.current = false;
    }, []);

    return (
        <div className="flex flex-col items-center gap-1">
            <div
                className={cn(
                    "relative rounded-full cursor-grab active:cursor-grabbing select-none transition-shadow",
                    isKilled && "opacity-30"
                )}
                style={{ width: size, height: size }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onDoubleClick={onDoubleClick}
            >
                <svg width={size} height={size} className="absolute inset-0">
                    {(() => {
                        const r = size / 2 - 3;
                        const circumference = 2 * Math.PI * r;
                        const arcTotal = (270 / 360) * circumference;
                        const gapTotal = circumference - arcTotal;
                        // SVG circle stroke starts at 3 o'clock. Our arc starts at 7:30 (225° from 12).
                        // Offset = -(rotate from 3 o'clock to start) = -(225° - 90°) = -135°
                        // In circumference units: -135/360 * circumference
                        const baseOffset = -(135 / 360) * circumference;

                        // Background arc track
                        const bgArc = (
                            <circle
                                cx={size / 2} cy={size / 2} r={r}
                                fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={2.5}
                                strokeDasharray={`${arcTotal} ${gapTotal}`}
                                strokeDashoffset={baseOffset}
                                strokeLinecap="round"
                            />
                        );

                        if (centerValue !== undefined) {
                            // Center is at 12 o'clock = 0° rotation = midpoint of arc
                            // Arc midpoint in stroke units = arcTotal / 2 from start
                            // The colored arc spans from center to current angle
                            const centerAngle = 0; // 12 o'clock
                            const currentAngle = angle; // -135 to +135

                            const startDeg = Math.min(centerAngle, currentAngle);
                            const endDeg = Math.max(centerAngle, currentAngle);
                            const spanDeg = endDeg - startDeg;

                            const arcLen = (spanDeg / 360) * circumference;
                            const arcStartOffset = baseOffset - ((startDeg + 135) / 360) * circumference;

                            return (
                                <>
                                    {bgArc}
                                    {/* Center tick mark at 12 o'clock */}
                                    <line
                                        x1={size / 2} y1={1} x2={size / 2} y2={4}
                                        stroke="rgba(255,255,255,0.25)" strokeWidth={1.5} strokeLinecap="round"
                                    />
                                    {spanDeg > 0.5 && (
                                        <circle
                                            cx={size / 2} cy={size / 2} r={r}
                                            fill="none" stroke={color} strokeWidth={2.5}
                                            strokeDasharray={`${arcLen} ${circumference - arcLen}`}
                                            strokeDashoffset={arcStartOffset}
                                            strokeLinecap="round"
                                            className="transition-[stroke-dasharray,stroke-dashoffset] duration-75"
                                        />
                                    )}
                                </>
                            );
                        } else {
                            // Standard: arc from start (min) to current value
                            const valAngle = angle + 135; // 0 to 270
                            const arcLen = (valAngle / 360) * circumference;

                            return (
                                <>
                                    {bgArc}
                                    <circle
                                        cx={size / 2} cy={size / 2} r={r}
                                        fill="none" stroke={color} strokeWidth={2.5}
                                        strokeDasharray={`${arcLen} ${circumference - arcLen}`}
                                        strokeDashoffset={baseOffset}
                                        strokeLinecap="round"
                                        className="transition-[stroke-dasharray] duration-75"
                                    />
                                </>
                            );
                        }
                    })()}
                </svg>
                <div
                    className="absolute inset-1.5 rounded-full bg-[#1a1a2e] border border-white/10"
                    style={{ transform: `rotate(${angle}deg)` }}
                >
                    <div
                        className="absolute top-1 left-1/2 -translate-x-1/2 w-1 h-1.5 rounded-full"
                        style={{ backgroundColor: color }}
                    />
                </div>
            </div>
            {showValue && (
                <span className="text-[8px] tabular-nums text-white/30 font-mono -mt-0.5">
                    {valueFormatter ? valueFormatter(value) : value.toFixed(1)}
                </span>
            )}
            {label && (
                <span className="text-[9px] uppercase tracking-wider text-white/40 font-medium">
                    {label}
                </span>
            )}
        </div>
    );
});

// ─── Vertical Fader ──────────────────────────────────────────────────────

const VerticalFader = memo(function VerticalFader({
    value,
    min = 0,
    max = 1,
    onChange,
    height = 120,
    color = "rgb(168,85,247)",
    label,
}: {
    value: number;
    min?: number;
    max?: number;
    onChange: (v: number) => void;
    height?: number;
    color?: string;
    label?: string;
}) {
    const trackRef = useRef<HTMLDivElement>(null);
    const dragging = useRef(false);

    const normalized = (value - min) / (max - min);

    const updateFromPointer = useCallback((e: React.PointerEvent) => {
        if (!trackRef.current) return;
        const rect = trackRef.current.getBoundingClientRect();
        const y = 1 - (e.clientY - rect.top) / rect.height;
        const clamped = Math.max(0, Math.min(1, y));
        onChange(min + clamped * (max - min));
    }, [min, max, onChange]);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        updateFromPointer(e);
    }, [updateFromPointer]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!dragging.current) return;
        updateFromPointer(e);
    }, [updateFromPointer]);

    const handlePointerUp = useCallback(() => {
        dragging.current = false;
    }, []);

    return (
        <div className="flex flex-col items-center gap-1.5">
            {label && (
                <span className="text-[9px] uppercase tracking-wider text-white/40 font-medium">{label}</span>
            )}
            <div
                ref={trackRef}
                className="relative rounded-full cursor-pointer"
                style={{ width: 6, height }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
            >
                <div className="absolute inset-0 rounded-full bg-white/10" />
                <div
                    className="absolute bottom-0 left-0 right-0 rounded-full transition-[height] duration-75"
                    style={{ height: `${normalized * 100}%`, backgroundColor: color }}
                />
                <div
                    className="absolute left-1/2 -translate-x-1/2 w-4 h-3 rounded-sm bg-white/90 shadow-md border border-white/20 transition-[bottom] duration-75"
                    style={{ bottom: `calc(${normalized * 100}% - 6px)` }}
                />
            </div>
            <span className="text-[9px] tabular-nums text-white/40">{Math.round(value * 100)}</span>
        </div>
    );
});

// ─── Horizontal Crossfader ───────────────────────────────────────────────

const Crossfader = memo(function Crossfader({ value, onChange }: { value: number; onChange: (v: number) => void }) {
    const trackRef = useRef<HTMLDivElement>(null);
    const dragging = useRef(false);

    const updateFromPointer = useCallback((e: React.PointerEvent) => {
        if (!trackRef.current) return;
        const rect = trackRef.current.getBoundingClientRect();
        onChange(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
    }, [onChange]);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        updateFromPointer(e);
    }, [updateFromPointer]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!dragging.current) return;
        updateFromPointer(e);
    }, [updateFromPointer]);

    const handlePointerUp = useCallback(() => {
        dragging.current = false;
    }, []);

    return (
        <div className="flex flex-col items-center gap-2 w-full">
            <div className="flex items-center justify-between w-full px-1">
                <span className="text-[9px] uppercase tracking-wider text-purple-400 font-bold">A</span>
                <span className="text-[9px] uppercase tracking-wider text-white/30">Crossfader</span>
                <span className="text-[9px] uppercase tracking-wider text-blue-400 font-bold">B</span>
            </div>
            <div
                ref={trackRef}
                className="relative w-full h-3 rounded-full cursor-pointer bg-white/5 border border-white/10"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
            >
                <div className="absolute inset-0.5 rounded-full bg-gradient-to-r from-purple-500/20 via-transparent to-blue-500/20" />
                <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-px bg-white/20" />
                <div
                    className="absolute top-1/2 -translate-y-1/2 w-8 h-5 rounded-md bg-white/90 shadow-lg border border-white/20 transition-[left] duration-75"
                    style={{ left: `calc(${value * 100}% - 16px)` }}
                >
                    <div className="absolute inset-x-2 top-1/2 -translate-y-1/2 h-px bg-black/30" />
                </div>
            </div>
        </div>
    );
});

// ─── Level Meter ─────────────────────────────────────────────────────────

function LevelMeter({ analyser, color }: { analyser: AnalyserNode | null; color: string }) {
    const barARef = useRef<HTMLDivElement>(null);
    const barBRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!analyser) return;
        let lastLevel = -1;
        let lastWasHot = false;
        const update = () => {
            // Use the shared analyser cache: if the waveform / spectrum already
            // pulled this frame, we re-use their buffer instead of stalling the
            // audio thread again.
            const data = getSharedFrequencyData(analyser);
            // Sample every 4th bin instead of summing all (4× faster)
            let sum = 0;
            const step = 4;
            const len = data.length;
            for (let i = 0; i < len; i += step) sum += data[i];
            const level = sum / (len / step) / 255;
            // Skip DOM writes when nothing visibly changed (cheap early exit).
            if (Math.abs(level - lastLevel) < 0.005 && (level > 0.7) === lastWasHot) return;
            lastLevel = level;
            lastWasHot = level > 0.7;
            const h = `${Math.min(level * 130, 100)}%`;
            const bg = `linear-gradient(to top, ${color}, ${lastWasHot ? "#ef4444" : color})`;
            if (barARef.current) { barARef.current.style.height = h; barARef.current.style.background = bg; }
            if (barBRef.current) { barBRef.current.style.height = h; barBRef.current.style.background = bg; }
        };
        // Level meters at 30 fps look identical to 60 fps to the human eye and
        // halve their main-thread cost.
        return subscribeRaf(update, { fps: 30 });
    }, [analyser, color]);

    return (
        <div className="flex gap-0.5 h-20">
            <div className="w-1.5 rounded-full bg-white/5 overflow-hidden flex flex-col-reverse">
                <div ref={barARef} className="rounded-full" style={{ height: "0%" }} />
            </div>
            <div className="w-1.5 rounded-full bg-white/5 overflow-hidden flex flex-col-reverse">
                <div ref={barBRef} className="rounded-full" style={{ height: "0%" }} />
            </div>
        </div>
    );
}

// ─── Beat Indicator LED ──────────────────────────────────────────────────

function BeatIndicator({ deck, color }: { deck: DeckState; color: string }) {
    const dotsRef = useRef<(HTMLDivElement | null)[]>([]);
    const phaseRef = useRef(0);
    const beatRef = useRef(0);

    useEffect(() => {
        if (!deck.isPlaying || deck.bpm <= 0) {
            phaseRef.current = 0;
            beatRef.current = 0;
            // Reset all dots to inactive
            dotsRef.current.forEach(dot => {
                if (dot) {
                    dot.style.backgroundColor = "rgba(255,255,255,0.05)";
                    dot.style.borderColor = "rgba(255,255,255,0.08)";
                    dot.style.boxShadow = "none";
                }
            });
            return;
        }
        const beatInterval = 60 / deck.bpm;
        let last = performance.now();
        const animate = (now: number) => {
            const dt = (now - last) / 1000;
            last = now; phaseRef.current += dt / beatInterval;
            if (phaseRef.current >= 1) {
                beatRef.current = (beatRef.current + 1) % 4;
                phaseRef.current %= 1;
            }
            const brightness = Math.max(0, 1 - phaseRef.current * 2.5);
            const beat = beatRef.current;
            // Direct DOM updates — no React re-renders
            for (let i = 0; i < 4; i++) {
                const dot = dotsRef.current[i];
                if (!dot) continue;
                if (i === beat) {
                    const c = i === 0 ? color : "white";
                    const pct = Math.round(30 + brightness * 70);
                    dot.style.backgroundColor = `color-mix(in srgb, ${c} ${pct}%, transparent)`;
                    dot.style.borderColor = `color-mix(in srgb, ${c} 60%, transparent)`;
                    // No box-shadow: blurred shadows recalculated per frame are
                    // a major GPU rasterisation cost (measured 15–25 % GPU on
                    // integrated Iris Xe per active BeatIndicator).
                } else {
                    dot.style.backgroundColor = "rgba(255,255,255,0.05)";
                    dot.style.borderColor = "rgba(255,255,255,0.08)";
                }
            }
        };
        // Capped at 30 fps. A beat pulse does not benefit from 120 fps —
        // the eye cannot distinguish additional smoothness on a 6 px dot,
        // and the per-frame color-mix + inline-style writes are not free.
        return subscribeRaf(animate, { fps: 30 });
    }, [deck.isPlaying, deck.bpm, color]);

    return (
        <div className="flex items-center gap-1">
            {[0, 1, 2, 3].map(i => (
                <div key={i} className="relative">
                    <div
                        ref={el => { dotsRef.current[i] = el; }}
                        className="w-2.5 h-2.5 lg:w-3 lg:h-3 rounded-full border"
                        style={{
                            backgroundColor: "rgba(255,255,255,0.05)",
                            borderColor: "rgba(255,255,255,0.08)",
                        }}
                    />
                </div>
            ))}
        </div>
    );
}

// ─── Tempo Fader (Pitch Slider) ──────────────────────────────────────────

const TempoFader = memo(function TempoFader({
    value,
    originalBpm,
    tempoRange,
    onChange,
    onRangeChange,
    onSync,
    color,
    isSynced,
}: {
    value: number;
    originalBpm: number;
    tempoRange: number;
    onChange: (bpm: number) => void;
    onRangeChange: (range: number) => void;
    onSync: () => void;
    color: string;
    isSynced: boolean;
}) {
    const trackRef = useRef<HTMLDivElement>(null);
    const dragging = useRef(false);

    // Calculate current ±% from original
    const pctChange = originalBpm > 0 ? ((value - originalBpm) / originalBpm) * 100 : 0;

    // Normalize slider position: center = 0%, up = faster, down = slower
    // Inverted: top=+range%, bottom=-range%
    const normalized = originalBpm > 0 ? 0.5 - (pctChange / (tempoRange * 2)) : 0.5;

    const updateFromPointer = useCallback((e: React.PointerEvent) => {
        if (!trackRef.current || originalBpm <= 0) return;
        const rect = trackRef.current.getBoundingClientRect();
        const y = (e.clientY - rect.top) / rect.height;
        const clamped = Math.max(0, Math.min(1, y));
        // Top = +range%, Bottom = -range%
        const pct = (0.5 - clamped) * tempoRange * 2;
        const newBpm = originalBpm * (1 + pct / 100);
        onChange(Math.round(newBpm * 10) / 10);
    }, [originalBpm, tempoRange, onChange]);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        updateFromPointer(e);
    }, [updateFromPointer]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!dragging.current) return;
        updateFromPointer(e);
    }, [updateFromPointer]);

    const handlePointerUp = useCallback(() => {
        dragging.current = false;
    }, []);

    const ranges = [6, 10, 16, 25];

    return (
        <div className="flex flex-col items-center gap-1 self-stretch">
            <span className="text-[7px] lg:text-[8px] uppercase tracking-wider text-white/20">Tempo</span>

            {/* Tempo Range selector */}
            <div className="flex items-center gap-0.5">
                {ranges.map(r => (
                    <button key={r} onClick={() => onRangeChange(r)}
                        className={cn("text-[6px] lg:text-[7px] px-0.5 lg:px-1 py-0.5 rounded cursor-pointer transition-all font-bold",
                            tempoRange === r ? "text-black" : "text-white/15 hover:text-white/30 bg-white/[0.03]"
                        )}
                        style={tempoRange === r ? { backgroundColor: color } : undefined}>
                        ±{r}
                    </button>
                ))}
            </div>

            {/* Vertical slider track */}
            <div className="relative flex items-stretch gap-1 flex-1">
                <div
                    ref={trackRef}
                    className="relative w-2 rounded-full cursor-pointer select-none min-h-[60px]"
                    style={{ height: undefined }}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                >
                    {/* Track background with groove marks */}
                    <div className="absolute inset-0 rounded-full bg-white/[0.06] border border-white/[0.08]" />

                    {/* Center line (original BPM) */}
                    <div className="absolute left-0 right-0 top-1/2 -translate-y-px h-0.5 bg-white/20 rounded-full" />

                    {/* Deviation indicator (from center) */}
                    {Math.abs(pctChange) > 0.2 && (
                        <div
                            className="absolute left-0 right-0 rounded-full transition-all duration-75"
                            style={{
                                backgroundColor: `${color}60`,
                                top: pctChange > 0 ? `${normalized * 100}%` : "50%",
                                height: `${Math.abs(normalized - 0.5) * 100}%`,
                            }}
                        />
                    )}

                    {/* Fader thumb */}
                    <div
                        className="absolute left-1/2 -translate-x-1/2 w-5 h-3 rounded-sm border shadow-md transition-[top] duration-75"
                        style={{
                            top: `calc(${normalized * 100}% - 6px)`,
                            backgroundColor: Math.abs(pctChange) > 0.2 ? color : "rgba(255,255,255,0.85)",
                            borderColor: Math.abs(pctChange) > 0.2 ? `${color}80` : "rgba(255,255,255,0.3)",
                        }}
                    >
                        <div className="absolute inset-x-1 top-1/2 -translate-y-1/2 h-px bg-black/30" />
                    </div>

                    {/* Scale ticks */}
                    {[-1, -0.5, 0, 0.5, 1].map(t => (
                        <div key={t} className="absolute -right-1.5 w-1 h-px bg-white/15" style={{ top: `${(0.5 - t * 0.5) * 100}%` }} />
                    ))}
                </div>

                {/* BPM display */}
                <div className="flex flex-col items-center gap-0.5 min-w-[32px]">
                    <span className="text-[10px] lg:text-[11px] xl:text-xs font-bold tabular-nums leading-none" style={{ color }}>
                        {value.toFixed(1)}
                    </span>
                    <span className={cn("text-[7px] lg:text-[8px] tabular-nums font-bold",
                        Math.abs(pctChange) < 0.1 ? "text-white/20" : pctChange > 0 ? "text-green-400/60" : "text-red-400/60"
                    )}>
                        {pctChange >= 0 ? "+" : ""}{pctChange.toFixed(1)}%
                    </span>
                </div>
            </div>

            {/* Sync + Reset */}
            <div className="flex items-center gap-0.5">
                <button onClick={onSync}
                    className={cn("text-[7px] lg:text-[8px] font-bold px-1.5 py-0.5 rounded cursor-pointer transition-all border",
                        isSynced ? "bg-yellow-500/30 text-yellow-300 border-yellow-500/30" : "bg-yellow-500/15 text-yellow-400/70 hover:bg-yellow-500/25 border-yellow-500/20"
                    )}>Sync</button>
                <button onClick={() => onChange(originalBpm)}
                    className="text-[7px] lg:text-[8px] text-white/15 hover:text-white/35 cursor-pointer px-1 py-0.5 rounded hover:bg-white/5">0%</button>
            </div>
        </div>
    );
});

// ─── Color FX Link Switch ────────────────────────────────────────────────

type ColorFxTarget = "A" | "B" | "LINK";

function ColorFxLinkSwitch({ value, onChange }: { value: ColorFxTarget; onChange: (v: ColorFxTarget) => void }) {
    const options: ColorFxTarget[] = ["A", "LINK", "B"];
    return (
        <div className="flex flex-col items-center gap-1">
            <span className="text-[7px] lg:text-[8px] uppercase tracking-wider text-white/15">Color FX</span>
            <div className="relative flex items-center bg-white/[0.04] rounded-full border border-white/[0.08] p-0.5">
                {/* Sliding indicator */}
                <div
                    className="absolute h-[calc(100%-4px)] rounded-full transition-all duration-200 ease-out"
                    style={{
                        width: `${100 / 3}%`,
                        left: `calc(${options.indexOf(value) * (100 / 3)}% + 2px)`,
                        backgroundColor: value === "A" ? "rgba(168,85,247,0.25)" : value === "B" ? "rgba(59,130,246,0.25)" : "rgba(236,72,153,0.25)",
                        border: `1px solid ${value === "A" ? "rgba(168,85,247,0.3)" : value === "B" ? "rgba(59,130,246,0.3)" : "rgba(236,72,153,0.3)"}`,
                    }}
                />
                {options.map(opt => (
                    <button
                        key={opt}
                        onClick={() => onChange(opt)}
                        className={cn(
                            "relative z-10 px-1.5 lg:px-2 py-0.5 text-[7px] lg:text-[8px] font-bold uppercase cursor-pointer transition-colors rounded-full",
                            value === opt
                                ? opt === "A" ? "text-purple-300" : opt === "B" ? "text-blue-300" : "text-pink-300"
                                : "text-white/20 hover:text-white/40"
                        )}
                    >
                        {opt === "LINK" ? <Link2 className="h-2.5 w-2.5 lg:h-3 lg:w-3 inline" /> : opt}
                    </button>
                ))}
            </div>
        </div>
    );
}

// ─── Deck Info (Header + Track + Details + Time) ─────────────────────────

const DeckInfo = memo(function DeckInfo({ side, deck, color, track, onBrowse }: { side: DeckSide; deck: DeckState; color: string; track: Track | null; onBrowse?: () => void }) {
    const mixer = useMixerActions();
    const { noteNotations } = useDAWSettings();
    const [pickerOpen, setPickerOpen] = useState(false);
    const currentTime = useDeckCurrentTime(side);

    const trackCard = (
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-1.5 lg:p-2 xl:p-2.5 min-h-[48px]">
            {deck.trackId ? (
                <div className="flex flex-col gap-1 lg:gap-1.5">
                    <div className="flex items-center gap-2">
                        {deck.trackArtworkUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- dynamic blob/data/remote artwork; next/image cannot optimise unknown remotes
                            <img src={deck.trackArtworkUrl} alt="" className="w-8 h-8 lg:w-10 lg:h-10 xl:w-12 xl:h-12 rounded object-cover shrink-0" />
                        ) : (
                            <div className="w-8 h-8 lg:w-10 lg:h-10 xl:w-12 xl:h-12 rounded bg-white/10 shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                            <p className="text-[11px] lg:text-xs xl:text-sm font-medium truncate">{deck.trackTitle}</p>
                            <p className="text-[9px] lg:text-[10px] xl:text-xs text-white/35 truncate">{deck.trackArtist}</p>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                        {deck.bpm > 0 && (
                            <span className="text-[8px] lg:text-[9px] xl:text-[10px] px-1 py-0.5 rounded-full bg-white/8 text-white/50 tabular-nums">
                                {deck.bpm.toFixed(1)} BPM
                            </span>
                        )}
                        {deck.key && (
                            <span className="text-[8px] lg:text-[9px] xl:text-[10px] px-1 py-0.5 rounded-full bg-white/8 text-white/50">{formatKey(deck.key, noteNotations)}</span>
                        )}
                        {track?.genre && (
                            <span className="text-[8px] lg:text-[9px] xl:text-[10px] px-1 py-0.5 rounded-full text-purple-300/70" style={{ backgroundColor: `${color}15` }}>{track.genre}</span>
                        )}
                        {track?.format && (
                            <span className="text-[8px] lg:text-[9px] xl:text-[10px] px-1 py-0.5 rounded-full bg-white/5 text-white/25 uppercase">{track.format}</span>
                        )}
                        {track?.duration != null && (
                            <span className="text-[8px] lg:text-[9px] xl:text-[10px] px-1 py-0.5 rounded-full bg-white/5 text-white/25 tabular-nums">{formatDuration(track.duration)}</span>
                        )}
                    </div>
                </div>
            ) : (
                <button onClick={() => setPickerOpen(true)}
                    className="flex items-center justify-center h-9 w-full text-[11px] lg:text-xs text-white/20 hover:text-white/40 hover:bg-white/[0.03] rounded transition-colors cursor-pointer">
                    Load a track to Deck {side}
                </button>
            )}
        </div>
    );

    return (
        <div className="flex-1 flex flex-col gap-1 lg:gap-1.5 min-w-0">
            <DeckTrackPicker side={side} open={pickerOpen} onClose={() => setPickerOpen(false)} />
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 lg:gap-2">
                    <span className="text-[9px] lg:text-[10px] xl:text-xs font-bold px-1.5 lg:px-2 py-0.5 rounded" style={{ backgroundColor: color, color: "#000" }}>{side}</span>
                    <span className="text-[8px] lg:text-[9px] xl:text-[10px] text-white/25 uppercase tracking-wider">Deck {side}</span>
                </div>
                <div className="flex items-center gap-1">
                    <button onClick={onBrowse}
                        className="text-[8px] lg:text-[9px] xl:text-[10px] uppercase font-bold px-2 py-1 rounded hover:bg-white/10 text-white/30 hover:text-white/60 transition-colors cursor-pointer">Load</button>
                    <button onClick={() => mixer.ejectTrack(side)}
                        className="p-1 rounded hover:bg-white/10 text-white/25 hover:text-white/50 transition-colors cursor-pointer"><Power className="h-3 w-3 lg:h-3.5 lg:w-3.5" /></button>
                </div>
            </div>
            {track && deck.trackId ? (
                <TrackContextMenu track={track} hideDeckActions onMutate={() => { }}>{trackCard}</TrackContextMenu>
            ) : trackCard}
            <div className="flex items-center justify-between px-0.5">
                <span className="text-[10px] lg:text-[11px] xl:text-xs tabular-nums text-white/50 font-mono">{formatTime(currentTime)}</span>
                <span className="text-[10px] lg:text-[11px] xl:text-xs tabular-nums text-white/25 font-mono">{formatTimeRemaining(currentTime, deck.duration)}</span>
            </div>
        </div>
    );
});

// ─── Deck Stems Panel ────────────────────────────────────────────────────

const STEM_ICON_MAP: Record<StemType, typeof Mic> = {
    vocals: Mic,
    drums: Drum,
    bass: Music2,
    melody: Piano,
};

const DeckStemsPanel = memo(function DeckStemsPanel({
    processor,
    color,
}: {
    processor: RealtimeStemProcessor | null;
    color: string;
}) {
    const [, forceRender] = useReducer((x: number) => x + 1, 0);
    const levelsRef = useRef<Record<StemType, number>>({ vocals: 0, drums: 0, bass: 0, melody: 0 });
    // Refs to each stem's level-overlay DOM element so we can mutate
    // `style.width` directly in the RAF loop (no React renders 60–120×/s).
    const levelOverlayRefs = useRef<Record<StemType, HTMLDivElement | null>>({
        vocals: null, drums: null, bass: null, melody: null,
    });

    const isActive = processor?.isActive ?? false;
    const configs = processor?.configs ?? createDefaultStemConfigs();
    const configsRef = useRef(configs);
    useEffect(() => { configsRef.current = configs; });

    // Animate levels when active. We deliberately avoid `setState` here —
    // every frame we'd otherwise re-render the entire panel, capping the
    // mixer at ~30 fps. Instead we mutate the bar widths via refs.
    useEffect(() => {
        if (!processor?.isActive) {
            // Reset bars when inactive.
            for (const stem of STEM_TYPES) {
                const el = levelOverlayRefs.current[stem];
                if (el) el.style.width = "0%";
                levelsRef.current[stem] = 0;
            }
            return;
        }
        const update = () => {
            for (const stem of STEM_TYPES) {
                const analyser = processor.getAnalyser(stem);
                if (!analyser) continue;
                // Shared time-domain read: re-uses the cached buffer if any
                // other consumer already pulled this analyser this frame.
                const data = getSharedTimeDomainData(analyser);
                let max = 0;
                for (let i = 0; i < data.length; i++) { const abs = Math.abs(data[i]); if (abs > max) max = abs; }
                levelsRef.current[stem] = max;
                const cfg = configsRef.current.find(c => c.type === stem);
                const eff = cfg && !cfg.muted ? max * cfg.volume : 0;
                const el = levelOverlayRefs.current[stem];
                if (el) el.style.width = `${eff * 100}%`;
            }
        };
        // Stem level meters at 30 fps — visually indistinguishable, half cost.
        return subscribeRaf(update, { fps: 30 });
    }, [processor, processor?.isActive]);

    // Dragging state for horizontal faders
    const draggingRef = useRef<StemType | null>(null);

    const handlePointerDown = useCallback((stem: StemType, e: React.PointerEvent) => {
        e.preventDefault();
        draggingRef.current = stem;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        updateVolume(stem, e);
    }, [processor]);

    const handlePointerMove = useCallback((stem: StemType, e: React.PointerEvent) => {
        if (draggingRef.current !== stem) return;
        updateVolume(stem, e);
    }, [processor]);

    const handlePointerUp = useCallback(() => {
        draggingRef.current = null;
    }, []);

    const updateVolume = useCallback((stem: StemType, e: React.PointerEvent) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        processor?.setStemVolume(stem, x);
        forceRender();
    }, [processor]);

    if (!processor) return null;

    return (
        <div className={cn(
            "rounded-lg border transition-all duration-300",
            isActive
                ? "border-purple-500/30 bg-purple-950/20"
                : "border-white/[0.06] bg-white/[0.03]",
        )}>
            {/* Header */}
            <div className="flex items-center justify-between px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                    <button
                        onClick={() => { processor.toggle(); forceRender(); }}
                        className={cn(
                            "flex items-center justify-center w-6 h-6 rounded-md transition-all duration-200 cursor-pointer",
                            isActive
                                ? "bg-purple-500/25 text-purple-400 shadow-[0_0_8px_rgba(168,85,247,0.25)]"
                                : "bg-white/5 text-white/30 hover:bg-white/10 hover:text-white/50",
                        )}
                    >
                        <Power className="w-3 h-3" />
                    </button>
                    <span className="text-[8px] lg:text-[9px] uppercase tracking-wider font-semibold text-white/25">
                        Stems
                    </span>
                    {isActive && (
                        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-purple-500/15 text-[8px] font-medium text-purple-400 animate-[fadeIn_200ms_ease-out]">
                            <span className="w-1 h-1 rounded-full bg-purple-400 animate-pulse" />
                            Live
                        </span>
                    )}
                </div>
            </div>

            {/* Stem controls — 4 rows, each stem a horizontal strip */}
            {isActive && (
                <div className="px-2 pb-2 flex flex-col gap-1 animate-[fadeIn_200ms_ease-out]">
                    {STEM_TYPES.map((stemType) => {
                        const config = configs.find(c => c.type === stemType);
                        if (!config) return null;
                        const Icon = STEM_ICON_MAP[stemType];
                        const stemColor = STEM_COLORS[stemType];
                        const stemActive = !config.muted && config.volume > 0;
                        const isSoloed = config.solo;

                        return (
                            <div key={stemType} className="flex items-center gap-1.5">
                                {/* Icon */}
                                <div className={cn(
                                    "flex items-center justify-center w-5 h-5 rounded shrink-0 transition-all",
                                    stemActive ? "bg-white/10" : "bg-white/5 opacity-40",
                                )}>
                                    <Icon className="w-2.5 h-2.5" style={{ color: stemActive ? stemColor : undefined }} />
                                </div>

                                {/* Horizontal volume fader */}
                                <div
                                    className="relative flex-1 h-4 rounded-full bg-white/[0.04] cursor-pointer overflow-hidden select-none"
                                    onPointerDown={(e) => handlePointerDown(stemType, e)}
                                    onPointerMove={(e) => handlePointerMove(stemType, e)}
                                    onPointerUp={handlePointerUp}
                                    onDoubleClick={() => { processor.setStemVolume(stemType, 1); forceRender(); }}
                                    title={`${STEM_LABELS[stemType]}: ${Math.round(config.volume * 100)}%`}
                                >
                                    {/* Volume fill */}
                                    <div
                                        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-75"
                                        style={{
                                            width: `${config.volume * 100}%`,
                                            background: `linear-gradient(to right, ${stemColor}30, ${stemColor}60)`,
                                        }}
                                    />
                                    {/* Level overlay (mutated directly via ref every RAF tick) */}
                                    <div
                                        ref={el => { levelOverlayRefs.current[stemType] = el; }}
                                        className="absolute inset-y-0 left-0 rounded-full pointer-events-none"
                                        style={{
                                            width: "0%",
                                            background: `${stemColor}20`,
                                        }}
                                    />
                                    {/* Thumb */}
                                    <div
                                        className="absolute top-1/2 -translate-y-1/2 w-1.5 h-3 rounded-full bg-white shadow-sm transition-[left] duration-75"
                                        style={{ left: `calc(${config.volume * 100}% - 3px)` }}
                                    />
                                    {/* Label inside */}
                                    <span className="absolute inset-0 flex items-center px-1.5 text-[7px] lg:text-[8px] font-medium tracking-wide text-white/40 pointer-events-none">
                                        {STEM_LABELS[stemType]}
                                    </span>
                                    {/* Percentage */}
                                    <span className="absolute inset-0 flex items-center justify-end px-1.5 text-[7px] tabular-nums text-white/25 pointer-events-none">
                                        {Math.round(config.volume * 100)}
                                    </span>
                                </div>

                                {/* Mute */}
                                <button
                                    onClick={() => { processor.toggleStemMute(stemType); forceRender(); }}
                                    className={cn(
                                        "flex items-center justify-center w-5 h-5 rounded shrink-0 transition-all cursor-pointer",
                                        config.muted
                                            ? "bg-red-500/20 text-red-400"
                                            : "bg-white/5 text-white/25 hover:bg-white/10 hover:text-white/40",
                                    )}
                                    title={config.muted ? "Unmute" : "Mute"}
                                >
                                    {config.muted ? <VolumeX className="w-2.5 h-2.5" /> : <Volume2 className="w-2.5 h-2.5" />}
                                </button>

                                {/* Solo */}
                                <button
                                    onClick={() => { processor.toggleStemSolo(stemType); forceRender(); }}
                                    className={cn(
                                        "flex items-center justify-center w-5 h-5 rounded shrink-0 text-[8px] font-bold transition-all cursor-pointer",
                                        isSoloed
                                            ? "text-amber-400"
                                            : "bg-white/5 text-white/25 hover:bg-white/10 hover:text-white/40",
                                    )}
                                    style={isSoloed ? { backgroundColor: `${stemColor}30` } : undefined}
                                    title={isSoloed ? "Unsolo" : "Solo"}
                                >
                                    S
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
});

// ─── Deck Controls (Transport + BPM/Key + EQ + etc) ──────────────────────

const DeckControls = memo(function DeckControls({ side, deck, color, analyser }: DeckProps) {
    const mixer = useMixer();
    const { noteNotations } = useDAWSettings();
    const currentTime = useDeckCurrentTime(side);
    const [shiftActive, setShiftActive] = useState(false);
    const [shiftLocked, setShiftLocked] = useState(false);
    const [samplePickerSlot, setSamplePickerSlot] = useState<number | null>(null);
    const loopBeatsMain = [1, 2, 4, 8, 16];
    const loopBeatsPad = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
    const beatJumpSizes = [1, 2, 4, 8, 16, 32];

    // Vinyl brake animation
    const brakeRef = useRef<number>(0);
    const [isBraking, setIsBraking] = useState(false);

    const vinylBrake = useCallback(() => {
        if (!deck.isPlaying || isBraking) return;
        setIsBraking(true);
        const startBpm = deck.bpm;
        const startTime = performance.now();
        const duration = 1200;
        const animate = (now: number) => {
            const elapsed = now - startTime;
            const progress = Math.min(1, elapsed / duration);
            const factor = 1 - progress * progress;
            mixer.setBpm(side, Math.max(0.1, startBpm * factor));
            if (progress < 1) {
                brakeRef.current = requestAnimationFrame(animate);
            } else {
                mixer.pause(side);
                mixer.setBpm(side, startBpm);
                setIsBraking(false);
            }
        };
        brakeRef.current = requestAnimationFrame(animate);
    }, [deck.isPlaying, deck.bpm, isBraking, mixer, side]);

    useEffect(() => {
        return () => { if (brakeRef.current) cancelAnimationFrame(brakeRef.current); };
    }, []);

    // Listen to keyboard Shift key (hold-to-activate, respects lock)
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Shift" && !shiftLocked) setShiftActive(true); };
        const onKeyUp = (e: KeyboardEvent) => { if (e.key === "Shift" && !shiftLocked) setShiftActive(false); };
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
    }, [shiftLocked]);

    // Listen for MIDI vinyl brake events
    useEffect(() => {
        const onBrake = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.deck === side) vinylBrake();
        };
        window.addEventListener("mixer-vinyl-brake", onBrake);
        return () => window.removeEventListener("mixer-vinyl-brake", onBrake);
    }, [side, vinylBrake]);

    const sectionCls = "rounded-lg bg-white/[0.03] border border-white/[0.06] p-1.5 lg:p-2 xl:p-2.5";
    const labelCls = "text-[8px] lg:text-[9px] xl:text-[10px] uppercase tracking-wider text-white/25";
    const toggleCls = "text-[7px] lg:text-[8px] xl:text-[9px] uppercase font-bold px-1 lg:px-1.5 py-0.5 rounded transition-all cursor-pointer";
    const btnCls = "text-[7px] lg:text-[8px] xl:text-[9px] font-bold py-1 lg:py-1.5 rounded transition-all cursor-pointer";
    const iconSm = "h-3 w-3 lg:h-3.5 lg:w-3.5 xl:h-4 xl:w-4";
    const iconXs = "h-2.5 w-2.5 lg:h-3 lg:w-3";

    // Shifted pad mode labels
    const padModeLabel = (mode: PadMode) => {
        if (shiftActive) {
            if (mode === "hotcue") return "Del Cue";
            if (mode === "beatloop") return "Manual LP";
            if (mode === "beatjump") return "Beat Jump";
            if (mode === "sampler") return "Clr Samp";
        }
        if (mode === "hotcue") return "Hot Cue";
        if (mode === "beatloop") return "Beat Loop";
        if (mode === "beatjump") return "Beat Jump";
        return "Sampler";
    };

    return (
        <>
            <div className="flex flex-col gap-1.5 lg:gap-2 w-full">
                {/* Row 1: Jog + Tempo + Key */}
                <div className="flex items-stretch gap-2 lg:gap-3">
                    <div className="flex items-center shrink-0">
                        <JogWheel side={side} deck={deck} color={color} />
                    </div>
                    {/* Tempo Fader (vertical pitch slider) */}
                    <TempoFader
                        value={deck.bpm}
                        originalBpm={deck.originalBpm}
                        tempoRange={mixer.tempoRange}
                        onChange={(bpm) => mixer.setBpm(side, bpm)}
                        onRangeChange={(range) => mixer.setTempoRange(range)}
                        onSync={() => mixer.syncBpm(side)}
                        color={color}
                        isSynced={deck.bpm !== deck.originalBpm}
                    />
                    {/* Key + Pitch Bend + Loop */}
                    <div className="flex-1 flex flex-col gap-1.5 lg:gap-2 min-w-0">
                        <div className="grid grid-cols-2 gap-1.5">
                            {/* Key control */}
                            <div className={sectionCls}>
                                <div className="flex items-center justify-between mb-0.5">
                                    <span className={labelCls}>Key {deck.keyLock && <Lock className="h-2 w-2 inline text-emerald-400/60" />}</span>
                                    <button onClick={() => mixer.setKeyShift(side, 0)} className="text-[7px] lg:text-[8px] text-white/15 hover:text-white/35 cursor-pointer">Reset</button>
                                </div>
                                <div className="flex items-center gap-0.5">
                                    <button onClick={() => mixer.setKeyShift(side, deck.keyShift - 1)} className="p-0.5 rounded hover:bg-white/10 text-white/30 hover:text-white cursor-pointer"><ChevronLeft className={iconSm} /></button>
                                    <span className="flex-1 text-center text-sm lg:text-base xl:text-lg font-bold tabular-nums" style={{ color }}>{formatKey(deck.key, noteNotations) || "—"}</span>
                                    <button onClick={() => mixer.setKeyShift(side, deck.keyShift + 1)} className="p-0.5 rounded hover:bg-white/10 text-white/30 hover:text-white cursor-pointer"><ChevronRight className={iconSm} /></button>
                                </div>
                            </div>
                            {/* Pitch Bend */}
                            <div className={sectionCls}>
                                <span className={cn(labelCls, "block mb-1")}>Pitch Bend</span>
                                <div className="flex items-center justify-center gap-0.5 lg:gap-1">
                                    <button onPointerDown={() => mixer.nudge(side, -80)} onPointerUp={() => mixer.nudgeRelease(side)} onPointerLeave={() => mixer.nudgeRelease(side)} className="p-1 lg:p-1.5 rounded hover:bg-white/10 text-white/30 hover:text-white cursor-pointer active:bg-white/15 select-none"><ChevronsLeft className={iconSm} /></button>
                                    <button onPointerDown={() => mixer.nudge(side, -30)} onPointerUp={() => mixer.nudgeRelease(side)} onPointerLeave={() => mixer.nudgeRelease(side)} className="p-1 lg:p-1.5 rounded hover:bg-white/10 text-white/30 hover:text-white cursor-pointer active:bg-white/15 select-none"><ChevronLeft className={iconSm} /></button>
                                    <span className="text-[8px] lg:text-[9px] text-white/15 px-0.5">Bend</span>
                                    <button onPointerDown={() => mixer.nudge(side, 30)} onPointerUp={() => mixer.nudgeRelease(side)} onPointerLeave={() => mixer.nudgeRelease(side)} className="p-1 lg:p-1.5 rounded hover:bg-white/10 text-white/30 hover:text-white cursor-pointer active:bg-white/15 select-none"><ChevronRight className={iconSm} /></button>
                                    <button onPointerDown={() => mixer.nudge(side, 80)} onPointerUp={() => mixer.nudgeRelease(side)} onPointerLeave={() => mixer.nudgeRelease(side)} className="p-1 lg:p-1.5 rounded hover:bg-white/10 text-white/30 hover:text-white cursor-pointer active:bg-white/15 select-none"><ChevronsRight className={iconSm} /></button>
                                </div>
                            </div>
                        </div>
                        {/* Sync & Match + Beat Grid */}
                        <div className="grid grid-cols-2 gap-1.5">
                            {(() => {
                                const other = side === "A" ? mixer.deckB : mixer.deckA;
                                const bpmDelta = other.bpm > 0 && deck.bpm > 0 ? deck.bpm - other.bpm : null;
                                const bpmMatched = bpmDelta !== null && Math.abs(bpmDelta) < 0.1;
                                const keyCompat = (() => {
                                    if (!deck.key || !other.key) return null;
                                    if (deck.key === other.key) return "perfect";
                                    const camelot: Record<string, string> = {
                                        "1A": "1A", "1B": "1B", "2A": "2A", "2B": "2B", "3A": "3A", "3B": "3B",
                                        "4A": "4A", "4B": "4B", "5A": "5A", "5B": "5B", "6A": "6A", "6B": "6B",
                                        "7A": "7A", "7B": "7B", "8A": "8A", "8B": "8B", "9A": "9A", "9B": "9B",
                                        "10A": "10A", "10B": "10B", "11A": "11A", "11B": "11B", "12A": "12A", "12B": "12B",
                                    };
                                    const dKey = deck.key.replace(/[^0-9A-B]/gi, "").toUpperCase();
                                    const oKey = other.key.replace(/[^0-9A-B]/gi, "").toUpperCase();
                                    if (!camelot[dKey] || !camelot[oKey]) return "unknown";
                                    const dNum = parseInt(dKey); const oNum = parseInt(oKey);
                                    const dMode = dKey.slice(-1); const oMode = oKey.slice(-1);
                                    if (dNum === oNum && dMode !== oMode) return "harmonic";
                                    if (dMode === oMode && (Math.abs(dNum - oNum) === 1 || Math.abs(dNum - oNum) === 11)) return "harmonic";
                                    return "clash";
                                })();
                                const remaining = deck.duration > 0 ? deck.duration - currentTime : 0;
                                const pct = deck.duration > 0 ? (currentTime / deck.duration) * 100 : 0;
                                return (
                                    <div className={sectionCls}>
                                        <div className="flex items-center justify-between mb-1">
                                            <span className={cn(labelCls, "flex items-center gap-1")}><Target className={iconXs} /> Sync & Match</span>
                                            <button onClick={() => mixer.syncBpm(side)} className={cn(toggleCls, bpmMatched ? "bg-emerald-500/25 text-emerald-400" : "text-white/20 hover:text-white/40")}>Sync</button>
                                        </div>
                                        <div className="flex items-center justify-between gap-1 mb-1">
                                            <span className="text-[7px] lg:text-[8px] text-white/25">BPM Δ</span>
                                            {bpmDelta !== null ? (
                                                <span className={cn("text-[9px] lg:text-[10px] font-bold tabular-nums", bpmMatched ? "text-emerald-400" : Math.abs(bpmDelta) < 2 ? "text-amber-400" : "text-rose-400")}>
                                                    {bpmMatched ? "MATCHED" : `${bpmDelta > 0 ? "+" : ""}${bpmDelta.toFixed(1)}`}
                                                </span>
                                            ) : <span className="text-[9px] text-white/15">—</span>}
                                        </div>
                                        <div className="flex items-center justify-between gap-1 mb-1">
                                            <span className="text-[7px] lg:text-[8px] text-white/25">Key</span>
                                            <span className={cn("text-[9px] lg:text-[10px] font-bold",
                                                keyCompat === "perfect" ? "text-emerald-400" :
                                                    keyCompat === "harmonic" ? "text-sky-400" :
                                                        keyCompat === "clash" ? "text-rose-400/60" : "text-white/15"
                                            )}>
                                                {keyCompat === "perfect" ? "✓ Perfect" : keyCompat === "harmonic" ? "♪ Harmonic" : keyCompat === "clash" ? "✗ Clash" : "—"}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <div className="flex-1 h-1 rounded-full bg-white/[0.06] overflow-hidden">
                                                <div className={cn("h-full rounded-full transition-all", pct > 85 ? "bg-rose-500/60" : pct > 50 ? "bg-amber-500/40" : "bg-white/15")} style={{ width: `${pct}%` }} />
                                            </div>
                                            <span className={cn("text-[8px] tabular-nums", remaining < 30 ? "text-rose-400" : "text-white/25")}>{remaining > 0 ? `-${Math.floor(remaining / 60)}:${String(Math.floor(remaining % 60)).padStart(2, "0")}` : "—"}</span>
                                        </div>
                                    </div>
                                );
                            })()}
                            <div className={sectionCls}>
                                <div className="flex items-center justify-between mb-1">
                                    <span className={cn(labelCls, "flex items-center gap-1")}><Grid3X3 className={iconXs} /> Beat Grid</span>
                                    <button onClick={() => mixer.setBeatGrid(side, { isLocked: !deck.beatGrid.isLocked })} className={cn(toggleCls, "flex items-center gap-0.5", deck.beatGrid.isLocked ? "bg-amber-500/25 text-amber-400" : "text-white/20 hover:text-white/40")}><Lock className="h-2 w-2" />{deck.beatGrid.isLocked ? "Locked" : "Lock"}</button>
                                </div>
                                <div className="flex items-center justify-center gap-0.5 lg:gap-1">
                                    <button onClick={() => mixer.nudgeBeatGrid(side, "left")} disabled={deck.beatGrid.isLocked} className={cn(btnCls, "px-1.5 bg-white/5 hover:bg-white/10 text-white/30 disabled:opacity-30")}>◀</button>
                                    <span className="text-[8px] lg:text-[9px] tabular-nums text-white/40 px-1">{deck.beatGrid.offset >= 0 ? "+" : ""}{(deck.beatGrid.offset * 1000).toFixed(1)}ms</span>
                                    <button onClick={() => mixer.nudgeBeatGrid(side, "right")} disabled={deck.beatGrid.isLocked} className={cn(btnCls, "px-1.5 bg-white/5 hover:bg-white/10 text-white/30 disabled:opacity-30")}>▶</button>
                                    <button onClick={() => mixer.setBeatGrid(side, { offset: 0 })} disabled={deck.beatGrid.isLocked} className={cn(btnCls, "px-1 bg-white/5 hover:bg-white/10 text-white/20 disabled:opacity-30")}>Reset</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Transport buttons */}
                <div className="flex items-center gap-1 lg:gap-1.5 flex-wrap justify-between">
                    {/* SHIFT toggle */}
                    <button
                        onMouseDown={() => { if (!shiftLocked) setShiftActive(true); }}
                        onMouseUp={() => { if (!shiftLocked) setShiftActive(false); }}
                        onMouseLeave={() => { if (!shiftLocked) setShiftActive(false); }}
                        onDoubleClick={() => { setShiftLocked(l => { const next = !l; setShiftActive(next); return next; }); }}
                        className={cn(
                            "relative px-2 lg:px-2.5 py-1.5 lg:py-2 xl:py-2.5 rounded-lg font-extrabold text-[9px] lg:text-[10px] xl:text-xs uppercase tracking-wider transition-all cursor-pointer border select-none",
                            shiftLocked
                                ? "bg-amber-500/30 border-amber-500/50 text-amber-200 shadow-[0_0_16px_rgba(245,158,11,0.35),inset_0_1px_0_rgba(255,255,255,0.15)] ring-1 ring-amber-500/40"
                                : shiftActive
                                    ? "bg-amber-500/20 border-amber-500/40 text-amber-300 shadow-[0_0_12px_rgba(245,158,11,0.25),inset_0_1px_0_rgba(255,255,255,0.1)]"
                                    : "bg-gradient-to-b from-white/[0.06] to-white/[0.01] border-white/[0.08] hover:border-white/[0.15] text-white/40 hover:text-white/60 shadow-[0_2px_6px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.05)]",
                            "active:scale-95"
                        )}
                        title={shiftLocked ? "Shift LOCKED — double-click to unlock" : "Hold for Shift · double-click to lock"}
                    >
                        <ArrowBigUp className="h-3.5 w-3.5 lg:h-4 lg:w-4 xl:h-5 xl:w-5" />
                        {shiftLocked && <div className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />}
                    </button>

                    {/* CUE button */}
                    <button onClick={() => {
                        if (shiftActive) {
                            // SHIFT+CUE: Set cue point at current position (no seek)
                        } else {
                            // CUE: Jump to cue / start and pause
                            mixer.seek(side, 0); mixer.pause(side);
                        }
                    }}
                        className={cn(
                            "relative px-3 lg:px-4 xl:px-5 py-1.5 lg:py-2 xl:py-2.5 rounded-lg font-extrabold text-[10px] lg:text-xs xl:text-sm uppercase tracking-wider transition-all cursor-pointer border",
                            shiftActive
                                ? "bg-gradient-to-b from-amber-500/15 to-amber-500/5 border-amber-500/30 text-amber-300 shadow-[0_2px_8px_rgba(245,158,11,0.15),inset_0_1px_0_rgba(255,255,255,0.08)]"
                                : "bg-gradient-to-b from-white/[0.08] to-white/[0.02] border-white/[0.1] hover:border-white/[0.2] text-white/70 hover:text-white shadow-[0_2px_8px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.08)]",
                            "active:scale-95 active:brightness-125"
                        )}>
                        {shiftActive ? "SET" : "CUE"}
                    </button>

                    {/* PLAY / PAUSE */}
                    <button onClick={() => {
                        if (shiftActive) {
                            mixer.seek(side, 0);
                            mixer.play(side);
                        } else {
                            mixer.togglePlay(side);
                        }
                    }}
                        className={cn(
                            "relative p-2.5 lg:p-3 xl:p-3.5 rounded-xl transition-all cursor-pointer border",
                            deck.isPlaying
                                ? "border-transparent shadow-[0_2px_20px_var(--glow)] active:scale-95"
                                : "bg-gradient-to-b from-white/[0.08] to-white/[0.02] border-white/[0.1] hover:border-white/[0.2] shadow-[0_2px_8px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.08)] text-white hover:brightness-125 active:scale-95"
                        )}
                        style={{
                            ...(deck.isPlaying ? {
                                backgroundColor: color,
                                color: "black",
                                "--glow": `${color}40`,
                            } as React.CSSProperties : {}),
                        }}>
                        {deck.isPlaying
                            ? <Pause className="h-4 w-4 lg:h-5 lg:w-5 xl:h-6 xl:w-6" />
                            : <Play className="h-4 w-4 lg:h-5 lg:w-5 xl:h-6 xl:w-6 ml-0.5" />}
                    </button>

                    {/* Vinyl Brake */}
                    <button onClick={vinylBrake}
                        disabled={!deck.isPlaying}
                        className={cn(
                            "relative px-2 lg:px-2.5 py-1.5 lg:py-2 xl:py-2.5 rounded-lg font-bold text-[8px] lg:text-[9px] xl:text-[10px] uppercase tracking-wider transition-all cursor-pointer border select-none",
                            isBraking
                                ? "bg-red-500/20 border-red-500/40 text-red-300 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.2)]"
                                : "bg-gradient-to-b from-white/[0.05] to-white/[0.01] border-white/[0.08] text-white/30 hover:text-white/50 hover:border-white/[0.15] shadow-[0_2px_4px_rgba(0,0,0,0.2)]",
                            !deck.isPlaying && "opacity-30 pointer-events-none"
                        )}
                        title="Vinyl Brake — gradually slow down and stop">
                        <Square className="h-3 w-3 lg:h-3.5 lg:w-3.5 fill-current" />
                    </button>

                    <div className="hidden sm:block w-px h-5 bg-white/[0.06]" />

                    {/* Beat Indicator */}
                    <BeatIndicator deck={deck} color={color} />

                    <div className="hidden sm:block w-px h-4 bg-white/[0.06]" />

                    {/* Toggle buttons */}
                    <div className="flex items-center gap-0.5 flex-wrap">
                        <button onClick={() => mixer.toggleQuantize(side)} className={cn("flex items-center gap-0.5", toggleCls, deck.quantize ? "bg-orange-500/25 text-orange-400" : "text-white/20 hover:text-white/40")}><Magnet className={iconXs} />Q</button>
                        <button onClick={() => mixer.toggleSlipMode(side)} className={cn("flex items-center gap-0.5", toggleCls, deck.slipMode ? "bg-cyan-500/25 text-cyan-400" : "text-white/20 hover:text-white/40")}><Layers className={iconXs} />Slip</button>
                        <button onClick={() => mixer.setKeyLock(side, !deck.keyLock)} className={cn("flex items-center gap-0.5", toggleCls, deck.keyLock ? "bg-emerald-500/25 text-emerald-400" : "text-white/20 hover:text-white/40")}><Lock className={iconXs} />Key</button>
                        <button onClick={() => mixer.toggleHeadphoneCue(side)} className={cn("flex items-center gap-0.5", toggleCls, deck.headphoneCue ? "bg-blue-500/25 text-blue-400" : "text-white/20 hover:text-white/40")}><Headphones className={iconXs} />Cue</button>
                    </div>
                </div>

                {/* Beat FX + Loop */}
                <div className="grid grid-cols-2 gap-1.5">
                    <div className={sectionCls}>
                        <div className="flex items-center justify-between mb-1">
                            <span className={labelCls}>Beat FX</span>
                            <button onClick={() => mixer.toggleBeatFx(side)} className={cn(toggleCls, deck.beatFxOn ? "bg-rose-500/25 text-rose-400" : "text-white/20 hover:text-white/40")}>{deck.beatFxOn ? "ON" : "OFF"}</button>
                        </div>
                        <div className="flex items-center gap-1">
                            <select value={deck.beatFxType} onChange={(e) => mixer.setBeatFx(side, e.target.value as BeatFxType)} className="flex-1 text-[7px] lg:text-[8px] xl:text-[9px] bg-white/[0.03] border border-white/[0.06] rounded px-1 py-0.5 text-rose-400/50 outline-none cursor-pointer hover:bg-white/[0.06] appearance-none text-center [&_option]:bg-[#1a1a2e] [&_option]:text-white/80">
                                {BEAT_FX_TYPES.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                            </select>
                            <Knob value={deck.beatFxAmount} min={0} max={1} onChange={(v) => mixer.setBeatFxAmount(side, v)} onDoubleClick={() => mixer.setBeatFxAmount(side, 0)} color={deck.beatFxOn && deck.beatFxAmount > 0.05 ? "rgb(244,63,94)" : "rgba(255,255,255,0.2)"} size={24} showValue valueFormatter={(v) => `${Math.round(v * 100)}%`} />
                        </div>
                        <div className="flex items-center gap-0.5 mt-1">
                            {[0.25, 0.5, 1, 2, 4].map(div => (<button key={div} onClick={() => mixer.setBeatFxBeatDiv(side, div)} className={cn("flex-1", btnCls, "py-0.5", deck.beatFxBeatDiv === div ? "bg-rose-500/20 text-rose-400" : "bg-white/[0.03] text-white/20 hover:bg-white/[0.06]")}>{div < 1 ? `1/${1 / div}` : div}</button>))}
                        </div>
                    </div>
                    <div className={sectionCls}>
                        <div className="flex items-center justify-between mb-1">
                            <span className={labelCls}>{shiftActive ? "Loop ½×/2×" : "Loop"}</span>
                            <button onClick={() => mixer.toggleLoop(side)} className={cn(toggleCls, deck.loopEnabled ? "bg-green-500/25 text-green-400" : "text-white/20 hover:text-white/40")}>{deck.loopEnabled ? "ON" : "OFF"}</button>
                        </div>
                        {shiftActive ? (
                            <div className="flex items-center gap-1">
                                <button onClick={() => { const nb = Math.max(0.25, deck.loopBeats / 2); mixer.setLoop(side, nb); }}
                                    className={cn("flex-1", btnCls, "bg-amber-500/10 text-amber-400/70 hover:bg-amber-500/20 border border-amber-500/20")}>½×</button>
                                <span className="text-[9px] lg:text-[10px] font-bold tabular-nums text-white/40">{deck.loopBeats}</span>
                                <button onClick={() => { const nb = Math.min(64, deck.loopBeats * 2); mixer.setLoop(side, nb); }}
                                    className={cn("flex-1", btnCls, "bg-amber-500/10 text-amber-400/70 hover:bg-amber-500/20 border border-amber-500/20")}>2×</button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-0.5">
                                <button onClick={() => mixer.moveLoop(side, "left")} disabled={!deck.loopEnabled} className="p-0.5 rounded hover:bg-white/10 text-white/25 disabled:opacity-20 cursor-pointer"><ChevronLeft className={iconSm} /></button>
                                {loopBeatsMain.map(b => (<button key={b} onClick={() => mixer.setLoop(side, b)} className={cn("flex-1", btnCls, deck.loopEnabled && deck.loopBeats === b ? "text-black shadow-sm" : "bg-white/[0.04] text-white/30 hover:bg-white/10")} style={deck.loopEnabled && deck.loopBeats === b ? { backgroundColor: color } : undefined}>{b}</button>))}
                                <button onClick={() => mixer.moveLoop(side, "right")} disabled={!deck.loopEnabled} className="p-0.5 rounded hover:bg-white/10 text-white/25 disabled:opacity-20 cursor-pointer"><ChevronRight className={iconSm} /></button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Pads */}
                <div className={sectionCls}>
                    <div className="flex items-center gap-0.5 mb-1 lg:mb-1.5">
                        {(["hotcue", "beatloop", "beatjump", "sampler"] as PadMode[]).map(mode => (
                            <button key={mode} onClick={() => mixer.setPadMode(side, mode)}
                                className={cn("flex-1", toggleCls,
                                    deck.padMode === mode ? "text-black" : "bg-white/[0.03] text-white/20 hover:bg-white/[0.06]",
                                    shiftActive && deck.padMode === mode && "ring-1 ring-amber-500/40"
                                )}
                                style={deck.padMode === mode ? { backgroundColor: color } : undefined}>
                                {padModeLabel(mode)}
                            </button>
                        ))}
                    </div>
                    {/* Shift indicator */}
                    {shiftActive && (
                        <div className="flex items-center gap-1 mb-1 px-1">
                            <ArrowBigUp className="h-2.5 w-2.5 text-amber-400/60" />
                            <span className="text-[7px] lg:text-[8px] uppercase text-amber-400/50 tracking-wider">
                                {deck.padMode === "hotcue" ? "Click to delete cue" : deck.padMode === "sampler" ? "Click to clear slot" : "Shift active"}
                            </span>
                        </div>
                    )}
                    <div className="grid grid-cols-4 grid-rows-2 gap-1">
                        {deck.padMode === "hotcue" && Array.from({ length: 8 }).map((_, i) => {
                            const cue = deck.hotCues[i] ?? null;
                            return (
                                <button key={i}
                                    onClick={() => {
                                        if (shiftActive) {
                                            // SHIFT+pad: delete the cue
                                            if (cue != null) mixer.clearHotCue(side, i);
                                        } else {
                                            // Normal: jump to cue or set new one
                                            if (cue != null) mixer.jumpHotCue(side, i);
                                            else mixer.setHotCue(side, i);
                                        }
                                    }}
                                    onContextMenu={(e) => { e.preventDefault(); if (cue != null) mixer.clearHotCue(side, i); }}
                                    className={cn(btnCls, "py-1.5 lg:py-2 xl:py-2.5 relative",
                                        cue != null
                                            ? shiftActive ? "bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30" : "text-black shadow-sm"
                                            : "bg-white/[0.04] text-white/15 hover:bg-white/10 border border-dashed border-white/[0.08]"
                                    )}
                                    style={cue != null && !shiftActive ? { backgroundColor: CUE_COLORS[i] || color } : undefined}>
                                    {shiftActive && cue != null ? <X className="h-3 w-3 mx-auto" /> : cue != null ? formatTime(cue) : `${i + 1}`}
                                </button>
                            );
                        })}
                        {deck.padMode === "beatloop" && loopBeatsPad.map((beats, i) => (<button key={i} onClick={() => mixer.setLoop(side, beats)} className={cn(btnCls, "py-1.5 lg:py-2 xl:py-2.5", deck.loopEnabled && deck.loopBeats === beats ? "text-black shadow-sm" : "bg-white/[0.04] text-white/30 hover:bg-white/10")} style={deck.loopEnabled && deck.loopBeats === beats ? { backgroundColor: color } : undefined}>{beats < 1 ? `1/${1 / beats}` : beats}</button>))}
                        {deck.padMode === "beatjump" && <>{beatJumpSizes.map((beats, i) => (<button key={`back-${i}`} onClick={() => mixer.beatJump(side, -beats)} className={cn(btnCls, "py-1.5 lg:py-2 xl:py-2.5 bg-white/[0.04] text-white/30 hover:bg-white/10")}>◀{beats}</button>))}{beatJumpSizes.slice(0, 2).map((beats, i) => (<button key={`fwd-${i}`} onClick={() => mixer.beatJump(side, beats)} className={cn(btnCls, "py-1.5 lg:py-2 xl:py-2.5 bg-white/[0.04] text-white/30 hover:bg-white/10")}>{beats}▶</button>))}</>}
                        {deck.padMode === "sampler" && mixer.samplerSlots.map((slot, i) => (
                            <button key={i}
                                onClick={() => {
                                    if (shiftActive) {
                                        // SHIFT+pad: clear the sample
                                        if (slot.buffer) mixer.clearSampler(i);
                                    } else {
                                        if (slot.buffer) { if (slot.isPlaying) mixer.stopSampler(i); else mixer.triggerSampler(i); }
                                        else { setSamplePickerSlot(i); }
                                    }
                                }}
                                onContextMenu={(e) => { e.preventDefault(); if (slot.buffer) mixer.clearSampler(i); else setSamplePickerSlot(i); }}
                                className={cn(btnCls, "py-1.5 lg:py-2 xl:py-2.5",
                                    shiftActive && slot.buffer ? "bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30"
                                        : slot.buffer ? slot.isPlaying ? "bg-orange-500/30 text-orange-300 border border-orange-500/40" : "bg-white/[0.06] text-white/40 hover:bg-white/10 border border-white/[0.08]"
                                            : "bg-white/[0.04] text-white/15 hover:bg-white/10 border border-dashed border-white/[0.08]"
                                )}>
                                {shiftActive && slot.buffer ? <X className="h-3 w-3 mx-auto" /> : slot.buffer ? slot.name.slice(0, 4) : `S${i + 1}`}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Stems */}
                <DeckStemsPanel processor={mixer.getDeckStems(side)} color={color} />
            </div>

            {/* Sample Picker Modal */}
            {samplePickerSlot !== null && (
                <SamplePickerModal
                    open={true}
                    onOpenChange={(open) => { if (!open) setSamplePickerSlot(null); }}
                    slotIndex={samplePickerSlot}
                />
            )}
        </>
    );
});

// ─── Center Mixer Strip (EQ, Trim, Filter, Color for all channels) ───────

const CenterMixerStrip = memo(function CenterMixerStrip({ analysers }: { analysers: Record<DeckSide, AnalyserNode | null> }) {
    const mixer = useMixer();
    const is4 = mixer.deckMode === "4deck";
    const [colorFxTarget, setColorFxTarget] = useState<ColorFxTarget>("LINK");

    const handleLinkedColorFx = useCallback((v: number) => {
        mixer.setColorFx("A", v); mixer.setColorFx("B", v);
    }, [mixer]);
    const handleLinkedColorFxType = useCallback((type: ColorFxType) => {
        mixer.setColorFxType("A", type); mixer.setColorFxType("B", type);
    }, [mixer]);

    // Channel order: A,C on left — D,B on right
    const sides: DeckSide[] = is4 ? ["A", "C", "D", "B"] : ["A", "B"];
    const getDeck = (s: DeckSide) => mixer[`deck${s}` as "deckA" | "deckB" | "deckC" | "deckD"];
    const leftSides: DeckSide[] = is4 ? ["A", "C"] : ["A"];
    const rightSides: DeckSide[] = is4 ? ["D", "B"] : ["B"];

    const gridCols = is4 ? "grid-cols-4" : "grid-cols-2";
    const knobSz = is4 ? 24 : 30;
    const knobSmSz = is4 ? 22 : 26;
    const faderH = is4 ? 60 : 80;

    const selectClass = "w-full text-[7px] lg:text-[8px] xl:text-[9px] bg-white/[0.03] border border-white/[0.06] rounded px-1 py-0.5 text-white/40 outline-none cursor-pointer hover:bg-white/[0.06] transition-colors appearance-none text-center [&_option]:bg-[#1a1a2e] [&_option]:text-white/80";
    const labelCls = "text-[8px] lg:text-[9px] xl:text-[10px] uppercase tracking-wider text-white/20";
    const killBtnCls = "text-[7px] lg:text-[8px] xl:text-[9px] uppercase font-bold px-1 lg:px-1.5 py-0.5 rounded cursor-pointer transition-colors";
    const cueBtnCls = "text-[7px] lg:text-[8px] xl:text-[9px] py-1 lg:py-1.5 rounded flex items-center justify-center gap-1 cursor-pointer transition-colors";

    const colorFxCategories = [...new Set(COLOR_FX_TYPES.map(f => f.category))];
    const anyPlaying = sides.some(s => getDeck(s).isPlaying);

    const renderColorFxSelect = (side: DeckSide, value: ColorFxType, onChange: (t: ColorFxType) => void, colSpan?: string) => (
        <select value={value} onChange={e => onChange(e.target.value as ColorFxType)} className={cn(selectClass, "text-pink-400/40 [&_optgroup]:bg-[#1a1a2e] [&_optgroup]:text-white/50", colSpan)}>
            {colorFxCategories.map(cat => (
                <optgroup key={cat} label={cat}>
                    {COLOR_FX_TYPES.filter(f => f.category === cat).map(f => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                </optgroup>
            ))}
        </select>
    );

    return (
        <div className={cn(
            "shrink-0 overflow-y-auto border-x border-white/[0.04] bg-white/[0.01] px-1.5 lg:px-2 xl:px-2.5 py-1.5 flex flex-col gap-1.5 lg:gap-2",
            is4 ? "w-64 lg:w-80 xl:w-96 2xl:w-[28rem]" : "w-40 lg:w-48 xl:w-56 2xl:w-64"
        )}>
            {/* Column labels + Deck Mode Switcher */}
            <div className="flex items-center">
                {sides.map((s, i) => (
                    <Fragment key={s}>
                        <span className="text-[8px] lg:text-[9px] font-bold text-center flex-1" style={{ color: DECK_COLORS[s] }}>{s}</span>
                        {i === (is4 ? 1 : 0) && (
                            <div className="flex items-center gap-0.5 shrink-0 mx-1">
                                <span className={cn(labelCls, "text-white/15 mr-0.5")}>Mixer</span>
                                <button onClick={() => mixer.setDeckMode("2deck")}
                                    className={cn("text-[7px] font-bold px-1 py-0.5 rounded cursor-pointer transition-all border",
                                        !is4 ? "bg-white/15 text-white/70 border-white/20" : "text-white/20 hover:text-white/40 border-transparent"
                                    )}>2</button>
                                <button onClick={() => mixer.setDeckMode("4deck")}
                                    className={cn("text-[7px] font-bold px-1 py-0.5 rounded cursor-pointer transition-all border",
                                        is4 ? "bg-white/15 text-white/70 border-white/20" : "text-white/20 hover:text-white/40 border-transparent"
                                    )}>4</button>
                            </div>
                        )}
                    </Fragment>
                ))}
            </div>

            {/* EQ */}
            <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-1.5 lg:p-2 xl:p-2.5">
                <span className={cn(labelCls, "mb-1.5 block text-center")}>EQ</span>
                <div className={cn("grid gap-x-2 lg:gap-x-3 gap-y-1", gridCols)}>
                    {(["hi", "mid", "low"] as const).map(band =>
                        sides.map(s => {
                            const d = getDeck(s);
                            const eq = band === "hi" ? d.eqHi : band === "mid" ? d.eqMid : d.eqLow;
                            const kill = band === "hi" ? d.eqHiKill : band === "mid" ? d.eqMidKill : d.eqLowKill;
                            return (
                                <div key={`${s}-${band}`} className="flex flex-col items-center gap-0.5">
                                    <Knob value={eq} min={-26} max={6} onChange={v => mixer.setEQ(s, band, v)} onDoubleClick={() => mixer.toggleEQKill(s, band)} color={DECK_COLORS[s]} size={knobSz} isKilled={kill} showValue centerValue={0} valueFormatter={v => `${v > 0 ? "+" : ""}${v.toFixed(0)}dB`} />
                                    <button onClick={() => mixer.toggleEQKill(s, band)} className={cn(killBtnCls, kill ? "bg-red-500/30 text-red-400" : "text-white/20 hover:text-white/40")}>{band}</button>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            {/* Trim / Filter / Color */}
            <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-1.5 lg:p-2 xl:p-2.5">
                <div className={cn("grid gap-x-2 lg:gap-x-3 gap-y-1.5", gridCols)}>
                    {/* Trim */}
                    {sides.map(s => {
                        const d = getDeck(s);
                        return (
                            <div key={`trim-${s}`} className="flex flex-col items-center">
                                <Knob
                                    value={d.volume > 0 ? Math.max(-26, 20 * Math.log10(d.volume)) : -26}
                                    min={-26} max={6}
                                    onChange={v => mixer.setVolume(s, Math.pow(10, v / 20))}
                                    onDoubleClick={() => mixer.setVolume(s, 1)}
                                    color={d.volume > 1.05 ? "rgb(234,179,8)" : d.volume < 0.05 ? "rgba(255,255,255,0.15)" : DECK_COLORS[s]}
                                    size={knobSmSz} label="Trim" showValue centerValue={0}
                                    valueFormatter={v => `${v > 0 ? "+" : ""}${v.toFixed(0)}dB`}
                                />
                            </div>
                        );
                    })}
                    {/* Filter */}
                    {sides.map(s => {
                        const d = getDeck(s);
                        return (
                            <div key={`filter-${s}`} className="flex flex-col items-center">
                                <Knob
                                    value={d.filter} min={-1} max={1}
                                    onChange={v => mixer.setFilter(s, v)}
                                    onDoubleClick={() => mixer.setFilter(s, 0)}
                                    color={Math.abs(d.filter) > 0.05 ? (d.filter < 0 ? "rgb(234,179,8)" : "rgb(59,130,246)") : "rgba(255,255,255,0.3)"}
                                    size={knobSmSz} label="Filter" showValue centerValue={0}
                                    valueFormatter={v => { if (Math.abs(v) < 0.05) return "OFF"; return v < 0 ? "LP" : "HP"; }}
                                />
                            </div>
                        );
                    })}
                    {/* Color FX */}
                    {is4 ? (
                        sides.map(s => {
                            const d = getDeck(s);
                            return (
                                <div key={`color-${s}`} className="flex flex-col items-center">
                                    <Knob
                                        value={d.colorFx} min={-1} max={1}
                                        onChange={v => mixer.setColorFx(s, v)}
                                        onDoubleClick={() => mixer.setColorFx(s, 0)}
                                        color={Math.abs(d.colorFx) > 0.05 ? "rgb(236,72,153)" : "rgba(255,255,255,0.3)"}
                                        size={knobSmSz} label="Color" showValue centerValue={0}
                                        valueFormatter={v => { const fx = COLOR_FX_TYPES.find(f => f.id === d.colorFxType); if (Math.abs(v) < 0.05) return "OFF"; return fx?.name || "Echo"; }}
                                    />
                                </div>
                            );
                        })
                    ) : colorFxTarget === "LINK" ? (
                        <div className="col-span-2 flex flex-col items-center">
                            <Knob
                                value={getDeck("A").colorFx} min={-1} max={1}
                                onChange={handleLinkedColorFx}
                                onDoubleClick={() => { mixer.setColorFx("A", 0); mixer.setColorFx("B", 0); }}
                                color={Math.abs(getDeck("A").colorFx) > 0.05 ? "rgb(236,72,153)" : "rgba(255,255,255,0.3)"}
                                size={30} label="Color" showValue centerValue={0}
                                valueFormatter={v => { const fx = COLOR_FX_TYPES.find(f => f.id === getDeck("A").colorFxType); if (Math.abs(v) < 0.05) return "OFF"; return fx?.name || "Echo"; }}
                            />
                        </div>
                    ) : (
                        sides.map(s => {
                            const d = getDeck(s);
                            return (
                                <div key={`color-${s}`} className="flex flex-col items-center" style={{ opacity: colorFxTarget !== s ? 0.3 : 1 }}>
                                    <Knob
                                        value={d.colorFx} min={-1} max={1}
                                        onChange={v => mixer.setColorFx(s, v)}
                                        onDoubleClick={() => mixer.setColorFx(s, 0)}
                                        color={Math.abs(d.colorFx) > 0.05 ? "rgb(236,72,153)" : "rgba(255,255,255,0.3)"}
                                        size={knobSmSz} label="Color" showValue centerValue={0}
                                        valueFormatter={v => { const fx = COLOR_FX_TYPES.find(f => f.id === d.colorFxType); if (Math.abs(v) < 0.05) return "OFF"; return fx?.name || "Echo"; }}
                                    />
                                </div>
                            );
                        })
                    )}
                </div>

                {/* Color FX Link Switch (2-deck only) */}
                {!is4 && (
                    <div className="flex justify-center mt-1">
                        <ColorFxLinkSwitch value={colorFxTarget} onChange={setColorFxTarget} />
                    </div>
                )}

                {/* Type Selectors */}
                <div className={cn("grid gap-1 mt-1.5 lg:mt-2", gridCols)}>
                    {sides.map(s => (
                        <select key={`ft-${s}`} value={getDeck(s).filterType} onChange={e => mixer.setFilterType(s, e.target.value as FilterType)} className={selectClass}>
                            {FILTER_TYPES.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                        </select>
                    ))}
                    {is4 ? (
                        sides.map(s => renderColorFxSelect(s, getDeck(s).colorFxType, t => mixer.setColorFxType(s, t)))
                    ) : colorFxTarget === "LINK" ? (
                        renderColorFxSelect("A", getDeck("A").colorFxType, handleLinkedColorFxType, "col-span-2")
                    ) : (
                        sides.map(s => renderColorFxSelect(s, getDeck(s).colorFxType, t => mixer.setColorFxType(s, t)))
                    )}
                </div>
            </div>

            {/* Channel Volume Faders + Level Meters */}
            <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-1.5 lg:p-2 xl:p-2.5">
                <span className={cn(labelCls, "mb-1.5 block text-center")}>Channel</span>
                <div className={cn("flex items-end justify-center", is4 ? "gap-1" : "gap-2 lg:gap-3")}>
                    {leftSides.map(s => (
                        <Fragment key={s}>
                            <VerticalFader value={getDeck(s).volume} min={0} max={1.5} onChange={v => mixer.setVolume(s, v)} height={faderH} color={DECK_COLORS[s]} label={s} />
                            <LevelMeter analyser={analysers[s]} color={DECK_COLORS[s]} />
                        </Fragment>
                    ))}
                    <button
                        onClick={() => {
                            if (anyPlaying) {
                                sides.forEach(s => { if (getDeck(s).isPlaying) mixer.pause(s); });
                            } else {
                                sides.forEach(s => { if (getDeck(s).trackId) mixer.play(s); });
                            }
                        }}
                        className={cn(
                            "flex items-center justify-center w-7 h-7 lg:w-8 lg:h-8 xl:w-9 xl:h-9 rounded-full transition-all cursor-pointer border shrink-0",
                            anyPlaying
                                ? "bg-white/15 border-white/20 text-white shadow-[0_0_12px_rgba(255,255,255,0.1)]"
                                : "bg-white/5 border-white/10 text-white/40 hover:bg-white/10"
                        )}
                        title={anyPlaying ? "Pause All" : "Play All"}
                    >
                        {anyPlaying ? <Pause className="h-3 w-3 lg:h-3.5 lg:w-3.5" /> : <Play className="h-3 w-3 lg:h-3.5 lg:w-3.5 ml-0.5" />}
                    </button>
                    {rightSides.map(s => (
                        <Fragment key={s}>
                            <LevelMeter analyser={analysers[s]} color={DECK_COLORS[s]} />
                            <VerticalFader value={getDeck(s).volume} min={0} max={1.5} onChange={v => mixer.setVolume(s, v)} height={faderH} color={DECK_COLORS[s]} label={s} />
                        </Fragment>
                    ))}
                </div>
            </div>

            {/* Headphone Cue Toggles */}
            <div className={cn("grid gap-1", gridCols)}>
                {sides.map(s => {
                    const d = getDeck(s);
                    const isActive = d.headphoneCue;
                    return (
                        <button key={`cue-${s}`}
                            onClick={() => mixer.toggleHeadphoneCue(s)}
                            className={cn(cueBtnCls, isActive
                                ? `border` : "bg-white/[0.03] text-white/20 hover:bg-white/[0.06] border border-white/[0.06]"
                            )}
                            style={isActive ? { backgroundColor: `${DECK_COLORS[s]}20`, color: DECK_COLORS[s], borderColor: `${DECK_COLORS[s]}40` } : undefined}
                        >
                            <Headphones className="h-2.5 w-2.5 lg:h-3 lg:w-3" /> CUE {s}
                        </button>
                    );
                })}
            </div>

        </div>
    );
});

// ─── Main Mixer View ─────────────────────────────────────────────────────

export function MixerView() {
    useRenderCount("MixerView");
    const mixer = useMixer();
    const player = usePlayer();
    const personalization = usePersonalization();
    const currentTrack = player.currentTrack;
    const [settingsOpen, setSettingsOpen] = useState(false);
    const focusMode = useFocusMode();
    const [browserOpen, setBrowserOpen] = useState(false);
    const [browserTargetDeck, setBrowserTargetDeck] = useState<DeckSide>("A");
    const [activeDeckLeft, setActiveDeckLeft] = useState<DeckSide>("A");
    const [activeDeckRight, setActiveDeckRight] = useState<DeckSide>("B");
    const is4 = mixer.deckMode === "4deck";

    const [waveformOrientation, setWaveformOrientation] = useState<"horizontal" | "vertical">(() => {
        if (typeof window !== "undefined") {
            return (localStorage.getItem("mmo-mixer-wf-orient") as "horizontal" | "vertical") || "horizontal";
        }
        return "horizontal";
    });

    // ── External Devices (Circuit Tracks etc.) ───────────────────────────
    const midi = useMidi();
    const [externalPanelVisible, setExternalPanelVisible] = useState(false);
    const [externalMinimized, setExternalMinimized] = useState(personalization.externalDeviceMinimized);
    const [externalPosition, setExternalPosition] = useState(personalization.externalDevicePosition);
    const [externalSize, setExternalSize] = useState(personalization.externalDeviceSize);

    // Forward MIDI messages as custom events for the Circuit Tracks panel
    useMidiMessages((msg) => {
        window.dispatchEvent(new CustomEvent("circuit-tracks-midi", { detail: msg }));
    });

    // Auto-show/hide external device panel based on detected devices
    useEffect(() => {
        if (!personalization.showExternalDevices) return;
        if (midi.externalDevices.length > 0 && personalization.externalDeviceAutoConnect) {
            setExternalPanelVisible(true);
            setExternalMinimized(false);
        }
        if (midi.externalDevices.length === 0) {
            setExternalPanelVisible(false);
        }
    }, [midi.externalDevices, personalization.showExternalDevices, personalization.externalDeviceAutoConnect]);

    // Persist external device position
    useEffect(() => {
        personalization.update({ externalDevicePosition: externalPosition });
    }, [externalPosition]);

    useEffect(() => {
        personalization.update({ externalDeviceSize: externalSize });
    }, [externalSize]);

    useEffect(() => {
        personalization.update({ externalDeviceMinimized: externalMinimized });
    }, [externalMinimized]);

    // Auto-init mixer when view mounts
    useEffect(() => {
        if (!mixer.isActive) mixer.initMixer();
    }, [mixer.isActive, mixer.initMixer]);

    // Sync currently playing track to Deck A — only on initial mount or when currentTrack changes,
    // NOT when deckA.trackId changes (to avoid overriding user's manual track selection)
    const lastSyncedTrackRef = useRef<number | null>(null);
    useEffect(() => {
        if (currentTrack && mixer.isActive && lastSyncedTrackRef.current !== currentTrack.id) {
            lastSyncedTrackRef.current = currentTrack.id;
            if (mixer.deckA.trackId !== currentTrack.id) {
                mixer.loadTrack("A", currentTrack);
            }
        }
    }, [currentTrack, mixer.isActive, mixer.loadTrack]);

    // Persist waveform orientation
    useEffect(() => {
        localStorage.setItem("mmo-mixer-wf-orient", waveformOrientation);
    }, [waveformOrientation]);

    // Sync master volume → player volume (bidirectional)
    const masterVolumeRef = useRef(mixer.masterVolume);
    const playerVolumeRef = useRef(player.volume);

    useEffect(() => {
        // Master changed by mixer controls → push to player
        if (mixer.masterVolume !== masterVolumeRef.current) {
            masterVolumeRef.current = mixer.masterVolume;
            const clamped = Math.min(1, mixer.masterVolume);
            if (Math.abs(clamped - player.volume) > 0.005) {
                playerVolumeRef.current = clamped;
                player.setVolume(clamped);
            }
        }
    }, [mixer.masterVolume, player.volume, player.setVolume]);

    useEffect(() => {
        // Player volume changed via Now Playing bar → push to mixer
        if (player.volume !== playerVolumeRef.current) {
            playerVolumeRef.current = player.volume;
            if (Math.abs(player.volume - mixer.masterVolume) > 0.005) {
                masterVolumeRef.current = player.volume;
                mixer.setMasterVolume(player.volume);
            }
        }
    }, [player.volume, mixer.masterVolume, mixer.setMasterVolume]);

    const toggleOrientation = useCallback(() => {
        setWaveformOrientation(prev => prev === "horizontal" ? "vertical" : "horizontal");
    }, []);

    // Tracks which deck the Beat FX section currently targets when a
    // "BEAT FX CH SELECT" button is pressed on hardware controllers like
    // the Pioneer DDJ-FLX4. Defaults to deck A.
    const activeFxDeckRef = useRef<"A" | "B">("A");

    // MIDI action handler - routes MIDI controller input to mixer actions
    const handleMidiAction: MidiActionHandler = useCallback((action, deck, value, isPress) => {
        // Continuous controls (faders / knobs / encoders / jog) report
        // updates without an explicit "press" — we always want them.
        // `jog-touch` is included so its Note-Off (release) reaches the
        // handler to clear any pending bend.
        const continuousActions = new Set([
            "jog-bend", "jog-vinyl", "jog-touch",
            "volume-fader", "trim", "crossfader", "master-volume",
            "eq-hi", "eq-mid", "eq-low",
            "filter", "tempo-slider",
            "color-fx-level", "fx-level",
            "headphone-mix", "headphone-level",
            "browse-turn",
        ]);
        if (!isPress && !continuousActions.has(action)) return;

        switch (action) {
            case "play":
                if (deck && isPress) mixer.togglePlay(deck);
                break;
            case "cue":
                if (deck && isPress) {
                    // CDJ-style behaviour:
                    //   - Playing  → jump to cue (start) and stop
                    //   - Stopped at start  → begin playback (preview play)
                    //   - Stopped elsewhere → jump back to cue and stay stopped
                    const ds = mixer[`deck${deck}` as "deckA" | "deckB" | "deckC" | "deckD"];
                    if (ds.isPlaying) {
                        mixer.pause(deck);
                        mixer.seek(deck, 0);
                    } else if (ds.currentTime <= 0.05) {
                        mixer.play(deck);
                    } else {
                        mixer.seek(deck, 0);
                    }
                }
                break;
            case "shift":
                // SHIFT is a hardware-only modifier on the FLX4: the
                // controller emits SHIFT-aliased note numbers for buttons
                // pressed while SHIFT is held, so there's nothing for us
                // to do here. We swallow the event to avoid the default
                // "unhandled action" warning.
                break;
            case "sync":
                if (deck && isPress) mixer.syncBpm(deck);
                break;
            case "volume-fader":
                if (deck) mixer.setVolume(deck, value);
                break;
            case "trim":
                // MIDI 0-1 → dB -26 to +6 → linear gain
                if (deck) {
                    const db = -26 + value * 32;
                    mixer.setVolume(deck, Math.pow(10, db / 20));
                }
                break;
            case "crossfader":
                mixer.setCrossfader(value);
                break;
            // EQ knobs (DDJ-FLX4 / Pioneer convention):
            //   full-left  (0)   = -26 dB
            //   center     (0.5) =   0 dB
            //   full-right (1)   =  +6 dB
            // Use a piecewise-linear mapping so 12 o'clock is exactly 0 dB.
            case "eq-hi":
                if (deck) mixer.setEQ(deck, "hi", value < 0.5 ? value * 52 - 26 : (value - 0.5) * 12);
                break;
            case "eq-mid":
                if (deck) mixer.setEQ(deck, "mid", value < 0.5 ? value * 52 - 26 : (value - 0.5) * 12);
                break;
            case "eq-low":
                if (deck) mixer.setEQ(deck, "low", value < 0.5 ? value * 52 - 26 : (value - 0.5) * 12);
                break;
            case "filter":
                if (deck) mixer.setFilter(deck, (value - 0.5) * 2); // map 0-1 to -1..+1
                break;
            case "tempo-slider":
                if (deck) {
                    // Map 0-1 to tempo range (center = original)
                    const deckKey = deck === "A" ? "deckA" : "deckB";
                    const origBpm = mixer[deckKey].originalBpm;
                    const range = mixer.tempoRange / 100; // use settings tempo range
                    const tempoRatio = 1 + (0.5 - value) * range * 2;
                    mixer.setBpm(deck, origBpm * tempoRatio);
                }
                break;
            case "jog-bend":
            case "jog-vinyl":
                // Pioneer signed-magnitude convention: 64 = center, >64 = forward,
                // <64 = reverse. The FLX4 platter sends one tick per detent.
                if (deck) {
                    const jogValue = Math.round(value * 127);
                    if (jogValue === 64) break;
                    const delta = jogValue - 64;
                    const sensitivity = mixer.jogSensitivity / 5; // 0.2 .. 2.0
                    // Scratch (vinyl-on) wants a much sharper response than
                    // pitch-bend; small turns should feel immediate.
                    const divisor = action === "jog-vinyl" ? 3 : 6;
                    const intensity = (delta / divisor) * sensitivity;
                    if (process.env.NODE_ENV !== "production") {
                         
                        console.debug(`[jog] ${action} deck=${deck} raw=${jogValue} delta=${delta} → intensity=${intensity.toFixed(3)}`);
                    }
                    mixer.nudge(deck, intensity);
                }
                break;
            case "jog-touch":
                // Touching the platter top stops playback if
                // vinyl-mode is implied; releasing resumes. The current
                // mixer engine doesn't expose a scratchEnable() yet, so
                // we issue a release-on-up to clear any pending nudge
                // bias from a previous bend.
                if (deck && !isPress) mixer.nudgeRelease(deck);
                break;
            case "loop-in":
                if (deck && isPress) mixer.setLoop(deck, mixer[`deck${deck}` as "deckA" | "deckB" | "deckC" | "deckD"].loopBeats);
                break;
            case "loop-out":
                // Loop OUT alone toggles a 4-beat loop at the current
                // position so the dj can grab a quick loop with a single
                // press. Holding LOOP IN first then LOOP OUT will
                // properly capture a manual loop once the engine grows
                // the dedicated loop-in/loop-out marker actions.
                if (deck && isPress) mixer.setLoop(deck, 4);
                break;
            case "beatloop-0.25":
                if (deck && isPress) mixer.setLoop(deck, 0.25);
                break;
            case "beatloop-0.5":
                if (deck && isPress) mixer.setLoop(deck, 0.5);
                break;
            case "beatloop-1":
                if (deck && isPress) mixer.setLoop(deck, 1);
                break;
            case "beatloop-2":
                if (deck && isPress) mixer.setLoop(deck, 2);
                break;
            case "beatloop-4":
                if (deck && isPress) mixer.setLoop(deck, 4);
                break;
            case "beatloop-8":
                if (deck && isPress) mixer.setLoop(deck, 8);
                break;
            case "beatloop-16":
                if (deck && isPress) mixer.setLoop(deck, 16);
                break;
            case "beatloop-32":
                if (deck && isPress) mixer.setLoop(deck, 32);
                break;
            case "reloop":
                if (deck && isPress) mixer.toggleLoop(deck);
                break;
            case "loop-halve":
                if (deck && isPress) {
                    const deckState = mixer[`deck${deck}` as "deckA" | "deckB" | "deckC" | "deckD"];
                    const newBeats = Math.max(0.25, deckState.loopBeats / 2);
                    mixer.setLoop(deck, newBeats);
                }
                break;
            case "loop-double":
                if (deck && isPress) {
                    const deckState = mixer[`deck${deck}` as "deckA" | "deckB" | "deckC" | "deckD"];
                    const newBeats = Math.min(32, deckState.loopBeats * 2);
                    mixer.setLoop(deck, newBeats);
                }
                break;
            case "hotcue-1": case "hotcue-2": case "hotcue-3": case "hotcue-4":
                if (deck && isPress) {
                    const idx = parseInt(action.split("-")[1]) - 1;
                    const cue = mixer[`deck${deck}` as "deckA" | "deckB" | "deckC" | "deckD"].hotCues[idx];
                    if (cue != null) mixer.jumpHotCue(deck, idx);
                    else mixer.setHotCue(deck, idx);
                }
                break;
            case "hotcue-1-clear": case "hotcue-2-clear": case "hotcue-3-clear": case "hotcue-4-clear":
                if (deck && isPress) {
                    const idx = parseInt(action.split("-")[1]) - 1;
                    mixer.clearHotCue(deck, idx);
                }
                break;
            case "hotcue-5": case "hotcue-6": case "hotcue-7": case "hotcue-8":
                if (deck && isPress) {
                    const idx = parseInt(action.split("-")[1]) - 1;
                    const cue = mixer[`deck${deck}` as "deckA" | "deckB" | "deckC" | "deckD"].hotCues[idx];
                    if (cue != null) mixer.jumpHotCue(deck, idx);
                    else mixer.setHotCue(deck, idx);
                }
                break;
            case "hotcue-5-clear": case "hotcue-6-clear": case "hotcue-7-clear": case "hotcue-8-clear":
                if (deck && isPress) {
                    const idx = parseInt(action.split("-")[1]) - 1;
                    mixer.clearHotCue(deck, idx);
                }
                break;

            // ── Browse / Load ────────────────────────────────────
            case "browse-turn":
                // Dispatch to browser modal via custom event
                window.dispatchEvent(new CustomEvent("mixer-browser-action", {
                    detail: { type: "navigate", direction: value > 0.5 ? 1 : -1 }
                }));
                break;
            case "browse-press":
                if (isPress) {
                    if (browserOpen) {
                        // Load selected track
                        window.dispatchEvent(new CustomEvent("mixer-browser-action", {
                            detail: { type: "load" }
                        }));
                    } else {
                        setBrowserOpen(true);
                    }
                }
                break;
            case "back":
                if (isPress) setBrowserOpen(false);
                break;
            case "load-deck":
                if (deck && isPress) {
                    setBrowserTargetDeck(deck);
                    setBrowserOpen(true);
                }
                break;

            // ── Beat Jump ────────────────────────────────────────
            case "beatjump-back-1":
                if (deck && isPress) mixer.beatJump(deck, -1);
                break;
            case "beatjump-fwd-1":
                if (deck && isPress) mixer.beatJump(deck, 1);
                break;
            case "beatjump-back-4":
                if (deck && isPress) mixer.beatJump(deck, -4);
                break;
            case "beatjump-fwd-4":
                if (deck && isPress) mixer.beatJump(deck, 4);
                break;

            // ── Headphone ────────────────────────────────────────
            case "headphone-cue":
                if (deck && isPress) mixer.toggleHeadphoneCue(deck);
                break;
            case "headphone-mix":
                mixer.setHeadphoneMix(value);
                break;
            case "headphone-level":
                mixer.setHeadphoneVolume(value * 1.5);
                break;

            // ── Master Volume ────────────────────────────────────
            case "master-volume":
                mixer.setMasterVolume(value);
                break;

            // ── Pad Mode / FX ────────────────────────────────────
            case "pad-mode-hotcue":
                if (deck && isPress) mixer.setPadMode(deck, "hotcue");
                break;
            case "pad-mode-beatloop":
                if (deck && isPress) mixer.setPadMode(deck, "beatloop");
                break;
            case "pad-mode-beatjump":
                if (deck && isPress) mixer.setPadMode(deck, "beatjump");
                break;
            case "pad-mode-sampler":
                if (deck && isPress) mixer.setPadMode(deck, "sampler");
                break;
            case "fx-select":
                // Cycle Beat FX types
                if (deck && isPress) {
                    const deckState = mixer[`deck${deck}` as "deckA" | "deckB" | "deckC" | "deckD"];
                    const currentIdx = BEAT_FX_TYPES.findIndex(f => f.id === deckState.beatFxType);
                    const nextIdx = (currentIdx + 1) % BEAT_FX_TYPES.length;
                    mixer.setBeatFx(deck, BEAT_FX_TYPES[nextIdx].id);
                }
                break;
            case "fx-select-prev":
                // Cycle Beat FX types backwards (Pioneer SHIFT + FX SELECT)
                if (isPress) {
                    const fxDeck = activeFxDeckRef.current;
                    const ds = mixer[`deck${fxDeck}` as "deckA" | "deckB"];
                    const currentIdx = BEAT_FX_TYPES.findIndex(f => f.id === ds.beatFxType);
                    const prevIdx = (currentIdx - 1 + BEAT_FX_TYPES.length) % BEAT_FX_TYPES.length;
                    mixer.setBeatFx(fxDeck, BEAT_FX_TYPES[prevIdx].id);
                }
                break;
            case "fx-on-off":
                // Routes to the currently selected FX channel deck.
                if (isPress) {
                    const target = deck ?? activeFxDeckRef.current;
                    mixer.toggleBeatFx(target);
                }
                break;
            case "fx-level":
                // Continuous: targets the active FX deck unless an explicit
                // deck is bound on the mapping.
                {
                    const target = deck ?? activeFxDeckRef.current;
                    mixer.setBeatFxAmount(target, value);
                }
                break;
            case "fx-channel-1":
                if (isPress) activeFxDeckRef.current = "A";
                break;
            case "fx-channel-2":
                if (isPress) activeFxDeckRef.current = "B";
                break;
            case "fx-beats-up":
            case "fx-beats-down":
                // Pioneer "<" / ">" buttons next to BEAT FX SELECT — adjust
                // the current FX beat division (×2 / ÷2) on the active deck.
                if (isPress) {
                    const fxDeck = activeFxDeckRef.current;
                    const ds = mixer[`deck${fxDeck}` as "deckA" | "deckB"];
                    const cur = ds.beatFxBeatDiv || 1;
                    const next = action === "fx-beats-up"
                        ? Math.min(16, cur * 2)
                        : Math.max(1 / 16, cur / 2);
                    mixer.setBeatFxBeatDiv(fxDeck, next);
                }
                break;
            case "fx-disable-all":
                if (isPress) {
                    if (mixer.deckA.beatFxOn) mixer.toggleBeatFx("A");
                    if (mixer.deckB.beatFxOn) mixer.toggleBeatFx("B");
                }
                break;
            case "quantize":
                if (deck && isPress) mixer.toggleQuantize(deck);
                break;
            case "censor":
                // Reverse roll while held: the engine doesn't expose a
                // momentary reverse yet, so this is a no-op until we
                // wire a slip-reverse helper into DeckEngine.
                break;
            case "slip-mode":
                // FLX4 SLIP button → flip per-deck slip state. Mixer engine
                // already honours this in transport calls (cue/play/loop).
                if (deck && isPress) mixer.toggleSlipMode(deck);
                break;

            // ── Sampler ──────────────────────────────────────────
            case "sampler-1": case "sampler-2": case "sampler-3": case "sampler-4":
            case "sampler-5": case "sampler-6": case "sampler-7": case "sampler-8":
                if (isPress) {
                    const idx = parseInt(action.split("-")[1]) - 1;
                    const slot = mixer.samplerSlots[idx];
                    if (slot?.buffer) {
                        if (slot.isPlaying) mixer.stopSampler(idx);
                        else mixer.triggerSampler(idx);
                    }
                }
                break;

            // ── MIDI Clock ───────────────────────────────────────
            case "midi-clock-start":
                if (isPress) mixer.setMidiClockEnabled(true);
                break;
            case "midi-clock-stop":
                if (isPress) mixer.setMidiClockEnabled(false);
                break;

            // ── Color FX (linked or per-deck) ────────────────────
            case "color-fx-level":
                if (deck) mixer.setColorFx(deck, (value - 0.5) * 2); // 0-1 → -1..+1
                break;
            case "color-fx-select":
                // Cycle color FX type for the deck
                if (deck && isPress) {
                    const deckState = mixer[`deck${deck}` as "deckA" | "deckB" | "deckC" | "deckD"];
                    const currentIdx = COLOR_FX_TYPES.findIndex(f => f.id === deckState.colorFxType);
                    const nextIdx = (currentIdx + 1) % COLOR_FX_TYPES.length;
                    mixer.setColorFxType(deck, COLOR_FX_TYPES[nextIdx].id);
                }
                break;

            // ── Vinyl Brake ──────────────────────────────────────
            case "vinyl-brake":
                // Handled by the deck's vinylBrake callback — dispatch custom event
                if (deck && isPress) {
                    window.dispatchEvent(new CustomEvent("mixer-vinyl-brake", { detail: { deck } }));
                }
                break;

            // ── Pad Mode (generic cycle) ─────────────────────────
            case "pad-mode":
                if (deck && isPress) {
                    const modes: PadMode[] = ["hotcue", "beatloop", "beatjump", "sampler"];
                    const deckState = mixer[`deck${deck}` as "deckA" | "deckB" | "deckC" | "deckD"];
                    const currentIdx = modes.indexOf(deckState.padMode);
                    mixer.setPadMode(deck, modes[(currentIdx + 1) % modes.length]);
                }
                break;
        }
    }, [mixer, browserOpen]);

    // Wire MIDI action handler to the shared engine
    useEffect(() => {
        midi.setActionHandler(handleMidiAction);
    }, [midi, handleMidiAction]);

    const getDeckAnalyser = mixer.getDeckAnalyser;
    const analysers = useMemo<Record<DeckSide, AnalyserNode | null>>(() => ({
        A: getDeckAnalyser("A"),
        B: getDeckAnalyser("B"),
        C: getDeckAnalyser("C"),
        D: getDeckAnalyser("D"),
    }), [getDeckAnalyser, mixer.isActive]);
    const getDeck = (s: DeckSide) => mixer[`deck${s}` as "deckA" | "deckB" | "deckC" | "deckD"];
    const getDeckTrack = (s: DeckSide) => mixer[`deck${s}Track` as "deckATrack" | "deckBTrack" | "deckCTrack" | "deckDTrack"];

    // Active deck for left/right controls — auto-reset to A/B if switching to 2-deck mode
    const leftDeck = is4 ? activeDeckLeft : "A" as DeckSide;
    const rightDeck = is4 ? activeDeckRight : "B" as DeckSide;

    return (
        <div
            className={cn(
                "flex flex-col h-full w-full overflow-hidden",
                !personalization.reducedAnimations && "animate-[fadeIn_300ms_ease-out]"
            )}
            style={{
                gap: personalization.density.gap,
                padding: `${personalization.density.padding}px`,
                "--accent": personalization.accent.swatch,
            } as React.CSSProperties}
        >
            {/* Row 1: Track Info Cards + Performance Stats */}
            <div className="shrink-0 flex gap-1.5 lg:gap-2 px-1.5 lg:px-2 pt-1.5 pb-1 [&>*]:min-w-0">
                <DeckInfo side="A" deck={mixer.deckA} color={DECK_COLORS.A} track={mixer.deckATrack} onBrowse={() => { setBrowserTargetDeck("A"); setBrowserOpen(true); }} />
                {is4 && <DeckInfo side="C" deck={mixer.deckC} color={DECK_COLORS.C} track={mixer.deckCTrack} onBrowse={() => { setBrowserTargetDeck("C"); setBrowserOpen(true); }} />}
                {personalization.performanceStatsPosition === "on" && (
                    <div className="shrink-0">
                        <PerformancePanel />
                    </div>
                )}
                {is4 && <DeckInfo side="D" deck={mixer.deckD} color={DECK_COLORS.D} track={mixer.deckDTrack} onBrowse={() => { setBrowserTargetDeck("D"); setBrowserOpen(true); }} />}
                <DeckInfo side="B" deck={mixer.deckB} color={DECK_COLORS.B} track={mixer.deckBTrack} onBrowse={() => { setBrowserTargetDeck("B"); setBrowserOpen(true); }} />
            </div>

            {/* Row 2: Full-width Waveforms */}
            <div className="shrink-0 px-1.5 lg:px-2">
                <MixerWaveforms
                    orientation={waveformOrientation}
                    onToggleOrientation={toggleOrientation}
                />
            </div>

            {/* Row 3: Left Deck | Center Mixer Strip | Right Deck */}
            <div className="flex-1 min-h-0 grid grid-cols-[1fr_auto_1fr] overflow-hidden">
                {/* Left Deck Controls */}
                <div className="overflow-y-auto px-1.5 lg:px-2 xl:px-3 py-1.5">
                    {is4 && (
                        <div className="flex gap-1 mb-1.5">
                            {(["A", "C"] as DeckSide[]).map(s => (
                                <button key={s} onClick={() => setActiveDeckLeft(s)}
                                    className={cn("text-[9px] font-bold px-2 py-0.5 rounded cursor-pointer transition-all border",
                                        leftDeck === s
                                            ? "border-current text-white/80" : "text-white/25 hover:text-white/45 border-transparent"
                                    )}
                                    style={leftDeck === s ? { color: DECK_COLORS[s], borderColor: DECK_COLORS[s] + "60", backgroundColor: DECK_COLORS[s] + "15" } : undefined}
                                >Deck {s}</button>
                            ))}
                        </div>
                    )}
                    <DeckControls side={leftDeck} deck={getDeck(leftDeck)} color={DECK_COLORS[leftDeck]} analyser={analysers[leftDeck]} />
                </div>

                {/* Center Mixer Strip */}
                <CenterMixerStrip analysers={analysers} />

                {/* Right Deck Controls */}
                <div className="overflow-y-auto px-1.5 lg:px-2 xl:px-3 py-1.5">
                    {is4 && (
                        <div className="flex gap-1 mb-1.5 justify-end">
                            {(["B", "D"] as DeckSide[]).map(s => (
                                <button key={s} onClick={() => setActiveDeckRight(s)}
                                    className={cn("text-[9px] font-bold px-2 py-0.5 rounded cursor-pointer transition-all border",
                                        rightDeck === s
                                            ? "border-current text-white/80" : "text-white/25 hover:text-white/45 border-transparent"
                                    )}
                                    style={rightDeck === s ? { color: DECK_COLORS[s], borderColor: DECK_COLORS[s] + "60", backgroundColor: DECK_COLORS[s] + "15" } : undefined}
                                >Deck {s}</button>
                            ))}
                        </div>
                    )}
                    <DeckControls side={rightDeck} deck={getDeck(rightDeck)} color={DECK_COLORS[rightDeck]} analyser={analysers[rightDeck]} />
                </div>
            </div>

            {/* Row 4: Bottom Bar — Crossfader + Master + Headphone + Controls */}
            <div className="shrink-0 border-t border-white/[0.06] px-2 lg:px-3 py-1 lg:py-1.5 flex flex-col gap-1">
                {/* Crossfader Assign + Automix + Crossfader */}
                <div className="flex items-center gap-2 lg:gap-3">
                    {/* Left-side assigns (A, and C in 4-deck mode) */}
                    {(is4 ? ["A", "C"] as DeckSide[] : ["A"] as DeckSide[]).map(s => (
                        <div key={`assign-${s}`} className="flex items-center gap-0.5 shrink-0">
                            <span className="text-[7px] lg:text-[8px]" style={{ color: DECK_COLORS[s] + "70" }}>{s}:</span>
                            {(["thru", "A", "B"] as CrossfaderAssign[]).map(a => (
                                <button key={a} onClick={() => mixer.setCrossfaderAssign(s, a)}
                                    className={cn("text-[7px] lg:text-[8px] px-1 lg:px-1.5 py-0.5 rounded cursor-pointer transition-colors",
                                        getDeck(s).crossfaderAssign === a
                                            ? "border" : "bg-white/5 text-white/25 hover:bg-white/10 border border-white/[0.06]"
                                    )}
                                    style={getDeck(s).crossfaderAssign === a ? { backgroundColor: DECK_COLORS[s] + "30", color: DECK_COLORS[s], borderColor: DECK_COLORS[s] + "40" } : undefined}
                                >{a === "thru" ? "THRU" : a}</button>
                            ))}
                        </div>
                    ))}

                    {/* Automix + Undo */}
                    <button onClick={() => mixer.toggleAutomix()}
                        className={cn("text-[7px] lg:text-[8px] font-bold px-1.5 py-0.5 rounded cursor-pointer transition-all border flex items-center gap-0.5 shrink-0",
                            mixer.automixEnabled ? "bg-green-500/20 border-green-500/30 text-green-400" : "bg-white/5 border-white/[0.06] text-white/25 hover:bg-white/10"
                        )} title="Automix"><Repeat className="h-2.5 w-2.5 lg:h-3 lg:w-3" /> AUTO</button>
                    <button onClick={() => mixer.undoMixAction()}
                        className="text-[7px] lg:text-[8px] p-1 lg:p-1.5 rounded cursor-pointer bg-white/5 border border-white/[0.06] text-white/20 hover:bg-white/10 transition-colors shrink-0"
                        title="Undo"><Undo2 className="h-2.5 w-2.5" /></button>

                    {/* Crossfader */}
                    <div className="flex-1 min-w-0">
                        <Crossfader value={mixer.crossfader} onChange={mixer.setCrossfader} />
                    </div>

                    {/* Right-side assigns (B, and D in 4-deck mode) */}
                    {(is4 ? ["D", "B"] as DeckSide[] : ["B"] as DeckSide[]).map(s => (
                        <div key={`assign-${s}`} className="flex items-center gap-0.5 shrink-0">
                            <span className="text-[7px] lg:text-[8px]" style={{ color: DECK_COLORS[s] + "70" }}>{s}:</span>
                            {(["thru", "A", "B"] as CrossfaderAssign[]).map(a => (
                                <button key={a} onClick={() => mixer.setCrossfaderAssign(s, a)}
                                    className={cn("text-[7px] lg:text-[8px] px-1 lg:px-1.5 py-0.5 rounded cursor-pointer transition-colors",
                                        getDeck(s).crossfaderAssign === a
                                            ? "border" : "bg-white/5 text-white/25 hover:bg-white/10 border border-white/[0.06]"
                                    )}
                                    style={getDeck(s).crossfaderAssign === a ? { backgroundColor: DECK_COLORS[s] + "30", color: DECK_COLORS[s], borderColor: DECK_COLORS[s] + "40" } : undefined}
                                >{a === "thru" ? "THRU" : a}</button>
                            ))}
                        </div>
                    ))}
                </div>

                {/* Master + Headphone + Recording + Settings — single row */}
                <div className="flex items-center justify-center gap-2 lg:gap-3 flex-wrap">
                    {/* Recording */}
                    <button onClick={() => mixer.toggleRecording()}
                        className={cn("p-1 lg:p-1.5 rounded-md transition-all cursor-pointer border flex items-center gap-0.5 shrink-0",
                            mixer.isRecording ? "bg-red-500/20 border-red-500/30 text-red-400 animate-pulse" : "bg-white/5 border-white/5 text-white/30 hover:bg-white/10"
                        )} title={mixer.isRecording ? "Stop Recording" : "Record"}>
                        <Circle className={cn("h-2.5 w-2.5 lg:h-3 lg:w-3", mixer.isRecording && "fill-red-400")} />
                        {mixer.isRecording && <span className="text-[8px] lg:text-[9px] tabular-nums">{Math.floor(mixer.recordingDuration / 60000)}:{String(Math.floor((mixer.recordingDuration % 60000) / 1000)).padStart(2, "0")}</span>}
                    </button>

                    <div className="h-3 w-px bg-white/[0.08]" />

                    {/* Headphone */}
                    <Headphones className="h-2.5 w-2.5 lg:h-3 lg:w-3 text-white/20 shrink-0" />
                    <span className="text-[7px] lg:text-[8px] text-white/15">Cue</span>
                    <input type="range" min={0} max={1} step={0.01} value={mixer.headphoneMix}
                        onChange={(e) => mixer.setHeadphoneMix(parseFloat(e.target.value))}
                        className="w-14 lg:w-20 h-1 rounded-full appearance-none bg-white/10 accent-blue-400 cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-2 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-400" />
                    <span className="text-[7px] lg:text-[8px] text-white/15">Mix</span>
                    <input type="range" min={0} max={1.5} step={0.01} value={mixer.headphoneVolume}
                        onChange={(e) => mixer.setHeadphoneVolume(parseFloat(e.target.value))}
                        className="w-10 lg:w-14 h-1 rounded-full appearance-none bg-white/10 accent-blue-400 cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-2 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-400" />

                    <div className="h-3 w-px bg-white/[0.08]" />

                    {/* Master */}
                    <span className="text-[7px] lg:text-[8px] uppercase tracking-wider text-white/20 shrink-0">Master</span>
                    <input type="range" min={0} max={1.5} step={0.01} value={mixer.masterVolume}
                        onChange={(e) => mixer.setMasterVolume(parseFloat(e.target.value))}
                        className="w-24 lg:w-32 xl:w-40 h-1 rounded-full appearance-none bg-white/10 accent-purple-500 cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md" />
                    <span className="text-[8px] lg:text-[9px] tabular-nums text-white/30">{Math.round(mixer.masterVolume * 100)}%</span>

                    <div className="h-3 w-px bg-white/[0.08]" />

                    {/* Settings */}
                    <button onClick={() => setSettingsOpen(true)}
                        className="p-1 rounded-md bg-white/5 hover:bg-white/10 text-white/25 hover:text-white/50 transition-colors cursor-pointer border border-white/5"
                        title="Settings"><Settings2 className="h-3 w-3" /></button>

                    {/* Focus Mode */}
                    <button onClick={focusMode.toggleFocusMode}
                        className={cn("p-1 rounded-md transition-colors cursor-pointer border",
                            focusMode.isFocusMode
                                ? "bg-purple-500/20 border-purple-500/30 text-purple-400 hover:bg-purple-500/30"
                                : "bg-white/5 border-white/5 text-white/25 hover:bg-white/10 hover:text-white/50"
                        )}
                        title={focusMode.isFocusMode ? "Exit focus mode" : "Focus mode (hide sidebar & player)"}>
                        {focusMode.isFocusMode ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
                    </button>

                    {/* External Device Badges (minimized panels) */}
                    {midi.externalDevices.map(({ profile, device }) => (
                        externalMinimized && externalPanelVisible ? (
                            <CircuitTracksBadge
                                key={device.id}
                                profile={profile}
                                isPlaying={false}
                                bpm={Math.round(mixer.deckA.bpm) || 120}
                                syncMode={profile.clock.defaultSyncMode}
                                onRestore={() => setExternalMinimized(false)}
                            />
                        ) : !externalPanelVisible ? (
                            <button
                                key={device.id}
                                onClick={() => { setExternalPanelVisible(true); setExternalMinimized(false); }}
                                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-all cursor-pointer border"
                                style={{
                                    backgroundColor: `${profile.color}10`,
                                    borderColor: `${profile.color}20`,
                                }}
                                title={`Open ${profile.name}`}
                            >
                                <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: profile.color, boxShadow: `0 0 4px ${profile.color}60` }} />
                                <span className="text-[7px] font-bold uppercase tracking-wider" style={{ color: `${profile.color}90` }}>{profile.name}</span>
                            </button>
                        ) : null
                    ))}
                </div>
            </div>

            {/* Transition Suggestions (overlay-style at bottom) */}
            {mixer.transitionSuggestions.length > 0 && (
                <div className="shrink-0 px-2 pb-1">
                    <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-1.5">
                        <div className="flex items-center gap-1.5 mb-1">
                            <Lightbulb className="h-2.5 w-2.5 text-yellow-400/60" />
                            <span className="text-[8px] text-white/25 uppercase tracking-wider">Suggestions</span>
                        </div>
                        <div className="flex gap-1 overflow-x-auto">
                            {mixer.transitionSuggestions.slice(0, 5).map((s, i) => (
                                <div key={i} className="shrink-0 text-[7px] px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/[0.06]">
                                    <div className="text-white/50 truncate max-w-[80px]">{s.targetTitle}</div>
                                    <div className="flex items-center gap-0.5 mt-0.5">
                                        <span className={cn("px-0.5 rounded-sm",
                                            s.keyCompatibility === "perfect" ? "bg-green-500/20 text-green-300" :
                                                s.keyCompatibility === "compatible" ? "bg-yellow-500/20 text-yellow-300" :
                                                    "bg-red-500/20 text-red-300"
                                        )}>{s.keyCompatibility}</span>
                                        <span className={cn("px-0.5 rounded-sm",
                                            s.score >= 80 ? "bg-green-500/15 text-green-300" : s.score >= 50 ? "bg-yellow-500/15 text-yellow-300" : "bg-red-500/15 text-red-300"
                                        )}>{s.score}%</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* External Device Floating Panels */}
            {externalPanelVisible && !externalMinimized && midi.engine && midi.externalDevices.map(({ profile, device }) => (
                <CircuitTracksPanel
                    key={device.id}
                    profile={profile}
                    device={device}
                    midiEngine={midi.engine!}
                    isMinimized={false}
                    onMinimize={() => setExternalMinimized(true)}
                    onClose={() => setExternalPanelVisible(false)}
                    position={externalPosition}
                    onPositionChange={setExternalPosition}
                    size={externalSize}
                    onSizeChange={setExternalSize}
                />
            ))}

            <MixerSettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} onMidiHandler={handleMidiAction} />
            <MixerBrowserModal open={browserOpen} onOpenChange={setBrowserOpen} targetDeck={browserTargetDeck} onDeckChange={setBrowserTargetDeck} />
        </div>
    );
}
