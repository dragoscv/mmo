#!/usr/bin/env node
// lint-staged gate for packages/design-tokens/src/**: rebuilds the tokens and fails
// when any generated file (dist/* or a committed mirror) differs from the index.
// It NEVER stages anything — in a shared clone the user re-runs `pnpm tokens:build`
// and stages the mirrors themselves. Extra CLI args (the staged file list) are ignored.
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = [
    "packages/design-tokens/dist",
    "apps/tv-android/app/src/main/java/ro/mixai/tv/ui/theme/Tokens.kt",
    "apps/tv-tizen/src/tokens.css",
    "apps/extension/tokens.css",
    "apps/native/web/tokens.css",
    "apps/web/public/prehydrate.js",
    "apps/tv-tizen/public/prehydrate.js",
    "apps/mixai/public/prehydrate.js",
    "server/ui/public/prehydrate.js",
];

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const build = spawnSync(pnpm, ["-C", "packages/design-tokens", "build"], { cwd: repo, stdio: "inherit", shell: process.platform === "win32" });
if (build.status !== 0) {
    console.error("tokens-drift: `pnpm -C packages/design-tokens build` failed");
    process.exit(build.status ?? 1);
}

// Compare working tree vs index for the generated paths: a diff means the staged
// mirrors are stale (or unstaged after regeneration).
let diff = "";
try {
    diff = execFileSync("git", ["diff", "--stat", "--", ...GENERATED], { cwd: repo, encoding: "utf8" }).trim();
} catch (e) {
    console.error("tokens-drift: git diff failed", e?.message ?? e);
    process.exit(2);
}
if (diff) {
    console.error("\ntokens-drift: FAIL — generated token files differ from what is staged:\n" + diff);
    console.error("\nFix: the build above already regenerated them; stage the mirrors and commit again:");
    console.error("  git add -- " + GENERATED.join(" "));
    process.exit(1);
}
console.log("tokens-drift: OK (dist + mirrors match the staged sources)");
