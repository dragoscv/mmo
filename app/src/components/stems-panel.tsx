"use client";

import { useState, useCallback, useRef, useEffect, useReducer, memo } from "react";
import { subscribeRaf } from "@/lib/raf-scheduler";
import {
    type StemType,
    type StemConfig,
    STEM_TYPES,
    STEM_LABELS,
    STEM_COLORS,
    createDefaultStemConfigs,
    RealtimeStemProcessor,
} from "@/lib/stems-engine";
import { cn } from "@/lib/utils";
import { useRenderCount } from "@/lib/dev-debugger";
import {
    Mic,
    Drum,
    Music,
    Piano,
    Volume2,
    VolumeX,
    Headphones,
    Power,
    ChevronDown,
    ChevronUp,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface StemsPanelProps {
    processor: RealtimeStemProcessor | null;
    compact?: boolean;
    deckColor?: string;
    className?: string;
}

interface StemControlProps {
    config: StemConfig;
    color: string;
    level: number;
    compact?: boolean;
    onVolumeChange: (volume: number) => void;
    onToggleMute: () => void;
    onToggleSolo: () => void;
}

const STEM_ICON_MAP: Record<StemType, typeof Mic> = {
    vocals: Mic,
    drums: Drum,
    bass: Music,
    melody: Piano,
};

// ─── Stem Level Meter ────────────────────────────────────────────────────────

function useStemLevels(processor: RealtimeStemProcessor | null) {
    const [levels, setLevels] = useState<Record<StemType, number>>({
        vocals: 0, drums: 0, bass: 0, melody: 0,
    });
    const dataRef = useRef(new Float32Array(128));
    const lastRef = useRef<Record<StemType, number>>({
        vocals: 0, drums: 0, bass: 0, melody: 0,
    });

    useEffect(() => {
        if (!processor?.isActive) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- external audio processor subscription sync
            setLevels({ vocals: 0, drums: 0, bass: 0, melody: 0 });
            return;
        }

        const update = () => {
            let changed = false;
            const last = lastRef.current;
            const next: Record<StemType, number> = { ...last };

            for (const stem of STEM_TYPES) {
                const analyser = processor.getAnalyser(stem);
                if (!analyser) continue;

                if (dataRef.current.length !== analyser.fftSize) {
                    dataRef.current = new Float32Array(analyser.fftSize);
                }
                analyser.getFloatTimeDomainData(dataRef.current);

                let max = 0;
                const buf = dataRef.current;
                for (let i = 0; i < buf.length; i += 2) {  // sample every other point
                    const abs = Math.abs(buf[i]);
                    if (abs > max) max = abs;
                }
                // Skip writes when nothing visibly changed (cheap early exit).
                if (Math.abs(max - last[stem]) > 0.015) {
                    next[stem] = max;
                    changed = true;
                }
            }

            if (changed) {
                lastRef.current = next;
                setLevels(next);
            }
        };

        // 30 fps is plenty for a level-meter ring; halves the React re-render
        // cost compared to the previous unthrottled rAF, and the shared
        // scheduler avoids spinning up a private rAF loop per processor.
        return subscribeRaf(update, { fps: 30 });
    }, [processor, processor?.isActive]);

    return levels;
}

// ─── Stem Control ────────────────────────────────────────────────────────────

