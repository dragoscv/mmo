#!/usr/bin/env node
/**
 * Fetch + verify the bundled virtual audio drivers.
 *
 * Pulls from official upstream releases and writes them to
 *   server/assets/virtual-audio/{windows,macos}/
 * keyed by SHA-256 so a tampered download is rejected.
 *
 * Usage:
 *   node scripts/fetch-virtual-audio.mjs            # fetch missing
 *   node scripts/fetch-virtual-audio.mjs --force    # re-download
 *   node scripts/fetch-virtual-audio.mjs --no-verify
 *                                                   # bring-up only:
 *                                                   #   compute hash &
 *                                                   #   keep the file so
 *                                                   #   you can audit +
 *                                                   #   pin manually.
 *
 * Run before `pnpm dist` so electron-builder packages the binaries.
 *
 * Linux ships nothing — pactl is part of every desktop distro.
 *
 * Drivers:
 *   - macOS: BlackHole 16ch (GPL-3, Existential Audio)
 *            Direct download from existential.audio (Homebrew uses the
 *            same versioned URLs). The GitHub release form is gated by
 *            an email signup, but the underlying CDN is open.
 *   - Windows: Virtual-Audio-Driver Signed (MIT, VirtualDrivers org)
 *            https://github.com/VirtualDrivers/Virtual-Audio-Driver/releases
 *
 * SHA-256 hashes are pinned so a compromised release cannot silently
 * inject malicious code into our installer. After bumping a version,
 * audit the new artifact (signature check, sandbox run, virustotal),
 * compute the hash, paste it below.
 */
import { createWriteStream, promises as fs, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, "..", "assets", "virtual-audio");
const FORCE = process.argv.includes("--force");
const SKIP_HASH_CHECK = process.argv.includes("--no-verify");

/**
 * Each entry: { url, dest (relative to ASSETS_DIR), sha256, [postProcess] }.
 *
 * Set sha256 to "" only during initial bring-up; production builds reject
 * empty hashes unless --no-verify is passed.
 */
const ARTIFACTS = [
    {
        // BlackHole 16ch installer pkg (universal, signed + notarised by
        // Existential Audio). Direct CDN URL — Homebrew uses the same.
        url: "https://existential.audio/downloads/BlackHole16ch-0.6.1.pkg",
        dest: "macos/BlackHole.16ch.pkg",
        sha256: "43f39f30ac9c1a455a90840345725ce6e3e2c3f69f69a7aaaf15b1edbf0a9de2",
    },
    {
        // Virtual-Audio-Driver "Signed" release zip. Contains:
        //   Virtual Audio Driver/VirtualAudioDriver.inf
        //   Virtual Audio Driver/VirtualAudioDriver.sys
        //   Virtual Audio Driver/virtualaudiodriver.cat
        url: "https://github.com/VirtualDrivers/Virtual-Audio-Driver/releases/download/25.7.14/Virtual.Audio.Driver.Signed.-.25.7.14.zip",
        dest: "windows/_vad-signed.zip",
        sha256: "dd10560994de65a7e587fb8b93c0d7e9838292d9c3566a0976c2786d727292bd",
        postProcess: extractVadZip,
    },
];

async function sha256File(p) {
    return new Promise((resolve, reject) => {
        const h = createHash("sha256");
        createReadStream(p)
            .on("data", c => h.update(c))
            .on("end", () => resolve(h.digest("hex")))
            .on("error", reject);
    });
}

