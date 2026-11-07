/**
 * MMO Server hub client (`WS /hub?t=<deviceToken>`; protocol at the top of server/src/hub/core.ts).
 * Behaviour mirrors tv-android `data/HubClient.kt`:
 *  - `hello {deviceId, name, platform:"tizen", caps, profileId, app:"mixai-tizen/<ver>"}` on open;
 *  - `time {t0}` pings (3 × 1 s, then every 30 s) → `ClockEstimator` (sync-math.ts);
 *  - reconnect with exponential backoff 1 s → 30 s, rejoin the room after a reconnect;
 *  - incoming `cmd` → `commands` emitter (App routes them; reply with `ack(seq, ok)`);
 *  - forwards `playerBus` now-playing as `state` (≤ 1/s) — video, live and background music (the music engine
 *    publishes `kind:"audio"` with `media.trackId/artist/album/coverUrlPath`; cap `music`, server 3.12);
 *  - Watch Together rooms (`room:*`).
 * Everything is safe to call while disconnected (messages are dropped).
 */
import type { ServerConfig } from "./config";
import { Emitter } from "./emitter";
import { ServerHttp, enc } from "./http";
import type { HubAck, HubDevice, HubMedia, HubRoom, HubRoomPhase } from "./media-types";
import { playerBus, type NowPlaying } from "./player-bus";
import { hubStatePayload } from "./music-remote";
import { deviceLabel, pairPlatform, platformKind } from "../platform";
import { ClockEstimator, expectedPosition, sampleFrom, type PlaybackAnchor } from "./sync-math";

export const DEVICE_ID_KEY = "mixai-tv:device-id";
export const HUB_CAPS = ["play", "pause", "seek", "stop", "next", "previous", "text", "navigate", "music"];

export type HubStatus = "disconnected" | "connecting" | "connected";

/** Remote command (`cmd {from, action, args, seq}`). */
export interface HubCommand {
    action: string;
    args: Record<string, unknown>;
    seq: string;
    fromName: string;
    fromDeviceId: string;
}

export interface RoomMember { connId: string; name: string; ready: boolean; guest: boolean }

export interface RoomState {
    roomId: string;
    name: string;
    phase: HubRoomPhase;
    media: HubMedia | null;
    anchor: PlaybackAnchor;
    members: RoomMember[];
    hostConnId: string | null;
    /** Invite secret for guests (web join link); null for guests. */
    invite: string | null;
}

export interface RoomChat { fromName: string; fromConnId: string; text: string; ts: number }
export interface RoomReaction { fromName: string; emoji: string; mediaSec: number; ts: number }

function uuid(): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
    const b = new Uint8Array(16);
    if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Stable per-install device id (localStorage `mixai-tv:device-id`). */
export function deviceId(): string {
    try {
        let id = localStorage.getItem(DEVICE_ID_KEY);
        if (!id) { id = uuid(); localStorage.setItem(DEVICE_ID_KEY, id); }
        return id;
    } catch {
        return "tizen-" + uuid();
    }
}

/** Name shown to other devices: Settings › Watch Together override (prefs `tvDeviceName`), else hardware name. */
export function displayDeviceName(): string {
    try {
        const raw = localStorage.getItem("mixai:prefs:v1");
        const v = raw ? (JSON.parse(raw) as Record<string, unknown>).tvDeviceName : undefined;
        if (typeof v === "string" && v.trim()) return v.trim().slice(0, 40);
    } catch { /* no storage */ }
    return hubDeviceName();
}

/** Device label for the hub ("Samsung QN90", "Windows PC", "Mac") — see platform/. */
export function hubDeviceName(): string {
    return deviceLabel();
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);

export class HubClient {
    private ws: WebSocket | null = null;
    private running = false;
    private backoff = 1_000;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private pingTimers: Array<ReturnType<typeof setTimeout>> = [];
    private pingInterval: ReturnType<typeof setInterval> | null = null;
    private pendingRejoin: string | null = null;
    private unsubNp: (() => void) | null = null;
    private lastStateAt = 0;
    private stateTimer: ReturnType<typeof setTimeout> | null = null;
    private seqN = 0;
    private readonly http: ServerHttp;

