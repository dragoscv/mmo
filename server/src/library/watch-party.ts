/**
 * Watch Party — co-watch rooms over the companion's WebSocket.
 *
 * Wire model:
 *   POST /video/party/create  → { roomId } (HTTP, auth required)
 *   WS   /party/:roomId       → join the room (auth via ?token=&u=&name=)
 *
 * Host authority: the FIRST member to join becomes host. Only the host's
 * `state` messages (play/pause/seek/file) are rebroadcast — anyone else's
 * are dropped. Chat is free for everyone. When the host disconnects, the
 * next-oldest member is promoted.
 *
 * Rooms auto-expire 5 minutes after the last member leaves.
 */

import type { Server as HttpServer, IncomingMessage } from "node:http";
import type express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";

interface Member {
    id: string;          // ephemeral connection id
    userId: string;
    name: string;
    ws: WebSocket;
    joinedAt: number;
}

interface RoomState {
    fileId?: string;
    title?: string;
    playing: boolean;
    timeSec: number;
    /** Last updated wall-clock (ms) so clients can drift-correct on join. */
    lastUpdatedMs: number;
}

interface QueueItem {
    fileId: string;
    title: string;
    posterUrl?: string;
    durationSec?: number;
}

interface ActiveVote {
    id: string;
    fromId: string;
    targetTimeSec: number;
    label: string;
    yes: Set<string>;
    no: Set<string>;
    openedAt: number;
}

interface Room {
    id: string;
    members: Map<string, Member>;
    hostId: string | null;
    state: RoomState;
    queue: QueueItem[];
    activeVote: ActiveVote | null;
    expiresAt: number | null;
}

const rooms = new Map<string, Room>();
const ROOM_TTL_MS = 5 * 60 * 1000;

function broadcast(room: Room, msg: object, exceptMemberId?: string) {
    const data = JSON.stringify(msg);
    for (const m of room.members.values()) {
        if (m.id === exceptMemberId) continue;
        if (m.ws.readyState === WebSocket.OPEN) m.ws.send(data);
    }
}

function publicMember(m: Member) {
    return { id: m.id, userId: m.userId, name: m.name };
}

function publicMembers(room: Room) {
    return Array.from(room.members.values()).map(publicMember);
}

function promoteHost(room: Room) {
    let oldest: Member | null = null;
    for (const m of room.members.values()) {
        if (!oldest || m.joinedAt < oldest.joinedAt) oldest = m;
    }
    room.hostId = oldest?.id ?? null;
    if (room.hostId) {
        broadcast(room, { type: "host:change", hostId: room.hostId });
    }
}

function scheduleRoomCleanup(roomId: string) {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.members.size > 0) { room.expiresAt = null; return; }
    room.expiresAt = Date.now() + ROOM_TTL_MS;
    setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.members.size === 0 && r.expiresAt != null && Date.now() >= r.expiresAt) {
            rooms.delete(roomId);
        }
    }, ROOM_TTL_MS + 1000);
}

/** Constant-time compare of two strings. */
function safeEq(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}

/** Mount the HTTP route for creating a room. */
export function createWatchPartyRouter(authMiddleware: express.RequestHandler): express.Router {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const router = (require("express") as typeof express).Router();
    router.post("/party/create", authMiddleware, (_req, res) => {
        const id = randomBytes(6).toString("base64url");
        rooms.set(id, {
            id,
            members: new Map(),
            hostId: null,
            state: { playing: false, timeSec: 0, lastUpdatedMs: Date.now() },
            queue: [],
            activeVote: null,
            expiresAt: Date.now() + ROOM_TTL_MS,
        });
        // Schedule eviction in case nobody joins.
        scheduleRoomCleanup(id);
        res.json({ roomId: id });
    });
    router.get("/party/:roomId/info", authMiddleware, (req, res) => {
        const room = rooms.get(req.params.roomId);
        if (!room) { res.status(404).json({ error: "room not found" }); return; }
        res.json({ roomId: room.id, members: publicMembers(room), state: room.state, hostId: room.hostId });
    });
    return router;
}

/**
 * Attach a `/party/:roomId` WebSocket endpoint to the existing HTTP server.
 * Uses `noServer: true` and a manual upgrade dispatch, same pattern as yjs-ws.
 */
