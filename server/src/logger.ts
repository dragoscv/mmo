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

import { pushDebugLog } from "./debug-log";

export function log(level: "info" | "warn" | "error", ...args: unknown[]): void {
    // Route through the debug ring so the line shows up in the in-app
    // Debug panel AND the per-device console streamed to the web app.
    // pushDebugLog already writes to the same main.log + stderr.
    pushDebugLog(level, ...args);
}
