import { describe, it, expect, vi } from "vitest";
import { openMemoryMediaDb, getMeta } from "./db";
import { ProgressStore } from "./progress";
import { MediaSyncClient, type FetchLike, type SyncPushBody } from "./sync-client";

function setup(responses: Array<{ status: number } | Error>, opts: { token?: string; url?: string } = {}) {
    const db = openMemoryMediaDb();
    const progress = new ProgressStore(db, () => 1_000);
    const calls: { url: string; headers: Record<string, string>; body: SyncPushBody }[] = [];
    const fetch: FetchLike = vi.fn(async (url, init) => {
        calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as SyncPushBody });
        const next = responses.shift() ?? { status: 200 };
        if (next instanceof Error) throw next;
        return { ok: next.status >= 200 && next.status < 300, status: next.status };
    });
    const warn = vi.fn();
    const client = new MediaSyncClient({
        db, progress, fetch, debounceMs: 20, fullIntervalMs: 60_000,
        getWebAppUrl: () => opts.url ?? "https://mixai.ro/",
        getDeviceToken: () => opts.token ?? "tok",
        getDeviceId: () => "dev-1",
        log: { debug() {}, info() {}, warn, error() {} },
    });
    return { db, progress, client, calls, fetch, warn };
}

describe("MediaSyncClient", () => {
    it("pushes only rows after the watermark, with Bearer auth, and advances last_pushed_revision on 200", async () => {
        const { db, progress, client, calls } = setup([{ status: 200 }, { status: 200 }]);
        progress.putProgress({ profileId: "p", kind: "movie", tmdbId: 1, positionSec: 10, durationSec: 100 });
        progress.recordPlay("p", "t:1", 60, true);
        const r1 = await client.push();
        expect(r1).toMatchObject({ ok: true, status: 200, pushed: 2, revision: 2 });
        expect(calls[0]!.url).toBe("https://mixai.ro/api/media/sync");
        expect(calls[0]!.headers.authorization).toBe("Bearer tok");
        expect(calls[0]!.body).toMatchObject({ deviceId: "dev-1", revision: 2, since: 0, full: false });
        expect(calls[0]!.body.progress).toHaveLength(1);
        expect(calls[0]!.body.plays).toHaveLength(1);
        expect(getMeta(db, "last_pushed_revision")).toBe("2");

        // nothing new → skipped without a request
        expect((await client.push()).status).toBe("skipped");
        expect(calls).toHaveLength(1);

        progress.putProgress({ profileId: "p", kind: "movie", tmdbId: 1, positionSec: 50, durationSec: 100 });
        const r2 = await client.push();
        expect(r2.pushed).toBe(1);
        expect(calls[1]!.body.since).toBe(2);
        expect(calls[1]!.body.progress[0]!.positionSec).toBe(50);
        expect(calls[1]!.body.plays).toHaveLength(0);
        expect(getMeta(db, "last_pushed_revision")).toBe("3");
    });

    it("404 (endpoint not deployed) keeps the watermark and retries next time", async () => {
        const { db, progress, client, calls, warn } = setup([{ status: 404 }, { status: 404 }, { status: 200 }]);
        progress.putProgress({ profileId: "p", kind: "tv", tmdbId: 2, season: 1, episode: 1, positionSec: 5, durationSec: 10 });
        expect(await client.push()).toMatchObject({ ok: false, status: 404, pushed: 0 });
        expect(getMeta(db, "last_pushed_revision")).toBe("0");
        expect(client.consecutiveFailures).toBe(1);
        expect(await client.push()).toMatchObject({ ok: false, status: 404 });
        expect(warn).toHaveBeenCalledTimes(1); // repeated identical error deduped
        expect(await client.push()).toMatchObject({ ok: true, status: 200, pushed: 1 });
        expect(client.consecutiveFailures).toBe(0);
        expect(calls).toHaveLength(3);
        expect(getMeta(db, "last_pushed_revision")).toBe("1");
    });

    it("network error → status offline, watermark untouched, retry succeeds", async () => {
        const { db, progress, client } = setup([new TypeError("fetch failed"), { status: 200 }]);
        progress.recordPlay("p", "t:2", 1, false);
        expect(await client.push()).toMatchObject({ ok: false, status: "offline" });
        expect(getMeta(db, "last_pushed_revision")).toBe("0");
        expect(await client.push()).toMatchObject({ ok: true });
        expect(getMeta(db, "last_pushed_revision")).toBe("1");
    });

    it("401 pauses pushes until the token changes", async () => {
        let token = "old";
        const db = openMemoryMediaDb();
        const progress = new ProgressStore(db, () => 1);
        const statuses = [401, 200];
        const fetch: FetchLike = vi.fn(async () => { const s = statuses.shift()!; return { ok: s < 300, status: s }; });
        const client = new MediaSyncClient({ db, progress, fetch, getWebAppUrl: () => "http://x", getDeviceToken: () => token, getDeviceId: () => "d" });
        progress.recordPlay("p", "t", 1, true);
        expect((await client.push()).status).toBe(401);
        expect((await client.push()).status).toBe("skipped");
        expect(fetch).toHaveBeenCalledTimes(1);
        token = "new";
        expect((await client.push()).status).toBe(200);
    });

    it("skips when webAppUrl/token missing; full push sends since=0 with everything", async () => {
        const nothing = setup([], { token: "" });
        nothing.progress.recordPlay("p", "t", 1, true);
        expect((await nothing.client.push()).status).toBe("skipped");
        expect(nothing.calls).toHaveLength(0);

        const { progress, client, calls } = setup([{ status: 200 }, { status: 200 }]);
        progress.recordPlay("p", "t", 1, true);
        await client.push();
        const r = await client.push({ full: true });
        expect(r.pushed).toBe(1);
        expect(calls[1]!.body).toMatchObject({ full: true, since: 0 });
    });

    it("schedule() debounces many writes into one request", async () => {
        const { progress, client, calls } = setup([{ status: 200 }]);
        for (let i = 0; i < 5; i++) { progress.recordPlay("p", `t:${i}`, 1, true); client.schedule(); }
        expect(calls).toHaveLength(0);
        await new Promise((r) => setTimeout(r, 60));
        expect(calls).toHaveLength(1);
        expect(calls[0]!.body.plays).toHaveLength(5);
        client.stop();
    });
});
