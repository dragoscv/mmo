#!/usr/bin/env node
// i18n parity gate for the browser extension (Chrome `_locales/<lang>/messages.json`,
// format `{ key: { message, description? } }`).
//
//   node scripts/i18n-parity-ext.mjs            # missing keys → exit 1
//   node scripts/i18n-parity-ext.mjs --strict   # also fail on identical messages
//   node scripts/i18n-parity-ext.mjs --dir=<_locales dir>   # check another directory (mutation tests)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dirArg = process.argv.find((a) => a.startsWith("--dir="));
const dir = dirArg ? dirArg.slice("--dir=".length) : join(here, "..", "apps", "extension", "_locales");
const STRICT = process.argv.includes("--strict");
const BASE = "en";

const load = (locale) => {
    const raw = JSON.parse(readFileSync(join(dir, locale, "messages.json"), "utf8"));
    return new Map(Object.entries(raw).map(([k, v]) => [k, typeof v === "string" ? v : v?.message]));
};
const locales = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "messages.json")))
    .map((d) => d.name);
if (!locales.includes(BASE)) { console.error(`i18n-parity-ext: _locales/${BASE}/messages.json not found`); process.exit(2); }

const looksUntranslated = (v) => typeof v === "string" && v.trim().length > 2 && !/^(MixAI|OK|URL|API|ID)$/i.test(v) && !/^[\p{P}\p{S}\d\s]+$/u.test(v);

const base = load(BASE);
let failed = false;
let identicalTotal = 0;
for (const locale of locales.filter((l) => l !== BASE)) {
    const other = load(locale);
    const missingInOther = [...base.keys()].filter((k) => !other.has(k));
    const missingInBase = [...other.keys()].filter((k) => !base.has(k));
    const identical = [...base.keys()].filter((k) => other.has(k) && other.get(k) === base.get(k) && looksUntranslated(base.get(k)));
    console.log(`${BASE}: ${base.size} keys · ${locale}: ${other.size} keys`);
    const report = (title, list) => {
        if (!list.length) return;
        console.log(`  ${title} (${list.length}):`);
        for (const k of list) console.log(`    - ${k}`);
    };
    report(`missing in ${locale}`, missingInOther);
    report(`missing in ${BASE}`, missingInBase);
    if (missingInOther.length || missingInBase.length) failed = true;
    if (identical.length) {
        identicalTotal += identical.length;
        report(`identical to ${BASE} (possibly untranslated)`, identical);
        if (STRICT) failed = true;
    }
}
if (failed) { console.error(`i18n-parity-ext: FAIL${STRICT ? " (strict)" : ""}`); process.exit(1); }
console.log(`i18n-parity-ext: OK${identicalTotal ? ` (${identicalTotal} identical values; --strict to fail on them)` : ""}`);
