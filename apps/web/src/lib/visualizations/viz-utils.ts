import type { AudioData, RenderConfig } from "./types";

// Convert hex color to rgba string
export function hexToRgba(hex: string, alpha = 1): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

// Create a gradient from palette colors
export function createLinearGradient(
    ctx: CanvasRenderingContext2D,
    x0: number, y0: number,
    x1: number, y1: number,
    colors: string[],
): CanvasGradient {
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    colors.forEach((c, i) => grad.addColorStop(i / (colors.length - 1), c));
    return grad;
}

export function createRadialGradient(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number,
    r0: number, r1: number,
    colors: string[],
): CanvasGradient {
    const grad = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
    colors.forEach((c, i) => grad.addColorStop(i / (colors.length - 1), c));
    return grad;
}

// Smooth a data array for cleaner visualizations
export function smoothArray(data: Uint8Array, windowSize = 3): number[] {
    const result: number[] = [];
    for (let i = 0; i < data.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - windowSize); j <= Math.min(data.length - 1, i + windowSize); j++) {
            sum += data[j];
            count++;
        }
        result.push(sum / count);
    }
    return result;
}

// Get N evenly sampled values from audio data
export function sampleData(data: Uint8Array, samples: number): number[] {
    const result: number[] = [];
    const step = data.length / samples;
    for (let i = 0; i < samples; i++) {
        result.push(data[Math.floor(i * step)] / 255);
    }
    return result;
}

// Normalize 0-255 Uint8Array value to 0-1
export function norm(value: number): number {
    return value / 255;
}

// Map a value from one range to another
export function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
    return ((value - inMin) / (inMax - inMin)) * (outMax - outMin) + outMin;
}

// Lerp between two values
export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

// Get color from palette based on index/fraction
export function getColor(palette: string[], fraction: number): string {
    const idx = Math.floor(fraction * (palette.length - 1));
    return palette[Math.min(idx, palette.length - 1)];
}

// Interpolate between two palette colors
export function getColorInterp(palette: string[], fraction: number): string {
    const f = Math.max(0, Math.min(1, fraction)) * (palette.length - 1);
    const i = Math.floor(f);
    const t = f - i;
    if (i >= palette.length - 1) return palette[palette.length - 1];
    const c1 = hexToRgb(palette[i]);
    const c2 = hexToRgb(palette[i + 1]);
    const r = Math.round(lerp(c1.r, c2.r, t));
    const g = Math.round(lerp(c1.g, c2.g, t));
    const b = Math.round(lerp(c1.b, c2.b, t));
    return `rgb(${r},${g},${b})`;
}

function hexToRgb(hex: string) {
    return {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16),
    };
}

// Apply glow effect
export function applyGlow(ctx: CanvasRenderingContext2D, color: string, blur: number) {
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
}

export function clearGlow(ctx: CanvasRenderingContext2D) {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
}

// Draw a rounded rect
export function roundRect(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    w: number, h: number,
    r: number,
) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
}

// Get average energy from a range of frequency bins
export function bandEnergy(data: Uint8Array, start: number, end: number): number {
    let sum = 0;
    const s = Math.floor(start);
    const e = Math.min(Math.floor(end), data.length);
    for (let i = s; i < e; i++) sum += data[i];
    return sum / ((e - s) * 255);
}

// Simple easing
export function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

export function easeInOutSine(t: number): number {
    return -(Math.cos(Math.PI * t) - 1) / 2;
}

// Clear canvas with optional fade effect
export function clearCanvas(ctx: CanvasRenderingContext2D, w: number, h: number, fade = 0) {
    if (fade > 0) {
        ctx.fillStyle = `rgba(0,0,0,${fade})`;
        ctx.fillRect(0, 0, w, h);
    } else {
        ctx.clearRect(0, 0, w, h);
    }
}

// Capitalize string
export function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
