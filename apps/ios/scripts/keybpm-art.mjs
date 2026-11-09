#!/usr/bin/env node
// MixAI Key & BPM iOS + watchOS app icons from the Android launcher vector (apps/keybpm-android
// ic_launcher_foreground.xml: accent Camelot ring + cyan beat dot, same colours as res/values/colors.xml, which mirror
// the generated design tokens). AppIcon 1024 opaque (App Store rejects alpha). Run from apps/ios:
//   node scripts/keybpm-art.mjs   (uses apps/web's sharp)
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const sharp = require('sharp');

const bg = '#07060F', a1 = '#9588FF', a2 = '#38DCF2';
const art = `
  <circle cx="54" cy="54" r="24" fill="none" stroke="${a1}" stroke-width="7"/>
  <circle cx="54" cy="54" r="8" fill="${a2}"/>
  <rect x="51" y="24" width="6" height="10" fill="${a2}"/>`;
const svg = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 108 108">
  <defs><radialGradient id="g" cx="0.3" cy="0.25" r="0.9"><stop offset="0" stop-color="#1a1636"/><stop offset="1" stop-color="${bg}"/></radialGradient></defs>
  <rect width="108" height="108" fill="url(#g)"/><g transform="translate(54,54) scale(${scale}) translate(-54,-54)">${art}</g></svg>`;

const targets = [
  { dir: '../KeyBpmApp/Assets.xcassets/', scale: 1.45, platform: 'ios' },
  { dir: '../KeyBpmWatch/Assets.xcassets/', scale: 1.6, platform: 'watchos' },
];
for (const t of targets) {
  const root = new URL(t.dir, import.meta.url);
  const icon = new URL('AppIcon.appiconset/', root);
  mkdirSync(icon, { recursive: true });
  writeFileSync(new URL('Contents.json', root), JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2) + '\n');
  await sharp(Buffer.from(svg(t.scale))).flatten({ background: bg }).removeAlpha().png()
    .toFile(decodeURIComponent(new URL('AppIcon-1024.png', icon).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
  writeFileSync(new URL('Contents.json', icon), JSON.stringify({
    images: [{ filename: 'AppIcon-1024.png', idiom: 'universal', platform: t.platform, size: '1024x1024' }],
    info: { author: 'xcode', version: 1 },
  }, null, 2) + '\n');
  console.log('icon', t.platform, 'ok');
}
