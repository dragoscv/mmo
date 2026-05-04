import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { dialog, BrowserWindow } from "electron";
import { store, getSettings, updateSettings, type AuthorizedAudioDevice } from "./store";
import {
    NativeAudioEngine,
    listBackends,
    listDevices,
    resolveDeviceId,
    invalidateAudioInventoryCache,
    type AudioBackend,
    type EngineConfig,
} from "./audio/native-engine";
import type { ScaleConfig } from "./audio/pitch-dsp";
import { createLibraryRouter } from "./library/routes";
import { closeLibraryDb } from "./library/db";
import { createPluginsRouter } from "./plugins/routes";
import {
    createScanJob,
    getScanJob,
    listAllScanJobs,
    listActiveScanJobs,
    startScanJobGc,
    stopScanJobGc,
    clearJobTracks,
} from "./library/scan-jobs";
import { runScanJob } from "./library/scan-runner";
import {
    startWatcher,
    stopWatcher,
    listWatcherStatuses,
    getEventsSince,
    watcherBus,
    startWatcherGc,
    stopWatcherGc,
    stopAllWatchers,
} from "./library/watcher";

const MIME_TYPES: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".aac": "audio/aac",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".wma": "audio/x-ms-wma",
    ".aiff": "audio/aiff",
    ".aif": "audio/aiff",
    ".opus": "audio/opus",
};

let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
let serverPort = 17899;
const wsClients = new Set<WebSocket>();

// ─── Server Version ──────────────────────────────────────────────────────────
// Resolved once at module load from the bundled package.json so the value
// shown in /health, /audio/native/probe and the desktop UI always matches
// the installed build (no more stale hardcoded strings).
const SERVER_VERSION: string = (() => {
    // dist/server.js → ../package.json. In dev (ts-node) it's also one level up.
    const candidates = [
        path.join(__dirname, "..", "package.json"),
        path.join(__dirname, "..", "..", "package.json"),
    ];
    for (const p of candidates) {
        try {
            const pkg = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string };
            if (pkg.version) return pkg.version;
        } catch { /* try next */ }
    }
    return "0.0.0";
})();

export function getServerVersion(): string {
    return SERVER_VERSION;
}

// ─── Native Audio Engine (singleton) ─────────────────────────────────────────
//
// One process = one mic + one speakers. The engine is created lazily on
// the first /audio/native/start request and torn down on /audio/native/stop
// (or on process exit). All control flows through the HTTP API; the
// realtime audio path lives entirely inside the engine's RtAudio thread.
const nativeEngine = new NativeAudioEngine();
/** Accessor so the Electron main process can read live engine state via IPC
 *  without going through HTTP. Returns the singleton instance. */
export function getNativeEngine(): NativeAudioEngine { return nativeEngine; }
let nativePitchUnsub: (() => void) | null = null;
// Pitch is published over WS at most every PITCH_PUSH_MIN_MS to avoid
// flooding the wire (the DSP fires onPitch every 2.67 ms = 374 Hz).
const PITCH_PUSH_MIN_MS = 25;            // ~40 Hz throttled push
let lastPitchPushAt = 0;
// Levels (in/out peak + RMS) are pushed independently at a fixed cadence
// — they don't depend on pitch detection firing, so we use setInterval.
const LEVELS_PUSH_INTERVAL_MS = 33;      // ~30 Hz, fine for meters
let nativeLevelsTimer: ReturnType<typeof setInterval> | null = null;

// ─── Auth State Management ───────────────────────────────────────────────────

export const authEvents = new EventEmitter();
const pendingAuthStates = new Map<string, number>();

export function generateAuthState(): string {
    const state = crypto.randomUUID();
    pendingAuthStates.set(state, Date.now());
    // Cleanup states older than 5 minutes
    for (const [key, time] of pendingAuthStates) {
        if (Date.now() - time > 5 * 60 * 1000) pendingAuthStates.delete(key);
    }
    return state;
}

// ─── Auth Middleware ─────────────────────────────────────────────────────────

function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
    const token = req.headers["x-device-token"] as string;
    const storedToken = store.get("deviceToken") as string;

    if (!storedToken || token !== storedToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    next();
}

