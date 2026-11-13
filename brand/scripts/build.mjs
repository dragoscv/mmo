#!/usr/bin/env node
// MixAI brand generator (WP22-07): ONE script writes every brand export of every surface from
// brand/src/marks.mjs, brand/src/motion.mjs, brand/src/lettering.json and the design tokens.
//
//   node brand/scripts/build.mjs                 write every output that changed
//   node brand/scripts/build.mjs --only dist,web write selected groups (see GROUPS below)
//   node brand/scripts/build.mjs --check         drift gate: exit 1 when a committed output differs
//   node brand/scripts/build.mjs --list          print every output path and its group
//
// Text outputs (SVG, XML, CSS, Swift, JSON) are compared byte for byte. Rasters (PNG, ICO, ICNS) are compared
// through brand/dist/manifest.json: the hash of the SVG source that produced each file plus the hash of the
// file itself, so the gate does not depend on the rasteriser of the machine that runs it, yet catches both a
// stale export (source changed) and a hand-edited one (file changed).
//
// Regions: a hand-written HTML file can host generated markup between `<!-- brand:<name>:start -->` and
// `<!-- brand:<name>:end -->`. The generator owns only what is between the markers.
//
// Needs `pnpm tokens:build` to have run (reads packages/design-tokens/dist/tokens.json) and apps/web's sharp.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GLYPHS, IDS } from '../src/marks.mjs';
import { LOGO_MOTION } from '../src/motion.mjs';
import { SONIC } from '../src/sonic.mjs';
import * as A from './lib/android.mjs';
import { constructionSvg, motionDemoHtml } from './lib/demo.mjs';
import * as D from './lib/draw.mjs';
import { kotlinBrand } from './lib/kotlin.mjs';
import * as MO from './lib/motion.mjs';
import { renderWav } from './lib/sonic.mjs';
import { swiftBrand } from './lib/swift.mjs';
import { bootStyle, inlineLogo, inlineWordmark, uiData } from './lib/web.mjs';

const { REPO, C, PRODUCTS, n } = D;
void n;
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const LIST = args.includes('--list');
const onlyArg = args.find((a) => a.startsWith('--only'));
const ONLY = onlyArg ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1]).split(',') : null;
const MANIFEST = 'brand/dist/manifest.json';

/** @type {Array<{ group: string, path: string, text?: string, region?: string, render?: () => Promise<Buffer>, source?: string }>} */
const outputs = [];
const text = (group, p, content) => outputs.push({ group, path: p, text: content.replace(/\r\n/g, '\n') });
/** Generated markup inside a hand-written file, between the `brand:<name>` markers. */
const region = (group, p, name, content) => outputs.push({ group, path: p, region: name, text: content });
/** Raster from one SVG (its width/height = pixel size). */
const raster = (group, p, svgText, opts = {}) => outputs.push({ group, path: p, source: svgText + JSON.stringify(opts), render: () => D.png(svgText, opts) });
/** Composite raster (ICO / ICNS) from several SVGs. */
const composite = (group, p, parts, build) =>
  outputs.push({ group, path: p, source: parts.map((x) => x.svg).join('\n'), render: async () => build(await Promise.all(parts.map(async (x) => ({ ...x, data: await D.png(x.svg) })))) });
/** Any other binary output: `source` describes its inputs, `render` produces the bytes. */
const binary = (group, p, source, render) => outputs.push({ group, path: p, source, render: async () => render() });
const json = (v) => JSON.stringify(v, null, 2) + '\n';

