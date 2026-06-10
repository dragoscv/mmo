#!/usr/bin/env node
// @ts-check
/**
 * Tiny ESLint baseline tool.
 *
 * Usage:
 *   node scripts/lint-baseline.mjs snapshot   # write .eslint-baseline.json
 *   node scripts/lint-baseline.mjs check      # fail only on NEW errors
 *
 * The baseline records `{ <relativePath>: errorCount }` for the worst
 * lines as of the snapshot. `check` runs ESLint, computes the same map for
 * the current tree, and exits non-zero only when a file has MORE errors
 * than the baseline (i.e. a regression). Files with fewer errors are
 * silently allowed — that's progress.
 *
 * We deliberately do NOT match per-rule or per-line: ESLint output is too
 * sensitive to plugin upgrades and surrounding code changes for that to be
 * useful in practice. File-level error counts strike the balance between
 * "catches regressions on this file" and "doesn't churn on every refactor".
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BASELINE_PATH = path.join(REPO_ROOT, ".eslint-baseline.json");

function runEslintJson() {
    // ESLint exits non-zero when there are errors — we WANT the JSON either
    // way, so swallow the throw and read stdout.
    let stdout = "";
    try {
        stdout = execFileSync("pnpm", ["exec", "eslint", ".", "--format", "json"], {
            cwd: REPO_ROOT,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            shell: process.platform === "win32",
        });
    } catch (err) {
        stdout = /** @type {{ stdout?: string }} */ (err).stdout ?? "";
    }
    if (!stdout) {
        console.error("ESLint produced no JSON output; is the config broken?");
        process.exit(2);
    }
    /** @type {Array<{ filePath: string; errorCount: number; warningCount: number }>} */
    const results = JSON.parse(stdout);
    /** @type {Record<string, number>} */
    const errors = {};
    for (const r of results) {
        if (r.errorCount > 0) {
            errors[path.relative(REPO_ROOT, r.filePath).replace(/\\/g, "/")] = r.errorCount;
        }
    }
    return errors;
}

const cmd = process.argv[2] ?? "check";

if (cmd === "snapshot") {
    const map = runEslintJson();
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(map, null, 2) + "\n");
    const total = Object.values(map).reduce((a, b) => a + b, 0);
    console.log(`Baseline written: ${Object.keys(map).length} files, ${total} total errors → ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
    process.exit(0);
}

if (cmd === "check") {
    if (!fs.existsSync(BASELINE_PATH)) {
        console.error(`No baseline at ${BASELINE_PATH}. Run 'pnpm lint:baseline' once to create one.`);
        process.exit(2);
    }
    /** @type {Record<string, number>} */
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    const current = runEslintJson();

    /** @type {Array<{ file: string; baseline: number; current: number; delta: number }>} */
    const regressions = [];
    for (const [file, count] of Object.entries(current)) {
        const allowed = baseline[file] ?? 0;
        if (count > allowed) regressions.push({ file, baseline: allowed, current: count, delta: count - allowed });
    }

    const totalNew = regressions.reduce((s, r) => s + r.delta, 0);
    if (regressions.length === 0) {
        console.log("OK — no new ESLint errors above baseline.");
        process.exit(0);
    }

    console.error(`FAIL — ${regressions.length} file(s) with ${totalNew} new ESLint error(s) above baseline:`);
    for (const r of regressions) {
        console.error(`  ${r.file}: baseline ${r.baseline} → current ${r.current}  (+${r.delta})`);
    }
    console.error("\nFix the new errors, or — if intentional — re-run 'pnpm lint:baseline' to accept them.");
    process.exit(1);
}

console.error(`Unknown command: ${cmd}. Use 'snapshot' or 'check'.`);
process.exit(2);
