import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMemoryLiveTvDb } from "./db";
import { LiveTvService } from "./service";
import { DvrScheduler, type SpawnFfmpeg } from "./recorder";
import { createLiveTvRouter } from "./routes";
import { rewritePlaylist } from "./routes";
import { silentLogger, type FetchLike } from "./util";

const H = 3_600_000;
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const xt = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";

const PLAYLIST = [
    '#EXTM3U url-tvg="http://iptv.test/guide.xml"',
    '#EXTINF:-1 tvg-id="news" group-title="News",News One',
    "http://stream.test/news.ts",
    '#EXTINF:-1 tvg-id="film" group-title="Movies",Film Box',
    "http://stream.test/film.ts",
    '#EXTINF:-1 tvg-id="hls" group-title="Live",HLS Chan',
    "http://hls.test/live/master.m3u8",
].join("\n");
const GUIDE = `<tv>
  <programme start="${xt(NOW - H)}" stop="${xt(NOW + H)}" channel="news"><title>Live News</title></programme>
  <programme start="${xt(NOW + 2 * H)}" stop="${xt(NOW + 3 * H)}" channel="film"><title>Film</title></programme>
</tv>`;

const upstreamFetch: FetchLike = async (url) => {
    if (url.includes("list.m3u")) return new Response(PLAYLIST);
    if (url.includes("guide.xml")) return new Response(GUIDE);
    if (url.startsWith("http://stream.test/")) return new Response("TSDATA", { status: 200, headers: { "content-type": "video/mp2t" } });
    if (url === "http://hls.test/live/master.m3u8") {
        return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8\n", { headers: { "content-type": "application/vnd.apple.mpegurl" } });
    }
    if (url === "http://hls.test/live/low/index.m3u8") {
        return new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nseg1.ts\n', { headers: { "content-type": "application/x-mpegURL" } });
    }
    if (url === "http://hls.test/live/low/seg1.ts") return new Response("SEG1", { headers: { "content-type": "video/mp2t" } });
    return new Response("nope", { status: 404 });
};

describe("rewritePlaylist", () => {
    it("resolves relative URIs and rewrites plain lines + URI attributes", () => {
        const out = rewritePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\n../a/s1.m4s\n', "http://h.test/x/y/p.m3u8", (u) => `P(${u})`);
        expect(out).toBe('#EXTM3U\n#EXT-X-MAP:URI="P(http://h.test/x/y/init.mp4)"\n#EXTINF:4,\nP(http://h.test/x/a/s1.m4s)\n');
    });
});

const neverSpawn: SpawnFfmpeg = () => { throw new Error("ffmpeg must not run in route tests"); };