    readonly clock = new ClockEstimator();
    status: HubStatus = "disconnected";
    myConnId: string | null = null;
    devices: HubDevice[] = [];
    room: RoomState | null = null;

    readonly statusChanged = new Emitter<HubStatus>();
    readonly commands = new Emitter<HubCommand>();
    readonly devicesChanged = new Emitter<HubDevice[]>();
    readonly roomChanged = new Emitter<RoomState | null>();
    readonly chat = new Emitter<RoomChat>();
    readonly reactions = new Emitter<RoomReaction>();
    /** Server `error {error}` codes (room_not_found, room_full, not_in_room). */
    readonly errors = new Emitter<string>();

    constructor(
        private readonly cfg: ServerConfig,
        private readonly profileId: () => string | null = () => null,
        private readonly appVersion = "0",
    ) {
        this.http = new ServerHttp(cfg);
    }

    /** `ws(s)://<host>/hub?t=<token>`. */
    hubUrl(): string {
        return this.cfg.baseUrl.replace(/^http/i, "ws") + `/hub?t=${enc(this.cfg.token)}`;
    }

    // ─── lifecycle ────────────────────────────────────────────────────────

    start(): void {
        if (this.running) return;
        if (typeof WebSocket === "undefined") return;
        this.running = true;
        this.unsubNp = playerBus.onNowPlaying((np) => this.scheduleState(np));
        this.connect();
    }

