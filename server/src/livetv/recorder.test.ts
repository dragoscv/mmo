import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMemoryLiveTvDb, type LiveTvDb } from "./db";
import { LiveTvService } from "./service";
import { DvrScheduler, recordArgs, remuxArgs, type SpawnFfmpeg } from "./recorder";
import type { FetchLike } from "./util";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 4, 18, 0);
const xt = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";

const PLAYLIST = [
    "#EXTM3U",
    '#EXTINF:-1 tvg-id="news",News One',
    "http://stream.test/news.ts",
    '#EXTINF:-1 tvg-id="movies",Movies',
    "http://stream.test/movies.ts",
    '#EXTINF:-1 tvg-id="kids",Kids',
    "http://stream.test/kids.ts",
].join("\n");

const GUIDE = `<tv>
  <programme start="${xt(NOW + H)}" stop="${xt(NOW + 2 * H)}" channel="news"><title>Evening News</title></programme>
  <programme start="${xt(NOW + 25 * H)}" stop="${xt(NOW + 26 * H)}" channel="news"><title>Evening News</title></programme>
  <programme start="${xt(NOW + H)}" stop="${xt(NOW + 3 * H)}" channel="movies"><title>Big Movie</title><sub-title>Part 1</sub-title></programme>
  <programme start="${xt(NOW + H)}" stop="${xt(NOW + 2 * H)}" channel="kids"><title>Cartoons</title></programme>
</tv>`;

interface Spawned { args: string[]; purpose: string; resolve: (r: { code: number | null; stderr: string }) => void; killed: boolean }