// ─── Localhost-only middleware (no auth required) ────────────────────────────
//
// Used for the realtime audio routes (/audio/native/*). The threat model:
//
//   - The companion binds to 0.0.0.0 (so other devices on the LAN can use
//     the music-library proxy), so a naive "no auth" route would let
//     anyone on the network turn on the user's mic.
//   - Random websites the user visits could try to hit
//     http://localhost:17899/* via fetch from their browser. Browsers block
//     that with CORS BUT only if we set the right headers — and DNS
//     rebinding can defeat origin checks if Host isn't validated.
//
// Defense in depth:
//
//   1. Connection MUST come from a loopback address (127.0.0.1, ::1).
//      Drops every LAN/internet attacker.
//   2. Host header MUST be "localhost" or "127.0.0.1" (any port).
//      Mitigates DNS rebinding (an attacker tricks the browser into
//      resolving evil.com → 127.0.0.1 to bypass SOP).
//   3. Origin header MUST be in the configured allowlist OR be a localhost
//      origin. Configurable per-install in companion settings.
//
// If all three pass, the route is treated as authentic — no token needed.
// This is what lets the web app's /live page Just Work after a fresh
// companion install, with zero sign-in.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopbackAddress(addr: string | undefined): boolean {
    if (!addr) return false;
    // Express may report ::ffff:127.0.0.1 (IPv4-mapped IPv6), ::1, 127.0.0.1
    return (
        addr === "127.0.0.1" ||
        addr === "::1" ||
        addr === "::ffff:127.0.0.1" ||
        addr.startsWith("127.")
    );
}

function isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return true; // Same-origin requests have no Origin header
    try {
        const u = new URL(origin);
        if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;

        // Allowlist from companion settings. Defaults to common dev + prod
        // origins for the MMO web app. Users can extend this in settings.
        const settings = getSettings();
        const allowlist = settings.audioOriginAllowlist ?? [];
        for (const pattern of allowlist) {
            if (pattern === "*") return true;
            if (pattern === origin) return true;
            // Simple wildcard suffix support: "https://*.brivio.ro"
            if (pattern.startsWith("https://*.") || pattern.startsWith("http://*.")) {
                const proto = pattern.startsWith("https://") ? "https:" : "http:";
                const suffix = pattern.slice(pattern.indexOf("*.") + 1); // ".brivio.ro"
                if (u.protocol === proto && u.hostname.endsWith(suffix)) return true;
            }
        }
        // Also allow the configured webAppUrl exactly (set during OAuth).
        if (settings.webAppUrl) {
            try {
                const w = new URL(settings.webAppUrl);
                if (u.origin === w.origin) return true;
            } catch { /* malformed webAppUrl in store, ignore */ }
        }
        return false;
    } catch {
        return false;
    }
}

function publicLocalhostMiddleware(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
) {
    // 1. Loopback only.
    const remote = req.socket.remoteAddress ?? req.ip;
    if (!isLoopbackAddress(remote)) {
        res.status(403).json({ error: "Forbidden: non-loopback origin" });
        return;
    }

    // 2. Host header check.
    const host = (req.headers.host ?? "").split(":")[0];
    if (!LOOPBACK_HOSTS.has(host)) {
        res.status(403).json({ error: "Forbidden: invalid host" });
        return;
    }

    // 3. Origin header check (mitigates same-host browser attacks).
    const origin = req.headers.origin as string | undefined;
    if (!isAllowedOrigin(origin)) {
        res.status(403).json({ error: "Forbidden: origin not allowed" });
        return;
    }

    next();
}

// ─── Server Setup ────────────────────────────────────────────────────────────

export function getServerPort(): number {
    return serverPort;
}

