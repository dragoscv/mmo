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
 *   GET    /livetv/catchup/:channelId?start=&duration=   302
 *   GET    /livetv/recordings  POST /livetv/recordings  DELETE /livetv/recordings/:id
 *   GET    /livetv/rules       POST /livetv/rules       DELETE /livetv/rules/:id
 *
 * JSON only; errors are `{error}` with 400/404/409/502.
 */

import express from "express";
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

export function createLiveTvRouter(deps: LiveTvRouterDeps): express.Router {
    const { service, dvr, log } = deps;
    const fetchImpl = deps.fetch ?? defaultFetch;
    const router = express.Router();
    router.use(express.json({ limit: "256kb" }));

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
    router.get("/stream/:channelId", wrap(async (req, res) => {
        const url = service.streamUrlFor(param(req, "channelId"));
        if (!url) throw new LiveTvError(404, "channel not found");
        if (!truthy(req.query.proxy)) {
            res.setHeader("cache-control", "no-store");
            res.redirect(302, url);
            return;
        }
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
