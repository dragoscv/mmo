#!/usr/bin/env node
// RO/EN parity for src/i18n/{en,ro}.json: identical key sets, no empty values, same {placeholders}.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "i18n");
const flat = (o, p = "", out = {}) => {
    for (const [k, v] of Object.entries(o)) {
        const key = p ? `${p}.${k}` : k;
        if (v && typeof v === "object") flat(v, key, out);
        else out[key] = String(v);
    }
    return out;
};
const load = (l) => flat(JSON.parse(readFileSync(join(dir, `${l}.json`), "utf8")));
const en = load("en");
const ro = load("ro");
const vars = (s) => [...s.matchAll(/\{\{?(\w+)\}?\}/g)].map((m) => m[1]).sort().join(",");
const problems = [];
for (const k of Object.keys(en)) if (!(k in ro)) problems.push(`missing in ro: ${k}`);
for (const k of Object.keys(ro)) if (!(k in en)) problems.push(`missing in en: ${k}`);
for (const [k, v] of Object.entries(en)) {
    if (!v.trim()) problems.push(`empty en: ${k}`);
    if (k in ro) {
        if (!ro[k].trim()) problems.push(`empty ro: ${k}`);
        if (vars(v) !== vars(ro[k])) problems.push(`placeholder mismatch: ${k}`);
    }
}
if (problems.length) {
    console.error(problems.join("\n"));
    console.error(`i18n parity: ${problems.length} problem(s)`);
    process.exit(1);
}
console.log(`i18n parity OK: ${Object.keys(en).length} keys in en + ro`);
