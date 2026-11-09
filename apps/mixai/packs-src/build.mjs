#!/usr/bin/env node
// Build the official MixAI Decks packs into the web app (apps/web/src/lib/decks-packs/).
//
//   node apps/mixai/packs-src/build.mjs [--key <seed file>] [--date <iso>] [--unsigned]
//
// Signs with the official key `mixai-official-2026`. The private seed is read ONLY here, at build
// time, from outside the repo (default C:\Users\<you>\.mixai\pack-signing-key.txt, or
// $MIXAI_PACK_SIGNING_KEY_FILE). It is never printed or written anywhere.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseArgs } from "../sdk/mixaipack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../../web/src/lib/decks-packs");
const { flags } = parseArgs(process.argv.slice(2));
const keyFile = flags.key ?? process.env.MIXAI_PACK_SIGNING_KEY_FILE ?? join(homedir(), ".mixai", "pack-signing-key.txt");
const date = flags.date ?? "2026-11-09T00:00:00.000Z";
const unsigned = process.argv.includes("--unsigned");
if (!unsigned && !existsSync(keyFile)) {
    console.error(`signing key not found (${keyFile}); pass --key or --unsigned`);
    process.exit(1);
}

const TAGS = {
    "ro.mixai.skin.neon-club": ["skin", "dark", "neon", "club"],
    "ro.mixai.skin.vinyl-warm": ["skin", "light", "warm", "daylight"],
    "ro.mixai.layout.radio-host": ["layout", "radio", "library", "compact"],
    "ro.mixai.bundle.festival-pro": ["bundle", "dark", "gold", "4-decks"],
};

const log = (s) => console.log(s);
const run = (argv) => {
    const code = main(argv, log);
    if (code !== 0) process.exit(code);
};

const files = join(web, "files");
const previews = join(web, "previews");
rmSync(files, { recursive: true, force: true });
rmSync(previews, { recursive: true, force: true });
mkdirSync(files, { recursive: true });

const ids = readdirSync(here).filter((n) => statSync(join(here, n)).isDirectory() && existsSync(join(here, n, "manifest.json"))).sort();
for (const id of ids) {
    const dir = join(here, id);
    run(["preview", dir]);
    run(["validate", dir]);
    const out = join(files, `${id}.mixaipack`);
    run(["pack", dir, "-o", out, ...(unsigned ? [] : ["--sign", keyFile, "--key-id", "mixai-official-2026"])]);
}
const tagsFile = join(here, ".tags.tmp.json");
writeFileSync(tagsFile, JSON.stringify(TAGS));
try {
    run(["catalog", files, "-o", join(web, "catalog.json"), "--base-url", "/api/decks/packs", "--previews", previews, "--date", date, "--tags", tagsFile]);
} finally {
    rmSync(tagsFile, { force: true });
}
