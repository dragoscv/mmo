#!/usr/bin/env node
// Drift guard: every Express route registered under server/src must appear in
// server/openapi.yaml (and vice versa). Run with `pnpm openapi:check`.
//
// Route discovery is textual on purpose — it needs no build step and no
// server bootstrap. It handles:
//   - `app.get("/x", …)`, `router.post("/y", …)`, `r.delete(…)`, `.all(…)`
//   - a newline between `(` and the path literal (prettier wraps long calls)
//   - Express 5 params `:id` → `{id}` and splats `*name` → `{name}`
//   - router mount prefixes (`app.use("/library", createLibraryRouter(…))`)
//     mapped per file below.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "..");
const srcRoot = join(serverRoot, "src");
const specPath = join(serverRoot, "openapi.yaml");

/** Mount prefix per router file (relative to server/src, forward slashes). */
const MOUNTS = {
    "server.ts": "",
    "library/routes.ts": "/library",
    "library/video-routes.ts": "/video",
    "library/watch-party.ts": "/video",
    "subsonic/router.ts": "/rest",
    "sync/http-router.ts": "/v1/sync",
    "projects/router.ts": "/projects",
    "profile/routes.ts": "/mixai-profile",
    "plugins/routes.ts": "/plugins",
    "render/router.ts": "/render",
    "voice/router.ts": "/voice",
    "cast/router.ts": "/cast",
    "pair/router.ts": "/pair",
};

const ROUTE_RE = /\b(?:app|router|r)\.(get|post|put|patch|delete|all)\(\s*"(\/[^"]*)"/g;

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith(".ts") && !full.endsWith(".test.ts") && !full.endsWith(".d.ts")) out.push(full);
    }
    return out;
}

/** `/tracks/:id/audio` → `/tracks/{id}/audio`; `/audio/*filePath` → `/audio/{filePath}`. */
export function normalizeExpressPath(prefix, path) {
    const joined = (prefix + (path === "/" ? "" : path)) || "/";
    return joined
        .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}")
        .replace(/\*([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

export function collectCodeRoutes() {
    const routes = new Map(); // "METHOD path" -> file:line
    for (const file of walk(srcRoot)) {
        const rel = relative(srcRoot, file).split("\\").join("/");
        const prefix = MOUNTS[rel];
        const text = readFileSync(file, "utf8");
        let m;
        ROUTE_RE.lastIndex = 0;
        while ((m = ROUTE_RE.exec(text)) !== null) {
            if (prefix === undefined) {
                throw new Error(`${rel} registers ${m[1].toUpperCase()} ${m[2]} but has no mount prefix in openapi-check.mjs MOUNTS`);
            }
            const line = text.slice(0, m.index).split("\n").length;
            const path = normalizeExpressPath(prefix, m[2]);
            const methods = m[1] === "all" ? ["GET", "POST"] : [m[1].toUpperCase()];
            for (const method of methods) routes.set(`${method} ${path}`, `${rel}:${line}`);
        }
    }
    return routes;
}

export function collectSpecRoutes(specText) {
    const spec = parse(specText);
    const routes = new Set();
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
        for (const method of ["get", "post", "put", "patch", "delete"]) {
            if (item && item[method]) routes.add(`${method.toUpperCase()} ${path}`);
        }
    }
    return { spec, routes };
}

function main() {
    const code = collectCodeRoutes();
    const { spec, routes: specRoutes } = collectSpecRoutes(readFileSync(specPath, "utf8"));

    const missingInSpec = [...code.keys()].filter((k) => !specRoutes.has(k)).sort();
    const missingInCode = [...specRoutes].filter((k) => !code.has(k)).sort();

    const pkg = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8"));
    const versionOk = spec.info?.version === pkg.version;

    console.log(`routes in code: ${code.size}`);
    console.log(`routes in spec: ${specRoutes.size}`);
    if (!versionOk) console.log(`info.version ${spec.info?.version} != package.json ${pkg.version}`);
    for (const k of missingInSpec) console.log(`MISSING IN SPEC  ${k}  (${code.get(k)})`);
    for (const k of missingInCode) console.log(`MISSING IN CODE  ${k}`);

    const ok = missingInSpec.length === 0 && missingInCode.length === 0 && versionOk;
    console.log(ok ? "openapi-check: OK" : "openapi-check: FAILED");
    process.exit(ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