// ── brand/dist: masters, lockups, motion, construction ─────────────────────────────────────
for (const id of IDS) {
  const name = D.nameOf(id);
  text('dist', `brand/dist/logo/${id}/symbol.svg`, D.symbolSvg(id, 512, { title: name }));
  text('dist', `brand/dist/logo/${id}/symbol-light.svg`, D.symbolSvg(id, 512, { mode: 'light', title: name }));
  text('dist', `brand/dist/logo/${id}/symbol-small.svg`, D.symbolSvg(id, 32, { title: name }));
  text('dist', `brand/dist/logo/${id}/symbol-micro.svg`, D.symbolSvg(id, 16, { title: name }));
  text('dist', `brand/dist/logo/${id}/symbol-mono.svg`, D.symbolSvg(id, 512, { mono: '#000000', title: name }));
  text('dist', `brand/dist/logo/${id}/tile.svg`, D.tileSvg(id, 512, { title: name }));
  text('dist', `brand/dist/logo/${id}/lockup.svg`, D.lockupSvg(id, 96));
  text('dist', `brand/dist/logo/${id}/lockup-light.svg`, D.lockupSvg(id, 96, { mode: 'light' }));
  text('dist', `brand/dist/logo/${id}/lockup-mono.svg`, D.lockupSvg(id, 96, { mono: '#000000' }));
  text('dist', `brand/dist/logo/${id}/wordmark.svg`, D.wordmarkSvg(id, 96));
  text('dist', `brand/dist/logo/${id}/wordmark-light.svg`, D.wordmarkSvg(id, 96, { mode: 'light' }));
  raster('dist', `brand/dist/png/${id}-tile-1024.png`, D.tileSvg(id, 1024, { shape: 'square' }));
  raster('dist', `brand/dist/png/${id}-symbol-512.png`, D.symbolSvg(id, 512));
  for (const anim of ['intro', 'loading', 'success', 'error']) text('dist', `brand/dist/motion/${id}-${anim}.svg`, MO.animatedSvg(id, anim, 256));
}
text('dist', 'brand/dist/motion/logo.css', MO.logoCss());
text('dist', 'brand/dist/motion/demo.html', motionDemoHtml());
text('dist', 'brand/dist/logo/construction.svg', constructionSvg());
for (const key of Object.keys(SONIC.variants)) {
  const { variants, ...common } = SONIC;
  binary('dist', `brand/dist/sound/signature-${key}.wav`, JSON.stringify({ common, variant: variants[key] }), () => renderWav(key));
}
// The chosen signature, shipped to the TV apps (played once at start, with a setting to turn it off).
{
  const { variants, ...common } = SONIC;
  const source = JSON.stringify({ common, variant: variants[SONIC.chosen] });
  binary('dist', 'brand/dist/sound/signature.wav', source, () => renderWav(SONIC.chosen));
  binary('android', 'apps/tv-android/app/src/main/res/raw/brand_signature.wav', source, () => renderWav(SONIC.chosen));
  binary('tv', 'apps/tv-tizen/public/brand-signature.wav', source, () => renderWav(SONIC.chosen));
  binary('apple', 'apps/ios/MixAITV/Resources/brand-signature.wav', source, () => renderWav(SONIC.chosen));
}
text(
  'dist',
  'brand/dist/tokens.json',
  json({
    $comment: 'GENERATED by brand/scripts/build.mjs. Colours come from packages/design-tokens (single source).',
    mark: C,
    products: Object.fromEntries(Object.entries(PRODUCTS).map(([id, p]) => [id, { name: p.name, short: p.short, ...p.hex }])),
    motion: LOGO_MOTION,
  }),
);

// ── contrast pairs: every shipped pairing of a brand colour with a surface (input of contrast-gate.mjs) ──
{
  const lch = (c) => `oklch(${c.l} ${c.c} ${c.h})`;
  const pairs = [];
  const add = (name, fg, bg, use) => pairs.push({ name, fg, bg, use });
  for (const mode of ['dark', 'light']) {
    const R = D.ROLES[mode];
    const signal = lch(R.foreground);
    // surfaces a mark sits on in this theme; the tile and the splash canvas are dark in both themes
    const surfaces = [['background', lch(R.background)], ['card', lch(R.card)]];
    for (const [id, p] of Object.entries(PRODUCTS)) {
      for (const [surface, bg] of surfaces) {
        add(`${id} ${mode}: glyph on ${surface}`, lch(p[mode]), bg, 'ui');
        add(`${id} ${mode}: product colour as text on ${surface}`, lch(p[mode]), bg, 'body');
      }
      if (mode === 'dark') {
        add(`${id}: glyph on the icon tile`, lch(p.dark), C.tile, 'ui');
        add(`${id}: glyph on the splash canvas`, lch(p.dark), C.canvas, 'ui');
      }
    }
    for (const [surface, bg] of surfaces) add(`${mode}: signal and lettering on ${surface}`, signal, bg, 'body');
  }
  add('signal on the icon tile', C.signal.dark, C.tile, 'ui');
  add('signal on the splash canvas', C.signal.dark, C.canvas, 'ui');
  add('light boot screen: signal on the light canvas', C.signal.light, C.canvasLight, 'ui');
  text(
    'dist',
    'brand/contrast-pairs.json',
    json({
      $description: 'GENERATED by brand/scripts/build.mjs from packages/design-tokens. Input for brand/scripts/contrast-gate.mjs. use: body (4.5) | large (3) | ui (3).',
      pairs,
    }),
  );
}

