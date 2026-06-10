/**
 * Companion-side project export / render router.
 *
 * STATUS: Phase E (P6) — functional in-memory job queue.
 *
 * Endpoints:
 *
 *   POST /render/start              { projectExternalId, format }
 *     → { id, stage: "queued" }
 *
 *   POST /render/:id/upload         (raw audio body)
 *     Client (web app) streams its OfflineAudioContext bounce here.
 *     Companion stores the bytes and flips the job to "ready".
 *
 *   GET  /render/:id                → { id, stage, bytes, error, ... }
 *
 *   GET  /render/:id/download       → audio/wav | audio/mpeg (range-aware)
 *
 *   GET  /render                    → list recent jobs
 *
 * When the native engine grows an offline-render mode the upload step
 * is replaced by an in-process render and these endpoints stay stable.
 */

import { Router, type RequestHandler } from "express";
import { createReadStream } from "node:fs";
import { renderHost, type RenderFormat, type RenderMode } from "./host";

export function createRenderRouter(authMiddleware: RequestHandler): Router {
    const r = Router();
    r.use(authMiddleware);

    r.post("/start", (req, res) => {
        const body = (req.body ?? {}) as { projectExternalId?: string; format?: RenderFormat; mode?: RenderMode };
        if (!body.projectExternalId) {
            res.status(400).json({ error: "projectExternalId required" });
            return;
        }
        const fmt: RenderFormat = body.format === "mp3" ? "mp3" : "wav";
        const mode: RenderMode = body.mode === "native" ? "native" : "upload";
        const job = renderHost.start(body.projectExternalId, fmt, mode);
        res.json({ id: job.id, stage: job.stage, format: job.format, mode: job.mode });
    });

    r.get("/", (_req, res) => {
        res.json({ jobs: renderHost.list() });
    });

    r.get("/:id", (req, res) => {
        const job = renderHost.get(req.params.id);
        if (!job) { res.status(404).json({ error: "render job not found" }); return; }
        res.json(job);
    });

    r.delete("/:id", (req, res) => {
        const ok = renderHost.remove(req.params.id);
        if (!ok) { res.status(404).json({ error: "render job not found" }); return; }
        res.json({ ok: true });
    });

    // Raw body upload — pipes request body straight into the host's
    // write stream. Bypasses express.json() limits.
    r.post("/:id/upload", (req, res) => {
        const handle = renderHost.upload(req.params.id);
        if (!handle) { res.status(404).json({ error: "render job not found" }); return; }
        let aborted = false;
        req.on("aborted", () => { aborted = true; handle.finalize(false, "client aborted"); });
        req.on("error", (e) => { aborted = true; handle.finalize(false, e.message); });
        req.pipe(handle.sink);
        handle.sink.on("finish", () => {
            if (aborted) return;
            handle.finalize(true);
            res.json({ id: handle.job.id, stage: handle.job.stage, bytes: handle.job.bytes });
        });
        handle.sink.on("error", (e) => {
            handle.finalize(false, e.message);
            res.status(500).json({ error: e.message });
        });
    });

    r.get("/:id/download", (req, res) => {
        const dl = renderHost.download(req.params.id);
        if (!dl) { res.status(404).json({ error: "render not ready" }); return; }
        const mime = dl.job.format === "mp3" ? "audio/mpeg" : "audio/wav";
        res.setHeader("Content-Type", mime);
        res.setHeader("Accept-Ranges", "bytes");
        const range = req.headers.range;
        if (range) {
            const m = /^bytes=(\d+)-(\d*)$/.exec(range);
            if (m) {
                const start = parseInt(m[1], 10);
                const end = m[2] ? parseInt(m[2], 10) : dl.size - 1;
                res.status(206);
                res.setHeader("Content-Range", `bytes ${start}-${end}/${dl.size}`);
                res.setHeader("Content-Length", String(end - start + 1));
                createReadStream(dl.path, { start, end }).pipe(res);
                return;
            }
        }
        res.setHeader("Content-Length", String(dl.size));
        createReadStream(dl.path).pipe(res);
    });

    return r;
}

