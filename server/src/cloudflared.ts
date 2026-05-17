/**
 * Cloudflared subprocess lifecycle.
 *
 * The companion runs `cloudflared tunnel --no-autoupdate run --token <t>`
 * as a child process. cloudflared opens an outbound QUIC connection to
 * the Cloudflare edge and proxies all inbound traffic to the local
 * Express server on `localhost:17899` (the destination is configured
 * server-side via the CF API by the web app — see app/src/lib/cloudflare.ts).
 *
 * Why a child process and not the `cloudflare-tunnel-rs` lib or the
 * Go SDK? Because the binary already exists, is signed, is updated
 * weekly, handles every transport/QUIC/H2/H1 quirk, and recovers from
 * its own faults. Re-implementing any of that in Node is folly.
 *
 * Crash recovery: exponential backoff capped at 60s. We never expose
 * the token via process args list (`ps`) — we pass it via env var
 * `TUNNEL_TOKEN`, which cloudflared respects.
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { pushDebugLog } from "./debug-log";

let child: ChildProcess | null = null;
let activeToken: string | null = null;
let activeHostname: string | null = null;
let backoffMs = 1000;
let restartTimer: NodeJS.Timeout | null = null;
let stopRequested = false;

/**
 * Locate the cloudflared binary shipped in extraResources. In dev we
 * fall back to the `cloudflared` npm package's downloaded binary, then
 * to a $PATH lookup so contributors don't need a custom setup.
 */
function locateBinary(): string | null {
    const isWin = process.platform === "win32";
    const exe = isWin ? "cloudflared.exe" : "cloudflared";

    // Packaged: process.resourcesPath/cloudflared/<exe>
    if (app.isPackaged) {
        const packed = path.join(process.resourcesPath, "cloudflared", exe);
        if (fs.existsSync(packed)) return packed;
    }

    // Dev: try the cloudflared npm package
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pkg = require("cloudflared") as { bin?: string };
        if (pkg.bin && fs.existsSync(pkg.bin)) return pkg.bin;
    } catch { /* not installed */ }

    // Dev: PATH lookup
    return exe;
}

export function getActiveTunnelHostname(): string | null {
    return activeHostname;
}

/**
 * Start cloudflared with the given token. If already running with the
 * same token, no-op. If running with a different token, restart.
 */
export function startCloudflared(token: string, hostname: string): void {
    if (!token || !hostname) {
        pushDebugLog("warn", `[cloudflared] startCloudflared called with empty token or hostname; ignoring`);
        return;
    }
    if (child && activeToken === token) {
        pushDebugLog("info", `[cloudflared] already running for host=${hostname} — no-op`);
        return;
    }
    stopCloudflared();
    stopRequested = false;
    activeToken = token;
    activeHostname = hostname;
    pushDebugLog("info", `[cloudflared] starting for host=${hostname}`);
    spawnOnce();
}

function spawnOnce(): void {
    const bin = locateBinary();
    if (!bin) {
        pushDebugLog("warn", "[cloudflared] binary not found; tunnel disabled");
        return;
    }
    pushDebugLog("info", `[cloudflared] spawning ${bin}`);
    try {
        child = spawn(bin, ["tunnel", "--no-autoupdate", "run"], {
            env: { ...process.env, TUNNEL_TOKEN: activeToken ?? "" },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
    } catch (err) {
        pushDebugLog("warn", "[cloudflared] spawn failed:", err instanceof Error ? err.message : String(err));
        scheduleRestart();
        return;
    }

    child.stdout?.on("data", (b: Buffer) => {
        pushDebugLog("info", `[cloudflared] ${b.toString().trimEnd()}`);
    });
    child.stderr?.on("data", (b: Buffer) => {
        // cloudflared logs to stderr by default — not errors.
        pushDebugLog("info", `[cloudflared] ${b.toString().trimEnd()}`);
    });

    child.once("exit", (code, signal) => {
        console.warn(`[cloudflared] exited code=${code} signal=${signal}`);
        child = null;
        if (!stopRequested) scheduleRestart();
    });

    // Successful boot resets the backoff (cloudflared takes ~3-5s to
    // establish the tunnel; if we live that long we're healthy).
    setTimeout(() => { if (child && !child.killed) backoffMs = 1000; }, 8000);
}

function scheduleRestart(): void {
    if (restartTimer) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, 60_000);
    restartTimer = setTimeout(() => {
        restartTimer = null;
        spawnOnce();
    }, delay);
}

export function stopCloudflared(): void {
    stopRequested = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (child && !child.killed) {
        try { child.kill(); } catch { /* ignore */ }
    }
    child = null;
    activeToken = null;
    activeHostname = null;
    backoffMs = 1000;
}
