import type { VisualizationDef, AudioData, RenderConfig } from "../types";
import { PALETTES, VARIANT_PALETTES } from "../palettes";
import { sampleData, getColorInterp, clearCanvas, hexToRgba, capitalize, applyGlow, clearGlow, createLinearGradient } from "../viz-utils";

type LineType = "strings" | "web" | "trails" | "echo" | "pulse";

// Persistent trail data
const trailBuffers = new Map<string, Array<{ x: number; y: number }[]>>();

function renderLines(
    ctx: CanvasRenderingContext2D,
    data: AudioData,
    config: RenderConfig,
    type: LineType,
    palette: string[],
    id: string,
) {
    const { width: w, height: h, time, sensitivity, mouse } = config;

    switch (type) {
        case "strings": {
            clearCanvas(ctx, w, h);
            const stringCount = 20;
            const samples = sampleData(data.frequency, stringCount);
            const gap = h / (stringCount + 1);
            for (let s = 0; s < stringCount; s++) {
                const y = gap * (s + 1);
                const v = samples[s] * sensitivity;
                const color = getColorInterp(palette, s / stringCount);
                ctx.beginPath();
                for (let x = 0; x <= w; x += 3) {
                    const vibration = Math.sin(x * 0.03 + time * 5 + s * 0.5) * v * 30;
                    const decay = Math.sin((x / w) * Math.PI); // stronger in center
                    const py = y + vibration * decay;
                    if (x === 0) ctx.moveTo(x, py); else ctx.lineTo(x, py);
                }
                ctx.strokeStyle = hexToRgba(color, 0.5 + v * 0.5);
                ctx.lineWidth = 1 + v * 2;
                applyGlow(ctx, color, v * 10);
                ctx.stroke();
                clearGlow(ctx);
            }
            break;
        }
        case "web": {
            clearCanvas(ctx, w, h);
            const nodeCount = 30;
            const samples = sampleData(data.frequency, nodeCount);
            const nodes: { x: number; y: number; v: number }[] = [];
            for (let i = 0; i < nodeCount; i++) {
                const angle = (i / nodeCount) * Math.PI * 2 + time * 0.2;
                const v = samples[i] * sensitivity;
                const r = 50 + v * Math.min(w, h) * 0.35;
                nodes.push({
                    x: w / 2 + Math.cos(angle) * r + Math.sin(time + i) * 20,
                    y: h / 2 + Math.sin(angle) * r + Math.cos(time * 0.7 + i) * 20,
                    v,
                });
            }
            // Draw connections
            ctx.lineWidth = 0.8;
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const dx = nodes[i].x - nodes[j].x;
                    const dy = nodes[i].y - nodes[j].y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < 200) {
                        const alpha = (1 - dist / 200) * 0.4 * (nodes[i].v + nodes[j].v);
                        const color = getColorInterp(palette, i / nodes.length);
                        ctx.strokeStyle = hexToRgba(color, alpha);
                        ctx.beginPath();
                        ctx.moveTo(nodes[i].x, nodes[i].y);
                        ctx.lineTo(nodes[j].x, nodes[j].y);
                        ctx.stroke();
                    }
                }
            }
            // Draw nodes
            for (let i = 0; i < nodes.length; i++) {
                const color = getColorInterp(palette, i / nodes.length);
                const r = 2 + nodes[i].v * 6;
                ctx.beginPath();
                ctx.arc(nodes[i].x, nodes[i].y, r, 0, Math.PI * 2);
                ctx.fillStyle = hexToRgba(color, 0.7);
                ctx.fill();
            }
            break;
        }
        case "trails": {
            clearCanvas(ctx, w, h, 0.05);
            const trailCount = 8;
            if (!trailBuffers.has(id)) {
                trailBuffers.set(id, Array.from({ length: trailCount }, () => []));
            }
            const trails = trailBuffers.get(id)!;
            const samples = sampleData(data.frequency, trailCount);
            for (let t = 0; t < trailCount; t++) {
                const v = samples[t] * sensitivity;
                const angle = (t / trailCount) * Math.PI * 2 + time * (0.5 + t * 0.1);
                const r = 80 + v * 150;
                const x = w / 2 + Math.cos(angle) * r;
                const y = h / 2 + Math.sin(angle * 1.3) * r * 0.6;
                trails[t].push({ x, y });
                if (trails[t].length > 60) trails[t].shift();
                // Draw trail
                const color = palette[t % palette.length];
                ctx.beginPath();
                for (let i = 0; i < trails[t].length; i++) {
                    const p = trails[t][i];
                    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
                }
                ctx.strokeStyle = hexToRgba(color, 0.6);
                ctx.lineWidth = 2;
                applyGlow(ctx, color, 6);
                ctx.stroke();
                clearGlow(ctx);
                // Head dot
                const last = trails[t][trails[t].length - 1];
                if (last) {
                    ctx.beginPath();
                    ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
                    ctx.fillStyle = color;
                    ctx.fill();
                }
            }
            break;
        }
        case "echo": {
            clearCanvas(ctx, w, h, 0.06);
            const samples = sampleData(data.timeDomain, 256);
            const layers = 5;
            for (let l = 0; l < layers; l++) {
                const offset = l * 0.08;
                const alpha = 1 - l * 0.18;
                const shift = l * 15;
                ctx.beginPath();
                for (let i = 0; i < samples.length; i++) {
                    const x = (i / samples.length) * w;
                    const v = (samples[i] - 0.5) * 2 * sensitivity;
                    const y = h / 2 + v * h * 0.3 + shift;
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                const color = palette[l % palette.length];
                ctx.strokeStyle = hexToRgba(color, alpha * 0.6);
                ctx.lineWidth = 2;
                ctx.stroke();
            }
            break;
        }
        case "pulse": {
            clearCanvas(ctx, w, h, 0.08);
            if (data.beat || Math.random() < data.bass * 0.1) {
                const cx = w / 2;
                const cy = h / 2;
                const maxR = Math.max(w, h) * 0.6;
                const color = palette[Math.floor(Math.random() * palette.length)];
                // Expanding ring
                for (let r = 0; r < maxR; r += maxR / 15) {
                    const alpha = (1 - r / maxR) * data.beatIntensity * 0.5;
                    ctx.beginPath();
                    ctx.arc(cx, cy, r, 0, Math.PI * 2);
                    ctx.strokeStyle = hexToRgba(color, alpha);
                    ctx.lineWidth = 3;
                    ctx.stroke();
                }
            }
            // Steady subtle rings based on mid energy
            const ringCount = Math.floor(data.mid * sensitivity * 5);
            for (let i = 0; i < ringCount; i++) {
                const r = 20 + i * 40 + Math.sin(time + i) * 10;
                const color = getColorInterp(palette, i / 5);
                ctx.beginPath();
                ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
                ctx.strokeStyle = hexToRgba(color, 0.15);
                ctx.lineWidth = 1;
                ctx.stroke();
            }
            break;
        }
    }
}

const TYPES: LineType[] = ["strings", "web", "trails", "echo", "pulse"];
const NAMES: Record<LineType, string> = {
    strings: "Strings", web: "Neural Web", trails: "Trails",
    echo: "Echo", pulse: "Pulse",
};

export function createLineVisualizations(): VisualizationDef[] {
    return TYPES.flatMap((type) =>
        VARIANT_PALETTES.map((palName) => {
            const id = `lines-${type}-${palName}`;
            return {
                id,
                name: `${NAMES[type]} · ${capitalize(palName)}`,
                category: "Lines",
                tags: ["lines", "patterns", type, palName],
                render: (ctx: CanvasRenderingContext2D, data: AudioData, config: RenderConfig) =>
                    renderLines(ctx, data, config, type, PALETTES[palName], id),
            };
        })
    );
}
