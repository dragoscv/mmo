// Drawing primitives of the brand generator: colours (from the design tokens), optical sizes, SVG builders,
// outlined lettering, PNG / ICO / ICNS encoders. No file output here (see ../build.mjs).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLYPHS, TILE, WORDMARK, geometry } from '../../src/marks.mjs';
import * as P from './path.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readJson = (rel) => JSON.parse(readFileSync(path.join(REPO, rel), 'utf8'));

const tokens = readJson('packages/design-tokens/dist/tokens.json');
if (!tokens.products || !tokens.mark) throw new Error('packages/design-tokens/dist/tokens.json has no product colours: run `pnpm tokens:build` first');
export const LETTERING = readJson('brand/src/lettering.json');
/** id -> { name, short, hex: { dark, light } } */
export const PRODUCTS = tokens.products;
/** { tile, canvas, canvasLight, streamA: {dark, light}, streamB, signal } */
export const C = tokens.mark.colors;
/** Neutral roles per theme as OKLCH objects `{ l, c, h }` (background, card, foreground, ...). */
export const ROLES = tokens.roles;
export const PRODUCT_IDS = Object.keys(GLYPHS);
for (const id of PRODUCT_IDS) if (!PRODUCTS[id]) throw new Error(`design tokens have no colour for product "${id}"`);

