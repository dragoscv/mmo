"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { cn, formatNumber } from "@/lib/utils";
import {
    Sparkles,
    Pause,
    Play,
    Loader2,
    CheckCircle2,
    StopCircle,
    GripHorizontal,
} from "lucide-react";
import type { JobStatus } from "@/hooks/use-analysis";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FloatingStatusProps {
    status: JobStatus;
    progress: number;
    total: number;
    changesCount: number;
    currentTrack: string;
    onOpen: () => void;
    onPause: () => Promise<void>;
    onResume: () => Promise<void>;
}

// ─── Position Persistence ────────────────────────────────────────────────────

const WIDGET_POS_KEY = "analysis-widget-position";

function loadWidgetPosition(): { x: number; y: number } | null {
    try {
        const raw = localStorage.getItem(WIDGET_POS_KEY);
        if (!raw) return null;
        const pos = JSON.parse(raw);
        if (typeof pos.x === "number" && typeof pos.y === "number") return pos;
    } catch { }
    return null;
}

function saveWidgetPosition(pos: { x: number; y: number }) {
    try {
        localStorage.setItem(WIDGET_POS_KEY, JSON.stringify(pos));
    } catch { }
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AnalysisFloatingStatus({
    status,
    progress,
    total,
    changesCount,
    currentTrack,
    onOpen,
    onPause,
    onResume,
}: FloatingStatusProps) {
    // ─── Drag State ──────────────────────────────────────────────────────
    const [position, setPosition] = useState(() => {
        return loadWidgetPosition() ?? { x: 20, y: 20 };
    });
    const [isDragging, setIsDragging] = useState(false);
    const didDragRef = useRef(false);
    const dragStart = useRef({ x: 0, y: 0, posX: 0, posY: 0 });
    const containerRef = useRef<HTMLDivElement>(null);

    const onPointerDown = useCallback(
        (e: React.PointerEvent) => {
            e.preventDefault();
            setIsDragging(true);
            didDragRef.current = false;
            dragStart.current = {
                x: e.clientX,
                y: e.clientY,
                posX: position.x,
                posY: position.y,
            };
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
        },
        [position]
    );

    const onPointerMove = useCallback(
        (e: React.PointerEvent) => {
            if (!isDragging) return;
            didDragRef.current = true;
            const dx = e.clientX - dragStart.current.x;
            const dy = e.clientY - dragStart.current.y;
            const newX = dragStart.current.posX + dx;
            const newY = dragStart.current.posY + dy;

            // Clamp to viewport
            const maxX = window.innerWidth - 60;
            const maxY = window.innerHeight - 40;
            setPosition({
                x: Math.max(0, Math.min(newX, maxX)),
                y: Math.max(0, Math.min(newY, maxY)),
            });
        },
        [isDragging]
    );

    const onPointerUp = useCallback(() => {
        setIsDragging(false);
        if (didDragRef.current) {
            // Save final position after drag
            setPosition(pos => {
                saveWidgetPosition(pos);
                return pos;
            });
        }
    }, []);

    // ─── Position initialization (bottom-right, only if no saved position) ─
    useEffect(() => {
        const saved = loadWidgetPosition();
        if (!saved) {
            setPosition({
                x: window.innerWidth - 340,
                y: window.innerHeight - 140,
            });
        }
    }, []);

    // ─── Derived ─────────────────────────────────────────────────────────
    const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
    const isRunning = status === "running";
    const isPaused = status === "paused";
    const isDone = status === "completed" || status === "stopped";

    return (
        <div
            ref={containerRef}
            className={cn(
                "fixed z-50 select-none",
                "animate-in fade-in slide-in-from-bottom-4 duration-300"
            )}
            style={{
                left: position.x,
                top: position.y,
                transition: isDragging ? "none" : "box-shadow 0.2s",
            }}
        >
            <div
                className={cn(
                    "flex flex-col rounded-2xl border shadow-2xl backdrop-blur-xl",
                    "w-[300px] overflow-hidden",
                    isDone
                        ? "border-green-500/30 bg-[var(--card)]/95"
                        : isPaused
                            ? "border-amber-500/30 bg-[var(--card)]/95"
                            : "border-purple-500/30 bg-[var(--card)]/95"
                )}
            >
                {/* Progress bar (thin top bar) */}
                {!isDone && (
                    <div className="h-1 w-full bg-[var(--secondary)]">
                        <div
                            className={cn(
                                "h-full transition-[width] duration-700 ease-out",
                                isPaused
                                    ? "bg-gradient-to-r from-amber-500 to-orange-500"
                                    : "bg-gradient-to-r from-purple-500 to-pink-500"
                            )}
                            style={{ width: `${pct}%` }}
                        />
                    </div>
                )}

                {/* Header row — drag handle + title */}
                <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
                    {/* Drag handle */}
                    <div
                        className={cn(
                            "flex items-center justify-center rounded p-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]",
                            isDragging ? "cursor-grabbing" : "cursor-grab"
                        )}
                        onPointerDown={onPointerDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                    >
                        <GripHorizontal className="h-3.5 w-3.5" />
                    </div>

                    {/* Status icon + label */}
                    <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        {isRunning && (
                            <Loader2 className="h-3.5 w-3.5 text-purple-400 animate-spin shrink-0" />
                        )}
                        {isPaused && (
                            <Pause className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                        )}
                        {isDone && (
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-400 shrink-0" />
                        )}
                        <span className="text-xs font-medium truncate">
                            {isRunning && "Analyzing Library"}
                            {isPaused && "Analysis Paused"}
                            {isDone &&
                                `Analysis Done — ${changesCount} updates`}
                        </span>
                    </div>

                    {/* Percentage */}
                    {!isDone && (
                        <span className="text-xs font-mono font-bold text-purple-400 tabular-nums shrink-0">
                            {pct}%
                        </span>
                    )}
                </div>

                {/* Track info */}
                {!isDone && currentTrack && (
                    <div className="px-3 pb-1">
                        <p className="text-[10px] text-[var(--muted-foreground)] truncate">
                            {currentTrack}
                        </p>
                    </div>
                )}

                {/* Stats row */}
                <div className="flex items-center gap-3 px-3 pb-2 text-[10px] text-[var(--muted-foreground)]">
                    <span className="tabular-nums">
                        <span className="text-[var(--foreground)] font-medium">
                            {formatNumber(progress)}
                        </span>
                        /{formatNumber(total)} tracks
                    </span>
                    <span className="tabular-nums">
                        <span className="text-green-400 font-medium">
                            {changesCount}
                        </span>{" "}
                        updates
                    </span>
                </div>

                {/* Action row */}
                <div className="flex items-center border-t border-[var(--border)] divide-x divide-[var(--border)]">
                    {/* Pause/Resume toggle */}
                    {!isDone && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                isRunning ? onPause() : onResume();
                            }}
                            className={cn(
                                "flex items-center justify-center gap-1.5 flex-1 py-2 text-xs transition-colors cursor-pointer",
                                "hover:bg-[var(--accent)]",
                                isPaused
                                    ? "text-green-400 hover:text-green-300"
                                    : "text-amber-400 hover:text-amber-300"
                            )}
                        >
                            {isRunning ? (
                                <>
                                    <Pause className="h-3 w-3" />
                                    Pause
                                </>
                            ) : (
                                <>
                                    <Play className="h-3 w-3" />
                                    Resume
                                </>
                            )}
                        </button>
                    )}

                    {/* Open modal */}
                    <button
                        onClick={onOpen}
                        className={cn(
                            "flex items-center justify-center gap-1.5 flex-1 py-2 text-xs transition-colors cursor-pointer",
                            "text-purple-400 hover:text-purple-300 hover:bg-[var(--accent)]"
                        )}
                    >
                        <Sparkles className="h-3 w-3" />
                        {isDone ? "Review Changes" : "Open"}
                    </button>
                </div>
            </div>
        </div>
    );
}
