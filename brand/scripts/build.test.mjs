// Tests of the brand source and generator. Run: node --test brand/scripts/build.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { GLYPHS, IDS, MARK, geometry } from '../src/marks.mjs';
import { EASE, LOGO_MOTION } from '../src/motion.mjs';
import { SONIC } from '../src/sonic.mjs';
import * as A from './lib/android.mjs';
import * as D from './lib/draw.mjs';
import * as MO from './lib/motion.mjs';
import * as P from './lib/path.mjs';
import { renderWav, wavFacts } from './lib/sonic.mjs';
import { bootStyle, inlineLogo, inlineWordmark } from './lib/web.mjs';

const read = (rel) => readFileSync(path.join(D.REPO, ...rel.split('/')), 'utf8');

test('path: H, V, Q and A become M / L / C and keep their end points', () => {
  const segs = P.parse('M9 39V9L18.37 22.74');
  assert.deepEqual(segs.map((s) => s.c), ['M', 'L', 'L']);
  assert.deepEqual([segs[1].x, segs[1].y], [9, 9]);
  const arc = P.parse('M24 10A14 14 0 1 1 23.99 10Z');
  assert.ok(arc.filter((s) => s.c === 'C').length >= 4, 'a full circle needs at least four curves');
  const box = P.bbox(arc);
  for (const [got, want] of [[box[0], 10], [box[1], 10], [box[2], 38], [box[3], 38]]) assert.ok(Math.abs(got - want) < 0.05, `circle bbox ${box}`);
  assert.throws(() => P.parse('M0 0l1 1'), /unsupported path command/);
  assert.ok(Math.abs(P.length(P.parse('M0 0H10V10')) - 20) < 1e-6);
});

test('marks: every mark is lines plus exactly one dot, on both optical sizes, inside its grid', () => {
  assert.deepEqual(IDS, ['mark', 'tv', 'music', 'decks', 'live', 'studio', 'keybpm', 'server', 'connector']);
  for (const id of IDS) {
    for (const [size, geo] of Object.entries(geometry(id))) {
      assert.ok(geo.lines.length >= 1, `${id}.${size} has lines`);
      assert.equal(geo.dot.length, 3, `${id}.${size} has one dot`);
      assert.equal(geo.grid, size === 'micro' ? 16 : 48);
      const half = geo.w / 2;
      for (const line of geo.lines) {
        const [x0, y0, x1, y1] = P.bbox(P.parse(line.d));
        assert.ok(x0 - half >= 0 && y0 - half >= 0 && x1 + half <= geo.grid && y1 + half <= geo.grid, `${id}.${size} stroke leaves the grid: ${line.d}`);
      }
    }
  }
  assert.deepEqual(MARK.master.lines.map((l) => l.role), ['a', 'b'], 'the family mark has one line per stream');
  for (const g of Object.values(GLYPHS)) assert.ok(g.master.lines.every((l) => !l.role), 'product glyphs have one colour');
});

test('marks: the family mark is mirror-symmetric and the dot sits on the axis', () => {
  const [a, b] = MARK.master.lines.map((l) => P.parse(l.d));
  a.forEach((s, i) => {
    assert.ok(Math.abs(s.x + b[i].x - 48) < 0.01 && Math.abs(s.y - b[i].y) < 0.01, 'streams mirror around x = 24');
  });
  assert.equal(MARK.master.dot[0], 24);
});

test('android: every glyph stays inside the 66 dp adaptive safe circle', () => {
  for (const id of IDS) assert.ok(A.adaptiveReach(id) <= A.ADAPTIVE.safeRadius, `${id} reaches ${A.adaptiveReach(id).toFixed(2)} dp`);
});

test('colours: the tokens give every product a colour that reads on the tile', () => {
  for (const id of D.PRODUCT_IDS) {
    const lum = (hex) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (lum(D.PRODUCTS[id].hex.dark) + 0.05) / (lum(D.C.tile) + 0.05);
    assert.ok(ratio >= 3, `${id} on the tile is ${ratio.toFixed(2)}:1`);
  }
});