let server: http.Server;
let base = "";
let svc: LiveTvService;
let dir: string;

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "livetv-routes-"));
    const db = openMemoryLiveTvDb();
    svc = new LiveTvService({ db, fetch: upstreamFetch });
    const dvr = new DvrScheduler({ db, service: svc, recordingsDir: dir, spawnFfmpeg: neverSpawn });
    const app = express();
    app.use("/livetv", createLiveTvRouter({ service: svc, dvr, log: silentLogger, fetch: upstreamFetch }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/livetv`;
});
afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
});

const j = async (p: string, init?: RequestInit) => {
    const res = await fetch(base + p, { redirect: "manual", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
    return { status: res.status, body, text, headers: res.headers };
};
const post = (p: string, b: unknown, method = "POST") => j(p, { method, body: JSON.stringify(b) });

describe("livetv router", () => {
    let sourceId = "";
    let newsId = "";
    let filmId = "";

    it("sources CRUD masks passwords and validates input", async () => {
        expect((await post("/sources", { kind: "ftp", name: "x", url: "y" })).status).toBe(400);
        expect((await post("/sources", { kind: "m3u", url: "http://x" })).body.error).toMatch(/name/);
        expect((await post("/sources", { kind: "xtream", name: "X", url: "http://xt" })).status).toBe(400);
        expect((await j("/sources", { method: "POST", body: "[1]" })).status).toBe(400);

        const xt = await post("/sources", { kind: "xtream", name: "XT", url: "http://xt.test", username: "bob", password: "hunter2", enabled: false });
        expect(xt.status).toBe(201);
        expect(xt.body).toMatchObject({ kind: "xtream", username: "bob", hasPassword: true, enabled: false });
        expect(xt.text).not.toContain("hunter2");
        const patched = await post(`/sources/${xt.body.id as string}`, { name: "XT2", password: "" }, "PATCH");
        expect(patched.status).toBe(400); // xtream needs a password
        expect((await post(`/sources/${xt.body.id as string}`, { kind: "m3u" }, "PATCH")).status).toBe(400);
        expect((await post(`/sources/${xt.body.id as string}`, { name: "XT2" }, "PATCH")).body).toMatchObject({ name: "XT2", hasPassword: true });

        const list = await j("/sources");
        expect(list.text).not.toContain("hunter2");
        expect((await j(`/sources/${xt.body.id as string}`, { method: "DELETE" })).body).toEqual({ ok: true });
        expect((await j(`/sources/${xt.body.id as string}`, { method: "DELETE" })).status).toBe(404);

        const m3u = await post("/sources", { kind: "m3u", name: "Home", url: "http://iptv.test/list.m3u" });
        expect(m3u.status).toBe(201);
        sourceId = m3u.body.id as string;
    });

    it("test + refresh imports channels and guide", async () => {
        const t = await post(`/sources/${sourceId}/test`, {});
        expect(t.body).toMatchObject({ ok: true, channelCount: 3, error: null });
        const r = await post(`/sources/${sourceId}/refresh`, {});
        expect(r.status).toBe(200);
        expect(r.body.source).toMatchObject({ ok: true, channelCount: 3 });
        expect(r.body.guide).toMatchObject({ ok: true, programmes: 2 });
        const ch = (await j("/channels")).body.channels as Array<{ id: string; name: string; favourite: boolean }>;
        newsId = ch.find((c) => c.name === "News One")!.id;
        filmId = ch.find((c) => c.name === "Film Box")!.id;
        expect((await j("/groups")).body.groups).toEqual([{ name: "News", count: 1 }, { name: "Movies", count: 1 }, { name: "Live", count: 1 }]);
        expect(((await j("/channels?group=Movies")).body.channels as unknown[]).length).toBe(1);
    });

    it("favourites and channel patch", async () => {
        expect((await j(`/channels/${newsId}/favourite?profile=kid`, { method: "PUT" })).body).toEqual({ ok: true, favourite: true });
        expect((await j(`/channels/${newsId}/favourite?profile=bad%20id`, { method: "PUT" })).status).toBe(400);
        expect((await j("/channels/missing/favourite?profile=kid", { method: "PUT" })).status).toBe(404);
        const favs = (await j("/channels?profile=kid&favourites=1")).body.channels as Array<{ id: string; favourite: boolean }>;
        expect(favs).toEqual([expect.objectContaining({ id: newsId, favourite: true })]);
        expect((await post(`/channels/${filmId}`, { hidden: "yes" }, "PATCH")).status).toBe(400);
        expect((await post(`/channels/${filmId}`, { hidden: true, number: "9" }, "PATCH")).body).toMatchObject({ hidden: true, number: "9" });
        expect(((await j("/channels")).body.channels as unknown[]).length).toBe(2);
        expect(((await j("/channels?hidden=1")).body.channels as unknown[]).length).toBe(3);
        await post(`/channels/${filmId}`, { hidden: false }, "PATCH");
        await j(`/channels/${newsId}/favourite?profile=kid`, { method: "DELETE" });
        expect(((await j("/channels?profile=kid&favourites=1")).body.channels as unknown[]).length).toBe(0);
    });

    it("guide window + now/next", async () => {
        const g = await j(`/guide?from=${NOW - 2 * H}&to=${NOW + 4 * H}`);
        expect((g.body.programmes as Array<{ title: string }>).map((p) => p.title).sort()).toEqual(["Film", "Live News"]);
        const onlyNews = await j(`/guide?from=${NOW - 2 * H}&to=${NOW + 4 * H}&channels=${newsId}`);
        expect((onlyNews.body.programmes as Array<{ title: string }>).map((p) => p.title)).toEqual(["Live News"]);
        expect((await j(`/guide?from=${NOW}&to=${NOW + 49 * H}`)).status).toBe(400);
        const now = await j(`/now?channels=${newsId},${filmId}`);
        const rows = now.body.channels as Array<{ channelId: string; now: { title: string } | null; next: { title: string } | null }>;
        expect(rows[0]).toMatchObject({ channelId: newsId, now: { title: "Live News" } });
        expect(rows[1]).toMatchObject({ channelId: filmId, now: null, next: { title: "Film" } });
    });

    it("stream redirects by default and proxies with ?proxy=1", async () => {
        const r = await j(`/stream/${newsId}`);
        expect(r.status).toBe(302);
        expect(r.headers.get("location")).toBe("http://stream.test/news.ts");
        const p = await j(`/stream/${newsId}?proxy=1`);
        expect(p.status).toBe(200);
        expect(p.headers.get("content-type")).toBe("video/mp2t");
        expect(p.text).toBe("TSDATA");
        expect((await j("/stream/missing")).status).toBe(404);
    });

    it("proxies HLS: master → variant → key/segment through signed /proxy URLs, rejects forged ones", async () => {
        const chans = (await j("/channels")).body.channels as { id: string; name: string }[];
        const hlsId = chans.find((c) => c.name === "HLS Chan")!.id;
        const master = await fetch(`${base}/stream/${hlsId}?proxy=1&t=tok`);
        expect(master.headers.get("content-type")).toMatch(/^application\/vnd\.apple\.mpegurl/);
        const mText = await master.text();
        const variantLine = mText.split("\n").find((l) => l.startsWith("/livetv/proxy/"))!;
        expect(variantLine).toContain("&t=tok");
        const variant = await (await fetch(`http://127.0.0.1:${new URL(base).port}${variantLine}`)).text();
        expect(variant).toMatch(/URI="\/livetv\/proxy\/[^"]+"/);
        const segLine = variant.split("\n").find((l) => l.startsWith("/livetv/proxy/"))!;
        expect(await (await fetch(`http://127.0.0.1:${new URL(base).port}${segLine}`)).text()).toBe("SEG1");
        // forged target / tampered signature → 403
        const forged = `${base}/proxy/${hlsId}?u=${Buffer.from("http://169.254.169.254/").toString("base64url")}&s=${"A".repeat(32)}`;
        expect((await fetch(forged)).status).toBe(403);
    });

    it("catch-up needs params and an archive", async () => {
        expect((await j(`/catchup/${newsId}`)).status).toBe(400);
        expect((await j(`/catchup/${newsId}?start=${NOW - H}&duration=30`)).status).toBe(409);
    });

    it("recordings + rules validate, schedule and cancel without spawning ffmpeg", async () => {
        expect((await post("/recordings", { channelId: newsId, start: NOW + H })).status).toBe(400);
        expect((await post("/recordings", { start: NOW + H, stop: NOW + 2 * H })).status).toBe(400);
        const rec = await post("/recordings", { channelId: filmId, programme: { start: NOW + 2 * H } });
        expect(rec.status).toBe(201);
        expect(rec.body).toMatchObject({ channelId: filmId, title: "Film", status: "scheduled", conflict: false });
        const manual = await post("/recordings", { channelId: newsId, start: NOW + 5 * H, stop: NOW + 6 * H, title: "Manual" });
        expect(manual.body).toMatchObject({ title: "Manual", status: "scheduled" });
        expect(((await j("/recordings")).body.recordings as unknown[]).length).toBe(2);
        expect((await j(`/recordings/${manual.body.id as string}`, { method: "DELETE" })).body).toEqual({ ok: true, status: "cancelled", deleted: false });
        expect((await j("/recordings/missing", { method: "DELETE" })).status).toBe(404);

        expect((await post("/rules", { titleMatch: "" })).status).toBe(400);
        const rule = await post("/rules", { titleMatch: "Live", keepLast: 3 });
        expect(rule.status).toBe(201);
        expect(rule.body).toMatchObject({ titleMatch: "Live", keepLast: 3, enabled: true });
        expect(((await j("/rules")).body.rules as unknown[]).length).toBe(1);
        expect((await j(`/rules/${rule.body.id as string}`, { method: "DELETE" })).body).toEqual({ ok: true });
        expect((await j(`/rules/${rule.body.id as string}`, { method: "DELETE" })).status).toBe(404);
    });
});
