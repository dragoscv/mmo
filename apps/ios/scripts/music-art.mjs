#!/usr/bin/env node
// MixAI Music iOS art from the Android launcher vector (apps/music-android ic_launcher_foreground.xml, same colours):
// AppIcon 1024 (opaque, no alpha — App Store rejects transparency) + BrandMark (transparent note, 512).
// Run from apps/ios: node scripts/music-art.mjs  (uses apps/web's sharp).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const sharp = require('sharp');

const root = new URL('../MixAIMusic/Assets.xcassets/', import.meta.url);
const bg = '#07060F', a1 = '#9588FF', a2 = '#38DCF2';
const note = `
  <path fill="${a1}" d="M48,32 L72,28 L72,36 L52,39.3 L52,32.6 Z"/>
  <path fill="${a2}" d="M48,32.6 L52,32 L52,68 C52,74 46.6,78 41,78 C36,78 33,75.3 33,71.5 C33,66.6 38,63 43.4,63 C45.2,63 46.8,63.4 48,64 Z"/>
  <path fill="${a2}" d="M68,30 L72,29.3 L72,62 C72,68 66.6,72 61,72 C56,72 53,69.3 53,65.5 C53,60.6 58,57 63.4,57 C65.2,57 66.8,57.4 68,58 Z"/>`;
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 108 108">
  <defs><radialGradient id="g" cx="0.3" cy="0.25" r="0.9"><stop offset="0" stop-color="#1a1636"/><stop offset="1" stop-color="${bg}"/></radialGradient></defs>
  <rect width="108" height="108" fill="url(#g)"/><g transform="translate(-8,-8) scale(1.15)">${note}</g></svg>`;
const mark = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="28 24 50 58">${note}</svg>`;

const dirs = { icon: new URL('AppIcon.appiconset/', root), mark: new URL('BrandMark.imageset/', root) };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
writeFileSync(new URL('Contents.json', root), JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2) + '\n');
await sharp(Buffer.from(icon)).flatten({ background: bg }).removeAlpha().png().toFile(new URL('AppIcon-1024.png', dirs.icon).pathname.slice(1));
writeFileSync(new URL('Contents.json', dirs.icon), JSON.stringify({
  images: [{ filename: 'AppIcon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
  info: { author: 'xcode', version: 1 },
}, null, 2) + '\n');
await sharp(Buffer.from(mark)).png().toFile(new URL('BrandMark.png', dirs.mark).pathname.slice(1));
writeFileSync(new URL('Contents.json', dirs.mark), JSON.stringify({
  images: [{ filename: 'BrandMark.png', idiom: 'universal' }],
  info: { author: 'xcode', version: 1 },
}, null, 2) + '\n');
for (const f of [new URL('AppIcon-1024.png', dirs.icon), new URL('BrandMark.png', dirs.mark)]) {
  const m = await sharp(f.pathname.slice(1)).metadata();
  console.log(f.pathname.split('/').slice(-2).join('/'), m.width, m.height, 'alpha=' + m.hasAlpha);
}
