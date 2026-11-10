import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import { openMemoryMediaDb } from "./db";
import { TmdbClient, type FetchLike } from "./tmdb";
import { ProviderRegistry } from "./providers";
import { AvailabilityResolver } from "./availability";
import { ProgressStore } from "./progress";
import { ProfileStore } from "./profiles";
import { LibraryIndex } from "./library";
import { createMediaRouter } from "./routes";
import { AgeLookup, type AgeSource } from "./age-lookup";
import { allowedForAge, filterCardsForAge } from "./ratings";
import type { MediaKind, TitleCard } from "./types";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe("allowedForAge", () => {
    it("blocks a title nobody looked up yet, whatever its genres", () => {
        expect(allowedForAge(undefined, 12, [16])).toBe(false);
        expect(allowedForAge(undefined, 12, [10751])).toBe(false);
        expect(allowedForAge(undefined, null, [28])).toBe(true);
    });

    it("lets an unrated title through only for the Family and Kids genres", () => {
        expect(allowedForAge(null, 12, [16])).toBe(false);
        expect(allowedForAge(null, 12, [16, 35])).toBe(false);
        expect(allowedForAge(null, 12, [10751])).toBe(true);
        expect(allowedForAge(null, 12, [16, 10762])).toBe(true);
        expect(allowedForAge(null, 12, [])).toBe(false);
    });

    it("compares a known age with the limit", () => {
        expect(allowedForAge(12, 12, [28])).toBe(true);
        expect(allowedForAge(13, 12, [10751])).toBe(false);
        expect(allowedForAge(0, 0, [])).toBe(true);
    });

    it("filterCardsForAge keeps an explicit unrated card unrated instead of asking the cache again", () => {
        const card = (tmdbId: number, age: number | null | undefined, genreIds: number[]): TitleCard =>
            ({ kind: "movie", tmdbId, title: String(tmdbId), posterPath: null, backdropPath: null, genreIds, ...(age === undefined ? {} : { age }) });
        const cards = [card(1, null, [16]), card(2, undefined, [16]), card(3, 7, [16])];
        // The cache would allow card 1 (age 6); its explicit `age: null` must win.
        const kept = filterCardsForAge(cards, 12, () => 6);
        expect(kept.map((c) => c.tmdbId)).toEqual([2, 3]);
    });
});