// ── web (apps/web/public) ──────────────────────────────────────────────────────────────────
const WEB = 'apps/web/public';
/** Maskable icon: full-bleed tile, symbol inside the 40 % safe circle. */
const maskable = (id, px) => D.tileSvg(id, px, { shape: 'square', scale: 0.62 });
const favicon = (id) => {
  // SVG favicon with a light/dark switch (Chromium, Firefox; Safari uses apple-touch-icon)
  const { grid, markup: dark } = D.inner(id, 16, D.scheme(id, 'dark'));
  const light = D.inner(id, 16, D.scheme(id, 'light')).markup;
  return D.svg(16, 16, `0 0 ${grid} ${grid}`, `<style>.l{display:none}@media (prefers-color-scheme: light){.d{display:none}.l{display:inline}}</style><g class="d">${dark}</g><g class="l">${light}</g>`, D.nameOf(id));
};
const ogImage = (id) => {
  const lock = D.placeLockup(id, 0, 0, 120);
  const x = (1200 - lock.width) / 2;
  const glow = id === 'mark' ? C.streamA.dark : PRODUCTS[id].hex.dark;
  return D.svg(
    1200,
    630,
    '0 0 1200 630',
    `<defs><radialGradient id="g" cx="0.5" cy="0.42" r="0.7"><stop offset="0" stop-color="${glow}" stop-opacity="0.22"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient></defs>` +
      `<rect width="1200" height="630" fill="${C.canvas}"/><rect width="1200" height="630" fill="url(#g)"/>` +
      D.placeLockup(id, x, 255, 120).markup,
  );
};
for (const id of IDS) {
  const suffix = id === 'mark' ? '' : `-${id}`;
  raster('web', `${WEB}/icon${suffix}-192.png`, D.tileSvg(id, 192));
  raster('web', `${WEB}/icon${suffix}-512.png`, D.tileSvg(id, 512));
  raster('web', `${WEB}/icon${suffix}-maskable-512.png`, maskable(id, 512));
  raster('web', `${WEB}/apple-touch-icon${suffix}.png`, D.tileSvg(id, 180, { shape: 'square' }), { flatten: C.tile });
  text('web', `${WEB}/icon${suffix}.svg`, favicon(id));
  raster('web', `${WEB}/og-image${suffix}.png`, ogImage(id));
}
raster('web', `${WEB}/favicon-32.png`, D.tileSvg('mark', 32));
composite('web', `${WEB}/favicon.ico`, [16, 32, 48].map((s) => ({ size: s, svg: D.tileSvg('mark', s) })), D.ico);
text('web', `${WEB}/logo.svg`, D.tileSvg('mark', 512, { title: 'MixAI' }));
text('web', `${WEB}/wordmark.svg`, D.lockupSvg('mark', 96, { mode: 'light' }));
text('web', `${WEB}/wordmark-dark.svg`, D.lockupSvg('mark', 96));
text('web', `${WEB}/og-image.svg`, ogImage('mark'));

// ── @mmo/ui: data for <BrandMark> / <BrandLockup> + the logo motion CSS ──────────────────────
text('ui', 'packages/ui/src/brand/generated/marks.ts', uiData());
text('ui', 'packages/ui/src/brand/generated/logo.css', MO.logoCss());

// ── plain HTML boot screens: regions `style` (in <head>), `logo` and `wordmark` in hand-written pages ──
// `tokens`: the page loads tokens.css before the mark (theme-aware); otherwise the style region carries its colours.
const SPLASH = [
  { page: 'server/ui/index.html', id: 'server', group: 'server', tokens: true, px: 96, anim: 'loading', wordmark: 36 },
  { page: 'apps/native/web/index.html', id: 'studio', group: 'desktop', tokens: true, px: 72, anim: 'loading', wordmark: 33 },
  { page: 'apps/music-desktop/web/index.html', id: 'music', group: 'desktop', tokens: true, px: 72, anim: 'loading', wordmark: 33 },
  { page: 'apps/tv-tizen/index.html', id: 'tv', group: 'tv', px: 160, anim: 'intro' },
  { page: 'apps/tv-desktop/index.html', id: 'tv', group: 'tv', px: 128, anim: 'intro' },
  { page: 'apps/mixai/index.html', id: 'decks', group: 'desktop', px: 96, anim: 'intro' },
  { page: 'apps/live/desktop/index.html', id: 'live', group: 'desktop', px: 96, anim: 'intro' },
];
for (const s of SPLASH) {
  region(s.group, s.page, 'style', bootStyle(s.id, { selfContained: !s.tokens }));
  region(s.group, s.page, 'logo', inlineLogo(s.id, s.px, `data-anim="${s.anim}"`));
  if (s.wordmark) region(s.group, s.page, 'wordmark', inlineWordmark(s.id, s.wordmark));
}

