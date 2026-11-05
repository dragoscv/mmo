import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

vi.mock("../store", () => ({ getSettings: () => ({ scanFolders: [] }), updateSettings: () => undefined, store: { get: () => undefined } }));
vi.mock("../platform", () => ({ platform: { getPath: () => os.tmpdir(), isElectron: false } }));

import { DownloadCache, parseProgressChunk, remuxMp4Args, type MediaTracks, type RunRemux } from "./download-cache";
import { createDownloadRouter, tracksFromMeta } from "./download-routes";
import { parseRange, contentDisposition } from "./http-range";
import { SubtitleIndexer } from "./subtitle-indexer";
import { SubtitleIndex } from "../media/subtitles";
import { openMemoryMediaDb } from "../media/db";

const tracks: MediaTracks = {
    videoCodec: "hevc", durationSec: 100,
    audioTracks: [{ codec: "truehd", channels: 8 }, { codec: "eac3", channels: 6 }],
    subtitleTracks: [{ codec: "subrip" }, { codec: "hdmv_pgs_subtitle" }, { codec: "ass" }],
};

describe("remux args (never re-encode video)", () => {
    it("copies video (hvc1), converts TrueHD with the playback E-AC3 policy, keeps text subs as mov_text", () => {
        const a = remuxMp4Args("in.mkv", "out.mp4", 0, tracks);
        expect(a.slice(a.indexOf("-c:v"), a.indexOf("-c:v") + 2)).toEqual(["-c:v", "copy"]);
        expect(a).toContain("hvc1");
        expect(a).not.toContain("libx264");
        expect(a).not.toContain("libx265");
        expect(a.join(" ")).toContain("-map 0:a:0 -c:a eac3 -ac 6");
        expect(a.join(" ")).toContain("-map 0:s:0 -map 0:s:2 -c:s mov_text");
        expect(a.join(" ")).not.toContain("0:s:1");
        expect(a.slice(-3)).toEqual(["-f", "mp4", "out.mp4"]);
    });
    it("copies AAC/AC3/EAC3 audio; out-of-range audio index falls back to track 0; no subs → no -c:s", () => {
        const a = remuxMp4Args("in.mkv", "o.mp4", 1, tracks).join(" ");
        expect(a).toContain("-map 0:a:1 -c:a copy");
        const b = remuxMp4Args("in.mkv", "o.mp4", 9, { ...tracks, videoCodec: "h264", subtitleTracks: [] }).join(" ");
        expect(b).toContain("-map 0:a:0");
        expect(b).not.toContain("-c:s");
        expect(b).not.toContain("hvc1");
    });
    it("parses -progress output", () => {
        expect(parseProgressChunk("frame=1\nout_time_us=12500000\nprogress=continue\n")).toBe(12.5);
        expect(parseProgressChunk("out_time=00:01:02.500000\n")).toBe(62.5);
        expect(parseProgressChunk("bitrate=1\n")).toBeNull();
    });
    it("range + disposition helpers", () => {
        expect(parseRange(undefined, 100)).toBeNull();
        expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
        expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
        expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
        expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
        expect(contentDisposition("Țara mea.mp4")).toBe(`attachment; filename="Tara mea.mp4"; filename*=UTF-8''%C8%9Aara%20mea.mp4`);
        expect(tracksFromMeta({ audioTracks: [{ codec: "aac", channels: 2 }], videoCodec: "h264", durationSec: 5 })).toMatchObject({ videoCodec: "h264", audioTracks: [{ codec: "aac", channels: 2 }], subtitleTracks: [] });
        expect(tracksFromMeta({})).toBeNull();
    });
});

