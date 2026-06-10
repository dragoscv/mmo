import type { VisualizationDef, AudioData, RenderConfig } from "../types";
import { PALETTES, VARIANT_PALETTES } from "../palettes";
import { sampleData, getColorInterp, clearCanvas, hexToRgba, capitalize } from "../viz-utils";

type TerrainType = "mountains" | "cityscape" | "horizon";

function renderTerrain(
    ctx: CanvasRenderingContext2D,
    data: AudioData,
    config: RenderConfig,
    type: TerrainType,
    palette: string[],
) {
    const { width: w, height: h, time, sensitivity } = config;
    clearCanvas(ctx, w, h);

    switch (type) {
        case "mountains": {
            const layers = 5;
            const samples = sampleData(data.frequency, 128);
            for (let l = 0; l < layers; l++) {
                const baseY = h * (0.4 + (l / layers) * 0.5);
                const amp = h * 0.2 * (1 - l / layers) * sensitivity;
                const speed = (layers - l) * 0.3;
                const color = getColorInterp(palette, l / layers);
                const alpha = 0.4 + (l / layers) * 0.6;

                ctx.beginPath();
                ctx.moveTo(0, h);
                for (let x = 0; x <= w; x += 3) {
                    const sIdx = Math.floor((x / w) * samples.length);
                    const audioVal = samples[sIdx % samples.length] || 0;
                    const noise = Math.sin(x * 0.02 + time * speed + l * 2)
                        + Math.sin(x * 0.005 + time * speed * 0.5) * 2;
                    const y = baseY - (noise * 0.5 + audioVal) * amp;
                    ctx.lineTo(x, y);
                }
                ctx.lineTo(w, h);
                ctx.closePath();
                ctx.fillStyle = hexToRgba(color, alpha);
                ctx.fill();
            }
            break;
        }
        case "cityscape": {
            // Starry sky
            if (data.beat) {
                for (let i = 0; i < 5; i++) {
                    ctx.beginPath();
                    ctx.arc(Math.random() * w, Math.random() * h * 0.5, 1, 0, Math.PI * 2);
                    ctx.fillStyle = "rgba(255,255,255,0.8)";
                    ctx.fill();
                }
            }
            const buildings = 40;
            const samples = sampleData(data.frequency, buildings);
            const bw = w / buildings;
            for (let i = 0; i < buildings; i++) {
                const v = samples[i] * sensitivity;
                const bh = h * 0.15 + v * h * 0.6;
                const x = i * bw;
                const y = h - bh;
                const color = getColorInterp(palette, i / buildings);
                // Building body
                ctx.fillStyle = hexToRgba(color, 0.7);
                ctx.fillRect(x + 1, y, bw - 2, bh);
                // Windows
                const winSize = 3;
                const winGap = 6;
                for (let wy = y + 8; wy < h - winGap; wy += winGap) {
                    for (let wx = x + 4; wx < x + bw - 4; wx += winGap) {
                        const lit = Math.random() > 0.3;
                        ctx.fillStyle = lit
                            ? hexToRgba("#ffffaa", 0.5 + v * 0.5)
                            : "rgba(0,0,0,0.3)";
                        ctx.fillRect(wx, wy, winSize, winSize);
                    }
                }
            }
            // Ground
            ctx.fillStyle = hexToRgba(palette[palette.length - 1], 0.2);
            ctx.fillRect(0, h - 4, w, 4);
            break;
        }
        case "horizon": {
            const samples = sampleData(data.frequency, 64);
            // Gradient sky
            const skyGrad = ctx.createLinearGradient(0, 0, 0, h);
            skyGrad.addColorStop(0, hexToRgba(palette[0], 0.3));
            skyGrad.addColorStop(0.5, hexToRgba(palette[1], 0.1));
            skyGrad.addColorStop(1, "transparent");
            ctx.fillStyle = skyGrad;
            ctx.fillRect(0, 0, w, h);
            // Sun/moon
            const sunR = 40 + data.bass * 20 * sensitivity;
            const sunY = h * 0.35 - data.mid * 30;
            ctx.beginPath();
            ctx.arc(w / 2, sunY, sunR, 0, Math.PI * 2);
            ctx.fillStyle = hexToRgba(palette[2] || palette[0], 0.6);
            ctx.shadowColor = palette[2] || palette[0];
            ctx.shadowBlur = sunR;
            ctx.fill();
            ctx.shadowBlur = 0;
            // Horizon lines
            const lineCount = 20;
            for (let i = 0; i < lineCount; i++) {
                const y = h * 0.55 + (i / lineCount) * h * 0.45;
                const spacing = 2 + i * 1.5;
                const sIdx = i % samples.length;
                const v = samples[sIdx] * sensitivity;
                ctx.strokeStyle = hexToRgba(
                    getColorInterp(palette, i / lineCount),
                    0.3 + v * 0.5
                );
                ctx.lineWidth = 1;
                ctx.beginPath();
                // Perspective vanishing point
                const narrowing = 1 - (y - h * 0.55) / (h * 0.45) * 0.4;
                const xStart = w * (0.5 - narrowing * 0.5);
                const xEnd = w * (0.5 + narrowing * 0.5);
                ctx.moveTo(xStart, y);
                ctx.lineTo(xEnd, y);
                ctx.stroke();
            }
            break;
        }
    }
}

const TYPES: TerrainType[] = ["mountains", "cityscape", "horizon"];
const NAMES: Record<TerrainType, string> = {
    mountains: "Mountains", cityscape: "Cityscape", horizon: "Horizon",
};

export function createTerrainVisualizations(): VisualizationDef[] {
    return TYPES.flatMap((type) =>
        VARIANT_PALETTES.map((palName) => ({
            id: `terrain-${type}-${palName}`,
            name: `${NAMES[type]} · ${capitalize(palName)}`,
            category: "Terrain",
            tags: ["terrain", "landscape", type, palName],
            render: (ctx: CanvasRenderingContext2D, data: AudioData, config: RenderConfig) =>
                renderTerrain(ctx, data, config, type, PALETTES[palName]),
        }))
    );
}
