#!/usr/bin/env node
/**
 * Copy the repo-root markdown corpus into `apps/web/learn-content/` so the
 * `/learn` route can read it at runtime. Source folders live at the repo
 * root (`../../{concept,docs,organizare,genuri,echipament,glosar}`) which is
 * fine in dev and on Vercel during the build phase, but at runtime we
 * need them inside `apps/web/` so Next.js outputFileTracing bundles them
 * into the serverless function. Idempotent — wipes the destination
 * each time so deletions in the source propagate.
 */

import { mkdirSync, readdirSync, statSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SOURCE_BASE = resolve(ROOT, "..", "..");
const DEST = resolve(ROOT, "learn-content");

// Six top-level folders the user asked us to surface under /learn.
const SECTIONS = ["concept", "docs", "organizare", "genuri", "echipament", "glosar"];

function copyTree(src, dst) {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src)) {
        const s = join(src, entry);
        const d = join(dst, entry);
        const st = statSync(s);
        if (st.isDirectory()) {
            copyTree(s, d);
        } else if (entry.endsWith(".md")) {
            copyFileSync(s, d);
        }
    }
}

if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

let copied = 0;
for (const section of SECTIONS) {
    const src = join(SOURCE_BASE, section);
    if (!existsSync(src)) {
        console.warn(`[sync-learn-content] skip missing: ${src}`);
        continue;
    }
    const dst = join(DEST, section);
    copyTree(src, dst);
    copied += 1;
}

console.log(`[sync-learn-content] copied ${copied}/${SECTIONS.length} sections into ${DEST}`);
