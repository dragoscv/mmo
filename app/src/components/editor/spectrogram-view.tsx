"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import { useEditor } from "./editor-context";

// ═══════════════════════════════════════════════════════════════════════════
// Spectrogram View — FFT-based frequency visualization
// ═══════════════════════════════════════════════════════════════════════════

const FFT_SIZE = 2048;
const COLOR_STOPS = [
    [0, 0, 0],       // silence = black
    [15, 5, 50],     // very quiet = deep purple
    [40, 10, 100],   // quiet = purple
    [80, 20, 160],   // soft = violet
    [20, 80, 200],   // medium-quiet = blue
    [20, 180, 200],  // medium = cyan
    [80, 220, 100],  // medium-loud = green
    [220, 220, 50],  // loud = yellow
    [255, 140, 20],  // very loud = orange
    [255, 40, 40],   // peak = red
    [255, 255, 255], // clip = white
];

function amplitudeToColor(amplitude: number): [number, number, number] {
    // Map 0..1 to color stops
    const idx = amplitude * (COLOR_STOPS.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, COLOR_STOPS.length - 1);
    const t = idx - lo;
    return [
        COLOR_STOPS[lo][0] + (COLOR_STOPS[hi][0] - COLOR_STOPS[lo][0]) * t,
        COLOR_STOPS[lo][1] + (COLOR_STOPS[hi][1] - COLOR_STOPS[lo][1]) * t,
        COLOR_STOPS[lo][2] + (COLOR_STOPS[hi][2] - COLOR_STOPS[lo][2]) * t,
    ];
}

// Pre-compute color lookup table
const COLOR_LUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
    const [r, g, b] = amplitudeToColor(i / 255);
    COLOR_LUT[i * 3] = r;
    COLOR_LUT[i * 3 + 1] = g;
    COLOR_LUT[i * 3 + 2] = b;
}

export function SpectrogramView() {
    const editor = useEditor();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [dimensions, setDimensions] = useState({ width: 800, height: 300 });

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

    // Render spectrogram
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !editor.buffer) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const w = dimensions.width;
        const h = dimensions.height;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);

        const { buffer, scrollX, zoom, selection, playPosition } = editor;
        const sampleRate = buffer.sampleRate;
        const data = buffer.getChannelData(0); // mono for spectrogram
        const halfFFT = FFT_SIZE / 2;

        // Clear
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, w, h);

        // Compute FFT for each pixel column
        const imageData = ctx.createImageData(w, h);
        const pixels = imageData.data;

        // Hann window
        const hannWindow = new Float32Array(FFT_SIZE);
        for (let i = 0; i < FFT_SIZE; i++) {
            hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
        }

        for (let px = 0; px < w; px++) {
            const timeSec = scrollX + px / zoom;
            const centerSample = Math.floor(timeSec * sampleRate);

            // Extract windowed segment
            const segment = new Float32Array(FFT_SIZE);
            for (let i = 0; i < FFT_SIZE; i++) {
                const sampleIdx = centerSample - halfFFT + i;
                segment[i] = (sampleIdx >= 0 && sampleIdx < data.length ? data[sampleIdx] : 0) * hannWindow[i];
            }

            // Simple DFT (real FFT approximation using only magnitude)
            // For performance, we only compute halfFFT bins
            const magnitudes = new Float32Array(halfFFT);
            let maxMag = 0;

            for (let k = 0; k < halfFFT; k++) {
                let real = 0;
                let imag = 0;
                for (let n = 0; n < FFT_SIZE; n++) {
                    const angle = (-2 * Math.PI * k * n) / FFT_SIZE;
                    real += segment[n] * Math.cos(angle);
                    imag += segment[n] * Math.sin(angle);
                }
                magnitudes[k] = Math.sqrt(real * real + imag * imag) / FFT_SIZE;
                if (magnitudes[k] > maxMag) maxMag = magnitudes[k];
            }

            // Draw column (frequency bins → pixels, low freq at bottom)
            for (let y = 0; y < h; y++) {
                const freqBin = Math.floor(((h - 1 - y) / h) * halfFFT);
                const mag = magnitudes[freqBin];
                // Log scale for better visualization
                const dbNorm = maxMag > 0
                    ? Math.max(0, Math.min(1, (20 * Math.log10(mag / maxMag) + 80) / 80))
                    : 0;
                const colorIdx = Math.floor(dbNorm * 255);
                const pixelIdx = (y * w + px) * 4;
                pixels[pixelIdx] = COLOR_LUT[colorIdx * 3];
                pixels[pixelIdx + 1] = COLOR_LUT[colorIdx * 3 + 1];
                pixels[pixelIdx + 2] = COLOR_LUT[colorIdx * 3 + 2];
                pixels[pixelIdx + 3] = 255;
            }
        }

        ctx.putImageData(imageData, 0, 0);

        // Selection overlay
        if (selection) {
            const selLeft = (selection.start - scrollX) * zoom;
            const selWidth = (selection.end - selection.start) * zoom;
            ctx.fillStyle = "oklch(0.62 0.19 250 / 0.15)";
            ctx.fillRect(selLeft, 0, selWidth, h);
            ctx.strokeStyle = "oklch(0.62 0.19 250 / 0.5)";
            ctx.lineWidth = 1;
            ctx.strokeRect(selLeft, 0, selWidth, h);
        }

        // Playhead
        const phx = (playPosition - scrollX) * zoom;
        if (phx >= 0 && phx <= w) {
            ctx.strokeStyle = "#22c55e";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(phx, 0);
            ctx.lineTo(phx, h);
            ctx.stroke();
        }

        // Frequency labels
        ctx.fillStyle = "oklch(1 0 0 / 0.3)";
        ctx.font = "9px monospace";
        const freqLabels = [100, 500, 1000, 2000, 5000, 10000, 20000];
        const nyquist = sampleRate / 2;
        for (const freq of freqLabels) {
            if (freq > nyquist) continue;
            const y = h - (freq / nyquist) * h;
            ctx.fillText(`${freq >= 1000 ? `${freq / 1000}k` : freq}Hz`, 4, y - 2);
            ctx.strokeStyle = "oklch(1 0 0 / 0.06)";
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
    }, [editor.buffer, editor.scrollX, editor.zoom, editor.selection, editor.playPosition, dimensions]);

    // Mouse handlers (same as waveform for selection)
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState<number | null>(null);

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
        }
    }, [editor, pxToSeconds]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!isDragging || dragStart === null) return;
        const sec = pxToSeconds(e.clientX);
        editor.setSelection({
            start: Math.min(dragStart, sec),
            end: Math.max(dragStart, sec),
        });
    }, [isDragging, dragStart, editor, pxToSeconds]);

    const handleMouseUp = useCallback(() => {
        setIsDragging(false);
        setDragStart(null);
    }, []);

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
        <div ref={containerRef} className="relative w-full h-full overflow-hidden bg-black">
            <canvas
                ref={canvasRef}
                className="w-full h-full"
                style={{ cursor: editor.tool === "select" ? "text" : "default" }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onWheel={handleWheel}
            />
        </div>
    );
}
