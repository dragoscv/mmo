/**
 * /video/* HTTP API — companion-side video pipeline.
 *
 * Routes:
 *   GET    /video/probe                  health + capabilities
 *   GET    /video/flags                  feature flags (vidsrc etc.)
 *   POST   /video/flags                  update feature flags
 *   POST   /video/scan                   scan configured folders, returns probed metadata
 *   GET    /video/stream/:fileId         HLS playlist for a known file (returns m3u8)
 *   GET    /video/stream/:fileId/:seg    HLS segment
 *   GET    /video/direct/:fileId         direct-play range-supported file
 *   GET    /video/subs/:fileId/:track    extract embedded subtitle as WebVTT
 *   GET    /video/tmdb-image/:size/*     cached TMDB image proxy
 *   POST   /video/discord/presence       set Discord rich presence
 *   GET    /video/discord/status         is Discord RPC connected
 *
 * Auth model: same as the rest of the companion. The :fileId is opaque
 * and maps through an in-process registry to an absolute path that has
 * been validated against the user's configured library roots; an
 * arbitrary path cannot be passed in the URL.
 */

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { walkVideos, ffprobe, parseFilename } from "./video-scanner";
import { ensureHlsSession, touchSession, canDirectPlay, type VideoQuality, destroyAllSessions } from "./transcode-video";
import { FFMPEG_BIN } from "./ffmpeg-paths";
import { getCachedTmdbImage } from "./tmdb-cache";
import { isVidsrcEnabled, setVidsrcEnabled } from "./vidsrc-flag";
import { initDiscordRpc, setPresence, shutdownDiscordRpc, rpcBus } from "../plugins/discord-rpc";
import { getSettings } from "../store";
import { resolveStreamingEmbeds, type ScrapeKind } from "./streaming-scrapers";
import { searchOpenSubtitles, searchAddic7ed, downloadOpenSubtitles } from "./subtitle-search";
import { startVideoWatcher, stopVideoWatcher, videoLibraryBus } from "./video-watcher";
import { rateLimit } from "./rate-limit";

/** In-process file registry: opaque fileId → absolute path. Populated by /video/scan. */
const fileRegistry = new Map<string, { absPath: string; meta: Record<string, unknown> }>();

function makeFileId(absPath: string): string {
    // Stable id: short hash of path. Same file always gets same id within session.
    let hash = 0;
    for (let i = 0; i < absPath.length; i++) {
        hash = ((hash << 5) - hash) + absPath.charCodeAt(i);
        hash |= 0;
    }
    return `f${(hash >>> 0).toString(36)}`;
}

function resolveFileId(fileId: string): string | null {
    const entry = fileRegistry.get(fileId);
    return entry?.absPath ?? null;
}

