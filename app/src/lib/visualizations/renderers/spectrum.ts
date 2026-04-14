import type { VisualizationDef, AudioData, RenderConfig } from "../types";
import { PALETTES, VARIANT_PALETTES } from "../palettes";
import { sampleData, getColorInterp, clearCanvas, hexToRgba, capitalize, applyGlow, clearGlow, createLinearGradient } from "../viz-utils";

type SpectrumType = "waterfall" | "spectrogram" | "heatmap";

// Persistent history buffers
const historyBuffers = new Map<string, number[][]>();

function getHistory(id: string, maxRows: number): number[][] {
    if (!historyBuffers.has(id)) historyBuffers.set(id, []);
    const h = historyBuffers.get(id)!;
    while (h.length > maxRows) h.shift();
    return h;
}

function renderSpectrum(
    ctx: CanvasRenderingContext2D,
    data: AudioData,
    config: RenderConfig,
    type: SpectrumType,
    palette: string[],
    id: string,
) {
    const { width: w, height: h, sensitivity } = config;
    const bins = config.quality === "high" ? 128 : 64;
    const samples = sampleData(data.frequency, bins);
    const maxRows = Math.floor(h / 3);

    const history = getHistory(id, maxRows);
    history.push(samples.map(s => s * sensitivity));

    switch (type) {
        case "waterfall": {
            clearCanvas(ctx, w, h);
            const rowH = h / maxRows;
            for (let row = 0; row < history.length; row++) {
                const rowData = history[row];
                const y = h - (history.length - row) * rowH;
                const alpha = 0.3 + (row / history.length) * 0.7;
                for (let col = 0; col < rowData.length; col++) {
                    const v = rowData[col];
                    const x = (col / rowData.length) * w;
                    const bw = w / rowData.length + 1;
                    const color = getColorInterp(palette, v);
                    ctx.fillStyle = hexToRgba(color, v * alpha);
                    ctx.fillRect(x, y, bw, rowH + 1);
                }
            }
            break;
        }
        case "spectrogram": {
            clearCanvas(ctx, w, h);
            const rowH = Math.max(2, h / maxRows);
            for (let row = 0; row < history.length; row++) {
                const rowData = history[row];
                const y = h - (history.length - row) * rowH;
                for (let col = 0; col < rowData.length; col++) {
                    const v = rowData[col];
                    const x = (col / rowData.length) * w;
                    const bw = w / rowData.length + 1;
                    // Heatmap coloring
                    const hue = (1 - v) * 240; // blue->red
                    ctx.fillStyle = `hsla(${hue}, 100%, ${20 + v * 60}%, ${0.3 + v * 0.7})`;
                    ctx.fillRect(x, y, bw, rowH + 1);
                }
            }
            break;
        }
        case "heatmap": {
            clearCanvas(ctx, w, h);
            const rowH = Math.max(2, h / maxRows);
            for (let row = 0; row < history.length; row++) {
                const rowData = history[row];
                const y = h - (history.length - row) * rowH;
                for (let col = 0; col < rowData.length; col++) {
                    const v = rowData[col];
                    const x = (col / rowData.length) * w;
                    const bw = w / rowData.length + 1;
                    const color = getColorInterp(palette, v);
                    ctx.fillStyle = hexToRgba(color, v);
                    ctx.fillRect(x, y, bw, rowH + 1);
                }
            }
            // Frequency labels
            ctx.fillStyle = "rgba(255,255,255,0.2)";
            ctx.font = "9px monospace";
            ctx.fillText("Low", 4, h - 4);
            ctx.fillText("High", w - 30, h - 4);
            break;
        }
    }
}

const TYPES: SpectrumType[] = ["waterfall", "spectrogram", "heatmap"];
const NAMES: Record<SpectrumType, string> = {
    waterfall: "Waterfall", spectrogram: "Spectrogram", heatmap: "Heatmap",
};

export function createSpectrumVisualizations(): VisualizationDef[] {
    return TYPES.flatMap((type) =>
        VARIANT_PALETTES.map((palName) => {
            const id = `spectrum-${type}-${palName}`;
            return {
                id,
                name: `${NAMES[type]} · ${capitalize(palName)}`,
                category: "Spectrum",
                tags: ["spectrum", "frequency", type, palName],
                render: (ctx: CanvasRenderingContext2D, data: AudioData, config: RenderConfig) =>
                    renderSpectrum(ctx, data, config, type, PALETTES[palName], id),
            };
        })
    );
}
