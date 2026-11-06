import { afterEach, describe, expect, it, vi } from "vitest";
import { MusicClient } from "./music";

const cfg = { baseUrl: "https://srv.test", token: "tok", userId: "u1" };

function mockFetch(status: number, body: unknown) {
    const f = vi.fn(async () => new Response(status === 404 ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", f);
    return f;
}

afterEach(() => vi.unstubAllGlobals());

describe("MusicClient (WP17-40 routes)", () => {
    it("radio sends the seed + size and returns the tracks", async () => {
        const f = mockFetch(200, { seed: "tr_1", tracks: [{ id: "tr_1" }, { id: "tr_2" }] });
        const r = await new MusicClient(cfg).radio("tr_1", 30);
        expect(r?.map((t) => t.id)).toEqual(["tr_1", "tr_2"]);
        expect(String((f.mock.calls[0] as unknown[])[0])).toBe("https://srv.test/media/music/radio?seed=tr_1&size=30");
    });

    it("tracks pages with offset/limit", async () => {
        const f = mockFetch(200, { total: 3, offset: 2, limit: 1, items: [{ id: "tr_9" }] });
        const r = await new MusicClient(cfg).tracks({ offset: 2, limit: 1 });
        expect(r?.total).toBe(3);
        expect(String((f.mock.calls[0] as unknown[])[0])).toBe("https://srv.test/media/music/tracks?offset=2&limit=1");
    });

    it("playlists returns the list", async () => {
        mockFetch(200, { playlists: [{ id: "pl_1", name: "Party" }] });
        expect((await new MusicClient(cfg).playlists())?.[0]?.name).toBe("Party");
    });

    it("answers null on servers older than 3.10 (404) so the UI can say 'update the server'", async () => {
        mockFetch(404, null);
        const m = new MusicClient(cfg);
        expect(await m.radio("tr_1")).toBeNull();
        expect(await m.tracks()).toBeNull();
        expect(await m.playlists()).toBeNull();
    });
});
