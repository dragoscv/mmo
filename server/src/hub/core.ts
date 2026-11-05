/**
 * Hub core (WP16-07/08): device registry + remote control + Watch Together rooms.
 * Transport-agnostic: the WebSocket wiring (`ws.ts`) calls `connect/message/disconnect`
 * and supplies `send`. Everything here is deterministic given `now()` → unit-testable.
 *
 * Protocol (JSON). Client → server:
 *   hello {deviceId, name, platform, caps?, profileId?, app?}
 *   time {t0}                          → time {t0, t1, t2}
 *   state {playing, positionSec, durationSec?, media?}   now-playing of this device
 *   cmd {target, action, args?, seq}   → forwarded as cmd {from, action, args, seq}
 *   ack {seq, to, ok, error?, state?}  → forwarded to the controller
 *   room:create {name?} | room:join {roomId} | room:leave
 *   room:load {media, positionSec?} | room:play {positionSec?} | room:pause {positionSec?} | room:seek {positionSec}
 *   room:ready {ready, positionSec?}   buffering report; anyone not ready → group waits
 *   room:report {positionSec, rttMs}   1 Hz while playing (lead time + drift view)
 *   room:chat {text} | room:react {emoji, mediaSec?}
 *   Moderation (WP16-50): report {messageId, reason, roomId?} | block {memberId} | unblock {memberId|deviceId}
 *   | kick {memberId} (host only; alias room:kick)
 * Server → client: welcome, devices, time, cmd, ack, room:joined, room:members, room:state, room:chat,
 *   room:react, room:left, room:kicked, report:ok, block:ok, error.
 *
 * `platform` is normalised (`android-tv`, `tizen`, `web`, `android-phone`, `ios`, …); the device list carries
 * `formFactor` and `playbackTarget` (phones are targets only with the `playback` cap).
 * Chat messages carry a stable `id`; text is masked by the word filter unless the owner disabled it.
 * Blocks hide the blocked member's chat + reactions from the blocker for the room lifetime and are persisted
 * per profile (`hub_blocks`) so they apply again in later rooms.
 */

import crypto from "node:crypto";
import { expectedPosition, leadTimeMs, type PlaybackAnchor } from "./sync-math";
import { formFactorOf, isPlaybackTarget, normalizePlatform, type FormFactor } from "../lib/client-platform";
import { maskProfanity, REPORT_REASONS, type ModerationStore, type ReportReason } from "./moderation";

export type Send = (connId: string, msg: object) => void;

export interface HubMedia {
    fileId?: string;
    kind?: string;
    tmdbId?: number;
    season?: number;
    episode?: number;
    title?: string;
    posterPath?: string | null;
    durationSec?: number;
    /** Live TV channel id, when the media is a channel. */
    channelId?: string;
}

export interface DeviceInfo {
    connId: string;
    deviceId: string;
    name: string;
    platform: string;
    caps: string[];
    profileId: string | null;
    app: string | null;
    connectedAt: number;
    /** Guests (invite link) can only take part in their room. */
    guest: boolean;
    nowPlaying: { playing: boolean; positionSec: number; durationSec?: number; media?: HubMedia; at: number } | null;
}

export type RoomPhase = "idle" | "waiting" | "playing" | "paused";

export interface RoomMember { connId: string; deviceId: string; name: string; ready: boolean; rttMs: number; positionSec: number; joinedAt: number; guest: boolean }

export interface ChatLogEntry { id: string; connId: string; deviceId: string; name: string; text: string; ts: number }

export type PublicDevice = Omit<DeviceInfo, "connId"> & { formFactor: FormFactor; playbackTarget: boolean };

export interface Room {
    id: string;
    name: string;
    hostConnId: string | null;
    phase: RoomPhase;
    media: HubMedia | null;
    anchor: PlaybackAnchor;
    members: Map<string, RoomMember>;
    createdAt: number;
    emptySince: number | null;
    /** Phase to enter once everyone is ready again. */
    resumeTo: "playing" | "paused";
    waitingSince: number | null;
    /** Last messages (for reports), newest last. */
    chatLog: ChatLogEntry[];
    /** blocker connId → blocked deviceIds (room lifetime). */
    blocks: Map<string, Set<string>>;
    /** deviceIds the host removed; they cannot rejoin this room. */
    kicked: Set<string>;
}

export const CHAT_LOG_MAX = 200;

