#!/usr/bin/env node
// lint-staged gate for docs/mixai-design-tracker.md: regenerates the CSV and fails when
// docs/mixai-design-tracker.csv differs from the index. Never stages anything — the
// user runs `git add docs/mixai-design-tracker.csv` (shared-clone safe).
// Extra CLI args (the staged file list) are ignored.
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CSV = "docs/mixai-design-tracker.csv";

const regen = spawnSync(process.execPath, ["scripts/tracker-regen-csv.mjs"], { cwd: repo, stdio: "inherit" });
if (regen.status !== 0) {
    console.error("tracker-drift: tracker-regen-csv.mjs failed");
    process.exit(regen.status ?? 1);
}
const diff = execFileSync("git", ["diff", "--stat", "--", CSV], { cwd: repo, encoding: "utf8" }).trim();
if (diff) {
    console.error(`\ntracker-drift: FAIL — ${CSV} is stale relative to the staged tracker .md:\n${diff}`);
    console.error(`\nFix: the CSV was just regenerated; stage it and commit again:\n  git add -- ${CSV}`);
    process.exit(1);
}
console.log("tracker-drift: OK (csv matches the tracker md)");