// ── Android ────────────────────────────────────────────────────────────────────────────────
const ANDROID = [
  { dir: 'apps/tv-android/app', id: 'tv', banner: true },
  { dir: 'apps/phone-android/app', id: 'tv', round: true, splash: true, stat: 'ic_stat_mixai' },
  { dir: 'apps/music-android/app', id: 'music', banner: true, splash: true, stat: 'ic_stat_mixai' },
  { dir: 'apps/music-android/wear', id: 'music' },
  { dir: 'apps/keybpm-android/app', id: 'keybpm', splash: true, stat: 'ic_stat_listen' },
  { dir: 'apps/keybpm-android/wear', id: 'keybpm', stat: 'ic_stat_listen' },
  { dir: 'apps/live-android/app', id: 'live' },
  { dir: 'apps/live-android/wear', id: 'live' },
  { dir: 'apps/decks-android/app', id: 'decks' },
];
for (const m of ANDROID) {
  const res = `${m.dir}/src/main/res`;
  text('android', `${res}/drawable/ic_launcher_foreground.xml`, A.launcherForeground(m.id));
  text('android', `${res}/drawable/ic_launcher_monochrome.xml`, A.launcherMonochrome(m.id));
  text('android', `${res}/mipmap-anydpi-v26/ic_launcher.xml`, A.adaptiveIcon());
  if (m.round) text('android', `${res}/mipmap-anydpi-v26/ic_launcher_round.xml`, A.adaptiveIcon());
  text('android', `${res}/values/brand.xml`, A.brandColors(m.id));
  if (m.banner) text('android', `${res}/drawable/banner.xml`, A.tvBanner(m.id));
  if (m.splash) text('android', `${res}/drawable/avd_brand_intro.xml`, A.animatedVector(m.id, 'intro'));
  if (m.stat) text('android', `${res}/drawable/${m.stat}.xml`, A.statusIcon(m.id));
}
// Capacitor shell (MixAI Studio): API 24-25 need PNG mipmaps next to the adaptive XML.
{
  const res = 'apps/native/android/app/src/main/res';
  text('android', `${res}/drawable-v24/ic_launcher_foreground.xml`, A.launcherForeground('studio'));
  text('android', `${res}/drawable/ic_launcher_monochrome.xml`, A.launcherMonochrome('studio'));
  text('android', `${res}/values/brand.xml`, A.brandColors('studio'));
  const adaptive = A.adaptiveIcon({ foreground: '@drawable/ic_launcher_foreground' });
  text('android', `${res}/mipmap-anydpi-v26/ic_launcher.xml`, adaptive);
  text('android', `${res}/mipmap-anydpi-v26/ic_launcher_round.xml`, adaptive);
  text('android', `${res}/drawable/banner.xml`, A.tvBanner('studio'));
  for (const [dpi, px] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
    raster('android', `${res}/mipmap-${dpi}/ic_launcher.png`, D.tileSvg('studio', px));
    raster('android', `${res}/mipmap-${dpi}/ic_launcher_round.png`, D.tileSvg('studio', px, { shape: 'circle' }));
  }
  // Capacitor launch images: the static mark, centred, on the canvas colour
  const splash = (w, h) => {
    const side = Math.min(w, h) * 0.24;
    return D.svg(w, h, `0 0 ${w} ${h}`, `<rect width="${w}" height="${h}" fill="${C.canvas}"/>` + D.place('studio', (w - side) / 2, (h - side) / 2, side));
  };
  raster('android', `${res}/drawable/splash.png`, splash(480, 320), { flatten: C.canvas });
  for (const [dpi, long, short] of [['mdpi', 480, 320], ['hdpi', 800, 480], ['xhdpi', 1280, 720], ['xxhdpi', 1600, 960], ['xxxhdpi', 1920, 1280]]) {
    raster('android', `${res}/drawable-land-${dpi}/splash.png`, splash(long, short), { flatten: C.canvas });
    raster('android', `${res}/drawable-port-${dpi}/splash.png`, splash(short, long), { flatten: C.canvas });
  }
}
// Compose: the mark as vectors with its animations (next to the generated Tokens.kt of each module family).
text('android', 'apps/tv-android/app/src/main/java/ro/mixai/tv/ui/theme/Brand.kt', kotlinBrand('ro.mixai.tv.ui.theme', false));
text('android', 'apps/mobile-android-common/src/main/java/ro/mixai/mobile/theme/Brand.kt', kotlinBrand('ro.mixai.mobile.theme', true));

