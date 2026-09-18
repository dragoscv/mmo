#!/usr/bin/env node
// Bundle budget gate for apps/web (First Load JS per route + shared chunks).
//
//   node scripts/bundle-budget.mjs --measure <buildlog|.next dir>            print {routes, shared} (kB)
//   node scripts/bundle-budget.mjs --measure <src> --baseline                write .bundle-baseline.json
//   node scripts/bundle-budget.mjs --check <buildlog|.next dir>              compare with the baseline, exit 1 on regression
//   … --baseline-file <path>                                                 use another baseline (mutation tests)
//
// Source of sizes:
//   * a `next build --webpack` log — the "Route (app) … First Load JS" table is parsed;
//   * a `.next` directory (Turbopack prints no sizes) — sizes are summed from the client
//     manifests (`build-manifest.json` + `server/app/**/page_client-reference-manifest.js`).
//   Never compare a webpack-log baseline with a `.next` measurement: the two methods count
//   differently. `.bundle-baseline.json` records `method` and --check refuses a mismatch.
//
// Seeding: `pnpm build:webpack > .copilot-tmp/build.log; node scripts/bundle-budget.mjs --measure .copilot-tmp/build.log --baseline`
// (or, after a Turbopack build, `--measure .next --baseline`).
//
// Thresholds: route > baseline × 1.10 AND > baseline + 25 kB → fail (either alone passes);
// shared > baseline + 20 kB → fail. Routes new in this build are reported, never failed.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROUTE_PCT = 0.10;
const ROUTE_ABS_KB = 25;
const SHARED_ABS_KB = 20;

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const BASELINE_PATH = arg("--baseline-file") ? resolve(arg("--baseline-file")) : join(here, "..", ".bundle-baseline.json");
const measureSrc = arg("--measure");
const checkSrc = arg("--check");
const writeBaseline = args.includes("--baseline");

const toKb = (n, unit) => { const v = parseFloat(n); return unit === "MB" ? v * 1024 : unit === "B" ? v / 1024 : v; };
const round = (kb) => Math.round(kb * 10) / 10;

function measureLog(path) {
    const lines = readFileSync(path, "utf8").replace(/\r/g, "").split("\n");
    const routes = {};
    let shared = null;
    let inTable = false;
    let sawSizes = false;
    for (const raw of lines) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
        if (/^Route \(app\)/.test(line)) { inTable = true; sawSizes = /First Load JS/.test(line); continue; }
        if (!inTable) continue;
        if (/First Load JS shared by all/.test(line)) {
            const m = line.match(/([\d.]+)\s*(kB|MB|B)/);
            if (m) shared = round(toKb(m[1], m[2]));
            continue;
        }
        const m = line.match(/^\s*[┌├└]\s+\S\s+(\/\S*)\s+([\d.]+)\s*(kB|MB|B)\s+([\d.]+)\s*(kB|MB|B)/);
        if (m) routes[m[1]] = round(toKb(m[4], m[5]));
    }
    if (!sawSizes || !Object.keys(routes).length) {
        console.error(`bundle-budget: no "First Load JS" table in ${path} (Turbopack build? use --measure <.next dir> or build:webpack)`);
        process.exit(2);
    }
    return { method: "webpack-log", shared, routes };
}