async function download(url, dest) {
    process.stdout.write(`  ↓ ${url}\n`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const out = createWriteStream(dest);
    await pipeline(Readable.fromWeb(res.body), out);
}

/**
 * Unzip the VAD Signed release into the windows/ folder. Uses the
 * platform-native unzip tool to avoid pulling in a Node dependency.
 */
async function extractVadZip(zipPath) {
    const winDir = path.join(ASSETS_DIR, "windows");
    process.stdout.write(`  ↳ extracting ${path.basename(zipPath)}\n`);
    if (os.platform() === "win32") {
        execFileSync("powershell.exe", [
            "-NoProfile",
            "-Command",
            `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${winDir}'`,
        ], { stdio: "inherit" });
    } else {
        execFileSync("unzip", ["-o", zipPath, "-d", winDir], { stdio: "inherit" });
    }
    // Move the contents of the inner "Virtual Audio Driver/" folder up
    // one level so windows.ts can read them at predictable paths.
    const inner = path.join(winDir, "Virtual Audio Driver");
    try {
        const entries = await fs.readdir(inner);
        for (const f of entries) {
            const target = path.join(winDir, normaliseVadFilename(f));
            await fs.rm(target, { force: true });
            await fs.rename(path.join(inner, f), target);
        }
        await fs.rmdir(inner);
    } catch (err) {
        if (err.code !== "ENOENT") throw err;
    }
    // Drop the zip — reproducible from the URL + hash.
    await fs.rm(zipPath, { force: true });
}

/**
 * Canonicalise upstream filename casing so case-sensitive build hosts
 * (Linux/macOS) and case-insensitive ones (Windows) agree.
 */
function normaliseVadFilename(name) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".inf")) return "VirtualAudioDriver.inf";
    if (lower.endsWith(".sys")) return "VirtualAudioDriver.sys";
    if (lower.endsWith(".cat")) return "VirtualAudioDriver.cat";
    return name;
}

async function ensureArtifact(art) {
    const dest = path.join(ASSETS_DIR, art.dest);
    let exists = false;
    try {
        await fs.access(dest);
        exists = true;
    } catch { /* missing */ }

    if (exists && !FORCE) {
        if (art.sha256) {
            const got = await sha256File(dest);
            if (got === art.sha256) {
                process.stdout.write(`  ✓ ${art.dest} (verified, sha256=${got.slice(0, 12)}…)\n`);
                if (art.postProcess) await art.postProcess(dest);
                return;
            }
            process.stdout.write(`  ! ${art.dest} hash mismatch — re-downloading\n`);
        } else if (SKIP_HASH_CHECK) {
            const got = await sha256File(dest);
            process.stdout.write(`  · ${art.dest} present, sha256=${got}\n`);
            if (art.postProcess) await art.postProcess(dest);
            return;
        }
    }

    await download(art.url, dest);
    const got = await sha256File(dest);
    if (art.sha256) {
        if (got !== art.sha256) {
            await fs.unlink(dest);
            throw new Error(
                `SHA-256 mismatch for ${art.dest}.\n  expected: ${art.sha256}\n  got:      ${got}\n` +
                `Audit the new release manually before updating the pinned hash.`
            );
        }
        process.stdout.write(`  ✓ ${art.dest} downloaded + verified (sha256=${got.slice(0, 12)}…)\n`);
    } else if (SKIP_HASH_CHECK) {
        process.stdout.write(`  ⚠ ${art.dest} downloaded WITHOUT hash verification\n`);
        process.stdout.write(`    sha256=${got}\n`);
        process.stdout.write(`    → paste this hash into ARTIFACTS in fetch-virtual-audio.mjs\n`);
    } else {
        await fs.unlink(dest);
        throw new Error(
            `${art.dest}: no pinned sha256 in fetch-virtual-audio.mjs.\n` +
            `Re-run with --no-verify to compute it, audit the file, then paste the hash.\n` +
            `(this download had sha256=${got})`
        );
    }
    if (art.postProcess) await art.postProcess(dest);
}

async function main() {
    process.stdout.write("Fetching virtual audio driver assets…\n");
    await fs.mkdir(path.join(ASSETS_DIR, "macos"), { recursive: true });
    await fs.mkdir(path.join(ASSETS_DIR, "windows"), { recursive: true });

    let failed = 0;
    for (const art of ARTIFACTS) {
        try {
            await ensureArtifact(art);
        } catch (err) {
            process.stderr.write(`  ✗ ${art.dest}: ${err.message}\n`);
            failed++;
        }
    }
    if (failed > 0) {
        process.stderr.write(`Done with ${failed} failure(s).\n`);
        process.exit(1);
    }
    process.stdout.write("Done.\n");
}

main().catch(err => {
    process.stderr.write(err.stack + "\n");
    process.exit(1);
});