// ── Apple (apps/ios) ───────────────────────────────────────────────────────────────────────
const appIconSet = (dir, id, platform) => {
  if (platform === 'ios') {
    raster('apple', `${dir}/AppIcon-1024.png`, D.tileSvg(id, 1024, { shape: 'square' }), { flatten: C.tile });
    raster('apple', `${dir}/AppIcon-1024-dark.png`, D.tileSvg(id, 1024, { shape: 'square', bg: null }));
    raster('apple', `${dir}/AppIcon-1024-tinted.png`, D.tileSvg(id, 1024, { shape: 'square', bg: '#000000', mono: '#ffffff' }), { flatten: '#000000', gray: true });
    const variant = (file, value) => ({ ...(value ? { appearances: [{ appearance: 'luminosity', value }] } : {}), filename: file, idiom: 'universal', platform: 'ios', size: '1024x1024' });
    text('apple', `${dir}/Contents.json`, json({ images: [variant('AppIcon-1024.png'), variant('AppIcon-1024-dark.png', 'dark'), variant('AppIcon-1024-tinted.png', 'tinted')], info: { author: 'xcode', version: 1 } }));
  } else if (platform === 'watchos') {
    // watchOS: circular mask, no black background (HIG) -> the tile colour fills the square
    raster('apple', `${dir}/AppIcon-1024.png`, D.tileSvg(id, 1024, { shape: 'square', scale: 0.7 }), { flatten: C.tile });
    text('apple', `${dir}/Contents.json`, json({ images: [{ filename: 'AppIcon-1024.png', idiom: 'universal', platform: 'watchos', size: '1024x1024' }], info: { author: 'xcode', version: 1 } }));
  } else {
    // macOS: one PNG per size with the system shape drawn in
    const images = [];
    for (const pt of [16, 32, 128, 256, 512])
      for (const scale of [1, 2]) {
        const px = pt * scale;
        const file = `AppIcon-${pt}@${scale}x.png`;
        raster('apple', `${dir}/${file}`, D.macIconSvg(id, px));
        images.push({ filename: file, idiom: 'mac', scale: `${scale}x`, size: `${pt}x${pt}` });
      }
    text('apple', `${dir}/Contents.json`, json({ images, info: { author: 'xcode', version: 1 } }));
  }
};
const catalogRoot = (dir) => text('apple', `${dir}/Contents.json`, json({ info: { author: 'xcode', version: 1 } }));
// In-app marks are drawn by `BrandMarkView` (Brand.swift): no image set for the mark.
const APPLE = [
  { catalog: 'apps/ios/MixAI/Assets.xcassets', id: 'tv', platform: 'ios' },
  { catalog: 'apps/ios/MixAIWatch/Assets.xcassets', id: 'tv', platform: 'watchos' },
  { catalog: 'apps/ios/MixAIMusic/Assets.xcassets', id: 'music', platform: 'ios' },
  { catalog: 'apps/ios/KeyBpmApp/Assets.xcassets', id: 'keybpm', platform: 'ios' },
  { catalog: 'apps/ios/KeyBpmWatch/Assets.xcassets', id: 'keybpm', platform: 'watchos' },
  { catalog: 'apps/ios/DecksApp/Assets.xcassets', id: 'decks', platform: 'ios', iconSet: 'AppIcon.appiconset' },
  { catalog: 'apps/ios/DecksApp/Assets.xcassets', id: 'decks', platform: 'macos', iconSet: 'AppIconMac.appiconset', noRoot: true },
  { catalog: 'apps/ios/LiveApp/Assets.xcassets', id: 'live', platform: 'ios' },
  { catalog: 'apps/ios/LiveWatch/Assets.xcassets', id: 'live', platform: 'watchos' },
];
for (const a of APPLE) {
  if (!a.noRoot) catalogRoot(a.catalog);
  appIconSet(`${a.catalog}/${a.iconSet ?? 'AppIcon.appiconset'}`, a.id, a.platform);
}
// tvOS: layered icon (back = tile, front = glyph) + Top Shelf
{
  const cat = 'apps/ios/MixAITV/Assets.xcassets';
  const ba = `${cat}/App Icon & Top Shelf Image.brandassets`;
  catalogRoot(cat);
  const layerSvg = (w, h, front) => {
    const side = h * 0.62;
    return D.svg(w, h, `0 0 ${w} ${h}`, front ? D.place('tv', (w - side) / 2, (h - side) / 2, side) : `<rect width="${w}" height="${h}" fill="${C.tile}"/>`);
  };
  for (const [stack, sizes] of [['App Icon', [[400, 240, '1x'], [800, 480, '2x']]], ['App Icon - App Store', [[1280, 768, '1x']]]]) {
    for (const layer of ['Front', 'Back']) {
      const images = sizes.map(([w, h, scale]) => {
        const file = `${layer.toLowerCase()}-${w}x${h}.png`;
        raster('apple', `${ba}/${stack}.imagestack/${layer}.imagestacklayer/Content.imageset/${file}`, layerSvg(w, h, layer === 'Front'), layer === 'Back' ? { flatten: C.tile } : {});
        return { idiom: 'tv', scale, filename: file };
      });
      text('apple', `${ba}/${stack}.imagestack/${layer}.imagestacklayer/Content.imageset/Contents.json`, json({ info: { author: 'xcode', version: 1 }, images }));
      text('apple', `${ba}/${stack}.imagestack/${layer}.imagestacklayer/Contents.json`, json({ info: { author: 'xcode', version: 1 } }));
    }
    text('apple', `${ba}/${stack}.imagestack/Contents.json`, json({ info: { author: 'xcode', version: 1 }, layers: [{ filename: 'Front.imagestacklayer' }, { filename: 'Back.imagestacklayer' }] }));
  }
  const shelf = (w, h) => {
    const lockH = h * 0.2;
    const lock = D.placeLockup('tv', 0, 0, lockH);
    return D.svg(w, h, `0 0 ${w} ${h}`, `<rect width="${w}" height="${h}" fill="${C.canvas}"/>` + D.placeLockup('tv', (w - lock.width) / 2, (h - lockH) / 2, lockH).markup);
  };
  for (const [set, sizes] of [['Top Shelf Image', [[1920, 720, '1x'], [3840, 1440, '2x']]], ['Top Shelf Image Wide', [[2320, 720, '1x'], [4640, 1440, '2x']]]]) {
    const images = sizes.map(([w, h, scale]) => {
      const file = `shelf-${w}x${h}.png`;
      raster('apple', `${ba}/${set}.imageset/${file}`, shelf(w, h), { flatten: C.canvas });
      return { idiom: 'tv', scale, filename: file };
    });
    text('apple', `${ba}/${set}.imageset/Contents.json`, json({ info: { author: 'xcode', version: 1 }, images }));
  }
}
text('apple', 'apps/ios/MixaiCore/Sources/MixaiCore/Theme/Brand.swift', swiftBrand());

