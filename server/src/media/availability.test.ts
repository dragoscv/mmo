import { describe, it, expect, beforeEach } from "vitest";
import { openMemoryMediaDb, type MediaDb } from "./db";
import { TmdbClient, type FetchLike } from "./tmdb";
import { ProviderRegistry } from "./providers";
import { AvailabilityResolver, MOTN_BASE } from "./availability";

type Route = (url: URL) => { status: number; body?: unknown } | undefined;

function mockFetch(route: Route): FetchLike & { calls: string[] } {
    const calls: string[] = [];
    const fn = (async (url: string) => {
        calls.push(url);
        const r = route(new URL(url)) ?? { status: 404, body: { error: "nf" } };
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} };
    }) as FetchLike & { calls: string[] };
    fn.calls = calls;
    return fn;
}

const tmdbTitle = (withProviders: boolean) => ({
    id: 238, title: "The Godfather", genres: [{ id: 80, name: "Crime" }], vote_average: 8.7, vote_count: 20000,
    "watch/providers": withProviders
        ? { results: { RO: { link: "https://www.themoviedb.org/movie/238/watch?locale=RO", flatrate: [{ provider_id: 1899, provider_name: "HBO Max", logo_path: "/hbo.png", display_priority: 3 }], rent: [{ provider_id: 2, provider_name: "Apple TV", logo_path: "/apple.png" }] } } }
        : { results: {} },
});

const motnShow = {
    tmdbId: "movie/238",
    streamingOptions: {
        ro: [
            { service: { id: "netflix", name: "Netflix" }, type: "subscription", link: "https://www.netflix.com/title/60011152" },
            { service: { id: "netflix", name: "Netflix" }, type: "subscription", link: "dup" },
            { service: { id: "apple", name: "Apple TV" }, type: "rent", link: "https://tv.apple.com/ro/movie/x" },
        ],
    },
};

let db: MediaDb;
let now = 1_700_000_000_000;

function setup(opts: { motn: "ok" | "404" | "off"; tmdbProviders: boolean }) {
    const fetch = mockFetch((u) => {
        if (u.origin + u.pathname === `${MOTN_BASE}/shows/movie/238`) {
            expect(u.searchParams.get("country")).toBe("ro");
            return opts.motn === "ok" ? { status: 200, body: motnShow } : { status: 404 };
        }
        if (u.pathname === "/3/movie/238") return { status: 200, body: tmdbTitle(opts.tmdbProviders) };
        return undefined;
    });
    const tmdb = new TmdbClient(db, { apiKey: "v3key", region: "RO", fetch, now: () => now });
    const registry = new ProviderRegistry(db, tmdb);
    const resolver = new AvailabilityResolver({ db, tmdb, registry, motnApiKey: opts.motn === "off" ? undefined : "motn-key", fetch, now: () => now });
    return { fetch, resolver, tmdb };
}

beforeEach(() => { db = openMemoryMediaDb(); now = 1_700_000_000_000; });

