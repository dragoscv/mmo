import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { store, getSettings, updateSettings } from "./store";
import { parseFile } from "music-metadata";
import {
    NativeAudioEngine,
    listBackends,
    listDevices,
    type AudioBackend,
    type EngineConfig,
} from "./audio/native-engine";
import type { ScaleConfig } from "./audio/pitch-dsp";

const AUDIO_EXTENSIONS = new Set([
    ".mp3", ".flac", ".wav", ".aac", ".ogg", ".m4a", ".wma", ".aiff", ".aif", ".alac", ".opus",
]);

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

// ─── Native Audio Engine (singleton) ─────────────────────────────────────────
//
// One process = one mic + one speakers. The engine is created lazily on
// the first /audio/native/start request and torn down on /audio/native/stop
// (or on process exit). All control flows through the HTTP API; the
// realtime audio path lives entirely inside the engine's RtAudio thread.
const nativeEngine = new NativeAudioEngine();
let nativePitchUnsub: (() => void) | null = null;
// Pitch is published over WS at most every PITCH_PUSH_MIN_MS to avoid
// flooding the wire (the DSP fires onPitch every 2.67 ms = 374 Hz).
const PITCH_PUSH_MIN_MS = 25;            // ~40 Hz throttled push
let lastPitchPushAt = 0;

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
    app.use(express.json());

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
            version: "0.1.0",
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

    app.get("/audio/*", authMiddleware, (req, res) => {
        // Filepath comes URL-encoded after /audio/
        const filePath = decodeURIComponent(req.params[0] || "");

        if (!filePath) {
            res.status(400).json({ error: "No file path" });
            return;
        }

        // Security: verify the file is within a configured scan folder
        const normalizedPath = path.resolve(filePath);
        const isAllowed = settings.scanFolders.some(folder =>
            normalizedPath.startsWith(path.resolve(folder))
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
        const isAllowed = settings.scanFolders.some(folder =>
            normalizedPath.startsWith(path.resolve(folder))
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
        res.json({ folders: settings.scanFolders });
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
        if (!folders.includes(resolved)) {
            folders.push(resolved);
            store.set("scanFolders", folders);
        }

        res.json({ success: true, folders });
    });

    app.post("/folders/remove", authMiddleware, (req, res) => {
        const { path: folderPath } = req.body;
        const folders = settings.scanFolders.filter(f => f !== folderPath);
        store.set("scanFolders", folders);
        res.json({ success: true, folders });
    });

    // ─── Scan Folder ─────────────────────────────────────────────────────

    app.post("/scan", authMiddleware, async (req, res) => {
        const { folder } = req.body;
        if (!folder || typeof folder !== "string") {
            res.status(400).json({ error: "No folder specified" });
            return;
        }

        const resolved = path.resolve(folder);
        const isAllowed = settings.scanFolders.some(f => resolved.startsWith(path.resolve(f)));
        if (!isAllowed) {
            res.status(403).json({ error: "Folder not in allowed paths" });
            return;
        }

        try {
            const tracks = await scanDirectory(resolved);
            res.json({ success: true, tracks, count: tracks.length });
        } catch (err) {
            res.status(500).json({ error: `Scan failed: ${err}` });
        }
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
            version: "0.3.1",
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
            const backend = (req.query.backend as AudioBackend | undefined) ?? "auto";
            res.json(listDevices(backend));
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/audio/native/start", publicLocalhostMiddleware, (req, res) => {
        try {
            const cfg = req.body as EngineConfig;
            // Wire the DSP pitch callback to all connected WS clients.
            nativePitchUnsub?.();
            nativePitchUnsub = nativeEngine.addPitchListener((p) => {
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
            res.json({ success: true, metrics });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/audio/native/stop", publicLocalhostMiddleware, (_req, res) => {
        try {
            nativePitchUnsub?.();
            nativePitchUnsub = null;
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

    // ─── Start HTTP server ───────────────────────────────────────────────

    httpServer = http.createServer(app);

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
    try { nativeEngine.stop(); } catch { /* ignore */ }

    for (const client of wsClients) {
        client.close();
    }
    wsClients.clear();

    return new Promise<void>((resolve) => {
        if (httpServer) {
            httpServer.close(() => resolve());
        } else {
            resolve();
        }
    });
}

// ─── Directory Scanner ───────────────────────────────────────────────────────

interface ScannedTrack {
    filepath: string;
    filename: string;
    artist?: string;
    title?: string;
    album?: string;
    bpm?: number;
    key?: string;
    duration?: number;
    genre?: string;
    format?: string;
    bitrate?: number;
    sampleRate?: number;
    fileSize: number;
    year?: number;
}

async function scanDirectory(dirPath: string): Promise<ScannedTrack[]> {
    const tracks: ScannedTrack[] = [];

    async function walk(dir: string) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (AUDIO_EXTENSIONS.has(ext)) {
                    try {
                        const stat = fs.statSync(fullPath);
                        const metadata = await parseFile(fullPath, { duration: true });
                        tracks.push({
                            filepath: fullPath,
                            filename: entry.name,
                            artist: metadata.common.artist,
                            title: metadata.common.title || entry.name.replace(ext, ""),
                            album: metadata.common.album,
                            bpm: metadata.common.bpm,
                            key: metadata.common.key,
                            duration: metadata.format.duration ? Math.round(metadata.format.duration) : undefined,
                            genre: metadata.common.genre?.[0],
                            format: ext.replace(".", "").toUpperCase(),
                            bitrate: metadata.format.bitrate ? Math.round(metadata.format.bitrate / 1000) : undefined,
                            sampleRate: metadata.format.sampleRate,
                            fileSize: stat.size,
                            year: metadata.common.year,
                        });
                    } catch {
                        // Skip unreadable files
                        tracks.push({
                            filepath: fullPath,
                            filename: entry.name,
                            fileSize: fs.statSync(fullPath).size,
                            format: ext.replace(".", "").toUpperCase(),
                        });
                    }
                }
            }
        }
    }

    await walk(dirPath);
    return tracks;
}