    stop(): void {
        this.running = false;
        this.unsubNp?.(); this.unsubNp = null;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.stateTimer) clearTimeout(this.stateTimer);
        this.clearPings();
        try { this.ws?.close(1000, "bye"); } catch { /* ignore */ }
        this.ws = null;
        this.setStatus("disconnected");
    }

    private setStatus(s: HubStatus): void {
        if (this.status === s) return;
        this.status = s;
        this.statusChanged.emit(s);
    }

    private connect(): void {
        if (!this.running) return;
        this.setStatus("connecting");
        let opened = false;
        let sock: WebSocket;
        try {
            sock = new WebSocket(this.hubUrl());
        } catch {
            this.scheduleReconnect(false);
            return;
        }
        this.ws = sock;
        sock.onopen = () => {
            opened = true;
            this.backoff = 1_000;
            this.setStatus("connected");
            this.sendHello();
            this.startPings();
        };
        sock.onmessage = (ev) => { if (typeof ev.data === "string") this.handle(ev.data); };
        sock.onerror = () => { /* onclose follows */ };
        sock.onclose = () => {
            if (this.ws === sock) this.ws = null;
            this.clearPings();
            this.setStatus("disconnected");
            if (this.room) this.pendingRejoin = this.room.roomId;
            this.scheduleReconnect(opened);
        };
    }

    private scheduleReconnect(wasOpen: boolean): void {
        if (!this.running) return;
        this.backoff = wasOpen ? 1_000 : Math.min(this.backoff * 2, 30_000);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
    }

    private clearPings(): void {
        for (const t of this.pingTimers) clearTimeout(t);
        this.pingTimers = [];
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = null;
    }

    private startPings(): void {
        this.clearPings();
        for (let i = 0; i < 3; i++) this.pingTimers.push(setTimeout(() => this.ping(), i * 1_000));
        this.pingInterval = setInterval(() => this.ping(), 30_000);
    }

    private ping(): void { this.send({ type: "time", t0: Date.now() }); }

    private sendHello(): void {
        const pid = this.profileId();
        this.send({
            type: "hello",
            deviceId: deviceId(),
            name: displayDeviceName(),
            platform: pairPlatform(),
            caps: HUB_CAPS,
            ...(pid ? { profileId: pid } : {}),
            app: `mixai-${platformKind() === "desktop" ? "desktop" : "tizen"}/${this.appVersion}`,
        });
        if (this.pendingRejoin) { this.joinRoom(this.pendingRejoin); this.pendingRejoin = null; }
        const np = playerBus.nowPlaying();
        if (np) this.scheduleState(np);
    }

    /** Re-sends `hello` (profile changed). */
    refreshHello(): void { if (this.status === "connected") this.sendHello(); }

    private send(o: Json): boolean {
        const s = this.ws;
        if (!s || s.readyState !== 1) return false;
        try { s.send(JSON.stringify(o)); return true; } catch { return false; }
    }

    // ─── inbound ──────────────────────────────────────────────────────────

    private handle(text: string): void {
        let msg: Json;
        try { msg = JSON.parse(text) as Json; } catch { return; }
        switch (str(msg.type)) {
            case "welcome": this.myConnId = str(obj(msg.you)?.connId) ?? null; return;
            case "time": {
                const t3 = Date.now();
                const t0 = num(msg.t0), t1 = num(msg.t1), t2 = num(msg.t2);
                if (t0 === undefined || t1 === undefined || t2 === undefined) return;
                this.clock.add(sampleFrom(t0, t1, t2, t3));
                return;
            }
            case "cmd": {
                const action = str(msg.action);
                if (!action) return;
                const from = obj(msg.from);
                this.commands.emit({ action, args: obj(msg.args) ?? {}, seq: str(msg.seq) ?? "", fromName: str(from?.name) ?? "", fromDeviceId: str(from?.deviceId) ?? "" });
                return;
            }
            case "devices":
                this.devices = Array.isArray(msg.devices) ? (msg.devices as HubDevice[]) : [];
                this.devicesChanged.emit(this.devices);
                return;
            case "room:created": case "room:joined": {
                const id = str(msg.roomId);
                if (!id) return;
                const cur = this.room?.roomId === id ? this.room : this.emptyRoom(id);
                this.setRoom({ ...cur, name: str(msg.name) ?? cur.name, invite: str(msg.invite) ?? cur.invite });
                return;
            }
            case "room:state": {
                const id = str(msg.roomId);
                if (!id) return;
                const a = obj(msg.anchor);
                const cur = this.room?.roomId === id ? this.room : this.emptyRoom(id);
                this.setRoom({
                    ...cur,
                    phase: (str(msg.phase) as HubRoomPhase | undefined) ?? cur.phase,
                    media: (obj(msg.media) as HubMedia | undefined) ?? null,
                    anchor: { playing: a?.playing === true, positionSec: num(a?.positionSec) ?? 0, atServerMs: num(a?.atServerMs) ?? 0, rate: num(a?.rate) },
                });
                return;
            }
            case "room:members": {
                const id = str(msg.roomId);
                if (!id) return;
                const members = Array.isArray(msg.members) ? (msg.members as Json[]).map((m) => ({
                    connId: str(m.connId) ?? "", name: str(m.name) ?? "", ready: m.ready === true, guest: m.guest === true,
                })) : [];
                const cur = this.room?.roomId === id ? this.room : this.emptyRoom(id);
                this.setRoom({ ...cur, members, hostConnId: str(msg.hostConnId) ?? null });
                return;
            }
            case "room:chat": {
                const from = obj(msg.from);
                const t = str(msg.text);
                if (t) this.chat.emit({ fromName: str(from?.name) ?? "", fromConnId: str(from?.connId) ?? "", text: t, ts: num(msg.ts) ?? Date.now() });
                return;
            }
            case "room:react": {
                const from = obj(msg.from);
                const e = str(msg.emoji);
                if (e) this.reactions.emit({ fromName: str(from?.name) ?? "", emoji: e, mediaSec: num(msg.mediaSec) ?? 0, ts: num(msg.ts) ?? Date.now() });
                return;
            }
            case "room:left":
                if (this.room?.roomId === str(msg.roomId)) this.setRoom(null);
                return;
            case "error": {
                const e = str(msg.error);
                if (e) this.errors.emit(e);
                return;
            }
        }
    }

    private emptyRoom(id: string): RoomState {
        return { roomId: id, name: "", phase: "idle", media: null, anchor: { playing: false, positionSec: 0, atServerMs: 0 }, members: [], hostConnId: null, invite: null };
    }

    private setRoom(r: RoomState | null): void {
        this.room = r;
        this.roomChanged.emit(r);
    }

    // ─── clock helpers ────────────────────────────────────────────────────

    /** Server time estimate (ms). */
    serverNowMs(): number { return Date.now() + this.clock.offsetMs; }

    /** Where the room's media should be right now (s), or null outside a room. */
    roomExpectedPosition(): number | null {
        return this.room ? expectedPosition(this.room.anchor, this.serverNowMs()) : null;
    }

    // ─── outbound: remote control ─────────────────────────────────────────

    ack(seq: string, ok: boolean, error?: string, state?: Json): void {
        if (!seq) return;
        this.send({ type: "ack", seq, ok, ...(error ? { error } : {}), ...(state ? { state } : {}) });
    }

    reportState(playing: boolean, positionSec: number, durationSec?: number, media?: HubMedia): void {
        this.send({ type: "state", playing, positionSec, ...(durationSec !== undefined ? { durationSec } : {}), ...(media ? { media } : {}) });
    }

    reportIdle(): void { this.send({ type: "state", idle: true }); }

    private scheduleState(np: NowPlaying | null): void {
        const flush = () => {
            this.stateTimer = null;
            this.lastStateAt = Date.now();
            this.send(hubStatePayload(playerBus.nowPlaying()));
        };
        if (!np) { if (this.stateTimer) clearTimeout(this.stateTimer); flush(); return; }
        if (this.stateTimer) return;
        const wait = Math.max(0, 1_000 - (Date.now() - this.lastStateAt));
        this.stateTimer = setTimeout(flush, wait);
    }

    /** Send a command to another device over the socket; returns the seq (ack arrives as a server `ack`). */
    command(targetDeviceId: string, action: string, args: Json = {}): string {
        const seq = `tz${Date.now().toString(36)}${(this.seqN++).toString(36)}`;
        this.send({ type: "cmd", target: targetDeviceId, action, args, seq });
        return seq;
    }

    // ─── outbound: Watch Together ─────────────────────────────────────────

    createRoom(name?: string): void { this.send({ type: "room:create", ...(name ? { name } : {}) }); }
    joinRoom(roomId: string): void { this.send({ type: "room:join", roomId }); }
    leave(): void { this.send({ type: "room:leave" }); this.setRoom(null); }
    load(media: HubMedia, positionSec = 0): void { this.send({ type: "room:load", media, positionSec }); }
    play(positionSec?: number): void { this.send({ type: "room:play", ...(positionSec !== undefined ? { positionSec } : {}) }); }
    pause(positionSec?: number): void { this.send({ type: "room:pause", ...(positionSec !== undefined ? { positionSec } : {}) }); }
    seek(positionSec: number): void { this.send({ type: "room:seek", positionSec }); }
    ready(ready: boolean, positionSec?: number): void { this.send({ type: "room:ready", ready, ...(positionSec !== undefined ? { positionSec } : {}) }); }
    report(positionSec: number): void { this.send({ type: "room:report", positionSec, rttMs: this.clock.rttMs }); }
    sendChat(text: string): void { this.send({ type: "room:chat", text }); }
    react(emoji: string, mediaSec?: number): void { this.send({ type: "room:react", emoji, ...(mediaSec !== undefined ? { mediaSec } : {}) }); }

    // ─── HTTP (`/hub/*`) ──────────────────────────────────────────────────

    async listDevices(): Promise<HubDevice[]> {
        const r = await this.http.get<{ devices: HubDevice[]; serverTime: number }>("/hub/devices", { allow404: true });
        return r?.devices ?? [];
    }
    /** Remote-control another device and wait (≤ 4 s) for its ack. */
    sendCommand(target: string, action: string, args: Json = {}): Promise<HubAck | null> {
        return this.http.post<HubAck>("/hub/command", { target, action, args }, { timeoutMs: 6_000 });
    }
    createRoomHttp(name?: string): Promise<{ roomId: string; invite: string } | null> {
        return this.http.post("/hub/rooms", name ? { name } : {});
    }
    getRoom(id: string): Promise<HubRoom | null> { return this.http.get<HubRoom>(`/hub/rooms/${enc(id)}`, { allow404: true }); }
}