function measureNextDir(nextDir) {
    const sizeCache = new Map();
    const size = (f) => {
        if (!sizeCache.has(f)) { const p = join(nextDir, f); sizeCache.set(f, existsSync(p) ? statSync(p).size : 0); }
        return sizeCache.get(f);
    };
    const filesOf = (manifest) => {
        const out = [];
        for (const key of ["rootMainFiles", "polyfillFiles"]) for (const f of manifest[key] ?? []) if (f.endsWith(".js")) out.push(f);
        for (const list of Object.values(manifest.pages ?? {})) if (Array.isArray(list)) for (const f of list) if (f.endsWith(".js")) out.push(f);
        return out;
    };
    const rootManifest = join(nextDir, "build-manifest.json");
    if (!existsSync(rootManifest)) { console.error(`bundle-budget: ${rootManifest} not found — run a build first`); process.exit(2); }
    const rootFiles = filesOf(JSON.parse(readFileSync(rootManifest, "utf8")));
    const appDir = join(nextDir, "server", "app");
    const found = [];
    (function walk(dir) {
        let items; try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const it of items) {
            const p = join(dir, it.name);
            if (it.isDirectory()) walk(p); else if (it.name === "page_client-reference-manifest.js") found.push(p);
        }
    })(appDir);
    const entries = [];
    for (const p of found) {
        const rel = relative(appDir, p).split(sep).slice(0, -1).join("/");
        const route = rel === "" ? "/" : "/" + rel;
        const src = readFileSync(p, "utf8");
        const marker = src.indexOf("] = {");
        if (marker < 0) continue;
        let o; try { o = JSON.parse(src.slice(marker + 4).trim().replace(/;\s*$/, "")); } catch { continue; }
        const files = new Set(rootFiles);
        for (const list of Object.values(o.entryJSFiles ?? {})) for (const f of list) if (typeof f === "string" && f.endsWith(".js")) files.add(f.replace(/^\/_next\//, ""));
        entries.push([route, files]);
    }
    let shared = null;
    for (const [, files] of entries) shared = shared === null ? new Set(files) : new Set([...shared].filter((f) => files.has(f)));
    shared ??= new Set(rootFiles);
    const routes = {};
    for (const [route, files] of entries) routes[route] = round([...files].reduce((n, f) => n + size(f), 0) / 1024);
    return { method: "next-dir", shared: round([...shared].reduce((n, f) => n + size(f), 0) / 1024), routes };
}

function measure(src) {
    const p = resolve(src);
    if (!existsSync(p)) { console.error(`bundle-budget: ${p} does not exist`); process.exit(2); }
    return statSync(p).isDirectory() ? measureNextDir(p) : measureLog(p);
}

const fmt = (kb) => kb == null ? "—" : `${kb.toFixed(1)} kB`;
const delta = (a, b) => a == null || b == null ? "—" : `${b - a >= 0 ? "+" : ""}${(b - a).toFixed(1)} kB (${a ? (((b - a) / a) * 100).toFixed(0) : "∞"}%)`;

if (measureSrc) {
    const m = measure(measureSrc);
    const out = { method: m.method, generatedAt: new Date().toISOString(), source: measureSrc, shared: m.shared, routes: Object.fromEntries(Object.entries(m.routes).sort()) };
    if (writeBaseline) {
        writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 2) + "\n");
        console.log(`bundle-budget: wrote ${relative(process.cwd(), BASELINE_PATH)} (${Object.keys(out.routes).length} routes, shared ${fmt(out.shared)}, method ${out.method})`);
    } else {
        console.log(JSON.stringify(out, null, 2));
    }
    process.exit(0);
}

if (checkSrc) {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    const current = measure(checkSrc);
    if (!Object.keys(baseline.routes ?? {}).length) {
        console.log("bundle-budget: baseline is empty — nothing to compare. Seed it with `--measure <src> --baseline`.");
        process.exit(0);
    }
    if (baseline.method && baseline.method !== current.method) {
        console.error(`bundle-budget: baseline method "${baseline.method}" ≠ measurement "${current.method}"; re-seed or measure the same way`);
        process.exit(2);
    }
    const rows = [];
    const failures = [];
    if (baseline.shared != null && current.shared != null && current.shared > baseline.shared + SHARED_ABS_KB) {
        failures.push(`shared: ${fmt(baseline.shared)} → ${fmt(current.shared)} (> +${SHARED_ABS_KB} kB)`);
    }
    rows.push(["**shared by all**", baseline.shared, current.shared, failures.length ? "❌" : "✅"]);
    const newRoutes = [];
    for (const [route, kb] of Object.entries(current.routes).sort()) {
        const b = baseline.routes[route];
        if (b == null) { newRoutes.push(route); rows.push([route, null, kb, "🆕"]); continue; }
        const over = kb > b * (1 + ROUTE_PCT) && kb > b + ROUTE_ABS_KB;
        if (over) failures.push(`${route}: ${fmt(b)} → ${fmt(kb)} (> ×${1 + ROUTE_PCT} and > +${ROUTE_ABS_KB} kB)`);
        if (over || Math.abs(kb - b) >= 1) rows.push([route, b, kb, over ? "❌" : "✅"]);
    }
    const removed = Object.keys(baseline.routes).filter((r) => !(r in current.routes));
    console.log(`| Route | Baseline | Current | Δ | |\n|---|---:|---:|---:|:-:|`);
    for (const [r, b, c, s] of rows) console.log(`| \`${r}\` | ${fmt(b)} | ${fmt(c)} | ${delta(b, c)} | ${s} |`);
    console.log(`\n${Object.keys(current.routes).length} routes measured, ${rows.length - 1} changed ≥1 kB, ${newRoutes.length} new, ${removed.length} removed (method ${current.method})`);
    if (failures.length) {
        console.error(`\nbundle-budget: FAIL\n  - ${failures.join("\n  - ")}\nIf intentional: node scripts/bundle-budget.mjs --measure ${checkSrc} --baseline`);
        process.exit(1);
    }
    console.log("bundle-budget: OK");
    process.exit(0);
}

console.error("usage: bundle-budget.mjs --measure <buildlog|.next> [--baseline] | --check <buildlog|.next>");
process.exit(2);
