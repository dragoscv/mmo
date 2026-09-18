import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import { openMemoryMediaDb } from "./db";
import { TmdbClient, type FetchLike } from "./tmdb";
import { ProviderRegistry } from "./providers";
import { AvailabilityResolver } from "./availability";
import { ProgressStore } from "./progress";
import { createMediaRouter } from "./routes";
import { LibraryIndex } from "./library";
import { MediaSyncClient } from "./sync-client";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

let server: http.Server;
let base = "";
let library: LibraryIndex;
let sync: MediaSyncClient;
let pushes = 0;

beforeAll(async () => {
    const db = openMemoryMediaDb();
    const fetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}) });
    const tmdb = new TmdbClient(db, { fetch }); // no key → no-op
    const registry = new ProviderRegistry(db, tmdb);
    const availability = new AvailabilityResolver({ db, tmdb, registry, fetch });
    const progress = new ProgressStore(db);
    library = new LibraryIndex(db, tmdb);
    sync = new MediaSyncClient({
        db, progress, debounceMs: 15, getWebAppUrl: () => "http://web", getDeviceToken: () => "t", getDeviceId: () => "srv-1",
        fetch: async () => { pushes++; return { ok: true, status: 200 }; },
    });
    const app = express();
    app.use("/media", createMediaRouter({
        db, tmdb, registry, availability, progress, library, sync, region: "ro", log: silent,
        getServerId: () => "srv-1", getServerName: () => "Living PC",
    }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}/media`;
});
afterAll(() => { sync.stop(); return new Promise<void>((r) => server.close(() => r())); });

const j = async (path: string, init?: RequestInit) => {
    const res = await fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("media router (no keys)", () => {
    it("status reports configured:false, region, identity and sync state", async () => {
        const r = await j("/status");
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({
            configured: false, tmdb: false, motn: false, region: "RO", language: "ro-RO", revision: 0, libraryEtag: 0, libraryCount: 0,
            serverId: "srv-1", serverName: "Living PC", sync: { lastPushedRevision: 0, last: null },
        });
        expect(Object.keys(r.body).sort()).toEqual(
            ["configured", "language", "libraryCount", "libraryEtag", "motn", "region", "revision", "serverId", "serverName", "sync", "tmdb"],
        );
    });

    it("home returns empty rows with server attribution", async () => {
        const r = await j("/home?profile=p1");
        expect(r.status).toBe(200);
        expect(r.body.rows).toEqual([]);
        expect(r.body).toMatchObject({ serverId: "srv-1", serverName: "Living PC", libraryEtag: 0 });
    });

    it("title is 503 without TMDB, 400 on bad params", async () => {
        expect((await j("/title/movie/238")).status).toBe(503);
        expect((await j("/title/book/238")).status).toBe(400);
        expect((await j("/title/movie/abc")).status).toBe(400);
    });

    it("progress PUT validates and round-trips; etag revision bumps; schedules a push", async () => {
        const bad = await j("/progress", { method: "PUT", body: JSON.stringify({ profileId: "p1", kind: "movie" }) });
        expect(bad.status).toBe(400);
        const ok = await j("/progress", { method: "PUT", body: JSON.stringify({ profileId: "p1", kind: "movie", tmdbId: 238, positionSec: 95, durationSec: 100 }) });
        expect(ok.status).toBe(200);
        expect(ok.body.entry).toMatchObject({ tmdbId: 238, completed: true, rev: 1 });
        const list = await j("/progress?profile=p1");
        expect((list.body.entries as unknown[]).length).toBe(1);
        const etag = await j("/etag");
        expect(etag.body.revision).toBe(1);
        expect(etag.body.libraryEtag).toBe(0);
        expect((await j("/progress")).status).toBe(400);
        await new Promise((r) => setTimeout(r, 50));
        expect(pushes).toBe(1);
    });

    it("progress PUT accepts a batch; GET ?since= returns only newer revisions", async () => {
        const before = (await j("/etag")).body.revision as number;
        const batch = await j("/progress?profile=p2", {
            method: "PUT",
            body: JSON.stringify([
                { kind: "movie", tmdbId: 1, positionSec: 10, durationSec: 100 },
                { kind: "tv", tmdbId: 2, season: 1, episode: 3, positionSec: 20, durationSec: 40 },
            ]),
        });
        expect(batch.status).toBe(200);
        expect((batch.body.entries as unknown[]).length).toBe(2);
        expect(batch.body.revision).toBe(before + 2);
        const delta = await j(`/progress?profile=p2&since=${before + 1}`);
        expect((delta.body.entries as { tmdbId: number }[]).map((e) => e.tmdbId)).toEqual([2]);
        expect((await j(`/progress?profile=p2&since=${before + 2}`)).body.entries).toEqual([]);
        const badBatch = await j("/progress", { method: "PUT", body: JSON.stringify([{ kind: "movie", tmdbId: 1, positionSec: 1 }]) });
        expect(badBatch.status).toBe(400);
        expect(String(badBatch.body.error)).toMatch(/entries\[0\]/);
        expect((await j("/progress", { method: "PUT", body: "[]" })).status).toBe(400);
    });

    it("library returns full index then a delta with tombstones", async () => {
        const empty = await j("/library");
        expect(empty.body).toMatchObject({ revision: 0, full: true, items: [], removed: [], serverId: "srv-1", serverName: "Living PC" });
        library.upsert({ path: "D:\\Movies\\A.mkv", size: 1, mtime: 1, title: "A", year: null, season: null, episode: null });
        library.upsert({ path: "D:\\Movies\\B.mkv", size: 1, mtime: 1, title: "B", year: null, season: null, episode: null });
        const full = await j("/library");
        expect(full.body).toMatchObject({ revision: 2, full: true });
        expect((full.body.items as unknown[]).length).toBe(2);
        library.removePaths(["D:\\Movies\\A.mkv"]);
        const delta = await j("/library?since=2");
        expect(delta.body).toMatchObject({ revision: 3, full: false, items: [] });
        expect((delta.body.removed as string[]).length).toBe(1);
        expect((await j("/etag")).body.libraryEtag).toBe(3);
        expect((await j("/status")).body.libraryCount).toBe(1);
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
