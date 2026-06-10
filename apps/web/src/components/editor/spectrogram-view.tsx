"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import { useEditor } from "./editor-context";
import { useDAWSettings, type SpectrogramColorMap } from "@/hooks/use-daw-settings";
import { useRenderCount } from "@/lib/dev-debugger";

// ═══════════════════════════════════════════════════════════════════════════
// Spectrogram View — FFT-based frequency visualization
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_FFT_SIZE = 2048;

const COLOR_MAPS: Record<SpectrogramColorMap, number[][]> = {
    magma: [
        [0, 0, 0], [15, 5, 50], [40, 10, 100], [80, 20, 160],
        [20, 80, 200], [20, 180, 200], [80, 220, 100],
        [220, 220, 50], [255, 140, 20], [255, 40, 40], [255, 255, 255],
    ],
    viridis: [
        [68, 1, 84], [72, 35, 116], [64, 67, 135], [52, 94, 141],
        [33, 145, 140], [53, 183, 121], [109, 205, 89],
        [180, 222, 44], [253, 231, 37], [253, 231, 37], [255, 255, 255],
    ],
    inferno: [
        [0, 0, 4], [22, 11, 57], [66, 10, 104], [120, 28, 109],
        [165, 44, 96], [207, 68, 70], [237, 105, 37],
        [251, 155, 6], [252, 206, 37], [252, 255, 164], [255, 255, 255],
    ],
    plasma: [
        [13, 8, 135], [75, 3, 161], [126, 3, 168], [168, 34, 150],
        [203, 70, 121], [229, 107, 93], [248, 148, 65],
        [253, 195, 40], [240, 249, 33], [240, 249, 33], [255, 255, 255],
    ],
    grayscale: [
        [0, 0, 0], [25, 25, 25], [51, 51, 51], [76, 76, 76],
        [102, 102, 102], [127, 127, 127], [153, 153, 153],
        [178, 178, 178], [204, 204, 204], [229, 229, 229], [255, 255, 255],
    ],
};

function buildColorLUT(colorMap: SpectrogramColorMap): Uint8Array {
    const stops = COLOR_MAPS[colorMap];
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
        const amplitude = i / 255;
        const idx = amplitude * (stops.length - 1);
        const lo = Math.floor(idx);
        const hi = Math.min(lo + 1, stops.length - 1);
        const t = idx - lo;
        lut[i * 3] = stops[lo][0] + (stops[hi][0] - stops[lo][0]) * t;
        lut[i * 3 + 1] = stops[lo][1] + (stops[hi][1] - stops[lo][1]) * t;
        lut[i * 3 + 2] = stops[lo][2] + (stops[hi][2] - stops[lo][2]) * t;
    }
    return lut;
}

// Pre-computed LUT cache
const lutCache = new Map<SpectrogramColorMap, Uint8Array>();
function getColorLUT(colorMap: SpectrogramColorMap): Uint8Array {
    if (!lutCache.has(colorMap)) {
        lutCache.set(colorMap, buildColorLUT(colorMap));
    }
    return lutCache.get(colorMap)!;
}

export function SpectrogramView() {
    useRenderCount("SpectrogramView");
    const editor = useEditor();
    const ds = useDAWSettings();
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
        const fftSize = ds.spectrogramFftSize;
        const halfFFT = fftSize / 2;
        const colorLUT = getColorLUT(ds.spectrogramColorMap);

        // Clear
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, w, h);

        // Compute FFT for each pixel column
        const imageData = ctx.createImageData(w, h);
        const pixels = imageData.data;

        // Hann window
        const hannWindow = new Float32Array(fftSize);
        for (let i = 0; i < fftSize; i++) {
            hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
        }

        for (let px = 0; px < w; px++) {
            const timeSec = scrollX + px / zoom;
            const centerSample = Math.floor(timeSec * sampleRate);

            // Extract windowed segment
            const segment = new Float32Array(fftSize);
            for (let i = 0; i < fftSize; i++) {
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
                for (let n = 0; n < fftSize; n++) {
                    const angle = (-2 * Math.PI * k * n) / fftSize;
                    real += segment[n] * Math.cos(angle);
                    imag += segment[n] * Math.sin(angle);
                }
                magnitudes[k] = Math.sqrt(real * real + imag * imag) / fftSize;
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
                pixels[pixelIdx] = colorLUT[colorIdx * 3];
                pixels[pixelIdx + 1] = colorLUT[colorIdx * 3 + 1];
                pixels[pixelIdx + 2] = colorLUT[colorIdx * 3 + 2];
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
    }, [editor.buffer, editor.scrollX, editor.zoom, editor.selection, editor.playPosition, dimensions, ds.spectrogramColorMap, ds.spectrogramFftSize]);

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
