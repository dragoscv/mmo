#!/usr/bin/env node
// Hard-coded colour gate: design tokens only (docs/design-system.md).
//
//   node scripts/hex-gate.mjs                  scan the default roots
//   node scripts/hex-gate.mjs <path> [...]     scan given files/dirs
//   node scripts/hex-gate.mjs --staged         only git-staged files (lint-staged / pre-commit)
//
// Flags `#rgb[a]`/`#rrggbb[aa]` in .ts/.tsx/.css and `Color(0x…)` in .kt, except files
// matching a glob in scripts/hex-gate.allowlist.json (generated token files, SVG logos,
// QR canvases, the Tizen sRGB fallback block). Exit 1 on any hit.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const allowlist = JSON.parse(readFileSync(join(here, "hex-gate.allowlist.json"), "utf8"));

const DEFAULT_ROOTS = [
    "packages/ui/src",
    "apps/mixai/src",
    "server/ui/src",
    "apps/tv-tizen/src",
    "apps/tv-android/app/src/main/java",
];
const EXT_RE = /\.(ts|tsx|css|kt)$/;
const HEX_RE = /#[0-9a-f]{3,8}\b/gi;
const KT_RE = /Color\(0x[0-9a-fA-F]+\)/g;
const IGNORE_DIRS = new Set(["node_modules", "dist", ".next", "build", "generated"]);

const args = process.argv.slice(2);
const staged = args.includes("--staged");
const roots = args.filter((a) => !a.startsWith("--"));

const norm = (p) => relative(repo, resolve(p)).replace(/\\/g, "/");
const globToRe = (g) => {
    const src = g
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "\u0000")
        .replace(/\*\*/g, "\u0001")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, "(?:.*/)?")
        .replace(/\u0001/g, ".*");
    return new RegExp("^" + src + "$");
};
const allowRes = allowlist.files.map(globToRe);
const isAllowed = (rel) => allowRes.some((re) => re.test(rel));

function collect(dir, out) {
    for (const it of readdirSync(dir, { withFileTypes: true })) {
        if (it.isDirectory()) { if (!IGNORE_DIRS.has(it.name)) collect(join(dir, it.name), out); }
        else if (EXT_RE.test(it.name)) out.push(join(dir, it.name));
    }
}

let files = [];
if (staged) {
    const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { cwd: repo, encoding: "utf8" });
    const inRoots = (rel) => DEFAULT_ROOTS.some((r) => rel.startsWith(r + "/"));
    files = out.split(/\r?\n/).filter((f) => f && EXT_RE.test(f) && inRoots(f)).map((f) => join(repo, f)).filter(existsSync);
} else {
    for (const r of (roots.length ? roots : DEFAULT_ROOTS)) {
        const p = resolve(repo, r);
        if (!existsSync(p)) continue;
        if (statSync(p).isDirectory()) collect(p, files); else files.push(p);
    }
}

let hits = 0;
let scanned = 0;
let skipped = 0;
for (const file of files) {
    const rel = norm(file);
    if (isAllowed(rel)) { skipped++; continue; }
    scanned++;
    const re = rel.endsWith(".kt") ? KT_RE : HEX_RE;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
        // Skip CSS custom-property fallbacks that reference tokens, e.g. var(--x, #fff) is still a hit;
        // only url(#id) SVG references and `#` inside string ids are not colours.
        const cleaned = line.replace(/url\(#[^)]*\)/g, "").replace(/href="#[^"]*"/g, "");
        for (const m of cleaned.matchAll(re)) {
            hits++;
            console.log(`${rel}:${i + 1}: ${m[0]}  ${line.trim().slice(0, 100)}`);
        }
    });
}
console.log(`hex-gate: ${scanned} files scanned, ${skipped} allowlisted, ${hits} hard-coded colour${hits === 1 ? "" : "s"}`);
if (hits) {
    console.error("hex-gate: FAIL — use tokens from @mmo/design-tokens (var(--…), Tokens.kt) or add a justified entry to scripts/hex-gate.allowlist.json");
    process.exit(1);
}
console.log("hex-gate: OK");
