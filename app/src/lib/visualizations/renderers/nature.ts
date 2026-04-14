import type { VisualizationDef, AudioData, RenderConfig } from "../types";
import { PALETTES, VARIANT_PALETTES } from "../palettes";
import { sampleData, getColorInterp, clearCanvas, hexToRgba, capitalize, applyGlow, clearGlow } from "../viz-utils";

type NatureType = "aurora" | "lightning" | "fire" | "bloom";

function renderNature(
    ctx: CanvasRenderingContext2D,
    data: AudioData,
    config: RenderConfig,
    type: NatureType,
    palette: string[],
) {
    const { width: w, height: h, time, sensitivity } = config;

    switch (type) {
        case "aurora": {
            clearCanvas(ctx, w, h, 0.03);
            const layers = 4;
            const samples = sampleData(data.frequency, 128);
            for (let l = 0; l < layers; l++) {
                const baseY = h * 0.3 + l * h * 0.1;
                ctx.beginPath();
                ctx.moveTo(0, h);
                for (let x = 0; x <= w; x += 4) {
                    const sIdx = Math.floor((x / w) * samples.length);
                    const v = (samples[sIdx] || 0) * sensitivity;
                    const wave1 = Math.sin(x * 0.008 + time * (0.5 + l * 0.2) + l) * 40;
                    const wave2 = Math.sin(x * 0.003 + time * 0.3 + l * 2) * 60;
                    const y = baseY + wave1 + wave2 - v * 80;
                    ctx.lineTo(x, y);
                }
                ctx.lineTo(w, h);
                ctx.closePath();
                const color = palette[l % palette.length];
                const grad = ctx.createLinearGradient(0, baseY - 100, 0, h);
                grad.addColorStop(0, hexToRgba(color, 0.4 + data.volume * 0.3));
                grad.addColorStop(0.5, hexToRgba(color, 0.1));
                grad.addColorStop(1, "transparent");
                ctx.fillStyle = grad;
                ctx.fill();
            }
            break;
        }
        case "lightning": {
            clearCanvas(ctx, w, h, 0.15);
            if (data.beat || data.bass * sensitivity > 0.6) {
                const bolts = 1 + Math.floor(data.beatIntensity * 3);
                for (let b = 0; b < bolts; b++) {
                    const startX = Math.random() * w;
                    let x = startX;
                    let y = 0;
                    const color = palette[b % palette.length];
                    // Main bolt
                    ctx.beginPath();
                    ctx.moveTo(x, y);
                    while (y < h) {
                        x += (Math.random() - 0.5) * 60;
                        y += 10 + Math.random() * 30;
                        ctx.lineTo(x, y);
                        // Branch
                        if (Math.random() > 0.7) {
                            ctx.moveTo(x, y);
                            let bx = x, by = y;
                            for (let i = 0; i < 5; i++) {
                                bx += (Math.random() - 0.5) * 40;
                                by += 5 + Math.random() * 15;
                                ctx.lineTo(bx, by);
                            }
                            ctx.moveTo(x, y);
                        }
                    }
                    applyGlow(ctx, color, 20);
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    ctx.stroke();
                    clearGlow(ctx);
                    // Inner bright line
                    ctx.strokeStyle = "rgba(255,255,255,0.8)";
                    ctx.lineWidth = 0.5;
                    ctx.stroke();
                }
                // Flash
                ctx.fillStyle = `rgba(255,255,255,${data.beatIntensity * 0.15})`;
                ctx.fillRect(0, 0, w, h);
            }
            break;
        }
        case "fire": {
            clearCanvas(ctx, w, h, 0.1);
            const samples = sampleData(data.frequency, 64);
            const particleCount = Math.floor(30 + data.volume * sensitivity * 50);
            for (let i = 0; i < particleCount; i++) {
                const x = Math.random() * w;
                const sIdx = Math.floor((x / w) * samples.length);
                const v = (samples[sIdx] || 0) * sensitivity;
                const baseY = h;
                const flameH = v * h * 0.7 + Math.random() * 30;
                const y = baseY - flameH;
                const size = 3 + Math.random() * 8 * v;
                const frac = 1 - flameH / (h * 0.7);
                const color = getColorInterp(palette, Math.min(1, frac));
                ctx.beginPath();
                ctx.arc(x, y, size, 0, Math.PI * 2);
                ctx.fillStyle = hexToRgba(color, 0.3 + v * 0.5);
                ctx.fill();
            }
            // Base glow
            const baseGrad = ctx.createLinearGradient(0, h, 0, h * 0.6);
            baseGrad.addColorStop(0, hexToRgba(palette[0], 0.5));
            baseGrad.addColorStop(1, "transparent");
            ctx.fillStyle = baseGrad;
            ctx.fillRect(0, h * 0.6, w, h * 0.4);
            break;
        }
        case "bloom": {
            clearCanvas(ctx, w, h);
            const cx = w / 2;
            const cy = h / 2;
            const samples = sampleData(data.frequency, 32);
            const petalLayers = 5;
            for (let l = 0; l < petalLayers; l++) {
                const petalCount = 6 + l * 2;
                const r = 30 + l * 40 + samples[l * 3] * sensitivity * 60;
                const rotation = time * (0.2 + l * 0.1) * (l % 2 === 0 ? 1 : -1);
                const color = palette[l % palette.length];
                for (let p = 0; p < petalCount; p++) {
                    const angle = (p / petalCount) * Math.PI * 2 + rotation;
                    const x = cx + Math.cos(angle) * r;
                    const y = cy + Math.sin(angle) * r;
                    const petalR = 15 + samples[(l * 3 + p) % samples.length] * sensitivity * 25;
                    ctx.beginPath();
                    ctx.ellipse(x, y, petalR, petalR * 0.6, angle, 0, Math.PI * 2);
                    ctx.fillStyle = hexToRgba(color, 0.2 + data.volume * 0.3);
                    ctx.fill();
                    ctx.strokeStyle = hexToRgba(color, 0.5);
                    ctx.lineWidth = 1;
                    ctx.stroke();
                }
            }
            // Center
            const centerR = 15 + data.bass * sensitivity * 20;
            ctx.beginPath();
            ctx.arc(cx, cy, centerR, 0, Math.PI * 2);
            const cGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, centerR);
            cGrad.addColorStop(0, hexToRgba(palette[0], 0.8));
            cGrad.addColorStop(1, hexToRgba(palette[0], 0));
            ctx.fillStyle = cGrad;
            ctx.fill();
            break;
        }
    }
}

const TYPES: NatureType[] = ["aurora", "lightning", "fire", "bloom"];
const NAMES: Record<NatureType, string> = {
    aurora: "Aurora", lightning: "Lightning", fire: "Fire", bloom: "Bloom",
};

export function createNatureVisualizations(): VisualizationDef[] {
    return TYPES.flatMap((type) =>
        VARIANT_PALETTES.map((palName) => ({
            id: `nature-${type}-${palName}`,
            name: `${NAMES[type]} · ${capitalize(palName)}`,
            category: "Nature",
            tags: ["nature", "organic", type, palName],
            render: (ctx: CanvasRenderingContext2D, data: AudioData, config: RenderConfig) =>
                renderNature(ctx, data, config, type, PALETTES[palName]),
        }))
    );
}
