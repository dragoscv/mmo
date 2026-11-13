#!/usr/bin/env node
// lint-staged / CI gate for the brand pack (WP22-07): every generated brand output must match brand/src and the
// design tokens, and (with --staged) must be staged together with its source.
//
//   node scripts/brand-drift.mjs            working tree vs brand/src (CI)
//   node scripts/brand-drift.mjs --staged   same, plus: no generated output may be modified or new but unstaged
//
// It NEVER writes or stages anything: in a shared clone you run `node brand/scripts/build.mjs` and stage the
// outputs yourself. Extra CLI args (the staged file list from lint-staged) are ignored.
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGED = process.argv.includes("--staged");
const generator = ["brand/scripts/build.mjs"];

const check = spawnSync(process.execPath, [...generator, "--check"], { cwd: repo, encoding: "utf8" });
process.stdout.write(check.stdout ?? "");
process.stderr.write(check.stderr ?? "");
if (check.status !== 0) {
    console.error("\nbrand-drift: FAIL (a brand output differs from brand/src; see above)");
    process.exit(check.status ?? 1);
}

if (STAGED) {
    const list = spawnSync(process.execPath, [...generator, "--list"], { cwd: repo, encoding: "utf8" });
    if (list.status !== 0) {
        console.error("brand-drift: `node brand/scripts/build.mjs --list` failed\n" + (list.stderr ?? ""));
        process.exit(2);
    }
    // "group  path" or "group  path  (region name)"; a region lives in a hand-written page, so the page is included.
    const outputs = [...new Set(list.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^\S+\s+/, "").replace(/\s+\(region .*$/, "")))];
    outputs.push("brand/dist/manifest.json");
    const git = (args) => {
        // chunked: a few hundred paths with spaces exceed the Windows command-line limit in one call
        const out = [];
        for (let i = 0; i < outputs.length; i += 100) {
            out.push(execFileSync("git", [...args, "--", ...outputs.slice(i, i + 100)], { cwd: repo, encoding: "utf8" }));
        }
        return out.join("").split(/\r?\n/).filter(Boolean);
    };
    let unstaged;
    let untracked;
    try {
        unstaged = git(["diff", "--name-only"]);
        untracked = git(["ls-files", "--others", "--exclude-standard"]);
    } catch (e) {
        console.error("brand-drift: git failed", e?.message ?? e);
        process.exit(2);
    }
    const pending = [...unstaged, ...untracked];
    if (pending.length) {
        console.error(`\nbrand-drift: FAIL — ${pending.length} generated brand file(s) are not staged with this commit:`);
        for (const p of pending.slice(0, 30)) console.error("  " + p);
        if (pending.length > 30) console.error(`  … +${pending.length - 30} more`);
        console.error("\nFix: stage them (they already match brand/src) and commit again:");
        console.error("  git add -- <the paths above>");
        process.exit(1);
    }
}
console.log(`brand-drift: OK${STAGED ? " (outputs match brand/src and are staged)" : ""}`);