export const ROOM_EMPTY_TTL_MS = 10 * 60_000;
export const WAIT_TIMEOUT_MS = 8_000;
export const INVITE_TTL_MS = 24 * 3600_000;
export const MAX_ROOM_MEMBERS = 16;

const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function cleanMedia(v: unknown): HubMedia | undefined {
    if (!v || typeof v !== "object") return undefined;
    const m = v as Record<string, unknown>;
    return {
        fileId: str(m.fileId, 64), kind: str(m.kind, 16), tmdbId: num(m.tmdbId), season: num(m.season), episode: num(m.episode),
        title: str(m.title, 200), posterPath: str(m.posterPath, 200) ?? null, durationSec: num(m.durationSec), channelId: str(m.channelId, 64),
    };
}

export class HubCore {
    readonly devices = new Map<string, DeviceInfo>();
    readonly rooms = new Map<string, Room>();
    private readonly pendingAcks = new Map<string, { from: string; resolve?: (ack: Record<string, unknown>) => void; at: number }>();

    constructor(
        private readonly send: Send,
        private readonly secret: () => string,
        private readonly now: () => number = Date.now,
        private readonly moderation: ModerationStore | null = null,
    ) {}

    // ── connection lifecycle ──────────────────────────────────────────────

    connect(connId: string, opts: { guest?: boolean; guestName?: string; inviteRoomId?: string } = {}): void {
        this.devices.set(connId, {
            connId, deviceId: opts.guest ? `guest:${connId.slice(0, 8)}` : connId, name: opts.guestName ?? "Device",
            platform: opts.guest ? "web-guest" : "unknown", caps: [], profileId: null, app: null,
            connectedAt: this.now(), guest: Boolean(opts.guest), nowPlaying: null,
        });
        this.send(connId, { type: "welcome", you: { connId, guest: Boolean(opts.guest) }, serverTime: this.now() });
        if (opts.inviteRoomId) this.joinRoom(connId, opts.inviteRoomId);
    }

    disconnect(connId: string): void {
        for (const room of this.rooms.values()) if (room.members.has(connId)) this.leaveRoom(connId, room.id);
        const had = this.devices.delete(connId);
        if (had) this.broadcastDevices();
    }

    message(connId: string, raw: unknown): void {
        const dev = this.devices.get(connId);
        if (!dev || !raw || typeof raw !== "object") return;
        const msg = raw as Record<string, unknown>;
        const type = str(msg.type, 32);
        if (!type) return;
        if (dev.guest && !(type.startsWith("room:") || type === "time" || type === "hello" || type === "report" || type === "block" || type === "unblock")) return;
        switch (type) {
            case "hello": return this.onHello(dev, msg);
            case "time": {
                const t = this.now();
                this.send(connId, { type: "time", t0: num(msg.t0) ?? 0, t1: t, t2: this.now() });
                return;
            }
            case "state": return this.onState(dev, msg);
            case "cmd": return this.onCmd(dev, msg);
            case "ack": return this.onAck(dev, msg);
            case "report": return this.onReport(dev, msg);
            case "block": return this.onBlock(dev, msg, true);
            case "unblock": return this.onBlock(dev, msg, false);
            case "kick": return this.onKick(dev, msg);
            default:
                if (type.startsWith("room:")) return this.onRoom(dev, type, msg);
        }
    }

    // ── registry + remote ─────────────────────────────────────────────────

    private onHello(dev: DeviceInfo, msg: Record<string, unknown>): void {
        if (!dev.guest) {
            dev.deviceId = str(msg.deviceId, 64) ?? dev.deviceId;
            dev.platform = msg.platform === undefined ? dev.platform : normalizePlatform(msg.platform, dev.platform);
            dev.caps = Array.isArray(msg.caps) ? (msg.caps as unknown[]).filter((c): c is string => typeof c === "string").slice(0, 32) : [];
            dev.profileId = str(msg.profileId, 64) ?? null;
            dev.app = str(msg.app, 64) ?? null;
            // A reconnecting device replaces its stale connection.
            for (const [other, d] of this.devices) {
                if (other !== dev.connId && !d.guest && d.deviceId === dev.deviceId) this.disconnect(other);
            }
        }
        dev.name = str(msg.name, 48) ?? dev.name;
        this.broadcastDevices();
    }

