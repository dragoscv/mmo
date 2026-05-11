/**
 * /plugins/* HTTP API.
 *
 * Exposes the plugin host (server/src/plugins/host.ts) to the web app:
 *
 *   GET  /plugins                   → cached inventory (instant)
 *   POST /plugins/scan              → trigger a fresh scan, streams
 *                                     progress over a long-lived SSE
 *                                     response (or returns the result
 *                                     synchronously if `stream=false`)
 *   POST /plugins/describe          → re-introspect a single plugin
 *   POST /plugins/render            → enqueue an offline render job;
 *                                     returns the job id for polling
 *   GET  /plugins/render/:id        → poll a render job's status
 *   GET  /plugins/render/:id/audio  → stream the rendered WAV (range)
 *   GET  /plugins/status            → host snapshot for /analysis
 *
 * Auth: same X-Device-Token + X-User-Id headers as /library. Plugin
 * scans don't carry user data but the rendered files contain user
 * audio, so we keep them behind the same gate.
 */

import express from "express";
import { createReadStream, statSync, existsSync } from "node:fs";
import { pluginHost, type PluginChainStep } from "./host";

interface AuthedRequest extends express.Request {
    userId: string;
}

function requireUser(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
) {
    const userId = (req.headers["x-user-id"] as string | undefined)?.trim();
    if (!userId) {
        res.status(400).json({ error: "Missing X-User-Id header" });
        return;
    }
    (req as AuthedRequest).userId = userId;
    next();
}

export function createPluginsRouter(authMiddleware: express.RequestHandler) {
    const router = express.Router();
    router.use(authMiddleware);
    router.use(requireUser);

    // GET /plugins — cached inventory (or null on first run).
    router.get("/", (_req, res) => {
        const cached = pluginHost.getCached();
        res.json({
            cached: cached ?? null,
        });
    });

    // POST /plugins/scan — runs a full scan. Body: { paths?: string[],
    // stream?: boolean }. When stream is true (default), responds with
    // SSE; otherwise blocks until done and returns the result inline.
    router.post("/scan", async (req, res) => {
        const body = (req.body ?? {}) as { paths?: string[]; stream?: boolean };
        const extraPaths = Array.isArray(body.paths) ? body.paths : [];
        const useStream = body.stream !== false;

        if (useStream) {
            res.status(200);
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");
            const send = (event: string, data: unknown) => {
                res.write(`event: ${event}\n`);
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };
            try {
                const result = await pluginHost.scan(extraPaths, (p) => {
                    send("progress", p);
                });
                send("done", result);
            } catch (e) {
                send("error", { error: e instanceof Error ? e.message : String(e) });
            } finally {
                res.end();
            }
            return;
        }

        try {
            const result = await pluginHost.scan(extraPaths);
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    // POST /plugins/describe { path } — single-plugin introspection.
    router.post("/describe", async (req, res) => {
        const body = (req.body ?? {}) as { path?: string };
        if (!body.path) { res.status(400).json({ error: "path required" }); return; }
        // Defence: only describe plugins already in the inventory. A
        // raw `path` here could otherwise be coerced into loading any
        // .vst3 / .so / .dll on disk — VST3 plugins are arbitrary
        // native code, so this is an RCE primitive if the device
        // token leaks. The user-facing scan flow always populates the
        // cache before describe is reachable from the UI.
        if (!pluginHost.isKnownPluginPath(body.path)) {
            res.status(403).json({ error: "plugin not in cached inventory; run a scan first" });
            return;
        }
        try {
            const data = await pluginHost.describe(body.path);
            res.json(data);
        } catch (e) {
            res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    // POST /plugins/render — enqueue offline render. Body:
    //   { input: string, chain: PluginChainStep[] }
    router.post("/render", async (req, res) => {
        const body = (req.body ?? {}) as { input?: string; chain?: PluginChainStep[] };
        if (!body.input) { res.status(400).json({ error: "input required" }); return; }
        if (!Array.isArray(body.chain)) { res.status(400).json({ error: "chain required" }); return; }
        // Same allowlist guard as /describe — every chain step's plugin
        // path must already be in the inventory. Otherwise an attacker
        // who has a device token could load an arbitrary native plugin
        // (RCE).
        for (const step of body.chain) {
            if (typeof step?.path !== "string" || !step.path) {
                res.status(400).json({ error: "each chain step needs a path" });
                return;
            }
            if (!pluginHost.isKnownPluginPath(step.path)) {
                res.status(403).json({ error: `chain plugin not in cached inventory: ${step.path}` });
                return;
            }
        }
        try {
            const job = await pluginHost.render(body.input, body.chain);
            res.json({ id: job.id, stage: job.stage });
        } catch (e) {
            res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    // GET /plugins/render/:id — poll status.
    router.get("/render/:id", (req, res) => {
        const job = pluginHost.findRender(req.params.id);
        if (!job) { res.status(404).json({ error: "render job not found" }); return; }
        res.json({
            id: job.id,
            stage: job.stage,
            progress: job.progress,
            message: job.message,
            error: job.error,
            durationSec: job.durationSec,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
        });
    });

    // GET /plugins/render/:id/audio — stream the WAV. Supports range
    // so the web app can mount it as <audio src=…> for previews.
    router.get("/render/:id/audio", (req, res) => {
        const file = pluginHost.renderOutputPath(req.params.id);
        if (!file || !existsSync(file)) {
            res.status(404).json({ error: "render not ready" });
            return;
        }
        const stat = statSync(file);
        const range = req.headers.range;
        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Accept-Ranges", "bytes");
        if (range) {
            const m = /^bytes=(\d+)-(\d*)$/.exec(range);
            if (m) {
                const start = parseInt(m[1], 10);
                const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
                res.status(206);
                res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
                res.setHeader("Content-Length", String(end - start + 1));
                createReadStream(file, { start, end }).pipe(res);
                return;
            }
        }
        res.setHeader("Content-Length", String(stat.size));
        createReadStream(file).pipe(res);
    });

    // GET /plugins/status — snapshot for the /analysis page widget.
    router.get("/status", (_req, res) => {
        res.json(pluginHost.status());
    });

    return router;
}
