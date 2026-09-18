#!/usr/bin/env node
// i18n parity gate for apps/web next-intl messages.
//
//   node scripts/i18n-parity.mjs            # missing keys on either side → exit 1
//   node scripts/i18n-parity.mjs --strict   # also fail on identical (untranslated) values
//   node scripts/i18n-parity.mjs --dir=<messages dir>   # check another directory (mutation tests)
//
// ICU plural/select variant differences (e.g. RO `few`, EN lacks it) are NOT
// flagged: only leaf keys are compared, and plural variants live inside the
// message string, not in the JSON tree.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dirArg = process.argv.find((a) => a.startsWith("--dir="));
const dir = dirArg ? dirArg.slice("--dir=".length) : join(here, "..", "messages");
const STRICT = process.argv.includes("--strict");
const BASE = "en";

const flat = (o, pre = "", out = new Map()) => {
    for (const k of Object.keys(o)) {
        const v = o[k];
        const kk = pre ? `${pre}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v)) flat(v, kk, out);
        else out.set(kk, v);
    }
    return out;
};
const load = (locale) => flat(JSON.parse(readFileSync(join(dir, `${locale}.json`), "utf8")));

const locales = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => basename(f, ".json"));
if (!locales.includes(BASE)) { console.error(`i18n-parity: messages/${BASE}.json not found`); process.exit(2); }

// Values that legitimately stay identical across locales.
const SAME_OK = /^(\s*|[A-Z0-9 ._\-/+&:#%]{0,4}|\{[^}]+\}|MixAI|OK|Cancel|Pro|Beta|DJ|BPM|API|URL|ID|Email|Podcast|Studio|Sync)$/i;
const looksUntranslated = (v) => typeof v === "string" && v.trim().length > 2 && !SAME_OK.test(v) && !/^\{[^}]+\}$/.test(v) && !/^[\p{P}\p{S}\d\s]+$/u.test(v);

const base = load(BASE);
let failed = false;
let untranslatedTotal = 0;

for (const locale of locales.filter((l) => l !== BASE)) {
    const other = load(locale);
    const missingInOther = [...base.keys()].filter((k) => !other.has(k));
    const missingInBase = [...other.keys()].filter((k) => !base.has(k));
    const identical = [...base.keys()].filter((k) => other.has(k) && other.get(k) === base.get(k) && looksUntranslated(base.get(k)));

    console.log(`${BASE}: ${base.size} keys · ${locale}: ${other.size} keys`);
    const report = (title, list) => {
        if (!list.length) return;
        console.log(`  ${title} (${list.length}):`);
        for (const k of list.slice(0, 50)) console.log(`    - ${k}`);
        if (list.length > 50) console.log(`    … +${list.length - 50} more`);
    };
    report(`missing in ${locale}`, missingInOther);
    report(`missing in ${BASE}`, missingInBase);
    if (missingInOther.length || missingInBase.length) failed = true;
    if (identical.length) {
        untranslatedTotal += identical.length;
        report(`identical to ${BASE} (possibly untranslated)`, identical);
        if (STRICT) failed = true;
    }
}

if (failed) {
    console.error(`i18n-parity: FAIL${STRICT ? " (strict)" : ""}`);
    process.exit(1);
}
console.log(`i18n-parity: OK${untranslatedTotal ? ` (${untranslatedTotal} identical values; run with --strict to fail on them)` : ""}`);