test('lettering: every product has an outlined name and the i of MixAI loses its own dot', () => {
  for (const id of D.PRODUCT_IDS) assert.ok(D.LETTERING.runs[id], `lettering.json has no run for ${id}`);
  assert.equal(D.LETTERING.runs.brand.text, 'MixAI');
  const { parts, dot } = D.runParts('brand', { cap: 24, iDot: true });
  assert.equal(parts.length, 5);
  assert.ok(dot && dot.r > 0);
  const lock = D.lockupSvg('keybpm', 96);
  assert.ok(!lock.includes('<text'), 'lockups carry no live text');
  assert.ok(lock.includes('aria-label="MixAI Key &amp; BPM"'), 'names are XML-escaped');
  assert.match(D.sha256(read('apps/web/src/app/fonts/SpaceGroteskVariable.woff2')), /^[0-9a-f]{64}$/);
  assert.equal(D.sha256(readFileSync(path.join(D.REPO, D.LETTERING.font.file))), D.LETTERING.font.sha256, 'lettering.json was outlined from another font file: re-run outline-lettering.py');
});

test('motion: every track starts and ends on the static mark and uses easings every platform can play', () => {
  const rest = { trimStart: 0, lineOpacity: 1, dotScale: 1, shakeX: 0 };
  for (const [name, anim] of Object.entries(LOGO_MOTION)) {
    for (const [track, value] of Object.entries(rest)) {
      if (!anim[track] || name === 'morph') continue;
      const ks = MO.keys(anim[track]);
      assert.equal(ks[0].v, value, `${name}.${track} starts on the static mark`);
      assert.equal(ks.at(-1).v, value, `${name}.${track} ends on the static mark`);
    }
    assert.ok(anim.reduced, `${name} documents its reduced-motion form`);
  }
  for (const [name, e] of Object.entries(EASE)) assert.ok(e.every((v) => v >= 0 && v <= 1), `easing ${name} leaves 0..1`);
  assert.throws(() => MO.keys([[0, 0], [1, 1, 'nope']]), /unknown easing/);
  assert.ok(A.animationMs('intro') <= 1000, 'the Android system splash allows 1000 ms');
  assert.ok(Math.abs(MO.valueAt(LOGO_MOTION.success.dotScale, 0.4) - 1.38) < 1e-9);
  assert.equal(MO.valueAt(LOGO_MOTION.intro.trimStart, 0.36), 1, 'the lines are fully retracted in the middle of the intro');
});

test('motion: CSS has every animation, a reduced-motion block and the app switch', () => {
  const css = MO.logoCss();
  for (const anim of ['intro', 'loading', 'success', 'error', 'morph']) assert.ok(css.includes(`.mixai-logo[data-anim="${anim}"]`), anim);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*animation: none/);
  assert.ok(css.includes(':root[data-motion="reduced"] .mixai-logo[data-anim]'));
  assert.equal(read('packages/ui/src/brand/generated/logo.css'), css, '@mmo/ui ships the generated CSS');
  assert.ok(read('packages/ui/src/styles.css').includes('@import "./brand/generated/logo.css";'), '@mmo/ui/styles.css imports it');
});

