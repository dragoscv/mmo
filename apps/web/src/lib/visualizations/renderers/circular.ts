import type { VisualizationDef, AudioData, RenderConfig } from "../types";
import { PALETTES, VARIANT_PALETTES } from "../palettes";
import {
    sampleData, getColorInterp, applyGlow, clearGlow, clearCanvas, hexToRgba,
    capitalize,
} from "../viz-utils";

type CircularLayout = "ring" | "sunburst" | "radar" | "vinyl" | "orbital";

function renderCircular(
    ctx: CanvasRenderingContext2D,
    data: AudioData,
    config: RenderConfig,
    layout: CircularLayout,
    palette: string[],
) {
    const { width: w, height: h, time, sensitivity } = config;
    clearCanvas(ctx, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(w, h) * 0.4;
    const barCount = config.quality === "high" ? 180 : config.quality === "medium" ? 120 : 64;
    const samples = sampleData(data.frequency, barCount);

    switch (layout) {
        case "ring": {
            const innerR = maxR * 0.4;
            for (let i = 0; i < barCount; i++) {
                const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;
                const v = samples[i] * sensitivity;
                const r = innerR + v * (maxR - innerR);
                const color = getColorInterp(palette, i / barCount);
                ctx.strokeStyle = color;
                ctx.lineWidth = Math.max(2, (Math.PI * 2 * innerR) / barCount - 1);
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR);
                ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
                ctx.stroke();
            }
            break;
        }
        case "sunburst": {
            const innerR = maxR * 0.15;
            for (let i = 0; i < barCount; i++) {
                const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;
                const v = samples[i] * sensitivity;
                const r = innerR + v * maxR * 0.9;
                const color = getColorInterp(palette, i / barCount);
                applyGlow(ctx, color, 10);
                ctx.strokeStyle = color;
                ctx.lineWidth = Math.max(1, (Math.PI * 2 * innerR) / barCount);
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR);
                ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
                ctx.stroke();
            }
            clearGlow(ctx);
            // Center circle
            ctx.beginPath();
            ctx.arc(cx, cy, innerR * 0.8, 0, Math.PI * 2);
            ctx.fillStyle = hexToRgba(palette[0], 0.3);
            ctx.fill();
            break;
        }
        case "radar": {
            // Grid circles
            ctx.strokeStyle = "rgba(255,255,255,0.05)";
            ctx.lineWidth = 1;
            for (let r = 0.25; r <= 1; r += 0.25) {
                ctx.beginPath();
                ctx.arc(cx, cy, maxR * r, 0, Math.PI * 2);
                ctx.stroke();
            }
            // Sweep line
            const sweepAngle = (time * 0.5) % (Math.PI * 2);
            ctx.strokeStyle = hexToRgba(palette[0], 0.6);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(sweepAngle) * maxR, cy + Math.sin(sweepAngle) * maxR);
            ctx.stroke();
            // Data points
            ctx.beginPath();
            for (let i = 0; i < barCount; i++) {
                const angle = (i / barCount) * Math.PI * 2;
                const v = samples[i] * sensitivity;
                const r = v * maxR;
                const x = cx + Math.cos(angle) * r;
                const y = cy + Math.sin(angle) * r;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.fillStyle = hexToRgba(palette[1], 0.15);
            ctx.fill();
            ctx.strokeStyle = getColorInterp(palette, 0.5);
            ctx.lineWidth = 2;
            ctx.stroke();
            // Dots
            for (let i = 0; i < barCount; i += 3) {
                const angle = (i / barCount) * Math.PI * 2;
                const v = samples[i] * sensitivity;
                const r = v * maxR;
                ctx.beginPath();
                ctx.arc(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, 2, 0, Math.PI * 2);
                ctx.fillStyle = getColorInterp(palette, i / barCount);
                ctx.fill();
            }
            break;
        }
        case "vinyl": {
            const rotation = time * 0.3;
            // Grooves
            for (let r = maxR * 0.2; r < maxR; r += 8) {
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(255,255,255,${0.02 + data.volume * 0.05})`;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
            // Audio-reactive waveform in a circle
            const waveR = maxR * 0.7;
            ctx.beginPath();
            const wSamples = sampleData(data.timeDomain, barCount);
            for (let i = 0; i < barCount; i++) {
                const angle = (i / barCount) * Math.PI * 2 + rotation;
                const v = (wSamples[i] - 0.5) * 2 * sensitivity;
                const r = waveR + v * maxR * 0.25;
                const x = cx + Math.cos(angle) * r;
                const y = cy + Math.sin(angle) * r;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.strokeStyle = getColorInterp(palette, data.bass);
            ctx.lineWidth = 2;
            applyGlow(ctx, palette[0], 8);
            ctx.stroke();
            clearGlow(ctx);
            // Center dot
            ctx.beginPath();
            ctx.arc(cx, cy, 8 + data.bass * 4 * sensitivity, 0, Math.PI * 2);
            ctx.fillStyle = palette[0];
            ctx.fill();
            break;
        }
        case "orbital": {
            const rings = 5;
            for (let r = 0; r < rings; r++) {
                const radius = maxR * 0.2 + (r / rings) * maxR * 0.7;
                const count = 12 + r * 8;
                const rSamples = sampleData(data.frequency, count);
                const rotSpeed = (r % 2 === 0 ? 1 : -1) * (0.2 + r * 0.1);
                const rot = time * rotSpeed;
                for (let i = 0; i < count; i++) {
                    const angle = (i / count) * Math.PI * 2 + rot;
                    const v = rSamples[i] * sensitivity;
                    const dotR = 2 + v * 8;
                    const x = cx + Math.cos(angle) * radius;
                    const y = cy + Math.sin(angle) * radius;
                    const color = getColorInterp(palette, r / rings);
                    ctx.beginPath();
                    ctx.arc(x, y, dotR, 0, Math.PI * 2);
                    ctx.fillStyle = hexToRgba(color, 0.5 + v * 0.5);
                    ctx.fill();
                }
            }
            break;
        }
    }
}

const LAYOUTS: CircularLayout[] = ["ring", "sunburst", "radar", "vinyl", "orbital"];
const NAMES: Record<CircularLayout, string> = {
    ring: "Ring Spectrum", sunburst: "Sunburst", radar: "Radar",
    vinyl: "Vinyl", orbital: "Orbital",
};

export function createCircularVisualizations(): VisualizationDef[] {
    return LAYOUTS.flatMap((layout) =>
        VARIANT_PALETTES.map((palName) => ({
            id: `circular-${layout}-${palName}`,
            name: `${NAMES[layout]} · ${capitalize(palName)}`,
            category: "Circular",
            tags: ["circular", "radial", layout, palName],
            render: (ctx: CanvasRenderingContext2D, data: AudioData, config: RenderConfig) =>
                renderCircular(ctx, data, config, layout, PALETTES[palName]),
        }))
    );
}
