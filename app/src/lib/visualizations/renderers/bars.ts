import type { VisualizationDef, AudioData, RenderConfig, PaletteName } from "../types";
import { PALETTES, VARIANT_PALETTES } from "../palettes";
import {
    sampleData, getColorInterp, applyGlow, clearGlow, clearCanvas, hexToRgba,
    createLinearGradient, roundRect, capitalize,
} from "../viz-utils";

type BarLayout = "classic" | "mirror" | "center" | "rounded" | "3d" | "floating";

function renderBars(
    ctx: CanvasRenderingContext2D,
    data: AudioData,
    config: RenderConfig,
    layout: BarLayout,
    palette: string[],
) {
    const { width: w, height: h, sensitivity } = config;
    clearCanvas(ctx, w, h);

    const barCount = config.quality === "high" ? 128 : config.quality === "medium" ? 80 : 48;
    const samples = sampleData(data.frequency, barCount);
    const gap = 2;
    const barWidth = (w - gap * barCount) / barCount;

    switch (layout) {
        case "classic": {
            for (let i = 0; i < barCount; i++) {
                const v = samples[i] * sensitivity;
                const barH = v * h * 0.85;
                const x = i * (barWidth + gap);
                const color = getColorInterp(palette, i / barCount);
                ctx.fillStyle = color;
                applyGlow(ctx, color, 8);
                ctx.fillRect(x, h - barH, barWidth, barH);
            }
            clearGlow(ctx);
            break;
        }
        case "mirror": {
            const half = h / 2;
            for (let i = 0; i < barCount; i++) {
                const v = samples[i] * sensitivity;
                const barH = v * half * 0.85;
                const x = i * (barWidth + gap);
                const color = getColorInterp(palette, i / barCount);
                ctx.fillStyle = color;
                ctx.fillRect(x, half - barH, barWidth, barH);
                ctx.fillStyle = hexToRgba(color, 0.5);
                ctx.fillRect(x, half, barWidth, barH);
            }
            break;
        }
        case "center": {
            const half = h / 2;
            for (let i = 0; i < barCount; i++) {
                const v = samples[i] * sensitivity;
                const barH = v * half * 0.85;
                const x = i * (barWidth + gap);
                const color = getColorInterp(palette, i / barCount);
                ctx.fillStyle = color;
                ctx.fillRect(x, half - barH / 2, barWidth, barH);
            }
            break;
        }
        case "rounded": {
            for (let i = 0; i < barCount; i++) {
                const v = samples[i] * sensitivity;
                const barH = Math.max(4, v * h * 0.85);
                const x = i * (barWidth + gap);
                const color = getColorInterp(palette, i / barCount);
                ctx.fillStyle = color;
                applyGlow(ctx, color, 6);
                roundRect(ctx, x, h - barH, barWidth, barH, barWidth / 2);
            }
            clearGlow(ctx);
            break;
        }
        case "3d": {
            const depth = 6;
            for (let i = 0; i < barCount; i++) {
                const v = samples[i] * sensitivity;
                const barH = v * h * 0.8;
                const x = i * (barWidth + gap);
                const y = h - barH;
                const color = getColorInterp(palette, i / barCount);
                // Side face
                ctx.fillStyle = hexToRgba(color, 0.4);
                ctx.beginPath();
                ctx.moveTo(x + barWidth, y);
                ctx.lineTo(x + barWidth + depth, y - depth);
                ctx.lineTo(x + barWidth + depth, h - depth);
                ctx.lineTo(x + barWidth, h);
                ctx.fill();
                // Top face
                ctx.fillStyle = hexToRgba(color, 0.6);
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x + depth, y - depth);
                ctx.lineTo(x + barWidth + depth, y - depth);
                ctx.lineTo(x + barWidth, y);
                ctx.fill();
                // Front face
                ctx.fillStyle = color;
                ctx.fillRect(x, y, barWidth, barH);
            }
            break;
        }
        case "floating": {
            for (let i = 0; i < barCount; i++) {
                const v = samples[i] * sensitivity;
                const segments = Math.max(1, Math.floor(v * 12));
                const x = i * (barWidth + gap);
                const segH = 4;
                const segGap = 3;
                for (let s = 0; s < segments; s++) {
                    const y = h - s * (segH + segGap) - segH;
                    const frac = s / 12;
                    const color = getColorInterp(palette, frac);
                    ctx.fillStyle = color;
                    ctx.fillRect(x, y, barWidth, segH);
                }
            }
            break;
        }
    }
}

const BAR_LAYOUTS: BarLayout[] = ["classic", "mirror", "center", "rounded", "3d", "floating"];
const BAR_LAYOUT_NAMES: Record<BarLayout, string> = {
    classic: "Classic", mirror: "Mirror", center: "Centered",
    rounded: "Rounded", "3d": "3D", floating: "Floating",
};

export function createBarVisualizations(): VisualizationDef[] {
    return BAR_LAYOUTS.flatMap((layout) =>
        VARIANT_PALETTES.map((palName) => ({
            id: `bars-${layout}-${palName}`,
            name: `${BAR_LAYOUT_NAMES[layout]} Bars · ${capitalize(palName)}`,
            category: "Bars",
            tags: ["bars", layout, palName],
            render: (ctx: CanvasRenderingContext2D, data: AudioData, config: RenderConfig) =>
                renderBars(ctx, data, { ...config, palette: PALETTES[palName] }, layout, PALETTES[palName]),
        }))
    );
}
