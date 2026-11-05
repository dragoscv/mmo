import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import express from "express";
import { WebSocket } from "ws";
import { HubCore } from "./core";
import { createHub, type Hub } from "./index";
import { ClockEstimator, driftAction, expectedPosition, leadTimeMs, sampleFrom } from "./sync-math";

describe("sync math", () => {
    it("computes offset/RTT and trusts the lowest-RTT sample", () => {
        // client clock 500 ms behind server, 40 ms each way, 2 ms processing
        const s = sampleFrom(1000, 1540, 1542, 1082);
        expect(s.offsetMs).toBe(500);
        expect(s.rttMs).toBe(80);
        const est = new ClockEstimator();
        est.add({ offsetMs: 700, rttMs: 900 });
        est.add(s);
        est.add({ offsetMs: 300, rttMs: 600 });
        expect(est.best()).toEqual(s);
        expect(est.rttMs).toBe(80);
        expect(Math.abs(est.offsetMs - 500)).toBeLessThan(200);
    });
    it("expected position advances only while playing", () => {
        expect(expectedPosition({ playing: true, positionSec: 10, atServerMs: 1000 }, 3000)).toBe(12);
        expect(expectedPosition({ playing: false, positionSec: 10, atServerMs: 1000 }, 3000)).toBe(10);
        expect(expectedPosition({ playing: true, positionSec: 10, atServerMs: 5000 }, 3000)).toBe(10);
    });
    it("drift correction uses hysteresis, rate clamp and seek", () => {
        expect(driftAction(10.1, 10, false)).toEqual({ kind: "none" });
        const r = driftAction(10.2, 10, false);
        expect(r.kind).toBe("rate");
        if (r.kind === "rate") expect(r.rate).toBeLessThan(1);
        expect(driftAction(10.1, 10, true).kind).toBe("rate");
        expect(driftAction(10.03, 10, true)).toEqual({ kind: "none" });
        expect(driftAction(8, 10, false)).toEqual({ kind: "seek", positionSec: 10 });
        const behind = driftAction(9.5, 10, true);
        expect(behind.kind === "rate" && behind.rate > 1 && behind.rate <= 1.05).toBe(true);
        expect(leadTimeMs([])).toBe(150);
        expect(leadTimeMs([100, 400])).toBe(550);
        expect(leadTimeMs([9000])).toBe(2000);
    });
});

function mkCore() {
    let t = 10_000;
    const out: { to: string; msg: Record<string, unknown> }[] = [];
    const core = new HubCore((to, msg) => out.push({ to, msg: msg as Record<string, unknown> }), () => "secret", () => t);
    const last = (to: string, type: string) => [...out].reverse().find((o) => o.to === to && o.msg.type === type)?.msg;
    return { core, out, last, advance: (ms: number) => { t += ms; }, now: () => t };
}

describe("HubCore registry + remote", () => {
    it("registers devices, forwards commands and routes acks back", () => {
        const { core, last } = mkCore();
        core.connect("tv"); core.connect("web");
        core.message("tv", { type: "hello", deviceId: "tv-1", name: "Bedroom TV", platform: "android-tv", caps: ["play", "seek"] });
        core.message("web", { type: "hello", deviceId: "web-1", name: "Chrome", platform: "web" });
        expect(core.listDevices().map((d) => d.deviceId).sort()).toEqual(["tv-1", "web-1"]);
        core.message("web", { type: "cmd", target: "tv-1", action: "play", args: { fileId: "f1", startSec: 30 }, seq: "s1" });
        expect(last("tv", "cmd")).toMatchObject({ action: "play", args: { fileId: "f1", startSec: 30 }, seq: "s1", from: { deviceId: "web-1" } });
        core.message("tv", { type: "ack", seq: "s1", ok: true });
        expect(last("web", "ack")).toMatchObject({ seq: "s1", ok: true, from: "tv-1" });
        core.message("web", { type: "cmd", target: "nope", action: "play", seq: "s2" });
        expect(last("web", "ack")).toMatchObject({ seq: "s2", ok: false, error: "no_such_device" });
        core.message("tv", { type: "state", playing: true, positionSec: 31, media: { fileId: "f1", title: "Dune" } });
        expect(core.listDevices().find((d) => d.deviceId === "tv-1")?.nowPlaying).toMatchObject({ playing: true, positionSec: 31 });
        // reconnect with the same deviceId replaces the stale connection
        core.connect("tv2");
        core.message("tv2", { type: "hello", deviceId: "tv-1", name: "Bedroom TV", platform: "android-tv" });
        expect(core.listDevices().filter((d) => d.deviceId === "tv-1").length).toBe(1);
    });

    it("HTTP command resolves with the ack or times out", async () => {
        const { core, last } = mkCore();
        core.connect("tv");
        core.message("tv", { type: "hello", deviceId: "tv-1", name: "TV", platform: "android-tv" });
        const p = core.command("tv-1", "pause", {});
        const cmd = last("tv", "cmd")!;
        core.message("tv", { type: "ack", seq: cmd.seq, ok: true, state: { playing: false } });
        await expect(p).resolves.toMatchObject({ ok: true, state: { playing: false } });
        await expect(core.command("ghost", "pause", {})).resolves.toMatchObject({ ok: false, error: "no_such_device" });
        await expect(core.command("tv-1", "pause", {}, 20)).resolves.toMatchObject({ ok: false, error: "timeout" });
    });
});