export function createVideoRouter(authMiddleware: express.RequestHandler): express.Router {
    const r = express.Router();

    // Allow query-string auth (?t=token&u=userId) on streaming endpoints,
    // because <video>, <track> and `hls.js` cannot set custom headers.
    // We rewrite the request headers from the query so the same
    // authMiddleware works without modification.
    const queryAuth: express.RequestHandler = (req, _res, next) => {
        const t = req.query.t;
        const u = req.query.u;
        if (typeof t === "string" && !req.headers["x-device-token"]) req.headers["x-device-token"] = t;
        if (typeof u === "string" && !req.headers["x-user-id"]) req.headers["x-user-id"] = u;
        next();
    };

    // Probe — public localhost beacon
    r.get("/probe", (_req, res) => {
        res.json({
            ok: true,
            capabilities: ["video.scan", "video.transcode", "video.subtitles", "video.tmdb-cache"],
            vidsrcEnabled: isVidsrcEnabled(),
            ffmpeg: !!FFMPEG_BIN,
        });
    });

    r.get("/flags", authMiddleware, (_req, res) => {
        res.json({ vidsrcEnabled: isVidsrcEnabled() });
    });

    r.post("/flags", authMiddleware, express.json(), (req, res) => {
        const body = req.body as { vidsrcEnabled?: boolean };
        if (typeof body.vidsrcEnabled === "boolean") setVidsrcEnabled(body.vidsrcEnabled);
        res.json({ vidsrcEnabled: isVidsrcEnabled() });
    });

    r.post("/scan", authMiddleware, express.json(), async (req, res) => {
        const body = req.body as { roots?: string[] };
        const roots = (body.roots && body.roots.length > 0)
            ? body.roots
            : getSettings().scanFolders.map((f) => f.path);
        if (!roots || roots.length === 0) {
            res.json({ files: [], rootsScanned: 0 });
            return;
        }
        const files: Array<Record<string, unknown>> = [];
        for (const root of roots) {
            for await (const f of walkVideos(root)) {
                const probed = await ffprobe(f);
                if (!probed) continue;
                const fileId = makeFileId(f);
                const parsed = parseFilename(f);
                fileRegistry.set(fileId, { absPath: f, meta: { ...probed, parsed } });
                files.push({ fileId, parsed, ...probed });
            }
        }
        res.json({ files, rootsScanned: roots.length });
    });

    r.get("/file/:fileId/info", authMiddleware, (req, res) => {
        const entry = fileRegistry.get(req.params.fileId);
        if (!entry) { res.status(404).json({ error: "unknown fileId" }); return; }
        res.json({ fileId: req.params.fileId, ...entry.meta });
    });

    // Lookup the registry by absolute path. The web app stores absolute
    // paths in the DB but needs the opaque fileId to build streaming
    // URLs. If the registry has been cleared (companion restarted), we
    // re-register the file on the fly after verifying it exists.
    r.get("/lookup", authMiddleware, async (req, res) => {
        const p = req.query.path;
        if (typeof p !== "string" || !p) { res.status(400).json({ error: "missing path" }); return; }
        // Try existing registry first
        for (const [fileId, entry] of fileRegistry.entries()) {
            if (entry.absPath === p) { res.json({ fileId }); return; }
        }
        // Verify the path is within a configured library root before
        // registering — never trust an arbitrary path from the client.
        const roots = getSettings().scanFolders.map((f) => f.path);
        const inRoot = roots.some((root) => {
            const rel = path.relative(root, p);
            return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
        });
        if (!inRoot) { res.status(403).json({ error: "path not in library" }); return; }
        if (!fs.existsSync(p)) { res.status(404).json({ error: "file not found" }); return; }
        const probed = await ffprobe(p);
        if (!probed) { res.status(415).json({ error: "unsupported file" }); return; }
        const fileId = makeFileId(p);
        const parsed = parseFilename(p);
        fileRegistry.set(fileId, { absPath: p, meta: { ...probed, parsed } });
        res.json({ fileId });
    });

    r.get("/direct/:fileId", queryAuth, authMiddleware, (req, res) => {
        const abs = resolveFileId(req.params.fileId);
        if (!abs || !fs.existsSync(abs)) { res.status(404).end(); return; }
        const stat = fs.statSync(abs);
        const range = req.headers.range;
        const ext = path.extname(abs).toLowerCase();
        const ctMap: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska" };
        const ct = ctMap[ext] ?? "application/octet-stream";
        if (range) {
            const m = range.match(/bytes=(\d+)-(\d*)/);
            if (!m) { res.status(416).end(); return; }
            const start = parseInt(m[1], 10);
            const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${stat.size}`,
                "Accept-Ranges": "bytes",
                "Content-Length": end - start + 1,
                "Content-Type": ct,
            });
            fs.createReadStream(abs, { start, end }).pipe(res);
        } else {
            res.writeHead(200, { "Content-Length": stat.size, "Content-Type": ct, "Accept-Ranges": "bytes" });
            fs.createReadStream(abs).pipe(res);
        }
    });

    r.get("/stream/:fileId", queryAuth, authMiddleware, async (req, res) => {
        const abs = resolveFileId(req.params.fileId);
        if (!abs) { res.status(404).json({ error: "unknown fileId" }); return; }
        const q = ((req.query.q as string) || "720p") as VideoQuality;
        const start = parseFloat((req.query.start as string) || "0") || 0;
        try {
            const sess = await ensureHlsSession(req.params.fileId, abs, q, start);
            const m3u8 = await fs.promises.readFile(sess.playlistPath, "utf8");
            // Forward the same auth params on every segment URL so hls.js
            // (which can't set custom headers) can fetch them.
            const t = encodeURIComponent((req.query.t as string) || (req.headers["x-device-token"] as string) || "");
            const u = encodeURIComponent((req.query.u as string) || (req.headers["x-user-id"] as string) || "");
            const baseUrl = `${req.protocol}://${req.get("host")}/video/stream/${req.params.fileId}/seg/${encodeURIComponent(sess.key)}`;
            const rewritten = m3u8.replace(/^(seg_\d+\.m4s|init\.mp4)$/gm, (n) => `${baseUrl}/${n}?t=${t}&u=${u}`);
            res.set("Content-Type", "application/vnd.apple.mpegurl");
            res.send(rewritten);
        } catch (e) {
            res.status(500).json({ error: (e as Error).message });
        }
    });

    r.get("/stream/:fileId/seg/:sessionKey/:seg", queryAuth, authMiddleware, async (req, res) => {
        const { sessionKey, seg } = req.params;
        touchSession(sessionKey);
        const fileEntry = fileRegistry.get(req.params.fileId);
        if (!fileEntry) { res.status(404).end(); return; }
        const m = sessionKey.match(/^[^:]+:(original|1080p|720p|480p):(\d+)$/);
        if (!m) { res.status(400).end(); return; }
        try {
            const sess = await ensureHlsSession(req.params.fileId, fileEntry.absPath, m[1] as VideoQuality, parseInt(m[2], 10));
            const segPath = path.join(sess.segmentDir, path.basename(seg));
            if (!fs.existsSync(segPath)) {
                // Segment may still be writing — wait briefly
                const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
                for (let i = 0; i < 20 && !fs.existsSync(segPath); i++) await wait(150);
            }
            if (!fs.existsSync(segPath)) { res.status(404).end(); return; }
            res.sendFile(segPath, {
                headers: {
                    "Content-Type": seg.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" :
                        seg.endsWith(".mp4") ? "video/mp4" : "video/iso.segment",
                    "Cache-Control": "max-age=3600",
                },
            });
        } catch (e) {
            res.status(500).json({ error: (e as Error).message });
        }
    });

    r.get("/subs/:fileId/:track", queryAuth, authMiddleware, (req, res) => {
        const abs = resolveFileId(req.params.fileId);
        if (!abs) { res.status(404).end(); return; }
        const track = parseInt(req.params.track, 10);
        if (!Number.isFinite(track)) { res.status(400).end(); return; }
        // Extract sub stream → WebVTT on stdout
        const args = [
            "-y", "-loglevel", "error",
            "-i", abs,
            "-map", `0:s:${track}`,
            "-f", "webvtt",
            "-",
        ];
        const child = spawn(FFMPEG_BIN, args, { windowsHide: true });
        res.set("Content-Type", "text/vtt; charset=utf-8");
        child.stdout.pipe(res);
        child.on("error", () => { try { res.end(); } catch { /* ignore */ } });
    });

    r.get("/tmdb-image/:size/*", queryAuth, authMiddleware, async (req, res) => {
        const size = req.params.size;
        const rest = "/" + (req.params as Record<string, string>)["0"];
        try {
            const cached = await getCachedTmdbImage(size, rest);
            res.set("Cache-Control", "public, max-age=2592000, immutable");
            res.sendFile(cached.filePath, { headers: { "Content-Type": cached.contentType } });
        } catch (e) {
            res.status(404).json({ error: (e as Error).message });
        }
    });

    r.post("/discord/init", authMiddleware, express.json(), async (req, res) => {
        const body = req.body as { clientId?: string };
        await initDiscordRpc(body.clientId);
        res.json({ ok: true });
    });

    r.post("/discord/presence", authMiddleware, express.json(), (req, res) => {
        setPresence(req.body);
        res.json({ ok: true });
    });

    r.post("/discord/shutdown", authMiddleware, async (_req, res) => {
        await shutdownDiscordRpc();
        res.json({ ok: true });
    });

    // ----- Discord presence SSE bridge -----
    // The web app subscribes to read presence state changes (connected,
    // current activity). Server actions remain the write path.
    r.get("/discord/stream", queryAuth, authMiddleware, (req, res) => {
        res.set({
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        const send = (event: string, data: unknown) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        send("hello", { at: new Date().toISOString() });
        const bus = rpcBus();
        const onState = (s: unknown) => send("state", s);
        const onPresence = (p: unknown) => send("presence", p);
        bus.on("state", onState);
        bus.on("presence", onPresence);
        const keepalive = setInterval(() => res.write(`: ping\n\n`), 15000);
        req.on("close", () => {
            clearInterval(keepalive);
            bus.off("state", onState);
            bus.off("presence", onPresence);
        });
    });

    // ----- Library watcher SSE -----
    r.get("/watch/events", queryAuth, authMiddleware, (req, res) => {
        res.set({
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        const send = (event: string, data: unknown) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        send("hello", { at: new Date().toISOString() });
        startVideoWatcher();
        const bus = videoLibraryBus();
        const onChange = (p: unknown) => send("change", p);
        const onError = (e: Error) => send("error", { message: e.message });
        bus.on("change", onChange);
        bus.on("error", onError);
        const keepalive = setInterval(() => res.write(`: ping\n\n`), 15000);
        req.on("close", () => {
            clearInterval(keepalive);
            bus.off("change", onChange);
            bus.off("error", onError);
        });
    });

    // ----- External streaming embed sources -----
    const scrapersLimiter = rateLimit({ windowMs: 60_000, max: 30 });
    r.get("/streams/:kind/:tmdbId", authMiddleware, scrapersLimiter, (req, res) => {
        const kind = req.params.kind as ScrapeKind;
        if (kind !== "movie" && kind !== "tv") { res.status(400).json({ error: "bad kind" }); return; }
        const tmdbId = parseInt(req.params.tmdbId, 10);
        if (!Number.isFinite(tmdbId)) { res.status(400).json({ error: "bad tmdbId" }); return; }
        const imdbId = typeof req.query.imdb === "string" ? req.query.imdb : undefined;
        const season = req.query.season ? parseInt(String(req.query.season), 10) : undefined;
        const episode = req.query.episode ? parseInt(String(req.query.episode), 10) : undefined;
        const options = resolveStreamingEmbeds({ tmdbId, imdbId, kind, season, episode });
        res.json({ options });
    });

    // ----- Subtitle providers -----
    const subsLimiter = rateLimit({ windowMs: 60_000, max: 20 });
    r.get("/subs/search", authMiddleware, subsLimiter, async (req, res) => {
        const q = req.query;
        const opts = {
            title: typeof q.title === "string" ? q.title : undefined,
            year: q.year ? parseInt(String(q.year), 10) : undefined,
            imdbId: typeof q.imdb === "string" ? q.imdb : undefined,
            tmdbId: q.tmdb ? parseInt(String(q.tmdb), 10) : undefined,
            kind: (q.kind === "tv" || q.kind === "movie") ? (q.kind as "tv" | "movie") : undefined,
            season: q.season ? parseInt(String(q.season), 10) : undefined,
            episode: q.episode ? parseInt(String(q.episode), 10) : undefined,
            languages: typeof q.lang === "string" ? q.lang.split(",") : ["ro", "en"],
        };
        const [os, ad] = await Promise.all([searchOpenSubtitles(opts), searchAddic7ed(opts)]);
        res.json({ results: [...os, ...ad] });
    });

    r.get("/subs/download", authMiddleware, subsLimiter, async (req, res) => {
        const provider = req.query.provider;
        const id = req.query.id;
        if (provider !== "opensubtitles" || typeof id !== "string") {
            res.status(400).json({ error: "unsupported provider" });
            return;
        }
        const vtt = await downloadOpenSubtitles(id);
        if (!vtt) { res.status(404).json({ error: "not found" }); return; }
        res.set("Content-Type", "text/vtt; charset=utf-8");
        res.send(vtt);
    });

    return r;
}

export function shutdownVideoSubsystem(): void {
    destroyAllSessions();
    stopVideoWatcher();
    fileRegistry.clear();
}