// ── desktop (Tauri, MSIX, Compose desktop) ─────────────────────────────────────────────────
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const icoOf = (id) => ICO_SIZES.map((s) => ({ size: s, svg: D.tileSvg(id, s) }));
const icnsOf = (id) => [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]].map(([type, px]) => ({ type, svg: D.macIconSvg(id, px) }));
const TAURI = [
  { dir: 'apps/mixai/src-tauri/icons', id: 'decks' },
  { dir: 'apps/native/src-tauri/icons', id: 'studio' },
  { dir: 'apps/music-desktop/src-tauri/icons', id: 'music' },
  { dir: 'apps/tv-desktop/src-tauri/icons', id: 'tv' },
  { dir: 'apps/live/desktop/src-tauri/icons', id: 'live' },
];
for (const t of TAURI) {
  raster('desktop', `${t.dir}/32x32.png`, D.tileSvg(t.id, 32));
  raster('desktop', `${t.dir}/128x128.png`, D.tileSvg(t.id, 128));
  raster('desktop', `${t.dir}/128x128@2x.png`, D.tileSvg(t.id, 256));
  raster('desktop', `${t.dir}/icon.png`, D.tileSvg(t.id, 512));
  composite('desktop', `${t.dir}/icon.ico`, icoOf(t.id), D.ico);
  composite('desktop', `${t.dir}/icon.icns`, icnsOf(t.id), D.icns);
  // MSIX (scripts/package-msix.ps1 copies these four into Assets/)
  raster('desktop', `${t.dir}/StoreLogo.png`, D.tileSvg(t.id, 50));
  raster('desktop', `${t.dir}/Square44x44Logo.png`, D.tileSvg(t.id, 44));
  raster('desktop', `${t.dir}/Square150x150Logo.png`, D.tileSvg(t.id, 150, { scale: 0.6 }));
  raster('desktop', `${t.dir}/Square310x310Logo.png`, D.tileSvg(t.id, 310, { scale: 0.6 }));
}
composite('desktop', 'apps/decks-desktop/icons/icon.ico', icoOf('decks'), D.ico);
composite('desktop', 'apps/decks-desktop/icons/icon.icns', icnsOf('decks'), D.icns);
raster('desktop', 'apps/decks-desktop/icons/icon.png', D.tileSvg('decks', 512));

