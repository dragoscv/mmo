/**
 * Offline downloads (WP16-50, D37). Mounted at `/video` next to video-routes.ts.
 *
 *   GET /video/file/:fileId                       original file, Range, attachment (Android downloads)
 *   GET /video/download/:fileId?container=mp4&audio=<n>
 *        mp4  → 200/206 ranged MP4 once the remux is cached; 202 {jobId, state, progress} while preparing
 *        else → same as /video/file/:fileId
 *   GET /video/download/:fileId/status?audio=<n>  job/caching state (404 when never requested)
 *   GET /video/downloads/cache                    {bytes, files, capBytes}
 *
 * Kids over their daily cap get 403 `{error:"daily_cap"}` (playback gate). Auth = device token
 * (header or `?t=`), same as the streaming routes.
 */

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { contentDisposition, sendRangedFile, videoContentType } from "./http-range";
import type { DownloadCache, MediaTracks } from "./download-cache";
import { playbackGate } from "../media/playback-gate";

export interface DownloadRoutesDeps {
    auth: express.RequestHandler;
    cache: () => DownloadCache | null;
    /** fileId → absolute path + registry meta (null when unknown). */
    resolve: (fileId: string) => Promise<{ absPath: string; meta: Record<string, unknown> } | null>;
    /** Track info for the remux (runs inside the job; may probe). */
    tracks: (absPath: string, meta: Record<string, unknown>) => Promise<MediaTracks>;
}

const queryAuth: express.RequestHandler = (req, _res, next) => {
    if (typeof req.query.t === "string" && !req.headers["x-device-token"]) req.headers["x-device-token"] = req.query.t;
    next();
};

function audioParam(v: unknown): number {
    const n = parseInt(typeof v === "string" ? v : "0", 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(31, n)) : 0;
}

function titleOf(meta: Record<string, unknown>, absPath: string): string {
    const parsed = meta.parsed as { title?: string; year?: number | null; season?: number | null; episode?: number | null } | undefined;
    if (parsed?.title) {
        const se = parsed.season && parsed.episode ? ` S${String(parsed.season).padStart(2, "0")}E${String(parsed.episode).padStart(2, "0")}` : "";
        return `${parsed.title}${parsed.year && !se ? ` (${parsed.year})` : ""}${se}`;
    }
    return path.basename(absPath, path.extname(absPath));
}

/** Registry meta (ffprobe at scan time) → MediaTracks; null when the scan did not record tracks. */
export function tracksFromMeta(meta: Record<string, unknown>): MediaTracks | null {
    const at = meta.audioTracks as Array<{ codec?: string; channels?: number }> | undefined;
    if (!Array.isArray(at)) return null;
    const st = (meta.subtitleTracks as Array<{ codec?: string }> | undefined) ?? [];
    return {
        videoCodec: typeof meta.videoCodec === "string" ? meta.videoCodec : null,
        durationSec: typeof meta.durationSec === "number" ? meta.durationSec : null,
        audioTracks: at.map((a) => ({ codec: a.codec ?? null, channels: a.channels ?? null })),
        subtitleTracks: st.map((s) => ({ codec: s.codec ?? null })),
    };
}

export function createDownloadRouter(deps: DownloadRoutesDeps): express.Router {
    const r = express.Router();
    const auth = deps.auth as express.RequestHandler<Record<string, string>>;
    const qa = queryAuth as express.RequestHandler<Record<string, string>>;

    const original = async (req: express.Request<Record<string, string>>, res: express.Response) => {
        const f = await deps.resolve(req.params.fileId);
        if (!f) { res.status(404).json({ error: "unknown fileId" }); return; }
        if (!fs.existsSync(f.absPath)) { res.status(404).json({ error: "file missing on disk", code: "file_missing" }); return; }
        const name = path.basename(f.absPath);
        sendRangedFile(req as unknown as express.Request, res, f.absPath, videoContentType(path.extname(name)), {
            "Content-Disposition": contentDisposition(name), "Cache-Control": "private, max-age=3600",
        });
    };

    r.get("/file/:fileId", qa, auth, playbackGate, (req, res) => { void original(req, res); });

    r.get("/download/:fileId/status", qa, auth, async (req, res) => {
        const cache = deps.cache();
        if (!cache) { res.status(503).json({ error: "downloads cache unavailable" }); return; }
        const f = await deps.resolve(req.params.fileId);
        if (!f) { res.status(404).json({ error: "unknown fileId" }); return; }
        const st = cache.status(req.params.fileId, audioParam(req.query.audio), f.absPath);
        if (!st) { res.status(404).json({ error: "not requested", state: "none" }); return; }
        res.json(st);
    });

    r.get("/download/:fileId", qa, auth, playbackGate, async (req, res) => {
        const container = typeof req.query.container === "string" ? req.query.container.toLowerCase() : "original";
        if (container !== "mp4") { await original(req, res); return; }
        const cache = deps.cache();
        if (!cache) { res.status(503).json({ error: "downloads cache unavailable" }); return; }
        const f = await deps.resolve(req.params.fileId);
        if (!f) { res.status(404).json({ error: "unknown fileId" }); return; }
        if (!fs.existsSync(f.absPath)) { res.status(404).json({ error: "file missing on disk", code: "file_missing" }); return; }
        const audio = audioParam(req.query.audio);
        const ready = cache.ready(req.params.fileId, audio, f.absPath);
        if (ready) {
            const name = `${titleOf(f.meta, f.absPath)}.mp4`;
            sendRangedFile(req as unknown as express.Request, res, ready, "video/mp4", { "Content-Disposition": contentDisposition(name), "Cache-Control": "private, max-age=3600" });
            return;
        }
        const job = cache.prepare(req.params.fileId, audio, f.absPath, () => deps.tracks(f.absPath, f.meta), titleOf(f.meta, f.absPath));
        if (job.state === "failed") { res.status(500).json(job); return; }
        res.setHeader("Retry-After", "5");
        res.status(202).json(job);
    });

    r.get("/downloads/cache", auth, (_req, res) => {
        const cache = deps.cache();
        if (!cache) { res.status(503).json({ error: "downloads cache unavailable" }); return; }
        res.json(cache.usage());
    });

    return r;
}
