import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import express from "express";
import { createHub, type Hub } from "./index";
import { HubCore } from "./core";
import { isBlockedWord, maskProfanity, MediaModerationStore } from "./moderation";
import { openMemoryMediaDb } from "../media/db";
import { formFactorOf, isPlaybackTarget, normalizePlatform } from "../lib/client-platform";

function mk(withStore = true) {
    let t = 50_000;
    const db = openMemoryMediaDb();
    const store = withStore ? new MediaModerationStore(db, () => t) : null;
    const out: { to: string; msg: Record<string, unknown> }[] = [];
    const core = new HubCore((to, msg) => out.push({ to, msg: msg as Record<string, unknown> }), () => "s", () => t, store);
    const all = (to: string, type: string) => out.filter((o) => o.to === to && o.msg.type === type).map((o) => o.msg);
    const last = (to: string, type: string) => all(to, type).at(-1);
    return { core, store, db, out, all, last, advance: (ms: number) => { t += ms; } };
}

function room(m: ReturnType<typeof mk>, members: { conn: string; dev: string; name: string; profile?: string }[]) {
    for (const x of members) {
        m.core.connect(x.conn);
        m.core.message(x.conn, { type: "hello", deviceId: x.dev, name: x.name, platform: "android-phone", profileId: x.profile });
    }
    m.core.message(members[0]!.conn, { type: "room:create", name: "Film" });
    const roomId = String(m.last(members[0]!.conn, "room:created")!.roomId);
    for (const x of members.slice(1)) m.core.message(x.conn, { type: "room:join", roomId });
    return roomId;
}

describe("client platforms", () => {
    it("normalises phone platforms and aliases", () => {
        expect(normalizePlatform("android-phone")).toBe("android-phone");
        expect(normalizePlatform("iOS")).toBe("ios");
        expect(normalizePlatform("iPhone")).toBe("ios");
        expect(normalizePlatform("Android-TV")).toBe("android-tv");
        expect(normalizePlatform("weird <b>")).toBe("weirdb");
        expect(normalizePlatform(42)).toBe("unknown");
        expect(normalizePlatform("", "x")).toBe("x");
        expect(formFactorOf("ios")).toBe("phone");
        expect(formFactorOf("tizen")).toBe("tv");
    });
    it("phones are playback targets only with the playback cap", () => {
        expect(isPlaybackTarget({ platform: "android-tv", caps: [] })).toBe(true);
        expect(isPlaybackTarget({ platform: "ios", caps: ["remote"] })).toBe(false);
        expect(isPlaybackTarget({ platform: "android-phone", caps: ["playback"] })).toBe(true);
        expect(isPlaybackTarget({ platform: "web", caps: [], guest: true })).toBe(false);
    });
    it("hub lists formFactor/playbackTarget and filters targets", () => {
        const m = mk();
        m.core.connect("tv"); m.core.connect("ph"); m.core.connect("ph2");
        m.core.message("tv", { type: "hello", deviceId: "tv", name: "TV", platform: "android-tv" });
        m.core.message("ph", { type: "hello", deviceId: "ph", name: "Phone", platform: "ios", caps: ["remote"] });
        m.core.message("ph2", { type: "hello", deviceId: "ph2", name: "Tablet", platform: "android-phone", caps: ["playback"] });
        const list = m.core.listDevices();
        expect(list.find((d) => d.deviceId === "ph")).toMatchObject({ platform: "ios", formFactor: "phone", playbackTarget: false });
        expect(list.find((d) => d.deviceId === "tv")).toMatchObject({ formFactor: "tv", playbackTarget: true });
        expect(m.core.listDevices({ targetsOnly: true }).map((d) => d.deviceId).sort()).toEqual(["ph2", "tv"]);
    });
});

