/**
 * /livetv/* — Live TV / IPTV / DVR API (mount behind the device-token auth).
 *
 *   GET    /livetv/sources                     SourceView[]   (passwords → hasPassword)
 *   POST   /livetv/sources                     SourceInput → SourceView (201)
 *   PATCH  /livetv/sources/:id                 SourcePatch → SourceView
 *   DELETE /livetv/sources/:id                 {ok}
 *   POST   /livetv/sources/:id/test            TestResult
 *   POST   /livetv/sources/:id/refresh         {source, guide}
 *   GET    /livetv/channels?group=&profile=&favourites=1&hidden=1&source=
 *   PATCH  /livetv/channels/:id                {hidden?, sort?, number?}
 *   PUT    /livetv/channels/:id/favourite?profile=   DELETE same
 *   GET    /livetv/groups
 *   GET    /livetv/guide?from=&to=&channels=a,b      (epoch ms, ≤ 48 h)
 *   GET    /livetv/now?channels=a,b
 *   GET    /livetv/stream/:channelId[?proxy=1]       302 upstream | piped bytes
 *          (HLS playlists are rewritten so every variant/segment/key goes through /livetv/proxy)
 *   GET    /livetv/proxy/:channelId?u=&s=            signed pass-through of one URL seen in a proxied playlist
 *   GET    /livetv/catchup/:channelId?start=&duration=   302
 *   GET    /livetv/recordings  POST /livetv/recordings  DELETE /livetv/recordings/:id
 *   GET    /livetv/rules       POST /livetv/rules       DELETE /livetv/rules/:id
 *
 * JSON only; errors are `{error}` with 400/404/409/502.
 */

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { LiveTvService } from "./service";
import type { DvrScheduler } from "./recorder";
import { LiveTvError, type ChannelPatch, type RecordingInput, type RuleInput, type SourceInput, type SourcePatch } from "./types";
import { defaultFetch, errorMessage, redactUrl, type FetchLike, type LiveTvLogger } from "./util";

export interface LiveTvRouterDeps {
    service: LiveTvService;
    dvr: DvrScheduler;
    log: LiveTvLogger;
    /** Used by `?proxy=1`. */
    fetch?: FetchLike;
}

const qs = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const qnum = (v: unknown): number | undefined => {
    const s = qs(v);
    if (s === undefined) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
};
const qlist = (v: unknown): string[] | undefined => {
    const s = qs(v);
    if (!s) return undefined;
    const arr = s.split(",").map((x) => x.trim()).filter(Boolean);
    if (arr.length > 2000) throw new LiveTvError(400, "too many channel ids");
    return arr;
};
const truthy = (v: unknown) => v === "1" || v === "true";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const PROFILE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

const CT: Record<string, string> = { ".mkv": "video/x-matroska", ".ts": "video/mp2t", ".mp4": "video/mp4" };

/** Parse one `bytes=` range against `size` → inclusive [start, end], or null when unsatisfiable. */
export function parseByteRange(header: string, size: number): [number, number] | null {
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m || (m[1] === "" && m[2] === "") || size <= 0) return null;
    let start: number, end: number;
    if (m[1] === "") { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }
    else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
    return start <= end && start < size ? [start, end] : null;
}

function sendFileRange(req: express.Request, res: express.Response, file: string): void {
    const size = fs.statSync(file).size;
    const ct = CT[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const name = path.basename(file).replace(/[^\w.\- ]/g, "_");
    const base = { "Content-Type": ct, "Accept-Ranges": "bytes", "Content-Disposition": `inline; filename="${name}"`, "Cache-Control": "no-store" };
    const range = req.headers.range;
    if (range) {
        const r = parseByteRange(range, size);
        if (!r) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
        res.writeHead(206, { ...base, "Content-Range": `bytes ${r[0]}-${r[1]}/${size}`, "Content-Length": r[1] - r[0] + 1 });
        fs.createReadStream(file, { start: r[0], end: r[1] }).pipe(res);
        return;
    }
    res.writeHead(200, { ...base, "Content-Length": size });
    fs.createReadStream(file).pipe(res);
}
function profileOf(req: express.Request): string {
    const p = qs(req.query.profile) ?? "default";
    if (!PROFILE_RE.test(p)) throw new LiveTvError(400, "invalid profile");
    return p;
}

function pick<T extends object>(body: Record<string, unknown>, keys: readonly (keyof T & string)[]): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
    return out as Partial<T>;
}