describe("AgeLookup", () => {
    interface Fake extends AgeSource {
        calls: { kind: MediaKind; tmdbId: number; force: boolean }[];
        cache: Map<string, { age?: number | null; genreIds: number[] }>;
        gates: Map<number, () => void>;
        maxActive: number;
    }
    const fake = (opts: { configured?: boolean; hold?: boolean; fail?: Set<number> } = {}): Fake => {
        let active = 0;
        const f: Fake = {
            configured: opts.configured ?? true,
            calls: [],
            cache: new Map(),
            gates: new Map(),
            maxActive: 0,
            getCachedTitle: (kind, tmdbId) => f.cache.get(`${kind}:${tmdbId}`) ?? null,
            getTitle: async (kind, tmdbId, o) => {
                f.calls.push({ kind, tmdbId, force: o?.force === true });
                active++;
                f.maxActive = Math.max(f.maxActive, active);
                if (opts.hold) await new Promise<void>((r) => f.gates.set(tmdbId, r));
                else await new Promise<void>((r) => setTimeout(r, 2));
                active--;
                if (opts.fail?.has(tmdbId)) return null;
                const row = { age: tmdbId % 2 === 0 ? tmdbId : null, genreIds: [] };
                f.cache.set(`${kind}:${tmdbId}`, row);
                return row;
            },
        };
        return f;
    };
    const refs = (...ids: number[]) => ids.map((tmdbId) => ({ kind: "movie" as const, tmdbId }));

    it("looks up only titles whose age is unknown, once each, with bounded concurrency", async () => {
        const src = fake();
        src.cache.set("movie:1", { age: 16, genreIds: [] });
        src.cache.set("movie:2", { age: null, genreIds: [] });
        const ages = new AgeLookup(src, { concurrency: 3 });
        await ages.resolve([...refs(1, 2), ...refs(...Array.from({ length: 20 }, (_, i) => 10 + i)), ...refs(10, 11)]);
        expect(src.calls.map((c) => c.tmdbId).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => 10 + i));
        expect(src.maxActive).toBe(3);
        expect(ages.rating("movie", 12)).toEqual({ age: 12, genreIds: [] });
        expect(ages.rating("movie", 13)).toEqual({ age: null, genreIds: [] });
        expect(ages.rating("movie", 999)).toEqual({ age: undefined, genreIds: [] });
        await ages.resolve(refs(10, 11, 12));
        expect(src.calls).toHaveLength(20);
    });

    it("returns when the budget ends, keeps the lookup running and does not start it twice", async () => {
        const src = fake({ hold: true });
        const ages = new AgeLookup(src, { budgetMs: 25 });
        const t0 = Date.now();
        await ages.resolve(refs(7));
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(ages.rating("movie", 7).age).toBeUndefined();
        const second = ages.resolve(refs(7), 2000);
        expect(src.calls).toHaveLength(1);
        src.gates.get(7)!();
        await second;
        expect(ages.rating("movie", 7).age).toBeNull();
    });

    it("serves the newest request before an older backlog, and a request's titles in list order", async () => {
        const src = fake({ hold: true });
        const ages = new AgeLookup(src, { concurrency: 1 });
        await ages.resolve(refs(1, 2, 3, 4, 5), 5);
        expect(src.calls.map((c) => c.tmdbId)).toEqual([1]);
        const search = ages.resolve(refs(9), 2000);
        src.gates.get(1)!();
        await new Promise((r) => setTimeout(r, 10));
        expect(src.calls.map((c) => c.tmdbId)).toEqual([1, 9]);
        src.gates.get(9)!();
        await search;
        expect(ages.rating("movie", 9).age).toBeNull();
        await new Promise((r) => setTimeout(r, 10));
        src.gates.get(2)!();
        await new Promise((r) => setTimeout(r, 10));
        expect(src.calls.map((c) => c.tmdbId)).toEqual([1, 9, 2, 3]);
    });

    it("forces a refetch of a row cached before ratings existed", async () => {
        const src = fake();
        src.cache.set("movie:4", { genreIds: [16] });
        await new AgeLookup(src).resolve(refs(4, 6));
        expect(src.calls).toEqual([{ kind: "movie", tmdbId: 4, force: true }, { kind: "movie", tmdbId: 6, force: false }]);
    });

    it("reads ratings through getCachedRating when the source offers it", async () => {
        const src = fake();
        src.cache.set("movie:4", { age: 12, genreIds: [16] });
        let cheap = 0;
        let full = 0;
        const wrapped: AgeSource = {
            configured: true,
            getCachedTitle: (k, id) => { full++; return src.getCachedTitle(k, id); },
            getCachedRating: (k, id) => { cheap++; const t = src.getCachedTitle(k, id); return t ? { age: t.age, genreIds: t.genreIds } : null; },
            getTitle: src.getTitle,
        };
        const ages = new AgeLookup(wrapped);
        expect(ages.rating("movie", 4)).toEqual({ age: 12, genreIds: [16] });
        await ages.resolve(refs(4, 5));
        expect(src.calls.map((c) => c.tmdbId)).toEqual([5]);
        expect(cheap).toBeGreaterThan(0);
        expect(full).toBe(0);
    });

    it("does not repeat a failed lookup until the retry window passes; no lookups without a TMDB key", async () => {
        let now = 1_000_000;
        const src = fake({ fail: new Set([8]) });
        const ages = new AgeLookup(src, { retryAfterMs: 60_000, now: () => now });
        await ages.resolve(refs(8));
        await ages.resolve(refs(8));
        expect(src.calls).toHaveLength(1);
        now += 60_001;
        await ages.resolve(refs(8));
        expect(src.calls).toHaveLength(2);

        const off = fake({ configured: false });
        await new AgeLookup(off).resolve(refs(1, 2, 3));
        expect(off.calls).toHaveLength(0);
    });
});

// ── routes against a fake TMDB ────────────────────────────────────────────

interface FakeTitle { id: number; title: string; genres: number[]; cert?: string; recs?: number[]; broken?: boolean }
const TITLES: FakeTitle[] = [
    { id: 101, title: "Adult Cartoon", genres: [16, 35], cert: "R" },
    { id: 102, title: "Kids Film", genres: [16, 10751], cert: "G", recs: [101, 104, 105, 107] },
    { id: 103, title: "Unrated Animation", genres: [16] },
    { id: 104, title: "Unrated Family", genres: [10751] },
    { id: 105, title: "Teen Action", genres: [28], cert: "PG-13" },
    { id: 106, title: "Lookup Fails", genres: [16, 10751], cert: "G", broken: true },
    // Never in a search result: only the title page (107) or Home (108) can have looked their ages up.
    { id: 107, title: "Unseen Family", genres: [10751], cert: "G" },
    { id: 108, title: "Trending Family", genres: [10751], cert: "G" },
];
const SEARCH_RESULTS = TITLES.filter((t) => t.id <= 106);
const TRENDING_RESULTS = TITLES.filter((t) => t.id !== 107);
const byId = (id: number) => TITLES.find((t) => t.id === id)!;
const listItem = (t: FakeTitle) => ({ id: t.id, media_type: "movie", title: t.title, genre_ids: t.genres });
const details = (t: FakeTitle) => ({
    id: t.id, title: t.title, genres: t.genres.map((id) => ({ id, name: `g${id}` })),
    release_dates: { results: t.cert ? [{ iso_3166_1: "US", release_dates: [{ type: 3, certification: t.cert }] }] : [] },
    recommendations: { results: (t.recs ?? []).map((id) => listItem(byId(id))) },
});