describe("download routes with a mocked runner", () => {
    let server: http.Server | null = null;
    let tmp = "";
    afterEach(async () => {
        server?.closeAllConnections();
        await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
        server = null;
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    async function setup(run: RunRemux, cap = 20 * 1024 ** 3) {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mixai-dl-"));
        const src = path.join(tmp, "Film (2020).mkv");
        fs.writeFileSync(src, Buffer.alloc(1000, 7));
        const ready: string[] = [];
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => { release = r; });
        const cache = new DownloadCache({
            dir: path.join(tmp, "cache"), run, getCapBytes: () => cap, onReady: (j, title) => ready.push(`${j.fileId}:${title}`),
            slot: async (fn) => { await gate; return fn(); },
        });
        const app = express();
        app.use("/video", createDownloadRouter({
            auth: (req, res, next) => { if (req.headers["x-device-token"] === "tok") next(); else res.status(401).json({ error: "Unauthorized" }); },
            cache: () => cache,
            resolve: async (id) => (id === "f1" ? { absPath: src, meta: { parsed: { title: "Film", year: 2020 } } } : null),
            tracks: async () => tracks,
        }));
        server = http.createServer(app);
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/video`;
        return { base, cache, src, ready, release };
    }

    it("original file with Range + auth via header or ?t=", async () => {
        const { base } = await setup(async () => ({ code: 0, stderr: "" }));
        expect((await fetch(`${base}/file/f1`)).status).toBe(401);
        const full = await fetch(`${base}/file/f1?t=tok`);
        expect(full.status).toBe(200);
        expect(full.headers.get("accept-ranges")).toBe("bytes");
        expect(full.headers.get("content-type")).toBe("video/x-matroska");
        expect(full.headers.get("content-disposition")).toContain("Film (2020).mkv");
        expect((await full.arrayBuffer()).byteLength).toBe(1000);
        const part = await fetch(`${base}/file/f1`, { headers: { "x-device-token": "tok", range: "bytes=10-19" } });
        expect(part.status).toBe(206);
        expect(part.headers.get("content-range")).toBe("bytes 10-19/1000");
        expect((await part.arrayBuffer()).byteLength).toBe(10);
        expect((await fetch(`${base}/file/f1`, { headers: { "x-device-token": "tok", range: "bytes=5000-" } })).status).toBe(416);
        expect((await fetch(`${base}/file/nope?t=tok`)).status).toBe(404);
        // container != mp4 → original
        expect((await fetch(`${base}/download/f1?t=tok`)).status).toBe(200);
    });

    it("mp4: 202 while preparing (one job), status, then ranged MP4 + download.ready", async () => {
        const runs: string[][] = [];
        const { base, release, ready } = await setup(async (args, onSec) => {
            runs.push(args);
            onSec(50);
            fs.writeFileSync(args[args.length - 1]!, Buffer.alloc(500, 1));
            return { code: 0, stderr: "" };
        });
        expect((await fetch(`${base}/download/f1/status?t=tok`)).status).toBe(404);
        const a = await fetch(`${base}/download/f1?container=mp4&audio=1&t=tok`);
        expect(a.status).toBe(202);
        expect(a.headers.get("retry-after")).toBe("5");
        const job = await a.json() as { jobId: string; state: string; progress: number };
        expect(job).toMatchObject({ state: "queued", progress: 0 });
        const b = await (await fetch(`${base}/download/f1?container=mp4&audio=1&t=tok`)).json() as { jobId: string };
        expect(b.jobId).toBe(job.jobId);
        release();
        for (let i = 0; i < 50; i++) {
            const st = await (await fetch(`${base}/download/f1/status?audio=1&t=tok`)).json() as { state: string };
            if (st.state === "done") break;
            await new Promise((r) => setTimeout(r, 10));
        }
        expect(runs).toHaveLength(1);
        expect(runs[0]!.join(" ")).toContain("-map 0:a:1 -c:a copy");
        const st = await (await fetch(`${base}/download/f1/status?audio=1&t=tok`)).json();
        expect(st).toMatchObject({ state: "done", progress: 1, sizeBytes: 500 });
        expect(ready).toEqual(["f1:Film (2020)"]);
        const got = await fetch(`${base}/download/f1?container=mp4&audio=1&t=tok`, { headers: { range: "bytes=0-99" } });
        expect(got.status).toBe(206);
        expect(got.headers.get("content-type")).toBe("video/mp4");
        expect(got.headers.get("content-disposition")).toContain('filename="Film (2020).mp4"');
        expect((await got.arrayBuffer()).byteLength).toBe(100);
        // other audio track = separate cache entry
        expect((await fetch(`${base}/download/f1?container=mp4&audio=0&t=tok`)).status).toBe(202);
        expect(((await (await fetch(`${base}/downloads/cache`, { headers: { "x-device-token": "tok" } })).json()) as { files: number }).files).toBeGreaterThanOrEqual(1);
    });

    it("failed remux → status failed with ffmpeg error, retry allowed", async () => {
        let fail = true;
        const { base, release } = await setup(async (args) => {
            if (fail) return { code: 1, stderr: "Could not find tag for codec\n" };
            fs.writeFileSync(args[args.length - 1]!, Buffer.alloc(10));
            return { code: 0, stderr: "" };
        });
        release();
        await fetch(`${base}/download/f1?container=mp4&t=tok`);
        await new Promise((r) => setTimeout(r, 30));
        const st = await (await fetch(`${base}/download/f1/status?t=tok`)).json();
        expect(st).toMatchObject({ state: "failed", error: "Could not find tag for codec" });
        fail = false;
        expect((await fetch(`${base}/download/f1?container=mp4&t=tok`)).status).toBe(202);
        await new Promise((r) => setTimeout(r, 30));
        expect((await fetch(`${base}/download/f1?container=mp4&t=tok`)).status).toBe(200);
    });

    it("LRU eviction keeps the cache under the cap and never deletes the newest file", async () => {
        const { cache } = await setup(async () => ({ code: 0, stderr: "" }), 250);
        const dir = path.join(tmp, "cache");
        const mk = (n: string, size: number, ageMin: number) => {
            const p = path.join(dir, `${n}.mp4`);
            fs.writeFileSync(p, Buffer.alloc(size));
            const t = new Date(Date.now() - ageMin * 60_000);
            fs.utimesSync(p, t, t);
            return p;
        };
        const old = mk("old", 100, 30);
        const mid = mk("mid", 100, 20);
        const fresh = mk("new", 100, 1);
        const removed = cache.evict(new Set([fresh]));
        expect(removed).toEqual([old]);
        expect(fs.existsSync(mid) && fs.existsSync(fresh)).toBe(true);
        expect(cache.usage()).toMatchObject({ bytes: 200, files: 2, capBytes: 250 });
    });
});

describe("subtitle indexer (no ffmpeg outside the slot)", () => {
    it("indexes sidecars inline and queues embedded extraction in the slot only on request", async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mixai-si-"));
        try {
            const video = path.join(tmp, "Show.S01E01.mkv");
            fs.writeFileSync(video, "x");
            fs.writeFileSync(path.join(tmp, "Show.S01E01.srt"), "1\n00:00:01,000 --> 00:00:02,000\nAici e sidecar\n");
            const vtt = path.join(tmp, "0.vtt");
            const db = openMemoryMediaDb();
            const index = new SubtitleIndex(db);
            const slotCalls: string[] = [];
            let extracted = false;
            const indexer = new SubtitleIndexer({
                index,
                resolve: (id) => (id === "f1" ? { absPath: video, meta: { subtitleTracks: [{ codec: "subrip", lang: "ro" }, { codec: "hdmv_pgs_subtitle" }] } } : null),
                slot: async (fn) => { slotCalls.push("slot"); return fn(); },
                extract: async () => { extracted = true; fs.writeFileSync(vtt, "WEBVTT\n\n00:10.000 --> 00:12.000\nTrack intern\n"); },
                cached: () => (extracted ? [{ index: 0, path: vtt, sig: "s1" }] : []),
            });
            expect(indexer.indexCheap("f1")).toEqual({ externalCues: 1, embeddedCues: 0 });
            expect(slotCalls).toEqual([]);
            expect(indexer.request("nope")).toBeNull();
            const job = indexer.request("f1")!;
            expect(job.state === "queued" || job.state === "running" || job.state === "done").toBe(true);
            await new Promise((r) => setTimeout(r, 20));
            expect(slotCalls).toEqual(["slot"]);
            expect(indexer.job("f1")).toMatchObject({ state: "done", embeddedCues: 1 });
            const hits = index.search("intern", { titleOf: () => ({ kind: null, tmdbId: null, season: null, episode: null, title: "x" }) });
            expect(hits[0]).toMatchObject({ source: "embedded", trackIndex: 0, lang: "ro", startSec: 10 });
            // Everything extracted already → no new slot job.
            expect(indexer.request("f1")!.state).toBe("done");
            expect(slotCalls).toEqual(["slot"]);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
