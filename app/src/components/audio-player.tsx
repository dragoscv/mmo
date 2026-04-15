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
import { useRef, useCallback, useEffect, useState } from "react";
import { TrackContextMenu } from "./track-actions";
import { useSidebar } from "./sidebar-context";

// Touch swipe helpers — detects swipe-up and swipe-right
function useBarSwipe(onSwipeUp: () => void, onSwipeRight: () => void) {
    const touchRef = useRef<{ x: number; y: number; time: number } | null>(null);
    const onTouchStart = useCallback((e: React.TouchEvent) => {
        const t = e.touches[0];
        touchRef.current = { x: t.clientX, y: t.clientY, time: Date.now() };
    }, []);
    const onTouchEnd = useCallback((e: React.TouchEvent) => {
        if (!touchRef.current) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - touchRef.current.x;
        const dy = t.clientY - touchRef.current.y;
        const dt = Date.now() - touchRef.current.time;
        touchRef.current = null;
        if (dt > 400) return;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (dy < -50 && absDy > absDx) { onSwipeUp(); return; }
        if (dx > 60 && absDx > absDy) { onSwipeRight(); return; }
    }, [onSwipeUp, onSwipeRight]);
    return { onTouchStart, onTouchEnd };
}

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

    const { openMobile } = useSidebar();
    const swipe = useBarSwipe(openNowPlaying, openMobile);

    if (!currentTrack) {
        // Minimal bar when no track is loaded — allows opening Now Playing
        return (
            <div
                className="fixed bottom-0 left-0 right-0 z-50"
                onTouchStart={swipe.onTouchStart}
                onTouchEnd={swipe.onTouchEnd}
            >
                <div className="absolute -top-8 left-0 right-0 h-8 bg-gradient-to-t from-background/80 to-transparent pointer-events-none" />
                <div className="relative bg-card/90 backdrop-blur-2xl border-t border-border pb-[env(safe-area-inset-bottom)]">
                    <div className="flex items-center justify-center gap-3 px-4 py-3 h-[56px]">
                        <button
                            onClick={openNowPlaying}
                            className="flex items-center gap-2.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer group"
                        >
                            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-purple-500/20 to-fuchsia-500/20 flex items-center justify-center ring-1 ring-border group-hover:ring-purple-500/30 transition-all">
                                <Disc3 className="h-4 w-4 text-purple-400/60" />
                            </div>
                            <div className="text-left">
                                <p className="text-xs font-medium group-hover:text-purple-300 transition-colors">Now Playing</p>
                                <p className="text-[10px] text-muted-foreground/60">No track loaded · Press N to open</p>
                            </div>
                            <ChevronUp className="h-4 w-4 text-muted-foreground/30 group-hover:text-muted-foreground/70 transition-colors ml-1" />
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
    const upNextCount = queue.length - queueIndex - 1;
    const volumePercent = Math.round(volume * 100);

    return (
        <TrackContextMenu track={currentTrack} onMutate={() => { }}>
            <div
                className="fixed bottom-0 left-0 right-0 z-50 animate-[slideUpFade_300ms_ease-out]"
                onTouchStart={swipe.onTouchStart}
                onTouchEnd={swipe.onTouchEnd}
            >
                {/* Gradient glow behind the bar */}
                <div className="absolute -top-8 left-0 right-0 h-8 bg-gradient-to-t from-background/80 to-transparent pointer-events-none" />

                {/* Glass container */}
                <div className="relative bg-card/90 backdrop-blur-2xl border-t border-border pb-[env(safe-area-inset-bottom)]">
                    {/* Decorative background waveform */}
                    <BarWaveformBg trackId={currentTrack.id} progress={progress / 100} isPlaying={isPlaying} />
                    {/* Animated progress line at top — clickable for seeking */}
                    <div
                        className="absolute top-0 left-0 right-0 h-4 -mt-2 cursor-pointer group/top z-10"
                        onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            const pct = (e.clientX - rect.left) / rect.width;
                            seek(Math.max(0, Math.min(1, pct)) * duration);
                        }}
                    >
                        <div className="absolute bottom-[7px] left-0 right-0 h-[2px] bg-muted">
                            <div
                                className="h-full bg-gradient-to-r from-purple-500 via-purple-400 to-fuchsia-500 transition-[width] duration-200 ease-linear"
                                style={{ width: `${progress}%` }}
                            />
                            {/* Glow dot at the end of progress */}
                            <div
                                className="absolute top-1/2 h-2.5 w-2.5 rounded-full bg-purple-400 shadow-[0_0_8px_rgba(139,92,246,0.6)] transition-[left] duration-200 ease-linear group-hover/top:h-3.5 group-hover/top:w-3.5"
                                style={{ left: `${progress}%`, transform: "translate(-50%, -50%)", opacity: progress > 0 ? 1 : 0 }}
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-2.5 h-[72px]">
                        {/* ─── Left – Track Info (clickable) ──────────────────── */}
                        <button
                            onClick={openNowPlaying}
                            className="flex items-center gap-3 min-w-0 text-left group cursor-pointer"
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

                            {/* Track text + details */}
                            <div className="min-w-0 flex-1 space-y-0.5">
                                <div className="flex items-center gap-2">
                                    <p className="text-[13px] font-semibold truncate group-hover:text-purple-300 transition-colors duration-200">
                                        {currentTrack.title || currentTrack.filename}
                                    </p>
                                    {currentTrack.isFavorite && (
                                        <Heart className="h-3 w-3 fill-rose-500 text-rose-500 shrink-0" />
                                    )}
                                    {/* Track details badges */}
                                    <div className="hidden md:flex items-center gap-1.5 shrink-0">
                                        {currentTrack.bpm && (
                                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground tabular-nums">
                                                {Math.round(currentTrack.bpm)}
                                            </span>
                                        )}
                                        {currentTrack.keyCamelot && (
                                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                                {currentTrack.keyCamelot}
                                                {currentTrack.keyMusical ? ` · ${currentTrack.keyMusical}` : ""}
                                            </span>
                                        )}
                                        {currentTrack.genre && (
                                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400">
                                                {currentTrack.genre}
                                            </span>
                                        )}
                                        {currentTrack.bitrate && (
                                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground tabular-nums">
                                                {currentTrack.bitrate}kbps
                                            </span>
                                        )}
                                        {currentTrack.format && (
                                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase">
                                                {currentTrack.format}
                                            </span>
                                        )}
                                        <span className="text-[9px] text-muted-foreground tabular-nums font-mono">
                                            {formatDuration(Math.floor(duration))}
                                        </span>
                                    </div>
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

                        {/* ─── Center – Controls ──────────────────────────────── */}
                        <div className="flex items-center gap-3 shrink-0">
                            <span className="text-[10px] text-muted-foreground w-10 text-right tabular-nums font-mono">
                                {formatDuration(Math.floor(currentTime))}
                            </span>

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

                            <span className="text-[10px] text-muted-foreground w-10 tabular-nums font-mono">
                                -{formatDuration(Math.max(0, Math.floor(duration - currentTime)))}
                            </span>
                        </div>

                        {/* ─── Right – Queue + Volume ─────────────────────────── */}
                        <div className="flex items-center gap-3 justify-end">
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
                            <div className="flex items-center gap-2 w-32 group/vol">
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
        </TrackContextMenu>
    );
}

