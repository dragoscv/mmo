#!/usr/bin/env node
// Gate: the server file traces of a web build (`.next/server/**/*.nft.json`) must stay inside
// apps/web, packages/* and node_modules.
//
//   node scripts/trace-scope.mjs                 check ./.next of this app
//   node scripts/trace-scope.mjs --web-root=<p>  check <p>/.next (mutation tests with a fixture tree)
//
// Why: a server file that resolves the PARENT of the working directory
// (`path.resolve(process.cwd(), "..")`) makes Turbopack trace every file under `apps/`. On a
// developer machine that folder holds the Rust and Gradle build output of the other apps (93 GB on
// 2026-11-12): `next build` read all of it and grew to 100 GB of memory. The fix is the
// `/*turbopackIgnore: true*/` mark on that call; this gate fails when a trace leaves the app again.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name) => process.argv.slice(2).find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const webRoot = resolve(arg("--web-root") ?? join(here, ".."));
const repoRoot = resolve(webRoot, "..", "..");
const serverDir = join(webRoot, ".next", "server");

if (!existsSync(serverDir)) {
    console.error(`trace-scope: ${serverDir} does not exist (run the build first)`);
    process.exit(2);
}

/** `p` is a path below `root` (another drive gives an absolute "relative" path on Windows). */
const inside = (root, p) => {
    const rel = relative(root, p);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

function* traces(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) yield* traces(p);
        else if (e.name.endsWith(".nft.json")) yield p;
    }
}

let files = 0;
let entries = 0;
const bad = new Map(); // area -> { count, sample, trace }
for (const trace of traces(serverDir)) {
    files++;
    const list = JSON.parse(readFileSync(trace, "utf8")).files ?? [];
    entries += list.length;
    for (const rel of list) {
        const abs = resolve(dirname(trace), rel);
        if (!inside(repoRoot, abs)) continue; // outside the repository (a package store): not ours to judge
        if (inside(webRoot, abs)) continue;
        const parts = relative(repoRoot, abs).split(sep);
        if (parts.includes("node_modules") || parts[0] === "packages") continue;
        const area = parts[0] === "apps" ? `apps/${parts[1]}` : parts[0];
        const seen = bad.get(area);
        if (seen) seen.count++;
        else bad.set(area, { count: 1, sample: parts.join("/"), trace: relative(webRoot, trace).split(sep).join("/") });
    }
}

if (files === 0) {
    console.error(`trace-scope: no .nft.json under ${serverDir}`);
    process.exit(2);
}
if (bad.size === 0) {
    console.log(`trace-scope: ok (${files} traces, ${entries} entries, none outside apps/web, packages/* and node_modules)`);
    process.exit(0);
}
console.error(`trace-scope: ${[...bad.values()].reduce((s, b) => s + b.count, 0)} traced file(s) outside apps/web:`);
for (const [area, b] of [...bad].sort((x, y) => y[1].count - x[1].count)) {
    console.error(`  ${String(b.count).padStart(7)}  ${area}   e.g. ${b.sample}   (in ${b.trace})`);
}
console.error("A server file reaches outside the app with a path the bundler cannot narrow, usually");
console.error('path.resolve(process.cwd(), ".."). Mark the call: path.resolve(/*turbopackIgnore: true*/ process.cwd(), "..").');
console.error("See docs/arhitectura/build-performance.md (web build memory).");
process.exit(1);
