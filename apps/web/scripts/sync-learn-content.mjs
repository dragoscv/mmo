#!/usr/bin/env node
/**
 * Copy the repo-root markdown corpus into `apps/web/learn-content/` so the
 * `/learn` route can read it at runtime. All source folders now live under
 * the repo-root `docs/` tree (`../../docs/{concept,organizare,genuri,
 * echipament,glosar}` plus the general `docs/` pages themselves). That is
 * fine in dev and on Vercel during the build phase, but at runtime we
 * need them inside `apps/web/` so Next.js outputFileTracing bundles them
 * into the serverless function. Idempotent — wipes the destination
 * each time so deletions in the source propagate.
 *
 * The `/learn/<slug>` URLs are kept stable (concept, docs, organizare,
 * genuri, echipament, glosar) even though the physical folders moved under
 * `docs/`. The `docs` section reads only the general docs pages and skips
 * the sibling sub-corpora (and `versuri`) so nothing is double-listed.
 */

import { mkdirSync, readdirSync, statSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SOURCE_BASE = resolve(ROOT, "..", "..");
const DEST = resolve(ROOT, "learn-content");

// Section slug -> source path relative to the repo root. URL slugs are kept
// stable; the physical corpora now live under `docs/`.
const SECTIONS = {
    concept: "docs/concept",
    docs: "docs",
    organizare: "docs/organizare",
    genuri: "docs/genuri",
    echipament: "docs/echipament",
    glosar: "docs/glosar",
};

// Sub-paths (relative to the section source) skipped when copying. Used to
// keep the `docs` section from re-including the sibling corpora that now
// live inside `docs/` and the non-learn `versuri` lyric folder.
const SKIP = {
    docs: new Set(["concept", "organizare", "genuri", "echipament", "glosar", "versuri"]),
};

function copyTree(src, dst, skip) {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src)) {
        if (skip && skip.has(entry)) continue;
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
const sectionSlugs = Object.keys(SECTIONS);
for (const section of sectionSlugs) {
    const src = join(SOURCE_BASE, SECTIONS[section]);
    if (!existsSync(src)) {
        console.warn(`[sync-learn-content] skip missing: ${src}`);
        continue;
    }
    const dst = join(DEST, section);
    copyTree(src, dst, SKIP[section]);
    copied += 1;
}

console.log(`[sync-learn-content] copied ${copied}/${sectionSlugs.length} sections into ${DEST}`);