const StemControl = memo(function StemControl({
    config,
    color,
    level,
    compact,
    onVolumeChange,
    onToggleMute,
    onToggleSolo,
}: StemControlProps) {
    const Icon = STEM_ICON_MAP[config.type];
    const isActive = !config.muted && config.volume > 0;
    const isSoloed = config.solo;
    const effectiveLevel = config.muted ? 0 : level * config.volume;

    const sliderRef = useRef<HTMLDivElement>(null);
    const isDragging = useRef(false);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        isDragging.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        updateFromPointer(e);
    }, []);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!isDragging.current) return;
        updateFromPointer(e);
    }, []);

    const handlePointerUp = useCallback(() => {
        isDragging.current = false;
    }, []);

    const updateFromPointer = useCallback((e: React.PointerEvent) => {
        const rect = sliderRef.current?.getBoundingClientRect();
        if (!rect) return;
        const y = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        onVolumeChange(y);
    }, [onVolumeChange]);

    if (compact) {
        return (
            <div className="flex flex-col items-center gap-1">
                <button
                    onClick={onToggleMute}
                    className={cn(
                        "relative flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-200",
                        isActive
                            ? "bg-white/10 hover:bg-white/15"
                            : "bg-white/5 hover:bg-white/10 opacity-40",
                    )}
                    title={`${STEM_LABELS[config.type]}: ${config.muted ? "Unmute" : "Mute"}`}
                >
                    <Icon className="w-3.5 h-3.5" style={{ color: isActive ? color : undefined }} />
                    {/* Level indicator ring */}
                    <div
                        className="absolute inset-0 rounded-lg border-2 transition-opacity duration-100"
                        style={{
                            borderColor: color,
                            opacity: effectiveLevel * 0.8,
                        }}
                    />
                </button>
                <span className="text-[9px] text-[var(--muted-foreground)] leading-none">
                    {STEM_LABELS[config.type].slice(0, 3)}
                </span>
            </div>
        );
    }

    return (
        <div className="flex flex-col items-center gap-1.5 select-none">
            {/* Label */}
            <span
                className="text-[10px] font-medium tracking-wider uppercase"
                style={{ color }}
            >
                {STEM_LABELS[config.type]}
            </span>

            {/* Volume slider (vertical) */}
            <div
                ref={sliderRef}
                className="relative w-6 h-20 rounded-full bg-white/5 cursor-pointer overflow-hidden"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
            >
                {/* Volume fill */}
                <div
                    className="absolute bottom-0 left-0 right-0 rounded-full transition-[height] duration-75"
                    style={{
                        height: `${config.volume * 100}%`,
                        background: `linear-gradient(to top, ${color}40, ${color}80)`,
                    }}
                />
                {/* Level meter overlay */}
                <div
                    className="absolute bottom-0 left-0 right-0 transition-[height] duration-75"
                    style={{
                        height: `${effectiveLevel * 100}%`,
                        background: `${color}30`,
                    }}
                />
                {/* Thumb */}
                <div
                    className="absolute left-1/2 -translate-x-1/2 w-4 h-1.5 rounded-full bg-white shadow-sm transition-[bottom] duration-75"
                    style={{ bottom: `calc(${config.volume * 100}% - 3px)` }}
                />
            </div>

            {/* Volume percentage */}
            <span className="text-[9px] text-[var(--muted-foreground)] tabular-nums">
                {Math.round(config.volume * 100)}%
            </span>

            {/* Buttons row */}
            <div className="flex items-center gap-0.5">
                {/* Mute */}
                <button
                    onClick={onToggleMute}
                    className={cn(
                        "flex items-center justify-center w-6 h-6 rounded transition-all duration-150",
                        config.muted
                            ? "bg-red-500/20 text-red-400"
                            : "bg-white/5 text-[var(--muted-foreground)] hover:bg-white/10 hover:text-[var(--foreground)]",
                    )}
                    title={config.muted ? "Unmute" : "Mute"}
                >
                    {config.muted ? (
                        <VolumeX className="w-3 h-3" />
                    ) : (
                        <Volume2 className="w-3 h-3" />
                    )}
                </button>

                {/* Solo */}
                <button
                    onClick={onToggleSolo}
                    className={cn(
                        "flex items-center justify-center w-6 h-6 rounded text-[10px] font-bold transition-all duration-150",
                        isSoloed
                            ? "text-amber-400"
                            : "bg-white/5 text-[var(--muted-foreground)] hover:bg-white/10 hover:text-[var(--foreground)]",
                    )}
                    style={isSoloed ? { backgroundColor: `${color}30` } : undefined}
                    title={isSoloed ? "Unsolo" : "Solo"}
                >
                    S
                </button>
            </div>

            {/* Icon */}
            <div
                className={cn(
                    "flex items-center justify-center w-7 h-7 rounded-lg transition-all duration-200",
                    isActive ? "bg-white/10" : "bg-white/5 opacity-40",
                )}
            >
                <Icon className="w-3.5 h-3.5" style={{ color: isActive ? color : undefined }} />
            </div>
        </div>
    );
});

// ─── Stems Panel ─────────────────────────────────────────────────────────────