export async function startServer(): Promise<void> {
    const settings = getSettings();
    serverPort = settings.serverPort;

    const app = express();
    app.use(cors({
        origin: true,
        credentials: true,
    }));
    // Bump JSON limit well above the express default (100 KB). The
    // /library/tracks/ingest endpoint receives a full scan worth of
    // metadata in one POST — a 5k-track library easily clears 5 MB.
    // 64 MB is comfortably above any realistic single-folder scan and
    // still bounded enough to reject runaway clients. The matching
    // app-side ingest helper also chunks at 1k tracks per request as a
    // belt-and-braces measure.
    app.use(express.json({ limit: "64mb" }));

    // ─── Auth Callback (no auth middleware — this IS the auth endpoint) ───

    app.get("/auth/callback", (req, res) => {
        const { state, token, deviceId, userName, userEmail, userImage, webAppUrl } =
            req.query as Record<string, string>;

        if (!state || !pendingAuthStates.has(state)) {
            res.status(400).send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Auth Failed</title>
<style>body{background:#0a0a0a;color:#fafafa;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh}
.c{text-align:center;padding:40px}.icon{font-size:52px;margin-bottom:16px}.err{color:#ef4444}</style></head>
<body><div class="c"><div class="icon">✗</div><h2 class="err">Auth Failed</h2><p style="color:#71717a">Invalid or expired auth state. Please try again from the companion app.</p></div></body></html>`);
            return;
        }
        pendingAuthStates.delete(state);

        // Store credentials
        store.set("deviceToken", token || "");
        store.set("deviceId", deviceId || "");
        store.set("userName", userName || "");
        store.set("userEmail", userEmail || "");
        store.set("userImage", userImage || "");
        if (webAppUrl) updateSettings({ webAppUrl });

        authEvents.emit("authenticated", { deviceId, token, userName, userEmail, userImage });

        res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Connected!</title>
<style>body{background:#0a0a0a;color:#fafafa;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh}
.c{text-align:center;padding:40px}.icon{font-size:52px;margin-bottom:16px}.ok{color:#22c55e}.name{color:#a855f7;font-weight:600}</style></head>
<body><div class="c"><div class="icon">✓</div><h2 class="ok">Connected!</h2>
<p style="color:#71717a">Signed in as <span class="name">${userName || userEmail || "user"}</span></p>
<p style="margin-top:16px;color:#3f3f46;font-size:13px">You can close this tab and return to the companion app.</p></div></body></html>`);
    });

    // ─── Health / Status ─────────────────────────────────────────────────

    app.get("/health", (_req, res) => {
        res.json({
            status: "ok",
            version: SERVER_VERSION,
            hostname: os.hostname(),
            platform: process.platform,
            uptime: process.uptime(),
        });
    });

    app.get("/info", authMiddleware, (_req, res) => {
        res.json({
            hostname: os.hostname(),
            platform: process.platform,
            arch: os.arch(),
            cpus: os.cpus().length,
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
            folders: settings.scanFolders,
        });
    });

    // ─── File Streaming (audio) ──────────────────────────────────────────

    // NOTE: this catch-all is shadowed by the public `/audio/native/*` routes
    // and the device-management routes (`/audio/devices`, `/audio/devices/authorize`)
    // registered further below. Express matches routes in registration order,
    // so we must explicitly bail out for non-streaming subpaths — otherwise
    // those routes 403 here as "Path not in allowed folders" because the
    // streaming handler treats the URL tail as a filesystem path.
    app.get("/audio/*", (req, res, next) => {
        if (
            req.path.startsWith("/audio/native/") ||
            req.path === "/audio/devices" ||
            req.path.startsWith("/audio/devices/")
        ) {
            next("route");
            return;
        }
        next();
    }, authMiddleware, (req, res) => {
        // Filepath comes URL-encoded after /audio/
        const filePath = decodeURIComponent(req.params[0] || "");

        if (!filePath) {
            res.status(400).json({ error: "No file path" });
            return;
        }

        // Security: verify the file is within a configured scan folder
        const normalizedPath = path.resolve(filePath);
        const isAllowed = settings.scanFolders.some((folder) =>
            normalizedPath.startsWith(path.resolve(folder.path))
        );
        if (!isAllowed) {
            res.status(403).json({ error: "Path not in allowed folders" });
            return;
        }

        if (!fs.existsSync(normalizedPath)) {
            res.status(404).json({ error: "File not found" });
            return;
        }

        const stat = fs.statSync(normalizedPath);
        const ext = path.extname(normalizedPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";

        // Range request support for seeking
        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            const chunkSize = end - start + 1;

            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${stat.size}`,
                "Accept-Ranges": "bytes",
                "Content-Length": chunkSize,
                "Content-Type": contentType,
            });
            fs.createReadStream(normalizedPath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, {
                "Content-Length": stat.size,
                "Content-Type": contentType,
                "Accept-Ranges": "bytes",
            });
            fs.createReadStream(normalizedPath).pipe(res);
        }
    });

    // ─── Download entire file (for offline caching) ──────────────────────

    app.get("/download/*", authMiddleware, (req, res) => {
        const filePath = decodeURIComponent(req.params[0] || "");
        if (!filePath) {
            res.status(400).json({ error: "No file path" });
            return;
        }

        const normalizedPath = path.resolve(filePath);
        const isAllowed = settings.scanFolders.some((folder) =>
            normalizedPath.startsWith(path.resolve(folder.path))
        );
        if (!isAllowed) {
            res.status(403).json({ error: "Path not in allowed folders" });
            return;
        }

        if (!fs.existsSync(normalizedPath)) {
            res.status(404).json({ error: "File not found" });
            return;
        }

        const stat = fs.statSync(normalizedPath);
        const ext = path.extname(normalizedPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";

        res.writeHead(200, {
            "Content-Length": stat.size,
            "Content-Type": contentType,
            "Content-Disposition": `attachment; filename="${path.basename(normalizedPath)}"`,
        });
        fs.createReadStream(normalizedPath).pipe(res);
    });

    // ─── Folder Browsing ─────────────────────────────────────────────────

    app.get("/folders", authMiddleware, (_req, res) => {
        // Return rich entries (path + per-folder stats from the library DB).
        // Stats are computed best-effort by counting tracks whose filepath
        // is inside the folder. The web UI uses these to skip a separate
        // round trip to /library/stats per folder.
        const watcherStatuses = new Map(listWatcherStatuses().map((s) => [s.folder, s] as const));
        res.json({
            folders: settings.scanFolders.map((f) => ({
                path: f.path,
                exists: fs.existsSync(f.path),
                label: path.basename(f.path) || f.path,
                watch: !!f.watch,
                watchActive: !!watcherStatuses.get(f.path)?.active,
                watchEvents: watcherStatuses.get(f.path)?.eventsSeen ?? 0,
                watchError: watcherStatuses.get(f.path)?.error ?? null,
            })),
        });
    });

    /**
     * Open a native OS folder-picker on the companion machine and add the
     * chosen folder to scanFolders. This is the canonical way for the web
     * UI to add folders — users should never type paths by hand.
     *
     * Auth: companion device token (web app proxies via server action).
     * The dialog is shown on the focused or main window so it's modal and
     * the user can't accidentally pick folders for the wrong device.
     */
    app.post("/folders/pick", authMiddleware, async (_req, res) => {
        try {
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            const result = win
                ? await dialog.showOpenDialog(win, {
                    title: "Pick a music folder",
                    properties: ["openDirectory", "createDirectory"],
                })
                : await dialog.showOpenDialog({
                    title: "Pick a music folder",
                    properties: ["openDirectory", "createDirectory"],
                });

            if (result.canceled || result.filePaths.length === 0) {
                res.json({ canceled: true, folders: settings.scanFolders });
                return;
            }

            const picked = path.resolve(result.filePaths[0]);
            const folders = settings.scanFolders;
            if (!folders.some((f) => f.path === picked)) {
                folders.push({ path: picked, watch: false });
                store.set("scanFolders", folders);
            }
            res.json({ canceled: false, picked, folders });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/folders/add", authMiddleware, (req, res) => {
        const { path: folderPath } = req.body;
        if (!folderPath || typeof folderPath !== "string") {
            res.status(400).json({ error: "Invalid folder path" });
            return;
        }

        const resolved = path.resolve(folderPath);
        if (!fs.existsSync(resolved)) {
            res.status(404).json({ error: "Folder not found" });
            return;
        }

        const folders = settings.scanFolders;
        if (!folders.some((f) => f.path === resolved)) {
            folders.push({ path: resolved, watch: false });
            store.set("scanFolders", folders);
        }

        res.json({ success: true, folders });
    });

    app.post("/folders/remove", authMiddleware, (req, res) => {
        const { path: folderPath } = req.body;
        const folders = settings.scanFolders.filter((f) => f.path !== folderPath);
        store.set("scanFolders", folders);
        // Tear down any watcher pointed at this folder.
        void stopWatcher(folderPath);
        res.json({ success: true, folders });
    });

    /**
     * Toggle the watcher on/off for a single folder. The change is
     * persisted immediately so it survives restarts; the watcher itself
     * is reconciled to match.
     */
    app.post("/folders/watch", authMiddleware, (req, res) => {
        const { path: folderPath, watch } = req.body as { path?: string; watch?: boolean };
        if (!folderPath || typeof folderPath !== "string") {
            res.status(400).json({ error: "Invalid folder path" });
            return;
        }
        const folders = settings.scanFolders.map((f) =>
            f.path === folderPath ? { ...f, watch: !!watch } : f,
        );
        if (!folders.some((f) => f.path === folderPath)) {
            res.status(404).json({ error: "Folder not configured" });
            return;
        }
        store.set("scanFolders", folders);
        if (watch) {
            const status = startWatcher(folderPath);
            res.json({ success: true, folders, watcher: status });
        } else {
            void stopWatcher(folderPath);
            res.json({ success: true, folders, watcher: null });
        }
    });

    // ─── Scan Folder ─────────────────────────────────────────────────────
    //
    // Async job model: POST /scan returns `{ jobId }` immediately and the
    // walk runs in the background. The web app polls GET /scan/jobs/:id
    // for progress (refresh-resilient — the job state lives on the
    // companion). Once status === "complete", the web app pulls
    // `tracks` from the same endpoint and ingests through /library.

    app.post("/scan", authMiddleware, (req, res) => {
        const { folder } = req.body;
        if (!folder || typeof folder !== "string") {
            res.status(400).json({ error: "No folder specified" });
            return;
        }

        const resolved = path.resolve(folder);
        const isAllowed = settings.scanFolders.some((f) => resolved.startsWith(path.resolve(f.path)));
        if (!isAllowed) {
            res.status(403).json({ error: "Folder not in allowed paths" });
            return;
        }

        const job = createScanJob(resolved, "manual");
        // Fire-and-forget — runScanJob never throws. Status updates are
        // visible via GET /scan/jobs/:id.
        const broadcast = () => {
            const msg = JSON.stringify({ type: "scan:progress", job });
            for (const c of wsClients) if (c.readyState === WebSocket.OPEN) c.send(msg);
        };
        void runScanJob(job, broadcast);

        res.status(202).json({ jobId: job.id, job });
    });

    app.get("/scan/jobs", authMiddleware, (_req, res) => {
        res.json({ jobs: listAllScanJobs(), active: listActiveScanJobs().length });
    });

    app.get("/scan/jobs/:id", authMiddleware, (req, res) => {
        const job = getScanJob(req.params.id);
        if (!job) {
            res.status(404).json({ error: "Job not found" });
            return;
        }
        res.json({ job });
    });

    /** Acknowledge a completed job — frees its `tracks` payload from
     *  memory so a long-lived companion doesn't leak. The job itself
     *  remains visible (so a reload can still see "100% — done") but
     *  its tracks are cleared. */
    app.post("/scan/jobs/:id/ack", authMiddleware, (req, res) => {
        const job = getScanJob(req.params.id);
        if (!job) { res.status(404).json({ error: "Job not found" }); return; }
        clearJobTracks(job.id);
        res.json({ success: true });
    });

    // ─── Folder watcher events ───────────────────────────────────────────
    //
    // Long-poll fallback for clients that aren't connected over WS, and
    // a way to recover events that fired while the web app was closed.

    app.get("/watch/events", authMiddleware, (req, res) => {
        const since = Number(req.query.since ?? 0) || 0;
        const events = getEventsSince(since);
        res.json({
            events,
            highWatermark: events.length > 0 ? events[events.length - 1].id : since,
            watchers: listWatcherStatuses(),
        });
    });

    // ─── Check file availability ─────────────────────────────────────────

    app.post("/check-files", authMiddleware, (req, res) => {
        const { paths } = req.body as { paths: string[] };
        if (!Array.isArray(paths)) {
            res.status(400).json({ error: "paths must be an array" });
            return;
        }

        const results: Record<string, boolean> = {};
        for (const p of paths) {
            try {
                results[p] = fs.existsSync(path.resolve(p));
            } catch {
                results[p] = false;
            }
        }
        res.json(results);
    });

    // ─── User library (per-user tracks/playlists) ────────────────────────
    //
    // The companion now owns the music library DB. Web app calls these
    // routes for every read/write tied to the signed-in user. Auth =
    // existing device token + an `X-User-Id` header from the web app's
    // Auth.js session. See `server/src/library/routes.ts`.

    app.use("/library", createLibraryRouter(authMiddleware));

    // ─── Audio plugin host (VST3 / AU / LV2 via pedalboard) ──────────────
    //
    // Hosts third-party plugins inside the companion's Python sidecar
    // and renders user audio through them on demand. Used by the DAW
    // (per-track FX), Sound Editor (selection FX), and Live page
    // (recording post-FX). See `server/src/plugins/host.ts`.

    app.use("/plugins", createPluginsRouter(authMiddleware));

    // ─── Native low-latency audio engine ─────────────────────────────────
    //
    // These routes intentionally use `publicLocalhostMiddleware` instead of
    // `authMiddleware`. Rationale: the /live page in the web app needs to
    // discover the companion + drive realtime audio without forcing a
    // sign-in. The middleware enforces loopback-only + Host check + Origin
    // allowlist, which together provide equivalent (or stronger) security
    // for what is fundamentally a localhost-only feature.

    app.get("/audio/native/probe", publicLocalhostMiddleware, (_req, res) => {
        // Cheap presence beacon — used by the web app to detect "is the
        // companion installed and running?" without any credentials.
        res.json({
            ok: true,
            product: "MMOCompanion",
            version: SERVER_VERSION,
            platform: process.platform,
            capabilities: ["audio.native"],
        });
    });

    app.get("/audio/native/info", publicLocalhostMiddleware, (_req, res) => {
        try {
            res.json({
                supported: true,
                platform: process.platform,
                backends: listBackends(),
                running: nativeEngine.isRunning(),
                metrics: nativeEngine.metrics(),
            });
        } catch (err) {
            res.status(500).json({
                supported: false,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });

    app.get("/audio/native/devices", publicLocalhostMiddleware, (req, res) => {
        try {
            const wantBackend = (req.query.backend as AudioBackend | undefined) ?? "auto";
            // Honour an explicit ?refresh=1 by busting the enumeration cache
            // before probing. This is what the web UI's "Refresh" button
            // sends; without it, repeated clicks within the TTL window
            // would hit the cache.
            if (req.query.refresh === "1") {
                invalidateAudioInventoryCache();
            }
            // Enumerate every backend ONCE and reuse the results. The old
            // implementation called listDevices("auto") + listBackends() +
            // listDevices(b) for every backend, which was 5 RtAudio probes
            // per request (2–4 seconds of main-thread block on Windows).
            const backendInfos = listBackends();
            const groups = backendInfos.map((b) => {
                if (!b.available) return { backend: b.backend, available: false, devices: [] as ReturnType<typeof listDevices>["devices"] };
                try {
                    const g = listDevices(b.backend);
                    return { backend: b.backend, available: true, devices: g.devices };
                } catch {
                    return { backend: b.backend, available: false, devices: [] };
                }
            });
            // Pick the "auto" group: caller-requested backend if available,
            // otherwise the first available one (RtAudio's own auto pick).
            const wantLower = wantBackend.toLowerCase();
            const chosen =
                groups.find((g) => g.available && g.backend.toLowerCase() === wantLower) ??
                groups.find((g) => g.available) ??
                { backend: wantBackend, available: false, devices: [] };
            res.json({
                backend: chosen.backend,
                devices: chosen.devices,
                backends: groups,
                authorized: getSettings().authorizedAudioDevices,
            });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/audio/native/start", publicLocalhostMiddleware, (req, res) => {
        try {
            const body = (req.body ?? {}) as EngineConfig & {
                inputDeviceName?: string;
                inputBackend?: AudioBackend;
                outputDeviceName?: string;
                outputBackend?: AudioBackend;
            };
            // Resolve persisted device-name references (which survive reboots
            // and hot-plug, unlike RtAudio's numeric ids) to live ids at the
            // moment we open the stream. The web client may pass either form;
            // explicit numeric id wins when both are present.
            const cfg: EngineConfig = {
                sampleRate: body.sampleRate,
                frameSize: body.frameSize,
                backend: body.backend,
                autoCorrect: body.autoCorrect,
                formantPreserve: body.formantPreserve,
                scale: body.scale,
                minimizeLatency: body.minimizeLatency,
                realtimeSchedule: body.realtimeSchedule,
                exclusiveMode: body.exclusiveMode,
                inputDeviceId: body.inputDeviceId,
                outputDeviceId: body.outputDeviceId,
            };
            if (cfg.inputDeviceId == null && body.inputDeviceName) {
                const id = resolveDeviceId(body.inputBackend ?? cfg.backend ?? "auto", "input", body.inputDeviceName);
                if (id != null) cfg.inputDeviceId = id;
            }
            if (cfg.outputDeviceId == null && body.outputDeviceName) {
                const id = resolveDeviceId(body.outputBackend ?? cfg.backend ?? "auto", "output", body.outputDeviceName);
                if (id != null) cfg.outputDeviceId = id;
            }

            // Wire the DSP pitch callback to all connected WS clients.
            nativePitchUnsub?.();
            nativePitchUnsub = nativeEngine.addPitchListener((p) => {
                if (wsClients.size === 0) return;
                const now = Date.now();
                if (now - lastPitchPushAt < PITCH_PUSH_MIN_MS) return;
                lastPitchPushAt = now;
                const status = nativeEngine.lastStatus();
                const msg = JSON.stringify({
                    type: "audio.pitch",
                    pitch: p,
                    status,
                });
                for (const client of wsClients) {
                    if (client.readyState === WebSocket.OPEN) client.send(msg);
                }
            });
            const metrics = nativeEngine.start(cfg);
            // Start a fixed-rate levels broadcast so meters animate even
            // during silence / when no pitch is detected. Skip the JSON
            // serialization when nobody is listening.
            //
            // Wire format: 32 bytes of little-endian Float32 packed as
            //   [inPeak, outPeak, inRms, outRms,
            //    streamLatencyMs, dspAvgMs, dspMaxMs, underruns]
            // sent as a binary WebSocket frame. Saves ~150 bytes/frame
            // and an entire JSON.parse per tick on the client (=> less
            // renderer GC pressure during long sessions). Older clients
            // that don't recognise the binary frame are unaffected because
            // they just ignore non-string messages — and the pitch frame
            // (low-rate) is still JSON for back-compat.
            if (nativeLevelsTimer) clearInterval(nativeLevelsTimer);
            const levelsBuf = new ArrayBuffer(32);
            const levelsView = new Float32Array(levelsBuf);
            nativeLevelsTimer = setInterval(() => {
                if (!nativeEngine.isRunning()) return;
                if (wsClients.size === 0) return;
                const m = nativeEngine.metrics();
                levelsView[0] = m.inPeak;
                levelsView[1] = m.outPeak;
                levelsView[2] = m.inRms;
                levelsView[3] = m.outRms;
                levelsView[4] = m.streamLatencyMs;
                levelsView[5] = m.dspBlockAvgMs;
                levelsView[6] = m.dspBlockMaxMs;
                levelsView[7] = m.underruns;
                // ws's send(Buffer) auto-marks the frame as binary.
                const frame = Buffer.from(levelsBuf.slice(0));
                for (const client of wsClients) {
                    if (client.readyState === WebSocket.OPEN) client.send(frame);
                }
            }, LEVELS_PUSH_INTERVAL_MS);
            res.json({ success: true, metrics });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Surface the engine's last-known error too — lets the web UI
            // show a meaningful message (e.g. "openStream: ... in=12/2ch").
            res.status(500).json({ error: msg, lastError: nativeEngine.metrics().lastError });
        }
    });

    app.post("/audio/native/stop", publicLocalhostMiddleware, (_req, res) => {
        try {
            nativePitchUnsub?.();
            nativePitchUnsub = null;
            if (nativeLevelsTimer) { clearInterval(nativeLevelsTimer); nativeLevelsTimer = null; }
            nativeEngine.stop();
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.get("/audio/native/metrics", publicLocalhostMiddleware, (_req, res) => {
        res.json({
            running: nativeEngine.isRunning(),
            metrics: nativeEngine.metrics(),
            status: nativeEngine.lastStatus(),
            lastPitch: nativeEngine.lastPitch(),
        });
    });

    app.post("/audio/native/scale", publicLocalhostMiddleware, (req, res) => {
        try {
            const scale = req.body as ScaleConfig;
            nativeEngine.setScale(scale);
            res.json({ success: true });
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/audio/native/autocorrect", publicLocalhostMiddleware, (req, res) => {
        try {
            const { enabled, formantPreserve } = req.body as {
                enabled?: boolean;
                formantPreserve?: boolean;
            };
            if (typeof enabled === "boolean") nativeEngine.setAutoCorrectEnabled(enabled);
            if (typeof formantPreserve === "boolean") nativeEngine.setFormantPreserve(formantPreserve);
            res.json({ success: true });
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /audio/native/chain
    //
    // Replace the engine's FX chain. The browser pushes its current voice
    // chain in here whenever the user adds, removes, reorders, enables or
    // tweaks an insert while native mode is active. Browser-only effect
    // types are silently dropped by the engine; the rest run in the
    // companion's RtAudio callback at native low latency.
    //
    // Body shape:
    //   { items: Array<{
    //       id: string;             // stable insert id (preserves DSP state across edits)
    //       type: NativeFxType;
    //       enabled: boolean;
    //       params: Record<string, number>;
    //     }> }
    //
    // The endpoint is idempotent — sending the same chain twice is a
    // no-op for inserts whose type didn't change. We accept this even
    // when the engine isn't running; the items are stashed and applied
    // on the next start() so there's no race when the browser sends
    // chain config during the engine boot sequence.
    app.post("/audio/native/chain", publicLocalhostMiddleware, (req, res) => {
        try {
            const body = req.body as { items?: unknown };
            const items = Array.isArray(body.items) ? body.items : [];
            // Defensive normalisation. The HTTP boundary is the only place
            // we can't trust the shape; the engine's setItems() assumes
            // it's been validated.
            const safe = items
                .map((raw) => {
                    if (!raw || typeof raw !== "object") return null;
                    const item = raw as Record<string, unknown>;
                    const id = typeof item.id === "string" ? item.id : null;
                    const type = typeof item.type === "string" ? item.type : null;
                    const enabled = typeof item.enabled === "boolean" ? item.enabled : true;
                    const params = (item.params && typeof item.params === "object" && !Array.isArray(item.params))
                        ? item.params as Record<string, number>
                        : {};
                    if (!id || !type) return null;
                    return { id, type: type as never, enabled, params };
                })
                .filter((x): x is NonNullable<typeof x> => x !== null);
            nativeEngine.setFxChain(safe);
            res.json({ success: true, count: nativeEngine.getFxChainCount() });
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // ─── Audio Device Authorization ─────────────────────────────────────
    //
    // The web app shows a checkbox list of physical audio devices that can
    // be used by the in-browser engine when the page is being served from
    // localhost (low-latency live performance). The list of *available*
    // devices is enumerated via RtAudio on the companion; the *authorized*
    // subset is persisted per-companion in electron-store.
    //
    // These routes are auth'd with the device token (not publicLocalhost),
    // so the user can configure them from the web UI even when it lives
    // on app.brivio.ro.

    app.get("/audio/devices", authMiddleware, (_req, res) => {
        try {
            const backends = listBackends();
            const groups: Array<{
                backend: string;
                apiName: string;
                available: boolean;
                devices: Array<{
                    id: number;
                    name: string;
                    inputChannels: number;
                    outputChannels: number;
                    duplexChannels: number;
                    isDefaultInput: boolean;
                    isDefaultOutput: boolean;
                    sampleRates: number[];
                    preferredSampleRate: number;
                }>;
            }> = [];
            for (const b of backends) {
                if (!b.available) {
                    groups.push({ ...b, devices: [] });
                    continue;
                }
                try {
                    const ld = listDevices(b.backend as AudioBackend);
                    groups.push({ ...b, devices: ld.devices });
                } catch {
                    groups.push({ ...b, devices: [] });
                }
            }
            res.json({
                backends: groups,
                authorized: getSettings().authorizedAudioDevices,
            });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    /**
     * Replace the authorized-devices list. Body: `{ devices: AuthorizedAudioDevice[] }`.
     * Validation is intentionally lenient: we accept whatever the UI sent and
     * store it verbatim. Resolution back to a live RtAudio device id happens
     * at engine-start time, not here.
     */
    app.post("/audio/devices/authorize", authMiddleware, (req, res) => {
        const { devices: list } = req.body as { devices?: unknown };
        if (!Array.isArray(list)) {
            res.status(400).json({ error: "devices must be an array" });
            return;
        }
        const cleaned: AuthorizedAudioDevice[] = list
            .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null)
            .map((d) => ({
                name: String(d.name ?? ""),
                direction: (d.direction === "input" ? "input" : "output") as "input" | "output",
                backend: String(d.backend ?? ""),
                preferredSampleRate: typeof d.preferredSampleRate === "number" ? d.preferredSampleRate : undefined,
            }))
            .filter((d) => d.name.length > 0 && d.backend.length > 0);
        updateSettings({ authorizedAudioDevices: cleaned });
        res.json({ success: true, authorized: cleaned });
    });

    // ─── Start HTTP server ───────────────────────────────────────────────

    httpServer = http.createServer(app);

    // Tune Node's HTTP timeouts. Defaults (keepAliveTimeout=5s,
    // headersTimeout=60s) are too aggressive for a localhost service
    // that the web app polls every 1-3 s — under sustained event-loop
    // pressure (e.g. native audio init, big DB queries) the keep-alive
    // window can elapse mid-request and the browser sees the socket
    // close, surfacing as the "Companion offline" indicator flapping.
    // 65 s keep-alive is the AWS-recommended value behind ELBs and
    // gives us plenty of headroom over the 1-3 s poll cadence.
    httpServer.keepAliveTimeout = 65_000;
    httpServer.headersTimeout = 70_000; // must be > keepAliveTimeout
    httpServer.requestTimeout = 0;       // long-lived /analyze + /stems uploads

    // WebSocket for real-time status
    wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    wss.on("connection", (ws) => {
        wsClients.add(ws);
        ws.send(JSON.stringify({ type: "connected", hostname: os.hostname() }));
        ws.on("close", () => wsClients.delete(ws));
        ws.on("error", () => wsClients.delete(ws));
    });

    // Heartbeat
    setInterval(() => {
        const msg = JSON.stringify({
            type: "heartbeat",
            uptime: process.uptime(),
            timestamp: Date.now(),
        });
        for (const client of wsClients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(msg);
            }
        }
    }, 10_000);

    // ─── Scan-job + watcher bootstrap ────────────────────────────────────
    startScanJobGc();
    startWatcherGc();
    // Restart any watchers the user had previously enabled.
    for (const f of settings.scanFolders) {
        if (f.watch) {
            try { startWatcher(f.path); }
            catch (err) { console.warn(`[watcher] failed to start for ${f.path}:`, err); }
        }
    }
    // Bridge watcher events onto the existing WebSocket fan-out so the
    // web app can react in realtime (in addition to the polling endpoint).
    watcherBus.on("event", (ev) => {
        const msg = JSON.stringify({ type: "watch:event", event: ev });
        for (const c of wsClients) if (c.readyState === WebSocket.OPEN) c.send(msg);
    });

    return new Promise<void>((resolve, reject) => {
        httpServer!.listen(serverPort, "0.0.0.0", () => {
            console.log(`MMO Companion Server running on port ${serverPort}`);
            resolve();
        });
        httpServer!.on("error", reject);
    });
}

export async function stopServer(): Promise<void> {
    nativePitchUnsub?.();
    nativePitchUnsub = null;
    if (nativeLevelsTimer) { clearInterval(nativeLevelsTimer); nativeLevelsTimer = null; }
    try { nativeEngine.stop(); } catch { /* ignore */ }

    stopScanJobGc();
    stopWatcherGc();
    await stopAllWatchers().catch(() => { /* ignore */ });

    for (const client of wsClients) {
        client.close();
    }
    wsClients.clear();

    try { closeLibraryDb(); } catch { /* ignore */ }

    return new Promise<void>((resolve) => {
        if (httpServer) {
            httpServer.close(() => resolve());
        } else {
            resolve();
        }
    });
}

// ─── Directory Scanner ───────────────────────────────────────────────────────
//
// The directory walker has moved to ./library/scan-runner.ts so it can be
// shared with the watcher. The /scan HTTP route above only orchestrates a
// `ScanJob` — it no longer touches the filesystem directly.

