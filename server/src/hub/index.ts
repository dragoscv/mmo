/**
 * Hub wiring (WP16-07): WebSocket `/hub` + HTTP `/hub/*`.
 *
 *   WS  /hub?t=<deviceToken>            paired device / web (full access)
 *   WS  /hub?inv=<invite>&name=<name>   Watch Together guest (room only)
 *   GET  /hub/devices                   online devices + now playing      (device token)
 *   POST /hub/command {target, action, args}  → target's ack (4 s)        (device token)
 *   POST /hub/rooms {name?}             → {roomId, invite}                (device token)
 *   GET  /hub/rooms/:id                 snapshot                           (device token)
 *   GET  /hub/invite/:invite            public: {roomId, name, phase, media} for the join page
 *   GET  /hub/reports?status=open|resolved|all     chat reports (device token, owner)
 *   POST /hub/reports/:id/resolve {resolution}     mark a report handled
 *   GET  /hub/blocks?profile=           persisted blocks; DELETE /hub/blocks/:profileId/:deviceId
 *   GET|PUT /hub/settings {chatFilter}  owner switch for the chat word filter
 *
 * Guests stream only the room's current file: `/video/*` accepts `?inv=` for that fileId
 * (see `inviteAllowsFile`).
 */

import type { Server as HttpServer } from "node:http";
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { HubCore } from "./core";
import type { MediaModerationStore } from "./moderation";

export interface HubOptions {
    getDeviceToken: () => string | undefined;
    isAllowedOrigin: (origin: string | undefined) => boolean;
    /** Secret for invites (persisted by the caller so links survive restarts). */
    getSecret: () => string;
    /** Chat moderation persistence (media.sqlite). Without it, filter is on and reports/blocks are not stored. */
    moderation?: MediaModerationStore;
    log?: { info: (m: string, f?: Record<string, unknown>) => void; warn: (m: string, f?: Record<string, unknown>) => void };
}

export interface Hub {
    core: HubCore;
    router: express.Router;
    attach(server: HttpServer): void;
    close(): void;
}