export const StemsPanel = memo(function StemsPanel({
    processor,
    compact = false,
    deckColor,
    className,
}: StemsPanelProps) {
    useRenderCount("StemsPanel");
    const [isExpanded, setIsExpanded] = useState(!compact);
    const [, forceRender] = useReducer(x => x + 1, 0);
    const levels = useStemLevels(processor);

    const configs = processor?.configs ?? createDefaultStemConfigs();
    const isActive = processor?.isActive ?? false;

    const handleToggle = useCallback(() => {
        processor?.toggle();
        forceRender();
    }, [processor]);

    const handleVolumeChange = useCallback((stem: StemType, volume: number) => {
        processor?.setStemVolume(stem, volume);
        forceRender();
    }, [processor]);

    const handleToggleMute = useCallback((stem: StemType) => {
        processor?.toggleStemMute(stem);
        forceRender();
    }, [processor]);

    const handleToggleSolo = useCallback((stem: StemType) => {
        processor?.toggleStemSolo(stem);
        forceRender();
    }, [processor]);

    if (!processor) return null;

    return (
        <div
            className={cn(
                "flex flex-col rounded-xl border transition-all duration-300",
                isActive
                    ? "border-purple-500/30 bg-purple-500/5"
                    : "border-[var(--border)] bg-[var(--card)]/50",
                className,
            )}
        >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2">
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleToggle}
                        className={cn(
                            "flex items-center justify-center w-7 h-7 rounded-lg transition-all duration-200",
                            isActive
                                ? "bg-purple-500/20 text-purple-400 shadow-[0_0_8px_rgba(168,85,247,0.3)]"
                                : "bg-white/5 text-[var(--muted-foreground)] hover:bg-white/10",
                        )}
                    >
                        <Power className="w-3.5 h-3.5" />
                    </button>
                    <span className="text-xs font-semibold tracking-wide uppercase text-[var(--muted-foreground)]">
                        Stems
                    </span>
                    {isActive && (
                        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-purple-500/15 text-[9px] font-medium text-purple-400 animate-[fadeIn_200ms_ease-out]">
                            <span className="w-1 h-1 rounded-full bg-purple-400 animate-pulse" />
                            Active
                        </span>
                    )}
                </div>

                {!compact && (
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="flex items-center justify-center w-6 h-6 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-white/5 transition-colors"
                    >
                        {isExpanded ? (
                            <ChevronUp className="w-3.5 h-3.5" />
                        ) : (
                            <ChevronDown className="w-3.5 h-3.5" />
                        )}
                    </button>
                )}
            </div>

            {/* Stem controls */}
            {isActive && (isExpanded || compact) && (
                <div
                    className={cn(
                        "px-3 pb-3 animate-[fadeIn_200ms_ease-out]",
                        compact ? "flex items-center justify-center gap-3" : "flex items-end justify-center gap-4",
                    )}
                >
                    {STEM_TYPES.map((stemType) => {
                        const config = configs.find(c => c.type === stemType);
                        if (!config) return null;
                        return (
                            <StemControl
                                key={stemType}
                                config={config}
                                color={STEM_COLORS[stemType]}
                                level={levels[stemType]}
                                compact={compact}
                                onVolumeChange={(v) => handleVolumeChange(stemType, v)}
                                onToggleMute={() => handleToggleMute(stemType)}
                                onToggleSolo={() => handleToggleSolo(stemType)}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
});

// ─── Compact Stems Strip (for tight spaces) ─────────────────────────────────

export const StemsStrip = memo(function StemsStrip({
    processor,
    className,
}: {
    processor: RealtimeStemProcessor | null;
    className?: string;
}) {
    const [, forceRender] = useReducer(x => x + 1, 0);
    const levels = useStemLevels(processor);
    const configs = processor?.configs ?? createDefaultStemConfigs();
    const isActive = processor?.isActive ?? false;

    if (!processor) return null;

    return (
        <div className={cn("flex items-center gap-1", className)}>
            <button
                onClick={() => { processor.toggle(); forceRender(); }}
                className={cn(
                    "flex items-center justify-center w-6 h-6 rounded transition-all duration-150",
                    isActive
                        ? "bg-purple-500/20 text-purple-400"
                        : "bg-white/5 text-[var(--muted-foreground)] hover:bg-white/10",
                )}
                title="Toggle Stems"
            >
                <Power className="w-3 h-3" />
            </button>

            {isActive && STEM_TYPES.map((stemType) => {
                const config = configs.find(c => c.type === stemType);
                if (!config) return null;
                const Icon = STEM_ICON_MAP[stemType];
                const active = !config.muted && config.volume > 0;
                const level = levels[stemType];

                return (
                    <button
                        key={stemType}
                        onClick={() => { processor.toggleStemMute(stemType); forceRender(); }}
                        className={cn(
                            "relative flex items-center justify-center w-6 h-6 rounded transition-all duration-150",
                            active
                                ? "bg-white/10 hover:bg-white/15"
                                : "bg-white/5 opacity-40 hover:opacity-60",
                        )}
                        title={`${STEM_LABELS[stemType]}: ${config.muted ? "Unmute" : "Mute"}`}
                    >
                        <Icon className="w-3 h-3" style={{ color: active ? STEM_COLORS[stemType] : undefined }} />
                        {/* Level dot */}
                        <span
                            className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full transition-opacity"
                            style={{
                                backgroundColor: STEM_COLORS[stemType],
                                opacity: level * 0.8,
                            }}
                        />
                    </button>
                );
            })}
        </div>
    );
});
