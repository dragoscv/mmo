import { describe, it, expect, beforeEach } from "vitest";
import { openMemoryLiveTvDb } from "./db";
import { LiveTvService, expandCatchupTemplate, zoneOffsetMin } from "./service";
import type { FetchLike } from "./util";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 4, 18, 30); // 20:30 in Bucharest

const xmltvTime = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";

function playlist(withA3 = true): string {
    return [
        '#EXTM3U x-tvg-url="http://epg.test/guide.xml"',
        '#EXTINF:-1 tvg-id="ProTV.ro" tvg-chno="2" group-title="General" catchup="default" catchup-days="2" catchup-source="http://cdn/pro/{utc}-{duration}.m3u8?now={lutc}",Pro TV HD',
        "http://stream.test/pro.m3u8",
        '#EXTINF:-1 tvg-chno="1" group-title="News",Digi 24',
        "http://stream.test/digi.ts",
        ...(withA3 ? ['#EXTINF:-1 group-title="News" catchup="append" catchup-source="?utc={utc}&dur={duration:60}",Antena 3', "http://stream.test/a3.ts"] : []),
    ].join("\n");
}

function guide(): string {
    return `<tv>
      <channel id="ProTV.ro"><display-name>Pro TV</display-name></channel>
      <channel id="digi"><display-name>Digi 24 HD</display-name></channel>
      <programme start="${xmltvTime(NOW - H)}" stop="${xmltvTime(NOW)}" channel="ProTV.ro"><title>Before</title></programme>
      <programme start="${xmltvTime(NOW - 30 * 60_000)}" stop="${xmltvTime(NOW + 30 * 60_000)}" channel="ProTV.ro"><title>Now Show</title></programme>
      <programme start="${xmltvTime(NOW + 30 * 60_000)}" stop="${xmltvTime(NOW + 90 * 60_000)}" channel="ProTV.ro"><title>Next Show</title></programme>
      <programme start="${xmltvTime(NOW - 3 * 24 * H)}" stop="${xmltvTime(NOW - 3 * 24 * H + H)}" channel="ProTV.ro"><title>Too old</title></programme>
      <programme start="${xmltvTime(NOW + 20 * 24 * H)}" stop="${xmltvTime(NOW + 20 * 24 * H + H)}" channel="ProTV.ro"><title>Too far</title></programme>
      <programme start="${xmltvTime(NOW)}" stop="${xmltvTime(NOW + H)}" channel="digi"><title>Digi News</title></programme>
    </tv>`;
}

function makeFetch(state: { withA3: boolean }): FetchLike {
    return async (url) => {
        if (url.includes("list.m3u")) return new Response(playlist(state.withA3));
        if (url.includes("guide.xml")) return new Response(guide());
        return new Response("not found", { status: 404 });
    };
}