test('boot screens: the inline mark carries no colours or style attributes; the style region paints it from token variables', () => {
  for (const id of IDS) {
    const markup = inlineLogo(id, 96, 'data-anim="intro"') + (id === 'mark' ? '' : inlineWordmark(id, 30));
    assert.ok(!/ style=| fill=| stroke=|#[0-9a-f]{6}/i.test(markup), `${id}: inline markup must be paint-less`);
    assert.ok(markup.includes(`data-product="${id}"`));
    const own = bootStyle(id);
    assert.ok(!/#[0-9a-f]{6}/i.test(own), `${id}: a page with tokens.css gets no literal colours`);
    assert.ok(own.includes(id === 'mark' ? 'var(--mark-a)' : `var(--product-${id})`) && own.includes('var(--mark-signal)'));
    const self = bootStyle(id, { selfContained: true });
    assert.ok(self.includes('.mixai-boot {') && self.includes(':root[data-mode="light"] .mixai-boot'), `${id}: self-contained boot holder with a light variant`);
    assert.ok(!self.includes('inset:'), 'no inset shorthand (TV engines older than Chromium 87)');
  }
  assert.equal((inlineLogo('live', 96).match(/class="mixai-logo-line/g) ?? []).length, geometry('live').master.lines.length);
  assert.ok(bootStyle('live').includes('.mixai-logo[data-product="live"] .mixai-logo-line:nth-child(4) { --i: 1; }'), 'line positions come from CSS');
  for (const page of ['server/ui/index.html', 'apps/native/web/index.html', 'apps/music-desktop/web/index.html', 'apps/tv-tizen/index.html', 'apps/tv-desktop/index.html', 'apps/mixai/index.html', 'apps/live/desktop/index.html']) {
    const html = read(page);
    assert.match(html, /<!-- brand:style:start --><style>[\s\S]+<\/style><!-- brand:style:end -->/, `${page}: style region filled`);
    assert.match(html, /<!-- brand:logo:start --><svg class="mixai-logo"[\s\S]+<\/svg><!-- brand:logo:end -->/, `${page}: logo region filled`);
    assert.ok(html.indexOf('brand:style:start') < html.indexOf('</head>'), `${page}: the style region is in <head>`);
  }
});

test('android: the animated vector animates named targets that exist in the drawable', () => {
  const xml = A.animatedVector('live', 'intro');
  const names = [...xml.matchAll(/<target android:name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ['line0', 'line1', 'line2', 'line3', 'dot']);
  for (const n of names) assert.ok(xml.includes(`android:name="${n}"`));
  assert.ok(!xml.includes('repeatCount'), 'the intro plays once');
  assert.ok(A.animatedVector('tv', 'loading').includes('android:repeatCount="infinite"'));
  assert.ok(A.launcherMonochrome('tv').includes('#FFFFFFFF') && !A.launcherMonochrome('tv').includes(D.PRODUCTS.tv.hex.dark.slice(1).toUpperCase()));
});

test('containers: ico and icns list what was put in', () => {
  const data = Buffer.from([1, 2, 3]);
  assert.deepEqual(D.icoSizes(D.ico([16, 32, 256].map((size) => ({ size, data })))), [16, 32, 256]);
  assert.deepEqual(D.icnsTypes(D.icns([{ type: 'ic07', data }, { type: 'ic10', data }])), ['ic07', 'ic10']);
});

test('sound: the signature is short, quiet and ends in silence', () => {
  assert.ok(SONIC.variants[SONIC.chosen], 'the chosen variant exists');
  const wav = renderWav(SONIC.chosen);
  const facts = wavFacts(wav);
  assert.ok(facts.seconds <= 1.5, `${facts.seconds} s`);
  assert.ok(Math.abs(facts.peakDb - 20 * Math.log10(SONIC.peak)) < 0.1, `peak ${facts.peakDb.toFixed(2)} dBFS`);
  assert.ok(Math.abs(wav.readInt16LE(wav.length - 4)) < 64 && Math.abs(wav.readInt16LE(wav.length - 2)) < 64, 'no click at the end');
  assert.deepEqual(renderWav(SONIC.chosen), wav, 'rendering is deterministic');
});

test('generator: outputs are unique, cover every product on every platform group, and match the tree', () => {
  const list = execFileSync('node', ['brand/scripts/build.mjs', '--list'], { cwd: D.REPO, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  const paths = list.map((l) => l.replace(/^\S+\s+/, ''));
  assert.equal(new Set(paths).size, paths.length);
  for (const group of ['dist', 'web', 'ui', 'android', 'apple', 'desktop', 'tv', 'extension', 'server', 'store']) assert.ok(list.some((l) => l.startsWith(group)), `group ${group}`);
  for (const id of D.PRODUCT_IDS) assert.ok(paths.includes(`brand/dist/logo/${id}/lockup.svg`) && paths.includes(`apps/web/public/icon-${id}-512.png`), id);
  const check = spawnSync('node', ['brand/scripts/build.mjs', '--check'], { cwd: D.REPO, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);
});
