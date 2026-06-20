/**
 * Build the native `rbexport` sidecar and stage its binary under
 * `assets/bin/` so electron-builder picks it up via `extraResources`.
 *
 * Runs `cargo build --release` for the rbexport crate, then copies the
 * platform binary (rbexport / rbexport.exe) into assets/bin. Invoked from
 * the `dist:*` scripts before packaging.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, "..");
const crateDir = path.join(serverDir, "native", "rbexport");
const manifest = path.join(crateDir, "Cargo.toml");

const exe = process.platform === "win32" ? "rbexport.exe" : "rbexport";
const src = path.join(crateDir, "target", "release", exe);
const destDir = path.join(serverDir, "assets", "bin");
const dest = path.join(destDir, exe);

console.log("[rbexport] building release binary…");
execFileSync("cargo", ["build", "--release", "--manifest-path", manifest], {
    stdio: "inherit",
});

if (!existsSync(src)) {
    console.error(`[rbexport] expected binary not found at ${src}`);
    process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[rbexport] staged ${dest}`);