    private onState(dev: DeviceInfo, msg: Record<string, unknown>): void {
        if (msg.idle === true) dev.nowPlaying = null;
        else dev.nowPlaying = {
            playing: msg.playing === true, positionSec: num(msg.positionSec) ?? 0, durationSec: num(msg.durationSec),
            media: cleanMedia(msg.media), at: this.now(),
        };
        this.broadcastDevices();
    }

    private onCmd(dev: DeviceInfo, msg: Record<string, unknown>): void {
        const target = [...this.devices.values()].find((d) => !d.guest && (d.deviceId === msg.target || d.connId === msg.target));
        const seq = str(msg.seq, 64) ?? crypto.randomUUID();
        const action = str(msg.action, 32);
        if (!target || !action) {
            this.send(dev.connId, { type: "ack", seq, ok: false, error: target ? "bad_action" : "no_such_device" });
            return;
        }
        this.pendingAcks.set(seq, { from: dev.connId, at: this.now() });
        this.send(target.connId, { type: "cmd", from: { deviceId: dev.deviceId, name: dev.name }, action, args: msg.args ?? {}, seq });
    }

    private onAck(dev: DeviceInfo, msg: Record<string, unknown>): void {
        const seq = str(msg.seq, 64);
        if (!seq) return;
        const p = this.pendingAcks.get(seq);
        if (!p) return;
        this.pendingAcks.delete(seq);
        const ack = { type: "ack", seq, ok: msg.ok !== false, error: str(msg.error, 200), from: dev.deviceId, state: msg.state };
        if (p.resolve) p.resolve(ack);
        else this.send(p.from, ack);
    }