describe("chat word filter", () => {
    it("masks RO + EN abuse, accent- and case-insensitive, keeps innocent words", () => {
        expect(maskProfanity("you are a FUCKING idiot").text).toBe("you are a *** ***");
        expect(maskProfanity("ești un cretin, pizdă").text).toBe("ești un ***, ***");
        expect(maskProfanity("fuuuuck").masked).toBe(true);
        const clean = maskProfanity("Ce film bun! Assassin's Creed la 9 😂");
        expect(clean).toEqual({ text: "Ce film bun! Assassin's Creed la 9 😂", masked: false });
        expect(isBlockedWord("class")).toBe(false);
        expect(isBlockedWord("ass")).toBe(true);
        expect(isBlockedWord("pula")).toBe(true);
        expect(isBlockedWord("populară")).toBe(false);
    });

    it("chat messages get stable ids and are masked unless the owner disabled the filter", () => {
        const m = mk();
        room(m, [{ conn: "a", dev: "A", name: "Ana" }, { conn: "b", dev: "B", name: "Bogdan" }]);
        m.core.message("b", { type: "room:chat", text: "esti un idiot" });
        const msg = m.last("a", "room:chat")!;
        expect(msg.text).toBe("esti un ***");
        expect(msg.masked).toBe(true);
        expect(String(msg.id)).toMatch(/^m_/);
        expect(msg.from).toMatchObject({ deviceId: "B", name: "Bogdan" });
        m.store!.setChatFilter(false);
        m.core.message("b", { type: "room:chat", text: "esti un idiot" });
        expect(m.last("a", "room:chat")!.text).toBe("esti un idiot");
        expect(m.last("a", "room:chat")!.id).not.toBe(msg.id);
    });
});

describe("report / block / kick", () => {
    it("report stores the message with offender + reason; owner resolves it", () => {
        const m = mk();
        const roomId = room(m, [{ conn: "a", dev: "A", name: "Ana" }, { conn: "b", dev: "B", name: "Bogdan" }]);
        m.core.message("b", { type: "room:chat", text: "spam spam" });
        const id = String(m.last("a", "room:chat")!.id);
        m.core.message("a", { type: "report", roomId, messageId: id, reason: "spam" });
        expect(m.last("a", "report:ok")).toMatchObject({ messageId: id });
        const open = m.store!.listReports();
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({ roomId, messageId: id, reason: "spam", reporterDeviceId: "A", offenderDeviceId: "B", offenderName: "Bogdan", text: "spam spam", resolvedAt: null });
        m.core.message("a", { type: "report", messageId: "m_x", reason: "nonsense" });
        expect(m.store!.listReports()[0]).toMatchObject({ reason: "other", offenderDeviceId: null });
        const r = m.store!.resolveReport(open[0]!.id, "warned");
        expect(r).toMatchObject({ resolution: "warned" });
        expect(m.store!.listReports().length).toBe(1);
        expect(m.store!.listReports({ status: "resolved" }).length).toBe(1);
        expect(m.store!.resolveReport("nope", "x")).toBeNull();
    });

    it("block hides the member's chat + reactions from the blocker only, persists per profile, survives new rooms", () => {
        const m = mk();
        room(m, [{ conn: "a", dev: "A", name: "Ana", profile: "p1" }, { conn: "b", dev: "B", name: "Bogdan" }, { conn: "c", dev: "C", name: "Cris" }]);
        m.core.message("a", { type: "block", memberId: "b" });
        expect(m.last("a", "block:ok")).toMatchObject({ deviceId: "B", blocked: true });
        const before = m.all("a", "room:chat").length;
        m.core.message("b", { type: "room:chat", text: "hello" });
        m.core.message("b", { type: "room:react", emoji: "🔥" });
        expect(m.all("a", "room:chat").length).toBe(before);
        expect(m.all("a", "room:react").length).toBe(0);
        expect(m.last("c", "room:chat")!.text).toBe("hello");
        expect(m.last("c", "room:react")).toMatchObject({ emoji: "🔥" });
        expect([...m.store!.blockedDeviceIds("p1")]).toEqual(["B"]);

        // Same profile in a later room: the persisted block applies on join.
        m.core.message("a", { type: "room:leave" });
        m.core.message("b", { type: "room:create" });
        const r2 = String(m.last("b", "room:created")!.roomId);
        m.core.message("a", { type: "room:join", roomId: r2 });
        m.core.message("b", { type: "room:chat", text: "again" });
        expect(m.all("a", "room:chat").map((x) => x.text)).not.toContain("again");
        m.core.message("a", { type: "unblock", deviceId: "B" });
        m.core.message("b", { type: "room:chat", text: "back" });
        expect(m.last("a", "room:chat")!.text).toBe("back");
        expect(m.store!.blockedDeviceIds("p1").size).toBe(0);
        m.core.message("a", { type: "block", deviceId: "A" });
        expect(m.last("a", "error")).toMatchObject({ error: "bad_block" });
    });

    it("only the host can kick; kicked devices cannot rejoin", () => {
        const m = mk();
        const roomId = room(m, [{ conn: "a", dev: "A", name: "Ana" }, { conn: "b", dev: "B", name: "Bogdan" }]);
        m.core.message("b", { type: "kick", memberId: "a" });
        expect(m.last("b", "error")).toMatchObject({ error: "not_host" });
        m.core.message("a", { type: "room:kick", memberId: "b" });
        expect(m.last("b", "room:kicked")).toMatchObject({ roomId });
        expect(m.core.rooms.get(roomId)!.members.has("b")).toBe(false);
        m.core.message("b", { type: "room:join", roomId });
        expect(m.last("b", "error")).toMatchObject({ error: "kicked" });
        expect(m.core.rooms.get(roomId)!.members.has("b")).toBe(false);
    });

    it("works without a store (filter on, nothing persisted)", () => {
        const m = mk(false);
        const roomId = room(m, [{ conn: "a", dev: "A", name: "Ana" }, { conn: "b", dev: "B", name: "B" }]);
        m.core.message("b", { type: "room:chat", text: "shit" });
        expect(m.last("a", "room:chat")!.text).toBe("***");
        m.core.message("a", { type: "report", roomId, messageId: String(m.last("a", "room:chat")!.id), reason: "hate" });
        expect(m.last("a", "report:ok")).toMatchObject({ reportId: null });
    });
});

