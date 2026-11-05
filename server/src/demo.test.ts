import { describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("./store", () => ({
    store: { get: vi.fn(() => undefined), set: vi.fn() },
    getSettings: vi.fn(() => ({})),
}));
vi.mock("./logger", () => ({ log: vi.fn() }));

import { demoAllows, demoGuard, isDemoAdmin, isDemoMode } from "./demo";
import { createPairRouter } from "./pair/router";

describe("demo mode", () => {
    it("is enabled only by MMO_DEMO=1", () => {
        expect(isDemoMode({ MMO_DEMO: "1" })).toBe(true);
        expect(isDemoMode({ MMO_DEMO: "true" })).toBe(false);
        expect(isDemoMode({})).toBe(false);
    });

    it("lets viewers browse, play and keep progress", () => {
        expect(demoAllows("GET", "/media/home")).toBe(true);
        expect(demoAllows("GET", "/video/direct/abc")).toBe(true);
        expect(demoAllows("GET", "/livetv/channels")).toBe(true);
        expect(demoAllows("PUT", "/media/progress")).toBe(true);
        expect(demoAllows("PUT", "/media/watchlist/movie/10378")).toBe(true);
        expect(demoAllows("POST", "/video/scan")).toBe(true);
        expect(demoAllows("POST", "/pair/request")).toBe(true);
        expect(demoAllows("POST", "/hub/rooms")).toBe(true);
    });

    it("refuses administration and host reads", () => {
        expect(demoAllows("POST", "/folders/remove")).toBe(false);
        expect(demoAllows("POST", "/livetv/sources")).toBe(false);
        expect(demoAllows("DELETE", "/livetv/sources/1")).toBe(false);
        expect(demoAllows("POST", "/media/profiles")).toBe(false);
        expect(demoAllows("PATCH", "/media/profiles/p_1")).toBe(false);
        expect(demoAllows("DELETE", "/library/tracks/3")).toBe(false);
        expect(demoAllows("POST", "/pair/approve")).toBe(false);
        expect(demoAllows("PUT", "/hub/settings")).toBe(false);
        expect(demoAllows("POST", "/video/flags")).toBe(false);
        expect(demoAllows("GET", "/fs/drives")).toBe(false);
        expect(demoAllows("GET", "/logs/recent")).toBe(false);
        expect(demoAllows("GET", "/rest/createPlaylist.view")).toBe(false);
        expect(demoAllows("POST", "/media/progress/../profiles")).toBe(false);
    });

    it("treats only direct loopback (no proxy header) as admin", () => {
        expect(isDemoAdmin({ headers: {}, socket: { remoteAddress: "127.0.0.1" } })).toBe(true);
        expect(isDemoAdmin({ headers: {}, socket: { remoteAddress: "::ffff:127.0.0.1" } })).toBe(true);
        expect(isDemoAdmin({ headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "127.0.0.1" } })).toBe(false);
        expect(isDemoAdmin({ headers: {}, socket: { remoteAddress: "10.0.0.5" } })).toBe(false);
    });
});

describe("demo mode over HTTP", () => {
    const TOKEN = "tok_" + "d".repeat(40);

    async function withServer(fn: (base: string) => Promise<void>) {
        const app = express();
        app.use(demoGuard);
        const auth: express.RequestHandler = (req, res, next) => {
            if (req.header("x-device-token") === TOKEN) next(); else res.status(401).json({ error: "Unauthorized" });
        };
        app.use("/pair", createPairRouter({
            authMiddleware: auth, getPort: () => 17899, getVersion: () => "test", autoApprove: true,
            getDeviceToken: () => TOKEN, getUserId: () => "local", getWebAppUrl: () => undefined, getLanHost: () => null,
        }));
        app.post("/livetv/sources", auth, (_req, res) => { res.status(201).json({ ok: true }); });
        const server = http.createServer(app);
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        const { port } = server.address() as AddressInfo;
        try { await fn(`http://127.0.0.1:${port}`); } finally { server.close(); }
    }

    it("auto-approves Quick Connect: the first poll returns the token", async () => {
        await withServer(async (base) => {
            const req = await fetch(`${base}/pair/request`, {
                method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
                body: JSON.stringify({ deviceName: "Reviewer phone", platform: "ios" }),
            });
            expect(req.status).toBe(201);
            const { code, secret } = await req.json() as { code: string; secret: string };
            const poll = await fetch(`${base}/pair/poll?code=${code}&secret=${secret}`);
            const body = await poll.json() as { status: string; deviceToken?: string };
            expect(body.status).toBe("approved");
            expect(body.deviceToken).toBe(TOKEN);
        });
    });

    it("blocks a proxied client from admin writes even with the token, allows local admin", async () => {
        await withServer(async (base) => {
            const viaProxy = await fetch(`${base}/livetv/sources`, {
                method: "POST", headers: { "x-device-token": TOKEN, "x-forwarded-for": "203.0.113.9" },
            });
            expect(viaProxy.status).toBe(403);
            const local = await fetch(`${base}/livetv/sources`, { method: "POST", headers: { "x-device-token": TOKEN } });
            expect(local.status).toBe(201);
        });
    });
});
