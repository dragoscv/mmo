"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useRenderCount } from "@/lib/dev-debugger";

export type WaveformMode = "classic" | "rgb";

interface RGBPeak {
    r: number;
    g: number;
    b: number;
    amp: number;
}

interface WaveformSeekbarProps {
    trackId: number;
    progress: number; // 0-1
    duration: number;
    isPlaying: boolean;
    onSeek: (time: number) => void;
    className?: string;
    /** Overlay mode: render behind artwork with transparency */
    overlay?: boolean;
    /** Waveform rendering mode */
    mode?: WaveformMode;
}

// Client-side caches
const peaksCache = new Map<number, number[]>();
const rgbPeaksCache = new Map<number, RGBPeak[]>();

export function WaveformSeekbar({
    trackId,
    progress,
    duration,
    isPlaying,
    onSeek,
    className,
    overlay = false,
    mode = "classic",
}: WaveformSeekbarProps) {
    useRenderCount("WaveformSeekbar");
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [peaks, setPeaks] = useState<number[] | null>(null);
    const [rgbPeaks, setRgbPeaks] = useState<RGBPeak[] | null>(null);
    const [hoverX, setHoverX] = useState<number | null>(null);
    const [isHovering, setIsHovering] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const animFrameRef = useRef<number>(0);
    const prevProgressRef = useRef(0);

    // Fetch classic waveform data
    useEffect(() => {
        if (!trackId || mode !== "classic") return;

        // Clear stale data immediately so previous song's waveform doesn't linger
        if (!peaksCache.has(trackId)) {
            setPeaks(null);
        } else {
            setPeaks(peaksCache.get(trackId)!);
            return;
        }

        let cancelled = false;
        fetch(`/api/waveform/${trackId}`)
            .then((r) => r.json())
            .then((data) => {
                if (!cancelled && data.peaks) {
                    peaksCache.set(trackId, data.peaks);
                    setPeaks(data.peaks);
                }
            })
            .catch(() => { /* silently fail */ });

        return () => { cancelled = true; };
    }, [trackId, mode]);

    // Fetch RGB waveform data
    useEffect(() => {
        if (!trackId || mode !== "rgb") return;

        // Clear stale data immediately
        if (!rgbPeaksCache.has(trackId)) {
            setRgbPeaks(null);
        } else {
            setRgbPeaks(rgbPeaksCache.get(trackId)!);
            return;
        }

        let cancelled = false;
        fetch(`/api/waveform-rgb/${trackId}`)
            .then((r) => r.json())
            .then((data) => {
                if (!cancelled && data.peaks) {
                    rgbPeaksCache.set(trackId, data.peaks);
                    setRgbPeaks(data.peaks);
                }
            })
            .catch(() => { /* silently fail */ });

        return () => { cancelled = true; };
    }, [trackId, mode]);

    const getSeekPosition = useCallback(
        (e: React.MouseEvent | MouseEvent) => {
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return 0;
            return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        },
        []
    );

    const handleClick = useCallback(
        (e: React.MouseEvent) => {
            const pct = getSeekPosition(e);
            onSeek(pct * duration);
        },
        [getSeekPosition, onSeek, duration]
    );

    const handleMouseDown = useCallback(
        (e: React.MouseEvent) => {
            setIsDragging(true);
            const pct = getSeekPosition(e);
            onSeek(pct * duration);

            const handleMouseMove = (me: MouseEvent) => {
                const rect = containerRef.current?.getBoundingClientRect();
                if (!rect) return;
                const pct = Math.max(0, Math.min(1, (me.clientX - rect.left) / rect.width));
                setHoverX(pct);
                onSeek(pct * duration);
            };

            const handleMouseUp = () => {
                setIsDragging(false);
                window.removeEventListener("mousemove", handleMouseMove);
                window.removeEventListener("mouseup", handleMouseUp);
            };

            window.addEventListener("mousemove", handleMouseMove);
            window.addEventListener("mouseup", handleMouseUp);
        },
        [getSeekPosition, onSeek, duration]
    );

    // Draw waveform
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const isRgb = mode === "rgb";
        const data = isRgb ? rgbPeaks : peaks;
        if (!data) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);

        const draw = () => {
            ctx.clearRect(0, 0, w, h);

            const barCount = data.length;
            const gap = overlay ? 1.5 : isRgb ? 1 : 2;
            const barWidth = Math.max(1.5, (w - gap * (barCount - 1)) / barCount);
            const stride = barWidth + gap;
            const midY = h / 2;
            const maxBarH = overlay ? midY * 0.85 : midY * 0.9;
            const playedPct = progress;
            const hoverPct = hoverX;
            const cornerRadius = barWidth / 2;

            for (let i = 0; i < barCount; i++) {
                const x = i * stride;
                const barCenterPct = (x + barWidth / 2) / w;
                const isPlayedBar = barCenterPct <= playedPct;
                const isInHover = hoverPct !== null && barCenterPct <= hoverPct;

                if (isRgb) {
                    const peak = data[i] as RGBPeak;
                    const barH = Math.max(2, peak.amp * maxBarH);
                    // Top bar
                    drawRGBBar(ctx, x, midY - barH, barWidth, barH, cornerRadius, peak, isPlayedBar, isInHover, overlay, 1);
                    // Bottom bar (reflection)
                    drawRGBBar(ctx, x, midY, barWidth, barH * 0.4, cornerRadius, peak, isPlayedBar, isInHover, overlay, 0.3);
                } else {
                    const peakVal = data[i] as number;
                    const barH = Math.max(2, peakVal * maxBarH);
                    drawBar(ctx, x, midY - barH, barWidth, barH, cornerRadius, isPlayedBar, isInHover, overlay, 1);
                    drawBar(ctx, x, midY, barWidth, barH * 0.4, cornerRadius, isPlayedBar, isInHover, overlay, 0.3);
                }
            }

            // Playhead line
            if (playedPct > 0 && playedPct < 1) {
                const xPos = playedPct * w;
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(xPos, 0);
                ctx.lineTo(xPos, h);
                ctx.strokeStyle = overlay
                    ? "rgba(168, 85, 247, 0.6)"
                    : "rgba(255, 255, 255, 0.9)";
                ctx.lineWidth = 1.5;
                ctx.shadowColor = isRgb ? "rgba(255, 255, 255, 0.6)" : "rgba(168, 85, 247, 0.5)";
                ctx.shadowBlur = 6;
                ctx.stroke();
                ctx.restore();
            }

            // Hover line
            if (hoverPct !== null && isHovering) {
                const xPos = hoverPct * w;
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(xPos, 0);
                ctx.lineTo(xPos, h);
                ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.restore();
            }
        };

        draw();
        prevProgressRef.current = progress;
    }, [peaks, rgbPeaks, mode, progress, hoverX, isHovering, overlay]);

    // Resize observer
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const observer = new ResizeObserver(() => {
            setPeaks((p) => (p ? [...p] : null));
            setRgbPeaks((p) => (p ? [...p] : null));
        });
        observer.observe(canvas);
        return () => observer.disconnect();
    }, []);

    const hasData = mode === "rgb" ? !!rgbPeaks : !!peaks;

    if (!hasData) {
        // Skeleton loader
        return (
            <div
                className={cn(
                    "relative w-full",
                    overlay ? "h-full" : "h-20",
                    className
                )}
            >
                <div className="absolute inset-0 flex items-center justify-center gap-[2px] opacity-20">
                    {Array.from({ length: 60 }).map((_, i) => (
                        <div
                            key={i}
                            className="bg-white/30 rounded-full animate-pulse"
                            style={{
                                width: "2px",
                                height: `${20 + Math.sin(i * 0.3) * 15}%`,
                                animationDelay: `${i * 30}ms`,
                            }}
                        />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            className={cn(
                "relative w-full select-none",
                overlay ? "h-full" : "h-20",
                "cursor-pointer group/waveform",
                className
            )}
            onClick={handleClick}
            onMouseDown={handleMouseDown}
            onMouseMove={(e) => {
                setHoverX(getSeekPosition(e));
                setIsHovering(true);
            }}
            onMouseLeave={() => {
                if (!isDragging) {
                    setIsHovering(false);
                    setHoverX(null);
                }
            }}
        >
            <canvas
                ref={canvasRef}
                className="w-full h-full"
            />
            {/* Hover time tooltip */}
            {isHovering && hoverX !== null && duration > 0 && (
                <div
                    className="absolute top-0 -translate-y-full -translate-x-1/2 px-2 py-0.5 rounded bg-black/80 text-[10px] text-white/80 tabular-nums whitespace-nowrap pointer-events-none transition-opacity"
                    style={{ left: `${hoverX * 100}%` }}
                >
                    {formatTime(Math.floor(hoverX * duration))}
                </div>
            )}
        </div>
    );
}

function drawBar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    isPlayed: boolean,
    isInHover: boolean,
    overlay: boolean,
    alphaMultiplier: number,
) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);

    if (isPlayed) {
        // Played: vibrant purple gradient
        const grad = ctx.createLinearGradient(x, y, x, y + h);
        const baseAlpha = overlay ? 0.7 : 0.9;
        grad.addColorStop(0, `rgba(168, 85, 247, ${baseAlpha * alphaMultiplier})`);
        grad.addColorStop(1, `rgba(217, 70, 239, ${(baseAlpha - 0.1) * alphaMultiplier})`);
        ctx.fillStyle = grad;
    } else if (isInHover) {
        // Hover preview: lighter
        const alpha = overlay ? 0.35 : 0.45;
        ctx.fillStyle = `rgba(200, 180, 255, ${alpha * alphaMultiplier})`;
    } else {
        // Unplayed: subtle
        const alpha = overlay ? 0.15 : 0.25;
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha * alphaMultiplier})`;
    }

    ctx.fill();

    // Subtle glow on played bars
    if (isPlayed && alphaMultiplier > 0.5) {
        ctx.shadowColor = "rgba(168, 85, 247, 0.3)";
        ctx.shadowBlur = 4;
        ctx.fill();
    }

    ctx.restore();
}

function drawRGBBar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    peak: RGBPeak,
    isPlayed: boolean,
    isInHover: boolean,
    overlay: boolean,
    alphaMultiplier: number,
) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);

    // Map frequency bands to rekordbox-style colors:
    // Bass → red/magenta, Mid → green/yellow, Treble → blue/cyan
    const r = Math.floor(Math.min(1, peak.r * 1.2) * 255);
    const g = Math.floor(Math.min(1, peak.g * 1.1) * 255);
    const b = Math.floor(Math.min(1, peak.b * 1.3 + peak.r * 0.2) * 255);

    if (isPlayed) {
        // Full saturation with glow
        const baseAlpha = overlay ? 0.8 : 0.95;
        const alpha = baseAlpha * alphaMultiplier;
        const grad = ctx.createLinearGradient(x, y, x, y + h);
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`);
        grad.addColorStop(1, `rgba(${Math.floor(r * 0.7)}, ${Math.floor(g * 0.7)}, ${Math.floor(b * 0.7)}, ${alpha * 0.8})`);
        ctx.fillStyle = grad;
    } else if (isInHover) {
        const alpha = (overlay ? 0.5 : 0.6) * alphaMultiplier;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    } else {
        // Dimmed but still colored
        const alpha = (overlay ? 0.2 : 0.35) * alphaMultiplier;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    ctx.fill();

    // Glow on played bars
    if (isPlayed && alphaMultiplier > 0.5) {
        ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.4)`;
        ctx.shadowBlur = 5;
        ctx.fill();
    }

    ctx.restore();
}

function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
}
