/**
 * In-memory ring of recent log lines surfaced in the renderer's Debug
 * panel. Lives in its own module so any subsystem (cloudflared
 * subprocess, lan-announce, server routes) can push without circular
 * imports through main.ts.
 *
 * The ring is bounded so a chatty subprocess can't unbounded-grow it.
 */

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

const DEBUG_LOG_MAX = 500;
const ring: string[] = [];

export type DebugLogEntry = { ts: number; level: "info" | "warn" | "error"; line: string };
const subscribers = new Set<(e: DebugLogEntry) => void>();

/** Subscribe to live log lines. Returns an unsubscribe. Used by the
 *  WS server to fan out `log:line` frames to connected web clients so
 *  the Devices page can render a realtime console for each companion. */
export function subscribeDebugLog(fn: (e: DebugLogEntry) => void): () => void {
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
}

let LOG_FILE: string | null = null;
try {
    const dir = app.getPath("logs");
    fs.mkdirSync(dir, { recursive: true });
    LOG_FILE = path.join(dir, "main.log");
} catch { /* not in electron context or no perms */ }

export function pushDebugLog(level: "info" | "warn" | "error", ...args: unknown[]): void {
    const ts = Date.now();
    const line = `[${new Date(ts).toISOString()}] [${level}] ${args
        .map((a) => (a instanceof Error ? `${a.stack ?? a.message}` : typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ")}`;
    ring.push(line);
    if (ring.length > DEBUG_LOG_MAX) ring.splice(0, ring.length - DEBUG_LOG_MAX);
    if (LOG_FILE) {
        try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch { /* ignore */ }
    }
    try { process.stderr.write(line + "\n"); } catch { /* ignore */ }
    if (subscribers.size > 0) {
        const entry: DebugLogEntry = { ts, level, line };
        for (const fn of subscribers) {
            try { fn(entry); } catch { /* never let a bad listener break logging */ }
        }
    }
}

export function getDebugLogSnapshot(): string[] {
    return ring.slice();
}

export function clearDebugLog(): void {
    ring.length = 0;
}