describe("LiveTvService", () => {
    let svc: LiveTvService;
    const state = { withA3: true };
    beforeEach(() => {
        state.withA3 = true;
        svc = new LiveTvService({ db: openMemoryLiveTvDb(), fetch: makeFetch(state), now: () => NOW });
    });

    it("refresh imports channels, groups and keeps user state across refreshes", async () => {
        const src = svc.createSource({ kind: "m3u", name: "Home", url: "http://iptv.test/list.m3u" });
        expect(await svc.refreshSource(src.id)).toEqual({ ok: true, channelCount: 3, error: null });
        const list = svc.channels({});
        expect(list.map((c) => c.name)).toEqual(["Digi 24", "Pro TV HD", "Antena 3"]); // by number, then position
        expect(svc.groups()).toEqual([{ name: "General", count: 1 }, { name: "News", count: 2 }]);
        const pro = list.find((c) => c.name === "Pro TV HD")!;
        const digi = list.find((c) => c.name === "Digi 24")!;
        svc.setFavourite("kid", pro.id, true);
        svc.updateChannel(digi.id, { hidden: true, number: "101" });

        state.withA3 = false;
        expect((await svc.refreshSource(src.id)).channelCount).toBe(2);
        const after = svc.channels({ favouritesOf: "kid", includeHidden: true });
        expect(after.map((c) => c.id).sort()).toEqual([pro.id, digi.id].sort()); // stable ids
        expect(after.find((c) => c.id === pro.id)!.favourite).toBe(true);
        expect(after.find((c) => c.id === digi.id)).toMatchObject({ hidden: true, number: "101" });
        expect(svc.channels({}).map((c) => c.id)).toEqual([pro.id]);
        expect(svc.channels({ favouritesOf: "kid", favouritesOnly: true }).map((c) => c.id)).toEqual([pro.id]);
        expect(svc.listSources()[0]).toMatchObject({ channelCount: 2, lastError: null, tunerLimit: 2 });
    });

    it("records refresh errors without leaking credentials", async () => {
        const src = svc.createSource({ kind: "m3u", name: "Bad", url: "http://u:topsecret@iptv.test/missing" });
        const r = await svc.refreshSource(src.id);
        expect(r.ok).toBe(false);
        expect(r.error).toContain("404");
        expect(svc.listSources()[0]!.url).not.toContain("topsecret");
        expect((await svc.testSource(src.id)).ok).toBe(false);
    });

    it("refreshGuide matches by tvg-id and name, prunes and serves windows + now/next", async () => {
        const src = svc.createSource({ kind: "m3u", name: "Home", url: "http://iptv.test/list.m3u" });
        await svc.refreshSource(src.id);
        const g = await svc.refreshGuide();
        expect(g).toMatchObject({ ok: true, programmes: 4, matchedChannels: 2 });
        const pro = svc.channels({}).find((c) => c.name === "Pro TV HD")!;
        const digi = svc.channels({}).find((c) => c.name === "Digi 24")!;
        const win = svc.guide(NOW - 2 * H, NOW + 2 * H);
        expect(win.map((p) => p.title).sort()).toEqual(["Before", "Digi News", "Next Show", "Now Show"]);
        expect(svc.guide(NOW, NOW + 2 * H, [pro.id]).map((p) => p.title)).toEqual(["Now Show", "Next Show"]);
        expect(() => svc.guide(NOW, NOW + 49 * H)).toThrow(/48 h/);
        expect(() => svc.guide(NOW, NOW - 1)).toThrow();
        const nn = svc.nowNext([pro.id, digi.id]);
        expect(nn[0]).toMatchObject({ channelId: pro.id, now: { title: "Now Show" }, next: { title: "Next Show" } });
        expect(nn[1]).toMatchObject({ channelId: digi.id, now: { title: "Digi News" }, next: null });
        expect(svc.listSources()[0]!.guideRefreshedAt).toBe(NOW);
    });

    it("builds catch-up URLs from catchup-source templates", async () => {
        const src = svc.createSource({ kind: "m3u", name: "Home", url: "http://iptv.test/list.m3u" });
        await svc.refreshSource(src.id);
        const by = (n: string) => svc.channels({}).find((c) => c.name === n)!;
        const start = NOW - 2 * H;
        const utc = start / 1000;
        expect(svc.catchupUrlFor(by("Pro TV HD").id, start, 60)).toBe(`http://cdn/pro/${utc}-3600.m3u8?now=${NOW / 1000}`);
        expect(svc.catchupUrlFor(by("Antena 3").id, start, 30)).toBe(`http://stream.test/a3.ts?utc=${utc}&dur=30`);
        expect(() => svc.catchupUrlFor(by("Digi 24").id, start, 30)).toThrow(/no catch-up/);
        expect(() => svc.catchupUrlFor(by("Pro TV HD").id, NOW - 3 * 24 * H, 30)).toThrow(/archive/);
        expect(() => svc.catchupUrlFor(by("Pro TV HD").id, NOW + H, 30)).toThrow(/past/);
    });

    it("expandCatchupTemplate supports ${x}, date parts and offsets", () => {
        const start = Date.UTC(2026, 10, 4, 18, 5, 9);
        const out = expandCatchupTemplate("/a/${start}/{Y}{m}{d}-{H}{M}{S}/{offset}/{utcend}/{unknown}", start, 600, start + 1000 * 100);
        expect(out).toBe(`/a/${start / 1000}/20261104-180509/100/${start / 1000 + 600}/{unknown}`);
    });

    it("xtream sources use max_connections and timeshift URLs in the server timezone", async () => {
        const xfetch: FetchLike = async (url) => {
            const u = new URL(url);
            if (url.includes("xmltv.php")) return new Response("<tv></tv>");
            switch (u.searchParams.get("action")) {
                case null: return Response.json({ user_info: { auth: 1, max_connections: "1" }, server_info: { timezone: "Europe/Bucharest" } });
                case "get_live_categories": return Response.json([{ category_id: "9", category_name: "Sport" }]);
                case "get_live_streams": return Response.json([{ num: 7, name: "Sport 1", stream_id: 55, epg_channel_id: "s1", category_id: "9", tv_archive: 1, tv_archive_duration: 3 }]);
                default: return Response.json([]);
            }
        };
        const x = new LiveTvService({ db: openMemoryLiveTvDb(), fetch: xfetch, now: () => NOW });
        expect(() => x.createSource({ kind: "xtream", name: "X", url: "http://xt.test" })).toThrow(/username and password/);
        const src = x.createSource({ kind: "xtream", name: "X", url: "http://xt.test", username: "bob", password: "pw" });
        expect(src.hasPassword).toBe(true);
        expect(JSON.stringify(src)).not.toContain('"pw"');
        await x.refreshSource(src.id);
        const ch = x.channels({})[0]!;
        expect(ch).toMatchObject({ name: "Sport 1", group: "Sport", number: "7", archiveDays: 3, catchup: true });
        expect(x.streamUrlFor(ch.id)).toBe("http://xt.test/live/bob/pw/55.ts");
        expect(x.tunerLimit(src.id)).toBe(1);
        // 16:30 UTC = 18:30 Bucharest (EET, +2 in November)
        expect(x.catchupUrlFor(ch.id, NOW - 2 * H, 45)).toBe("http://xt.test/timeshift/bob/pw/45/2026-11-04:18-30/55.ts");
        expect(zoneOffsetMin("Europe/Bucharest", NOW)).toBe(120);
        // Update without password keeps it; tunerLimit override wins.
        expect(x.updateSource(src.id, { name: "Renamed", tunerLimit: 4 })).toMatchObject({ name: "Renamed", hasPassword: true, tunerLimit: 4 });
    });

    it("tick refreshes due sources only", async () => {
        let t = NOW;
        const s = new LiveTvService({ db: openMemoryLiveTvDb(), fetch: makeFetch(state), now: () => t });
        s.createSource({ kind: "m3u", name: "A", url: "http://iptv.test/list.m3u", refreshHours: 6 });
        expect(await s.tick()).toBe(1);
        t += H;
        expect(await s.tick()).toBe(0);
        t += 6 * H;
        expect(await s.tick()).toBe(1);
    });
});
