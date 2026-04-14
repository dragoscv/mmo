"use client";

import { usePlayer } from "./player-context";
import { formatDuration, cn } from "@/lib/utils";
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    Volume2,
    VolumeX,
    ChevronUp,
    Shuffle,
    Repeat,
    Repeat1,
    ListMusic,
    Heart,
    Disc3,
} from "lucide-react";

export function AudioPlayer() {
    const player = usePlayer();
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

    if (!currentTrack) return null;

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
    const upNextCount = queue.length - queueIndex - 1;

    return (
        <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-[var(--border)] bg-[var(--card)]/95 backdrop-blur-md">
            {/* Thin progress line at top */}
            <div className="absolute top-0 left-0 right-0 h-0.5 bg-[var(--secondary)]">
                <div
                    className="h-full bg-purple-500 transition-[width] duration-200 ease-linear"
                    style={{ width: `${progress}%` }}
                />
            </div>

            <div className="flex items-center gap-4 px-4 py-2 h-16">
                {/* Track Info - clickable to open Now Playing */}
                <button
                    onClick={openNowPlaying}
                    className="flex items-center gap-3 w-64 min-w-0 text-left group cursor-pointer"
                >
                    <div className="relative h-10 w-10 rounded-lg bg-purple-500/20 flex items-center justify-center shrink-0 overflow-hidden group-hover:ring-2 ring-purple-500/40 transition-all">
                        {currentTrack.artworkUrl ? (
                            <img
                                src={currentTrack.artworkUrl}
                                alt=""
                                className="h-full w-full object-cover"
                            />
                        ) : (
                            <Disc3
                                className={cn(
                                    "h-5 w-5 text-purple-400",
                                    isPlaying && "animate-[vinylSpin_3s_linear_infinite]"
                                )}
                            />
                        )}
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate group-hover:text-purple-400 transition-colors">
                            {currentTrack.title || currentTrack.filename}
                        </p>
                        <p className="text-xs text-[var(--muted-foreground)] truncate">
                            {currentTrack.artist || "Unknown Artist"}
                        </p>
                    </div>
                    <ChevronUp className="h-4 w-4 text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                </button>

                {/* Controls */}
                <div className="flex flex-col items-center flex-1 gap-1">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={toggleShuffle}
                            className={cn(
                                "transition-colors hidden sm:block cursor-pointer",
                                shuffle ? "text-purple-400" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                            )}
                        >
                            <Shuffle className="h-3.5 w-3.5" />
                        </button>
                        <button
                            onClick={prev}
                            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors cursor-pointer"
                        >
                            <SkipBack className="h-4 w-4" />
                        </button>
                        <button
                            onClick={togglePlay}
                            className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--foreground)] text-[var(--background)] hover:scale-105 active:scale-95 transition-transform cursor-pointer"
                        >
                            {isPlaying ? (
                                <Pause className="h-4 w-4" />
                            ) : (
                                <Play className="h-4 w-4 ml-0.5" />
                            )}
                        </button>
                        <button
                            onClick={next}
                            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors cursor-pointer"
                        >
                            <SkipForward className="h-4 w-4" />
                        </button>
                        <button
                            onClick={toggleRepeat}
                            className={cn(
                                "transition-colors hidden sm:block cursor-pointer",
                                repeat !== "off" ? "text-purple-400" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                            )}
                        >
                            {repeat === "one" ? <Repeat1 className="h-3.5 w-3.5" /> : <Repeat className="h-3.5 w-3.5" />}
                        </button>
                    </div>

                    {/* Progress Bar */}
                    <div className="flex items-center gap-2 w-full max-w-xl">
                        <span className="text-[10px] text-[var(--muted-foreground)] w-10 text-right tabular-nums">
                            {formatDuration(Math.floor(currentTime))}
                        </span>
                        <div
                            className="relative flex-1 h-1 rounded-full bg-[var(--secondary)] cursor-pointer group"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                const pct = (e.clientX - rect.left) / rect.width;
                                seek(pct * duration);
                            }}
                        >
                            <div
                                className="absolute h-full rounded-full bg-[var(--foreground)] group-hover:bg-purple-400 transition-colors"
                                style={{ width: `${progress}%` }}
                            />
                            <div
                                className="absolute top-1/2 -translate-y-1/2 h-3 w-3 rounded-full bg-[var(--foreground)] opacity-0 group-hover:opacity-100 transition-opacity"
                                style={{ left: `${progress}%`, marginLeft: "-6px" }}
                            />
                        </div>
                        <span className="text-[10px] text-[var(--muted-foreground)] w-10 tabular-nums">
                            {formatDuration(Math.floor(duration))}
                        </span>
                    </div>
                </div>

                {/* Right Side - Volume + Queue */}
                <div className="flex items-center gap-3 w-44">
                    {upNextCount > 0 && (
                        <button
                            onClick={openNowPlaying}
                            className="flex items-center gap-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors cursor-pointer"
                            title={`${upNextCount} tracks in queue`}
                        >
                            <ListMusic className="h-3.5 w-3.5" />
                            <span className="text-[10px] tabular-nums">{upNextCount}</span>
                        </button>
                    )}
                    <div className="flex items-center gap-2 flex-1">
                        <button
                            onClick={() => setVolume(volume > 0 ? 0 : 0.8)}
                            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
                        >
                            {volume === 0 ? (
                                <VolumeX className="h-4 w-4" />
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
                            className="w-full h-1 accent-[var(--foreground)] cursor-pointer"
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
