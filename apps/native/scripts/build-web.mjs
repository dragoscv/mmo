#!/usr/bin/env node
// Copies web/ → dist/ so `cap sync` has a webDir to bundle. No deps.
// The shell page is a plain HTML file; Tauri reads web/ directly
// (frontendDist), Capacitor reads dist/ (webDir).
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "web");
const out = resolve(root, "dist");

if (!existsSync(resolve(src, "index.html"))) {
    console.error(`build-web: ${src}/index.html not found`);
    process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(src, out, { recursive: true });

if (!existsSync(resolve(out, "index.html")) || !existsSync(resolve(out, "tokens.css"))) {
    console.error("build-web: copy incomplete (index.html / tokens.css missing in dist/)");
    process.exit(1);
}
console.log(`build-web: web/ → dist/ (${out})`);