// ── TV web (Tizen + webOS), extension, server ──────────────────────────────────────────────
raster('tv', 'apps/tv-tizen/icon.png', D.tileSvg('tv', 512, { shape: 'square' }), { flatten: C.tile });
raster('tv', 'apps/tv-tizen/webos/largeIcon.png', D.tileSvg('tv', 130, { shape: 'square' }), { flatten: C.tile });
raster('tv', 'apps/tv-tizen/webos/icon.png', D.tileSvg('tv', 80, { shape: 'square' }), { flatten: C.tile });
for (const s of [16, 32, 48, 128]) {
  text('extension', `apps/extension/icons/icon${s}.svg`, D.tileSvg('connector', s, { title: 'MixAI Connector' }));
  raster('extension', `apps/extension/icons/icon${s}.png`, D.tileSvg('connector', s));
}
text('server', 'server/assets/icon.svg', D.tileSvg('server', 512, { title: 'MixAI Server' }));
raster('server', 'server/assets/icon.png', D.tileSvg('server', 1024));
// Tray: Windows / Linux take the tile (visible on light and dark taskbars); Electron picks @2x by scale factor.
raster('server', 'server/assets/tray.png', D.tileSvg('server', 16));
raster('server', 'server/assets/tray@2x.png', D.tileSvg('server', 32));
// macOS menu bar: template image (black + alpha, the system tints it).
raster('server', 'server/assets/trayTemplate.png', D.symbolSvg('server', 16, { mono: '#000000' }));
raster('server', 'server/assets/trayTemplate@2x.png', D.symbolSvg('server', 32, { mono: '#000000' }));

// ── store graphics (Play 512 icon + 1024x500 feature graphic per product) ──────────────────
const feature = (id) => {
  const lock = D.placeLockup(id, 0, 0, 104);
  return D.svg(1024, 500, '0 0 1024 500', `<rect width="1024" height="500" fill="${C.canvas}"/>` + D.placeLockup(id, (1024 - lock.width) / 2, 198, 104).markup);
};
for (const id of Object.keys(GLYPHS)) {
  raster('store', `brand/dist/store/${id}/icon-512.png`, D.tileSvg(id, 512, { shape: 'square' }), { flatten: C.tile });
  raster('store', `brand/dist/store/${id}/feature-1024x500.png`, feature(id), { flatten: C.canvas });
}
// The same graphics next to each store listing (committed under the app's store/graphics; uploads are a
// separate, owner-approved step). `banner` centres the lockup and never lets it pass 80 % of the width.
const banner = (id, w, h) => {
  const lockH = Math.min(h * 0.21, (w * 0.8) / D.lockupWidth(id, 1));
  return D.svg(w, h, `0 0 ${w} ${h}`, `<rect width="${w}" height="${h}" fill="${C.canvas}"/>` + D.placeLockup(id, (w - D.lockupWidth(id, lockH)) / 2, (h - lockH) / 2, lockH).markup);
};
const storeIcon = (dir, id, px) => raster('store', `${dir}/icon-${px}.png`, D.tileSvg(id, px, { shape: 'square' }), { flatten: C.tile });
const storeBanner = (dir, id, name, w, h) => raster('store', `${dir}/${name}-${w}x${h}.png`, banner(id, w, h), { flatten: C.canvas });
// Google Play: 512 icon + 1024x500 feature graphic (+ 1280x720 TV banner in the listing that carries the TV app, D72)
for (const [app, id] of [['phone-android', 'tv'], ['music-android', 'music'], ['keybpm-android', 'keybpm'], ['live-android', 'live'], ['decks-android', 'decks']]) {
  const dir = `apps/${app}/store/graphics`;
  storeIcon(dir, id, 512);
  raster('store', `${dir}/feature-1024x500.png`, feature(id), { flatten: C.canvas });
}
storeBanner('apps/phone-android/store/graphics', 'tv', 'tv-banner', 1280, 720);
// Microsoft Store: 300 logo + 1920x1080 hero
for (const [app, id] of [['tv-desktop', 'tv'], ['music-desktop', 'music'], ['native', 'studio'], ['mixai', 'decks']]) {
  const dir = `apps/${app}/store/graphics`;
  storeIcon(dir, id, 300);
  storeBanner(dir, id, 'hero', 1920, 1080);
}
// Chrome Web Store / AMO / Edge: 128 icon, 440x280 small promo tile, 1400x560 marquee
storeIcon('apps/extension/store/graphics', 'connector', 128);
storeBanner('apps/extension/store/graphics', 'connector', 'promo', 440, 280);
storeBanner('apps/extension/store/graphics', 'connector', 'marquee', 1400, 560);