describe("profiles with an age limit: search, library, home, recommendations", () => {
    let server: http.Server;
    let base = "";
    let kidId = "";
    let pinKidId = "";
    let pinKidToken = "";
    let libraryEtag = 0;
    const detailCalls: number[] = [];
    let tmdbClient: TmdbClient;

    beforeAll(async () => {
        const db = openMemoryMediaDb();
        const fetchFn: FetchLike = async (url) => {
            const p = new URL(url).pathname.replace(/^\/3/, "");
            const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
            if (p === "/search/multi") return ok({ page: 1, total_pages: 1, results: SEARCH_RESULTS.map(listItem) });
            if (p === "/trending/movie/week") return ok({ page: 1, total_pages: 1, results: TRENDING_RESULTS.map(listItem) });
            const m = /^\/movie\/(\d+)$/.exec(p);
            if (m) {
                const t = TITLES.find((x) => x.id === Number(m[1]));
                detailCalls.push(Number(m[1]));
                if (!t || t.broken) return { ok: false, status: 500, json: async () => ({}) };
                return ok(details(t));
            }
            return ok({ page: 1, total_pages: 1, results: [] });
        };
        const tmdb = new TmdbClient(db, { apiKey: "k", region: "RO", fetch: fetchFn });
        tmdbClient = tmdb;
        const registry = new ProviderRegistry(db, tmdb);
        const availability = new AvailabilityResolver({ db, tmdb, registry, fetch: fetchFn });
        const progress = new ProgressStore(db);
        const profiles = new ProfileStore(db);
        kidId = profiles.create({ name: "Kid", kind: "kid", maxAge: 12 }).id;
        pinKidId = profiles.create({ name: "Kid PIN", kind: "kid", maxAge: 12, pin: "1357" }).id;
        const unlocked = profiles.unlock(pinKidId, "1357");
        if (!unlocked.ok) throw new Error("unlock failed");
        pinKidToken = unlocked.token;
        const library = new LibraryIndex(db, tmdb);
        const add = (name: string, tmdbId: number | null) =>
            library.upsert({ path: `D:\\Movies\\${name}.mkv`, size: 1, mtime: 1, title: name, year: null, season: null, episode: null, kind: "movie", tmdbId });
        add("Adult Cartoon", 101);
        add("Kids Film", 102);
        add("Unrated Family", 104);
        add("Lookup Fails", 106);
        add("home video", null);
        libraryEtag = library.getEtag();
        const app = express();
        app.use("/media", createMediaRouter({ db, tmdb, registry, availability, progress, profiles, library, region: "RO", log: silent }));
        server = http.createServer(app);
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}/media`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    const j = async (p: string, headers: Record<string, string> = {}) => {
        const res = await fetch(base + p, { headers });
        const text = await res.text();
        return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
    };
    const ids = (cards: unknown) => (cards as { tmdbId: number }[]).map((c) => c.tmdbId).sort((a, b) => a - b);

    it("search without a profile is the unrestricted default profile and costs no title lookups", async () => {
        const r = await j("/search?q=anything");
        expect(r.status).toBe(200);
        expect(ids(r.body.results)).toEqual([101, 102, 103, 104, 105, 106]);
        expect(detailCalls).toEqual([]);
        // An id this server does not know (a web account profile number, a deleted profile) is `default` too.
        const unknown = await j("/search?q=anything&profile=12345");
        expect(ids(unknown.body.results)).toEqual([101, 102, 103, 104, 105, 106]);
        expect(detailCalls).toEqual([]);
    });

    it("search for a profile with an age limit looks the ages up and hides what is above the limit or unknown", async () => {
        const r = await j(`/search?q=anything&profile=${kidId}`);
        expect(r.status).toBe(200);
        // 101 is 17+, 103 unrated animation, 105 is 13+, 106 could not be looked up.
        expect(ids(r.body.results)).toEqual([102, 104]);
        const results = r.body.results as { tmdbId: number; age?: number | null; inLibrary?: boolean }[];
        expect(results.find((c) => c.tmdbId === 102)).toMatchObject({ age: 0, inLibrary: true });
        expect(results.find((c) => c.tmdbId === 104)).toMatchObject({ age: null });
        expect([...detailCalls].sort((a, b) => a - b)).toEqual([101, 102, 103, 104, 105, 106]);

        const again = await j(`/search?q=anything&profile=${kidId}`);
        expect(ids(again.body.results)).toEqual([102, 104]);
        expect(detailCalls).toHaveLength(6);
    });

    it("getCachedRating matches the parsed title for rated, unrated and never-cached titles", () => {
        expect(tmdbClient.getCachedRating("movie", 101)).toEqual({ age: 17, genreIds: [16, 35] });
        expect(tmdbClient.getCachedRating("movie", 103)).toEqual({ age: null, genreIds: [16] });
        expect(tmdbClient.getCachedRating("movie", 999)).toBeNull();
        const full = tmdbClient.getCachedTitle("movie", 101)!;
        expect([full.age, full.genreIds]).toEqual([17, [16, 35]]);
    });

    it("a PIN-protected profile needs its token", async () => {
        expect((await j(`/search?q=anything&profile=${pinKidId}`)).status).toBe(403);
        expect((await j(`/library?profile=${pinKidId}`)).status).toBe(403);
        const ok = await j(`/search?q=anything&profile=${pinKidId}`, { "x-profile-token": pinKidToken });
        expect(ids(ok.body.results)).toEqual([102, 104]);
    });

    it("library: whole index without a profile, filtered and always full for a profile with an age limit", async () => {
        const all = await j("/library");
        expect((all.body.items as unknown[]).length).toBe(5);
        const adult = await j("/library?profile=default");
        expect((adult.body.items as unknown[]).length).toBe(5);
        const adultDelta = await j(`/library?profile=default&since=${libraryEtag}`);
        expect(adultDelta.body).toMatchObject({ full: false, items: [] });

        const kid = await j(`/library?profile=${kidId}`);
        expect(kid.status).toBe(200);
        expect(kid.body).toMatchObject({ full: true, revision: libraryEtag, removed: [] });
        // No unmatched file, nothing above the limit, nothing whose rating could not be looked up.
        expect(ids(kid.body.items)).toEqual([102, 104]);
        const kidDelta = await j(`/library?profile=${kidId}&since=${libraryEtag}`);
        expect(kidDelta.body.full).toBe(true);
        expect(ids(kidDelta.body.items)).toEqual([102, 104]);

        // An older client sends no `profile` but does send the token of its unlocked profile.
        const byToken = await j("/library", { "x-profile-token": pinKidToken });
        expect(ids(byToken.body.items)).toEqual([102, 104]);
    });

    it("title page: restricted titles stay closed and recommendations are looked up and filtered", async () => {
        expect((await j(`/title/movie/101?profile=${kidId}`)).status).toBe(403);
        expect((await j(`/title/movie/103?profile=${kidId}`)).status).toBe(403);
        expect(detailCalls).not.toContain(107);
        const t = await j(`/title/movie/102?profile=${kidId}`);
        expect(t.status).toBe(200);
        expect(ids((t.body.title as { recommendations: unknown }).recommendations)).toEqual([104, 107]);
        expect(detailCalls).toContain(107);
        const adult = await j("/title/movie/102");
        expect(ids((adult.body.title as { recommendations: unknown }).recommendations)).toEqual([101, 104, 105, 107]);
    });

    it("home rows look unseen ages up and carry nothing above the limit", async () => {
        expect(detailCalls).not.toContain(108);
        const kid = await j(`/home?profile=${kidId}`);
        expect(kid.status).toBe(200);
        const shown = new Set((kid.body.rows as { items: { tmdbId: number }[] }[]).flatMap((row) => row.items.map((c) => c.tmdbId)));
        expect([...shown].sort((a, b) => a - b)).toEqual([102, 104, 108]);
        expect(detailCalls).toContain(108);
        const adult = await j("/home");
        const adultShown = new Set((adult.body.rows as { items: { tmdbId: number }[] }[]).flatMap((row) => row.items.map((c) => c.tmdbId)));
        expect(adultShown.has(101)).toBe(true);
    });

    it("a season of a show whose rating cannot be checked stays closed for a restricted profile", async () => {
        const kid = await j(`/title/tv/999/season/1?profile=${kidId}`);
        expect(kid.status).toBe(403);
        expect(kid.body.error).toBe("age_restricted");
        expect((await j("/title/tv/999/season/1")).status).not.toBe(403);
    });
});
