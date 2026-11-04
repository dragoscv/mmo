import { describe, it, expect } from "vitest";
import { XtreamClient, decodeBase64Text, formatTimeshiftStart, normaliseHost } from "./xtream";
import { HdHomeRunClient } from "./hdhomerun";
import { redactUrl } from "./util";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function mockXtream(): { fetch: (url: string) => Promise<Response>; calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        fetch: async (url: string) => {
            calls.push(url);
            const u = new URL(url);
            if (u.searchParams.get("password") !== "s3cr3t!") return Response.json({ user_info: { auth: 0 } });
            switch (u.searchParams.get("action")) {
                case null:
                    return Response.json({
                        user_info: { username: "bob", auth: 1, status: "Active", exp_date: "1893456000", max_connections: "3", active_cons: "0", is_trial: "0" },
                        server_info: { url: "iptv.test", port: "8080", https_port: "8443", server_protocol: "http", timezone: "Europe/Bucharest" },
                    });
                case "get_live_categories":
                    return Response.json([{ category_id: "1", category_name: "RO News" }]);
                case "get_live_streams":
                    return Response.json([
                        { num: 1, name: "Digi 24", stream_id: 101, stream_icon: "http://l/d.png", epg_channel_id: "Digi24.ro", category_id: "1", tv_archive: 1, tv_archive_duration: "5" },
                        { num: 2, name: "No id" },
                    ]);
                case "get_short_epg":
                    return Response.json({ epg_listings: [{ title: b64("Știri"), description: b64("Ediție & detalii"), start_timestamp: "1793800800", stop_timestamp: "1793804400" }] });
                default:
                    return new Response("nope", { status: 500 });
            }
        },
    };
}

describe("XtreamClient", () => {
    it("normalises hosts", () => {
        expect(normaliseHost("iptv.test:8080/")).toBe("http://iptv.test:8080");
        expect(normaliseHost("https://iptv.test/player_api.php?username=a")).toBe("https://iptv.test");
    });

    it("logs in, lists categories/streams and decodes base64 EPG", async () => {
        const m = mockXtream();
        const c = new XtreamClient({ host: "http://iptv.test:8080", username: "bob", password: "s3cr3t!" }, { fetch: m.fetch });
        const { user, server } = await c.login();
        expect(user).toMatchObject({ auth: true, maxConnections: 3, status: "Active" });
        expect(server.timezone).toBe("Europe/Bucharest");
        expect(await c.liveCategories()).toEqual([{ id: "1", name: "RO News" }]);
        const streams = await c.liveStreams();
        expect(streams).toEqual([{
            streamId: 101, num: 1, name: "Digi 24", icon: "http://l/d.png", epgChannelId: "Digi24.ro", categoryId: "1", tvArchive: true, tvArchiveDuration: 5,
        }]);
        const epg = await c.shortEpg(101, 2);
        expect(epg).toEqual([{ title: "Știri", description: "Ediție & detalii", start: 1793800800000, stop: 1793804400000 }]);
        expect(m.calls.at(-1)).toContain("action=get_short_epg&stream_id=101&limit=2");
    });

    it("builds live, timeshift and xmltv URLs", () => {
        const c = new XtreamClient({ host: "http://iptv.test:8080", username: "bob", password: "p/w" });
        expect(c.liveUrl(101)).toBe("http://iptv.test:8080/live/bob/p%2Fw/101.ts");
        expect(c.liveUrl(101, "m3u8")).toBe("http://iptv.test:8080/live/bob/p%2Fw/101.m3u8");
        const start = Date.UTC(2026, 10, 4, 18, 5);
        expect(c.timeshiftUrl(101, start, 60)).toBe("http://iptv.test:8080/timeshift/bob/p%2Fw/60/2026-11-04:18-05/101.ts");
        expect(c.timeshiftUrl(101, start, 60, 120)).toContain("/2026-11-04:20-05/");
        expect(c.xmltvUrl()).toBe("http://iptv.test:8080/xmltv.php?username=bob&password=p%2Fw");
        expect(formatTimeshiftStart(Date.UTC(2026, 0, 2, 3, 4))).toBe("2026-01-02:03-04");
    });

    it("never puts the password in error messages", async () => {
        const c = new XtreamClient({ host: "http://iptv.test", username: "bob", password: "s3cr3t!" }, {
            fetch: async (url) => { throw new Error(`connect ECONNREFUSED ${url}`); },
        });
        const err = await c.login().catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("ECONNREFUSED");
        expect((err as Error).message).not.toContain("s3cr3t");
        const wrong = new XtreamClient({ host: "http://iptv.test", username: "bob", password: "wrong-pass" }, { fetch: mockXtream().fetch });
        const e2 = await wrong.login().catch((e: Error) => e);
        expect((e2 as Error).message).toMatch(/rejected/);
        expect((e2 as Error).message).not.toContain("wrong-pass");
    });

    it("times out after the configured limit", async () => {
        const c = new XtreamClient({ host: "http://iptv.test", username: "u", password: "pw" }, {
            timeoutMs: 30,
            fetch: (_url, init) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
        });
        await expect(c.login()).rejects.toThrow(/timeout/);
    });

    it("decodeBase64Text falls back to raw text", () => {
        expect(decodeBase64Text(b64("Hello"))).toBe("Hello");
        expect(decodeBase64Text("Not base64!")).toBe("Not base64!");
        expect(decodeBase64Text(undefined)).toBe("");
    });

    it("redactUrl masks Xtream path credentials and query secrets", () => {
        expect(redactUrl("http://h/live/bob/pw/1.ts")).toBe("http://h/live/***/***/1.ts");
        expect(redactUrl("http://h/xmltv.php?username=bob&password=pw")).toBe("http://h/xmltv.php?username=bob&password=***");
        expect(redactUrl("http://u:p@h/x")).toBe("http://***@h/x");
    });
});

describe("HdHomeRunClient", () => {
    it("reads discover + lineup and skips DRM channels", async () => {
        const c = new HdHomeRunClient("192.168.1.50", {
            fetch: async (url) => url.endsWith("discover.json")
                ? Response.json({ FriendlyName: "HDHR5", ModelNumber: "HDHR5-4K", DeviceID: "ABC", TunerCount: 4, LineupURL: "http://192.168.1.50/lineup.json" })
                : Response.json([
                    { GuideNumber: "5.1", GuideName: "TVR1", URL: "http://192.168.1.50:5004/auto/v5.1", HD: 1 },
                    { GuideNumber: "6.1", GuideName: "Paid", URL: "http://x", Tags: "favorite,drm" },
                    { GuideNumber: "7.1", GuideName: "Paid2", URL: "http://y", DRM: 1 },
                ]),
        });
        const dev = await c.discover();
        expect(dev).toMatchObject({ friendlyName: "HDHR5", tunerCount: 4, lineupUrl: "http://192.168.1.50/lineup.json" });
        expect(await c.lineup(dev.lineupUrl)).toEqual([{ guideNumber: "5.1", guideName: "TVR1", url: "http://192.168.1.50:5004/auto/v5.1", hd: true, favorite: false }]);
    });
});
