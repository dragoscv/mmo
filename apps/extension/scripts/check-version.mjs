#!/usr/bin/env node
/**
 * Pre-commit guard for the browser extension.
 *
 * If any file under apps/extension/ is being committed, BOTH
 *   - apps/extension/manifest.json
 *   - apps/extension/package.json
 * must have their `version` field bumped vs the merge base with origin/main.
 *
 * The CI workflow (.github/workflows/extension-ci.yml) re-runs the same
 * check on PRs in case the hook was bypassed locally.
 *
 * Usage:
 *   node apps/extension/scripts/check-version.mjs            # check vs origin/main
 *   node apps/extension/scripts/check-version.mjs --staged   # check staged changes (hook mode)
 *   node apps/extension/scripts/check-version.mjs --base=<ref>  # custom base ref
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const EXT_DIR = resolve(REPO_ROOT, "apps", "extension");
const MANIFEST = join(EXT_DIR, "manifest.json");
const PKG = join(EXT_DIR, "package.json");

const args = process.argv.slice(2);
const STAGED = args.includes("--staged");
const baseArg = args.find((a) => a.startsWith("--base="));
const BASE = baseArg ? baseArg.slice("--base=".length) : "origin/main";

const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

function exec(cmd, args) {
    try {
        return execFileSync(cmd, args, {
            cwd: REPO_ROOT,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch (err) {
        return null;
    }
}

function changedExtFiles() {
    if (STAGED) {
        const out = exec("git", ["diff", "--cached", "--name-only"]) ?? "";
        return out
            .split(/\r?\n/)
            .filter((p) => p.startsWith("apps/extension/"));
    }
    const baseExists = exec("git", ["rev-parse", "--verify", BASE]);
    if (!baseExists) {
        // Base ref not available locally (shallow clone, fresh fork). Fall
        // back to "everything currently dirty" to stay useful.
        const out = exec("git", ["status", "--porcelain"]) ?? "";
        return out
            .split(/\r?\n/)
            .map((l) => l.slice(3))
            .filter((p) => p.startsWith("apps/extension/"));
    }
    const out =
        exec("git", ["diff", "--name-only", `${BASE}...HEAD`]) ?? "";
    return out
        .split(/\r?\n/)
        .filter((p) => p.startsWith("apps/extension/"));
}

function readVersionFromHEAD(path) {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j.version ?? null;
}

function readVersionFromRef(ref, relPath) {
    const out = exec("git", ["show", `${ref}:${relPath}`]);
    if (!out) return null;
    try {
        return JSON.parse(out).version ?? null;
    } catch {
        return null;
    }
}

function readVersionStaged(path, relPath) {
    // What the commit will contain (staged version, not working-tree).
    const out = exec("git", ["show", `:${relPath}`]);
    if (!out) return readVersionFromHEAD(path);
    try {
        return JSON.parse(out).version ?? null;
    } catch {
        return null;
    }
}

function semverGreater(a, b) {
    if (!a || !b) return false;
    const norm = (v) =>
        v
            .split(/[.-]/)
            .map((p) => (Number.isFinite(+p) ? Number(p) : p));
    const aa = norm(a);
    const bb = norm(b);
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
        const x = aa[i] ?? 0;
        const y = bb[i] ?? 0;
        if (x === y) continue;
        if (typeof x === "number" && typeof y === "number") return x > y;
        return String(x) > String(y);
    }
    return false;
}

function fail(lines) {
    console.error("");
    console.error(
        `${RED}${BOLD}\u2716 Extension version bump required${RESET}`
    );
    console.error(
        `${DIM}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${RESET}`
    );
    for (const ln of lines) console.error(ln);
    console.error(
        `${DIM}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${RESET}`
    );
    console.error(
        `${YELLOW}How to fix:${RESET}`
    );
    console.error(
        `  1. Decide the new version (semver: patch / minor / major).`
    );
    console.error(
        `  2. ${BOLD}Bump BOTH files to the same value:${RESET}`
    );
    console.error(
        `     - ${DIM}apps/extension/manifest.json${RESET}  ${BOLD}"version"${RESET}`
    );
    console.error(
        `     - ${DIM}apps/extension/package.json${RESET}   ${BOLD}"version"${RESET}`
    );
    console.error(
        `  3. ${DIM}git add apps/extension/manifest.json apps/extension/package.json${RESET}`
    );
    console.error(
        `  4. ${DIM}git commit ...${RESET}`
    );
    console.error("");
    console.error(
        `${DIM}(To bypass intentionally \u2014 e.g. for a docs-only refactor inside the extension folder \u2014`
    );
    console.error(`${DIM} run: git commit --no-verify)${RESET}`);
    console.error("");
    process.exit(1);
}

// ── Main ────────────────────────────────────────────────────────────────
const changed = changedExtFiles().filter((p) => p.length > 0);
if (changed.length === 0) {
    // Nothing to check.
    process.exit(0);
}

// Ignore changes that are ONLY in the lockfile or scripts/ \u2014 those don't
// affect the shipped extension and shouldn't force a version bump.
const significant = changed.filter(
    (p) =>
        !p.endsWith("pnpm-lock.yaml") &&
        !p.startsWith("apps/extension/node_modules/") &&
        !p.startsWith("apps/extension/scripts/")
);
if (significant.length === 0) {
    process.exit(0);
}

const manifestRel = "apps/extension/manifest.json";
const pkgRel = "apps/extension/package.json";

const currentManifest = STAGED
    ? readVersionStaged(MANIFEST, manifestRel)
    : readVersionFromHEAD(MANIFEST);
const currentPkg = STAGED
    ? readVersionStaged(PKG, pkgRel)
    : readVersionFromHEAD(PKG);

const baseManifest =
    readVersionFromRef(BASE, manifestRel) ??
    // Transitional fallback: extension/ was moved to apps/extension/ in v1.1.0.
    // When diffing against a base ref that predates the move, fall back to
    // the legacy path so the bump check still has a real baseline.
    readVersionFromRef(BASE, "extension/manifest.json");
const basePkg =
    readVersionFromRef(BASE, pkgRel) ??
    readVersionFromRef(BASE, "extension/package.json");

const errors = [];

if (currentManifest && currentPkg && currentManifest !== currentPkg) {
    errors.push(
        `  ${RED}\u2022${RESET} manifest.json (${BOLD}${currentManifest}${RESET}) and package.json (${BOLD}${currentPkg}${RESET}) disagree.`
    );
    errors.push(`    Both files must declare the ${BOLD}same${RESET} version.`);
}

const manifestBumped = semverGreater(currentManifest, baseManifest);
const pkgBumped = semverGreater(currentPkg, basePkg);

if (!manifestBumped) {
    errors.push(
        `  ${RED}\u2022${RESET} manifest.json version is still ${BOLD}${currentManifest ?? "<missing>"}${RESET} (base ${DIM}${baseManifest ?? "<unknown>"}${RESET}).`
    );
}
if (!pkgBumped) {
    errors.push(
        `  ${RED}\u2022${RESET} package.json  version is still ${BOLD}${currentPkg ?? "<missing>"}${RESET} (base ${DIM}${basePkg ?? "<unknown>"}${RESET}).`
    );
}

if (errors.length > 0) {
    fail([
        `${BOLD}You changed ${significant.length} file(s) in apps/extension/${RESET}`,
        ...significant
            .slice(0, 8)
            .map((p) => `  ${DIM}\u2026${RESET} ${p}`),
        ...(significant.length > 8
            ? [`  ${DIM}\u2026 and ${significant.length - 8} more${RESET}`]
            : []),
        "",
        `${BOLD}Problems found:${RESET}`,
        ...errors,
    ]);
}

console.log(
    `${GREEN}\u2713${RESET} extension version bumped: ${BOLD}${baseManifest ?? "?"}${RESET} \u2192 ${BOLD}${currentManifest}${RESET}`
);