describe("hub moderation HTTP", () => {
    let server: http.Server | null = null;
    let hub: Hub | null = null;
    afterEach(async () => {
        hub?.close();
        await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    });

    it("lists/resolves reports, toggles the filter, lists/deletes blocks (device token only)", async () => {
        const db = openMemoryMediaDb();
        const store = new MediaModerationStore(db);
        hub = createHub({ getDeviceToken: () => "tok", isAllowedOrigin: () => false, getSecret: () => "s", moderation: store });
        const app = express();
        app.use("/hub", hub.router);
        server = http.createServer(app);
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/hub`;
        const H = { "x-device-token": "tok", "content-type": "application/json" };

        const rep = store.addReport({ roomId: "r", messageId: "m_1", reporterDeviceId: "A", reporterName: "Ana", offenderDeviceId: "B", offenderName: "B", text: "x", reason: "spam" });
        store.addBlock("p1", "B", "Bogdan");
        expect((await fetch(`${base}/reports`)).status).toBe(401);
        const list = await (await fetch(`${base}/reports`, { headers: H })).json() as { reports: { id: string }[] };
        expect(list.reports.map((r) => r.id)).toEqual([rep.id]);
        const res = await fetch(`${base}/reports/${rep.id}/resolve`, { method: "POST", headers: H, body: JSON.stringify({ resolution: "blocked" }) });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { report: { resolution: string } }).report.resolution).toBe("blocked");
        expect((await fetch(`${base}/reports/nope/resolve`, { method: "POST", headers: H, body: "{}" })).status).toBe(404);
        expect(((await (await fetch(`${base}/reports?status=all`, { headers: H })).json()) as { reports: unknown[] }).reports).toHaveLength(1);

        expect(await (await fetch(`${base}/settings`, { headers: H })).json()).toEqual({ chatFilter: true });
        expect((await fetch(`${base}/settings`, { method: "PUT", headers: H, body: JSON.stringify({ chatFilter: "no" }) })).status).toBe(400);
        expect(await (await fetch(`${base}/settings`, { method: "PUT", headers: H, body: JSON.stringify({ chatFilter: false }) })).json()).toEqual({ chatFilter: false });
        expect(store.chatFilterEnabled()).toBe(false);

        expect(((await (await fetch(`${base}/blocks?profile=p1`, { headers: H })).json()) as { blocks: { deviceId: string }[] }).blocks.map((b) => b.deviceId)).toEqual(["B"]);
        expect(await (await fetch(`${base}/blocks/p1/B`, { method: "DELETE", headers: H })).json()).toEqual({ removed: true });
        expect((await (await fetch(`${base}/devices?targets=1`, { headers: H })).json() as { devices: unknown[] }).devices).toEqual([]);
    });
});
