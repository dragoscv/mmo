#!/usr/bin/env node
// String catalog check for the iPhone apps (WP17-42): every literal key used by Text("…") / Label("…") /
// String(localized: "…") / LocalizedStringKey defaults in the given source dirs must exist in the catalog, with
// EN and RO translated. Usage: node scripts/strings-check.mjs <catalog.xcstrings> <dir> [dir…]  (exit 1 on gaps)
// Interpolated keys (`"pin.enter \(x)"`) are normalised to the catalog form (`pin.enter %@` / `%lld`).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [catalogPath, ...dirs] = process.argv.slice(2);
if (!catalogPath || dirs.length === 0) {
  console.error('usage: strings-check.mjs <catalog.xcstrings> <dir> [dir…]');
  process.exit(2);
}
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')).strings;
const keys = new Set(Object.keys(catalog));
// Catalog keys without their format specifiers, to match `"x \(y)"` regardless of %@ vs %lld.
const stem = (k) => k.replace(/ %(?:lld|@|d|f|\.\d+f)/g, ' %').trim();
const stems = new Map([...keys].map((k) => [stem(k), k]));
// Areas (`music`, `player`, …) that hold localised keys; bare literals outside them are SF Symbols or prefs keys.
const areas = new Set([...keys].map((k) => k.split('.')[0]));

function* files(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (p.endsWith('.swift')) yield p;
  }
}

// Literal dotted keys inside localising call sites. Keys look like `area.name` (lowercase, dots, underscores).
const CALL = /(?:Text|Label|Button|Section|Toggle|Picker|LocalizedStringKey|LocalizedStringResource|String\(localized:|navigationTitle|alert|confirmationDialog|accessibilityLabel\(Text|accessibilityHint\(Text|StateView\(kind: \.empty|SectionHeader\(title: String\(localized:|\.empty)\(?\s*"([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+(?: \\\([^)]*\))*)"/g;
const BARE = /"([a-z][a-z0-9_]*\.[a-z0-9_.]+(?: \\\([^)]*\))*)"/g;

const missing = new Map();
for (const d of dirs) {
  for (const f of files(d)) {
    const src = readFileSync(f, 'utf8');
    // SF Symbol names (`systemName: "music.note"`, `symbol: "music.mic"`, `placeholderSymbol:`) are not keys.
    const symbols = new Set([...src.matchAll(/(?:systemName|[sS]ymbol|systemImage|icon):\s*"([^"]+)"/g)].map((m) => m[1]));
    // Helper calls shaped `control("sf.symbol", "area.key")`: the first literal is the symbol.
    for (const m of src.matchAll(/\(\s*"([a-z0-9.]+)"\s*,\s*"[a-z][a-z0-9_]*\.[a-z0-9_.]+"/g)) symbols.add(m[1]);
    for (const m of src.matchAll(/\?\s*"([a-z0-9.]+)"\s*:\s*"([a-z0-9.]+)"/g)) { symbols.add(m[1]); symbols.add(m[2]); }
    for (const re of [CALL, BARE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const raw = m[1];
        if (symbols.has(raw)) continue;
        if (/\.(swift|json|jpg|png|mp4|xcstrings)$/.test(raw) || /^(ro|com|group|app|apple|mixai)\./.test(raw)) continue;
        if (re === BARE && !areas.has(raw.split('.')[0])) continue;
        if (raw.endsWith('.')) continue; // prefix of a computed key (`together.reason.\(x)`)
        const k = raw.replace(/ \\\([^)]*\)/g, ' %');
        if (keys.has(raw) || stems.has(k.trim()) || keys.has(k)) continue;
        if (!missing.has(raw)) missing.set(raw, f);
      }
    }
  }
}

const untranslated = [];
for (const [k, v] of Object.entries(catalog)) {
  if (v.shouldTranslate === false) continue;
  const loc = v.localizations ?? {};
  for (const l of ['en', 'ro']) {
    const unit = loc[l]?.stringUnit ?? loc[l]?.variations;
    if (!unit) untranslated.push(`${k} [${l}]`);
  }
}

for (const [k, f] of missing) console.log(`MISSING ${k}  (${f})`);
for (const u of untranslated) console.log(`UNTRANSLATED ${u}`);
console.log(`strings-check: ${keys.size} keys, ${missing.size} missing, ${untranslated.length} untranslated`);
process.exit(missing.size || untranslated.length ? 1 : 0);