const SOURCE_KEYS = ["kind", "name", "url", "xmltvUrl", "username", "password", "enabled", "refreshHours", "tunerLimit"] as const;
const HOP_HEADERS = ["content-type", "content-length", "cache-control", "last-modified", "etag", "accept-ranges", "content-range"];

const isPlaylist = (url: string, contentType: string | null) =>
    /mpegurl/i.test(contentType ?? "") || /\.m3u8?(\?|$)/i.test(url);

/**
 * Rewrites every URI of an HLS playlist (plain lines + `URI="…"` attributes) to [toProxy](absolute URL).
 * Relative URIs resolve against the playlist URL after redirects (`base`).
 */
export function rewritePlaylist(text: string, base: string, toProxy: (abs: string) => string): string {
    const abs = (u: string) => { try { return new URL(u, base).toString(); } catch { return u; } };
    return text.split(/\r?\n/).map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_m, u: string) => `URI="${toProxy(abs(u))}"`);
        return toProxy(abs(t));
    }).join("\n");
}

export function createLiveTvRouter(deps: LiveTvRouterDeps): express.Router {
    const { service, dvr, log } = deps;
    const fetchImpl = deps.fetch ?? defaultFetch;
    const router = express.Router();
    router.use(express.json({ limit: "256kb" }));
    // Signs proxied URLs so /livetv/proxy only fetches URLs that appeared in a playlist we served
    // (no open proxy / SSRF). Per process: after a restart the player simply refetches the master.
    const proxySecret = crypto.randomBytes(32);
    const sign = (channelId: string, u: string) => crypto.createHmac("sha256", proxySecret).update(`${channelId}\n${u}`).digest("base64url").slice(0, 32);

    const fail = (res: express.Response, err: unknown, path: string) => {
        if (err instanceof LiveTvError) { res.status(err.status).json({ error: err.message }); return; }
        log.error("[livetv] handler failed", err, { path });
        if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    };
    const wrap = (fn: (req: express.Request, res: express.Response) => Promise<void> | void): express.RequestHandler =>
        (req, res) => {
            try {
                const r = fn(req, res);
                if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch((err: unknown) => fail(res, err, req.path));
            } catch (err) {
                fail(res, err, req.path);
            }
        };
    const param = (req: express.Request, name: string): string => {
        const v = req.params[name];
        return Array.isArray(v) ? v.join("/") : String(v ?? "");
    };
    const body = (req: express.Request): Record<string, unknown> => {
        if (!isObj(req.body)) throw new LiveTvError(400, "JSON object body required");
        return req.body;
    };

    // ── sources ──────────────────────────────────────────────────────────
    router.get("/sources", wrap((_req, res) => { res.json({ sources: service.listSources() }); }));

    router.post("/sources", wrap(async (req, res) => {
        const input = pick<SourceInput>(body(req), SOURCE_KEYS) as SourceInput;
        const created = service.createSource(input);
        res.status(201).json(created);
        // First lineup + guide in the background; the client polls GET /sources.
        if (created.enabled) {
            void service.refreshSource(created.id)
                .then((r) => (r.ok ? service.refreshGuide(created.id) : undefined))
                .catch((err: unknown) => log.warn("[livetv] initial refresh failed", { source: created.id }, err));
        }
    }));

    router.patch("/sources/:id", wrap((req, res) => {
        const patch = pick<SourcePatch>(body(req), SOURCE_KEYS.filter((k) => k !== "kind") as Array<keyof SourcePatch & string>);
        if (body(req).kind !== undefined) throw new LiveTvError(400, "kind cannot be changed");
        res.json(service.updateSource(param(req, "id"), patch));
    }));

    router.delete("/sources/:id", wrap((req, res) => {
        service.deleteSource(param(req, "id"));
        res.json({ ok: true });
    }));

    router.post("/sources/:id/test", wrap(async (req, res) => {
        res.json(await service.testSource(param(req, "id")));
    }));

    router.post("/sources/:id/refresh", wrap(async (req, res) => {
        const id = param(req, "id");
        const source = await service.refreshSource(id);
        const guide = source.ok ? await service.refreshGuide(id) : null;
        res.json({ source, guide });
    }));

    // ── channels ─────────────────────────────────────────────────────────
    router.get("/channels", wrap((req, res) => {
        const profile = profileOf(req);
        const group = typeof req.query.group === "string" ? req.query.group : undefined;
        res.json({
            channels: service.channels({
                group, favouritesOf: profile, favouritesOnly: truthy(req.query.favourites), includeHidden: truthy(req.query.hidden),
                sourceId: qs(req.query.source),
            }),
        });
    }));

    router.patch("/channels/:id", wrap((req, res) => {
        res.json(service.updateChannel(param(req, "id"), pick<ChannelPatch>(body(req), ["hidden", "sort", "number"])));
    }));

    router.put("/channels/:id/favourite", wrap((req, res) => {
        service.setFavourite(profileOf(req), param(req, "id"), true);
        res.json({ ok: true, favourite: true });
    }));

    router.delete("/channels/:id/favourite", wrap((req, res) => {
        service.setFavourite(profileOf(req), param(req, "id"), false);
        res.json({ ok: true, favourite: false });
    }));

    router.get("/groups", wrap((_req, res) => { res.json({ groups: service.groups() }); }));

    // ── guide ────────────────────────────────────────────────────────────
    router.get("/guide", wrap((req, res) => {
        const from = qnum(req.query.from) ?? Date.now() - 3_600_000;
        const to = qnum(req.query.to) ?? from + 12 * 3_600_000;
        res.json({ from, to, programmes: service.guide(from, to, qlist(req.query.channels)) });
    }));

    router.get("/now", wrap((req, res) => {
        res.json({ now: Date.now(), channels: service.nowNext(qlist(req.query.channels)) });
    }));

    // ── playback ─────────────────────────────────────────────────────────
    /** Fetch [url] and pipe it; HLS playlists are rewritten to signed proxy URLs. */
    const pipeUpstream = async (req: express.Request, res: express.Response, channelId: string, url: string) => {
        const ac = new AbortController();
        const abort = () => ac.abort();
        req.on("close", abort);
        res.on("close", abort);
        let upstream: Response;
        try {
            const headers: Record<string, string> = {};
            if (typeof req.headers.range === "string") headers.range = req.headers.range;
            upstream = await fetchImpl(url, { signal: ac.signal, headers });
        } catch (err) {
            if (ac.signal.aborted) return;
            log.warn("[livetv] proxy upstream failed", { url: redactUrl(url), error: errorMessage(err) });
            res.status(502).json({ error: "upstream unreachable" });
            return;
        }
        const finalUrl = (upstream as { url?: string }).url || url;
        if (upstream.ok && isPlaylist(finalUrl, upstream.headers.get("content-type"))) {
            const text = await upstream.text();
            const t = typeof req.query.t === "string" ? `&t=${encodeURIComponent(req.query.t)}` : "";
            const prefix = `${req.baseUrl}/proxy/${encodeURIComponent(channelId)}`;
            const body = rewritePlaylist(text, finalUrl, (abs) => `${prefix}?u=${Buffer.from(abs).toString("base64url")}&s=${sign(channelId, abs)}${t}`);
            res.status(200).setHeader("content-type", "application/vnd.apple.mpegurl");
            res.setHeader("cache-control", "no-store");
            res.send(body);
            return;
        }
        res.status(upstream.status);
        for (const h of HOP_HEADERS) {
            const v = upstream.headers.get(h);
            if (v) res.setHeader(h, v);
        }
        res.setHeader("cache-control", "no-store");
        if (!upstream.body) { res.end(); return; }
        const stream = Readable.fromWeb(upstream.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
        stream.on("error", () => { abort(); res.destroy(); });
        stream.pipe(res);
    };

    router.get("/stream/:channelId", wrap(async (req, res) => {
        const channelId = param(req, "channelId");
        const url = service.streamUrlFor(channelId);
        if (!url) throw new LiveTvError(404, "channel not found");
        if (!truthy(req.query.proxy)) {
            res.setHeader("cache-control", "no-store");
            res.redirect(302, url);
            return;
        }
        await pipeUpstream(req, res, channelId, url);
    }));

    router.get("/proxy/:channelId", wrap(async (req, res) => {
        const channelId = param(req, "channelId");
        const u = qs(req.query.u);
        const s = qs(req.query.s);
        if (!u || !s) throw new LiveTvError(400, "u and s required");
        let abs: string;
        try { abs = Buffer.from(u, "base64url").toString("utf8"); } catch { throw new LiveTvError(400, "bad u"); }
        const want = Buffer.from(sign(channelId, abs));
        const got = Buffer.from(s);
        if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new LiveTvError(403, "bad signature");
        if (!/^https?:\/\//i.test(abs)) throw new LiveTvError(400, "unsupported scheme");
        await pipeUpstream(req, res, channelId, abs);
    }));

    router.get("/catchup/:channelId", wrap((req, res) => {
        const start = qnum(req.query.start);
        const duration = qnum(req.query.duration);
        if (start === undefined || duration === undefined) throw new LiveTvError(400, "start (epoch ms) and duration (minutes) required");
        res.setHeader("cache-control", "no-store");
        res.redirect(302, service.catchupUrlFor(param(req, "channelId"), start, duration));
    }));

    // ── DVR ──────────────────────────────────────────────────────────────
    router.get("/recordings", wrap((_req, res) => { res.json({ recordings: dvr.list() }); }));

    router.post("/recordings", wrap((req, res) => {
        const b = body(req);
        const channelId = b.channelId;
        if (typeof channelId !== "string" || !channelId) throw new LiveTvError(400, "channelId required");
        const prog = b.programme;
        if (isObj(prog) || typeof prog === "number") {
            const start = typeof prog === "number" ? prog : Number(prog.start);
            if (!Number.isFinite(start)) throw new LiveTvError(400, "programme.start must be epoch ms");
            const view = dvr.scheduleProgramme(channelId, start, {
                before: b.paddingBeforeSec as number | undefined, after: b.paddingAfterSec as number | undefined,
            });
            res.status(201).json(view);
            return;
        }
        const input = pick<RecordingInput>(b, ["channelId", "start", "stop", "title", "paddingBeforeSec", "paddingAfterSec"]) as RecordingInput;
        res.status(201).json(dvr.schedule(input));
    }));

    router.delete("/recordings/:id", wrap((req, res) => {
        res.json({ ok: true, ...dvr.remove(param(req, "id")) });
    }));

    // Finished recording as-is (`-c copy` MKV/TS), Range-capable for <video> seeking + offline download.
    router.get("/recordings/:id/file", wrap((req, res) => {
        const file = dvr.filePath(param(req, "id"));
        if (!file) throw new LiveTvError(404, "recording not found or not finished");
        sendFileRange(req, res, file);
    }));

    router.get("/rules", wrap((_req, res) => { res.json({ rules: dvr.listRules() }); }));

    router.post("/rules", wrap((req, res) => {
        const input = pick<RuleInput>(body(req), ["titleMatch", "channelId", "paddingBeforeSec", "paddingAfterSec", "keepLast", "enabled"]) as RuleInput;
        res.status(201).json(dvr.createRule(input));
    }));

    router.delete("/rules/:id", wrap((req, res) => {
        dvr.deleteRule(param(req, "id"));
        res.json({ ok: true });
    }));

    return router;
}
