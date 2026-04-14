"use client";

import { usePlayer } from "./player-context";
import { formatDuration, cn } from "@/lib/utils";
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    Volume2,
    Volume1,
    VolumeX,
    ChevronUp,
    Shuffle,
    Repeat,
    Repeat1,
    ListMusic,
    Heart,
    Disc3,
} from "lucide-react";
import { useRef, useCallback } from "react";

// ─── Waveform Bars ──────────────────────────────────────────────────────
function PlayingIndicator({ isPlaying }: { isPlaying: boolean }) {
    return (
        <div className="flex items-end gap-[2px] h-3.5 w-3.5 shrink-0">
            {[0, 1, 2, 3].map((i) => (
                <div
                    key={i}
                    className={cn(
                        "w-[2.5px] rounded-full origin-bottom transition-all duration-300",
                        isPlaying
                            ? "bg-purple-400 animate-[barBounce_0.8s_ease-in-out_infinite]"
                            : "bg-purple-400/40 h-[3px]"
                    )}
                    style={{
                        animationDelay: isPlaying ? `${i * 0.12}s` : undefined,
                        height: isPlaying ? undefined : "3px",
                    }}
                />
            ))}
        </div>
    );
}

export function AudioPlayer() {
    const player = usePlayer();
    const progressRef = useRef<HTMLDivElement>(null);
    const {
        currentTrack,
        isPlaying,
        currentTime,
        duration,
        volume,
        queue,
        queueIndex,
        shuffle,
        repeat,
        togglePlay,
        next,
        prev,
        seek,
        setVolume,
        toggleShuffle,
        toggleRepeat,
        openNowPlaying,
    } = player;

    const handleProgressClick = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            seek(Math.max(0, Math.min(1, pct)) * duration);
        },
        [seek, duration]
    );

    if (!currentTrack) return null;

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
    const upNextCount = queue.length - queueIndex - 1;
    const volumePercent = Math.round(volume * 100);

    return (
        <div className="fixed bottom-0 left-0 right-0 z-50 animate-[slideUpFade_300ms_ease-out]">
            {/* Gradient glow behind the bar */}
            <div className="absolute -top-8 left-0 right-0 h-8 bg-gradient-to-t from-background/80 to-transparent pointer-events-none" />

            {/* Glass container */}
            <div className="relative bg-card/90 backdrop-blur-2xl border-t border-border">
                {/* Animated progress line at top */}
                <div className="absolute top-0 left-0 right-0 h-[2px] bg-muted">
                    <div
                        className="h-full bg-gradient-to-r from-purple-500 via-purple-400 to-fuchsia-500 transition-[width] duration-200 ease-linear"
                        style={{ width: `${progress}%` }}
                    />
                    {/* Glow dot at the end of progress */}
                    <div
                        className="absolute top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-purple-400 shadow-[0_0_8px_rgba(139,92,246,0.6)] transition-[left] duration-200 ease-linear"
                        style={{ left: `${progress}%`, marginLeft: "-4px", opacity: progress > 0 ? 1 : 0 }}
                    />
                </div>

                <div className="flex items-center gap-3 px-4 py-2.5 h-[72px]">
                    {/* ─── Track Info (clickable) ──────────────────────────── */}
                    <button
                        onClick={openNowPlaying}
                        className="flex items-center gap-3 w-72 min-w-0 text-left group cursor-pointer"
                    >
                        {/* Artwork with glow */}
                        <div className="relative shrink-0">
                            <div className={cn(
                                "h-12 w-12 rounded-xl overflow-hidden ring-1 ring-border transition-all duration-300",
                                "group-hover:ring-purple-500/30 group-hover:shadow-[0_0_20px_rgba(139,92,246,0.15)]",
                                isPlaying && "shadow-[0_0_16px_rgba(139,92,246,0.1)]"
                            )}>
                                {currentTrack.artworkUrl ? (
                                    <img
                                        src={currentTrack.artworkUrl}
                                        alt=""
                                        className={cn(
                                            "h-full w-full object-cover transition-transform duration-[3s]",
                                            isPlaying && "animate-[vinylSpin_20s_linear_infinite]"
                                        )}
                                    />
                                ) : (
                                    <div className="h-full w-full bg-gradient-to-br from-purple-500/20 to-fuchsia-500/20 flex items-center justify-center">
                                        <Disc3
                                            className={cn(
                                                "h-6 w-6 text-purple-400/60",
                                                isPlaying && "animate-[vinylSpin_3s_linear_infinite]"
                                            )}
                                        />
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Track text */}
                        <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex items-center gap-2">
                                <p className="text-[13px] font-semibold truncate group-hover:text-purple-300 transition-colors duration-200">
                                    {currentTrack.title || currentTrack.filename}
                                </p>
                                {currentTrack.isFavorite && (
                                    <Heart className="h-3 w-3 fill-rose-500 text-rose-500 shrink-0" />
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <p className="text-[11px] text-muted-foreground truncate">
                                    {currentTrack.artist || "Unknown Artist"}
                                </p>
                                {isPlaying && <PlayingIndicator isPlaying={isPlaying} />}
                            </div>
                        </div>

                        <ChevronUp className="h-4 w-4 text-muted-foreground/50 opacity-0 group-hover:opacity-100 group-hover:text-muted-foreground transition-all duration-200 shrink-0" />
                    </button>

                    {/* ─── Center – Controls + Seekbar ────────────────────── */}
                    <div className="flex flex-col items-center flex-1 gap-1.5">
                        {/* Transport Controls */}
                        <div className="flex items-center gap-4">
                            <button
                                onClick={toggleShuffle}
                                className={cn(
                                    "p-1 rounded-md transition-all duration-200 hidden sm:block cursor-pointer",
                                    shuffle
                                        ? "text-purple-400 bg-purple-500/10"
                                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                                )}
                                title={shuffle ? "Shuffle: On" : "Shuffle: Off"}
                            >
                                <Shuffle className="h-3.5 w-3.5" />
                            </button>

                            <button
                                onClick={prev}
                                className="text-muted-foreground hover:text-foreground hover:scale-110 active:scale-95 transition-all duration-150 cursor-pointer"
                            >
                                <SkipBack className="h-4.5 w-4.5" />
                            </button>

                            <button
                                onClick={togglePlay}
                                className={cn(
                                    "flex h-10 w-10 items-center justify-center rounded-full transition-all duration-200 cursor-pointer",
                                    "bg-gradient-to-br from-purple-500 to-fuchsia-600 text-white",
                                    "hover:from-purple-400 hover:to-fuchsia-500 hover:shadow-[0_0_20px_rgba(139,92,246,0.4)]",
                                    "hover:scale-105 active:scale-95",
                                    isPlaying && "shadow-[0_0_12px_rgba(139,92,246,0.25)]"
                                )}
                            >
                                {isPlaying ? (
                                    <Pause className="h-4 w-4" />
                                ) : (
                                    <Play className="h-4 w-4 ml-0.5" />
                                )}
                            </button>

                            <button
                                onClick={next}
                                className="text-muted-foreground hover:text-foreground hover:scale-110 active:scale-95 transition-all duration-150 cursor-pointer"
                            >
                                <SkipForward className="h-4.5 w-4.5" />
                            </button>

                            <button
                                onClick={toggleRepeat}
                                className={cn(
                                    "p-1 rounded-md transition-all duration-200 hidden sm:block cursor-pointer",
                                    repeat !== "off"
                                        ? "text-purple-400 bg-purple-500/10"
                                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                                )}
                                title={`Repeat: ${repeat}`}
                            >
                                {repeat === "one" ? (
                                    <Repeat1 className="h-3.5 w-3.5" />
                                ) : (
                                    <Repeat className="h-3.5 w-3.5" />
                                )}
                            </button>
                        </div>

                        {/* Seekbar */}
                        <div className="flex items-center gap-2.5 w-full max-w-xl">
                            <span className="text-[10px] text-muted-foreground w-10 text-right tabular-nums font-mono">
                                {formatDuration(Math.floor(currentTime))}
                            </span>
                            <div
                                ref={progressRef}
                                className="relative flex-1 h-1 rounded-full bg-muted cursor-pointer group/seek"
                                onClick={handleProgressClick}
                            >
                                {/* Filled portion */}
                                <div
                                    className="absolute h-full rounded-full bg-gradient-to-r from-purple-500 to-fuchsia-500 group-hover/seek:from-purple-400 group-hover/seek:to-fuchsia-400 transition-colors duration-200"
                                    style={{ width: `${progress}%` }}
                                />
                                {/* Hover thumb */}
                                <div
                                    className="absolute top-1/2 -translate-y-1/2 h-3.5 w-3.5 rounded-full bg-foreground shadow-[0_0_6px_rgba(139,92,246,0.5)] scale-0 group-hover/seek:scale-100 transition-transform duration-150"
                                    style={{ left: `${progress}%`, marginLeft: "-7px" }}
                                />
                            </div>
                            <span className="text-[10px] text-muted-foreground w-10 tabular-nums font-mono">
                                {formatDuration(Math.floor(duration))}
                            </span>
                        </div>
                    </div>

                    {/* ─── Right – Queue + Volume ─────────────────────────── */}
                    <div className="flex items-center gap-3 w-48">
                        {/* Queue indicator */}
                        {upNextCount > 0 && (
                            <button
                                onClick={openNowPlaying}
                                className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-muted hover:bg-accent text-muted-foreground hover:text-foreground transition-all duration-200 cursor-pointer"
                                title={`${upNextCount} tracks in queue`}
                            >
                                <ListMusic className="h-3.5 w-3.5" />
                                <span className="text-[10px] tabular-nums font-medium">{upNextCount}</span>
                            </button>
                        )}

                        {/* Volume */}
                        <div className="flex items-center gap-2 flex-1 group/vol">
                            <button
                                onClick={() => setVolume(volume > 0 ? 0 : 0.8)}
                                className="text-muted-foreground hover:text-foreground transition-colors duration-200 cursor-pointer"
                            >
                                {volume === 0 ? (
                                    <VolumeX className="h-4 w-4" />
                                ) : volume < 0.5 ? (
                                    <Volume1 className="h-4 w-4" />
                                ) : (
                                    <Volume2 className="h-4 w-4" />
                                )}
                            </button>
                            <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.01}
                                value={volume}
                                onChange={(e) => setVolume(parseFloat(e.target.value))}
                                className="volume-slider w-full"
                                style={{ "--value": `${volumePercent}%` } as React.CSSProperties}
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