// ─── Decorative Background Waveform ─────────────────────────────────────
const bgPeaksCache = new Map<number, number[]>();

function BarWaveformBg({
    trackId,
    progress,
    isPlaying,
}: {
    trackId: number;
    progress: number;
    isPlaying: boolean;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [peaks, setPeaks] = useState<number[] | null>(null);
    const animRef = useRef<number>(0);

    // Fetch peaks
    useEffect(() => {
        if (!trackId) return;
        if (bgPeaksCache.has(trackId)) {
            setPeaks(bgPeaksCache.get(trackId)!);
            return;
        }
        let cancelled = false;
        fetch(`/api/waveform/${trackId}`)
            .then((r) => r.json())
            .then((data) => {
                if (!cancelled && data.peaks) {
                    bgPeaksCache.set(trackId, data.peaks);
                    setPeaks(data.peaks);
                }
            })
            .catch(() => { });
        return () => { cancelled = true; };
    }, [trackId]);

    // Draw
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !peaks) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);

        ctx.clearRect(0, 0, w, h);

        const barCount = peaks.length;
        const gap = 1.5;
        const barWidth = Math.max(1, (w - gap * (barCount - 1)) / barCount);
        const stride = barWidth + gap;
        const maxBarH = h * 0.7;

        for (let i = 0; i < barCount; i++) {
            const x = i * stride;
            const peakVal = peaks[i];
            const barH = Math.max(1, peakVal * maxBarH);
            const barCenterPct = (x + barWidth / 2) / w;
            const isPlayed = barCenterPct <= progress;

            ctx.beginPath();
            ctx.roundRect(x, h - barH, barWidth, barH, barWidth / 2);

            if (isPlayed) {
                ctx.fillStyle = "rgba(168, 85, 247, 0.12)";
            } else {
                ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
            }
            ctx.fill();
        }
    }, [peaks, progress]);

    // Resize handling
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const observer = new ResizeObserver(() => setPeaks((p) => p ? [...p] : null));
        observer.observe(canvas);
        return () => observer.disconnect();
    }, []);

    if (!peaks) return null;

    return (
        <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
        />
    );
}
