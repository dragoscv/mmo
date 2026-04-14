import type { VisualizationDef, AudioData, RenderConfig } from "../types";
import { PALETTES, VARIANT_PALETTES } from "../palettes";
import { sampleData, getColorInterp, clearCanvas, hexToRgba, capitalize, applyGlow, clearGlow } from "../viz-utils";

type AbstractType = "plasma" | "kaleidoscope" | "lava" | "ink" | "vortex";

function renderAbstract(
    ctx: CanvasRenderingContext2D,
    data: AudioData,
    config: RenderConfig,
    type: AbstractType,
    palette: string[],
) {
    const { width: w, height: h, time, sensitivity, mouse } = config;

    switch (type) {
        case "plasma": {
            clearCanvas(ctx, w, h);
            const step = config.quality === "high" ? 4 : config.quality === "medium" ? 6 : 10;
            const speed = time * 0.5;
            const audioMod = data.bass * sensitivity * 2;
            for (let y = 0; y < h; y += step) {
                for (let x = 0; x < w; x += step) {
                    const v1 = Math.sin(x * 0.02 + speed);
                    const v2 = Math.sin(y * 0.02 + speed * 0.7);
                    const v3 = Math.sin((x + y) * 0.01 + speed * 0.5);
                    const v4 = Math.sin(Math.sqrt(x * x + y * y) * 0.005 + speed * 0.3);
                    const v = (v1 + v2 + v3 + v4 + audioMod) / (4 + audioMod);
                    const frac = (v + 1) / 2;
                    ctx.fillStyle = getColorInterp(palette, frac);
                    ctx.fillRect(x, y, step, step);
                }
            }
            break;
        }
        case "kaleidoscope": {
            clearCanvas(ctx, w, h);
            const cx = w / 2;
            const cy = h / 2;
            const segments = 12;
            const samples = sampleData(data.frequency, 64);

            ctx.save();
            ctx.translate(cx, cy);
            for (let seg = 0; seg < segments; seg++) {
                ctx.save();
                ctx.rotate((seg / segments) * Math.PI * 2);
                if (seg % 2 === 1) ctx.scale(1, -1); // mirror alternating

                // Draw pattern
                for (let i = 0; i < 20; i++) {
                    const v = (samples[i % samples.length] || 0) * sensitivity;
                    const angle = (i / 20) * Math.PI * 0.5;
                    const r = 30 + i * 15 + v * 50;
                    const x = Math.cos(angle + time * 0.5) * r;
                    const y = Math.sin(angle + time * 0.5) * r;
                    const size = 5 + v * 15;
                    const color = getColorInterp(palette, i / 20);
                    ctx.beginPath();
                    ctx.arc(x, y, size, 0, Math.PI * 2);
                    ctx.fillStyle = hexToRgba(color, 0.3 + v * 0.5);
                    ctx.fill();
                }
                ctx.restore();
            }
            ctx.restore();
            break;
        }
        case "lava": {
            clearCanvas(ctx, w, h, 0.03);
            const blobs = 12;
            const samples = sampleData(data.frequency, blobs);
            for (let i = 0; i < blobs; i++) {
                const v = samples[i] * sensitivity;
                const angle = (i / blobs) * Math.PI * 2;
                const r = Math.min(w, h) * 0.15 + v * Math.min(w, h) * 0.2;
                const cx = w / 2 + Math.cos(angle + time * 0.3 + i) * r;
                const cy = h / 2 + Math.sin(angle * 1.5 + time * 0.2 + i) * r * 0.7;
                const blobR = 30 + v * 60;
                const color = palette[i % palette.length];
                const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, blobR);
                grad.addColorStop(0, hexToRgba(color, 0.6));
                grad.addColorStop(0.5, hexToRgba(color, 0.2));
                grad.addColorStop(1, "transparent");
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(cx, cy, blobR, 0, Math.PI * 2);
                ctx.fill();
            }
            break;
        }
        case "ink": {
            clearCanvas(ctx, w, h, 0.02);
            const drops = Math.floor(data.volume * sensitivity * 8) + (data.beat ? 5 : 0);
            for (let i = 0; i < drops; i++) {
                const x = Math.random() * w;
                const y = Math.random() * h;
                const r = 5 + Math.random() * 30 * data.bass * sensitivity;
                const color = palette[Math.floor(Math.random() * palette.length)];
                const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
                grad.addColorStop(0, hexToRgba(color, 0.3));
                grad.addColorStop(0.7, hexToRgba(color, 0.1));
                grad.addColorStop(1, "transparent");
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fill();
            }
            break;
        }
        case "vortex": {
            clearCanvas(ctx, w, h, 0.04);
            const cx = mouse.active ? mouse.x * w : w / 2;
            const cy = mouse.active ? mouse.y * h : h / 2;
            const arms = 6;
            const samples = sampleData(data.frequency, 128);
            const rotation = time * 0.5;

            for (let arm = 0; arm < arms; arm++) {
                const baseAngle = (arm / arms) * Math.PI * 2 + rotation;
                const color = palette[arm % palette.length];
                ctx.beginPath();
                for (let i = 0; i < 100; i++) {
                    const t = i / 100;
                    const sIdx = i % samples.length;
                    const v = (samples[sIdx] || 0) * sensitivity;
                    const r = t * Math.min(w, h) * 0.45;
                    const spiralAngle = baseAngle + t * Math.PI * 4;
                    const wobble = Math.sin(t * 10 + time * 3) * v * 15;
                    const x = cx + Math.cos(spiralAngle) * (r + wobble);
                    const y = cy + Math.sin(spiralAngle) * (r + wobble);
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.strokeStyle = hexToRgba(color, 0.5);
                ctx.lineWidth = 2 + data.volume * 3;
                applyGlow(ctx, color, 8);
                ctx.stroke();
                clearGlow(ctx);
            }
            break;
        }
    }
}

const TYPES: AbstractType[] = ["plasma", "kaleidoscope", "lava", "ink", "vortex"];
const NAMES: Record<AbstractType, string> = {
    plasma: "Plasma", kaleidoscope: "Kaleidoscope", lava: "Lava Lamp",
    ink: "Ink Bleed", vortex: "Vortex",
};

export function createAbstractVisualizations(): VisualizationDef[] {
    return TYPES.flatMap((type) =>
        VARIANT_PALETTES.map((palName) => ({
            id: `abstract-${type}-${palName}`,
            name: `${NAMES[type]} · ${capitalize(palName)}`,
            category: "Abstract",
            tags: ["abstract", "artistic", type, palName],
            interactive: type === "vortex",
            render: (ctx: CanvasRenderingContext2D, data: AudioData, config: RenderConfig) =>
                renderAbstract(ctx, data, config, type, PALETTES[palName]),
        }))
    );
}