describe("HubCore Watch Together", () => {
    it("waits for everyone, schedules play with lead time, re-waits on buffering", () => {
        const { core, last, advance, now } = mkCore();
        core.connect("a"); core.connect("b");
        core.message("a", { type: "hello", deviceId: "A", name: "Ana" });
        core.message("b", { type: "hello", deviceId: "B", name: "Bogdan" });
        core.message("a", { type: "room:create", name: "Film night" });
        const created = last("a", "room:created")!;
        const roomId = String(created.roomId);
        core.message("b", { type: "room:join", roomId });
        core.message("b", { type: "room:report", positionSec: 0, rttMs: 300 });

        core.message("a", { type: "room:load", media: { fileId: "f1", title: "Dune" }, positionSec: 0 });
        expect(last("b", "room:state")).toMatchObject({ phase: "waiting" });
        core.message("b", { type: "room:ready", ready: true });
        const playing = last("b", "room:state")!;
        expect(playing.phase).toBe("playing");
        const anchor = playing.anchor as { playing: boolean; atServerMs: number; positionSec: number };
        expect(anchor.playing).toBe(true);
        expect(anchor.atServerMs - now()).toBe(450); // 300 ms RTT + 150

        advance(10_450);
        core.message("b", { type: "room:ready", ready: false, positionSec: 10 });
        const waiting = last("a", "room:state")!;
        expect(waiting.phase).toBe("waiting");
        expect((waiting.anchor as { positionSec: number }).positionSec).toBeCloseTo(10, 1);
        core.message("b", { type: "room:ready", ready: true });
        expect(last("a", "room:state")!.phase).toBe("playing");

        core.message("a", { type: "room:pause", positionSec: 42 });
        expect(last("b", "room:state")).toMatchObject({ phase: "paused", anchor: { playing: false, positionSec: 42 } });
        core.message("a", { type: "room:seek", positionSec: 100 });
        expect(last("b", "room:state")!.phase).toBe("waiting");
        advance(9000); core.tick();
        expect(last("b", "room:state")).toMatchObject({ phase: "paused", anchor: { positionSec: 100 } });

        core.message("b", { type: "room:chat", text: "  salut  " });
        expect(last("a", "room:chat")).toMatchObject({ text: "salut", from: { name: "Bogdan" } });
        core.message("a", { type: "room:react", emoji: "😂" });
        expect(last("b", "room:react")).toMatchObject({ emoji: "😂", mediaSec: 100 });
    });

    it("invites admit guests to one room and the current file only", () => {
        const { core, last, advance } = mkCore();
        const { room, invite } = core.createRoom("x");
        expect(core.verifyInvite(invite)).toBe(room.id);
        // Flip the last MAC char to a DIFFERENT one (a fixed "x" was a no-op 1 time in 64).
        expect(core.verifyInvite(invite.slice(0, -1) + (invite.endsWith("x") ? "y" : "x"))).toBeNull();
        core.connect("g", { guest: true, guestName: "Guest", inviteRoomId: room.id });
        expect(last("g", "room:joined")).toMatchObject({ roomId: room.id });
        expect(core.listDevices()).toEqual([]);
        core.message("g", { type: "cmd", target: "x", action: "play" });
        expect(last("g", "ack")).toBeUndefined();
        core.message("g", { type: "room:load", media: { fileId: "f9" } });
        expect(core.inviteAllowsFile(invite, "f9")).toBe(true);
        expect(core.inviteAllowsFile(invite, "f8")).toBe(false);
        advance(25 * 3600_000);
        expect(core.verifyInvite(invite)).toBeNull();
    });

    it("empty rooms expire", () => {
        const { core, advance } = mkCore();
        const { room } = core.createRoom();
        advance(11 * 60_000); core.tick();
        expect(core.rooms.has(room.id)).toBe(false);
    });
});

describe("hub over a real WebSocket", () => {
    let server: http.Server | null = null;
    let hub: Hub | null = null;
    afterEach(async () => {
        hub?.close();
        await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    });

    it("rejects bad tokens, accepts the device token, serves /hub/devices", async () => {
        hub = createHub({ getDeviceToken: () => "tok", isAllowedOrigin: () => false, getSecret: () => "s" });
        const app = express();
        app.use("/hub", hub.router);
        server = http.createServer(app);
        hub.attach(server);
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        const port = (server.address() as { port: number }).port;

        const bad = new WebSocket(`ws://127.0.0.1:${port}/hub?t=nope`);
        await new Promise<void>((r) => { bad.on("error", () => r()); bad.on("unexpected-response", () => r()); });

        const ws = new WebSocket(`ws://127.0.0.1:${port}/hub?t=tok`);
        const msgs: Record<string, unknown>[] = [];
        ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
        await new Promise<void>((r) => ws.on("open", () => r()));
        ws.send(JSON.stringify({ type: "hello", deviceId: "tv-9", name: "TV", platform: "tizen" }));
        await new Promise((r) => setTimeout(r, 50));
        expect(msgs[0]).toMatchObject({ type: "welcome" });
        expect(msgs.some((m) => m.type === "devices")).toBe(true);

        const res = await fetch(`http://127.0.0.1:${port}/hub/devices`, { headers: { "x-device-token": "tok" } });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { devices: { deviceId: string }[] }).devices.map((d) => d.deviceId)).toEqual(["tv-9"]);
        expect((await fetch(`http://127.0.0.1:${port}/hub/devices`)).status).toBe(401);
        ws.close();
    });
});
