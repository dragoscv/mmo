#!/usr/bin/env node
// Downloads the GiantSteps Key + Tempo datasets into a PRIVATE cache (WP18-15, D69).
// The audio is Beatport-copyrighted preview material: benchmark use only, never commit or redistribute it.
//
//   node crates/mixai-listen-bench/fetch-giantsteps.mjs <cacheDir> [--only key|tempo|mtg] [--limit N]
//
// Layout produced: <cache>/key/{audio,annotations/key}, <cache>/tempo/{audio,annotations_v2/tempo},
// <cache>/mtg/{audio,annotations/key} (GiantSteps-MTG: training only, disjoint from the key test set; not
// fetched unless asked with --only mtg).
// Idempotent: files with a matching md5 are skipped. Exits 1 when fewer than 95 % of files arrive.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SETS = {
    key: { repo: "https://github.com/GiantSteps/giantsteps-key-dataset.git", mirrors: ["https://www.cp.jku.at/datasets/giantsteps/backup/", "https://geo-samples.beatport.com/lofi/"] },
    tempo: { repo: "https://github.com/GiantSteps/giantsteps-tempo-dataset.git", mirrors: ["https://www.cp.jku.at/datasets/giantsteps/backup/", "https://geo-samples.beatport.com/lofi/"] },
    mtg: { repo: "https://github.com/GiantSteps/giantsteps-mtg-key-dataset.git", mirrors: ["https://geo-samples.beatport.com/lofi/", "https://www.cp.jku.at/datasets/giantsteps/mtg_key_backup/"], optIn: true },
};

const args = process.argv.slice(2);
const cache = args[0];
if (!cache || cache.startsWith("--")) {
    console.error("usage: fetch-giantsteps.mjs <cacheDir> [--only key|tempo] [--limit N]");
    process.exit(2);
}
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;

const md5 = (buf) => createHash("md5").update(buf).digest("hex");

async function fetchWithRetry(url, tries = 3) {
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
            if (res.ok) return Buffer.from(await res.arrayBuffer());
            if (res.status === 404) return null;
        } catch {
            /* retry */
        }
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
    return null;
}

async function pool(items, n, fn) {
    let next = 0;
    await Promise.all(
        Array.from({ length: n }, async () => {
            while (next < items.length) await fn(items[next++]);
        }),
    );
}

let failed = false;
for (const [name, set] of Object.entries(SETS)) {
    if (only ? only !== name : set.optIn) continue;
    const dir = join(cache, name);
    if (!existsSync(join(dir, ".git"))) {
        mkdirSync(cache, { recursive: true });
        execFileSync("git", ["clone", "--depth", "1", set.repo, dir], { stdio: "inherit" });
    }
    const audio = join(dir, "audio");
    mkdirSync(audio, { recursive: true });
    const md5Dir = join(dir, "md5");
    const ids = readdirSync(md5Dir)
        .filter((f) => f.endsWith(".md5"))
        .map((f) => f.slice(0, -4))
        .slice(0, limit);
    let ok = 0;
    let fromCache = 0;
    await pool(ids, 8, async (id) => {
        const want = readFileSync(join(md5Dir, `${id}.md5`), "utf8").trim().split(/\s+/)[0];
        const dest = join(audio, `${id}.mp3`);
        if (existsSync(dest) && md5(readFileSync(dest)) === want) {
            ok++;
            fromCache++;
            return;
        }
        for (const base of set.mirrors) {
            const buf = await fetchWithRetry(`${base}${id}.mp3`);
            if (buf && md5(buf) === want) {
                writeFileSync(dest, buf);
                ok++;
                return;
            }
        }
        console.error(`${name}: ${id}.mp3 unavailable`);
    });
    console.log(`${name}: ${ok}/${ids.length} audio files (${fromCache} already cached)`);
    if (ok < ids.length * 0.95) failed = true;
}
process.exit(failed ? 1 : 0);
