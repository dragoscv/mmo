/**
 * WebSocket heartbeat + command channel.
 *
 * Replaces the 10s HTTP announce poll with a persistent connection:
 *
 *   companion --(WS /ws)--> gateway
 *     → on connect: auth with bearer device token, mark device online,
 *       provision tunnel, push any pending commands.
 *     → companion sends {type:"hb", lanUrl?, version?, tunnelHostnameAck?}
 *       periodically; gateway bumps lastSeenAt + may push tunnelBootstrap.
 *     → companion sends {type:"results", results:[...]}; gateway records.
 *     → gateway pushes {type:"commands", commands:[...]} as work arrives
 *       (drained on each heartbeat; a future LISTEN/NOTIFY can make it
 *       fully event-driven).
 *     → on close/error: mark device offline so the web UI flips fast.
 *
 * Liveness is authoritative here: a live socket == online. The DB
 * lastSeenAt is still written so the web app (which reads the DB) stays
 * correct without coupling to this process.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { devices } from "../db/schema.js";
import { findDeviceByToken } from "../lib/device-token.js";
import { validateDeviceLanUrl } from "../lib/url-guard.js";
import { claimPendingCommands, recordCommandResults, type IncomingCommandResult } from "../lib/device-commands.js";
import { ensureDeviceTunnel } from "../lib/tunnel.js";

interface HeartbeatMsg {
    type: "hb";
    lanUrl?: string | null;
    hostname?: string;
    os?: string;
    version?: string;
    tunnelHostnameAck?: string | null;
}
interface ResultsMsg { type: "results"; results: IncomingCommandResult[] }
type InboundMsg = HeartbeatMsg | ResultsMsg | { type: string;[k: string]: unknown };

// Track live sockets per device so multiple windows / reconnects are handled.
const liveByDevice = new Map<string, Set<WebSocket>>();

function addLive(deviceId: string, ws: WebSocket) {
    let set = liveByDevice.get(deviceId);
    if (!set) { set = new Set(); liveByDevice.set(deviceId, set); }
    set.add(ws);
}
function removeLive(deviceId: string, ws: WebSocket): boolean {
    const set = liveByDevice.get(deviceId);
    if (!set) return false;
    set.delete(ws);
    if (set.size === 0) { liveByDevice.delete(deviceId); return true; }
    return false;
}

function send(ws: WebSocket, msg: unknown) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

async function markOnline(deviceId: string, patch: Partial<typeof devices.$inferInsert> = {}) {
    await db.update(devices)
        .set({ status: "online", lastSeenAt: new Date(), ...patch })
        .where(eq(devices.id, deviceId));
}

async function markOffline(deviceId: string) {
    await db.update(devices)
        .set({ status: "offline" })
        .where(eq(devices.id, deviceId));
}

async function tunnelBootstrap(deviceId: string, ack: string | null | undefined, lanUrl: string | null) {
    let port: number | undefined;
    if (lanUrl) { try { port = Number(new URL(lanUrl).port) || undefined; } catch { /* ignore */ } }
    const t = await ensureDeviceTunnel(deviceId, port ? { port } : {});
    if (!t || ack === t.tunnelHostname) return null;
    return t;
}

async function drainCommands(ws: WebSocket, deviceId: string) {
    const commands = await claimPendingCommands(deviceId);
    if (commands.length > 0) send(ws, { type: "commands", commands });
}

export function createCompanionWss(): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true });

    wss.on("connection", (ws: WebSocket, _req: IncomingMessage, deviceId: string, deviceName: string) => {
        let alive = true;
        addLive(deviceId, ws);

        void markOnline(deviceId).then(() => drainCommands(ws, deviceId)).catch(() => { });
        send(ws, { type: "welcome", name: deviceName });

        // Liveness ping every 25s; terminate if no pong (dead NAT, sleep).
        ws.on("pong", () => { alive = true; });
        const pinger = setInterval(() => {
            if (!alive) { ws.terminate(); return; }
            alive = false;
            try { ws.ping(); } catch { /* ignore */ }
        }, 25_000);

        ws.on("message", (raw) => {
            void (async () => {
                let msg: InboundMsg;
                try { msg = JSON.parse(raw.toString()); } catch { return; }
                if (msg.type === "hb") {
                    const hb = msg as HeartbeatMsg;
                    const patch: Partial<typeof devices.$inferInsert> = {};
                    if (typeof hb.hostname === "string" && hb.hostname.length <= 128) patch.hostname = hb.hostname;
                    if (typeof hb.os === "string" && hb.os.length <= 64) patch.os = hb.os;
                    if (typeof hb.version === "string" && hb.version.length <= 32) patch.version = hb.version;
                    let lanUrl: string | null = null;
                    if (hb.lanUrl === null) { patch.lanUrl = null; patch.lanAnnouncedAt = new Date(); }
                    else if (hb.lanUrl !== undefined) {
                        const v = validateDeviceLanUrl(hb.lanUrl);
                        if (v) { patch.lanUrl = v; patch.lanAnnouncedAt = new Date(); lanUrl = v; }
                    }
                    await markOnline(deviceId, patch);
                    const boot = await tunnelBootstrap(deviceId, hb.tunnelHostnameAck, lanUrl);
                    if (boot) send(ws, { type: "tunnelBootstrap", ...boot });
                    await drainCommands(ws, deviceId);
                } else if (msg.type === "results") {
                    const r = msg as ResultsMsg;
                    if (Array.isArray(r.results) && r.results.length > 0) {
                        await recordCommandResults(deviceId, r.results);
                    }
                    await drainCommands(ws, deviceId);
                }
            })().catch((err) => console.warn("[ws] message error:", err instanceof Error ? err.message : err));
        });

        const cleanup = () => {
            clearInterval(pinger);
            const last = removeLive(deviceId, ws);
            if (last) void markOffline(deviceId).catch(() => { });
        };
        ws.on("close", cleanup);
        ws.on("error", cleanup);
    });

    return wss;
}

/**
 * Authenticate the upgrade request, then hand it to the WSS. Token comes
 * from `Authorization: Bearer` or `?token=`. Rejects unauthenticated
 * upgrades with a 401 before the socket is established.
 */
export function attachUpgradeHandler(wss: WebSocketServer, expectedPath = "/ws") {
    return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        void (async () => {
            try {
                const url = new URL(req.url ?? "/", "http://localhost");
                if (url.pathname !== expectedPath) { socket.destroy(); return; }
                const auth = req.headers["authorization"];
                const bearer = typeof auth === "string" && auth.startsWith("Bearer ")
                    ? auth.slice(7) : url.searchParams.get("token");
                if (!bearer) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
                const device = await findDeviceByToken(bearer);
                if (!device) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
                wss.handleUpgrade(req, socket, head, (ws) => {
                    wss.emit("connection", ws, req, device.id, device.name);
                });
            } catch (err) {
                console.warn("[ws] upgrade error:", err instanceof Error ? err.message : err);
                try { socket.destroy(); } catch { /* ignore */ }
            }
        })();
    };
}
