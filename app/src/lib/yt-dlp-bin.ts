/**
 * yt-dlp binary resolver.
 *
 * The web app runs on serverless platforms (Vercel) where there is **no**
 * `yt-dlp` on `PATH`, so a naive `spawn("yt-dlp", ...)` fails with
 * `ENOENT: spawn yt-dlp`. This module resolves a usable yt-dlp executable
 * with the following precedence:
 *
 *   1. `YT_DLP_PATH` env var — an operator-provided absolute path. Used
 *      verbatim. (Companion installs, custom Docker images, CI.)
 *   2. A system `yt-dlp` already on `PATH` — probed once via `--version`.
 *      This is the fast path for local dev and the desktop companion.
 *   3. The official **self-contained standalone** binary, downloaded on
 *      first use into a writable temp cache (`/tmp` on Vercel). The Linux
 *      build bundles its own Python, so it runs in the bare lambda
 *      sandbox with zero system dependencies.
 *
 * The resolved binary path is memoised in module scope so warm lambda
 * invocations reuse it without re-probing or re-downloading. Concurrent
 * cold-start requests share a single in-flight download via a promise
 * latch.
 *
 * Zero npm dependencies — only Node builtins — so it adds nothing to the
 * function bundle and can't break the install.
 */
import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Pin a known-good release by default so behaviour is reproducible. Override
// with `YT_DLP_VERSION` (e.g. a tag like "2025.05.22") or "latest".
const DEFAULT_YT_DLP_VERSION = "2025.09.26";

/** Map the current platform/arch to the matching standalone release asset. */
function assetNameForPlatform(): string {
    const platform = process.platform;
    const arch = process.arch;
    if (platform === "win32") return "yt-dlp.exe";
    if (platform === "darwin") return "yt-dlp_macos";
    // linux (Vercel/AWS Lambda) — the *_linux build is fully self-contained
    // (bundles Python), the generic "yt-dlp" zipimport build needs a system
    // Python which the lambda sandbox does not have.
    if (arch === "arm64") return "yt-dlp_linux_aarch64";
    if (arch === "arm") return "yt-dlp_linux_armv7l";
    return "yt-dlp_linux";
}

function downloadUrl(version: string, asset: string): string {
    const tag = version === "latest" ? "latest/download" : `download/${version}`;
    return `https://github.com/yt-dlp/yt-dlp/releases/${tag}/${asset}`;
}

/** Writable cache directory. `/tmp` is the only writable FS on Vercel. */
function cacheDir(): string {
    return path.join(os.tmpdir(), "mmo-yt-dlp");
}

function cachedBinaryPath(version: string): string {
    const asset = assetNameForPlatform();
    // Include the version in the filename so a version bump invalidates the
    // cache without a manual purge.
    const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, "_");
    const ext = process.platform === "win32" ? ".exe" : "";
    return path.join(cacheDir(), `yt-dlp-${safeVersion}${ext}`);
}

/** Run a binary with a single arg and resolve true if it exits cleanly. */
function probe(bin: string, arg = "--version", timeoutMs = 8_000): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (ok: boolean) => {
            if (settled) return;
            settled = true;
            resolve(ok);
        };
        try {
            const proc = spawn(bin, [arg], { windowsHide: true });
            proc.on("error", () => done(false));
            proc.on("close", (code) => done(code === 0));
            const timer = setTimeout(() => {
                try { proc.kill("SIGKILL"); } catch { /* already gone */ }
                done(false);
            }, timeoutMs);
            proc.on("close", () => clearTimeout(timer));
        } catch {
            done(false);
        }
    });
}

async function downloadStandalone(version: string): Promise<string> {
    const dest = cachedBinaryPath(version);

    // Already cached & executable from a previous (warm) invocation.
    if (fs.existsSync(dest)) return dest;

    await fsp.mkdir(cacheDir(), { recursive: true });

    const asset = assetNameForPlatform();
    const url = downloadUrl(version, asset);

    const res = await fetch(url, {
        // GitHub release downloads redirect to the CDN; fetch follows by
        // default. Generous timeout: the *_linux build is ~30 MB.
        signal: AbortSignal.timeout(60_000),
        headers: { "User-Agent": "mmo-app/yt-dlp-bootstrap" },
    });
    if (!res.ok || !res.body) {
        throw new Error(`Failed to download yt-dlp (${res.status} from ${url})`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    // Write atomically: download to a temp name then rename, so a crash
    // mid-write can't leave a truncated "valid-looking" binary behind that a
    // later invocation would try to exec.
    const tmp = `${dest}.${process.pid}.${Date.now()}.part`;
    await fsp.writeFile(tmp, buf, { mode: 0o755 });
    try {
        await fsp.rename(tmp, dest);
    } catch (err) {
        // Lost a race with a concurrent download — that's fine, the winner's
        // file is valid. Clean up our temp copy.
        await fsp.rm(tmp, { force: true }).catch(() => { /* best effort */ });
        if (!fs.existsSync(dest)) throw err;
    }

    // chmod again on the final path (rename preserves mode, but be explicit
    // on platforms where the umask stripped the +x bit).
    if (process.platform !== "win32") {
        await fsp.chmod(dest, 0o755).catch(() => { /* mode already ok */ });
    }

    return dest;
}

// Memoised resolution — survives across requests on a warm lambda.
let resolvedBinary: string | null = null;
let inFlight: Promise<string> | null = null;

async function resolve(): Promise<string> {
    // 1. Explicit operator override.
    const override = process.env.YT_DLP_PATH;
    if (override && override.trim()) return override.trim();

    // 2. System install on PATH (fast path for dev / companion).
    if (await probe("yt-dlp")) return "yt-dlp";

    // 3. Download the self-contained standalone binary.
    const version = process.env.YT_DLP_VERSION?.trim() || DEFAULT_YT_DLP_VERSION;
    return downloadStandalone(version);
}

/**
 * Resolve an executable yt-dlp path/command. Cached after the first
 * successful resolution; concurrent callers share one in-flight resolve.
 */
export async function resolveYtDlpBinary(): Promise<string> {
    if (resolvedBinary) return resolvedBinary;
    if (!inFlight) {
        inFlight = resolve()
            .then((bin) => {
                resolvedBinary = bin;
                return bin;
            })
            .finally(() => {
                inFlight = null;
            });
    }
    return inFlight;
}

/** Test/maintenance helper to clear the memoised resolution. */
export function _resetYtDlpBinaryCache(): void {
    resolvedBinary = null;
    inFlight = null;
}
