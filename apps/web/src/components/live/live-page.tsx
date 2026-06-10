"use client";

/**
 * LivePage — The full-screen live performance interface.
 *
 * Designed for live vocalists/performers (e.g. Romanian lăutari) who need:
 *   - One-touch mic activation with FX
 *   - Backing track playback with quick transport
 *   - Loop bank for vocal layering
 *   - Sample pads for cues/stings
 *   - Always-visible tuner + master meter
 *   - Dead-simple recording
 *
 * Visual language: rose/pink accent, dark surfaces, glass panels, animated.
 */

import { useCallback, useEffect, useMemo, useRef, useState, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { useLive } from "./live-context";
import { useFocusMode } from "@/components/focus-mode-context";
import { ProjectChrome } from "@/components/projects/project-chrome";
import { cn } from "@/lib/utils";
import { useRenderCount } from "@/lib/dev-debugger";
import {
    Mic, MicOff, Square, Circle, Play, Pause, Volume2, VolumeX,
    Music, Power, Plus, Trash2, ChevronDown, ChevronRight, Sparkles,
    Repeat, Upload, X, Maximize2, Minimize2, Activity,
    Settings2, Headphones, Disc3, GripVertical, Radio, Wifi, WifiOff,
    Save, RotateCcw, Sliders, KeyRound, Zap, Eye, BarChart3,
    ZoomIn, ZoomOut, Type, Music2, Plug,
} from "lucide-react";
import { Reorder, useDragControls, type DragControls } from "framer-motion";
import { FX_DEFAULTS, FX_CATEGORIES, MUSICAL_SCALES, NOTE_NAMES, AudioFxEngine, type FxType, type FxPreset } from "@/lib/audio-fx-engine";
import { formatLiveTime, formatRecordTime } from "@/lib/live-engine";
import { QUALITY_PROFILES, type StreamQuality } from "@/lib/webrtc-audio-bridge";
import { PerformancePanel } from "@/components/performance-stats";
import { LiveRecommendationsWidget } from "@/components/live/live-recommendations-widget";
import { LiveVisualizerWidget } from "@/components/live/live-visualizer-widget";
import { LiveEqWidget } from "@/components/live/live-eq-widget";
import { LiveAudioStatsCard } from "@/components/live/live-audio-stats-card";
import { AudioDiagnosticsLogger } from "@/components/live/audio-diagnostics-logger";
import { LiveInstrumentWidget } from "@/components/live/live-instrument-widget";
import { LivePluginsWidget } from "@/components/live/live-plugins-widget";
import { LiveWidgetSlotContext, useLiveWidgetSlot, AutoSize } from "@/components/live/live-widget-slot";
import { LiveWidgetGrid, type WidgetMeta } from "@/components/live/live-widget-grid";
import { useLiveMetersField, liveMetersStore } from "@/components/live/live-meters-store";
import { useUIRefreshHz, UI_REFRESH_HZ_MIN, UI_REFRESH_HZ_MAX } from "@/lib/use-ui-refresh-rate";
import { useLiveSettings } from "@/hooks/use-live-settings";
import { useStableValue } from "@/hooks/use-stable-value";
import { formatNoteMulti, formatPitch } from "@/lib/note-notation";
import type { NoteNotation } from "@/lib/note-notation";
import { LiveSettingsModal } from "@/components/live/live-settings-modal";
import { Settings as SettingsIcon } from "lucide-react";
import { AudioDeviceSelect } from "@/components/ui/audio-device-select";
import { encodeNativeValue } from "@/hooks/use-audio-devices";
import {
    NativeCompanionClient,
    discoverCompanion,
    type NativePitch,
    type NativeStatus,
    type NativeMetrics,
    type NativeDeviceInfo,
    type NativeLevels,
    type NativePerf,
} from "@/lib/native-companion";

// ─── Drag context: makes the Section title bar a drag handle when inside a Reorder.Item ─

const DragControlsContext = createContext<DragControls | null>(null);

// ─── Grid widget context: auto-wires Section's collapse/drag-handle props ────
// Now backed by the shared `LiveWidgetSlotContext` so widgets with custom
// headers (visualizer, EQ, …) can consume the same slot info directly.
function useLiveWidgetContext() { return useLiveWidgetSlot(); }

// ─── Atomic components ───────────────────────────────────────────────────────

function LiveKnob({
    value, min, max, color, label, onChange, onDoubleClick, format, size = 44,
}: {
    value: number; min: number; max: number; color: string; label: string;
    onChange: (v: number) => void; onDoubleClick?: () => void;
    format?: (v: number) => string; size?: number;
}) {
    const startRef = useRef<{ y: number; val: number } | null>(null);
    const normalized = (value - min) / (max - min);
    const angle = -135 + normalized * 270;
    const r = size * 0.4;
    const c = size / 2;
    const circ = 2 * Math.PI * r;
    return (
        <div className="flex flex-col items-center gap-1 select-none touch-none" onDoubleClick={onDoubleClick}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="cursor-pointer"
                onPointerDown={e => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); startRef.current = { y: e.clientY, val: value }; }}
                onPointerMove={e => { if (!startRef.current) return; const dy = startRef.current.y - e.clientY; const delta = (dy / 100) * (max - min); onChange(Math.max(min, Math.min(max, startRef.current.val + delta))); }}
                onPointerUp={() => { startRef.current = null; }}>
                <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2.5"
                    strokeDasharray={`${circ * 0.75} ${circ}`} strokeLinecap="round"
                    transform={`rotate(135 ${c} ${c})`} />
                <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth="2.5"
                    strokeDasharray={`${circ * 0.75 * normalized} ${circ}`} strokeLinecap="round"
                    transform={`rotate(135 ${c} ${c})`}
                    style={{ filter: `drop-shadow(0 0 4px ${color}80)` }} />
                <line x1={c} y1={c} x2={c} y2={c - r * 0.85} stroke={color} strokeWidth="2.5" strokeLinecap="round"
                    transform={`rotate(${angle} ${c} ${c})`} />
                <circle cx={c} cy={c} r={r * 0.45} fill="rgba(255,255,255,0.04)" />
            </svg>
            <span className="text-[9px] text-white/35 uppercase tracking-wider leading-none">{label}</span>
            <span className="text-[10px] text-white/55 tabular-nums leading-none">{format ? format(value) : value.toFixed(2)}</span>
        </div>
    );
}

function MeterPair({ peakL, peakR, isLimiting }: { peakL: number; peakR: number; isLimiting?: boolean }) {
    const dbL = peakL > 0 ? 20 * Math.log10(peakL) : -60;
    const dbR = peakR > 0 ? 20 * Math.log10(peakR) : -60;
    const segs = 24;
    const renderBar = (db: number) => {
        const norm = Math.max(0, Math.min(1, (db + 60) / 60));
        const lit = Math.floor(norm * segs);
        return Array.from({ length: segs }, (_, i) => {
            const isLit = i < lit;
            const isHigh = i >= segs * 0.75;
            const isMid = i >= segs * 0.5 && i < segs * 0.75;
            const color = isHigh ? "#ef4444" : isMid ? "#eab308" : "#10b981";
            return (
                <div key={i} className="flex-1 rounded-sm transition-opacity"
                    style={{
                        backgroundColor: isLit ? color : "rgba(255,255,255,0.06)",
                        opacity: isLit ? (isHigh ? 1 : 0.85) : 1,
                        boxShadow: isLit && isHigh ? "0 0 4px #ef4444aa" : "none",
                    }} />
            );
        });
    };
    return (
        <div className={cn("flex flex-col gap-1 p-1.5 rounded-lg bg-black/40 border transition-colors",
            isLimiting ? "border-red-500/50 shadow-[0_0_10px_rgba(239,68,68,0.3)]" : "border-white/[0.04]")}>
            <div className="flex flex-col gap-px h-2">{renderBar(dbL)}</div>
            <div className="flex flex-col gap-px h-2">{renderBar(dbR)}</div>
        </div>
    );
}

function VerticalMeter({ peak, color = "#f43f5e" }: { peak: number; color?: string }) {
    const db = peak > 0 ? 20 * Math.log10(peak) : -60;
    const norm = Math.max(0, Math.min(1, (db + 60) / 60));
    return (
        <div className="w-1 h-12 bg-white/[0.04] rounded-full overflow-hidden flex items-end">
            <div className="w-full rounded-full transition-[height] duration-75"
                style={{ height: `${norm * 100}%`, backgroundColor: color, boxShadow: `0 0 4px ${color}80` }} />
        </div>
    );
}

// ─── Self-subscribing meter wrappers ─────────────────────────────────────────
// Each component reads only its own primitive field(s) from the meters store,
// so they re-render at the configured refresh rate without dragging the rest
// of the page along.

function MasterMeterPair() {
    const peakL = useLiveMetersField(s => s.masterPeakL);
    const peakR = useLiveMetersField(s => s.masterPeakR);
    const isLimiting = useLiveMetersField(s => s.isLimiting);
    return <MeterPair peakL={peakL} peakR={peakR} isLimiting={isLimiting} />;
}

function VoiceMeters() {
    const peakL = useLiveMetersField(s => s.voicePeakL);
    const peakR = useLiveMetersField(s => s.voicePeakR);
    return (
        <>
            <VerticalMeter peak={peakL} />
            <VerticalMeter peak={peakR} />
        </>
    );
}

/**
 * Feature flag — the native (companion-side) low-latency engine path.
 * When ON, the Voice Processor shows live levels next to the input/output
 * knobs and a one-line perf row (latency / DSP / underruns) sourced from
 * the companion's WS push at ~30 Hz. Set to false to hide the entire
 * native UI surface (DSP + plumbing stay in place).
 */
const NATIVE_ENGINE_UI_ENABLED = true;

/**
 * Tiny shared-state hook for boolean settings persisted in localStorage.
 * Used by the Voice Processor's perf toggles + the KeyScale engine
 * lifecycle effect so both can read/write the same value without
 * threading the state through props or a context. Uses a custom window
 * event for cross-component sync (the native `storage` event fires only
 * for OTHER tabs, not the same tab that wrote the value).
 */
function useSharedLocalStorageBool(key: string, defaultValue: boolean): [boolean, (next: boolean) => void] {
    const [value, setValue] = useState<boolean>(() => {
        if (typeof window === "undefined") return defaultValue;
        const raw = window.localStorage.getItem(key);
        return raw === null ? defaultValue : raw === "1";
    });
    useEffect(() => {
        if (typeof window === "undefined") return;
        const eventName = `mmo-shared-bool-${key}`;
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ value: boolean }>).detail;
            if (detail) setValue(detail.value);
        };
        window.addEventListener(eventName, handler);
        return () => window.removeEventListener(eventName, handler);
    }, [key]);
    const update = useCallback((next: boolean) => {
        if (typeof window === "undefined") return;
        try { window.localStorage.setItem(key, next ? "1" : "0"); } catch { /* ignore */ }
        setValue(next);
        window.dispatchEvent(new CustomEvent(`mmo-shared-bool-${key}`, { detail: { value: next } }));
    }, [key]);
    return [value, update];
}

/**
 * Native input/output meter pair shown next to the corresponding gain knob
 * inside the Voice Processor. Two thin vertical bars (RMS + peak overlay)
 * driven by the companion's WS push at ~30 Hz. Renders nothing when the
 * native engine is not running so the layout stays compact in the common
 * "browser-only" case.
 */
function NativeKnobMeter({ direction }: { direction: "input" | "output" }) {
    const running = useLiveMetersField(s => s.nativeRunning);
    const peak = useLiveMetersField(s => direction === "input" ? s.nativeInPeak : s.nativeOutPeak);
    const rms = useLiveMetersField(s => direction === "input" ? s.nativeInRms : s.nativeOutRms);
    if (!NATIVE_ENGINE_UI_ENABLED) return null;
    if (!running) return null;
    // Convert linear → dBFS-ish normalized 0..1 for the bar height.
    const norm = (v: number) => {
        const db = v > 0 ? 20 * Math.log10(v) : -60;
        return Math.max(0, Math.min(1, (db + 60) / 60));
    };
    const peakN = norm(peak);
    const rmsN = norm(rms);
    return (
        <div className="flex items-end gap-0.5 h-12" title={`Native ${direction} ${(peak * 100).toFixed(0)}%`}>
            {/* RMS bar — solid colour, transitions smoothly */}
            <div className="w-1 h-12 bg-white/[0.04] rounded-full overflow-hidden flex items-end relative">
                <div className="w-full rounded-full transition-[height] duration-75"
                    style={{
                        height: `${rmsN * 100}%`,
                        background: "linear-gradient(to top, #22c55e, #facc15 70%, #ef4444 95%)",
                    }} />
                {/* Peak hold marker */}
                <div className="absolute left-0 right-0 h-[2px] bg-white/80"
                    style={{ bottom: `${peakN * 100}%`, transition: "bottom 80ms linear" }} />
            </div>
        </div>
    );
}

/**
 * Compact one-line perf readout for the Voice Processor. Only renders while
 * the companion engine is actively running; otherwise this is invisible.
 */
function NativeEnginePerfRow({ visible }: { visible: boolean }) {
    const running = useLiveMetersField(s => s.nativeRunning);
    const lat = useLiveMetersField(s => s.nativeStreamLatencyMs);
    const dspAvg = useLiveMetersField(s => s.nativeDspAvgMs);
    const dspMax = useLiveMetersField(s => s.nativeDspMaxMs);
    const underruns = useLiveMetersField(s => s.nativeUnderruns);
    if (!NATIVE_ENGINE_UI_ENABLED) return null;
    if (!visible || !running) return null;
    const cls = lat <= 8 ? "text-emerald-400" : lat <= 20 ? "text-amber-400" : "text-rose-400";
    return (
        <div className="flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-lg bg-emerald-500/[0.04] border border-emerald-500/10 text-[9px] tabular-nums">
            <span className="flex items-center gap-1 text-emerald-400/70 uppercase tracking-wider">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Native Engine
            </span>
            <span className="flex items-center gap-3 text-white/60">
                <span><span className="text-white/35">Lat </span><span className={cls}>{lat.toFixed(2)}ms</span></span>
                <span><span className="text-white/35">DSP </span>{dspAvg.toFixed(2)}/{dspMax.toFixed(2)}ms</span>
                <span className={underruns > 0 ? "text-rose-400" : "text-white/35"}>
                    {underruns > 0 ? `${underruns} xrun` : "0 xrun"}
                </span>
            </span>
        </div>
    );
}

function RecordTimerLabel() {
    const ms = useLiveMetersField(s => s.recordingDuration);
    return <>{formatRecordTime(ms)}</>;
}

function BackingPositionLabel({ duration }: { duration: number }) {
    const pos = useLiveMetersField(s => s.backingPosition);
    return (
        <div className="text-[9px] tabular-nums text-white/30 font-mono">
            {formatLiveTime(pos)} / {formatLiveTime(duration)}
        </div>
    );
}

function BackingProgressBar({ duration, onSeek }: { duration: number; onSeek: (s: number) => void }) {
    const pos = useLiveMetersField(s => s.backingPosition);
    const progressPct = duration > 0 ? (pos / duration) * 100 : 0;
    return (
        <div className="h-2 rounded-full bg-white/[0.04] cursor-pointer overflow-hidden touch-none select-none relative"
            onPointerDown={e => {
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                const rect = e.currentTarget.getBoundingClientRect();
                onSeek(((e.clientX - rect.left) / rect.width) * duration);
            }}
            onPointerMove={e => {
                if (e.buttons === 0) return;
                const rect = e.currentTarget.getBoundingClientRect();
                onSeek(((e.clientX - rect.left) / rect.width) * duration);
            }}>
            <div className="h-full rounded-full bg-gradient-to-r from-blue-500/50 to-blue-400/70 transition-[width] duration-100"
                style={{ width: `${progressPct}%` }} />
        </div>
    );
}

function Section({ title, icon, accent, children, action, dragHandle, collapsed: collapsedProp, onToggleCollapse: onToggleCollapseProp, dragHandleClass: dragHandleClassProp, fillHeight: fillHeightProp }: {
    title: string; icon?: React.ReactNode; accent: string; children: React.ReactNode;
    action?: React.ReactNode; dragHandle?: React.ReactNode;
    collapsed?: boolean;
    onToggleCollapse?: () => void;
    /** When provided, attached to the title bar so an outer grid library can use it as a drag handle. */
    dragHandleClass?: string;
    /** When true, body fills the remaining height with internal scroll. */
    fillHeight?: boolean;
}) {
    // Auto-wire from grid context (so panels don't need to manually plumb props).
    const grid = useLiveWidgetContext();
    const collapsed = collapsedProp ?? grid?.collapsed ?? false;
    const onToggleCollapse = onToggleCollapseProp ?? grid?.onToggleCollapse;
    const dragHandleClass = dragHandleClassProp ?? grid?.dragHandleClass;
    const fillHeight = fillHeightProp ?? grid?.fillHeight ?? false;
    const autoResize = grid?.autoResize ?? false;

    // Legacy framer-motion drag controls path (kept for any legacy callers).
    const dc = useContext(DragControlsContext);
    const draggable = dc !== null;
    const handleDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!dc) return;
        const target = e.target as HTMLElement;
        if (target.closest("button, input, select, textarea, a, [data-no-drag]")) return;
        e.preventDefault();
        e.stopPropagation();
        dc.start(e);
    }, [dc]);

    // New grid-library path: title bar is the drag handle via CSS class.
    const useGridDrag = !!dragHandleClass;

    return (
        <div className={cn(
            "rounded-2xl border border-white/[0.06] bg-gradient-to-b from-white/[0.025] to-white/[0.01] backdrop-blur overflow-hidden group/section flex flex-col",
            fillHeight && "h-full",
        )}>
            <div
                className={cn(
                    "flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.04] transition-colors shrink-0",
                    (draggable || useGridDrag) && "cursor-grab active:cursor-grabbing hover:bg-white/[0.03] select-none",
                    useGridDrag && dragHandleClass,
                )}
                style={(draggable || useGridDrag) ? { touchAction: "none", WebkitUserSelect: "none", userSelect: "none" } : undefined}
                onPointerDown={draggable ? handleDragStart : undefined}
            >
                {(draggable || useGridDrag) && (
                    <GripVertical className="w-3.5 h-3.5 text-white/20 group-hover/section:text-white/45 transition-colors -ml-1.5 pointer-events-none" />
                )}
                {dragHandle}
                {icon && <span className="pointer-events-none">{icon}</span>}
                <span className="text-[11px] font-bold uppercase tracking-wider pointer-events-none truncate" style={{ color: accent }}>{title}</span>
                <div className="ml-auto flex items-center gap-2" data-no-drag>
                    {action}
                    {onToggleCollapse && (
                        <button
                            onClick={onToggleCollapse}
                            title={collapsed ? "Expand" : "Collapse"}
                            className="w-6 h-6 flex items-center justify-center rounded text-white/30 hover:text-white/70 hover:bg-white/[0.06] transition-colors cursor-pointer"
                        >
                            {collapsed
                                ? <ChevronRight className="w-3.5 h-3.5" />
                                : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>
                    )}
                </div>
            </div>
            {!collapsed && (
                <div className={cn(
                    "p-3",
                    fillHeight && !autoResize && "flex-1 min-h-0 overflow-y-auto",
                    fillHeight && autoResize && "flex-1 min-h-0",
                )}>
                    {autoResize
                        ? <AutoSize padding={56 /* approx header height */}>{children}</AutoSize>
                        : children}
                </div>
            )}
        </div>
    );
}

