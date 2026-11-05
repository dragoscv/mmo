/**
 * /cast/* HTTP API — one "Play on…" surface over DLNA renderers and
 * Home Assistant media players.
 *
 *   GET  /cast/devices              merged list: [{id, kind, name, state}] + haConfigured
 *   POST /cast/play                 {deviceId, url, mime, title, thumb?, subtitleUrl?, startSec?}
 *   POST /cast/command              {deviceId, action, value?}
 *   GET  /cast/status/:deviceId
 *
 * Device ids: `dlna:<udn>` or `ha:<entity_id>`. The media `url` MUST be
 * reachable by the renderer — the web app builds it from the companion's
 * LAN URL with `?t=&u=` query auth (see /audio/* and /video/* queryAuth).
 *
 * Google Cast from the browser (Web Sender SDK) does not pass through
 * here; it is handled client-side. Cast devices exposed via HA are `ha:*`.
 */

import express from "express";
import * as dlna from "./dlna";
import * as ha from "./home-assistant";

export type CastDeviceKind = "dlna" | "home-assistant" | "google-cast-ha";

export interface CastDevice {
    id: string;
    kind: CastDeviceKind;
    name: string;
    state?: string;
    model?: string;
}

const COMMANDS = new Set(["play", "pause", "stop", "seek", "volume_set", "volume_mute", "next", "previous"]);

function parseDeviceId(id: unknown): { kind: "dlna" | "ha"; ref: string } | null {
    if (typeof id !== "string") return null;
    if (id.startsWith("dlna:") && id.length > 5) return { kind: "dlna", ref: id.slice(5) };
    if (id.startsWith("ha:media_player.") && id.length > 16) return { kind: "ha", ref: id.slice(3) };
    return null;
}

function isHttpUrl(u: unknown): u is string {
    if (typeof u !== "string") return false;
    try { const p = new URL(u); return p.protocol === "http:" || p.protocol === "https:"; } catch { return false; }
}

export function createCastRouter(authMiddleware: express.RequestHandler): express.Router {
    const r = express.Router();
    r.use(authMiddleware);

    r.get("/devices", async (req, res) => {
        const refresh = req.query.refresh === "1";
        const haConfigured = ha.isConfigured();
        const [dlnaRes, haRes] = await Promise.allSettled([
            dlna.discoverRenderers(refresh),
            haConfigured ? ha.listMediaPlayers() : Promise.resolve([]),
        ]);
        const devices: CastDevice[] = [];
        const errors: string[] = [];
        if (dlnaRes.status === "fulfilled") {
            for (const d of dlnaRes.value) {
                devices.push({ id: `dlna:${d.udn}`, kind: "dlna", name: d.friendlyName, model: d.modelName });
            }
        } else errors.push(`dlna: ${String(dlnaRes.reason?.message ?? dlnaRes.reason)}`);
        if (haRes.status === "fulfilled") {
            for (const p of haRes.value) {
                devices.push({
                    id: `ha:${p.entityId}`,
                    kind: p.supportsCast ? "google-cast-ha" : "home-assistant",
                    name: p.name,
                    state: p.state,
                });
            }
        } else errors.push(`home-assistant: ${String(haRes.reason?.message ?? haRes.reason)}`);
        res.json({ devices, haConfigured, ...(errors.length ? { errors } : {}) });
    });

    r.post("/play", express.json(), async (req, res) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const target = parseDeviceId(body.deviceId);
        if (!target) { res.status(400).json({ error: "Invalid deviceId" }); return; }
        if (!isHttpUrl(body.url)) { res.status(400).json({ error: "Invalid url" }); return; }
        const mime = typeof body.mime === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(body.mime) ? body.mime : "video/mp4";
        const title = typeof body.title === "string" ? body.title.slice(0, 300) : "MixAI";
        const thumb = isHttpUrl(body.thumb) ? body.thumb : undefined;
        const subtitleUrl = isHttpUrl(body.subtitleUrl) ? body.subtitleUrl : undefined;
        const startSec = typeof body.startSec === "number" && Number.isFinite(body.startSec) ? body.startSec : undefined;
        try {
            if (target.kind === "dlna") {
                await dlna.play(target.ref, body.url, { title, mime, thumb, subtitleUrl, startSec });
            } else {
                await ha.playMedia(target.ref, body.url, { mime, title, thumb });
                if (startSec && startSec > 2) {
                    await new Promise((r2) => setTimeout(r2, 1_500));
                    await ha.mediaCommand(target.ref, "media_seek", startSec).catch(() => undefined);
                }
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    r.post("/command", express.json(), async (req, res) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const target = parseDeviceId(body.deviceId);
        const action = typeof body.action === "string" ? body.action : "";
        if (!target) { res.status(400).json({ error: "Invalid deviceId" }); return; }
        if (!COMMANDS.has(action)) { res.status(400).json({ error: "Invalid action" }); return; }
        const value = typeof body.value === "number" ? body.value : typeof body.value === "boolean" ? body.value : undefined;
        try {
            if (target.kind === "dlna") {
                switch (action) {
                    case "play": await dlna.resume(target.ref); break;
                    case "pause": await dlna.pause(target.ref); break;
                    case "stop": await dlna.stop(target.ref); break;
                    case "seek":
                        if (typeof value !== "number") { res.status(400).json({ error: "seek needs value" }); return; }
                        await dlna.seek(target.ref, value); break;
                    default:
                        res.status(400).json({ error: `${action} not supported on DLNA` }); return;
                }
            } else {
                const map: Record<string, ha.HaMediaCommand> = {
                    play: "media_play", pause: "media_pause", stop: "media_stop", seek: "media_seek",
                    volume_set: "volume_set", volume_mute: "volume_mute",
                    next: "media_next_track", previous: "media_previous_track",
                };
                await ha.mediaCommand(target.ref, map[action], value);
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    r.get("/status/:deviceId", async (req, res) => {
        const target = parseDeviceId(req.params.deviceId);
        if (!target) { res.status(400).json({ error: "Invalid deviceId" }); return; }
        try {
            const s = target.kind === "dlna" ? await dlna.status(target.ref) : await ha.getStatus(target.ref);
            res.json(s);
        } catch (e) {
            res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    return r;
}
