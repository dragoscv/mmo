#!/usr/bin/env node
// Copies the release engine binary next to the Tauri app as a sidecar with the target-triple suffix
// Tauri's `bundle.externalBin` expects: src-tauri/binaries/mixai-live-engine-<triple>[.exe].
//
//   node scripts/copy-engine.mjs [--target <triple>] [--from <path-to-binary>]
//
// Build the engine first (from the repo root, through the shared build lock):
//   cargo build --release -p live-cli --manifest-path apps/live/engine/Cargo.toml
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const args = process.argv.slice(2);
const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};

function hostTriple() {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const m = /^host:\s*(\S+)/m.exec(out);
    if (!m) throw new Error("could not read the host triple from `rustc -vV`");
    return m[1];
}

const triple = opt("--target") ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple();
const ext = triple.includes("windows") ? ".exe" : "";
const engineTarget = resolve(app, "..", "engine", "target");
const candidates = [
    opt("--from"),
    join(engineTarget, triple, "release", `mixai-live-engine${ext}`),
    join(engineTarget, "release", `mixai-live-engine${ext}`),
].filter(Boolean);
const from = candidates.find((p) => existsSync(p));
if (!from) {
    console.error(`engine binary not found; looked in:\n  ${candidates.join("\n  ")}`);
    console.error("build it: cargo build --release -p live-cli --manifest-path apps/live/engine/Cargo.toml");
    process.exit(1);
}
const dest = join(app, "src-tauri", "binaries", `mixai-live-engine-${triple}${ext}`);
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(from, dest);
console.log(`copied ${from} -> ${dest} (${(statSync(dest).size / 1024 / 1024).toFixed(1)} MiB)`);
