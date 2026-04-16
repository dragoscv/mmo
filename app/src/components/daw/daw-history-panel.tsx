"use client";

import { useMemo } from "react";
import {
    type HistoryState,
    type HistoryEntry,
    canUndo,
    canRedo,
} from "@/lib/history-engine";
import { cn } from "@/lib/utils";
import {
    Undo2, Redo2, Clock, ChevronDown,
    Plus, Trash2, Scissors, Copy, Move, ArrowUpDown,
    Plug, ArrowRight, Volume2, ArrowUpFromLine,
    ArrowDownToLine, RotateCcw, VolumeX, Clipboard,
    FileAudio, Music, Gauge, Layers, TrendingUp,
} from "lucide-react";

// Icon resolver (best-effort match from icon hint strings)
const ICON_MAP: Record<string, typeof Plus> = {
    Plus, Trash2, Scissors, Copy, Move, ArrowUpDown,
    Plug, ArrowRight, Volume2, ArrowUpFromLine,
    ArrowDownToLine, RotateCcw, VolumeX, Clipboard,
    FileAudio, Music, Gauge, Layers, TrendingUp, Clock,
};

function getIcon(hint?: string) {
    if (!hint) return Clock;
    return ICON_MAP[hint] || Clock;
}

// ═══════════════════════════════════════════════════════════════════════════
// History Panel — visual time-travel for DAW or Sound Editor
// ═══════════════════════════════════════════════════════════════════════════

interface HistoryPanelProps<T> {
    history: HistoryState<T>;
    onUndo: () => void;
    onRedo: () => void;
    onJump: (index: number) => void;
    className?: string;
    compact?: boolean;
}

export function HistoryPanel<T>({
    history,
    onUndo,
    onRedo,
    onJump,
    className,
    compact = false,
}: HistoryPanelProps<T>) {
    const { entries, currentIndex } = history;

    const timeAgo = useMemo(() => {
        const now = Date.now();
        return (ts: number) => {
            const diff = now - ts;
            if (diff < 60_000) return "just now";
            if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
            return `${Math.floor(diff / 3_600_000)}h ago`;
        };
    }, []);

    return (
        <div className={cn(
            "flex flex-col h-full bg-[var(--daw-surface,oklch(0.14_0.01_260))]",
            "text-[var(--daw-text,oklch(0.95_0.01_260))]",
            className,
        )}>
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--daw-border,oklch(1_0_0/0.08))]">
                <Clock className="h-3.5 w-3.5 text-[var(--daw-text-dim,oklch(1_0_0/0.3))]" />
                <span className="text-xs font-medium flex-1">History</span>
                <span className="text-[10px] font-mono text-[var(--daw-text-dim,oklch(1_0_0/0.3))]">
                    {currentIndex}/{entries.length - 1}
                </span>
                <button
                    onClick={onUndo}
                    disabled={!canUndo(history)}
                    className="h-5 w-5 flex items-center justify-center rounded hover:bg-[var(--daw-hover,oklch(1_0_0/0.05))] disabled:opacity-20 transition-colors"
                    title="Undo"
                >
                    <Undo2 className="h-3 w-3" />
                </button>
                <button
                    onClick={onRedo}
                    disabled={!canRedo(history)}
                    className="h-5 w-5 flex items-center justify-center rounded hover:bg-[var(--daw-hover,oklch(1_0_0/0.05))] disabled:opacity-20 transition-colors"
                    title="Redo"
                >
                    <Redo2 className="h-3 w-3" />
                </button>
            </div>

            {/* Entry list */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
                {entries.map((entry, i) => {
                    const Icon = getIcon(entry.icon);
                    const isCurrent = i === currentIndex;
                    const isFuture = i > currentIndex;
                    const isPast = i < currentIndex;

                    return (
                        <button
                            key={entry.id}
                            onClick={() => onJump(i)}
                            className={cn(
                                "w-full flex items-center gap-2 px-3 text-left transition-all",
                                compact ? "py-1" : "py-1.5",
                                "hover:bg-[var(--daw-hover,oklch(1_0_0/0.05))]",
                                isCurrent && "bg-[oklch(0.62_0.19_250/0.12)] border-l-2 border-l-[oklch(0.62_0.19_250)]",
                                isFuture && "opacity-35",
                                isPast && "opacity-70",
                                !isCurrent && "border-l-2 border-l-transparent",
                            )}
                        >
                            {/* Timeline dot */}
                            <div className="flex flex-col items-center shrink-0">
                                <div className={cn(
                                    "h-2 w-2 rounded-full transition-colors",
                                    isCurrent ? "bg-[oklch(0.62_0.19_250)]" : isPast ? "bg-[oklch(1_0_0/0.2)]" : "bg-[oklch(1_0_0/0.08)]",
                                )} />
                                {i < entries.length - 1 && (
                                    <div className={cn(
                                        "w-px flex-1 min-h-[8px]",
                                        i < currentIndex ? "bg-[oklch(1_0_0/0.12)]" : "bg-[oklch(1_0_0/0.04)]",
                                    )} />
                                )}
                            </div>

                            {/* Icon */}
                            <Icon className={cn(
                                "h-3 w-3 shrink-0",
                                isCurrent ? "text-[oklch(0.62_0.19_250)]" : "text-[var(--daw-text-dim,oklch(1_0_0/0.3))]",
                            )} />

                            {/* Label */}
                            <div className="flex-1 min-w-0">
                                <div className={cn(
                                    "text-[11px] truncate",
                                    isCurrent && "font-medium text-[oklch(0.62_0.19_250)]",
                                )}>
                                    {entry.label}
                                </div>
                                {!compact && (
                                    <div className="text-[9px] text-[var(--daw-text-dim,oklch(1_0_0/0.2))]">
                                        {timeAgo(entry.timestamp)}
                                    </div>
                                )}
                            </div>

                            {/* Current indicator */}
                            {isCurrent && (
                                <ChevronDown className="h-3 w-3 text-[oklch(0.62_0.19_250)] shrink-0 rotate-[-90deg]" />
                            )}
                        </button>
                    );
                })}
            </div>

            {/* Footer */}
            <div className="px-3 py-1.5 border-t border-[var(--daw-border,oklch(1_0_0/0.08))] text-[9px] text-[var(--daw-text-dim,oklch(1_0_0/0.2))]">
                {entries.length} entries · Click to jump · Ctrl+Z/Y to undo/redo
            </div>
        </div>
    );
}
