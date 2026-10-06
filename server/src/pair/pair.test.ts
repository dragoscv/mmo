import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../store", () => ({
    store: { get: vi.fn(() => undefined), set: vi.fn() },
    getSettings: vi.fn(() => ({})),
}));
vi.mock("../logger", () => ({ log: vi.fn() }));

import { PairingService, PairError, PAIR_TTL_MS, PAIR_MAX_PENDING, PAIR_POLL_MIN_INTERVAL_MS } from "./service";
import { createPairRouter } from "./router";

const TOKEN = "tok_" + "a".repeat(40);

function makeClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("PairingService", () => {
    let clock: ReturnType<typeof makeClock>;
    let svc: PairingService;
    beforeEach(() => {
        clock = makeClock();
        svc = new PairingService(clock.now);
    });

    it("issues a 6-digit code, 64-hex secret and a 10-minute expiry", () => {
        const r = svc.request({ deviceName: "Living TV", platform: "tizen" });
        expect(r.code).toMatch(/^\d{6}$/);
        expect(r.secret).toMatch(/^[0-9a-f]{64}$/);
        expect(r.expiresAt - r.createdAt).toBe(PAIR_TTL_MS);
        expect(r.approved).toBe(false);
        expect(svc.listPending()[0]).not.toHaveProperty("secret");
    });

    it("codes are unique among pending", () => {
        const codes = new Set<string>();
        for (let i = 0; i < PAIR_MAX_PENDING; i++) codes.add(svc.request({}).code);
        expect(codes.size).toBe(PAIR_MAX_PENDING);
        expect(() => svc.request({})).toThrowError(PairError);
        try { svc.request({}); } catch (e) { expect((e as PairError).status).toBe(429); }
    });

    it("expires after TTL", () => {
        const r = svc.request({});
        expect(svc.poll(r.code, r.secret).status).toBe("pending");
        clock.advance(PAIR_TTL_MS + 1);
        expect(svc.poll(r.code, r.secret).status).toBe("expired");
        expect(svc.approve(r.code)).toBe(false);
    });

    it("approve → poll hands over exactly once", () => {
        const r = svc.request({});
        expect(svc.approve(r.code)).toBe(true);
        expect(svc.poll(r.code, r.secret).status).toBe("approved");
        clock.advance(PAIR_POLL_MIN_INTERVAL_MS);
        expect(svc.poll(r.code, r.secret).status).toBe("expired");
        expect(svc.size).toBe(0);
    });

    it("wrong secret → 403", () => {
        const r = svc.request({});
        const wrong = r.secret.replace(/./, (c) => (c === "0" ? "1" : "0"));
        expect(() => svc.poll(r.code, wrong)).toThrowError(PairError);
        try { svc.poll(r.code, wrong); } catch (e) { expect((e as PairError).status).toBe(403); }
        try { svc.poll(r.code, "short"); } catch (e) { expect((e as PairError).status).toBe(403); }
    });

    it("rate-limits polls to one per 2 s", () => {
        const r = svc.request({});
        svc.poll(r.code, r.secret);
        clock.advance(500);
        try { svc.poll(r.code, r.secret); expect.unreachable(); } catch (e) { expect((e as PairError).status).toBe(429); }
        clock.advance(PAIR_POLL_MIN_INTERVAL_MS);
        expect(svc.poll(r.code, r.secret).status).toBe("pending");
    });

    it("rejects malformed codes", () => {
        try { svc.poll("12345", "x"); expect.unreachable(); } catch (e) { expect((e as PairError).status).toBe(400); }
        expect(svc.approve("abcdef")).toBe(false);
    });
});

describe("/pair router", () => {
    let server: http.Server;
    let base: string;
    let clock: ReturnType<typeof makeClock>;

    beforeEach(async () => {
        clock = makeClock();
        const app = express();
        const authMiddleware: express.RequestHandler = (req, res, next) => {
            if (req.headers["x-device-token"] === TOKEN) next();
            else res.status(401).json({ error: "Unauthorized" });
        };
        app.use("/pair", createPairRouter({
            authMiddleware,
            getPort: () => 17899,
            getVersion: () => "9.9.9",
            service: new PairingService(clock.now),
            getDeviceToken: () => TOKEN,
            getUserId: () => "user_1",
            getWebAppUrl: () => "https://mixai.ro/",
            getLanHost: () => "192.168.1.50",
        }));
        server = http.createServer(app);
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        return () => new Promise<void>((r) => server.close(() => r()));
    });

    const json = async (path: string, init?: RequestInit) => {
        const res = await fetch(base + path, init);
        return { status: res.status, body: await res.json() as Record<string, unknown> };
    };

    it("info is public and labels the server", async () => {
        const { status, body } = await json("/pair/info");
        expect(status).toBe(200);
        expect(body).toMatchObject({ version: "9.9.9", port: 17899, lanUrl: "http://192.168.1.50:17899", pairingSupported: true, hasToken: true });
    });

    it("request → approve (POST, auth) → poll returns token once", async () => {
        const req = await json("/pair/request", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceName: "TV", platform: "android-tv" }),
        });
        expect(req.status).toBe(201);
        const code = req.body.code as string;
        const secret = req.body.secret as string;
        expect(req.body.qr).toBe(`mixai://pair?host=192.168.1.50&port=17899&code=${code}`);
        expect(req.body.approveUrl).toBe(`https://mixai.ro/pair?host=192.168.1.50&port=17899&code=${code}`);

        expect((await json(`/pair/poll?code=${code}&secret=${secret}`)).body).toEqual({ status: "pending" });

        const pending = await json("/pair/pending", { headers: { "x-device-token": TOKEN } });
        expect(pending.body.pending).toEqual([expect.objectContaining({ code, deviceName: "TV", platform: "android-tv" })]);
        expect(JSON.stringify(pending.body)).not.toContain(secret);

        expect((await json("/pair/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })).status).toBe(401);
        const ok = await json("/pair/approve", {
            method: "POST", headers: { "content-type": "application/json", "x-device-token": TOKEN },
            body: JSON.stringify({ code }),
        });
        expect(ok.body).toEqual({ ok: true, code });

        clock.advance(PAIR_POLL_MIN_INTERVAL_MS);
        const approved = await json(`/pair/poll?code=${code}&secret=${secret}`);
        expect(approved.body).toEqual({ status: "approved", deviceToken: TOKEN, userId: "user_1" });

        clock.advance(PAIR_POLL_MIN_INTERVAL_MS);
        expect((await json(`/pair/poll?code=${code}&secret=${secret}`)).body).toEqual({ status: "expired" });
    });

    it("GET approve needs the real token in ?t=", async () => {
        const req = await json("/pair/request", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const code = req.body.code as string;
        expect((await json(`/pair/approve?code=${code}&t=wrong`)).status).toBe(401);
        expect((await json(`/pair/approve?code=${code}&t=${TOKEN}`)).body).toEqual({ ok: true, code });
        expect((await json(`/pair/approve?code=000000&t=${TOKEN}`)).status).toBe(404);
    });

    it("poll with wrong secret → 403, too fast → 429", async () => {
        const req = await json("/pair/request", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const code = req.body.code as string;
        const secret = req.body.secret as string;
        expect((await json(`/pair/poll?code=${code}&secret=${"f".repeat(64)}`)).status).toBe(403);
        expect((await json(`/pair/poll?code=${code}&secret=${secret}`)).status).toBe(200);
        expect((await json(`/pair/poll?code=${code}&secret=${secret}`)).status).toBe(429);
    });
});
