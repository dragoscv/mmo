#!/usr/bin/env node
/**
 * Generic version-bump guard for the non-web surfaces that ship a package.json:
 *   server/                    → server/package.json
 *   packages/ui                → packages/ui/package.json
 *   packages/design-tokens     → packages/design-tokens/package.json
 *   packages/sdk               → packages/sdk/package.json
 *   packages/ai                → packages/ai/package.json
 *
 * For every surface with a significant changed file, the surface's package.json
 * `version` must be greater than the base version (semver compare).
 * Mirrors apps/web/scripts/check-version.mjs (same flags, same exit codes).
 *
 * Usage:
 *   node scripts/check-version-generic.mjs            # vs origin/main
 *   node scripts/check-version-generic.mjs --staged   # staged changes (husky / lint-staged)
 *   node scripts/check-version-generic.mjs --base=<ref>
 *   node scripts/check-version-generic.mjs --staged [file ...]   # lint-staged passes files; ignored (index is read)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/** dir prefix → label. Order matters only for output. */
const SURFACES = [
    { dir: "server/", label: "MMO Server" },
    { dir: "packages/ui/", label: "@mmo/ui" },
    { dir: "packages/design-tokens/", label: "@mmo/design-tokens" },
    { dir: "packages/sdk/", label: "@mmo/sdk" },
    { dir: "packages/ai/", label: "@mmo/ai" },
];

/** Files that never require a bump (relative to the surface dir). */
const IGNORED_SUBPATHS = [
    "node_modules/",
    "dist/",
    "release/",
    "coverage/",
    "scripts/",
    "ui/dist/",
    "pnpm-lock.yaml",
    "README.md",
    "CHANGELOG.md",
    "openapi.yaml", // spec-only edits are covered by openapi-check + version of the route change
    ".gitignore",
];
const IGNORED_SUFFIXES = [".test.ts", ".test.tsx", ".spec.ts", ".md"];

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

function exec(cmd, cmdArgs) {
    try {
        return execFileSync(cmd, cmdArgs, {
            cwd: REPO_ROOT,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch {
        return null;
    }
}

function changedFiles() {
    let out;
    if (STAGED) {
        out = exec("git", ["diff", "--cached", "--name-only"]) ?? "";
    } else if (!exec("git", ["rev-parse", "--verify", BASE])) {
        out = (exec("git", ["status", "--porcelain"]) ?? "")
            .split(/\r?\n/)
            .map((l) => l.slice(3))
            .join("\n");
    } else {
        out = exec("git", ["diff", "--name-only", `${BASE}...HEAD`]) ?? "";
    }
    return out.split(/\r?\n/).filter(Boolean);
}

function readVersionWorkingTree(relPkg) {
    const abs = join(REPO_ROOT, relPkg);
    if (!existsSync(abs)) return null;
    try {
        return JSON.parse(readFileSync(abs, "utf8")).version ?? null;
    } catch {
        return null;
    }
}

function readVersionFromRef(ref, relPkg) {
    const out = exec("git", ["show", `${ref}:${relPkg}`]);
    if (!out) return null;
    try {
        return JSON.parse(out).version ?? null;
    } catch {
        return null;
    }
}

function readVersionStaged(relPkg) {
    const out = exec("git", ["show", `:${relPkg}`]);
    if (!out) return readVersionWorkingTree(relPkg);
    try {
        return JSON.parse(out).version ?? null;
    } catch {
        return null;
    }
}

function semverGreater(a, b) {
    if (!a || !b) return false;
    const norm = (v) => v.split(/[.-]/).map((p) => (Number.isFinite(+p) ? Number(p) : p));
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

function isSignificant(surface, file) {
    const rel = file.slice(surface.dir.length);
    if (IGNORED_SUBPATHS.some((p) => rel.startsWith(p) || rel === p)) return false;
    if (IGNORED_SUFFIXES.some((s) => rel.endsWith(s))) return false;
    return true;
}

// ── Main ────────────────────────────────────────────────────────────────
const changed = changedFiles();
const failures = [];
const passes = [];

for (const surface of SURFACES) {
    const files = changed.filter((f) => f.startsWith(surface.dir));
    if (files.length === 0) continue;
    const significant = files.filter((f) => isSignificant(surface, f));
    if (significant.length === 0) continue;

    const pkgRel = `${surface.dir}package.json`;
    const current = STAGED ? readVersionStaged(pkgRel) : readVersionWorkingTree(pkgRel);
    // Same rule as apps/web/scripts/check-version.mjs: compare with BASE (origin/main);
    // when that ref does not exist locally fall back to HEAD.
    const baseRef = exec("git", ["rev-parse", "--verify", BASE]) ? BASE : "HEAD";
    const base = readVersionFromRef(baseRef, pkgRel);

    if (base === null && current) {
        // package.json does not exist at the base ref → brand-new surface, nothing to bump against.
        passes.push(`${surface.label}: new at ${baseRef} (${current})`);
    } else if (semverGreater(current, base)) {
        passes.push(`${surface.label}: ${base ?? "?"} \u2192 ${current}`);
    } else {
        failures.push({ surface, significant, current, base, pkgRel });
    }
}

if (failures.length === 0) {
    for (const p of passes) console.log(`${GREEN}\u2713${RESET} version bumped: ${BOLD}${p}${RESET}`);
    process.exit(0);
}

console.error("");
console.error(`${RED}${BOLD}\u2716 Version bump required${RESET}`);
console.error(`${DIM}${"\u2500".repeat(50)}${RESET}`);
for (const f of failures) {
    console.error(`${BOLD}${f.surface.label}${RESET} \u2014 ${f.significant.length} significant file(s) changed:`);
    for (const p of f.significant.slice(0, 6)) console.error(`  ${DIM}\u2026${RESET} ${p}`);
    if (f.significant.length > 6) console.error(`  ${DIM}\u2026 and ${f.significant.length - 6} more${RESET}`);
    console.error(
        `  ${RED}\u2022${RESET} ${f.pkgRel} version is still ${BOLD}${f.current ?? "<missing>"}${RESET} (base ${DIM}${f.base ?? "<unknown>"}${RESET}).`,
    );
}
console.error(`${DIM}${"\u2500".repeat(50)}${RESET}`);
console.error(`${YELLOW}How to fix:${RESET}`);
console.error(`  1. Bump "version" (semver patch/minor/major) in the package.json listed above.`);
console.error(`  2. ${DIM}git add <that package.json>${RESET} and commit again.`);
console.error(`${DIM}(Bypass intentionally with git commit --no-verify — e.g. generated-only changes.)${RESET}`);
console.error("");
process.exit(1);