// ── run ────────────────────────────────────────────────────────────────────────────────────
const selected = outputs.filter((o) => !ONLY || ONLY.includes(o.group));
const seen = new Set();
for (const o of outputs) {
  const key = o.region ? `${o.path}#${o.region}` : o.path;
  if (seen.has(key)) throw new Error(`two outputs write ${key}`);
  seen.add(key);
}
if (LIST) {
  for (const o of selected) console.log(`${o.group.padEnd(9)} ${o.path}${o.region ? `  (region ${o.region})` : ''}`);
  process.exit(0);
}

const abs = (p) => path.join(REPO, ...p.split('/'));
const manifest = existsSync(abs(MANIFEST)) ? JSON.parse(readFileSync(abs(MANIFEST), 'utf8')) : { rasters: {} };
const drift = [];
const missingMarkers = [];
let written = 0;
let unchanged = 0;
for (const o of selected) {
  const file = abs(o.path);
  const exists = existsSync(file);
  if (o.region) {
    const start = `<!-- brand:${o.region}:start -->`;
    const end = `<!-- brand:${o.region}:end -->`;
    // Line endings are the page's own business (autocrlf checkouts, editors): compare and write in LF terms,
    // then give the page back the style it had.
    const raw = exists ? readFileSync(file, 'utf8') : '';
    const crlf = raw.includes('\r\n');
    const html = raw.replace(/\r\n/g, '\n');
    const a = html.indexOf(start);
    const b = html.indexOf(end);
    if (a < 0 || b < a) {
      missingMarkers.push(`${o.path}: add ${start}${end} where the ${o.region} goes`);
      continue;
    }
    const next = html.slice(0, a + start.length) + o.text + html.slice(b);
    if (next === html) unchanged++;
    else if (CHECK) drift.push(`differs  ${o.path} (region ${o.region})`);
    else {
      writeFileSync(file, crlf ? next.replace(/\n/g, '\r\n') : next);
      written++;
    }
    continue;
  }
  if (o.text !== undefined) {
    const same = exists && readFileSync(file, 'utf8').replace(/\r\n/g, '\n') === o.text;
    if (same) unchanged++;
    else if (CHECK) drift.push(`${exists ? 'differs' : 'missing'}  ${o.path}`);
    else {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, o.text);
      written++;
    }
    continue;
  }
  const source = D.sha256(o.source);
  const entry = manifest.rasters[o.path];
  const fileHash = exists ? D.sha256(readFileSync(file)) : null;
  const fresh = entry && entry.source === source && entry.file === fileHash;
  if (fresh) {
    unchanged++;
    continue;
  }
  if (CHECK) {
    drift.push(`${!exists ? 'missing' : entry?.source !== source ? 'stale  ' : 'edited '}  ${o.path}`);
    continue;
  }
  const data = await o.render();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  manifest.rasters[o.path] = { source, file: D.sha256(data) };
  written++;
}

if (CHECK) {
  for (const m of missingMarkers) drift.push(`markers  ${m}`);
  if (drift.length) {
    console.error(`brand drift: ${drift.length} of ${selected.length} outputs differ from brand/src:\n  ${drift.join('\n  ')}`);
    console.error('\nFix: node brand/scripts/build.mjs, then stage the outputs it wrote.');
    process.exit(1);
  }
  console.log(`brand drift: OK (${selected.length} outputs match brand/src)`);
} else {
  // keep entries of groups not run this time; drop entries of outputs that no longer exist
  const known = new Set(outputs.map((o) => o.path));
  manifest.rasters = Object.fromEntries(Object.entries(manifest.rasters).filter(([p]) => known.has(p)).sort(([a], [b]) => a.localeCompare(b)));
  manifest.$comment = 'GENERATED by brand/scripts/build.mjs: sha256 of the SVG source and of the file of every raster output (drift gate).';
  const body = json({ $comment: manifest.$comment, rasters: manifest.rasters });
  if (!existsSync(abs(MANIFEST)) || readFileSync(abs(MANIFEST), 'utf8') !== body) {
    mkdirSync(path.dirname(abs(MANIFEST)), { recursive: true });
    writeFileSync(abs(MANIFEST), body);
  }
  console.log(`brand build: ${written} written, ${unchanged} unchanged, ${selected.length} outputs${ONLY ? ` (groups ${ONLY.join(',')})` : ''}`);
  if (missingMarkers.length) console.log(`brand build: ${missingMarkers.length} page(s) have no markers yet (skipped):\n  ${missingMarkers.join('\n  ')}`);
}
