// Golden fixtures for the layout solver (WP19-34): runs the TS solver (the source of truth) over
// every preset x a grid of window sizes (including too-small ones), plus minimum sizes and
// validator cases, and writes docs/decks/fixtures/layout-cases.json. Asserted by
// src/layout/solver.test.ts (TS) and crates/decks-layout (Rust), so the two can never drift.
//
// Run from apps/mixai: node scripts/gen-layout-fixtures.mjs   (Node >= 23 strips TS types)
// Check only (CI):     node scripts/gen-layout-fixtures.mjs --check
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtures } from "../src/layout/fixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../docs/decks/fixtures/layout-cases.json");
const text = buildFixtures();
if (process.argv.includes("--check")) {
    const current = readFileSync(out, "utf8").replace(/\r\n/g, "\n");
    if (current !== text) {
        console.error(`${out} is stale: run node scripts/gen-layout-fixtures.mjs`);
        process.exit(1);
    }
    console.log("layout fixtures up to date");
} else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.log(`wrote ${out}`);
}
