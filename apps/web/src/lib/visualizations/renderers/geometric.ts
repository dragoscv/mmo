import type { VisualizationDef, AudioData, RenderConfig } from "../types";
import { PALETTES, VARIANT_PALETTES } from "../palettes";
import { sampleData, getColorInterp, clearCanvas, hexToRgba, capitalize, applyGlow, clearGlow } from "../viz-utils";

type GeoType = "hexgrid" | "polygons" | "tessellation" | "wireframe";

function renderGeometric(
    ctx: CanvasRenderingContext2D,
    data: AudioData,
    config: RenderConfig,
    type: GeoType,
    palette: string[],
) {
    const { width: w, height: h, time, sensitivity, mouse } = config;
    clearCanvas(ctx, w, h);

    switch (type) {
        case "hexgrid": {
            const size = config.quality === "high" ? 30 : 45;
            const cols = Math.ceil(w / (size * 1.5)) + 1;
            const rows = Math.ceil(h / (size * Math.sqrt(3))) + 1;
            const samples = sampleData(data.frequency, cols * rows);
            let idx = 0;
            for (let row = 0; row < rows; row++) {
                for (let col = 0; col < cols; col++) {
                    const x = col * size * 1.5;
                    const y = row * size * Math.sqrt(3) + (col % 2 ? size * Math.sqrt(3) / 2 : 0);
                    const v = (samples[idx % samples.length] || 0) * sensitivity;
                    const color = getColorInterp(palette, v);
                    ctx.beginPath();
                    for (let a = 0; a < 6; a++) {
                        const angle = (Math.PI / 3) * a + Math.PI / 6;
                        const r = size * 0.45 * (0.5 + v * 0.5);
                        const px = x + Math.cos(angle) * r;
                        const py = y + Math.sin(angle) * r;
                        if (a === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                    }
                    ctx.closePath();
                    ctx.fillStyle = hexToRgba(color, 0.3 + v * 0.7);
                    ctx.fill();
                    ctx.strokeStyle = hexToRgba(color, 0.5);
                    ctx.lineWidth = 1;
                    ctx.stroke();
                    idx++;
                }
            }
            break;
        }
        case "polygons": {
            const count = config.quality === "high" ? 24 : 16;
            const samples = sampleData(data.frequency, count);
            const cx = w / 2;
            const cy = h / 2;
            for (let i = 0; i < count; i++) {
                const v = samples[i] * sensitivity;
                const sides = 3 + (i % 6);
                const r = 30 + v * Math.min(w, h) * 0.35;
                const angle = (i / count) * Math.PI * 2 + time * 0.3;
                const px = cx + Math.cos(angle) * r * 0.5;
                const py = cy + Math.sin(angle) * r * 0.5;
                const color = getColorInterp(palette, i / count);
                ctx.beginPath();
                for (let s = 0; s <= sides; s++) {
                    const a = (s / sides) * Math.PI * 2 + time * 0.5;
                    const dx = px + Math.cos(a) * r * 0.4;
                    const dy = py + Math.sin(a) * r * 0.4;
                    if (s === 0) ctx.moveTo(dx, dy); else ctx.lineTo(dx, dy);
                }
                ctx.closePath();
                ctx.strokeStyle = hexToRgba(color, 0.6 + v * 0.4);
                ctx.lineWidth = 1.5 + v * 2;
                applyGlow(ctx, color, 6);
                ctx.stroke();
                clearGlow(ctx);
            }
            break;
        }
        case "tessellation": {
            const tileSize = config.quality === "high" ? 40 : 60;
            const cols = Math.ceil(w / tileSize);
            const rows = Math.ceil(h / tileSize);
            const samples = sampleData(data.frequency, 64);
            for (let row = 0; row < rows; row++) {
                for (let col = 0; col < cols; col++) {
                    const x = col * tileSize;
                    const y = row * tileSize;
                    const sIdx = (row * cols + col) % samples.length;
                    const v = samples[sIdx] * sensitivity;
                    const color = getColorInterp(palette, v);
                    const distort = Math.sin(time + col * 0.5 + row * 0.3) * v * 5;
                    ctx.fillStyle = hexToRgba(color, 0.2 + v * 0.6);
                    if ((row + col) % 2 === 0) {
                        ctx.beginPath();
                        ctx.moveTo(x + distort, y);
                        ctx.lineTo(x + tileSize + distort, y);
                        ctx.lineTo(x + tileSize / 2, y + tileSize);
                        ctx.closePath();
                        ctx.fill();
                    } else {
                        ctx.beginPath();
                        ctx.moveTo(x + tileSize / 2, y);
                        ctx.lineTo(x + tileSize, y + tileSize);
                        ctx.lineTo(x - distort, y + tileSize);
                        ctx.closePath();
                        ctx.fill();
                    }
                }
            }
            break;
        }
        case "wireframe": {
            const gridSize = config.quality === "high" ? 20 : 30;
            const cols = Math.ceil(w / gridSize);
            const rows = Math.ceil(h / gridSize);
            const samples = sampleData(data.frequency, 64);

            // Mouse interaction - distort grid around mouse
            const mx = mouse.active ? mouse.x * w : w / 2;
            const my = mouse.active ? mouse.y * h : h / 2;

            ctx.lineWidth = 0.8;
            for (let row = 0; row <= rows; row++) {
                ctx.beginPath();
                for (let col = 0; col <= cols; col++) {
                    let x = col * gridSize;
                    let y = row * gridSize;
                    const sIdx = (col + row) % samples.length;
                    const v = samples[sIdx] * sensitivity;
                    // Mouse distortion
                    const dx = x - mx;
                    const dy = y - my;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < 150) {
                        const force = (1 - dist / 150) * 20 * data.volume * sensitivity;
                        x += (dx / dist) * force;
                        y += (dy / dist) * force;
                    }
                    y += Math.sin(time * 2 + col * 0.3) * v * 10;
                    if (col === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                const color = getColorInterp(palette, row / rows);
                ctx.strokeStyle = hexToRgba(color, 0.3 + data.volume * 0.4);
                ctx.stroke();
            }
            break;
        }
    }
}

const TYPES: GeoType[] = ["hexgrid", "polygons", "tessellation", "wireframe"];
const NAMES: Record<GeoType, string> = {
    hexgrid: "Hex Grid", polygons: "Polygons",
    tessellation: "Tessellation", wireframe: "Wireframe",
};

export function createGeometricVisualizations(): VisualizationDef[] {
    return TYPES.flatMap((type) =>
        VARIANT_PALETTES.map((palName) => ({
            id: `geometric-${type}-${palName}`,
            name: `${NAMES[type]} · ${capitalize(palName)}`,
            category: "Geometric",
            tags: ["geometric", "shapes", type, palName],
            interactive: type === "wireframe",
            render: (ctx: CanvasRenderingContext2D, data: AudioData, config: RenderConfig) =>
                renderGeometric(ctx, data, config, type, PALETTES[palName]),
        }))
    );
}