export const nameOf = (id) => (id === 'mark' ? 'MixAI' : PRODUCTS[id].name);
/** Escape text for XML / HTML attribute and element content. */
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const n = (v, digits = 3) => {
  const s = Number(v).toFixed(digits);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/** Colours of a mark: stream A, stream B, the signal dot. `mono` paints everything in one colour. */
export function scheme(id, mode = 'dark', mono) {
  if (mono) return { a: mono, b: mono, dot: mono };
  if (id === 'mark') return { a: C.streamA[mode], b: C.streamB[mode], dot: C.signal[mode] };
  const c = PRODUCTS[id].hex[mode];
  return { a: c, b: c, dot: C.signal[mode] };
}

/** Optical size for a rendered symbol box of `px` pixels. */
export function optical(id, px) {
  const set = geometry(id);
  if (px <= 16) return { geo: set.micro, wMul: 1, dotMul: 1 };
  if (px <= 40) return { geo: set.master, wMul: 1.12, dotMul: 1.06 };
  return { geo: set.master, wMul: 1, dotMul: 1 };
}

/** SVG markup of a symbol in its own grid (no wrapper). */
export function inner(id, px, sch) {
  const { geo, wMul, dotMul } = optical(id, px);
  const w = n(geo.w * wMul);
  const lines = geo.lines
    .map((l) => `<path d="${l.d}" fill="none" stroke="${l.role === 'b' ? sch.b : sch.a}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join('');
  const [cx, cy, r] = geo.dot;
  return { grid: geo.grid, markup: `${lines}<circle cx="${cx}" cy="${cy}" r="${n(r * dotMul)}" fill="${sch.dot}"/>` };
}

export function svg(w, h, viewBox, body, title) {
  const a11y = title ? ` role="img" aria-label="${esc(title)}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w, 2)}" height="${n(h, 2)}" viewBox="${viewBox}"${a11y}>${body}</svg>\n`;
}

/** Symbol alone (transparent background). */
export function symbolSvg(id, px, { mode = 'dark', mono, title } = {}) {
  const { grid, markup } = inner(id, px, scheme(id, mode, mono));
  return svg(px, px, `0 0 ${grid} ${grid}`, markup, title);
}

/** A symbol placed in a larger drawing: `<g>` at (x, y) with a box of `size` user units. */
export function place(id, x, y, size, { mode = 'dark', mono, px = size } = {}) {
  const { grid, markup } = inner(id, px, scheme(id, mode, mono));
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${n(size / grid, 5)})">${markup}</g>`;
}

/** App icon tile. shape: rounded | square | circle. `scale` overrides the optical symbol scale. */
export function tileSvg(id, px, { shape = 'rounded', bg = C.tile, mode = 'dark', mono, scale, title } = {}) {
  const k = scale ?? (px <= 16 ? TILE.scale.micro : px <= 32 ? TILE.scale.small : TILE.scale.large);
  const { grid, markup } = inner(id, px * k, scheme(id, mode, mono));
  const rx = shape === 'rounded' ? ` rx="${n(grid * TILE.radius)}"` : shape === 'circle' ? ` rx="${grid / 2}"` : '';
  const plate = bg ? `<rect width="${grid}" height="${grid}"${rx} fill="${bg}"/>` : '';
  const off = n((grid * (1 - k)) / 2);
  const symbol = k === 1 ? markup : `<g transform="translate(${off} ${off}) scale(${n(k, 5)})">${markup}</g>`;
  return svg(px, px, `0 0 ${grid} ${grid}`, plate + symbol, title);
}

/** macOS icon (Big Sur to Sequoia shape): rounded body of 824 on a 1024 canvas, drawn at `px`. */
export function macIconSvg(id, px) {
  const body = 824;
  const m = (1024 - body) / 2;
  const sym = body * TILE.scale.large;
  const o = m + (body - sym) / 2;
  const markup = `<rect x="${m}" y="${m}" width="${body}" height="${body}" rx="185" fill="${C.tile}"/>` + place(id, o, o, sym, { px: (px * sym) / 1024 });
  return svg(px, px, '0 0 1024 1024', markup);
}

// ── lettering (outlined Space Grotesk) ─────────────────────────────────────────────────────

/**
 * Outlined text run in a y-down space. Returns one `{ d, index, char }` per glyph plus `width`.
 * With `iDot`, the dot of the "i" is left out of the glyph and returned as `dot: { cx, cy, r }`.
 */
export function runParts(key, { x = 0, y = 0, cap, iDot = false }) {
  const run = LETTERING.runs[key];
  if (!run) throw new Error(`brand/src/lettering.json has no run "${key}": add it to outline-lettering.py and re-run it`);
  const s = cap / LETTERING.font.capHeight;
  const parts = [];
  let dot = null;
  run.glyphs.forEach((g, index) => {
    let d = '';
    g.contours.forEach((c, ci) => {
      if (iDot && g.char === 'i' && ci === 1) {
        dot = { cx: x + (g.x + WORDMARK.iDot.cx) * s, cy: y - WORDMARK.iDot.cy * s, r: WORDMARK.iDot.r * s };
        return;
      }
      d += P.format(P.mapPoints(P.parse(c.d), (px, py) => [x + (g.x + px) * s, y - py * s]), 2);
    });
    if (d) parts.push({ d, index, char: g.char });
  });
  return { parts, dot, width: run.advance * s };
}

/**
 * "MixAI" (+ product name) as filled paths: `[{ d, role, fill }]` and the total width.
 * "Mix" and the product name take the text colour, "AI" the accent (second stream for the family, the product
 * colour for a product), the dot of the "i" is the signal. `role` is `fg` or `accent`.
 */
export function letteringParts(id, { x = 0, y, cap, mode = 'dark', mono }) {
  const fill = { fg: mono ?? C.signal[mode], accent: mono ?? (id === 'mark' ? C.streamB[mode] : PRODUCTS[id].hex[mode]) };
  const part = (d, role) => ({ d, role, fill: fill[role] });
  const s = cap / LETTERING.font.capHeight;
  const brand = runParts('brand', { x, y, cap, iDot: true });
  const out = brand.parts.map((p) => part(p.d, p.index >= 3 ? 'accent' : 'fg'));
  out.push(part(P.format(P.parse(P.circlePath(brand.dot.cx, brand.dot.cy, brand.dot.r)), 2), 'fg'));
  let width = brand.width;
  if (id !== 'mark') {
    const gap = WORDMARK.descriptorGap * s;
    const desc = runParts(id, { x: x + brand.width + gap, y, cap });
    for (const p of desc.parts) out.push(part(p.d, 'fg'));
    width += gap + desc.width;
  }
  return { parts: out, width };
}

export const partsMarkup = (parts) => parts.map((p) => `<path d="${p.d}" fill="${p.fill}"/>`).join('');

/** Symbol + lettering on one line, `h` pixels high. */
export function lockupSvg(id, h, { mode = 'dark', mono } = {}) {
  const { parts, width } = letteringParts(id, { x: 48 + WORDMARK.gap, y: WORDMARK.baseline, cap: WORDMARK.capHeight, mode, mono });
  const w = 48 + WORDMARK.gap + width;
  const { markup } = inner(id, h, scheme(id, mode, mono));
  return svg((h * w) / 48, h, `0 0 ${n(w, 2)} 48`, markup + partsMarkup(parts), nameOf(id));
}

/** Lockup as a group for a larger drawing; returns `{ markup, width }` for a line `h` units high. */
export function placeLockup(id, x, y, h, { mode = 'dark', mono, px = h } = {}) {
  const { parts, width } = letteringParts(id, { x: 48 + WORDMARK.gap, y: WORDMARK.baseline, cap: WORDMARK.capHeight, mode, mono });
  const { markup } = inner(id, px, scheme(id, mode, mono));
  const k = h / 48;
  return { markup: `<g transform="translate(${n(x)} ${n(y)}) scale(${n(k, 5)})">${markup}${partsMarkup(parts)}</g>`, width: (48 + WORDMARK.gap + width) * k };
}

export const lockupWidth = (id, h) => ((48 + WORDMARK.gap + letteringParts(id, { y: 0, cap: WORDMARK.capHeight }).width) * h) / 48;

/** Lettering only, `h` pixels high (cap height = h / 1.5, room for the dot above and descenders below). */
export function wordmarkSvg(id, h, { mode = 'dark', mono } = {}) {
  const cap = 100;
  const { parts, width } = letteringParts(id, { x: 0, y: cap * 1.1, cap, mode, mono });
  return svg((h * width) / (cap * 1.5), h, `0 0 ${n(width, 2)} ${cap * 1.5}`, partsMarkup(parts), nameOf(id));
}

// ── rasters ────────────────────────────────────────────────────────────────────────────────

let sharpModule;
/** Render an SVG string (its width / height are the pixel size) to PNG. */
export async function png(svgText, { flatten, gray } = {}) {
  sharpModule ??= createRequire(path.join(REPO, 'apps', 'web', 'package.json'))('sharp');
  let img = sharpModule(Buffer.from(svgText));
  if (flatten) img = img.flatten({ background: flatten }).removeAlpha();
  if (gray) img = img.toColourspace('b-w');
  return img.png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

/** `{ width, height }` of a PNG buffer (IHDR). */
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Windows .ico with PNG entries: `[{ size, data }]`. */
export function ico(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((e, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(e.size >= 256 ? 0 : e.size, at);
    header.writeUInt8(e.size >= 256 ? 0 : e.size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(e.data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.data)]);
}

/** Sizes of the entries of an .ico buffer. */
export function icoSizes(buf) {
  const count = buf.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => buf.readUInt8(6 + 16 * i) || 256);
}

/** Apple .icns with PNG entries: `[{ type, data }]` (types such as ic07, ic08, ic09, ic10). */
export function icns(entries) {
  const chunks = entries.map((e) => {
    const head = Buffer.alloc(8);
    head.write(e.type, 0, 4, 'ascii');
    head.writeUInt32BE(e.data.length + 8, 4);
    return Buffer.concat([head, e.data]);
  });
  const total = 8 + chunks.reduce((sum, c) => sum + c.length, 0);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...chunks]);
}

/** Entry types of an .icns buffer. */
export function icnsTypes(buf) {
  const out = [];
  for (let at = 8; at + 8 <= buf.length; at += buf.readUInt32BE(at + 4)) out.push(buf.toString('ascii', at, at + 4));
  return out;
}