describe("DvrScheduler", () => {
    let db: LiveTvDb;
    let svc: LiveTvService;
    let dvr: DvrScheduler;
    let dir: string;
    let now = NOW;
    let spawned: Spawned[];
    let ids: Record<string, string>;
    let sourceId: string;

    const spawnFfmpeg: SpawnFfmpeg = (args, opts) => {
        let resolve!: Spawned["resolve"];
        const done = new Promise<{ code: number | null; stderr: string }>((r) => { resolve = r; });
        const entry: Spawned = { args, purpose: opts.purpose, resolve, killed: false };
        spawned.push(entry);
        if (opts.purpose === "remux") {
            // Simulate a successful remux: write the output file.
            fs.writeFileSync(args[args.length - 1]!, "mkv");
            resolve({ code: 0, stderr: "" });
        } else {
            const out = args[args.length - 1]!;
            fs.writeFileSync(out, "ts-bytes");
        }
        return { pid: 1, kill: () => { entry.killed = true; resolve({ code: 255, stderr: "killed" }); }, done };
    };

    beforeEach(async () => {
        now = NOW;
        spawned = [];
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "dvr-"));
        db = openMemoryLiveTvDb();
        const fetch: FetchLike = async (url) => new Response(url.includes("guide") ? GUIDE : PLAYLIST);
        svc = new LiveTvService({ db, fetch, now: () => now });
        dvr = new DvrScheduler({ db, service: svc, recordingsDir: dir, spawnFfmpeg, now: () => now });
        sourceId = svc.createSource({ kind: "m3u", name: "S", url: "http://iptv.test/list.m3u", xmltvUrl: "http://iptv.test/guide.xml" }).id;
        await svc.refreshSource(sourceId);
        await svc.refreshGuide();
        ids = Object.fromEntries(svc.channels({}).map((c) => [c.name, c.id]));
    });
    afterEach(() => { dvr.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

    it("ffmpeg args always stream-copy, never re-encode", () => {
        const rec = recordArgs("http://x/1.ts", 90.2, "/tmp/a.ts");
        expect(rec.join(" ")).toContain("-c copy");
        expect(rec).toEqual(expect.arrayContaining(["-map", "0", "-f", "mpegts", "-t", "91"]));
        expect(rec.slice(0, 3)).toEqual(["-hide_banner", "-loglevel", "error"]);
        const rem = remuxArgs("/tmp/a.ts", "/tmp/a.mkv");
        expect(rem.join(" ")).toContain("-c copy");
        for (const a of [rec, rem]) {
            expect(a.join(" ")).not.toMatch(/libx26|-c:v|-vcodec|-crf/);
        }
    });

    it("validates schedule input", () => {
        expect(() => dvr.schedule({ channelId: ids["News One"]!, start: NOW + H, stop: NOW })).toThrow(/stop > start/);
        expect(() => dvr.schedule({ channelId: "nope", start: NOW + H, stop: NOW + 2 * H })).toThrow(/channel not found/);
        expect(() => dvr.schedule({ channelId: ids["News One"]!, start: NOW - 2 * H, stop: NOW - H })).toThrow(/past/);
        expect(() => dvr.schedule({ channelId: ids["News One"]!, start: NOW, stop: NOW + 25 * H })).toThrow(/24 h/);
    });

    it("flags tuner conflicts per source instead of dropping recordings", () => {
        const a = dvr.schedule({ channelId: ids["News One"]!, start: NOW + H, stop: NOW + 2 * H });
        const b = dvr.scheduleProgramme(ids["Movies"]!, NOW + H);
        expect(b.title).toBe("Big Movie - Part 1");
        const c = dvr.scheduleProgramme(ids["Kids"]!, NOW + H);
        const list = dvr.list();
        const by = (id: string) => list.find((r) => r.id === id)!;
        expect(by(a.id).conflict).toBe(false);
        expect(by(b.id).conflict).toBe(false);
        expect(by(c.id).conflict).toBe(true); // default M3U limit = 2
        expect(c.conflict).toBe(true);
        // Raising the limit resolves it.
        svc.updateSource(sourceId, { tunerLimit: 3 });
        expect(dvr.get(c.id)!.conflict).toBe(false);
        // Sequential (non-overlapping) recordings never conflict.
        svc.updateSource(sourceId, { tunerLimit: 1 });
        const d = dvr.schedule({ channelId: ids["News One"]!, start: NOW + 10 * H, stop: NOW + 11 * H });
        const e = dvr.schedule({ channelId: ids["Kids"]!, start: NOW + 11 * H, stop: NOW + 12 * H });
        expect(dvr.get(d.id)!.conflict).toBe(false);
        expect(dvr.get(e.id)!.conflict).toBe(false);
    });

    it("expands series rules against the guide, idempotently, and on guide refresh", async () => {
        const rule = dvr.createRule({ titleMatch: "evening news", paddingBeforeSec: 30, paddingAfterSec: 120, keepLast: 1 });
        expect(rule).toMatchObject({ titleMatch: "evening news", channelId: null, keepLast: 1, enabled: true });
        let recs = dvr.list().filter((r) => r.ruleId === rule.id);
        expect(recs).toHaveLength(2);
        expect(recs.every((r) => r.paddingBeforeSec === 30 && r.paddingAfterSec === 120)).toBe(true);
        expect(dvr.expandRules()).toBe(0);
        await svc.refreshGuide();
        recs = dvr.list().filter((r) => r.ruleId === rule.id);
        expect(recs).toHaveLength(2);
        const channelRule = dvr.createRule({ titleMatch: "cartoons", channelId: ids["Movies"]! });
        expect(dvr.list().filter((r) => r.ruleId === channelRule.id)).toHaveLength(0);
        expect(() => dvr.createRule({ titleMatch: "x" })).toThrow(/titleMatch/);
        dvr.deleteRule(rule.id);
        expect(dvr.list().filter((r) => r.ruleId === rule.id)).toHaveLength(0);
    });

    it("records with stream copy, remuxes to mkv and prunes keep_last", async () => {
        const rule = dvr.createRule({ titleMatch: "Evening News", channelId: ids["News One"]!, paddingBeforeSec: 0, paddingAfterSec: 0, keepLast: 1 });
        now = NOW + H;
        await dvr.tick();
        const rec = spawned.find((s) => s.purpose === "record")!;
        expect(rec.args).toContain("http://stream.test/news.ts");
        expect(rec.args[rec.args.indexOf("-t") + 1]).toBe("3600");
        expect(dvr.list().find((r) => r.status === "recording")).toBeTruthy();
        rec.resolve({ code: 0, stderr: "" });
        await dvr.idle();
        const done = dvr.list().find((r) => r.status === "done")!;
        expect(done.path).toMatch(/Evening News - News One - .*\.mkv$/);
        expect(fs.existsSync(done.path!)).toBe(true);
        expect(fs.existsSync(path.join(dir, ".partial", `${done.id}.ts`))).toBe(false);
        expect(spawned.find((s) => s.purpose === "remux")!.args).toEqual(expect.arrayContaining(["-c", "copy"]));

        // Second airing (next day) → keep_last=1 deletes the first file.
        now = NOW + 25 * H;
        await dvr.tick();
        spawned.filter((s) => s.purpose === "record").at(-1)!.resolve({ code: 0, stderr: "" });
        await dvr.idle();
        const doneNow = dvr.list().filter((r) => r.ruleId === rule.id && r.status === "done");
        expect(doneNow).toHaveLength(1);
        expect(doneNow[0]!.id).not.toBe(done.id);
        expect(fs.existsSync(done.path!)).toBe(false);
    });

    it("fails a recording with empty output, and refuses to exceed the tuner limit at start", async () => {
        svc.updateSource(sourceId, { tunerLimit: 1 });
        const a = dvr.schedule({ channelId: ids["News One"]!, start: NOW + H, stop: NOW + 2 * H });
        const b = dvr.schedule({ channelId: ids["Kids"]!, start: NOW + H, stop: NOW + 2 * H });
        now = NOW + H;
        await dvr.tick();
        expect(dvr.get(a.id)!.status).toBe("recording");
        expect(dvr.get(b.id)).toMatchObject({ status: "failed" });
        expect(dvr.get(b.id)!.error).toMatch(/tuner conflict/);
        const rec = spawned.find((s) => s.purpose === "record")!;
        fs.writeFileSync(rec.args.at(-1)!, "");
        rec.resolve({ code: 1, stderr: "Server returned 403 Forbidden http://stream.test/news.ts" });
        await dvr.idle();
        const failed = dvr.get(a.id)!;
        expect(failed.status).toBe("failed");
        expect(failed.error).toContain("403");
        expect(failed.error).not.toContain("http://stream.test/news.ts");
    });

    it("cancels scheduled and running recordings, deletes finished ones", async () => {
        const a = dvr.schedule({ channelId: ids["News One"]!, start: NOW + H, stop: NOW + 2 * H });
        expect(dvr.remove(a.id)).toEqual({ status: "cancelled", deleted: false });
        const b = dvr.schedule({ channelId: ids["Kids"]!, start: NOW + H, stop: NOW + 2 * H });
        now = NOW + H;
        await dvr.tick();
        expect(dvr.remove(b.id).status).toBe("cancelled");
        await dvr.idle();
        expect(spawned[0]!.killed).toBe(true);
        expect(dvr.get(b.id)!.status).toBe("cancelled");
        expect(dvr.remove(b.id)).toEqual({ status: "cancelled", deleted: true });
        expect(dvr.get(b.id)).toBeNull();
    });

    it("recovers after a restart: in-progress and missed recordings fail with a reason", () => {
        const a = dvr.schedule({ channelId: ids["News One"]!, start: NOW + H, stop: NOW + 2 * H });
        const b = dvr.schedule({ channelId: ids["Kids"]!, start: NOW + 5 * H, stop: NOW + 6 * H });
        const c = dvr.schedule({ channelId: ids["Movies"]!, start: NOW + 10 * H, stop: NOW + 11 * H });
        db.prepare("UPDATE recordings SET status = 'recording' WHERE id = ?").run(a.id);
        now = NOW + 7 * H;
        const fresh = new DvrScheduler({ db, service: svc, recordingsDir: dir, spawnFfmpeg, now: () => now });
        expect(fresh.recover()).toEqual({ interrupted: 1, missed: 1 });
        expect(fresh.get(a.id)).toMatchObject({ status: "failed", error: "server restarted during recording" });
        expect(fresh.get(b.id)!.status).toBe("failed");
        expect(fresh.get(b.id)!.error).toMatch(/missed/);
        expect(fresh.get(c.id)!.status).toBe("scheduled");
    });
});
