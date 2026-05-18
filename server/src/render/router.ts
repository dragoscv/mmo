/**
 * Companion-side project export / render router.
 *
 * STATUS: scaffold. Not wired up.
 *
 * Planned endpoints:
 *
 *   POST /render/start
 *     Body: { projectKind, projectExternalId, mode: "wav"|"mp3"|"flac"|"video",
 *             options: {...} }
 *     Spawns the existing native audio engine in offline-render mode
 *     (or ffmpeg for video bounces), tracks progress, returns a jobId.
 *
 *   GET /render/:jobId
 *     SSE stream of progress events.
 *
 *   GET /render/:jobId/download
 *     Streams the final rendered file.
 *
 *   POST /export/mmoprj
 *     Bundles project JSON + all referenced assets into a single
 *     `.mmoprj` zip for offline backup / sharing.
 *
 * TODO:
 *   1. Add `RenderMode` to the native engine spec (`server/python/...`).
 *   2. Persist jobs in `library/db.ts` so they survive companion restarts.
 *   3. Mount this router from `server/src/server.ts` after the projects router.
 */

import { Router, type RequestHandler } from "express";

export function createRenderRouter(authMiddleware: RequestHandler): Router {
    const r = Router();
    r.use(authMiddleware);

    r.post("/start", (_req, res) => {
        res.status(501).json({ error: "render: not implemented (scaffold)" });
    });
    r.get("/:jobId", (_req, res) => {
        res.status(501).json({ error: "render: not implemented (scaffold)" });
    });
    r.get("/:jobId/download", (_req, res) => {
        res.status(501).json({ error: "render: not implemented (scaffold)" });
    });

    return r;
}