// ─── Stream Panel (WebRTC audio to/from remote device) ──────────────────────

function LanConnectHint() {
    const [urls, setUrls] = useState<string[]>([]);
    const [copied, setCopied] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch("/api/lan-url")
            .then((r) => r.json())
            .then((d: { urls: string[] }) => { if (!cancelled) setUrls(d.urls ?? []); })
            .catch(() => { /* offline / route missing */ });
        return () => { cancelled = true; };
    }, []);

    const copy = useCallback((url: string) => {
        navigator.clipboard?.writeText(url).then(() => {
            setCopied(url);
            setTimeout(() => setCopied(null), 1500);
        }).catch(() => { /* clipboard blocked */ });
    }, []);

    if (urls.length === 0) {
        return (
            <div className="text-[11px] text-white/30 text-center py-3 rounded-xl border border-dashed border-white/[0.06]">
                Open <code className="text-cyan-400/70">/remote</code> on your phone to enable audio streaming
            </div>
        );
    }

    return (
        <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.02] p-3 space-y-2">
            <div className="text-[10px] text-white/40 font-bold uppercase tracking-wider">Connect from phone (same WiFi)</div>
            <div className="space-y-1">
                {urls.map((url) => (
                    <button key={url} onClick={() => copy(url)}
                        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-black/20 border border-white/[0.04] hover:bg-cyan-500/5 hover:border-cyan-500/20 transition-colors cursor-pointer text-left">
                        <code className="text-[10px] text-cyan-400/80 truncate">{url}</code>
                        <span className="text-[8px] text-white/30 uppercase tracking-wider shrink-0">
                            {copied === url ? "Copied" : "Copy"}
                        </span>
                    </button>
                ))}
            </div>
            <div className="text-[9px] text-white/25 leading-relaxed">
                Works fully offline once both devices are on the same network. No internet required.
            </div>
        </div>
    );
}

function StreamPanel() {
    const live = useLive();
    const s = live.stream;
    const [outputAudio] = useState(() => typeof Audio !== "undefined" ? new Audio() : null);
    const audioRef = useRef<HTMLAudioElement | null>(outputAudio);

    // Auto-start when peer becomes available (idempotent — only opens if not connected yet)
    useEffect(() => {
        if (s.hasPeer && s.connectionState === "idle") {
            void s.start();
        }
    }, [s.hasPeer, s.connectionState, s]);

    const profile = QUALITY_PROFILES[s.quality];
    const stateColor = s.connectionState === "connected" ? "#10b981"
        : s.connectionState === "connecting" ? "#eab308"
            : s.connectionState === "failed" ? "#ef4444"
                : "#6b7280";
    const stateLabel = s.connectionState === "connected" ? "Live"
        : s.connectionState === "connecting" ? "Connecting…"
            : s.connectionState === "failed" ? "Failed"
                : s.hasPeer ? "Ready" : "No remote";

    return (
        <Section title="Remote Stream" accent="#22d3ee"
            icon={s.connectionState === "connected" ? <Wifi className="w-3.5 h-3.5 text-cyan-400/70" /> : <WifiOff className="w-3.5 h-3.5 text-white/30" />}
            action={
                <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md"
                    style={{ color: stateColor, backgroundColor: `${stateColor}15`, border: `1px solid ${stateColor}30` }}>
                    <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: stateColor }} />
                    {stateLabel}
                </span>
            }>
            <div className="space-y-3">
                {!s.hasPeer ? (
                    <LanConnectHint />
                ) : (
                    <>
                        {/* Send/Receive toggles */}
                        <div className="grid grid-cols-2 gap-2">
                            <button onClick={() => void s.setSendOutput(!s.isSendingOutput)}
                                disabled={s.connectionState !== "connected"}
                                className={cn("flex flex-col items-start gap-0.5 px-3 py-2 rounded-xl border transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed",
                                    s.isSendingOutput
                                        ? "bg-cyan-500/15 border-cyan-500/30 shadow-[0_0_8px_rgba(34,211,238,0.15)]"
                                        : "bg-white/[0.03] border-white/[0.06] hover:bg-cyan-500/5")}>
                                <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider"
                                    style={{ color: s.isSendingOutput ? "#22d3ee" : "rgba(255,255,255,0.4)" }}>
                                    <Headphones className="w-3 h-3" />
                                    Send Master
                                </div>
                                <div className="text-[9px] text-white/30">→ phone speakers</div>
                            </button>
                            <button onClick={() => void s.setSendMic(!s.isSendingMic)}
                                disabled={s.connectionState !== "connected"}
                                className={cn("flex flex-col items-start gap-0.5 px-3 py-2 rounded-xl border transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed",
                                    s.isSendingMic
                                        ? "bg-rose-500/15 border-rose-500/30 shadow-[0_0_8px_rgba(244,63,94,0.15)]"
                                        : "bg-white/[0.03] border-white/[0.06] hover:bg-rose-500/5")}>
                                <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider"
                                    style={{ color: s.isSendingMic ? "#f43f5e" : "rgba(255,255,255,0.4)" }}>
                                    <Mic className="w-3 h-3" />
                                    Send Mic
                                </div>
                                <div className="text-[9px] text-white/30">this device → remote</div>
                            </button>
                        </div>

                        {/* Receiving indicator */}
                        <div className={cn("flex items-center gap-2 px-3 py-2 rounded-xl border text-[10px]",
                            s.isReceivingRemote
                                ? "bg-rose-500/10 border-rose-500/25"
                                : "bg-white/[0.02] border-white/[0.04]")}>
                            <Radio className={cn("w-3.5 h-3.5", s.isReceivingRemote ? "text-rose-400 animate-pulse" : "text-white/25")} />
                            <span className={cn("font-medium uppercase tracking-wider",
                                s.isReceivingRemote ? "text-rose-400" : "text-white/30")}>
                                {s.isReceivingRemote ? "Receiving remote audio → voice input" : "No incoming audio"}
                            </span>
                        </div>

                        {/* Quality picker */}
                        <div>
                            <div className="text-[9px] font-bold uppercase tracking-wider text-white/30 mb-1.5">
                                Audio Quality
                            </div>
                            <div className="grid grid-cols-2 gap-1">
                                {(["ultra", "high", "balanced", "low"] as StreamQuality[]).map(q => {
                                    const p = QUALITY_PROFILES[q];
                                    const isActive = s.quality === q;
                                    return (
                                        <button key={q} onClick={() => void s.setQuality(q)}
                                            className={cn("flex flex-col items-start gap-0.5 px-2.5 py-1.5 rounded-lg border transition-all cursor-pointer",
                                                isActive
                                                    ? "bg-cyan-500/15 border-cyan-500/30 shadow-[0_0_6px_rgba(34,211,238,0.15)]"
                                                    : "bg-white/[0.02] border-white/[0.04] hover:bg-white/[0.04]")}>
                                            <span className={cn("text-[10px] font-bold",
                                                isActive ? "text-cyan-300" : "text-white/55")}>
                                                {p.label}
                                            </span>
                                            <span className="text-[8px] text-white/30 leading-tight">{p.description}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Stats — always visible to help diagnose */}
                        <div className="rounded-lg bg-black/30 border border-white/[0.04] divide-y divide-white/[0.04]">
                            <div className="grid grid-cols-4 px-2 py-1.5 text-[9px] tabular-nums">
                                <div>
                                    <div className="text-white/30 uppercase tracking-wider text-[8px]">RTT</div>
                                    <div className="font-bold" style={{ color: s.connectionState === "connected" ? (s.stats.rttMs < 50 ? "#10b981" : s.stats.rttMs < 100 ? "#eab308" : "#ef4444") : "rgba(255,255,255,0.3)" }}>
                                        {s.stats.rttMs}<span className="text-white/30 font-normal text-[8px] ml-0.5">ms</span>
                                    </div>
                                </div>
                                <div>
                                    <div className="text-white/30 uppercase tracking-wider text-[8px]">Jitter</div>
                                    <div className="font-bold text-white/70">
                                        {s.stats.jitterMs}<span className="text-white/30 font-normal text-[8px] ml-0.5">ms</span>
                                    </div>
                                </div>
                                <div>
                                    <div className="text-white/30 uppercase tracking-wider text-[8px]">Loss</div>
                                    <div className="font-bold text-white/70">{s.stats.packetsLost}</div>
                                </div>
                                <div>
                                    <div className="text-white/30 uppercase tracking-wider text-[8px]">Sync</div>
                                    <div className="font-bold text-white/70 truncate" title={s.stats.signalingState ?? "n/a"}>
                                        {!s.stats.signalingState || s.stats.signalingState === "n/a" ? "—" : s.stats.signalingState === "stable" ? "OK" : s.stats.signalingState.replace("have-", "")}
                                    </div>
                                </div>
                            </div>
                            <div className="grid grid-cols-4 px-2 py-1.5 text-[9px] tabular-nums">
                                <div>
                                    <div className="text-white/30 uppercase tracking-wider text-[8px]">Up</div>
                                    <div className="font-bold text-cyan-300">
                                        {Math.round(s.stats.bytesSentPerSec / 1000)}<span className="text-white/30 font-normal text-[8px] ml-0.5">kbps</span>
                                    </div>
                                </div>
                                <div>
                                    <div className="text-white/30 uppercase tracking-wider text-[8px]">Down</div>
                                    <div className="font-bold text-cyan-300">
                                        {Math.round(s.stats.bytesReceivedPerSec / 1000)}<span className="text-white/30 font-normal text-[8px] ml-0.5">kbps</span>
                                    </div>
                                </div>
                                <div>
                                    <div className="text-white/30 uppercase tracking-wider text-[8px]">ICE</div>
                                    <div className={cn("font-bold truncate",
                                        s.stats.iceState === "connected" || s.stats.iceState === "completed" ? "text-emerald-400"
                                            : s.stats.iceState === "checking" ? "text-amber-400"
                                                : s.stats.iceState === "failed" || s.stats.iceState === "disconnected" ? "text-red-400"
                                                    : "text-white/50",
                                    )} title={s.stats.iceState ?? "n/a"}>
                                        {!s.stats.iceState || s.stats.iceState === "n/a" ? "—" : s.stats.iceState}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-white/30 uppercase tracking-wider text-[8px]">Role</div>
                                    <div className="font-bold text-white/70">
                                        {s.stats.role === "initiator" ? "OFR" : s.stats.role === "responder" ? "ANS" : "—"}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Disconnect/Reconnect */}
                        <div className="flex items-center gap-1.5">
                            {s.connectionState === "connected" ? (
                                <button onClick={s.stop}
                                    className="flex-1 py-1.5 rounded-lg text-[10px] bg-white/[0.04] text-white/40 hover:bg-red-500/10 hover:text-red-400 cursor-pointer border border-white/[0.06] transition-all">
                                    Disconnect
                                </button>
                            ) : (
                                <button onClick={() => void s.start()}
                                    className="flex-1 py-1.5 rounded-lg text-[10px] bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 cursor-pointer border border-cyan-500/20 transition-all font-medium uppercase tracking-wider">
                                    Connect
                                </button>
                            )}
                        </div>
                    </>
                )}
            </div>

            {/* Hidden audio element for remote playback (host receives mic from remote → routed via attachRemoteInput, no playback needed here) */}
            <audio ref={audioRef as React.RefObject<HTMLAudioElement>} autoPlay playsInline className="hidden" />
        </Section>
    );
}

// ─── Master Bar (top) ────────────────────────────────────────────────────────

function MasterBar() {
    const live = useLive();
    const { isFocusMode, toggleFocusMode } = useFocusMode();
    const [tapAnim, setTapAnim] = useState(0);
    const [sessionId, setSessionId] = useState<string | null>(null);

    useEffect(() => {
        try {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror LiveAutosave id derivation
            setSessionId(localStorage.getItem("mmo:live:session-id"));
        } catch { /* ignore */ }
    }, []);

    const handleTap = useCallback(() => {
        live.tapBpm();
        setTapAnim(n => n + 1);
    }, [live]);

    return (
        <div className="flex flex-wrap items-stretch gap-2 px-3 sm:px-4 py-2 sm:py-3 bg-black/40 backdrop-blur-xl border-b border-white/[0.06]">
            {/* App identity */}
            <div className="flex items-center gap-2 pr-3 border-r border-white/[0.04] shrink-0">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-rose-500/20 to-rose-600/10 border border-rose-500/30 flex items-center justify-center shadow-[0_0_12px_rgba(244,63,94,0.15)] shrink-0">
                    <Mic className="w-5 h-5 text-rose-400" />
                </div>
                <div className="hidden sm:block">
                    <div className="text-sm font-bold text-white/80 leading-none">Live</div>
                    <div className="text-[9px] text-white/30 uppercase tracking-wider mt-0.5">Performance</div>
                </div>
            </div>

            {/* BPM + Tap */}
            <div className="flex items-center gap-2 shrink-0">
                <div className="flex flex-col items-center justify-center px-3 py-1.5 rounded-xl bg-white/[0.03] border border-white/[0.06] min-w-[78px]">
                    <input type="number" min={20} max={300} step={0.1} value={live.tempo.toFixed(1)}
                        onChange={e => live.setTempo(parseFloat(e.target.value) || 120)}
                        className="w-full text-2xl font-bold text-amber-400 tabular-nums bg-transparent text-center focus:outline-none leading-none" />
                    <span className="text-[8px] text-white/30 uppercase tracking-wider mt-0.5">BPM</span>
                </div>
                <button onClick={handleTap}
                    className="relative h-full px-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 active:scale-95 transition-all cursor-pointer text-xs font-bold uppercase tracking-wider">
                    Tap
                    <span key={tapAnim} className="absolute inset-0 rounded-xl border-2 border-amber-400 animate-ping pointer-events-none opacity-0"
                        style={{ animation: tapAnim ? "ping 0.4s ease-out" : "none" }} />
                </button>
            </div>

            {/* Key & Scale display */}
            <div className="shrink-0"><KeyScaleDisplay /></div>

            {/* Master meters */}
            <div className="shrink-0"><MasterMeterPair /></div>

            {/* Master volume */}
            <div className="flex items-center gap-2 px-2 shrink-0">
                <Volume2 className="w-3.5 h-3.5 text-white/40 shrink-0" />
                <input type="range" min={0} max={2} step={0.01} value={live.masterVolume}
                    onChange={e => live.setMasterVolume(parseFloat(e.target.value))}
                    className="w-20 md:w-24 accent-rose-500" />
                <span className="text-[10px] tabular-nums text-white/40 w-8 hidden md:inline">{Math.round(live.masterVolume * 100)}</span>
            </div>

            {/* Monitor volume */}
            <div className="flex items-center gap-2 px-2 border-l border-white/[0.04] shrink-0">
                <Headphones className="w-3.5 h-3.5 text-white/40 shrink-0" />
                <input type="range" min={0} max={2} step={0.01} value={live.monitorVolume}
                    onChange={e => live.setMonitorVolume(parseFloat(e.target.value))}
                    className="w-16 md:w-20 accent-cyan-500" />
            </div>

            {/* Metronome */}
            <button onClick={live.toggleMetronome}
                className={cn("flex items-center gap-1.5 px-3 rounded-xl border transition-all cursor-pointer text-xs font-medium shrink-0",
                    live.isMetronomeOn
                        ? "bg-blue-500/20 text-blue-400 border-blue-500/30 shadow-[0_0_8px_rgba(59,130,246,0.2)]"
                        : "bg-white/[0.03] text-white/40 hover:bg-white/[0.06] border-white/[0.06]")}>
                <span className={cn("text-base leading-none", live.isMetronomeOn && "animate-pulse")}>🔔</span>
                <span className="hidden sm:inline">Metro</span>
                {live.metronomeMonitorOnly && live.isMetronomeOn && (
                    <span className="text-[8px] uppercase opacity-60">cue</span>
                )}
            </button>

            {/* Right-aligned trio: Record / Settings / Focus. Wraps as a unit. */}
            <div className="ml-auto flex items-stretch gap-2 shrink-0">
                <button onClick={live.toggleRecording}
                    className={cn("flex items-center gap-2 px-3 rounded-xl border transition-all cursor-pointer text-xs font-bold",
                        live.isRecording
                            ? "bg-red-500/20 text-red-400 border-red-500/40 shadow-[0_0_12px_rgba(239,68,68,0.3)]"
                            : "bg-white/[0.03] text-white/50 hover:bg-red-500/10 hover:text-red-400 border-white/[0.06]")}>
                    <Circle className={cn("w-3 h-3", live.isRecording && "fill-red-400 animate-pulse")} />
                    <span className="hidden sm:inline">{live.isRecording ? <RecordTimerLabel /> : "Record"}</span>
                </button>

                <LiveSettingsButton />

                {sessionId && (
                    <ProjectChrome
                        kind="live"
                        externalId={sessionId}
                        getCurrentDocument={() => ({
                            masterVolume: live.masterVolume,
                            monitorVolume: live.monitorVolume,
                            tempo: live.tempo,
                        }) as Record<string, unknown>}
                    />
                )}

                <button onClick={toggleFocusMode}
                    className="flex items-center justify-center w-9 rounded-xl bg-white/[0.03] text-white/40 hover:bg-white/[0.06] border border-white/[0.06] transition-colors cursor-pointer"
                    title={isFocusMode ? "Exit focus mode" : "Focus mode (hide app shell)"}>
                    {isFocusMode ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                </button>
            </div>
        </div>
    );
}

function KeyScaleDisplay() {
    const live = useLive();
    const settings = useLiveSettings();
    const scaleName = MUSICAL_SCALES[live.scaleIndex]?.name ?? "\u2014";
    // Treat any scale whose name doesn't include "major" as minor for Camelot purposes.
    const quality: "major" | "minor" = /major/i.test(scaleName) ? "major" : "minor";
    const keyLabel = formatNoteMulti(live.keyIndex, settings.noteNotations, quality);
    return (
        <div className="flex items-center gap-2 px-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
            <span className="text-[9px] text-white/30 uppercase tracking-wider">Key</span>
            <span className="text-lg font-bold text-rose-400 tabular-nums">{keyLabel}</span>
            <span className="text-[10px] text-white/40">{scaleName}</span>
        </div>
    );
}

function LiveSettingsButton() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button onClick={() => setOpen(true)}
                className="flex items-center justify-center w-9 rounded-xl bg-white/[0.03] text-white/40 hover:bg-white/[0.06] hover:text-white/70 border border-white/[0.06] transition-colors cursor-pointer"
                title="Live settings">
                <SettingsIcon className="w-4 h-4" />
            </button>
            <LiveSettingsModal open={open} onClose={() => setOpen(false)} />
        </>
    );
}

