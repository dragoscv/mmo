"use client";

import { useState } from "react";
import {
    SkipBack, SkipForward, Shuffle, Heart, BarChart3,
    Maximize, Minimize, Layers, RectangleHorizontal, Shrink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { VisualizationDef } from "@/lib/visualizations/types";

interface VisualizationControlsProps {
    current: VisualizationDef;
    isFavorite: boolean;
    showStats: boolean;
    isTheater: boolean;
    isFullscreen: boolean;
    onPrev: () => void;
    onNext: () => void;
    onRandom: () => void;
    onToggleFavorite: () => void;
    onToggleStats: () => void;
    onToggleTheater: () => void;
    onToggleFullscreen: () => void;
    onOpenBrowser: () => void;
    fps?: number;
}

export function VisualizationControls({
    current,
    isFavorite,
    showStats,
    isTheater,
    isFullscreen,
    onPrev,
    onNext,
    onRandom,
    onToggleFavorite,
    onToggleStats,
    onToggleTheater,
    onToggleFullscreen,
    onOpenBrowser,
    fps,
}: VisualizationControlsProps) {
    const [visible, setVisible] = useState(true);

    return (
        <div
            className="absolute inset-0 z-10"
            onMouseEnter={() => setVisible(true)}
            onMouseLeave={() => setVisible(false)}
        >
            {/* Top bar */}
            <div
                className={cn(
                    "absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/60 to-transparent transition-opacity duration-300",
                    visible ? "opacity-100" : "opacity-0"
                )}
            >
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-white/40 uppercase tracking-wide">{current.category}</span>
                    <span className="text-white/20">·</span>
                    <span className="text-sm text-white/80 truncate">{current.name}</span>
                    {current.interactive && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 uppercase">
                            Interactive
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    {fps != null && (
                        <span className={cn(
                            "text-[10px] font-mono tabular-nums mr-2",
                            fps >= 50 ? "text-green-400/60" : fps >= 30 ? "text-yellow-400/60" : "text-red-400/60"
                        )}>
                            {fps} FPS
                        </span>
                    )}
                    <button
                        onClick={onToggleStats}
                        className={cn(
                            "p-2 rounded-lg transition-colors cursor-pointer",
                            showStats ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"
                        )}
                        title="Toggle stats"
                    >
                        <BarChart3 className="h-4 w-4" />
                    </button>
                    <button
                        onClick={onToggleTheater}
                        className={cn(
                            "p-2 rounded-lg transition-colors cursor-pointer",
                            isTheater ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"
                        )}
                        title={isTheater ? "Exit theater mode" : "Theater mode"}
                    >
                        {isTheater
                            ? <Shrink className="h-4 w-4" />
                            : <RectangleHorizontal className="h-4 w-4" />
                        }
                    </button>
                    <button
                        onClick={onToggleFullscreen}
                        className={cn(
                            "p-2 rounded-lg transition-colors cursor-pointer",
                            isFullscreen ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"
                        )}
                        title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                    >
                        {isFullscreen
                            ? <Minimize className="h-4 w-4" />
                            : <Maximize className="h-4 w-4" />
                        }
                    </button>
                </div>
            </div>

            {/* Bottom bar */}
            <div
                className={cn(
                    "absolute bottom-0 left-0 right-0 flex items-center justify-center gap-3 px-4 py-3 bg-gradient-to-t from-black/60 to-transparent transition-opacity duration-300",
                    visible ? "opacity-100" : "opacity-0"
                )}
            >
                <button
                    onClick={onOpenBrowser}
                    className="p-2 rounded-lg text-white/40 hover:text-white/70 transition-colors cursor-pointer"
                    title="Browse visualizations"
                >
                    <Layers className="h-4 w-4" />
                </button>
                <button
                    onClick={onPrev}
                    className="p-2.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                    title="Previous"
                >
                    <SkipBack className="h-4 w-4" />
                </button>
                <button
                    onClick={onRandom}
                    className="p-2.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                    title="Random"
                >
                    <Shuffle className="h-4 w-4" />
                </button>
                <button
                    onClick={onNext}
                    className="p-2.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                    title="Next"
                >
                    <SkipForward className="h-4 w-4" />
                </button>
                <button
                    onClick={onToggleFavorite}
                    className={cn(
                        "p-2 rounded-lg transition-colors cursor-pointer",
                        isFavorite
                            ? "text-rose-400"
                            : "text-white/40 hover:text-rose-400"
                    )}
                    title={isFavorite ? "Remove from favorites" : "Add to favorites"}
                >
                    <Heart className={cn("h-4 w-4", isFavorite && "fill-current")} />
                </button>
            </div>
        </div>
    );
}