describe("availability chain", () => {
    it("MOTN ok → exact links, dedupes service+type, maps to registry ids", async () => {
        const { resolver, fetch } = setup({ motn: "ok", tmdbProviders: true });
        const a = await resolver.getAvailability("movie", 238, "RO");
        expect(a.source).toBe("motn");
        expect(a.attribution).toEqual(["Movie of the Night"]);
        expect(a.offers).toHaveLength(2);
        const nf = a.offers.find((o) => o.providerId === 8)!;
        expect(nf.link).toBe("https://www.netflix.com/title/60011152");
        expect(nf.launch.web).toBe(nf.link);
        expect(nf.launch.android?.package).toBe("com.netflix.ninja");
        expect(nf.launch.android?.uri).toBe(nf.link);
        expect(nf.launch.tizen?.appId).toBe("3201907018807");
        expect(nf.launch.search).toContain("netflix.com/search?q=The%20Godfather");
        expect(a.offers[1]!.type).toBe("rent");
        // MOTN header is X-API-Key on the direct API
        expect(fetch.calls.some((c) => c.startsWith(MOTN_BASE))).toBe(true);
    });

    it("MOTN 404 → TMDB watch/providers with JustWatch attribution and search fallbacks", async () => {
        const { resolver } = setup({ motn: "404", tmdbProviders: true });
        const a = await resolver.getAvailability("movie", 238, "RO");
        expect(a.source).toBe("tmdb");
        expect(a.attribution).toEqual(["JustWatch"]);
        expect(a.offers.map((o) => [o.providerId, o.type])).toEqual([[1899, "subscription"], [2, "rent"]]);
        const hbo = a.offers[0]!;
        expect(hbo.link).toBeUndefined();
        expect(hbo.logo).toBe("/hbo.png");
        expect(hbo.launch.web).toBe(hbo.launch.search);
        expect(hbo.launch.search).toContain("play.max.com/search?q=");
        expect(hbo.launch.android?.package).toBe("com.wbd.stream");
    });

    it("nothing anywhere → none", async () => {
        const { resolver } = setup({ motn: "404", tmdbProviders: false });
        const a = await resolver.getAvailability("movie", 238, "RO");
        expect(a).toMatchObject({ offers: [], source: "none", attribution: [] });
    });

    it("no MOTN key → never calls MOTN", async () => {
        const { resolver, fetch } = setup({ motn: "off", tmdbProviders: true });
        expect(resolver.motnConfigured).toBe(false);
        const a = await resolver.getAvailability("movie", 238, "RO");
        expect(a.source).toBe("tmdb");
        expect(fetch.calls.filter((c) => c.startsWith(MOTN_BASE))).toHaveLength(0);
    });

    it("caches per region: second call makes no network requests, expires after 7 d", async () => {
        const { resolver, fetch } = setup({ motn: "ok", tmdbProviders: true });
        await resolver.getAvailability("movie", 238, "RO");
        const n = fetch.calls.length;
        const again = await resolver.getAvailability("movie", 238, "RO");
        expect(again.source).toBe("motn");
        expect(fetch.calls.length).toBe(n);
        now += 8 * 24 * 3600_000;
        await resolver.getAvailability("movie", 238, "RO");
        expect(fetch.calls.length).toBeGreaterThan(n);
    });
});

describe("TmdbClient", () => {
    it("uses api_key query for v3 keys and Bearer for v4 tokens", async () => {
        const seen: { url: string; headers?: Record<string, string> }[] = [];
        const fetch: FetchLike = async (url, init) => { seen.push({ url, headers: init?.headers }); return { ok: true, status: 200, json: async () => ({ results: [] }) }; };
        await new TmdbClient(db, { apiKey: "abc", fetch }).trending("movie");
        await new TmdbClient(db, { apiKey: "eyJtoken", fetch, language: "en-US" }).trending("movie");
        expect(seen[0]!.url).toContain("api_key=abc");
        expect(seen[0]!.headers?.authorization).toBeUndefined();
        expect(seen[1]!.url).not.toContain("api_key");
        expect(seen[1]!.headers?.authorization).toBe("Bearer eyJtoken");
    });
    it("is a no-op without a key", async () => {
        const fetch = mockFetch(() => ({ status: 200, body: { results: [{ id: 1 }] } }));
        const c = new TmdbClient(db, { fetch });
        expect(c.configured).toBe(false);
        expect((await c.trending("movie")).results).toEqual([]);
        expect(await c.getTitle("movie", 1)).toBeNull();
        expect(fetch.calls).toHaveLength(0);
    });
    it("caches list calls for 6 h and titles for 30 d", async () => {
        const fetch = mockFetch((u) => u.pathname === "/3/movie/5"
            ? { status: 200, body: { id: 5, title: "Five", genres: [{ id: 1, name: "a" }] } }
            : { status: 200, body: { results: [{ id: 9, title: "Nine", media_type: "movie" }] } });
        const c = new TmdbClient(db, { apiKey: "k", fetch, now: () => now });
        await c.trending("movie"); await c.trending("movie");
        expect(fetch.calls).toHaveLength(1);
        now += 7 * 3600_000;
        await c.trending("movie");
        expect(fetch.calls).toHaveLength(2);
        const t = await c.getTitle("movie", 5);
        expect(t?.title).toBe("Five");
        expect(fetch.calls[2]).toContain("append_to_response=credits%2Ckeywords");
        expect(fetch.calls[2]).toContain("include_image_language=ro%2Cen%2Cnull");
        await c.getTitle("movie", 5);
        expect(fetch.calls).toHaveLength(3);
        expect(c.getCachedTitle("movie", 5)?.tmdbId).toBe(5);
    });
});
