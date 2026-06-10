import type { VisualizationDef, AudioData, RenderConfig } from "../types";
import { PALETTES, VARIANT_PALETTES } from "../palettes";
import { sampleData, getColorInterp, clearCanvas, hexToRgba, capitalize } from "../viz-utils";

type DigitalType = "matrix" | "binary" | "glitch";

// Persistent state for matrix rain
const matrixState = new Map<string, { drops: number[]; chars: string[][] }>();

function renderDigital(
    ctx: CanvasRenderingContext2D,
    data: AudioData,
    config: RenderConfig,
    type: DigitalType,
    palette: string[],
    id: string,
) {
    const { width: w, height: h, time, sensitivity, deltaTime } = config;

    switch (type) {
        case "matrix": {
            clearCanvas(ctx, w, h, 0.05);
            const fontSize = 14;
            const cols = Math.floor(w / fontSize);
            if (!matrixState.has(id)) {
                const drops = Array.from({ length: cols }, () => Math.random() * -50);
                const chars = Array.from({ length: cols }, () =>
                    Array.from({ length: Math.ceil(h / fontSize) + 1 }, () =>
                        String.fromCharCode(0x30A0 + Math.floor(Math.random() * 96))
                    )
                );
                matrixState.set(id, { drops, chars });
            }
            const state = matrixState.get(id)!;
            const speed = 1 + data.volume * sensitivity * 3;

            ctx.font = `${fontSize}px monospace`;
            for (let i = 0; i < cols; i++) {
                const sIdx = i % 64;
                const samples = sampleData(data.frequency, 64);
                const v = samples[sIdx] * sensitivity;
                const drop = state.drops[i];
                const y = drop * fontSize;

                // Head character (bright)
                const color = getColorInterp(palette, v);
                ctx.fillStyle = color;
                ctx.shadowColor = color;
                ctx.shadowBlur = 8;
                const char = state.chars[i][Math.floor(drop) % state.chars[i].length];
                ctx.fillText(char, i * fontSize, y);
                ctx.shadowBlur = 0;

                // Trail
                for (let t = 1; t < 8; t++) {
                    const ty = (drop - t) * fontSize;
                    if (ty < 0) continue;
                    const tc = state.chars[i][(Math.floor(drop) - t + state.chars[i].length) % state.chars[i].length];
                    ctx.fillStyle = hexToRgba(color, (1 - t / 8) * 0.6);
                    ctx.fillText(tc, i * fontSize, ty);
                }

                state.drops[i] += speed * deltaTime * 10;
                if (state.drops[i] * fontSize > h && Math.random() > 0.95) {
                    state.drops[i] = 0;
                }
                // Randomize chars occasionally
                if (Math.random() > 0.98) {
                    const ri = Math.floor(Math.random() * state.chars[i].length);
                    state.chars[i][ri] = String.fromCharCode(0x30A0 + Math.floor(Math.random() * 96));
                }
            }
            break;
        }
        case "binary": {
            clearCanvas(ctx, w, h, 0.08);
            const fontSize = 12;
            const samples = sampleData(data.frequency, 32);
            const streams = Math.floor(data.volume * sensitivity * 30) + 5;

            ctx.font = `${fontSize}px monospace`;
            for (let s = 0; s < streams; s++) {
                const x = Math.random() * w;
                const y = (time * (50 + s * 10) + s * 100) % (h + fontSize) - fontSize;
                const v = samples[s % samples.length];
                const color = getColorInterp(palette, s / streams);
                const bit = Math.random() > 0.5 ? "1" : "0";
                ctx.fillStyle = hexToRgba(color, 0.3 + v * 0.7);
                ctx.fillText(bit, x, y);
            }
            break;
        }
        case "glitch": {
            clearCanvas(ctx, w, h);
            const samples = sampleData(data.frequency, 64);
            // Horizontal scan lines
            for (let y = 0; y < h; y += 2) {
                const sIdx = Math.floor((y / h) * samples.length);
                const v = samples[sIdx] * sensitivity;
                if (v > 0.3) {
                    const offset = (Math.random() - 0.5) * v * 40;
                    const sliceH = 2 + Math.floor(Math.random() * 4);
                    const color = getColorInterp(palette, v);
                    ctx.fillStyle = hexToRgba(color, v * 0.5);
                    ctx.fillRect(offset, y, w, sliceH);
                }
            }
            // RGB split blocks
            if (data.beat) {
                for (let i = 0; i < 5; i++) {
                    const bx = Math.random() * w;
                    const by = Math.random() * h;
                    const bw = 20 + Math.random() * 100;
                    const bh = 5 + Math.random() * 30;
                    ctx.fillStyle = hexToRgba(palette[i % palette.length], 0.4);
                    ctx.fillRect(bx, by, bw, bh);
                    ctx.fillStyle = hexToRgba(palette[(i + 1) % palette.length], 0.3);
                    ctx.fillRect(bx + 3, by + 2, bw, bh);
                }
            }
            // Static noise
            const noiseAmount = data.treble * sensitivity * 200;
            for (let i = 0; i < noiseAmount; i++) {
                const px = Math.random() * w;
                const py = Math.random() * h;
                const brightness = Math.random();
                ctx.fillStyle = `rgba(255,255,255,${brightness * 0.3})`;
                ctx.fillRect(px, py, 1, 1);
            }
            break;
        }
    }
}

const TYPES: DigitalType[] = ["matrix", "binary", "glitch"];
const NAMES: Record<DigitalType, string> = {
    matrix: "Matrix Rain", binary: "Binary Stream", glitch: "Glitch",
};

export function createDigitalVisualizations(): VisualizationDef[] {
    return TYPES.flatMap((type) =>
        VARIANT_PALETTES.map((palName) => {
            const id = `digital-${type}-${palName}`;
            return {
                id,
                name: `${NAMES[type]} · ${capitalize(palName)}`,
                category: "Digital",
                tags: ["digital", "retro", type, palName],
                render: (ctx: CanvasRenderingContext2D, data: AudioData, config: RenderConfig) =>
                    renderDigital(ctx, data, config, type, PALETTES[palName], id),
            };
        })
    );
}
