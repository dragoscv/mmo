"use client";

import { useRef, useEffect, useCallback } from "react";
import { usePlayer } from "./player-context";
import { useAudioAnalyzer } from "@/lib/audio-analyzer";
import type { VisualizationDef, RenderConfig, AudioData } from "@/lib/visualizations/types";
import { ShaderCanvas } from "./shader-canvas";

interface VisualizationCanvasProps {
    visualization: VisualizationDef;
    sensitivity?: number;
    quality?: "low" | "medium" | "high";
    className?: string;
    onFpsUpdate?: (fps: number) => void;
    showStats?: boolean;
}

export function VisualizationCanvas({
    visualization,
    sensitivity = 1,
    quality = "medium",
    className = "",
    onFpsUpdate,
    showStats = false,
}: VisualizationCanvasProps) {
    // Delegate to WebGL shader canvas if this is a shader visualization
    if (visualization.shader) {
        return (
            <ShaderCanvas
                visualization={visualization}
                sensitivity={sensitivity}
                quality={quality}
                className={`w-full h-full ${className}`}
                onFpsUpdate={onFpsUpdate}
            />
        );
    }

    return (
        <Canvas2DRenderer
            visualization={visualization}
            sensitivity={sensitivity}
            quality={quality}
            className={className}
            onFpsUpdate={onFpsUpdate}
            showStats={showStats}
        />
    );
}

function Canvas2DRenderer({
    visualization,
    sensitivity = 1,
    quality = "medium",
    className = "",
    onFpsUpdate,
    showStats = false,
}: VisualizationCanvasProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number>(0);
    const startTimeRef = useRef(0);
    const lastFrameRef = useRef(0);
    const fpsFramesRef = useRef(0);
    const fpsTimeRef = useRef(0);
    const fpsRef = useRef(0);
    const mouseRef = useRef({ x: 0.5, y: 0.5, active: false });

    // Use refs for values that change frequently but shouldn't restart the render loop
    const player = usePlayer();
    const { getAudioData } = useAudioAnalyzer();
    const playerRef = useRef(player);
    playerRef.current = player;
    const getAudioDataRef = useRef(getAudioData);
    getAudioDataRef.current = getAudioData;
    const onFpsUpdateRef = useRef(onFpsUpdate);
    onFpsUpdateRef.current = onFpsUpdate;
    const showStatsRef = useRef(showStats);
    showStatsRef.current = showStats;
    const sensitivityRef = useRef(sensitivity);
    sensitivityRef.current = sensitivity;

    // Mouse tracking
    const handleMouseMove = useCallback((e: MouseEvent) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        mouseRef.current = {
            x: (e.clientX - rect.left) / rect.width,
            y: (e.clientY - rect.top) / rect.height,
            active: true,
        };
    }, []);

    const handleMouseLeave = useCallback(() => {
        mouseRef.current.active = false;
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        canvas.addEventListener("mousemove", handleMouseMove);
        canvas.addEventListener("mouseleave", handleMouseLeave);

        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return;

        startTimeRef.current = performance.now();
        lastFrameRef.current = performance.now();
        fpsTimeRef.current = performance.now();
        fpsFramesRef.current = 0;

        const render = () => {
            const now = performance.now();
            const time = (now - startTimeRef.current) / 1000;
            const deltaTime = (now - lastFrameRef.current) / 1000;
            lastFrameRef.current = now;

            // FPS calculation
            fpsFramesRef.current++;
            if (now - fpsTimeRef.current >= 1000) {
                fpsRef.current = fpsFramesRef.current;
                fpsFramesRef.current = 0;
                fpsTimeRef.current = now;
                onFpsUpdateRef.current?.(fpsRef.current);
            }

            // Resize canvas to match display size
            const dpr = quality === "low" ? 1 : quality === "high" ? (window.devicePixelRatio || 1) : Math.min(window.devicePixelRatio || 1, 1.5);
            const rect = canvas.getBoundingClientRect();
            const w = Math.floor(rect.width * dpr);
            const h = Math.floor(rect.height * dpr);
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
                ctx.scale(dpr, dpr);
            }

            const displayW = rect.width;
            const displayH = rect.height;

            // Get audio data via refs (no dep on player state)
            const analyser = playerRef.current.getAnalyserNode();
            const audioData = getAudioDataRef.current(analyser);

            const config: RenderConfig = {
                width: displayW,
                height: displayH,
                time,
                deltaTime: Math.min(deltaTime, 0.1),
                mouse: mouseRef.current,
                palette: [],
                sensitivity: sensitivityRef.current,
                quality,
            };

            // Clear and render
            ctx.save();
            try {
                visualization.render(ctx, audioData, config);
            } catch {
                // Don't crash on render errors
            }
            ctx.restore();

            // Stats overlay
            if (showStatsRef.current) {
                drawStats(ctx, displayW, displayH, fpsRef.current, audioData);
            }

            rafRef.current = requestAnimationFrame(render);
        };

        rafRef.current = requestAnimationFrame(render);

        return () => {
            cancelAnimationFrame(rafRef.current);
            canvas.removeEventListener("mousemove", handleMouseMove);
            canvas.removeEventListener("mouseleave", handleMouseLeave);
        };
    }, [visualization, quality, handleMouseMove, handleMouseLeave]);

    return (
        <canvas
            ref={canvasRef}
            className={`w-full h-full ${className}`}
            style={{ display: "block", background: "#000" }}
        />
    );
}

function drawStats(
    ctx: CanvasRenderingContext2D,
    w: number, h: number,
    fps: number,
    data: AudioData,
) {
    const padding = 10;
    const lineH = 16;
    const boxW = 180;
    const lines = 7;
    const boxH = lineH * lines + padding * 2;

    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(w - boxW - padding, padding, boxW, boxH);

    ctx.font = "11px monospace";
    ctx.textAlign = "right";
    let y = padding + lineH;

    const stats = [
        [`FPS`, `${fps}`],
        [`Bass`, `${(data.bass * 100).toFixed(0)}%`],
        [`Mid`, `${(data.mid * 100).toFixed(0)}%`],
        [`Treble`, `${(data.treble * 100).toFixed(0)}%`],
        [`Volume`, `${(data.volume * 100).toFixed(0)}%`],
        [`Beat`, data.beat ? "●" : "○"],
        [`Bins`, `${data.frequency.length}`],
    ];

    for (const [label, value] of stats) {
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.textAlign = "left";
        ctx.fillText(label, w - boxW, y);
        ctx.fillStyle = fps < 30 && label === "FPS"
            ? "#ff4444"
            : data.beat && label === "Beat"
                ? "#ff00ff"
                : "#ffffff";
        ctx.textAlign = "right";
        ctx.fillText(value, w - padding - 4, y);
        y += lineH;
    }
}
