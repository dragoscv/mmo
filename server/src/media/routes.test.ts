import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import { openMemoryMediaDb } from "./db";
import { TmdbClient, type FetchLike } from "./tmdb";
import { ProviderRegistry } from "./providers";
import { AvailabilityResolver } from "./availability";
import { ProgressStore } from "./progress";
import { createMediaRouter } from "./routes";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

let server: http.Server;
let base = "";

beforeAll(async () => {
    const db = openMemoryMediaDb();
    const fetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}) });
    const tmdb = new TmdbClient(db, { fetch }); // no key → no-op
    const registry = new ProviderRegistry(db, tmdb);
    const availability = new AvailabilityResolver({ db, tmdb, registry, fetch });
    const progress = new ProgressStore(db);
    const app = express();
    app.use("/media", createMediaRouter({ db, tmdb, registry, availability, progress, region: "ro", log: silent }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}/media`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const j = async (path: string, init?: RequestInit) => {
    const res = await fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("media router (no keys)", () => {
    it("status reports configured:false and region", async () => {
        const r = await j("/status");
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ configured: false, tmdb: false, motn: false, region: "RO", revision: 0 });
    });

    it("home returns empty rows, no error", async () => {
        const r = await j("/home?profile=p1");
        expect(r.status).toBe(200);
        expect(r.body.rows).toEqual([]);
    });

    it("title is 503 without TMDB, 400 on bad params", async () => {
        expect((await j("/title/movie/238")).status).toBe(503);
        expect((await j("/title/book/238")).status).toBe(400);
        expect((await j("/title/movie/abc")).status).toBe(400);
    });

    it("progress PUT validates and round-trips; etag revision bumps", async () => {
        const bad = await j("/progress", { method: "PUT", body: JSON.stringify({ profileId: "p1", kind: "movie" }) });
        expect(bad.status).toBe(400);
        const ok = await j("/progress", { method: "PUT", body: JSON.stringify({ profileId: "p1", kind: "movie", tmdbId: 238, positionSec: 95, durationSec: 100 }) });
        expect(ok.status).toBe(200);
        expect(ok.body.entry).toMatchObject({ tmdbId: 238, completed: true });
        const list = await j("/progress?profile=p1");
        expect((list.body.entries as unknown[]).length).toBe(1);
        const etag = await j("/etag");
        expect(etag.body.revision).toBe(1);
        expect((await j("/progress")).status).toBe(400);
    });

    it("plays POST/GET", async () => {
        const p = await j("/plays", { method: "POST", body: JSON.stringify({ profileId: "p1", trackKey: "t:1", durationSec: 120, completed: true }) });
        expect(p.status).toBe(201);
        const l = await j("/plays?profile=p1");
        expect((l.body.plays as { trackKey: string }[])[0]!.trackKey).toBe("t:1");
    });

    it("search requires q and returns empty without key", async () => {
        expect((await j("/search")).status).toBe(400);
        const r = await j("/search?q=godfather");
        expect(r.body.results).toEqual([]);
    });

    it("providers returns empty catalog without key", async () => {
        const r = await j("/providers");
        expect(r.status).toBe(200);
        expect(r.body.providers).toEqual([]);
    });
});