const safeEq = (a: string, b: string) => {
    const x = Buffer.from(a); const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function createHub(opts: HubOptions): Hub {
    const sockets = new Map<string, WebSocket>();
    const send = (connId: string, msg: object) => {
        const ws = sockets.get(connId);
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const core = new HubCore(send, opts.getSecret, Date.now, opts.moderation ?? null);
    const moderation = opts.moderation;
    const ticker = setInterval(() => core.tick(), 1000);
    ticker.unref?.();

    const tokenOk = (t: string | undefined | null) => {
        const want = opts.getDeviceToken();
        return Boolean(want && t && safeEq(t, want));
    };
    const auth: express.RequestHandler = (req, res, next) => {
        const t = req.header("x-device-token") ?? (typeof req.query.t === "string" ? req.query.t : undefined);
        if (!tokenOk(t)) { res.status(401).json({ error: "Unauthorized" }); return; }
        next();
    };

    const router = express.Router();
    router.use(express.json({ limit: "64kb" }));
    router.get("/invite/:invite", (req, res) => {
        const roomId = core.verifyInvite(req.params.invite);
        const room = roomId ? core.rooms.get(roomId) : undefined;
        if (!room) { res.status(404).json({ error: "invite_invalid" }); return; }
        res.json({ roomId: room.id, name: room.name, phase: room.phase, media: room.media, members: room.members.size });
    });
    router.get("/devices", auth, (req, res) => {
        res.json({ devices: core.listDevices({ targetsOnly: req.query.targets === "1" }), serverTime: Date.now() });
    });
    const noModeration = (res: express.Response) => res.status(503).json({ error: "moderation storage unavailable" });
    router.get("/reports", auth, (req, res) => {
        if (!moderation) { noModeration(res); return; }
        const s = req.query.status;
        const status = s === "resolved" || s === "all" ? s : "open";
        const limit = Number(req.query.limit);
        res.json({ reports: moderation.listReports({ status, limit: Number.isFinite(limit) ? limit : undefined }) });
    });
    router.post("/reports/:id/resolve", auth, (req, res) => {
        if (!moderation) { noModeration(res); return; }
        const resolution = typeof req.body?.resolution === "string" ? req.body.resolution : "resolved";
        const r = moderation.resolveReport(String(req.params.id), resolution);
        if (!r) { res.status(404).json({ error: "report not found" }); return; }
        res.json({ report: r });
    });
    router.get("/blocks", auth, (req, res) => {
        if (!moderation) { noModeration(res); return; }
        res.json({ blocks: moderation.listBlocks(typeof req.query.profile === "string" ? req.query.profile : undefined) });
    });
    router.delete("/blocks/:profileId/:deviceId", auth, (req, res) => {
        if (!moderation) { noModeration(res); return; }
        res.json({ removed: moderation.removeBlock(String(req.params.profileId), String(req.params.deviceId)) });
    });
    router.get("/settings", auth, (_req, res) => {
        res.json({ chatFilter: moderation ? moderation.chatFilterEnabled() : true });
    });
    router.put("/settings", auth, (req, res) => {
        if (!moderation) { noModeration(res); return; }
        if (typeof req.body?.chatFilter !== "boolean") { res.status(400).json({ error: "chatFilter must be a boolean" }); return; }
        moderation.setChatFilter(req.body.chatFilter);
        res.json({ chatFilter: moderation.chatFilterEnabled() });
    });
    router.post("/command", auth, (req, res) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        if (typeof b.target !== "string" || typeof b.action !== "string") { res.status(400).json({ error: "target and action required" }); return; }
        void core.command(b.target, b.action, b.args).then((ack) => {
            res.status(ack.ok === false && ack.error === "no_such_device" ? 404 : ack.ok === false && ack.error === "timeout" ? 504 : 200).json(ack);
        });
    });
    router.post("/rooms", auth, (req, res) => {
        const { room, invite } = core.createRoom(typeof req.body?.name === "string" ? req.body.name : undefined);
        res.status(201).json({ roomId: room.id, invite });
    });
    router.get("/rooms/:id", auth, (req, res) => {
        const room = core.rooms.get(String(req.params.id));
        if (!room) { res.status(404).json({ error: "room not found" }); return; }
        res.json(core.roomSnapshot(room));
    });

    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    const onUpgrade = (req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
        const url = new URL(req.url ?? "", "http://localhost");
        if (url.pathname !== "/hub") return;
        const t = url.searchParams.get("t") ?? (req.headers["x-device-token"] as string | undefined);
        const inv = url.searchParams.get("inv");
        const full = tokenOk(t);
        const inviteRoom = !full ? core.verifyInvite(inv) : null;
        // Device-token clients may connect from anywhere they hold the token (TV apps have no Origin);
        // invite guests come from browsers, so their Origin must be allowed.
        if (!full && (!inviteRoom || !opts.isAllowedOrigin(req.headers.origin as string | undefined))) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            const connId = crypto.randomUUID();
            sockets.set(connId, ws);
            let alive = true;
            ws.on("pong", () => { alive = true; });
            const ping = setInterval(() => {
                if (!alive) { ws.terminate(); return; }
                alive = false;
                try { ws.ping(); } catch { /* closed */ }
            }, 20_000);
            ws.on("message", (data) => {
                let msg: unknown;
                try { msg = JSON.parse(String(data)); } catch { return; }
                core.message(connId, msg);
            });
            const close = () => {
                clearInterval(ping);
                if (sockets.delete(connId)) core.disconnect(connId);
            };
            ws.on("close", close);
            ws.on("error", close);
            core.connect(connId, inviteRoom
                ? { guest: true, guestName: (url.searchParams.get("name") ?? "Guest").slice(0, 32), inviteRoomId: inviteRoom }
                : {});
        });
    };

    let attached: HttpServer | null = null;
    return {
        core,
        router,
        attach(server) {
            attached = server;
            server.on("upgrade", onUpgrade);
            opts.log?.info("[hub] /hub WebSocket ready");
        },
        close() {
            clearInterval(ticker);
            attached?.off("upgrade", onUpgrade);
            for (const ws of sockets.values()) try { ws.close(); } catch { /* ignore */ }
            wss.close();
        },
    };
}
