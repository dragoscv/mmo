/**
 * Shared file-based logger used across the companion main process.
 *
 * Why this exists: in packaged Electron apps on Windows, console.log
 * goes nowhere — there's no terminal. The picker / queue debug needs
 * to be inspectable from `%APPDATA%\mmo-companion\logs\main.log` so
 * users can paste it into bug reports without rebuilding.
 *
 * The companion runs as a single main process; importing this from
 * any non-renderer module (lan-announce, command-worker, etc.) is safe.
 */

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

let LOG_FILE: string | null = null;
try {
    const dir = app.getPath("logs");
    fs.mkdirSync(dir, { recursive: true });
    LOG_FILE = path.join(dir, "main.log");
} catch { /* not in electron context or no perms */ }

export function log(level: "info" | "warn" | "error", ...args: unknown[]): void {
    const line = `[${new Date().toISOString()}] [${level}] ${args
        .map((a) => (a instanceof Error ? `${a.stack ?? a.message}` : typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ")}\n`;
    if (LOG_FILE) {
        try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
    }
    try { process.stderr.write(line); } catch { /* ignore */ }
}
