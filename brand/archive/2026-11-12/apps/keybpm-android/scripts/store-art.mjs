#!/usr/bin/env node
// Play store graphics for MixAI Key & BPM from the launcher vector (Camelot ring + beat dot, token colours):
// icon 512x512 (opaque PNG) and feature graphic 1024x500. Output: apps/keybpm-android/store/graphics/.
// Run from the repo root: node apps/keybpm-android/scripts/store-art.mjs  (uses apps/web's sharp).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const sharp = require('sharp');

const out = new URL('../store/graphics/', import.meta.url);
mkdirSync(out, { recursive: true });
const p = (n) => decodeURIComponent(new URL(n, out).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const bg = '#07060F', a1 = '#9588FF', a2 = '#38DCF2';
const mark = (cx, cy, s) => `
  <circle cx="${cx}" cy="${cy}" r="${24 * s}" fill="none" stroke="${a1}" stroke-width="${7 * s}"/>
  <circle cx="${cx}" cy="${cy}" r="${8 * s}" fill="${a2}"/>
  <rect x="${cx - 3 * s}" y="${cy - 30 * s}" width="${6 * s}" height="${10 * s}" fill="${a2}"/>`;
const grad = `<defs><radialGradient id="g" cx="0.3" cy="0.25" r="0.9"><stop offset="0" stop-color="#1a1636"/><stop offset="1" stop-color="${bg}"/></radialGradient></defs>`;

const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">${grad}<rect width="512" height="512" fill="url(#g)"/>${mark(256, 256, 7)}</svg>`;
await sharp(Buffer.from(icon)).flatten({ background: bg }).removeAlpha().png().toFile(p('icon-512.png'));

// Camelot ring segments as a decorative wheel on the right; title text on the left.
const hues = [180, 150, 120, 90, 60, 30, 0, 330, 300, 270, 240, 210];
let wheel = '';
for (let n = 1; n <= 12; n++) {
  const mid = (n * 30 - 90) * Math.PI / 180, a0 = mid - 0.22, a1r = mid + 0.22, r = 170, cx = 820, cy = 250;
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1r), y1 = cy + r * Math.sin(a1r);
  wheel += `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 0,1 ${x1.toFixed(1)},${y1.toFixed(1)}" stroke="hsl(${hues[n - 1]},70%,62%)" stroke-width="44" fill="none" opacity="${n === 8 ? 1 : 0.45}"/>`;
}
const feature = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500">${grad}<rect width="1024" height="500" fill="url(#g)"/>
  ${wheel}
  <text x="820" y="236" text-anchor="middle" font-family="Segoe UI, Arial" font-weight="800" font-size="72" fill="#F4F3FA">8A</text>
  <text x="820" y="296" text-anchor="middle" font-family="Segoe UI, Arial" font-weight="600" font-size="38" fill="#F4F3FA" opacity="0.8">124 BPM</text>
  <text x="64" y="210" font-family="Segoe UI, Arial" font-weight="800" font-size="64" fill="#F4F3FA">MixAI Key &amp; BPM</text>
  <text x="64" y="270" font-family="Segoe UI, Arial" font-weight="500" font-size="32" fill="#F4F3FA" opacity="0.8">Live key, tempo &amp; Song ID</text>
  <text x="64" y="320" font-family="Segoe UI, Arial" font-weight="500" font-size="26" fill="${a2}">On-device. Free. No ads.</text></svg>`;
await sharp(Buffer.from(feature)).flatten({ background: bg }).removeAlpha().png().toFile(p('feature-1024x500.png'));
console.log('store art ok');