    /** HTTP remote: forward a command and await the target's ack (timeout → `{ok:false,error:"timeout"}`). */
    command(target: string, action: string, args: unknown, timeoutMs = 4000): Promise<Record<string, unknown>> {
        const dev = [...this.devices.values()].find((d) => !d.guest && (d.deviceId === target || d.connId === target));
        if (!dev) return Promise.resolve({ ok: false, error: "no_such_device" });
        const seq = crypto.randomUUID();
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (this.pendingAcks.delete(seq)) resolve({ ok: false, error: "timeout" });
            }, timeoutMs);
            this.pendingAcks.set(seq, {
                from: "http", at: this.now(),
                resolve: (ack) => { clearTimeout(timer); resolve(ack); },
            });
            this.send(dev.connId, { type: "cmd", from: { deviceId: "http", name: "Remote" }, action, args: args ?? {}, seq });
        });
    }

    listDevices(opts: { targetsOnly?: boolean } = {}): PublicDevice[] {
        return [...this.devices.values()]
            .filter((d) => !d.guest && (!opts.targetsOnly || isPlaybackTarget(d)))
            .map(({ connId: _c, ...d }) => ({ ...d, formFactor: formFactorOf(d.platform), playbackTarget: isPlaybackTarget(d) }));
    }

    private broadcastDevices(): void {
        const list = this.listDevices();
        for (const d of this.devices.values()) if (!d.guest) this.send(d.connId, { type: "devices", devices: list });
    }

    // ── invites ───────────────────────────────────────────────────────────

    makeInvite(roomId: string, ttlMs = INVITE_TTL_MS): string {
        const exp = this.now() + ttlMs;
        const mac = crypto.createHmac("sha256", this.secret()).update(`${roomId}.${exp}`).digest("base64url").slice(0, 32);
        return `${roomId}.${exp}.${mac}`;
    }

    /** Room id of a valid invite, else null. */
    verifyInvite(invite: string | null | undefined): string | null {
        if (!invite) return null;
        const [roomId, expStr, mac] = invite.split(".");
        if (!roomId || !expStr || !mac) return null;
        const exp = Number(expStr);
        if (!Number.isFinite(exp) || exp < this.now() || !this.rooms.has(roomId)) return null;
        const want = crypto.createHmac("sha256", this.secret()).update(`${roomId}.${exp}`).digest("base64url").slice(0, 32);
        const a = Buffer.from(mac); const b = Buffer.from(want);
        return a.length === b.length && crypto.timingSafeEqual(a, b) ? roomId : null;
    }

    /** True when a guest invite may stream `fileId` (the room's current media). */
    inviteAllowsFile(invite: string | null | undefined, fileId: string): boolean {
        const roomId = this.verifyInvite(invite);
        if (!roomId) return false;
        return this.rooms.get(roomId)?.media?.fileId === fileId;
    }

    // ── rooms ─────────────────────────────────────────────────────────────

    createRoom(name?: string): { room: Room; invite: string } {
        const id = crypto.randomBytes(6).toString("base64url");
        const room: Room = {
            id, name: (name ?? "").slice(0, 60) || "Watch Together", hostConnId: null, phase: "idle", media: null,
            anchor: { playing: false, positionSec: 0, atServerMs: this.now() }, members: new Map(),
            createdAt: this.now(), emptySince: this.now(), resumeTo: "paused", waitingSince: null,
            chatLog: [], blocks: new Map(), kicked: new Set(),
        };
        this.rooms.set(id, room);
        return { room, invite: this.makeInvite(id) };
    }

    private onRoom(dev: DeviceInfo, type: string, msg: Record<string, unknown>): void {
        if (type === "room:create") {
            if (dev.guest) return;
            const { room, invite } = this.createRoom(str(msg.name, 60));
            this.send(dev.connId, { type: "room:created", roomId: room.id, invite });
            this.joinRoom(dev.connId, room.id);
            return;
        }
        if (type === "room:join") {
            const roomId = str(msg.roomId, 32);
            if (roomId && !dev.guest) this.joinRoom(dev.connId, roomId);
            return;
        }
        const room = [...this.rooms.values()].find((r) => r.members.has(dev.connId));
        if (!room) { this.send(dev.connId, { type: "error", error: "not_in_room" }); return; }
        const member = room.members.get(dev.connId)!;
        const t = this.now();
        switch (type) {
            case "room:leave": return this.leaveRoom(dev.connId, room.id);
            case "room:load": {
                const media = cleanMedia(msg.media);
                if (!media) return;
                room.media = media;
                room.anchor = { playing: false, positionSec: num(msg.positionSec) ?? 0, atServerMs: t };
                for (const m of room.members.values()) m.ready = m.connId === dev.connId;
                this.enterWaiting(room, "playing");
                return;
            }
            case "room:play": return this.schedule(room, true, num(msg.positionSec));
            case "room:pause": return this.schedule(room, false, num(msg.positionSec));
            case "room:seek": {
                const pos = num(msg.positionSec);
                if (pos === undefined) return;
                const wasPlaying = room.phase === "playing" || (room.phase === "waiting" && room.resumeTo === "playing");
                room.anchor = { playing: false, positionSec: pos, atServerMs: t };
                for (const m of room.members.values()) m.ready = false;
                this.enterWaiting(room, wasPlaying ? "playing" : "paused");
                return;
            }
            case "room:ready": {
                member.ready = msg.ready !== false;
                member.positionSec = num(msg.positionSec) ?? member.positionSec;
                if (!member.ready && room.phase === "playing") {
                    room.anchor = { playing: false, positionSec: expectedPosition(room.anchor, t), atServerMs: t };
                    this.enterWaiting(room, "playing");
                    return;
                }
                this.maybeResume(room);
                return;
            }
            case "room:report": {
                member.positionSec = num(msg.positionSec) ?? member.positionSec;
                member.rttMs = Math.max(0, Math.min(5000, num(msg.rttMs) ?? member.rttMs));
                return;
            }
            case "room:chat": {
                const raw = str(msg.text, 500)?.trim();
                if (!raw) return;
                const filtered = this.moderation?.chatFilterEnabled() !== false ? maskProfanity(raw) : { text: raw, masked: false };
                const id = `m_${crypto.randomBytes(6).toString("base64url")}`;
                room.chatLog.push({ id, connId: dev.connId, deviceId: dev.deviceId, name: dev.name, text: filtered.text, ts: t });
                if (room.chatLog.length > CHAT_LOG_MAX) room.chatLog.splice(0, room.chatLog.length - CHAT_LOG_MAX);
                this.toRoomFrom(room, dev.deviceId, {
                    type: "room:chat", id, from: { connId: dev.connId, deviceId: dev.deviceId, name: dev.name }, text: filtered.text,
                    ...(filtered.masked ? { masked: true } : {}), ts: t,
                });
                return;
            }
            case "room:react": {
                const emoji = str(msg.emoji, 16);
                if (!emoji) return;
                this.toRoomFrom(room, dev.deviceId, {
                    type: "room:react", id: `r_${crypto.randomBytes(6).toString("base64url")}`, from: { connId: dev.connId, deviceId: dev.deviceId, name: dev.name },
                    emoji, mediaSec: num(msg.mediaSec) ?? expectedPosition(room.anchor, t), ts: t,
                });
                return;
            }
            case "room:kick": return this.onKick(dev, msg);
        }
    }

    // ── moderation ────────────────────────────────────────────────────────

    private roomOf(connId: string): Room | undefined {
        return [...this.rooms.values()].find((r) => r.members.has(connId));
    }

    private onReport(dev: DeviceInfo, msg: Record<string, unknown>): void {
        const room = (str(msg.roomId, 32) && this.rooms.get(str(msg.roomId, 32)!)?.members.has(dev.connId) ? this.rooms.get(str(msg.roomId, 32)!) : undefined) ?? this.roomOf(dev.connId);
        const messageId = str(msg.messageId, 64);
        if (!room || !messageId) { this.send(dev.connId, { type: "error", error: room ? "bad_report" : "not_in_room" }); return; }
        const reason: ReportReason = (REPORT_REASONS as readonly string[]).includes(String(msg.reason)) ? msg.reason as ReportReason : "other";
        const entry = room.chatLog.find((m) => m.id === messageId);
        const report = this.moderation?.addReport({
            roomId: room.id, messageId, reporterDeviceId: dev.deviceId, reporterName: dev.name,
            offenderDeviceId: entry?.deviceId ?? null, offenderName: entry?.name ?? null, text: entry?.text ?? null, reason,
        });
        this.send(dev.connId, { type: "report:ok", messageId, reportId: report?.id ?? null });
    }

    private onBlock(dev: DeviceInfo, msg: Record<string, unknown>, block: boolean): void {
        const room = this.roomOf(dev.connId);
        const memberId = str(msg.memberId, 64);
        const target = memberId ? room?.members.get(memberId) : undefined;
        const deviceId = target?.deviceId ?? str(msg.deviceId, 64);
        if (!deviceId || deviceId === dev.deviceId) { this.send(dev.connId, { type: "error", error: "bad_block" }); return; }
        if (room) {
            const set = room.blocks.get(dev.connId) ?? new Set<string>();
            if (block) set.add(deviceId); else set.delete(deviceId);
            room.blocks.set(dev.connId, set);
        }
        // Persist per profile (paired devices only; guest ids are per-connection and meaningless later).
        if (!dev.guest && dev.profileId && !deviceId.startsWith("guest:")) {
            if (block) this.moderation?.addBlock(dev.profileId, deviceId, target?.name ?? null);
            else this.moderation?.removeBlock(dev.profileId, deviceId);
        }
        this.send(dev.connId, { type: "block:ok", deviceId, blocked: block });
    }

    private onKick(dev: DeviceInfo, msg: Record<string, unknown>): void {
        const room = this.roomOf(dev.connId);
        if (!room) { this.send(dev.connId, { type: "error", error: "not_in_room" }); return; }
        if (room.hostConnId !== dev.connId) { this.send(dev.connId, { type: "error", error: "not_host" }); return; }
        const memberId = str(msg.memberId, 64);
        const target = memberId ? room.members.get(memberId) : undefined;
        if (!target || target.connId === dev.connId) { this.send(dev.connId, { type: "error", error: "bad_kick" }); return; }
        room.kicked.add(target.deviceId);
        this.send(target.connId, { type: "room:kicked", roomId: room.id });
        this.leaveRoom(target.connId, room.id);
    }

    /** Room members' blocks: deviceIds hidden from `connId` (room lifetime + persisted profile blocks). */
    private isBlockedFor(room: Room, receiverConnId: string, senderDeviceId: string): boolean {
        return room.blocks.get(receiverConnId)?.has(senderDeviceId) === true;
    }

    joinRoom(connId: string, roomId: string): void {
        const room = this.rooms.get(roomId);
        const dev = this.devices.get(connId);
        if (!room || !dev) { this.send(connId, { type: "error", error: "room_not_found" }); return; }
        if (room.kicked.has(dev.deviceId)) { this.send(connId, { type: "error", error: "kicked" }); return; }
        if (room.members.size >= MAX_ROOM_MEMBERS && !room.members.has(connId)) { this.send(connId, { type: "error", error: "room_full" }); return; }
        for (const r of this.rooms.values()) if (r.id !== roomId && r.members.has(connId)) this.leaveRoom(connId, r.id);
        room.members.set(connId, { connId, deviceId: dev.deviceId, name: dev.name, ready: room.phase !== "waiting", rttMs: 0, positionSec: 0, joinedAt: this.now(), guest: dev.guest });
        if (!dev.guest && dev.profileId && this.moderation) {
            const persisted = this.moderation.blockedDeviceIds(dev.profileId);
            if (persisted.size > 0) room.blocks.set(connId, new Set([...(room.blocks.get(connId) ?? []), ...persisted]));
        }
        room.emptySince = null;
        if (!room.hostConnId) room.hostConnId = connId;
        this.send(connId, { type: "room:joined", roomId: room.id, name: room.name, invite: dev.guest ? undefined : this.makeInvite(room.id) });
        this.sendState(room, connId);
        this.broadcastMembers(room);
        // A late joiner must load the media first: the group waits for it (when playing).
        if (room.media && room.phase === "playing") {
            room.members.get(connId)!.ready = false;
            room.anchor = { playing: false, positionSec: expectedPosition(room.anchor, this.now()), atServerMs: this.now() };
            this.enterWaiting(room, "playing");
        }
    }

    leaveRoom(connId: string, roomId: string): void {
        const room = this.rooms.get(roomId);
        if (!room || !room.members.delete(connId)) return;
        room.blocks.delete(connId);
        this.send(connId, { type: "room:left", roomId });
        if (room.hostConnId === connId) room.hostConnId = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0]?.connId ?? null;
        if (room.members.size === 0) room.emptySince = this.now();
        this.broadcastMembers(room);
        this.maybeResume(room);
    }

    private enterWaiting(room: Room, resumeTo: "playing" | "paused"): void {
        room.phase = "waiting";
        room.resumeTo = resumeTo;
        room.waitingSince = this.now();
        this.sendState(room);
        this.maybeResume(room);
    }

    private maybeResume(room: Room): void {
        if (room.phase !== "waiting") return;
        const allReady = [...room.members.values()].every((m) => m.ready);
        if (!allReady) return;
        this.schedule(room, room.resumeTo === "playing");
    }

    /** Play/pause scheduled at `now + lead` so every member starts at the same server instant. */
    private schedule(room: Room, playing: boolean, positionSec?: number): void {
        const t = this.now();
        const pos = positionSec ?? expectedPosition(room.anchor, t);
        if (!room.media) { room.phase = "idle"; this.sendState(room); return; }
        const lead = playing ? leadTimeMs([...room.members.values()].map((m) => m.rttMs)) : 0;
        room.anchor = { playing, positionSec: pos, atServerMs: t + lead };
        room.phase = playing ? "playing" : "paused";
        room.waitingSince = null;
        this.sendState(room);
    }

    /** Called periodically: wait timeouts (drop stragglers' veto) + empty room expiry + stale acks. */
    tick(): void {
        const t = this.now();
        for (const room of this.rooms.values()) {
            if (room.phase === "waiting" && room.waitingSince && t - room.waitingSince > WAIT_TIMEOUT_MS) {
                for (const m of room.members.values()) m.ready = true;
                this.maybeResume(room);
            }
            if (room.members.size === 0 && room.emptySince && t - room.emptySince > ROOM_EMPTY_TTL_MS) this.rooms.delete(room.id);
        }
        for (const [seq, p] of this.pendingAcks) if (!p.resolve && t - p.at > 30_000) this.pendingAcks.delete(seq);
    }

    roomSnapshot(room: Room): Record<string, unknown> {
        return {
            id: room.id, name: room.name, phase: room.phase, media: room.media, anchor: room.anchor, hostConnId: room.hostConnId,
            members: [...room.members.values()].map((m) => ({ connId: m.connId, deviceId: m.deviceId, name: m.name, ready: m.ready, guest: m.guest })),
        };
    }

    private sendState(room: Room, only?: string): void {
        const msg = { type: "room:state", roomId: room.id, phase: room.phase, media: room.media, anchor: room.anchor, serverTime: this.now() };
        if (only) this.send(only, msg); else this.toRoom(room, msg);
    }

    private broadcastMembers(room: Room): void {
        this.toRoom(room, { type: "room:members", roomId: room.id, hostConnId: room.hostConnId, members: this.roomSnapshot(room).members });
    }

    private toRoom(room: Room, msg: object): void {
        for (const m of room.members.keys()) this.send(m, msg);
    }

    /** Like `toRoom`, but skips members who blocked the sender. */
    private toRoomFrom(room: Room, senderDeviceId: string, msg: object): void {
        for (const m of room.members.keys()) if (!this.isBlockedFor(room, m, senderDeviceId)) this.send(m, msg);
    }
}