export function attachWatchPartyWs(
    httpServer: HttpServer,
    isAllowedOrigin: (o: string | undefined) => boolean,
    getDeviceToken: () => string | undefined,
): void {
    const wss = new WebSocketServer({ noServer: true });

    wss.on("connection", ((ws: WebSocket, _req: IncomingMessage, ctx: { roomId: string; userId: string; name: string }) => {
        const room = rooms.get(ctx.roomId);
        if (!room) {
            ws.send(JSON.stringify({ type: "error", error: "room not found" }));
            ws.close();
            return;
        }
        const member: Member = {
            id: randomUUID(),
            userId: ctx.userId,
            name: ctx.name,
            ws,
            joinedAt: Date.now(),
        };
        room.members.set(member.id, member);
        room.expiresAt = null;
        if (!room.hostId) room.hostId = member.id;

        ws.send(JSON.stringify({
            type: "hello",
            you: { id: member.id, isHost: room.hostId === member.id },
            room: {
                id: room.id,
                state: room.state,
                members: publicMembers(room),
                hostId: room.hostId,
                queue: room.queue,
            },
        }));
        broadcast(room, { type: "member:join", member: publicMember(member) }, member.id);

        ws.on("message", (data: Buffer) => {
            let msg: { type?: string;[k: string]: unknown };
            try { msg = JSON.parse(data.toString()); } catch { return; }
            if (!msg || typeof msg.type !== "string") return;
            switch (msg.type) {
                case "state": {
                    if (room.hostId !== member.id) return; // ignore non-host
                    const playing = !!msg.playing;
                    const timeSec = typeof msg.timeSec === "number" ? msg.timeSec : room.state.timeSec;
                    const fileId = typeof msg.fileId === "string" ? msg.fileId : room.state.fileId;
                    const title = typeof msg.title === "string" ? msg.title : room.state.title;
                    room.state = { playing, timeSec, fileId, title, lastUpdatedMs: Date.now() };
                    broadcast(room, { type: "state", state: room.state }, member.id);
                    break;
                }
                case "chat": {
                    const text = typeof msg.text === "string" ? msg.text.slice(0, 500) : "";
                    if (!text) return;
                    broadcast(room, { type: "chat", from: publicMember(member), text, ts: Date.now() });
                    break;
                }
                case "reaction": {
                    const emoji = typeof msg.emoji === "string" ? msg.emoji.slice(0, 8) : "";
                    if (!emoji) return;
                    broadcast(room, { type: "reaction", from: publicMember(member), emoji, ts: Date.now() });
                    break;
                }
                case "ping": {
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
                    break;
                }
                case "queue:set": {
                    if (room.hostId !== member.id) return;
                    const items = Array.isArray(msg.items) ? (msg.items as QueueItem[]).slice(0, 50) : [];
                    room.queue = items;
                    broadcast(room, { type: "queue:state", items: room.queue });
                    break;
                }
                case "cursor": {
                    const x = typeof msg.x === "number" ? Math.max(0, Math.min(1, msg.x)) : null;
                    if (x == null) return;
                    broadcast(room, { type: "cursor", memberId: member.id, name: member.name, x }, member.id);
                    break;
                }
                case "vote:propose": {
                    const targetTimeSec = typeof msg.targetTimeSec === "number" ? msg.targetTimeSec : null;
                    if (targetTimeSec == null) return;
                    const label = typeof msg.label === "string" ? msg.label.slice(0, 64) : "Skip to here";
                    room.activeVote = {
                        id: randomUUID(),
                        fromId: member.id,
                        targetTimeSec,
                        label,
                        yes: new Set([member.id]),
                        no: new Set(),
                        openedAt: Date.now(),
                    };
                    broadcast(room, { type: "vote:open", vote: { id: room.activeVote.id, fromId: member.id, fromName: member.name, targetTimeSec, label, openedAt: room.activeVote.openedAt } });
                    // auto-resolve in 8s
                    const voteId = room.activeVote.id;
                    setTimeout(() => {
                        if (!room.activeVote || room.activeVote.id !== voteId) return;
                        const total = room.members.size;
                        const passed = room.activeVote.yes.size * 2 > total;
                        broadcast(room, { type: "vote:result", id: voteId, passed, targetTimeSec: room.activeVote.targetTimeSec });
                        room.activeVote = null;
                    }, 8000);
                    break;
                }
                case "vote:cast": {
                    if (!room.activeVote) return;
                    if (msg.id !== room.activeVote.id) return;
                    if (msg.vote === "yes") { room.activeVote.yes.add(member.id); room.activeVote.no.delete(member.id); }
                    else if (msg.vote === "no") { room.activeVote.no.add(member.id); room.activeVote.yes.delete(member.id); }
                    broadcast(room, { type: "vote:tally", id: room.activeVote.id, yes: room.activeVote.yes.size, no: room.activeVote.no.size, total: room.members.size });
                    // immediate resolve if strict majority reached
                    if (room.activeVote.yes.size * 2 > room.members.size) {
                        broadcast(room, { type: "vote:result", id: room.activeVote.id, passed: true, targetTimeSec: room.activeVote.targetTimeSec });
                        room.activeVote = null;
                    }
                    break;
                }
                case "rtc:signal": {
                    const toId = typeof msg.to === "string" ? msg.to : "";
                    if (!toId) return;
                    const target = room.members.get(toId);
                    if (!target || target.ws.readyState !== WebSocket.OPEN) return;
                    target.ws.send(JSON.stringify({ type: "rtc:signal", from: member.id, fromName: member.name, payload: msg.payload }));
                    break;
                }
                case "voice:status": {
                    const speaking = !!msg.speaking;
                    broadcast(room, { type: "voice:status", memberId: member.id, speaking }, member.id);
                    break;
                }
            }
        });

        const cleanup = () => {
            room.members.delete(member.id);
            broadcast(room, { type: "member:leave", memberId: member.id });
            if (room.hostId === member.id) promoteHost(room);
            scheduleRoomCleanup(room.id);
        };
        ws.on("close", cleanup);
        ws.on("error", cleanup);
    }) as unknown as (ws: WebSocket, req: IncomingMessage) => void);

    httpServer.on("upgrade", (req, socket, head) => {
        const url = req.url ?? "";
        if (!url.startsWith("/party/")) return;
        const origin = req.headers.origin as string | undefined;
        if (!isAllowedOrigin(origin)) { socket.destroy(); return; }
        // Parse `/party/:roomId?token=&u=&name=`
        const u = new URL(url, "http://localhost");
        const roomId = u.pathname.replace(/^\/party\//, "").replace(/\/.*/, "");
        const token = u.searchParams.get("token") ?? "";
        const userId = u.searchParams.get("u") ?? "";
        const name = (u.searchParams.get("name") ?? "Guest").slice(0, 32);
        const expected = getDeviceToken();
        if (!roomId || !rooms.has(roomId) || !expected || !safeEq(token, expected)) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req, { roomId, userId, name });
        });
    });
}
