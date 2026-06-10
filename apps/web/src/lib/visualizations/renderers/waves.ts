import type { VisualizationDef, AudioData, RenderConfig, PaletteName } from "../types";
import { PALETTES, VARIANT_PALETTES } from "../palettes";
import {
    sampleData, getColorInterp, applyGlow, clearGlow, clearCanvas, hexToRgba,
    createLinearGradient, capitalize,
} from "../viz-utils";

type WaveLayout = "line" | "filled" | "mirror" | "multi" | "neon";

function renderWaves(
    ctx: CanvasRenderingContext2D,
    data: AudioData,
    config: RenderConfig,
    layout: WaveLayout,
    palette: string[],
) {
    const { width: w, height: h, time, sensitivity } = config;
    clearCanvas(ctx, w, h);

    const samples = sampleData(data.timeDomain, 256);
    const mid = h / 2;

    switch (layout) {
        case "line": {
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            for (let i = 0; i < samples.length; i++) {
                const x = (i / samples.length) * w;
                const v = (samples[i] - 0.5) * 2 * sensitivity;
                const y = mid + v * mid * 0.8;
                ctx.strokeStyle = getColorInterp(palette, i / samples.length);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            const grad = createLinearGradient(ctx, 0, 0, w, 0, palette);
            ctx.strokeStyle = grad;
            ctx.stroke();
            break;
        }
        case "filled": {
            ctx.beginPath();
            ctx.moveTo(0, h);
            for (let i = 0; i < samples.length; i++) {
                const x = (i / samples.length) * w;
                const v = (samples[i] - 0.5) * 2 * sensitivity;
                const y = mid + v * mid * 0.7;
                ctx.lineTo(x, y);
            }
            ctx.lineTo(w, h);
            ctx.closePath();
            const grad = createLinearGradient(ctx, 0, 0, w, 0, palette.map(c => hexToRgba(c, 0.6)));
            ctx.fillStyle = grad;
            ctx.fill();
            // Top stroke
            ctx.beginPath();
            for (let i = 0; i < samples.length; i++) {
                const x = (i / samples.length) * w;
                const v = (samples[i] - 0.5) * 2 * sensitivity;
                const y = mid + v * mid * 0.7;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = createLinearGradient(ctx, 0, 0, w, 0, palette);
            ctx.lineWidth = 2;
            ctx.stroke();
            break;
        }
        case "mirror": {
            for (const dir of [1, -1]) {
                ctx.beginPath();
                ctx.moveTo(0, mid);
                for (let i = 0; i < samples.length; i++) {
                    const x = (i / samples.length) * w;
                    const v = Math.abs((samples[i] - 0.5) * 2) * sensitivity;
                    const y = mid + dir * v * mid * 0.7;
                    ctx.lineTo(x, y);
                }
                ctx.lineTo(w, mid);
                ctx.closePath();
                const alpha = dir === 1 ? 0.7 : 0.4;
                ctx.fillStyle = createLinearGradient(ctx, 0, 0, w, 0, palette.map(c => hexToRgba(c, alpha)));
                ctx.fill();
            }
            break;
        }
        case "multi": {
            const layers = 4;
            for (let l = 0; l < layers; l++) {
                const offset = l * 0.2;
                const alpha = 1 - l * 0.2;
                ctx.beginPath();
                for (let i = 0; i < samples.length; i++) {
                    const x = (i / samples.length) * w;
                    const base = (samples[i] - 0.5) * 2 * sensitivity;
                    const wave = Math.sin(time * 2 + i * 0.1 + l * 1.5) * 0.1;
                    const y = mid + (base + wave + offset * 0.3) * mid * 0.5;
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.strokeStyle = hexToRgba(palette[l % palette.length], alpha);
                ctx.lineWidth = 2;
                ctx.stroke();
            }
            break;
        }
        case "neon": {
            ctx.lineWidth = 3;
            ctx.beginPath();
            for (let i = 0; i < samples.length; i++) {
                const x = (i / samples.length) * w;
                const v = (samples[i] - 0.5) * 2 * sensitivity;
                const y = mid + v * mid * 0.8;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            const grad = createLinearGradient(ctx, 0, 0, w, 0, palette);
            ctx.strokeStyle = grad;
            applyGlow(ctx, palette[0], 20);
            ctx.stroke();
            clearGlow(ctx);
            // Inner brighter line
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.8;
            ctx.strokeStyle = "#ffffff";
            ctx.beginPath();
            for (let i = 0; i < samples.length; i++) {
                const x = (i / samples.length) * w;
                const v = (samples[i] - 0.5) * 2 * sensitivity;
                const y = mid + v * mid * 0.8;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
            break;
        }
    }
}

const WAVE_LAYOUTS: WaveLayout[] = ["line", "filled", "mirror", "multi", "neon"];
const WAVE_NAMES: Record<WaveLayout, string> = {
    line: "Line", filled: "Filled", mirror: "Mirror",
    multi: "Multi-Layer", neon: "Neon Glow",
};

export function createWaveVisualizations(): VisualizationDef[] {
    return WAVE_LAYOUTS.flatMap((layout) =>
        VARIANT_PALETTES.map((palName) => ({
            id: `waves-${layout}-${palName}`,
            name: `${WAVE_NAMES[layout]} Wave · ${capitalize(palName)}`,
            category: "Waves",
            tags: ["waves", "waveform", layout, palName],
            render: (ctx: CanvasRenderingContext2D, data: AudioData, config: RenderConfig) =>
                renderWaves(ctx, data, config, layout, PALETTES[palName]),
        }))
    );
}
