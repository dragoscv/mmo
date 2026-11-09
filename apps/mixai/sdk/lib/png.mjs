// Tiny PNG encoder (8-bit RGB, filter 0) + a palette preview renderer. Zero dependencies.
import { deflateSync } from "node:zlib";
import { crc32 } from "./zip.mjs";
import { toSrgb } from "./color.mjs";

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

/** Encode an RGB buffer (w*h*3) as PNG. */
export function encodePng(width, height, rgb) {
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 3 + 1)] = 0;
        rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type RGB
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

class Canvas {
    constructor(w, h) {
        this.w = w;
        this.h = h;
        this.px = Buffer.alloc(w * h * 3);
    }
    rect(x, y, w, h, [r, g, b]) {
        const x0 = Math.max(0, Math.round(x));
        const y0 = Math.max(0, Math.round(y));
        const x1 = Math.min(this.w, Math.round(x + w));
        const y1 = Math.min(this.h, Math.round(y + h));
        for (let yy = y0; yy < y1; yy++)
            for (let xx = x0; xx < x1; xx++) {
                const i = (yy * this.w + xx) * 3;
                this.px[i] = r;
                this.px[i + 1] = g;
                this.px[i + 2] = b;
            }
    }
    circle(cx, cy, rad, c) {
        for (let y = Math.floor(cy - rad); y <= cy + rad; y++)
            for (let x = Math.floor(cx - rad); x <= cx + rad; x++)
                if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) this.rect(x, y, 1, 1, c);
    }
}

const rgb255 = (color, fallback) => {
    const c = color ? toSrgb(color) : null;
    return (c ?? fallback).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
};

/**
 * Render a 640x360 preview from pack colours (+ optional layout grid sketch).
 * @param {Record<string,string>} colors
 * @param {{ columns:number[], rows:number[], areas:{panel:string,col:number,row:number,colSpan?:number,rowSpan?:number}[] } | null} layout
 */
export function renderPreview(colors = {}, layout = null, width = 640, height = 360) {
    const cv = new Canvas(width, height);
    const bg = rgb255(colors.background, [0.07, 0.07, 0.09]);
    const fg = rgb255(colors.foreground, [0.93, 0.93, 0.95]);
    const card = rgb255(colors.card, bg.map((v) => v / 255 * 0.9 + 0.08));
    const primary = rgb255(colors.primary, [0.55, 0.4, 0.95]);
    const muted = rgb255(colors["muted-foreground"] ?? colors.muted, [0.6, 0.6, 0.65]);
    const border = rgb255(colors.border, [0.25, 0.25, 0.3]);
    const decks = ["deck-a", "deck-b", "deck-c", "deck-d"].map((k, i) => rgb255(colors[k], [[0, 0.8, 1], [1, 0.4, 0.3], [0.4, 1, 0.5], [1, 0.8, 0.2]][i]));
    cv.rect(0, 0, width, height, bg);
    // top bar
    cv.rect(0, 0, width, 28, card);
    cv.rect(0, 28, width, 2, border);
    cv.circle(18, 14, 7, primary);
    cv.rect(34, 10, 90, 8, fg);
    cv.rect(width - 110, 9, 96, 10, primary);
    const area = { x: 12, y: 42, w: width - 24, h: height - 54 };
    const sketch = layout ?? {
        columns: [5, 3, 5],
        rows: [9, 2, 6],
        areas: [
            { panel: "deckA", col: 0, row: 0, rowSpan: 2 },
            { panel: "mixer", col: 1, row: 0 },
            { panel: "crossfader", col: 1, row: 1 },
            { panel: "deckB", col: 2, row: 0, rowSpan: 2 },
            { panel: "library", col: 0, row: 2, colSpan: 3 },
        ],
    };
    const gap = 8;
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const cw = (area.w - gap * (sketch.columns.length - 1)) / sum(sketch.columns);
    const rh = (area.h - gap * (sketch.rows.length - 1)) / sum(sketch.rows);
    const pos = (weights, i, unit) => sum(weights.slice(0, i)) * unit + gap * i;
    const deckIdx = { deckA: 0, deckB: 1, deckC: 2, deckD: 3 };
    for (const a of sketch.areas) {
        const cs = a.colSpan ?? 1;
        const rs = a.rowSpan ?? 1;
        const x = area.x + pos(sketch.columns, a.col, cw);
        const y = area.y + pos(sketch.rows, a.row, rh);
        const w = sum(sketch.columns.slice(a.col, a.col + cs)) * cw + gap * (cs - 1);
        const h = sum(sketch.rows.slice(a.row, a.row + rs)) * rh + gap * (rs - 1);
        cv.rect(x, y, w, h, border);
        cv.rect(x + 1, y + 1, w - 2, h - 2, card);
        if (a.panel in deckIdx) {
            const c = decks[deckIdx[a.panel]];
            cv.rect(x + 1, y + 1, w - 2, 4, c);
            const r = Math.max(6, Math.min(w, h) * 0.28);
            cv.circle(x + w / 2, y + h * 0.48, r, c);
            cv.circle(x + w / 2, y + h * 0.48, r * 0.55, card);
            cv.circle(x + w / 2, y + h * 0.48, Math.max(2, r * 0.12), fg);
            for (let i = 0; i < 24 && h > 60; i++) {
                const bh = (Math.sin(i * 1.7) * 0.5 + 0.6) * Math.min(18, h * 0.12);
                cv.rect(x + 8 + i * ((w - 16) / 24), y + h - 12 - bh, Math.max(1, (w - 16) / 24 - 2), bh, muted);
            }
        } else if (a.panel === "mixer") {
            for (let i = 0; i < 4; i++) cv.rect(x + 10 + i * ((w - 20) / 4), y + 12, Math.max(2, (w - 20) / 4 - 8), h - 24, i % 2 ? muted : primary);
        } else if (a.panel === "library") {
            for (let i = 0; y + 10 + i * 16 + 8 < y + h; i++) {
                cv.rect(x + 10, y + 10 + i * 16, w * 0.45, 7, i === 1 ? primary : fg);
                cv.rect(x + w * 0.6, y + 10 + i * 16, w * 0.3, 7, muted);
            }
        } else {
            cv.rect(x + 8, y + h / 2 - 3, w - 16, 6, primary);
        }
    }
    return encodePng(width, height, cv.px);
}
