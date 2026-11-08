#!/usr/bin/env node
// Adds / updates EN + RO entries in an .xcstrings catalog from a JSON map { key: [en, ro] } and keeps keys sorted
// (Xcode's own order). Usage: node scripts/strings-add.mjs <catalog.xcstrings> <entries.json>
import { readFileSync, writeFileSync } from 'node:fs';

const [catalogPath, entriesPath] = process.argv.slice(2);
const cat = JSON.parse(readFileSync(catalogPath, 'utf8'));
const add = JSON.parse(readFileSync(entriesPath, 'utf8'));
let n = 0;
for (const [key, [en, ro]] of Object.entries(add)) {
  cat.strings[key] = {
    extractionState: 'manual',
    localizations: {
      en: { stringUnit: { state: 'translated', value: en } },
      ro: { stringUnit: { state: 'translated', value: ro } },
    },
  };
  n++;
}
cat.strings = Object.fromEntries(Object.entries(cat.strings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
// Same layout as the committed catalogs (2-space JSON).
const out = JSON.stringify(cat, null, 2) + '\n';
writeFileSync(catalogPath, out.replace(/\r\n/g, '\n'));
console.log(`strings-add: ${n} entries -> ${catalogPath} (${Object.keys(cat.strings).length} keys)`);
