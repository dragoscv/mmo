"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import { useEditor } from "./editor-context";
import { cn } from "@/lib/utils";
import { useDAWSettings, EDITOR_WAVEFORM_COLORS } from "@/hooks/use-daw-settings";

// ═══════════════════════════════════════════════════════════════════════════
// Waveform View — Canvas-based zoomable waveform
// ═══════════════════════════════════════════════════════════════════════════

export function WaveformView() {
    const editor = useEditor();
    const ds = useDAWSettings();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [dimensions, setDimensions] = useState({ width: 800, height: 300 });
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState<number | null>(null);

    // Resize observer
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const obs = new ResizeObserver(entries => {
            for (const entry of entries) {
                setDimensions({
                    width: entry.contentRect.width,
                    height: entry.contentRect.height,
                });
            }
        });
        obs.observe(el);
        return () => obs.disconnect();
    }, []);

    // ─── Draw waveform ──────────────────────────────────────────────
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !editor.buffer) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = dimensions.width * dpr;
        canvas.height = dimensions.height * dpr;
        ctx.scale(dpr, dpr);

        const { width, height } = dimensions;
        const { buffer, scrollX, zoom, selection, playPosition } = editor;
        const channels = buffer.numberOfChannels;
        const channelHeight = height / channels;

        // Clear
        ctx.fillStyle = "oklch(0.14 0.01 260)";
        ctx.fillRect(0, 0, width, height);

        const waveColor = ds.editorWaveformHex;
        // Extract oklch base values for alpha variants
        const waveColorMatch = waveColor.match(/oklch\(([^)]+)\)/);
        const waveBase = waveColorMatch ? waveColorMatch[1] : "0.62 0.19 250";
        const waveColor06 = `oklch(${waveBase} / 0.6)`;
        const waveColor03 = `oklch(${waveBase} / 0.3)`;
        const waveColor015 = `oklch(${waveBase} / 0.15)`;
        const waveColor05 = `oklch(${waveBase} / 0.5)`;

        // Draw grid lines (every 0.5s)
        if (ds.editorShowGridLines) {
            ctx.strokeStyle = "oklch(1 0 0 / 0.04)";
            ctx.lineWidth = 1;
            const startSec = scrollX;
            const endSec = scrollX + width / zoom;
            const gridInterval = zoom > 200 ? 0.1 : zoom > 50 ? 0.5 : 1;
            for (let t = Math.floor(startSec / gridInterval) * gridInterval; t < endSec; t += gridInterval) {
                const x = (t - scrollX) * zoom;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, height);
                ctx.stroke();
            }
        }

        // Draw each channel
        for (let ch = 0; ch < channels; ch++) {
            const data = buffer.getChannelData(ch);
            const yOffset = ch * channelHeight;
            const centerY = yOffset + channelHeight / 2;

            // Waveform
            ctx.fillStyle = waveColor06;

            const startSample = Math.floor(scrollX * buffer.sampleRate);
            const samplesPerPx = buffer.sampleRate / zoom;

            for (let px = 0; px < width; px++) {
                const sampleStart = Math.floor(startSample + px * samplesPerPx);
                const sampleEnd = Math.floor(startSample + (px + 1) * samplesPerPx);

                let min = 0;
                let max = 0;
                for (let s = sampleStart; s < sampleEnd && s < data.length; s++) {
                    if (s < 0) continue;
                    if (data[s] < min) min = data[s];
                    if (data[s] > max) max = data[s];
                }

                const top = centerY - max * (channelHeight * 0.45);
                const bottom = centerY - min * (channelHeight * 0.45);
                ctx.fillRect(px, top, 1, Math.max(1, bottom - top));
            }

            // RMS overlay (softer fill for perceived loudness)
            if (ds.editorShowRms) {
                ctx.fillStyle = waveColor03;
                for (let px = 0; px < width; px++) {
                    const sampleStart2 = Math.floor(startSample + px * samplesPerPx);
                    const sampleEnd2 = Math.floor(startSample + (px + 1) * samplesPerPx);

                    let sumSq = 0;
                    let count = 0;
                    for (let s = sampleStart2; s < sampleEnd2 && s < data.length; s++) {
                        if (s < 0) continue;
                        sumSq += data[s] * data[s];
                        count++;
                    }
                    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
                    const rmsHeight = rms * channelHeight * 0.45;
                    ctx.fillRect(px, centerY - rmsHeight, 1, rmsHeight * 2);
                }
            }

            // Center line
            ctx.strokeStyle = "oklch(1 0 0 / 0.08)";
            ctx.beginPath();
            ctx.moveTo(0, centerY);
            ctx.lineTo(width, centerY);
            ctx.stroke();

            // Channel label
            ctx.fillStyle = "oklch(1 0 0 / 0.2)";
            ctx.font = "10px monospace";
            ctx.fillText(channels > 1 ? (ch === 0 ? "L" : "R") : "M", 4, yOffset + 14);
        }

        // Selection overlay
        if (selection) {
            const selLeft = (selection.start - scrollX) * zoom;
            const selWidth = (selection.end - selection.start) * zoom;
            ctx.fillStyle = waveColor015;
            ctx.fillRect(selLeft, 0, selWidth, height);
            ctx.strokeStyle = waveColor05;
            ctx.lineWidth = 1;
            ctx.strokeRect(selLeft, 0, selWidth, height);
        }

        // Markers
        for (const marker of editor.project.markers) {
            const mx = (marker.position - scrollX) * zoom;
            if (mx < 0 || mx > width) continue;
            ctx.strokeStyle = marker.color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(mx, 0);
            ctx.lineTo(mx, height);
            ctx.stroke();
            // Label
            ctx.fillStyle = marker.color;
            ctx.font = "bold 9px sans-serif";
            ctx.fillText(marker.label, mx + 3, 12);
        }

        // Regions
        for (const region of editor.project.regions) {
            const rl = (region.start - scrollX) * zoom;
            const rw = (region.end - region.start) * zoom;
            ctx.fillStyle = region.color + "15";
            ctx.fillRect(rl, 0, rw, height);
            ctx.strokeStyle = region.color + "40";
            ctx.lineWidth = 1;
            ctx.strokeRect(rl, 0, rw, height);
            ctx.fillStyle = region.color;
            ctx.font = "bold 9px sans-serif";
            ctx.fillText(region.label, rl + 3, height - 6);
        }

        // Playhead
        const phx = (playPosition - scrollX) * zoom;
        if (phx >= 0 && phx <= width) {
            ctx.strokeStyle = "#22c55e";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(phx, 0);
            ctx.lineTo(phx, height);
            ctx.stroke();
            // Triangle head
            ctx.fillStyle = "#22c55e";
            ctx.beginPath();
            ctx.moveTo(phx - 5, 0);
            ctx.lineTo(phx + 5, 0);
            ctx.lineTo(phx, 8);
            ctx.closePath();
            ctx.fill();
        }
    }, [editor.buffer, editor.scrollX, editor.zoom, editor.selection, editor.playPosition, editor.project.markers, editor.project.regions, dimensions, ds.editorWaveformColor, ds.editorShowRms, ds.editorShowGridLines]);

    // ─── Mouse interaction ──────────────────────────────────────────
    const pxToSeconds = useCallback((clientX: number): number => {
        const canvas = canvasRef.current;
        if (!canvas) return 0;
        const rect = canvas.getBoundingClientRect();
        const x = clientX - rect.left;
        return editor.scrollX + x / editor.zoom;
    }, [editor.scrollX, editor.zoom]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.button !== 0) return;
        const sec = pxToSeconds(e.clientX);

        if (editor.tool === "select") {
            setIsDragging(true);
            setDragStart(sec);
            editor.setSelection(null);
        } else if (editor.tool === "zoom") {
            if (e.altKey) {
                editor.setZoom(Math.max(10, editor.zoom * 0.7));
            } else {
                editor.setZoom(Math.min(5000, editor.zoom * 1.5));
                // Center on click
                editor.setScrollX(Math.max(0, sec - (dimensions.width / 2) / (editor.zoom * 1.5)));
            }
        } else if (editor.tool === "hand") {
            setIsDragging(true);
            setDragStart(e.clientX as unknown as number);
        }
    }, [editor, pxToSeconds, dimensions.width]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!isDragging) return;
        const sec = pxToSeconds(e.clientX);

        if (editor.tool === "select" && dragStart !== null) {
            editor.setSelection({
                start: Math.min(dragStart, sec),
                end: Math.max(dragStart, sec),
            });
        } else if (editor.tool === "hand" && dragStart !== null) {
            const dx = e.clientX - dragStart;
            editor.setScrollX(Math.max(0, editor.scrollX - dx / editor.zoom));
            setDragStart(e.clientX);
        }
    }, [isDragging, dragStart, editor, pxToSeconds]);

    const handleMouseUp = useCallback(() => {
        setIsDragging(false);
        setDragStart(null);
    }, []);

    const handleClick = useCallback((e: React.MouseEvent) => {
        if (editor.tool === "select" && !editor.selection) {
            const sec = pxToSeconds(e.clientX);
            editor.seek(sec);
        }
    }, [editor, pxToSeconds]);

    // Wheel to zoom or scroll
    const handleWheel = useCallback((e: React.WheelEvent) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            editor.setZoom(Math.max(10, Math.min(5000, editor.zoom * factor)));
        } else {
            const scrollDelta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
            editor.setScrollX(Math.max(0, editor.scrollX + scrollDelta / editor.zoom));
        }
    }, [editor]);

    return (
        <div ref={containerRef} className="relative w-full h-full overflow-hidden bg-[oklch(0.14_0.01_260)]">
            <canvas
                ref={canvasRef}
                className="w-full h-full"
                style={{ cursor: editor.tool === "hand" ? "grab" : editor.tool === "zoom" ? "zoom-in" : "text" }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onClick={handleClick}
                onWheel={handleWheel}
            />
        </div>
    );
}