// ─── Tuner Panel ─────────────────────────────────────────────────────────────

function RefreshRateControl() {
    const [hz, setHz] = useUIRefreshHz();
    return (
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white/[0.03] border border-white/[0.06]"
            title={`Realtime widget refresh rate: ${hz} Hz (Coach & Tuner). Lower = calmer display.`}>
            <Activity className="w-3 h-3 text-emerald-400/60" />
            <span className="text-[9px] text-white/50 uppercase tracking-wider hidden sm:inline">Refresh</span>
            <input
                type="range"
                min={UI_REFRESH_HZ_MIN}
                max={UI_REFRESH_HZ_MAX}
                step={1}
                value={hz}
                onChange={e => setHz(parseInt(e.target.value, 10))}
                className="w-20 accent-emerald-500 cursor-pointer"
                aria-label="Realtime UI refresh rate"
            />
            <span className="text-[10px] text-white/60 tabular-nums w-9 text-right">{hz} Hz</span>
        </div>
    );
}

function TunerPanel() {
    const settings = useLiveSettings();
    // Subscribe individually to each meter field. Each useSyncExternalStore
    // call is a primitive selector, so the component only re-renders when
    // *that* primitive changes.
    const conf = useLiveMetersField(s => s.tunerConfidence);
    const centsRaw = useLiveMetersField(s => s.tunerCents);
    const noteIdxRaw = useLiveMetersField(s => s.tunerNoteIndex);
    const freqRaw = useLiveMetersField(s => s.tunerFrequency);
    // Auto-correct fields. When acActive is true the corrector is steering
    // the input towards `targetMidi`; we surface BOTH notes in the tuner.
    const acActiveRaw = useLiveMetersField(s => s.autoCorrectActive);
    const acTargetMidi = useLiveMetersField(s => s.autoCorrectTargetMidi);
    const acSourceMidi = useLiveMetersField(s => s.autoCorrectSourceMidi);
    // Stickiness: hold each displayed value for at least N ms so the user can
    // actually read it before it changes. The internal signal is unaffected.
    const noteIdx = useStableValue(noteIdxRaw, settings.tunerStickinessMs);
    const cents = useStableValue(Math.round(centsRaw), settings.tunerStickinessMs);
    const freq = useStableValue(Math.round(freqRaw * 10) / 10, settings.tunerStickinessMs);
    const stickyTarget = useStableValue(acTargetMidi, settings.tunerStickinessMs);
    // Hold acActive much longer than the per-value stickiness: this flag
    // controls which *layout branch* renders (single big readout vs the
    // In→Out grid). When the input has gaps (silence between notes) the
    // corrector toggles on/off many times per second; without a long hold
    // the entire widget swaps layouts and visibly resizes, causing a
    // strobing/flashing effect. 1.5s is short enough to feel responsive
    // when the user actually engages/disengages auto-correct, but long
    // enough to ride out normal speech/singing pauses.
    const acActive = useStableValue(acActiveRaw, Math.max(1500, settings.tunerStickinessMs * 2));
    // Format the held note via the user's chosen notation(s). The tuner shows
    // a sounding pitch (with octave for Anglo/Solfège, code-only for Camelot).
    const inputNote = noteIdx >= 0
        ? settings.noteNotations.map(n => formatPitch(noteIdx, n, "major")).join(" / ")
        : "";
    const outputNote = acActive && stickyTarget >= 0
        ? settings.noteNotations.map(n => formatPitch(stickyTarget, n, "major")).join(" / ")
        : "";
    // When auto-correct is on, the listener hears the corrected pitch — we
    // colour the big readout by how close the input is to the corrector's
    // target (not to the nearest equal-tempered note), since that's what's
    // actually being snapped to.
    const inToTarget = acActive && stickyTarget >= 0 && Number.isFinite(acSourceMidi)
        ? (acSourceMidi - stickyTarget) * 100
        : cents;
    const inTune = Math.abs(inToTarget) <= 8 && conf > 0.5;
    const sharpFlat = inToTarget > 0 ? "sharp" : inToTarget < 0 ? "flat" : "—";
    const noteColor = inTune ? "#10b981" : Math.abs(inToTarget) > 25 ? "#ef4444" : "#eab308";

    // Dial rotation: -50..+50 cents → -45deg..+45deg
    const dialAngle = Math.max(-50, Math.min(50, inToTarget)) / 50 * 45;

    return (
        <Section title="Tuner" accent="#10b981" icon={<Activity className="w-3.5 h-3.5 text-emerald-400/60" />}>
            <div className="flex flex-col items-center gap-2">
                {/* Auto-correct active: stack input → output. Otherwise
                    keep the classic single big note display. Both branches
                    share the same min-height so the layout never reflows
                    when acActive toggles. */}
                <div className="w-full min-h-[68px] flex items-center justify-center">
                    {acActive && outputNote ? (
                        <div className="w-full grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                            <div className="text-center">
                                <div className="text-[8px] uppercase tracking-wider text-white/40 mb-0.5">In</div>
                                <div className="text-2xl font-bold tabular-nums leading-none"
                                    style={{ color: conf > 0.3 ? noteColor : "rgba(255,255,255,0.15)" }}>
                                    {inputNote || "—"}
                                </div>
                                <div className="text-[9px] text-white/40 tabular-nums mt-0.5">
                                    {freq > 0 ? `${freq.toFixed(1)} Hz` : "—"}
                                </div>
                            </div>
                            <div className="text-emerald-400/60 text-2xl leading-none -mt-2">→</div>
                            <div className="text-center">
                                <div className="text-[8px] uppercase tracking-wider text-emerald-400/70 mb-0.5">Out</div>
                                <div className="text-2xl font-bold tabular-nums leading-none text-emerald-300">
                                    {outputNote}
                                </div>
                                <div className="text-[9px] text-emerald-400/50 tabular-nums mt-0.5">
                                    tuned
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="relative w-full">
                            <div className="text-center">
                                <div className="text-5xl font-bold tabular-nums tracking-tight"
                                    style={{ color: conf > 0.3 ? noteColor : "rgba(255,255,255,0.15)" }}>
                                    {inputNote || "—"}
                                </div>
                                <div className="text-[10px] text-white/40 tabular-nums mt-1">
                                    {freq > 0 ? `${freq.toFixed(1)} Hz` : "—"}
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* Tuning dial */}
                <div className="relative w-full h-12 flex items-center justify-center mt-1">
                    {/* Cents scale */}
                    <div className="absolute inset-0 flex items-center justify-between text-[8px] text-white/20 px-1">
                        {[-50, -25, 0, 25, 50].map(v => (
                            <span key={v}>{v > 0 ? `+${v}` : v}</span>
                        ))}
                    </div>
                    {/* Bar with marks */}
                    <div className="absolute top-1/2 left-2 right-2 h-1 -translate-y-1/2 rounded-full bg-white/[0.05] overflow-hidden">
                        <div className="absolute inset-y-0 w-px bg-emerald-500/50" style={{ left: "50%" }} />
                    </div>
                    {/* Needle — no CSS transition: at refresh rates < ~5Hz the
                        needle would constantly chase a stale target and look
                        laggy; at high rates the transition never finishes
                        before the next update arrives anyway. */}
                    <div className="absolute top-1/2 left-1/2 origin-bottom"
                        style={{ transform: `translate(-50%, -100%) rotate(${dialAngle}deg)`, opacity: conf }}>
                        <div className="w-0.5 h-8 rounded-full" style={{ backgroundColor: noteColor, boxShadow: `0 0 6px ${noteColor}` }} />
                    </div>
                </div>

                <div className="flex items-center justify-between w-full px-1 text-[10px] mt-1">
                    <span className={cn("uppercase tracking-wider", inTune ? "text-emerald-400" : "text-white/30")}>
                        {acActive && outputNote ? (inTune ? "locked" : sharpFlat) : (inTune ? "in tune" : sharpFlat)}
                    </span>
                    {settings.showCents && (
                        <span className="text-white/30 tabular-nums">{Math.abs(Math.round(inToTarget))}¢</span>
                    )}
                    <span className="text-white/20 tabular-nums">{Math.round(conf * 100)}%</span>
                </div>
            </div>
        </Section>
    );
}

// ─── Voice Panel ─────────────────────────────────────────────────────────────

const FX_PARAM_RANGES: Record<string, { min: number; max: number }> = {
    threshold: { min: -60, max: 0 },
    knee: { min: 0, max: 40 },
    ratio: { min: 1, max: 20 },
    attack: { min: 0, max: 1 },
    release: { min: 0, max: 2 },
    makeupGain: { min: -12, max: 24 },
    mix: { min: 0, max: 1 },
    decay: { min: 0.1, max: 10 },
    preDelay: { min: 0, max: 0.5 },
    damping: { min: 0, max: 1 },
    time: { min: 0.001, max: 2 },
    feedback: { min: 0, max: 0.95 },
    rate: { min: 0.1, max: 20 },
    depth: { min: 0, max: 1 },
    drive: { min: 0, max: 1 },
    tone: { min: 0, max: 1 },
    bits: { min: 1, max: 16 },
    sampleRate: { min: 0, max: 1 },
    cutoff: { min: 20, max: 20000 },
    resonance: { min: 0.1, max: 30 },
    width: { min: 0, max: 2 },
    frequency: { min: 20, max: 20000 },
    semitones: { min: -24, max: 24 },
    cents: { min: -100, max: 100 },
    speed: { min: 0, max: 1 },
    amount: { min: 0, max: 1 },
    reduction: { min: 0, max: 60 },
    bands: { min: 4, max: 32 },
    spread: { min: 0, max: 1 },
    stages: { min: 2, max: 12 },
    low: { min: -24, max: 24 },
    mid: { min: -24, max: 24 },
    high: { min: -24, max: 24 },
    type: { min: 0, max: 5 },
    key: { min: 0, max: 11 },
    scale: { min: 0, max: 8 },
    freq1: { min: 20, max: 20000 }, freq2: { min: 20, max: 20000 }, freq3: { min: 20, max: 20000 },
    gain1: { min: -24, max: 24 }, gain2: { min: -24, max: 24 }, gain3: { min: -24, max: 24 },
    q1: { min: 0.1, max: 30 }, q2: { min: 0.1, max: 30 }, q3: { min: 0.1, max: 30 },
};

function VoiceFxRow({ fx }: { fx: { id: string; type: string; enabled: boolean; params: Record<string, number> } }) {
    const live = useLive();
    const [expanded, setExpanded] = useState(false);
    const params = Object.entries(fx.params);

    return (
        <div className={cn("rounded-xl border transition-all overflow-hidden",
            fx.enabled
                ? "border-rose-500/20 bg-gradient-to-r from-rose-500/[0.04] to-transparent"
                : "border-white/[0.04] bg-white/[0.01] opacity-50")}>
            <div className="flex items-center gap-2 px-2.5 py-2">
                <button onClick={() => live.voiceToggleEffect(fx.id)}
                    className={cn("w-7 h-7 rounded-lg flex items-center justify-center transition-all cursor-pointer",
                        fx.enabled
                            ? "bg-rose-500/25 text-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.2)]"
                            : "bg-white/5 text-white/20")}>
                    <Power className="w-3.5 h-3.5" />
                </button>
                <span className="text-[11px] text-white/65 font-medium flex-1 capitalize">
                    {fx.type.replace(/([A-Z])/g, " $1").trim()}
                </span>
                <button onClick={() => live.voiceRemoveEffect(fx.id)}
                    className="text-white/15 hover:text-red-400/70 transition-colors cursor-pointer p-1">
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
                {params.length > 0 && (
                    <button onClick={() => setExpanded(!expanded)} className="text-white/30 cursor-pointer p-1">
                        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                )}
            </div>
            {expanded && params.length > 0 && (
                <div className="px-3 pb-3 pt-1 grid grid-cols-4 gap-2 border-t border-white/[0.04]">
                    {params.map(([key, val]) => {
                        const range = FX_PARAM_RANGES[key] ?? { min: 0, max: 1 };
                        return (
                            <LiveKnob key={key} value={val} min={range.min} max={range.max} color="#f43f5e" label={key}
                                onChange={v => live.voiceUpdateParam(fx.id, key, v)} />
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function LiveVoicePresetMenu({ presets, selectedId, onSelect, onDelete, onClose, anchorRef }: {
    presets: FxPreset[];
    selectedId: string;
    onSelect: (p: FxPreset) => void;
    onDelete: (id: string) => void;
    onClose: () => void;
    anchorRef: React.RefObject<HTMLElement | null>;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node) &&
                anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("mousedown", handler);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", handler);
            document.removeEventListener("keydown", onKey);
        };
    }, [onClose, anchorRef]);

    useEffect(() => {
        if (anchorRef.current) {
            const rect = anchorRef.current.getBoundingClientRect();
            setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(240, rect.width) });
        }
    }, [anchorRef]);

    const grouped = useMemo(() => {
        const builtin: FxPreset[] = [];
        const user: FxPreset[] = [];
        for (const p of presets) {
            if (p.id.startsWith("user_")) user.push(p);
            else builtin.push(p);
        }
        // Group built-ins by category for clarity.
        const byCat = new Map<string, FxPreset[]>();
        for (const p of builtin) {
            const list = byCat.get(p.category) || [];
            list.push(p);
            byCat.set(p.category, list);
        }
        return { byCat, user };
    }, [presets]);

    const catLabels: Record<string, string> = {
        voice: "Voice",
        instrument: "Instrument",
        master: "Master",
        creative: "Creative",
        utility: "Utility",
    };

    return createPortal(
        <div
            ref={ref}
            className="fixed z-[9999] rounded-xl border border-white/10 bg-[#141418] shadow-2xl py-1.5 max-h-80 overflow-y-auto backdrop-blur"
            style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { top: 0, left: -9999 }}
        >
            {Array.from(grouped.byCat.entries()).map(([cat, list]) => (
                <div key={cat}>
                    <div className="px-3 pt-2 pb-1 text-[8px] text-white/25 uppercase tracking-widest font-bold">
                        {catLabels[cat] || cat}
                    </div>
                    {list.map(preset => (
                        <button
                            key={preset.id}
                            onClick={() => onSelect(preset)}
                            className={cn(
                                "w-full text-left px-3 py-1.5 text-[11px] transition-colors cursor-pointer",
                                selectedId === preset.id
                                    ? "text-rose-400 bg-rose-500/10"
                                    : "text-white/60 hover:bg-white/5 hover:text-white/85",
                            )}
                        >
                            <div className="flex items-center justify-between gap-2">
                                <span className="truncate">{preset.name}</span>
                                <span className="text-[8px] text-white/25 shrink-0">{preset.chain.length} fx</span>
                            </div>
                        </button>
                    ))}
                </div>
            ))}
            {grouped.user.length > 0 && (
                <div>
                    <div className="px-3 pt-2 pb-1 text-[8px] text-rose-400/60 uppercase tracking-widest font-bold flex items-center gap-1">
                        <Sparkles className="w-2.5 h-2.5" /> User
                    </div>
                    {grouped.user.map(preset => (
                        <div key={preset.id} className={cn(
                            "group flex items-center px-3 py-1.5 text-[11px] transition-colors",
                            selectedId === preset.id
                                ? "text-rose-400 bg-rose-500/10"
                                : "text-white/60 hover:bg-white/5 hover:text-white/85",
                        )}>
                            <button
                                onClick={() => onSelect(preset)}
                                className="flex-1 text-left flex items-center justify-between gap-2 cursor-pointer min-w-0"
                            >
                                <span className="truncate">{preset.name}</span>
                                <span className="text-[8px] text-white/25 shrink-0">{preset.chain.length} fx</span>
                            </button>
                            <button
                                onClick={(e) => { e.stopPropagation(); onDelete(preset.id); }}
                                className="ml-2 opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400 transition-opacity cursor-pointer"
                                title="Delete preset"
                            >
                                <Trash2 className="w-3 h-3" />
                            </button>
                        </div>
                    ))}
                </div>
            )}
            {presets.length === 0 && (
                <div className="py-4 text-center text-[10px] text-white/25">No presets</div>
            )}
        </div>,
        document.body,
    );
}

function VoicePanel() {
    const live = useLive();
    const settings = useLiveSettings();
    const [showAddFx, setShowAddFx] = useState(false);
    const [presets, setPresets] = useState<FxPreset[]>([]);
    const [selectedPresetId, setSelectedPresetId] = useState<string>("");
    const [showPresetMenu, setShowPresetMenu] = useState(false);
    const presetBtnRef = useRef<HTMLButtonElement>(null);
    // Native engine perf toggles \u2014 the source of truth lives in
    // localStorage and is read by KeyScalePanel's start config too.
    const [nativeUltraLowLatency, setNativeUltraLowLatency] = useSharedLocalStorageBool("mmo-live-native-ultra-latency", false);
    const [nativeExclusiveMode, setNativeExclusiveMode] = useSharedLocalStorageBool("mmo-live-native-exclusive", false);
    // Native engine state, mirrored from KeyScalePanel via the meters store.
    const nativeRunning = useLiveMetersField(s => s.nativeRunning);
    const nativeAvailable = useLiveMetersField(s => s.nativeAvailable);
    const nativeError = useLiveMetersField(s => s.nativeError);
    const nativeLatencyMs = useLiveMetersField(s => s.nativeMetricsLatencyMs);
    const nativeDspAvgMs = useLiveMetersField(s => s.nativeMetricsDspAvgMs);
    // Source-of-truth for the "is native mode requested" toggle. Shared
    // with KeyScalePanel via localStorage + a custom event so either panel
    // can flip it; KeyScalePanel still owns the engine lifecycle.
    const [nativeMode, setNativeMode] = useSharedLocalStorageBool("mmo-live-keyscale-native", false);

    // Mirror the native input device id (lives in localStorage so other
    // panels — Key & Scale — can share it). We need real React state so
    // that `<AudioDeviceSelect value={…}>` re-renders when the user picks
    // a new native device; reading localStorage inline does not trigger
    // a re-render and was the cause of the trigger label staying stuck on
    // "Default Input" after a successful native pick.
    const [voiceNativeInputId, setVoiceNativeInputId] = useState<number | null>(() => {
        if (typeof window === "undefined") return null;
        try {
            const raw = window.localStorage.getItem("mmo-live-native-input-device");
            if (!raw) return null;
            const n = parseInt(raw, 10);
            return Number.isFinite(n) ? n : null;
        } catch { return null; }
    });
    useEffect(() => {
        const onChange = (e: Event) => {
            const detail = (e as CustomEvent<{ id: number | null }>).detail;
            setVoiceNativeInputId(detail?.id ?? null);
        };
        window.addEventListener("mmo-live-native-input-changed", onChange);
        return () => window.removeEventListener("mmo-live-native-input-changed", onChange);
    }, []);

    // Same pattern for the native output device id. The actual engine
    // restart with the new output is done by KeyScalePanel which owns the
    // companion client; we just persist + dispatch.
    const [voiceNativeOutputId, setVoiceNativeOutputId] = useState<number | null>(() => {
        if (typeof window === "undefined") return null;
        try {
            const raw = window.localStorage.getItem("mmo-live-native-output-device");
            if (!raw) return null;
            const n = parseInt(raw, 10);
            return Number.isFinite(n) ? n : null;
        } catch { return null; }
    });
    useEffect(() => {
        const onChange = (e: Event) => {
            const detail = (e as CustomEvent<{ id: number | null }>).detail;
            setVoiceNativeOutputId(detail?.id ?? null);
        };
        window.addEventListener("mmo-live-native-output-changed", onChange);
        return () => window.removeEventListener("mmo-live-native-output-changed", onChange);
    }, []);

    const handleBrowserOutputChange = useCallback(async (deviceId: string) => {
        settings.update({ audioOutputDeviceId: deviceId });
        // Mirror the same setSinkId fan-out as the Live settings modal so the
        // Voice Processor's output selector swaps the active sink in-place.
        const ctx = (window as unknown as { __mmo_live_ctx?: AudioContext }).__mmo_live_ctx;
        if (ctx && "setSinkId" in ctx) {
            try { await (ctx as AudioContext & { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId); } catch { /* unsupported */ }
        }
        for (const audio of document.querySelectorAll("audio")) {
            if ("setSinkId" in audio) {
                try { await (audio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId); } catch { /* unsupported */ }
            }
        }
    }, [settings]);

    // Load presets on mount + listen for cross-tab/window changes.
    useEffect(() => {
        const reload = () => setPresets(AudioFxEngine.loadPresets());
        reload();
        window.addEventListener("mmo-preference-changed", reload);
        return () => window.removeEventListener("mmo-preference-changed", reload);
    }, []);

    const handleLoadPreset = useCallback((preset: FxPreset) => {
        live.voiceLoadPreset(preset.chain);
        setSelectedPresetId(preset.id);
        setShowPresetMenu(false);
    }, [live]);

    const handleSavePreset = useCallback(() => {
        if (live.voiceChain.length === 0) return;
        const name = prompt("Preset name:");
        if (!name) return;
        const preset = AudioFxEngine.createPreset(name, "voice", live.voiceChain);
        const updated = [...presets, preset];
        setPresets(updated);
        AudioFxEngine.savePresets(updated);
        setSelectedPresetId(preset.id);
    }, [live.voiceChain, presets]);

    const handleDeletePreset = useCallback((id: string) => {
        if (!id.startsWith("user_")) return;
        if (!confirm("Delete this preset?")) return;
        const updated = presets.filter(p => p.id !== id);
        setPresets(updated);
        AudioFxEngine.savePresets(updated);
        if (selectedPresetId === id) setSelectedPresetId("");
    }, [presets, selectedPresetId]);

    const selectedName = presets.find(p => p.id === selectedPresetId)?.name;

    return (
        <Section title="Voice Processor" accent="#f43f5e"
            icon={
                <div className={cn("w-6 h-6 rounded-lg flex items-center justify-center transition-all",
                    live.voiceActive ? "bg-rose-500/25 text-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.25)]" : "bg-white/5 text-white/30")}>
                    {live.voiceActive ? <Mic className="w-3 h-3" /> : <MicOff className="w-3 h-3" />}
                </div>
            }
            action={
                <button onClick={() => live.voiceActive ? void live.voiceStop() : void live.voiceStart()}
                    className={cn("px-3 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer",
                        live.voiceActive
                            ? "bg-rose-500/20 text-rose-400 border border-rose-500/30 shadow-[0_0_8px_rgba(244,63,94,0.15)]"
                            : "bg-white/[0.04] text-white/30 hover:bg-rose-500/10 hover:text-rose-300 border border-white/[0.06]")}>
                    {live.voiceActive ? "On" : "Off"}
                </button>
            }>
            <div className="space-y-3">
                {/* Native low-latency mode toggle. Drives the companion
                    engine via shared localStorage + custom event;
                    KeyScalePanel owns the engine lifecycle and mirrors
                    its state back through the meters store. */}
                {NATIVE_ENGINE_UI_ENABLED && (
                    <div className="flex items-center justify-between gap-2">
                        <button
                            onClick={() => {
                                if (!nativeAvailable || !live.voiceActive) return;
                                setNativeMode(!nativeMode);
                            }}
                            disabled={!nativeAvailable || !live.voiceActive}
                            title={
                                !nativeAvailable
                                    ? "MMO Companion not detected. Install + sign in on this device to enable native low-latency audio."
                                    : !live.voiceActive
                                        ? "Turn the Voice Processor ON first to enable the native engine."
                                        : nativeMode
                                            ? "Native mode ON — mic and speakers handled by the companion (RtAudio direct). Browser is bypassed for the autocorrect path."
                                            : "Browser mode — Web Audio worklet (~25 ms total round-trip on Windows, ~12 ms on macOS). Enable native for the lowest possible latency."
                            }
                            className={cn(
                                "flex items-center gap-1.5 h-6 px-2 text-[10px] rounded-full transition-all border cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
                                nativeMode && nativeAvailable && live.voiceActive
                                    ? "bg-purple-500/25 text-purple-200 border-purple-500/40 shadow-[0_0_10px_rgba(168,85,247,0.25)]"
                                    : "bg-white/[0.04] text-white/45 border-white/10 hover:text-white/80 hover:bg-white/[0.08]",
                            )}
                        >
                            <span className="text-[10px]">⚡</span>
                            <span>Native {nativeMode && nativeAvailable && live.voiceActive ? "ON" : "OFF"}</span>
                        </button>
                        <span className="text-[9px] tabular-nums text-white/60">
                            {!nativeAvailable
                                ? <span className="text-white/30">no companion</span>
                                : !live.voiceActive
                                    ? <span className="text-white/30">voice off</span>
                                    : !nativeMode
                                        ? <span className="text-white/40">browser ~25ms</span>
                                        : !nativeRunning
                                            ? nativeError
                                                ? <span className="text-rose-400/80">err</span>
                                                : <span className="text-white/40">starting…</span>
                                            : nativeLatencyMs > 0
                                                ? <span className="text-purple-300">
                                                    {nativeLatencyMs.toFixed(1)}ms
                                                    <span className="text-white/40"> + {nativeDspAvgMs.toFixed(1)}ms dsp</span>
                                                </span>
                                                : <span className="text-white/40">running</span>
                            }
                        </span>
                    </div>
                )}
                {nativeError && nativeMode && live.voiceActive && (
                    <div className="text-[9px] text-rose-400/80 leading-tight">
                        {nativeError}
                    </div>
                )}

                {/* Device selector + gains */}
                <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                        <AudioDeviceSelect
                            kind="input"
                            size="sm"
                            value={
                                voiceNativeInputId !== null && live.voiceInputDeviceId === "default"
                                    ? encodeNativeValue(voiceNativeInputId)
                                    : live.voiceInputDeviceId
                            }
                            onValueChange={(change) => {
                                if (change.source === "native" && change.nativeId !== null) {
                                    // Bridge to the Key & Scale native engine: pick the device,
                                    // turn native mode ON, and notify the panel.
                                    try {
                                        window.localStorage.setItem("mmo-live-native-input-device", String(change.nativeId));
                                        window.localStorage.setItem("mmo-live-keyscale-native", "1");
                                    } catch { /* ignore */ }
                                    setVoiceNativeInputId(change.nativeId);
                                    window.dispatchEvent(new CustomEvent("mmo-live-native-input-changed", {
                                        detail: { id: change.nativeId, autoEnable: true },
                                    }));
                                    // Reset the browser path to default so we don't capture mic twice.
                                    void live.voiceSetInputDevice("default");
                                } else {
                                    try { window.localStorage.removeItem("mmo-live-native-input-device"); } catch { /* ignore */ }
                                    setVoiceNativeInputId(null);
                                    window.dispatchEvent(new CustomEvent("mmo-live-native-input-changed", {
                                        detail: { id: null, autoEnable: false },
                                    }));
                                    void live.voiceSetInputDevice(change.value || "default");
                                }
                            }}
                            placeholder="Default Input"
                            showPermissionHint
                        />
                    </div>
                    <VoiceMeters />
                </div>

                <div className="flex items-center justify-around gap-2 py-1">
                    <div className="flex items-center gap-2">
                        <LiveKnob value={live.voiceInputGain} min={0} max={2} color="#f43f5e" label="Input"
                            onChange={live.voiceSetInputGain} onDoubleClick={() => live.voiceSetInputGain(1)}
                            format={v => `${Math.round(v * 100)}%`} />
                        <NativeKnobMeter direction="input" />
                    </div>
                    <div className="flex items-center gap-2">
                        <NativeKnobMeter direction="output" />
                        <LiveKnob value={live.voiceOutputGain} min={0} max={2} color="#f43f5e" label="Output"
                            onChange={live.voiceSetOutputGain} onDoubleClick={() => live.voiceSetOutputGain(0.85)}
                            format={v => `${Math.round(v * 100)}%`} />
                    </div>
                </div>

                {/* Output device picker — mirrors the one in the settings modal
                    so the user can swap sinks without leaving the panel. The
                    unified picker handles both browser sinks (setSinkId) and
                    companion-side native outputs. */}
                <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                        <AudioDeviceSelect
                            kind="output"
                            size="sm"
                            value={
                                voiceNativeOutputId !== null
                                    ? encodeNativeValue(voiceNativeOutputId)
                                    : (settings.audioOutputDeviceId || "default")
                            }
                            onValueChange={(change) => {
                                if (change.source === "native" && change.nativeId !== null) {
                                    try {
                                        window.localStorage.setItem("mmo-live-native-output-device", String(change.nativeId));
                                    } catch { /* ignore */ }
                                    setVoiceNativeOutputId(change.nativeId);
                                    window.dispatchEvent(new CustomEvent("mmo-live-native-output-changed", {
                                        detail: { id: change.nativeId },
                                    }));
                                } else {
                                    try { window.localStorage.removeItem("mmo-live-native-output-device"); } catch { /* ignore */ }
                                    setVoiceNativeOutputId(null);
                                    window.dispatchEvent(new CustomEvent("mmo-live-native-output-changed", {
                                        detail: { id: null },
                                    }));
                                    void handleBrowserOutputChange(change.value || "default");
                                }
                            }}
                            placeholder="System Default Output"
                        />
                    </div>
                </div>

                {/* Native engine perf row + controls — visible whenever
                    the engine is actively running OR a native device is
                    selected. Both gated on `nativeRunning` so the row
                    doesn't flash on/off when only the device picker has
                    a value but the engine hasn't started yet. */}
                <NativeEnginePerfRow visible={nativeRunning} />

                {NATIVE_ENGINE_UI_ENABLED && nativeRunning && (
                    <div className="flex items-center gap-3 px-2.5 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.04] text-[9px]">
                        <span className="text-white/40 uppercase tracking-wider">Native perf</span>
                        <label className="flex items-center gap-1.5 cursor-pointer text-white/70 hover:text-white"
                            title="Use a 64-sample buffer (~1.3 ms) instead of 128 (~2.7 ms). May cause clicks on weaker drivers. Applies on next engine start.">
                            <input type="checkbox" className="accent-emerald-400 w-3 h-3"
                                checked={nativeUltraLowLatency}
                                onChange={(e) => {
                                    const next = e.target.checked;
                                    setNativeUltraLowLatency(next);
                                    // Ultra-low latency on WASAPI shared is unreliable
                                    // (mixer period is ~10 ms). Pair the toggle with
                                    // exclusive mode so the user actually gets the
                                    // latency they asked for AND focus-stable audio.
                                    // One-way: enabling ultra enables exclusive;
                                    // disabling ultra leaves exclusive as-is so power
                                    // users keep their preferred config.
                                    if (next && !nativeExclusiveMode) {
                                        setNativeExclusiveMode(true);
                                    }
                                }} />
                            Ultra-low latency (64f)
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer text-white/70 hover:text-white"
                            title="Request exclusive access to the device (WASAPI exclusive on Windows). Saves ~2 ms but blocks other apps from playing through the same device. Applies on next engine start.">
                            <input type="checkbox" className="accent-amber-400 w-3 h-3"
                                checked={nativeExclusiveMode}
                                onChange={(e) => setNativeExclusiveMode(e.target.checked)} />
                            Exclusive mode
                        </label>
                        {nativeRunning && (
                            <span className="ml-auto text-emerald-400/60">applies on next start</span>
                        )}
                    </div>
                )}

                {/* Preset selector */}
                <div className="flex items-center gap-1.5">
                    <div className="relative flex-1">
                        <button
                            ref={presetBtnRef}
                            onClick={() => setShowPresetMenu(v => !v)}
                            className="w-full h-8 px-2.5 flex items-center justify-between gap-2 text-[10px] bg-black/40 border border-white/[0.06] rounded-lg hover:border-rose-500/30 transition-colors cursor-pointer"
                            title="Load preset"
                        >
                            <span className="flex items-center gap-1.5 min-w-0">
                                <Sparkles className="w-3 h-3 text-rose-400/60 shrink-0" />
                                <span className={cn("truncate", selectedName ? "text-white/70" : "text-white/35")}>
                                    {selectedName || "Select Preset…"}
                                </span>
                            </span>
                            <ChevronDown className="w-3 h-3 text-white/30 shrink-0" />
                        </button>
                        {showPresetMenu && (
                            <LiveVoicePresetMenu
                                presets={presets}
                                selectedId={selectedPresetId}
                                onSelect={handleLoadPreset}
                                onDelete={handleDeletePreset}
                                onClose={() => setShowPresetMenu(false)}
                                anchorRef={presetBtnRef}
                            />
                        )}
                    </div>
                    <button
                        onClick={handleSavePreset}
                        disabled={live.voiceChain.length === 0}
                        className="h-8 px-2.5 flex items-center gap-1 text-[10px] bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-400/80 hover:bg-rose-500/20 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
                        title="Save current FX chain as preset"
                    >
                        <Save className="w-3 h-3" />
                    </button>
                    <button
                        onClick={() => { live.voiceClearChain(); setSelectedPresetId(""); }}
                        disabled={live.voiceChain.length === 0}
                        className="h-8 px-2.5 flex items-center gap-1 text-[10px] bg-white/[0.04] border border-white/[0.06] rounded-lg text-white/40 hover:bg-white/[0.08] hover:text-white/60 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
                        title="Clear FX chain"
                    >
                        <RotateCcw className="w-3 h-3" />
                    </button>
                </div>

                {/* FX Chain */}
                <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-white/30">
                            FX Chain ({live.voiceChain.length})
                        </span>
                        {live.voiceChain.length > 0 && (
                            <button onClick={live.voiceClearChain}
                                className="text-[9px] text-white/25 hover:text-red-400/60 cursor-pointer">Clear</button>
                        )}
                        <button onClick={() => setShowAddFx(!showAddFx)}
                            className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] bg-rose-500/10 text-rose-400/80 hover:bg-rose-500/20 transition-all cursor-pointer border border-rose-500/15">
                            <Plus className="w-3 h-3" /> Add FX
                        </button>
                    </div>

                    {showAddFx && (
                        <div className="rounded-xl border border-rose-500/15 bg-black/60 backdrop-blur p-3 space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
                            <div className="flex items-center justify-between">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-rose-400/60">Choose Effect</span>
                                <button onClick={() => setShowAddFx(false)} className="text-white/30 hover:text-white/60 cursor-pointer">
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                            {Object.entries(FX_CATEGORIES).map(([key, cat]) => (
                                <div key={key}>
                                    <div className="text-[8px] uppercase tracking-wider text-white/25 mb-1">{cat.label}</div>
                                    <div className="flex flex-wrap gap-1">
                                        {cat.types.map(type => (
                                            <button key={type}
                                                onClick={() => { live.voiceAddEffect(type as FxType); setShowAddFx(false); }}
                                                className="px-2 py-1 rounded-lg text-[9px] bg-white/[0.04] text-white/45 hover:bg-rose-500/15 hover:text-rose-300 transition-all cursor-pointer capitalize border border-transparent hover:border-rose-500/20">
                                                {type.replace(/([A-Z])/g, " $1").trim()}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {live.voiceChain.length === 0 && !showAddFx && (
                        <div className="text-[10px] text-white/20 text-center py-4 rounded-xl border border-dashed border-white/[0.06]">
                            No effects — tap Add FX to start
                        </div>
                    )}

                    <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                        {live.voiceChain.map(fx => <VoiceFxRow key={fx.id} fx={fx} />)}
                    </div>
                </div>
            </div>
        </Section>
    );
}

// ─── Backing Track Panel ─────────────────────────────────────────────────────

function BackingPanel() {
    const live = useLive();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) await live.loadBackingFromFile(file);
        e.target.value = "";
    }, [live]);

    return (
        <Section title="Backing Track" accent="#3b82f6" icon={<Music className="w-3.5 h-3.5 text-blue-400/60" />}
            action={
                <>
                    <input ref={fileInputRef} type="file" accept="audio/*" hidden onChange={handleFile} />
                    <button onClick={() => fileInputRef.current?.click()}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] bg-blue-500/10 text-blue-400/80 hover:bg-blue-500/20 cursor-pointer border border-blue-500/20 transition-all">
                        <Upload className="w-3 h-3" /> Load
                    </button>
                    {live.backingLoaded && (
                        <button onClick={() => void live.unloadBacking()}
                            className="text-white/25 hover:text-red-400/60 cursor-pointer">
                            <X className="w-3.5 h-3.5" />
                        </button>
                    )}
                </>
            }>
            {!live.backingLoaded ? (
                <div className="text-[11px] text-white/25 text-center py-6 rounded-xl border border-dashed border-white/[0.06]">
                    No backing track loaded — drop or load an audio file
                </div>
            ) : (
                <div className="space-y-3">
                    {/* Track name */}
                    <div className="flex items-center gap-2">
                        <Disc3 className={cn("w-4 h-4 text-blue-400/70 shrink-0", live.backingIsPlaying && "animate-spin")} />
                        <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium text-white/70 truncate">{live.backingName}</div>
                            <BackingPositionLabel duration={live.backingDuration} />
                        </div>
                    </div>

                    {/* Progress / seek */}
                    <BackingProgressBar
                        duration={live.backingDuration}
                        onSeek={live.backingSeek}
                    />

                    {/* Transport */}
                    <div className="flex items-center gap-2">
                        <button onClick={live.backingToggle}
                            className={cn("flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-medium text-xs transition-all cursor-pointer",
                                live.backingIsPlaying
                                    ? "bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-[0_0_8px_rgba(59,130,246,0.15)]"
                                    : "bg-white/[0.04] text-white/40 hover:bg-white/[0.08] border border-white/[0.06]")}>
                            {live.backingIsPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                            {live.backingIsPlaying ? "Pause" : "Play"}
                        </button>
                        <button onClick={live.backingStop}
                            className="flex items-center justify-center w-10 h-10 rounded-xl bg-white/[0.04] text-white/40 hover:bg-white/[0.08] border border-white/[0.06] cursor-pointer">
                            <Square className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => live.setBackingLoop(!live.backingLoopActive)}
                            className={cn("flex items-center justify-center w-10 h-10 rounded-xl border transition-all cursor-pointer",
                                live.backingLoopActive
                                    ? "bg-purple-500/20 text-purple-400 border-purple-500/30"
                                    : "bg-white/[0.04] text-white/40 hover:bg-white/[0.08] border-white/[0.06]")}>
                            <Repeat className="w-3.5 h-3.5" />
                        </button>
                    </div>

                    {/* Knobs */}
                    <div className="flex items-center justify-around gap-2 pt-1">
                        <LiveKnob value={live.backingVolume} min={0} max={2} color="#3b82f6" label="Vol"
                            onChange={live.setBackingVolume} onDoubleClick={() => live.setBackingVolume(0.85)}
                            format={v => `${Math.round(v * 100)}%`} />
                        <LiveKnob value={live.backingTempoRatio} min={0.5} max={1.5} color="#3b82f6" label="Tempo"
                            onChange={live.setBackingTempoRatio} onDoubleClick={() => live.setBackingTempoRatio(1)}
                            format={v => `${Math.round(v * 100)}%`} />
                        <LiveKnob value={live.backingPitchSemis} min={-12} max={12} color="#3b82f6" label="Pitch"
                            onChange={live.setBackingPitchSemis} onDoubleClick={() => live.setBackingPitchSemis(0)}
                            format={v => `${v > 0 ? "+" : ""}${v}st`} />
                    </div>
                </div>
            )}
        </Section>
    );
}

// ─── Looper Panel ────────────────────────────────────────────────────────────

function LooperBank() {
    const live = useLive();

    const stateColor = (s: string) => {
        switch (s) {
            case "recording": return "#ef4444";
            case "playing": return "#10b981";
            case "stopped": return "#eab308";
            default: return "#6b7280";
        }
    };

    return (
        <Section title="Looper" accent="#a855f7" icon={<Repeat className="w-3.5 h-3.5 text-purple-400/60" />}
            action={
                <button onClick={live.stopAllLoopers}
                    className="text-[10px] px-2 py-1 rounded-lg bg-white/[0.04] text-white/40 hover:bg-purple-500/15 hover:text-purple-300 cursor-pointer transition-all border border-white/[0.06]">
                    Stop All
                </button>
            }>
            <div className="grid grid-cols-2 gap-2">
                {live.loopers.map(loop => {
                    const color = stateColor(loop.state);
                    const isActive = loop.state === "recording" || loop.state === "playing";
                    return (
                        <div key={loop.id} className={cn(
                            "rounded-xl border p-2.5 transition-all overflow-hidden",
                            loop.state === "recording" ? "border-red-500/40 bg-red-500/5 shadow-[0_0_10px_rgba(239,68,68,0.15)]"
                                : loop.state === "playing" ? "border-emerald-500/30 bg-emerald-500/5"
                                    : "border-white/[0.06] bg-white/[0.02]"
                        )}>
                            <div className="flex items-center gap-2 mb-2">
                                <div className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs"
                                    style={{ backgroundColor: `${color}25`, color }}>
                                    {loop.id + 1}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color }}>
                                        {loop.state}
                                    </div>
                                    {loop.buffer && (
                                        <div className="text-[8px] text-white/30 tabular-nums">
                                            {loop.durationBeats.toFixed(1)} beats
                                        </div>
                                    )}
                                </div>
                                {loop.buffer && (
                                    <button onClick={() => live.clearLooper(loop.id)}
                                        className="text-white/20 hover:text-red-400/60 cursor-pointer">
                                        <Trash2 className="w-3 h-3" />
                                    </button>
                                )}
                            </div>
                            <button onClick={() => live.toggleLooper(loop.id)}
                                className={cn("w-full py-2 rounded-lg text-xs font-bold uppercase tracking-wider cursor-pointer transition-all",
                                    loop.state === "empty" ? "bg-white/[0.04] text-white/40 hover:bg-red-500/15 hover:text-red-300 border border-white/[0.06]"
                                        : loop.state === "recording" ? "bg-red-500/25 text-red-400 border border-red-500/40 animate-pulse"
                                            : loop.state === "playing" ? "bg-emerald-500/25 text-emerald-400 border border-emerald-500/40"
                                                : "bg-amber-500/15 text-amber-400 border border-amber-500/25")}>
                                {loop.state === "empty" ? "● Rec" : loop.state === "recording" ? "■ Stop" : loop.state === "playing" ? "❚❚ Pause" : "▶ Play"}
                            </button>
                            <div className="flex items-center gap-1.5 mt-2">
                                <button onClick={() => live.toggleLooperMute(loop.id)}
                                    className={cn("w-7 h-7 rounded flex items-center justify-center text-[9px] cursor-pointer",
                                        loop.muted ? "bg-white/10 text-white/30" : "bg-white/[0.03] text-white/40")}>
                                    {loop.muted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                                </button>
                                <input type="range" min={0} max={2} step={0.01} value={loop.volume}
                                    onChange={e => live.setLooperVolume(loop.id, parseFloat(e.target.value))}
                                    className="flex-1 accent-purple-500" />
                            </div>
                        </div>
                    );
                })}
            </div>
        </Section>
    );
}

// ─── Pads Panel ──────────────────────────────────────────────────────────────

function PadGrid() {
    const live = useLive();

    return (
        <Section title="Pads" accent="#eab308" icon={<Sparkles className="w-3.5 h-3.5 text-yellow-400/60" />}>
            <div className="grid grid-cols-4 gap-2">
                {live.pads.map(pad => <PadButton key={pad.id} pad={pad} />)}
            </div>
        </Section>
    );
}

function PadButton({ pad }: { pad: { id: number; name: string; color: string; buffer: AudioBuffer | null; isPlaying: boolean; volume: number; loop: boolean } }) {
    const live = useLive();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [showSettings, setShowSettings] = useState(false);

    const handleFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) await live.loadPad(pad.id, file);
        e.target.value = "";
    }, [live, pad.id]);

    const handleDrop = useCallback(async (e: React.DragEvent) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        if (file?.type.startsWith("audio/")) await live.loadPad(pad.id, file);
    }, [live, pad.id]);

    return (
        <div className="relative">
            <input ref={fileInputRef} type="file" accept="audio/*" hidden onChange={handleFile} />
            <button
                onClick={() => pad.buffer ? live.triggerPad(pad.id) : fileInputRef.current?.click()}
                onContextMenu={(e) => { e.preventDefault(); setShowSettings(s => !s); }}
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                className={cn(
                    "relative w-full aspect-square rounded-xl border transition-all duration-150 cursor-pointer overflow-hidden flex flex-col items-center justify-center gap-1 active:scale-95",
                    pad.buffer
                        ? pad.isPlaying ? "shadow-[0_0_16px_var(--pad-color)]" : "hover:scale-[1.02]"
                        : "border-dashed border-white/[0.08] hover:border-white/[0.15] bg-white/[0.01]"
                )}
                style={pad.buffer ? {
                    "--pad-color": pad.color,
                    backgroundColor: pad.isPlaying ? `${pad.color}30` : `${pad.color}12`,
                    borderColor: pad.isPlaying ? pad.color : `${pad.color}40`,
                } as React.CSSProperties : undefined}>
                {pad.buffer ? (
                    <>
                        <div className="text-[10px] font-bold uppercase tracking-wider truncate max-w-full px-1"
                            style={{ color: pad.color }}>
                            {pad.name}
                        </div>
                        <div className="text-[8px] text-white/40 absolute bottom-1 left-1.5">
                            {pad.id + 1}
                        </div>
                        {pad.loop && (
                            <Repeat className="w-2.5 h-2.5 absolute top-1 right-1" style={{ color: pad.color }} />
                        )}
                    </>
                ) : (
                    <>
                        <Plus className="w-5 h-5 text-white/15" />
                        <span className="text-[8px] text-white/20 uppercase tracking-wider">Pad {pad.id + 1}</span>
                    </>
                )}
                {pad.isPlaying && (
                    <div className="absolute inset-0 rounded-xl pointer-events-none border-2 animate-pulse"
                        style={{ borderColor: pad.color }} />
                )}
            </button>
            {showSettings && pad.buffer && (
                <div className="absolute z-10 top-full mt-1 left-0 right-0 rounded-xl bg-black/90 border border-white/10 backdrop-blur p-2 space-y-2 animate-in fade-in slide-in-from-top-1 duration-150">
                    <div className="flex items-center gap-2">
                        <Volume2 className="w-3 h-3 text-white/40" />
                        <input type="range" min={0} max={2} step={0.01} value={pad.volume}
                            onChange={e => live.setPadVolume(pad.id, parseFloat(e.target.value))}
                            className="flex-1 accent-yellow-500" />
                    </div>
                    <button onClick={() => live.setPadLoop(pad.id, !pad.loop)}
                        className={cn("w-full py-1 rounded text-[10px] cursor-pointer",
                            pad.loop ? "bg-yellow-500/20 text-yellow-400" : "bg-white/[0.05] text-white/40")}>
                        {pad.loop ? "Loop On" : "One-Shot"}
                    </button>
                    <button onClick={() => live.stopPad(pad.id)}
                        className="w-full py-1 rounded text-[10px] bg-white/[0.05] text-white/40 hover:bg-white/[0.08] cursor-pointer">
                        Stop
                    </button>
                    <button onClick={() => { live.clearPad(pad.id); setShowSettings(false); }}
                        className="w-full py-1 rounded text-[10px] bg-red-500/10 text-red-400/60 hover:bg-red-500/20 cursor-pointer">
                        Clear
                    </button>
                </div>
            )}
        </div>
    );
}

// ─── Key & Scale Picker ──────────────────────────────────────────────────────

/**
 * LED-style meter that visualises the auto-correct in real time, like
 * the front-panel LEDs on a Tascam TA-1VP / Antares Auto-Tune Evo.
 *
 * Top row  — input cents deviation from the corrector's target note.
 *            Centre LED = on pitch; LEDs left = flat; LEDs right = sharp.
 * Bottom   — large note pill showing what the corrector is steering
 *            *towards*, with the live correction amount in cents.
 */
function AutoCorrectLedMeter({
    sourceMidi,
    targetMidi,
    semitones,
    confidence,
    rms,
    quality,
    notations,
}: {
    sourceMidi: number | null;
    targetMidi: number | null;
    semitones: number;
    confidence: number;
    rms: number;
    quality: "major" | "minor";
    notations: NoteNotation[];
}) {
    // Cents the input is OFF the target (positive = sharp).
    // semitones holds the corrector's applied shift in semitones; the input
    // is exactly -semitones away from the target (we ignore the user's
    // Amount slider here so the meter always shows the *raw* deviation).
    const inputCentsRaw = sourceMidi !== null && targetMidi !== null
        ? (sourceMidi - targetMidi) * 100
        : 0;
    // Clamp to ±50 cents for the meter scale.
    const inputCents = Math.max(-50, Math.min(50, inputCentsRaw));
    const correctionCents = -semitones * 100; // applied correction, signed

    // 21 LEDs (10 left, 1 centre, 10 right), 5 cents per LED.
    const LED_COUNT = 21;
    const ledIndex = Math.round((inputCents + 50) / 100 * (LED_COUNT - 1));
    const centreIdx = (LED_COUNT - 1) / 2;

    const hasSignal = confidence > 0.05 && rms > 0.0008 && targetMidi !== null;
    const targetLabel = targetMidi !== null
        ? notations.map(n => formatPitch(targetMidi, n, quality)).join(" / ")
        : "—";

    return (
        <div className="space-y-1.5">
            {/* Header: detected → target with correction amount in cents. */}
            <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-1.5">
                    <span className="text-[9px] uppercase tracking-wider text-emerald-300/60">Target</span>
                    <span className={cn(
                        "text-base font-semibold tabular-nums leading-none transition-colors",
                        hasSignal ? "text-emerald-200" : "text-white/20",
                    )}>
                        {targetLabel}
                    </span>
                </div>
                <div className="text-[9px] tabular-nums text-emerald-300/70">
                    {hasSignal ? (
                        <>
                            <span className="text-white/40">corr</span>{" "}
                            <span className={cn(
                                Math.abs(correctionCents) < 5 ? "text-emerald-300"
                                    : Math.abs(correctionCents) < 25 ? "text-yellow-300/80"
                                        : "text-orange-300",
                            )}>
                                {correctionCents >= 0 ? "+" : ""}{correctionCents.toFixed(0)}¢
                            </span>
                        </>
                    ) : rms > 0.0005 ? "listening…" : "no input"}
                </div>
            </div>

            {/* LED bar: shows input deviation from target. */}
            <div className="flex items-center justify-between gap-[2px] h-3 px-0.5">
                {Array.from({ length: LED_COUNT }, (_, i) => {
                    // distance from this LED to the lit one
                    const dist = Math.abs(i - ledIndex);
                    // distance from this LED to centre (target)
                    const distFromCentre = Math.abs(i - centreIdx);
                    let color = "bg-white/10";
                    let glow = "";
                    if (hasSignal) {
                        if (dist === 0) {
                            // The lit LED — coloured by how far off pitch we are.
                            if (distFromCentre <= 1) {
                                color = "bg-emerald-400";
                                glow = "shadow-[0_0_6px_rgba(16,185,129,0.9)]";
                            } else if (distFromCentre <= 4) {
                                color = "bg-yellow-300";
                                glow = "shadow-[0_0_6px_rgba(253,224,71,0.85)]";
                            } else {
                                color = i < centreIdx ? "bg-sky-400" : "bg-rose-400";
                                glow = i < centreIdx
                                    ? "shadow-[0_0_6px_rgba(56,189,248,0.85)]"
                                    : "shadow-[0_0_6px_rgba(251,113,133,0.85)]";
                            }
                        } else if (dist === 1) {
                            // Trailing LED for soft glow.
                            color = i < centreIdx ? "bg-sky-400/30" : i > centreIdx ? "bg-rose-400/30" : "bg-emerald-400/30";
                        }
                    }
                    // Thicker centre LED for "in tune" reference.
                    const isCentre = i === centreIdx;
                    return (
                        <span
                            key={i}
                            className={cn(
                                "flex-1 rounded-sm transition-colors duration-75",
                                isCentre ? "h-3" : "h-2",
                                color,
                                glow,
                                isCentre && !hasSignal && "bg-white/20",
                            )}
                        />
                    );
                })}
            </div>

            {/* Cents scale labels. */}
            <div className="flex items-center justify-between text-[8px] text-white/25 px-0.5 -mt-0.5 tabular-nums">
                <span>-50¢</span>
                <span>-25</span>
                <span>0</span>
                <span>+25</span>
                <span>+50¢</span>
            </div>
        </div>
    );
}

function KeyScalePanel() {
    const live = useLive();
    const settings = useLiveSettings();
    // User-controlled UI refresh rate — governs how often we mirror native
    // pitch / level data into the meter store and update acStatus. Without
    // this throttle the WS push runs at ~30–40 Hz and bypassed the slider.
    const [hz] = useUIRefreshHz();
    const scaleName = MUSICAL_SCALES[live.scaleIndex]?.name ?? "";
    const quality: "major" | "minor" = /major/i.test(scaleName) ? "major" : "minor";

    // ── Native low-latency mode ───────────────────────────────────────
    //
    // When `nativeMode` is ON and a local companion is reachable, the
    // mic→DSP→speakers path runs ENTIRELY in the Electron companion
    // (RtAudio + native PitchDsp). The browser audio engine still owns
    // the deck/master path; only the autocorrect bypass changes.
    //
    // When OFF (or when the companion is not available), we fall back
    // to the AudioWorklet path that already exists below.
    //
    // The toggle is persisted in localStorage and shared with VoicePanel
    // via a custom window event so either panel can drive it. While
    // `NATIVE_ENGINE_UI_ENABLED` is false the UI is hidden everywhere
    // and the auto-init below clears any stale "1" so the engine never
    // starts headlessly.
    const [nativeMode, setNativeMode] = useSharedLocalStorageBool("mmo-live-keyscale-native", false);
    useEffect(() => {
        if (!NATIVE_ENGINE_UI_ENABLED && nativeMode) setNativeMode(false);
    }, [nativeMode, setNativeMode]);
    const [nativeAvailable, setNativeAvailable] = useState<boolean>(false);
    const [nativeRunning, setNativeRunning] = useState<boolean>(false);
    const [nativeError, setNativeError] = useState<string | null>(null);
    const [nativeMetrics, setNativeMetrics] = useState<NativeMetrics | null>(null);
    const [nativeInputDevices, setNativeInputDevices] = useState<NativeDeviceInfo[]>([]);

    // Performance toggles: shared with VoicePanel via localStorage + a
    // custom window event so the user's checkboxes there feed straight
    // into the start config here. Read via a ref so toggling does NOT
    // re-trigger the start effect (auto-restart on every checkbox click
    // would fire RtAudio's sync openStream, blocking the main thread for
    // 0.5–2 s and causing visible UI flashes). The hint "applies on next
    // start" matches this behaviour: the user toggles native off→on, or
    // changes a device, to apply.
    const [nativeUltraLowLatency] = useSharedLocalStorageBool("mmo-live-native-ultra-latency", false);
    const [nativeExclusiveMode, setNativeExclusiveModeShared] = useSharedLocalStorageBool("mmo-live-native-exclusive", false);
    const nativePerfRef = useRef({ ultra: nativeUltraLowLatency, exclusive: nativeExclusiveMode });
    useEffect(() => {
        nativePerfRef.current = { ultra: nativeUltraLowLatency, exclusive: nativeExclusiveMode };
    }, [nativeUltraLowLatency, nativeExclusiveMode]);

    // Forced restart counter — bumped by the "Switch to Exclusive" hint
    // (and any other UI affordance that explicitly wants the engine
    // re-opened with new settings). Wired into the start effect's deps
    // so a +1 here triggers a clean stop-then-start cycle. We deliberately
    // do NOT auto-restart on every nativeExclusiveMode change — the
    // checkboxes use the "applies on next start" pattern to keep
    // toggling cheap. This counter is the explicit "do it now" path.
    const [nativeRestartGen, setNativeRestartGen] = useState(0);
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ exclusive?: boolean; ultra?: boolean }>).detail;
            if (detail?.exclusive === true) setNativeExclusiveModeShared(true);
            if (detail?.exclusive === false) setNativeExclusiveModeShared(false);
            // Bump on next tick so the localStorage write + ref mirror
            // effect have flushed before the start effect re-runs.
            window.setTimeout(() => setNativeRestartGen(g => g + 1), 0);
        };
        window.addEventListener("mmo-live-native-restart", handler);
        return () => window.removeEventListener("mmo-live-native-restart", handler);
    }, [setNativeExclusiveModeShared]);
    // Persist the last selected native input device id (RtAudio numeric id).
    // The id space is platform/backend-specific so it's not portable across
    // machines, but it's stable across reboots on the same setup.
    const [nativeInputDeviceId, setNativeInputDeviceIdState] = useState<number | null>(() => {
        if (typeof window === "undefined") return null;
        const raw = localStorage.getItem("mmo-live-native-input-device");
        if (raw == null) return null;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : null;
    });
    const setNativeInputDeviceId = useCallback((id: number | null) => {
        setNativeInputDeviceIdState(id);
        try {
            if (id == null) localStorage.removeItem("mmo-live-native-input-device");
            else localStorage.setItem("mmo-live-native-input-device", String(id));
        } catch { /* ignore */ }
    }, []);
    // Bridge: the Voice Processor's unified device picker can request a native
    // input + auto-engage native mode. Listen for that and mirror state here so
    // both panels stay in sync without extra plumbing.
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ id: number | null; autoEnable?: boolean }>).detail;
            if (!detail) return;
            setNativeInputDeviceIdState(detail.id);
            if (detail.autoEnable) setNativeMode(true);
        };
        window.addEventListener("mmo-live-native-input-changed", handler);
        return () => window.removeEventListener("mmo-live-native-input-changed", handler);
    }, []);
    // Same bridge for the output device. Persisted under its own key so the
    // engine restart effect can include it in the start config.
    const [nativeOutputDeviceId, setNativeOutputDeviceIdState] = useState<number | null>(() => {
        if (typeof window === "undefined") return null;
        const raw = localStorage.getItem("mmo-live-native-output-device");
        if (raw == null) return null;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : null;
    });
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ id: number | null }>).detail;
            if (!detail) return;
            setNativeOutputDeviceIdState(detail.id);
        };
        window.addEventListener("mmo-live-native-output-changed", handler);
        return () => window.removeEventListener("mmo-live-native-output-changed", handler);
    }, []);
    const nativeClientRef = useRef<NativeCompanionClient | null>(null);
    const nativePitchRef = useRef<{ pitch: NativePitch; status: NativeStatus | null } | null>(null);

    // Probe + acquire credentials. Runs on mount and then keeps re-probing
    // until a companion is reachable, so launching the app AFTER the /live
    // tab is already open flips the "no companion" state to "available"
    // automatically. Also re-probes on tab focus + when the browser regains
    // network connectivity, so the user doesn't have to refresh the page.
    useEffect(() => {
        let cancelled = false;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        // Retry interval grows from 2 s → 10 s with a small jitter so we
        // don't hammer the localhost ports if the user never installs the
        // companion. Once a companion is found we stop polling entirely.
        let nextDelayMs = 2000;
        const probe = async () => {
            if (cancelled) return;
            try {
                const hit = await discoverCompanion();
                if (cancelled) return;
                if (!hit) {
                    setNativeAvailable(false);
                    schedule();
                    return;
                }
                nativeClientRef.current = new NativeCompanionClient({ apiUrl: hit.apiUrl });
                setNativeAvailable(true);
                // Fetch device list once we know a companion is reachable
                // so the UI dropdown can populate even before native mode
                // is on.
                try {
                    const { devices } = await nativeClientRef.current.devices("auto");
                    if (cancelled) return;
                    const inputs = devices.filter((d) => d.inputChannels > 0);
                    setNativeInputDevices(inputs);
                    if (nativeInputDeviceId != null && !inputs.some((d) => d.id === nativeInputDeviceId)) {
                        setNativeInputDeviceId(null);
                    }
                } catch { /* device list is best-effort */ }
            } catch {
                if (cancelled) return;
                setNativeAvailable(false);
                schedule();
            }
        };
        const schedule = () => {
            if (cancelled) return;
            const jitter = Math.random() * 500;
            retryTimer = setTimeout(probe, nextDelayMs + jitter);
            nextDelayMs = Math.min(10_000, Math.round(nextDelayMs * 1.5));
        };
        // Re-probe immediately when the tab regains focus or the network
        // comes back \u2014 covers the common flow of installing/launching the
        // companion while the /live tab is open in the background.
        const onFocus = () => {
            if (!nativeClientRef.current) {
                nextDelayMs = 2000;
                void probe();
            }
        };
        window.addEventListener("focus", onFocus);
        window.addEventListener("online", onFocus);
        void probe();
        return () => {
            cancelled = true;
            if (retryTimer) clearTimeout(retryTimer);
            window.removeEventListener("focus", onFocus);
            window.removeEventListener("online", onFocus);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // (nativeMode is persisted by useSharedLocalStorageBool above.)

    // ── Auto-correct (live re-tune) ──────────────────────────────────
    const [autoCorrectOn, setAutoCorrectOn] = useState<boolean>(() => {
        if (typeof window === "undefined") return false;
        return localStorage.getItem("mmo-live-keyscale-autocorrect") === "1";
    });
    const [autoCorrectSpeed, setAutoCorrectSpeed] = useState<number>(() => {
        if (typeof window === "undefined") return 0.030;
        const raw = localStorage.getItem("mmo-live-keyscale-autocorrect-speed");
        const n = raw ? parseFloat(raw) : NaN;
        // Default 30 ms — close to T-Pain hard-tune feel, but the
        // soft-knee humanizer in the engine keeps natural vibrato
        // intact. The audible lag the user perceives is dominated by
        // pitch-detection (~21 ms YIN window) and shifter group delay
        // (~10 ms half-grain), not this time constant — so we set it
        // small to stop adding to the total reaction time.
        return Number.isFinite(n) ? Math.max(0.005, Math.min(0.5, n)) : 0.030;
    });
    const [autoCorrectAmount, setAutoCorrectAmount] = useState<number>(() => {
        if (typeof window === "undefined") return 1;
        const raw = localStorage.getItem("mmo-live-keyscale-autocorrect-amount");
        const n = raw ? parseFloat(raw) : NaN;
        return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
    });
    const [autoCorrectFormant, setAutoCorrectFormant] = useState<boolean>(() => {
        if (typeof window === "undefined") return true;
        return localStorage.getItem("mmo-live-keyscale-autocorrect-formant") !== "0";
    });
    // Root-lock: when ON, every input snaps to the SELECTED key root
    // (any octave) regardless of the chosen scale. "Re Major" with
    // root-lock means: every note becomes a D, period. When OFF, the
    // corrector behaves as classic Auto-Tune scale-snap (snap to nearest
    // note IN the scale — so D Major still allows E, F#, G, A, B, C#).
    // Default ON because that matches user expectation when they pick a
    // single key like "Re Major".
    const [autoCorrectRootLock, setAutoCorrectRootLock] = useState<boolean>(() => {
        if (typeof window === "undefined") return true;
        return localStorage.getItem("mmo-live-keyscale-autocorrect-rootlock") !== "0";
    });

    // Built-in auto-correct: lives outside the user-managed FX chain. We
    // ask the engine to insert a pitch-shifter between the chain output and
    // the engine output, then push the user's selected scale + tuning
    // params. The engine drives the pitchRatio param itself in a 30 Hz
    // internal loop so we don't depend on React effects firing.
    const autoCorrectNodeRef = useRef<AudioWorkletNode | null>(null);

    useEffect(() => {
        try {
            localStorage.setItem("mmo-live-keyscale-autocorrect", autoCorrectOn ? "1" : "0");
            localStorage.setItem("mmo-live-keyscale-autocorrect-speed", String(autoCorrectSpeed));
            localStorage.setItem("mmo-live-keyscale-autocorrect-amount", String(autoCorrectAmount));
            localStorage.setItem("mmo-live-keyscale-autocorrect-formant", autoCorrectFormant ? "1" : "0");
            localStorage.setItem("mmo-live-keyscale-autocorrect-rootlock", autoCorrectRootLock ? "1" : "0");
            window.dispatchEvent(new Event("mmo-preference-changed"));
        } catch { /* */ }
    }, [autoCorrectOn, autoCorrectSpeed, autoCorrectAmount, autoCorrectFormant, autoCorrectRootLock]);

    // Activate / deactivate the engine's built-in auto-correct shifter.
    useEffect(() => {
        const engine = live.engine;
        if (!engine) return;
        // When native mode is requested AND a companion is reachable, the
        // browser audio path stays disabled — the autocorrect runs entirely
        // inside the companion. Don't engage the worklet shifter.
        if (nativeMode && nativeAvailable) {
            void engine.voice.setAutoCorrectEnabled(false);
            return;
        }
        let cancelled = false;
        void engine.voice.setAutoCorrectEnabled(autoCorrectOn).then((node) => {
            if (cancelled) return;
            autoCorrectNodeRef.current = node;
            // Apply formant preserve flag once the worklet is up.
            engine.voice.setAutoCorrectFormantPreserve(autoCorrectFormant);
        });
        return () => { cancelled = true; };
    }, [autoCorrectOn, live.engine, autoCorrectFormant, nativeMode, nativeAvailable]);

    // Push formant-preserve flag separately so toggling it without re-creating
    // the worklet still takes effect (otherwise we'd recreate the audio node).
    useEffect(() => {
        const engine = live.engine;
        if (!engine || !autoCorrectOn) return;
        if (nativeMode && nativeAvailable) return;
        engine.voice.setAutoCorrectFormantPreserve(autoCorrectFormant);
    }, [autoCorrectFormant, autoCorrectOn, live.engine, nativeMode, nativeAvailable]);

    // Tear-down: always disable the shifter when the panel unmounts so we
    // don't leave an orphan correction node in the audio path.
    useEffect(() => {
        return () => {
            const engine = live.engine;
            if (!engine) return;
            void engine.voice.setAutoCorrectEnabled(false);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Push scale + tuning config to the engine whenever it changes. The
    // engine's internal driver loop will pick this up and drive pitchRatio
    // independently of React/UI tick rates.
    useEffect(() => {
        const engine = live.engine;
        if (!engine || !autoCorrectOn) return;
        if (nativeMode && nativeAvailable) return;
        const scale = MUSICAL_SCALES[live.scaleIndex];
        // Root-lock collapses the allowed pitch-class set to the tonic
        // alone (intervals=[0]) so the shifter snaps every input to the
        // selected key root in the closest octave. Otherwise we honour
        // the full scale.
        const intervals = autoCorrectRootLock ? [0] : (scale?.intervals ?? []);
        engine.voice.setAutoCorrectScale({
            keyIndex: live.keyIndex,
            intervals,
            amount: autoCorrectAmount,
            speed: autoCorrectSpeed,
        });
    }, [autoCorrectOn, autoCorrectSpeed, autoCorrectAmount, autoCorrectRootLock, live.keyIndex, live.scaleIndex, live.engine, nativeMode, nativeAvailable]);

    // ── Native engine lifecycle ───────────────────────────────────────
    //
    // Driven from the same toggles as the browser path, but goes to the
    // companion's HTTP+WS API. When `autoCorrectOn` flips OFF while in
    // native mode we keep the engine running with autocorrect bypassed
    // (so the user can hear monitor with no DSP for free, dirty-passthrough).
    useEffect(() => {
        const client = nativeClientRef.current;
        // Native engine is gated on the Voice Processor master switch:
        // if voice is off, the user expects silence — don't run the
        // companion DSP either. Stops cleanly when `voiceActive` flips off.
        if (!nativeMode || !nativeAvailable || !client || !live.voiceActive) {
            // If we previously started, stop now.
            if (nativeRunning && client) {
                void client.stop().catch(() => { /* ignore */ });
                client.disconnectWs();
                setNativeRunning(false);
            }
            return;
        }
        let cancelled = false;
        const scale = MUSICAL_SCALES[live.scaleIndex];
        const intervals = autoCorrectRootLock ? [0] : (scale?.intervals ?? []);
        (async () => {
            try {
                setNativeError(null);
                client.connectWs();
                const res = await client.start({
                    inputDeviceId: nativeInputDeviceId ?? undefined,
                    outputDeviceId: nativeOutputDeviceId ?? undefined,
                    autoCorrect: autoCorrectOn,
                    formantPreserve: autoCorrectFormant,
                    scale: { keyIndex: live.keyIndex, intervals, amount: autoCorrectAmount },
                    sampleRate: 48000,
                    // frameSize 0 = "let the engine pick the best value
                    // for the resolved backend + exclusive-mode combo".
                    // The native engine knows that WASAPI shared can't go
                    // below the OS mixer period (~10ms / 480 frames) but
                    // ASIO and WASAPI exclusive can hit ~64–128 frames
                    // reliably. Ultra mode forces the absolute minimum
                    // (128) regardless of backend — only safe when the
                    // user has also enabled exclusive mode or has ASIO.
                    frameSize: nativePerfRef.current.ultra ? 128 : 0,
                    minimizeLatency: nativePerfRef.current.ultra,
                    realtimeSchedule: true,
                    exclusiveMode: nativePerfRef.current.exclusive,
                });
                if (cancelled) return;
                setNativeMetrics(res.metrics);
                setNativeRunning(true);
            } catch (err) {
                if (cancelled) return;
                setNativeError(err instanceof Error ? err.message : String(err));
                setNativeRunning(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nativeMode, nativeAvailable, nativeInputDeviceId, nativeOutputDeviceId, live.voiceActive, nativeRestartGen]);

    // Push native scale/autocorrect changes when in native mode.
    useEffect(() => {
        const client = nativeClientRef.current;
        if (!nativeMode || !nativeAvailable || !client || !nativeRunning) return;
        const scale = MUSICAL_SCALES[live.scaleIndex];
        const intervals = autoCorrectRootLock ? [0] : (scale?.intervals ?? []);
        void client.setScale({ keyIndex: live.keyIndex, intervals, amount: autoCorrectAmount }).catch(() => { /* ignore */ });
    }, [nativeMode, nativeAvailable, nativeRunning, live.keyIndex, live.scaleIndex, autoCorrectRootLock, autoCorrectAmount]);

    useEffect(() => {
        const client = nativeClientRef.current;
        if (!nativeMode || !nativeAvailable || !client || !nativeRunning) return;
        void client.setAutoCorrect({
            enabled: autoCorrectOn,
            formantPreserve: autoCorrectFormant,
        }).catch(() => { /* ignore */ });
    }, [nativeMode, nativeAvailable, nativeRunning, autoCorrectOn, autoCorrectFormant]);

    // Mirror the user's voice FX chain into the native engine while
    // native mode is active. Browser-only insert types are dropped
    // server-side, so we don't need to filter here. Stable insert ids
    // mean an in-place knob change reuses the existing native DSP
    // instance — no buffer flush, no clicks. Runs on every chain
    // mutation (add / remove / reorder / toggle / param tweak).
    useEffect(() => {
        const client = nativeClientRef.current;
        if (!nativeMode || !nativeAvailable || !client || !nativeRunning) return;
        const items = live.voiceChain.map(i => ({
            id: i.id,
            type: i.type as never,    // engine filters unsupported types
            enabled: i.enabled,
            params: i.params,
        }));
        void client.setFxChain(items).catch(() => { /* ignore */ });
    }, [nativeMode, nativeAvailable, nativeRunning, live.voiceChain]);

    // Stop native engine on panel unmount.
    useEffect(() => {
        return () => {
            const client = nativeClientRef.current;
            if (!client) return;
            void client.stop().catch(() => { /* */ });
            client.disconnectWs();
        };
    }, []);

    // Stop the companion engine when the page is being unloaded (tab
    // close, refresh, navigation away). React cleanup is unreliable here
    // because the renderer is torn down before async fetches resolve, so
    // we use `sendBeacon` which the browser guarantees to deliver during
    // unload. Without this, sound keeps playing on the user's speakers
    // until they manually quit the companion app. We listen for both
    // `pagehide` (the modern unload signal, fires for bfcache too) and
    // `beforeunload` (older but still required by some browsers).
    useEffect(() => {
        const fire = () => {
            const client = nativeClientRef.current;
            if (!client) return;
            client.stopBeacon();
        };
        window.addEventListener("pagehide", fire);
        window.addEventListener("beforeunload", fire);
        return () => {
            window.removeEventListener("pagehide", fire);
            window.removeEventListener("beforeunload", fire);
        };
    }, []);

    // Subscribe to native pitch (WS-pushed) when in native mode. The
    // listener just stashes the latest payload into a ref — the throttled
    // mirror effect below decides when to push it into the React store /
    // local acStatus, so the WS rate (~40 Hz) doesn't bypass the user's
    // refresh slider.
    useEffect(() => {
        const client = nativeClientRef.current;
        if (!nativeMode || !nativeAvailable || !client) return;
        const off = client.addPitchListener((p, s) => {
            nativePitchRef.current = { pitch: p, status: s };
        });
        return () => { off(); };
    }, [nativeMode, nativeAvailable]);

    // Bridge native level + perf push into the live meters store so VoicePanel
    // (and any other meter consumer) can render bars/numbers without owning
    // a WebSocket subscription itself. The handler stashes the latest payload
    // into a ref — the actual store patch is done by the throttled mirror
    // effect below at the user's UI hz, so a 30 Hz WS push doesn't bypass
    // a 1 Hz slider setting.
    const nativeLevelsRef = useRef<{ levels: NativeLevels; perf: NativePerf } | null>(null);
    useEffect(() => {
        const client = nativeClientRef.current;
        if (!nativeMode || !nativeAvailable || !client) {
            nativeLevelsRef.current = null;
            liveMetersStore.patch({
                nativeInPeak: 0, nativeOutPeak: 0,
                nativeInRms: 0, nativeOutRms: 0,
                nativeStreamLatencyMs: 0, nativeDspAvgMs: 0,
                nativeDspMaxMs: 0, nativeUnderruns: 0,
            });
            return;
        }
        const off = client.addLevelListener((l, p) => {
            nativeLevelsRef.current = { levels: l, perf: p };
        });
        return () => {
            off();
            nativeLevelsRef.current = null;
            liveMetersStore.patch({
                nativeInPeak: 0, nativeOutPeak: 0,
                nativeInRms: 0, nativeOutRms: 0,
            });
        };
    }, [nativeMode, nativeAvailable]);

    // Throttled mirror: takes whatever native pitch/level data the WS
    // listeners have stashed in refs and patches the meter store + local
    // acStatus exactly `hz` times per second. Because the browser meter
    // loop in live-context.tsx skips voice/tuner publish when
    // `nativeRunning` is true, we are the sole writer for those fields
    // while native is active — so the user's hz slider fully controls the
    // perceived UI rate of the Tuner, Audio Engine card and Realtime Coach.
    useEffect(() => {
        if (!nativeMode || !nativeAvailable || !nativeRunning) return;
        const interval = Math.max(33, Math.round(1000 / hz));
        const tick = () => {
            const lv = nativeLevelsRef.current;
            const np = nativePitchRef.current;
            const patch: Partial<{
                nativeInPeak: number; nativeOutPeak: number;
                nativeInRms: number; nativeOutRms: number;
                nativeStreamLatencyMs: number; nativeDspAvgMs: number;
                nativeDspMaxMs: number; nativeUnderruns: number;
                voicePeakL: number; voicePeakR: number; voiceRms: number;
                masterPeakL: number; masterPeakR: number;
                tunerNote: string; tunerNoteIndex: number; tunerCents: number;
                tunerFrequency: number; tunerConfidence: number;
                autoCorrectActive: boolean;
                autoCorrectSourceMidi: number; autoCorrectTargetMidi: number;
            }> = {};
            if (lv) {
                const { levels: l, perf: p } = lv;
                patch.nativeInPeak = l.inPeak;
                patch.nativeOutPeak = l.outPeak;
                patch.nativeInRms = l.inRms;
                patch.nativeOutRms = l.outRms;
                patch.nativeStreamLatencyMs = p.streamLatencyMs;
                patch.nativeDspAvgMs = p.dspBlockAvgMs;
                patch.nativeDspMaxMs = p.dspBlockMaxMs;
                patch.nativeUnderruns = p.underruns;
                // Mirror into the standard meter fields so the Audio Engine
                // stats card, master meters and Voice meters reflect the
                // native signal (the browser engine sees silence when
                // native owns the mic).
                patch.voicePeakL = l.inPeak;
                patch.voicePeakR = l.inPeak;
                patch.voiceRms = l.inRms;
                patch.masterPeakL = l.outPeak;
                patch.masterPeakR = l.outPeak;
            }
            if (np) {
                const p = np.pitch;
                const s = np.status;
                if (p.confidence >= 0.3 && p.frequency > 0) {
                    const noteIdx = ((Math.round(p.midi) % 12) + 12) % 12;
                    patch.tunerNote = formatPitch(noteIdx, settings.noteNotations[0] ?? "anglo", quality);
                    patch.tunerNoteIndex = noteIdx;
                    patch.tunerCents = Math.round(p.cents);
                    patch.tunerFrequency = p.frequency;
                    patch.tunerConfidence = p.confidence;
                } else {
                    // Low-confidence frame — surface as "no signal" so the
                    // tuner/coach don't latch on to stale notes.
                    patch.tunerNote = "—";
                    patch.tunerNoteIndex = -1;
                    patch.tunerCents = 0;
                    patch.tunerFrequency = 0;
                    patch.tunerConfidence = p.confidence;
                }
                if (s) {
                    patch.autoCorrectActive = autoCorrectOn;
                    patch.autoCorrectSourceMidi = s.sourceMidi ?? NaN;
                    patch.autoCorrectTargetMidi = s.targetMidi ?? -1;
                }
            }
            if (Object.keys(patch).length > 0) liveMetersStore.patch(patch);
        };
        tick();
        const id = window.setInterval(tick, interval);
        return () => { window.clearInterval(id); };
    }, [nativeMode, nativeAvailable, nativeRunning, hz, autoCorrectOn, settings.noteNotations, quality]);

    // Mirror local native lifecycle state into the meters store so the
    // Voice Processor panel can render its Native ON/OFF button + status
    // text without owning the companion client. These flip on actual
    // start/stop — not on every WS frame — so they are flicker-free.
    useEffect(() => {
        liveMetersStore.patch({
            nativeRunning,
            nativeAvailable,
            nativeError,
            nativeMetricsLatencyMs: nativeMetrics?.streamLatencyMs ?? 0,
            nativeMetricsDspAvgMs: nativeMetrics?.dspBlockAvgMs ?? 0,
            // Audio Engine perf card uses these to render device-truth
            // values when native is the active path. Uptime is derived
            // from callback count so it tracks the audio thread, not
            // wall-clock — matches what an "AUDIO" card should show.
            nativeSampleRate: nativeMetrics?.sampleRate ?? 0,
            nativeFrameSize: nativeMetrics?.frameSize ?? 0,
            nativeBackend: nativeMetrics?.backend ?? "",
            nativeUptimeSec: (nativeMetrics?.callbackCount && nativeMetrics?.frameSize && nativeMetrics?.sampleRate)
                ? (nativeMetrics.callbackCount * nativeMetrics.frameSize) / nativeMetrics.sampleRate
                : 0,
            nativeExclusiveMode,
        });
    }, [nativeRunning, nativeAvailable, nativeError, nativeMetrics]);

    // Refresh native metrics every second (for UI readout).
    useEffect(() => {
        const client = nativeClientRef.current;
        if (!nativeMode || !nativeAvailable || !client || !nativeRunning) return;
        let alive = true;
        const tick = async () => {
            try {
                const m = await client.metrics();
                if (alive) setNativeMetrics(m.metrics);
            } catch { /* ignore */ }
        };
        const id = setInterval(tick, 1000);
        return () => { alive = false; clearInterval(id); };
    }, [nativeMode, nativeAvailable, nativeRunning]);

    // Subscribe to engine's live auto-correct status (60 Hz internal loop).
    // We poll instead of pushing to keep the engine free of UI deps.
    // When in native mode, status is sourced from `nativePitchRef` (filled
    // by WS messages from the companion) instead. Throttled to the user's
    // UI hz so even at 1 Hz the corrector readout doesn't flicker.
    const [acStatus, setAcStatus] = useState<{
        rms: number; freq: number; note: string; semis: number; ratio: number; conf: number;
        sourceMidi: number | null; targetMidi: number | null;
    }>({ rms: 0, freq: 0, note: "—", semis: 0, ratio: 1, conf: 0, sourceMidi: null, targetMidi: null });
    useEffect(() => {
        if (!autoCorrectOn) return;
        const engine = live.engine;
        const useNative = nativeMode && nativeAvailable && nativeRunning;
        if (!useNative && !engine) return;
        let alive = true;
        const interval = Math.max(33, Math.round(1000 / hz));
        const tick = () => {
            if (!alive) return;
            if (useNative) {
                const np = nativePitchRef.current;
                if (np) {
                    const p = np.pitch;
                    const s = np.status;
                    const noteName = p.midi >= 0
                        ? formatPitch(((Math.round(p.midi) % 12) + 12) % 12, settings.noteNotations[0] ?? "anglo", quality)
                        : "—";
                    const semis = s && s.targetMidi !== null && s.sourceMidi !== null
                        ? (s.targetMidi - s.sourceMidi)
                        : 0;
                    setAcStatus({
                        rms: p.rms,
                        freq: p.frequency,
                        note: noteName,
                        semis,
                        ratio: s?.ratio ?? 1,
                        conf: p.confidence,
                        sourceMidi: s?.sourceMidi ?? null,
                        targetMidi: s?.targetMidi ?? null,
                    });
                }
            } else if (engine) {
                const s = engine.voice.getAutoCorrectStatus();
                setAcStatus({
                    rms: s.rms,
                    freq: s.pitch.frequency,
                    note: s.pitch.note,
                    semis: s.semitones,
                    ratio: s.ratio,
                    conf: s.pitch.confidence,
                    sourceMidi: s.sourceMidi,
                    targetMidi: s.targetMidi,
                });
            }
        };
        tick();
        const id = window.setInterval(tick, interval);
        return () => { alive = false; window.clearInterval(id); };
    }, [autoCorrectOn, live.engine, nativeMode, nativeAvailable, nativeRunning, hz, settings.noteNotations, quality]);

    return (
        <Section title="Key & Scale" accent="#06b6d4" icon={<Settings2 className="w-3.5 h-3.5 text-cyan-400/60" />}>
            <div className="space-y-2">
                {/* Native low-latency mode UI lives in the Voice Processor
                    panel now — KeyScalePanel still owns the engine
                    lifecycle but renders no native controls of its own. */}

                {/* Auto-correct toggle row */}
                <div className="flex items-center justify-between gap-2">
                    <button
                        onClick={() => setAutoCorrectOn(v => !v)}
                        title={
                            autoCorrectOn
                                ? `Auto-correct ON — snapping to ${scaleName}`
                                : "Snap your voice to the nearest note in the selected scale"
                        }
                        className={cn(
                            "flex items-center gap-1.5 h-6 px-2 text-[10px] rounded-full transition-all border cursor-pointer",
                            autoCorrectOn
                                ? "bg-emerald-500/25 text-emerald-200 border-emerald-500/40 shadow-[0_0_10px_rgba(16,185,129,0.25)]"
                                : "bg-white/[0.04] text-white/45 border-white/10 hover:text-white/80 hover:bg-white/[0.08]",
                        )}
                    >
                        <Sparkles className="w-3 h-3" />
                        <span>Auto-correct {autoCorrectOn ? "ON" : "OFF"}</span>
                    </button>
                    {autoCorrectOn && (
                        <span className="text-[9px] text-emerald-300/70 tabular-nums">
                            {acStatus.note !== "—"
                                ? `► ${acStatus.note} ${acStatus.semis >= 0 ? "+" : ""}${acStatus.semis.toFixed(2)}st`
                                : acStatus.rms > 0.001
                                    ? "listening…"
                                    : "no input"}
                        </span>
                    )}
                </div>

                {autoCorrectOn && (
                    <div className="rounded-md border border-emerald-500/15 bg-emerald-500/[0.04] p-2 space-y-1.5">
                        <AutoCorrectLedMeter
                            sourceMidi={acStatus.sourceMidi}
                            targetMidi={acStatus.targetMidi}
                            semitones={acStatus.semis}
                            confidence={acStatus.conf}
                            rms={acStatus.rms}
                            quality={quality}
                            notations={settings.noteNotations}
                        />
                        <div className="flex items-center justify-between text-[9px] text-emerald-300/80">
                            <span className="uppercase tracking-wider">Speed</span>
                            <span className="tabular-nums">
                                {autoCorrectSpeed < 0.02 ? "Hard snap" : autoCorrectSpeed < 0.1 ? "Fast" : autoCorrectSpeed < 0.25 ? "Natural" : "Slow"}
                            </span>
                        </div>
                        <input
                            type="range"
                            min={0.005}
                            max={0.5}
                            step={0.005}
                            value={autoCorrectSpeed}
                            onChange={(e) => setAutoCorrectSpeed(parseFloat(e.target.value))}
                            className="w-full accent-emerald-400"
                        />
                        <div className="flex items-center justify-between text-[9px] text-emerald-300/80">
                            <span className="uppercase tracking-wider">Amount</span>
                            <span className="tabular-nums">{Math.round(autoCorrectAmount * 100)}%</span>
                        </div>
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={autoCorrectAmount}
                            onChange={(e) => setAutoCorrectAmount(parseFloat(e.target.value))}
                            className="w-full accent-emerald-400"
                        />
                        {/* Root-lock: snap every input to the SELECTED key
                            root (any octave) instead of the nearest scale
                            note. ON = "Re Major" → only D's get produced.
                            OFF = classic Auto-Tune scale-snap (D, E, F#, G,
                            A, B, C# all valid for D Major). Default ON to
                            match the user's expectation that picking a
                            single key means snap-to-that-note. */}
                        <button
                            type="button"
                            onClick={() => setAutoCorrectRootLock(v => !v)}
                            className={cn(
                                "w-full mt-1 flex items-center justify-between gap-2 px-2 py-1 rounded text-[10px] border transition-all cursor-pointer",
                                autoCorrectRootLock
                                    ? "bg-amber-500/15 text-amber-200 border-amber-500/30"
                                    : "bg-white/[0.04] text-white/55 border-white/10 hover:text-white/85",
                            )}
                            title="ON: every note snaps to the selected key root in the closest octave (e.g. Re Major → all output is D). OFF: classic scale-snap (any note in the scale is allowed)."
                        >
                            <span className="uppercase tracking-wider">Root Lock</span>
                            <span className="tabular-nums">{autoCorrectRootLock ? "ON" : "OFF"}</span>
                        </button>
                        {/* Formant preservation: keeps the singer's vocal-tract
                            colour even when shifted (no chipmunk effect). LPC
                            inverse + synthesis filter is applied on the wet
                            path inside the worklet. */}
                        <button
                            type="button"
                            onClick={() => setAutoCorrectFormant(v => !v)}
                            className={cn(
                                "w-full mt-1 flex items-center justify-between gap-2 px-2 py-1 rounded text-[10px] border transition-all cursor-pointer",
                                autoCorrectFormant
                                    ? "bg-emerald-500/15 text-emerald-200 border-emerald-500/30"
                                    : "bg-white/[0.04] text-white/55 border-white/10 hover:text-white/85",
                            )}
                            title="When ON, preserves the singer's vocal-tract resonances so the shifted voice doesn't sound chipmunk-like. Uses LPC analysis (~5 ms updates)."
                        >
                            <span className="uppercase tracking-wider">Formant Preserve</span>
                            <span className="tabular-nums">{autoCorrectFormant ? "ON" : "OFF"}</span>
                        </button>
                    </div>
                )}

                <div className="grid grid-cols-12 gap-0.5">
                    {NOTE_NAMES.map((note, i) => {
                        const label = formatNoteMulti(i, settings.noteNotations, quality, "/");
                        return (
                            <button key={i} onClick={() => live.setKey(i)}
                                title={label}
                                className={cn("py-1.5 rounded-md text-[10px] font-medium transition-all cursor-pointer",
                                    note.includes("#") ? "bg-gray-900" : "bg-white/[0.03]",
                                    live.keyIndex === i
                                        ? "!bg-cyan-500/25 text-cyan-300 border border-cyan-500/40 shadow-[0_0_6px_rgba(6,182,212,0.2)]"
                                        : "text-white/35 border border-transparent hover:bg-white/[0.06]")}>
                                {label}
                            </button>
                        );
                    })}
                </div>
                <div className="flex flex-wrap gap-1">
                    {Object.entries(MUSICAL_SCALES).map(([idx, scale]) => {
                        const i = Number(idx);
                        return (
                            <button key={i} onClick={() => live.setScale(i)}
                                className={cn("px-2 py-1 rounded-lg text-[10px] cursor-pointer transition-all",
                                    live.scaleIndex === i
                                        ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                                        : "bg-white/[0.03] text-white/35 hover:bg-white/[0.06] border border-transparent")}>
                                {scale.name}
                            </button>
                        );
                    })}
                </div>
            </div>
        </Section>
    );
}

// ─── Metronome Settings ──────────────────────────────────────────────────────

function MetroSettings() {
    const live = useLive();
    if (!live.isMetronomeOn) return null;
    return (
        <div className="px-4 py-2 flex items-center gap-3 bg-white/[0.02] border-y border-white/[0.04] text-[10px]">
            <span className="text-white/30 uppercase tracking-wider">Metronome</span>
            <button onClick={() => live.setMetronomeMonitorOnly(!live.metronomeMonitorOnly)}
                className={cn("px-2 py-0.5 rounded text-[9px] cursor-pointer",
                    live.metronomeMonitorOnly ? "bg-emerald-500/20 text-emerald-400" : "bg-white/[0.05] text-white/30")}>
                {live.metronomeMonitorOnly ? "Cue Only" : "On Master"}
            </button>
            <span className="text-white/30">Vol</span>
            <input type="range" min={0} max={1} step={0.01} value={live.metronomeVolume}
                onChange={e => live.setMetronomeVolume(parseFloat(e.target.value))}
                className="w-24 accent-blue-500" />
        </div>
    );
}

// ─── Main LivePage ───────────────────────────────────────────────────────────

function RecommendationsPanel() {
    return (
        <Section title="Realtime Coach" accent="#a855f7">
            <LiveRecommendationsWidget className="!border-0 !bg-transparent" />
        </Section>
    );
}

function InstrumentPanel() {
    return (
        <Section title="Instrument" accent="#10b981" icon={<Music2 className="w-3.5 h-3.5 text-emerald-400/60" />}>
            <LiveInstrumentWidget />
        </Section>
    );
}

// Memoized provider so the context VALUE is stable across parent re-renders
// (otherwise every consumer re-renders every frame and any consumer effect
// depending on the slot object would tear down + re-run synchronously, which
// can cascade into "Maximum update depth exceeded" via AutoSize).
function WidgetSlotProvider({ opts, children }: {
    opts: { collapsed: boolean; onToggleCollapse: () => void; dragHandleClass: string; locked: boolean; autoResize: boolean; requestAutoHeight: (px: number) => void };
    children: React.ReactNode;
}) {
    const value = useMemo(() => ({
        collapsed: opts.collapsed,
        onToggleCollapse: opts.onToggleCollapse,
        dragHandleClass: opts.dragHandleClass,
        fillHeight: true,
        autoResize: opts.autoResize,
        requestAutoHeight: opts.requestAutoHeight,
    }), [opts.collapsed, opts.onToggleCollapse, opts.dragHandleClass, opts.autoResize, opts.requestAutoHeight]);
    return <LiveWidgetSlotContext.Provider value={value}>{children}</LiveWidgetSlotContext.Provider>;
}

// ─── Performance widget with text-size scaling ──────────────────────────────
const PERF_TEXT_SCALE_KEY = "live-perf-text-scale-v1";
const PERF_SCALE_MIN = 0.7;
const PERF_SCALE_MAX = 1.6;
const PERF_SCALE_STEP = 0.1;
const PERF_SCALE_DEFAULT = 1;

function loadPerfScale(): number {
    if (typeof window === "undefined") return PERF_SCALE_DEFAULT;
    try {
        const raw = window.localStorage.getItem(PERF_TEXT_SCALE_KEY);
        if (!raw) return PERF_SCALE_DEFAULT;
        const v = parseFloat(raw);
        if (!Number.isFinite(v)) return PERF_SCALE_DEFAULT;
        return Math.min(PERF_SCALE_MAX, Math.max(PERF_SCALE_MIN, v));
    } catch { return PERF_SCALE_DEFAULT; }
}

function LivePerfSection() {
    const [scale, setScale] = useState<number>(PERF_SCALE_DEFAULT);
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only localStorage hydration after SSR
        setScale(loadPerfScale());
        setHydrated(true);
    }, []);

    useEffect(() => {
        if (!hydrated) return;
        try { window.localStorage.setItem(PERF_TEXT_SCALE_KEY, String(scale)); } catch { /* ignore */ }
    }, [scale, hydrated]);

    const dec = useCallback(() => setScale(s => Math.max(PERF_SCALE_MIN, +(s - PERF_SCALE_STEP).toFixed(2))), []);
    const inc = useCallback(() => setScale(s => Math.min(PERF_SCALE_MAX, +(s + PERF_SCALE_STEP).toFixed(2))), []);
    const reset = useCallback(() => setScale(PERF_SCALE_DEFAULT), []);

    const pct = Math.round(scale * 100);
    const atMin = scale <= PERF_SCALE_MIN + 1e-3;
    const atMax = scale >= PERF_SCALE_MAX - 1e-3;
    const isDefault = Math.abs(scale - PERF_SCALE_DEFAULT) < 1e-3;

    const action = (
        <div className="flex items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.03] p-0.5 select-none" data-no-drag>
            <button
                type="button"
                onClick={dec}
                disabled={atMin}
                title="Decrease text size"
                className="w-6 h-6 flex items-center justify-center rounded text-white/55 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
                <ZoomOut className="w-3 h-3" />
            </button>
            <button
                type="button"
                onClick={reset}
                disabled={isDefault}
                title={`Text size: ${pct}% — click to reset`}
                className={cn(
                    "min-w-[34px] h-6 px-1.5 flex items-center justify-center gap-1 rounded text-[9px] font-mono tabular-nums transition-colors cursor-pointer",
                    isDefault
                        ? "text-white/35 cursor-default"
                        : "text-lime-300 hover:text-lime-200 hover:bg-lime-500/10",
                )}
            >
                <Type className="w-2.5 h-2.5" />
                {pct}%
            </button>
            <button
                type="button"
                onClick={inc}
                disabled={atMax}
                title="Increase text size"
                className="w-6 h-6 flex items-center justify-center rounded text-white/55 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
                <ZoomIn className="w-3 h-3" />
            </button>
        </div>
    );

    return (
        <Section title="Performance" accent="#a3e635" action={action}>
            <div
                className="flex flex-col gap-2 origin-top-left"
                style={{
                    // CSS `zoom` scales both layout and text, supported in Chromium/Safari/Firefox 126+.
                    zoom: scale,
                }}
            >
                <PerformancePanel className="!w-full" />
                <LiveAudioStatsCard className="!w-full" />
            </div>
        </Section>
    );
}

type WidgetId = "voice" | "keyScale" | "backing" | "tuner" | "looper" | "pads" | "stream" | "perf" | "recommendations" | "visualizer" | "eq" | "instrument" | "plugins";

const WIDGET_RENDERERS: Record<WidgetId, () => React.ReactElement> = {
    voice: () => <VoicePanel />,
    keyScale: () => <KeyScalePanel />,
    visualizer: () => <LiveVisualizerWidget className="!h-full" />,
    eq: () => <LiveEqWidget className="!h-full" />,
    backing: () => <BackingPanel />,
    tuner: () => <TunerPanel />,
    looper: () => <LooperBank />,
    pads: () => <PadGrid />,
    stream: () => <StreamPanel />,
    perf: () => <LivePerfSection />,
    recommendations: () => <RecommendationsPanel />,
    instrument: () => <InstrumentPanel />,
    plugins: () => <LivePluginsWidget />,
};

// ─── Widget metadata: defaults, min sizes, max sizes ────────────────────────
// Designed against a 12-col grid at lg. Heights are in 32px row units.
const WIDGET_META: WidgetMeta<WidgetId>[] = [
    {
        id: "voice", title: "Voice Processor",
        icon: Mic, accent: "#f43f5e", description: "Mic input, FX chain, presets",
        defaults: { lg: { x: 0, y: 0, w: 5, h: 14 }, md: { x: 0, y: 0, w: 5, h: 14 }, sm: { x: 0, y: 0, w: 6, h: 14 }, xs: { x: 0, y: 0, w: 4, h: 14 }, xxs: { x: 0, y: 0, w: 2, h: 14 } },
        minW: 4, minH: 8, autoResize: true,
    },
    {
        id: "keyScale", title: "Key & Scale",
        icon: KeyRound, accent: "#22d3ee", description: "Pick root + scale; harmonic mirror",
        defaults: { lg: { x: 0, y: 14, w: 5, h: 5 }, md: { x: 0, y: 14, w: 5, h: 5 }, sm: { x: 0, y: 14, w: 6, h: 5 }, xs: { x: 0, y: 14, w: 4, h: 5 }, xxs: { x: 0, y: 14, w: 2, h: 5 } },
        minW: 3, minH: 4,
    },
    {
        id: "recommendations", title: "Realtime Coach",
        icon: Sparkles, accent: "#a855f7", description: "Live pitch & scale guidance",
        defaults: { lg: { x: 0, y: 19, w: 5, h: 10 }, md: { x: 0, y: 19, w: 5, h: 10 }, sm: { x: 0, y: 19, w: 6, h: 10 }, xs: { x: 0, y: 19, w: 4, h: 10 }, xxs: { x: 0, y: 19, w: 2, h: 10 } },
        minW: 3, minH: 5, autoResize: true,
    },
    {
        id: "backing", title: "Backing Track",
        icon: Music, accent: "#3b82f6", description: "Audio backing playback / loop",
        defaults: { lg: { x: 5, y: 0, w: 4, h: 10 }, md: { x: 5, y: 0, w: 5, h: 10 }, sm: { x: 0, y: 29, w: 6, h: 10 }, xs: { x: 0, y: 29, w: 4, h: 10 }, xxs: { x: 0, y: 29, w: 2, h: 10 } },
        minW: 3, minH: 6, autoResize: true,
    },
    {
        id: "tuner", title: "Tuner",
        icon: Activity, accent: "#10b981", description: "Realtime pitch & cents",
        defaults: { lg: { x: 5, y: 10, w: 4, h: 8 }, md: { x: 5, y: 10, w: 5, h: 8 }, sm: { x: 0, y: 39, w: 6, h: 8 }, xs: { x: 0, y: 39, w: 4, h: 8 }, xxs: { x: 0, y: 39, w: 2, h: 8 } },
        minW: 2, minH: 5,
    },
    {
        id: "stream", title: "Remote Stream",
        icon: Radio, accent: "#ec4899", description: "Phone\u2194desktop WebRTC mic",
        defaults: { lg: { x: 5, y: 18, w: 4, h: 11 }, md: { x: 5, y: 18, w: 5, h: 11 }, sm: { x: 0, y: 47, w: 6, h: 11 }, xs: { x: 0, y: 47, w: 4, h: 11 }, xxs: { x: 0, y: 47, w: 2, h: 11 } },
        minW: 3, minH: 6, autoResize: true,
    },
    {
        id: "looper", title: "Looper",
        icon: Repeat, accent: "#f59e0b", description: "4 banks of beat-synced loops",
        defaults: { lg: { x: 9, y: 0, w: 3, h: 15 }, md: { x: 0, y: 19, w: 5, h: 15 }, sm: { x: 0, y: 58, w: 6, h: 15 }, xs: { x: 0, y: 58, w: 4, h: 15 }, xxs: { x: 0, y: 58, w: 2, h: 15 } },
        minW: 2, minH: 8,
    },
    {
        id: "pads", title: "Pads",
        icon: Disc3, accent: "#8b5cf6", description: "8 trigger pads / one-shots",
        defaults: { lg: { x: 9, y: 15, w: 3, h: 10 }, md: { x: 5, y: 19, w: 5, h: 10 }, sm: { x: 0, y: 73, w: 6, h: 10 }, xs: { x: 0, y: 73, w: 4, h: 10 }, xxs: { x: 0, y: 73, w: 2, h: 10 } },
        minW: 2, minH: 6,
    },
    {
        id: "perf", title: "Performance",
        icon: Zap, accent: "#a3e635", description: "System / browser / audio stats",
        defaults: { lg: { x: 9, y: 25, w: 3, h: 16 }, md: { x: 5, y: 29, w: 5, h: 16 }, sm: { x: 0, y: 83, w: 6, h: 16 }, xs: { x: 0, y: 83, w: 4, h: 16 }, xxs: { x: 0, y: 83, w: 2, h: 16 } },
        minW: 2, minH: 8, autoResize: true,
    },
    {
        id: "visualizer", title: "Visualizer",
        icon: Eye, accent: "#06b6d4", description: "Spectrum / waveform / oscilloscope",
        defaults: { lg: { x: 9, y: 33, w: 3, h: 10 }, md: { x: 5, y: 37, w: 5, h: 10 }, sm: { x: 0, y: 91, w: 6, h: 10 }, xs: { x: 0, y: 91, w: 4, h: 10 }, xxs: { x: 0, y: 91, w: 2, h: 10 } },
        minW: 2, minH: 6,
    },
    {
        id: "eq", title: "Equalizer",
        icon: Sliders, accent: "#ef4444", description: "Simple EQ3 or N-band parametric",
        defaults: { lg: { x: 5, y: 29, w: 4, h: 13 }, md: { x: 5, y: 47, w: 5, h: 13 }, sm: { x: 0, y: 101, w: 6, h: 13 }, xs: { x: 0, y: 101, w: 4, h: 13 }, xxs: { x: 0, y: 101, w: 2, h: 13 } },
        minW: 3, minH: 8,
    },
    {
        id: "instrument", title: "Instrument",
        icon: Music2, accent: "#10b981", description: "Re-voice the mic as piano/violin/strings/...",
        defaults: { lg: { x: 5, y: 42, w: 4, h: 18 }, md: { x: 5, y: 60, w: 5, h: 18 }, sm: { x: 0, y: 114, w: 6, h: 18 }, xs: { x: 0, y: 114, w: 4, h: 18 }, xxs: { x: 0, y: 114, w: 2, h: 18 } },
        minW: 3, minH: 10, autoResize: true,
    },
    {
        id: "plugins", title: "Plugin FX",
        icon: Plug, accent: "#a78bfa", description: "VST3 / AU / LV2 master rack (offline render)",
        defaults: { lg: { x: 5, y: 60, w: 4, h: 16 }, md: { x: 5, y: 78, w: 5, h: 16 }, sm: { x: 0, y: 132, w: 6, h: 16 }, xs: { x: 0, y: 132, w: 4, h: 16 }, xxs: { x: 0, y: 132, w: 2, h: 16 } },
        minW: 3, minH: 8, autoResize: true,
    },
];

const LAYOUT_STORAGE_KEY = "live-widget-grid-v1";

export function LivePage() {
    useRenderCount("LivePage");
    const live = useLive();

    // Keyboard shortcuts
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement).tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
            switch (e.code) {
                case "Space": e.preventDefault(); live.backingToggle(); break;
                case "KeyR": e.preventDefault(); live.toggleRecording(); break;
                case "KeyM": e.preventDefault(); live.toggleMetronome(); break;
                case "KeyT": e.preventDefault(); live.tapBpm(); break;
                case "KeyV": e.preventDefault(); live.voiceActive ? void live.voiceStop() : void live.voiceStart(); break;
            }
            // Number keys 1-8 trigger pads
            if (e.code.startsWith("Digit")) {
                const n = parseInt(e.code.slice(5), 10);
                if (n >= 1 && n <= 8) {
                    e.preventDefault();
                    live.triggerPad(n - 1);
                }
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [live]);

    const renderWidget = useCallback((id: WidgetId, opts: { collapsed: boolean; onToggleCollapse: () => void; dragHandleClass: string; locked: boolean; autoResize: boolean; requestAutoHeight: (px: number) => void }) => {
        const Renderer = WIDGET_RENDERERS[id];
        return (
            <WidgetSlotProvider opts={opts}>
                <Renderer />
            </WidgetSlotProvider>
        );
    }, []);

    return (
        <div className="flex flex-col h-full bg-[oklch(0.10_0.01_260)] text-white overflow-hidden select-none">
            <AudioDiagnosticsLogger />
            <MasterBar />
            <MetroSettings />

            <LiveWidgetGrid
                storageKey={LAYOUT_STORAGE_KEY}
                widgets={WIDGET_META}
                renderWidget={renderWidget}
                toolbarExtra={<RefreshRateControl />}
                className="flex-1 min-h-0"
            />

            {/* Footer hint */}
            <div className="px-4 py-1.5 border-t border-white/[0.04] flex items-center gap-3 text-[9px] text-white/25 bg-black/20 shrink-0 flex-wrap">
                <span><kbd className="px-1 py-0.5 rounded bg-white/[0.05] mr-1">Space</kbd>Backing</span>
                <span><kbd className="px-1 py-0.5 rounded bg-white/[0.05] mr-1">R</kbd>Record</span>
                <span><kbd className="px-1 py-0.5 rounded bg-white/[0.05] mr-1">M</kbd>Metro</span>
                <span><kbd className="px-1 py-0.5 rounded bg-white/[0.05] mr-1">T</kbd>Tap</span>
                <span><kbd className="px-1 py-0.5 rounded bg-white/[0.05] mr-1">V</kbd>Voice</span>
                <span><kbd className="px-1 py-0.5 rounded bg-white/[0.05] mr-1">1-8</kbd>Pads</span>
                <span className="ml-auto text-white/20 hidden md:inline">Drag any widget by its title bar · Resize from bottom-right corner · Lock layout for performance</span>
            </div>
        </div>
    );
}
