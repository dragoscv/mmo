import { describe, it, expect } from "vitest";
import { openMemoryMediaDb } from "./db";
import { TmdbClient, type FetchLike } from "./tmdb";
import { LibraryIndex, makeServerFileId, pickMatch } from "./library";
import { createMediaLibraryHooks, showHintFor } from "./library-hooks";
import type { TitleCard } from "./types";

const file = (p: string, extra: Partial<{ size: number; mtime: number; season: number | null; episode: number | null; title: string; year: number | null }> = {}) => ({
    path: p, size: extra.size ?? 100, mtime: extra.mtime ?? 1_000, title: extra.title ?? "The Godfather", year: extra.year ?? 1972,
    season: extra.season ?? null, episode: extra.episode ?? null,
});

describe("makeServerFileId", () => {
    it("matches the /video fileId scheme (f + base36 of a 32-bit string hash)", () => {
        const id = makeServerFileId("D:\\Movies\\The.Godfather.1972.mkv");
        expect(id).toMatch(/^f[0-9a-z]+$/);
        expect(makeServerFileId("D:\\Movies\\The.Godfather.1972.mkv")).toBe(id);
        expect(makeServerFileId("D:\\Movies\\Other.mkv")).not.toBe(id);
    });
});

describe("LibraryIndex", () => {
    it("upsert bumps the etag only on real changes; unchanged re-upsert is a no-op", () => {
        const db = openMemoryMediaDb();
        const idx = new LibraryIndex(db);
        expect(idx.getEtag()).toBe(0);
        const a = idx.upsert(file("D:\\Movies\\A.mkv"));
        expect(a.kind).toBe("movie");
        expect(a.tmdbId).toBeNull();
        expect(a.rev).toBe(1);
        expect(idx.getEtag()).toBe(1);
        idx.upsert(file("D:\\Movies\\A.mkv"));
        expect(idx.getEtag()).toBe(1);
        idx.upsert(file("D:\\Movies\\A.mkv", { mtime: 2_000 }));
        expect(idx.getEtag()).toBe(2);
        expect(idx.count()).toBe(1);
    });

    it("tv kind is derived from season/episode", () => {
        const db = openMemoryMediaDb();
        const idx = new LibraryIndex(db);
        const r = idx.upsert(file("D:\\TV\\Show\\S01E02.mkv", { season: 1, episode: 2 }));
        expect(r.kind).toBe("tv");
        expect(r.season).toBe(1);
        expect(r.episode).toBe(2);
    });

    it("list(since) returns only the delta plus tombstones; stale/future since → full", () => {
        const db = openMemoryMediaDb();
        const idx = new LibraryIndex(db);
        idx.upsert(file("D:\\Movies\\A.mkv"));
        idx.upsert(file("D:\\Movies\\B.mkv"));
        const full = idx.list();
        expect(full.full).toBe(true);
        expect(full.items).toHaveLength(2);
        expect(full.revision).toBe(2);

        idx.upsert(file("D:\\Movies\\C.mkv"));
        const removed = idx.removePaths(["D:\\Movies\\A.mkv", "D:\\Movies\\nope.mkv"]);
        expect(removed).toEqual([makeServerFileId("D:\\Movies\\A.mkv")]);
        expect(idx.getEtag()).toBe(4);

        const delta = idx.list(2);
        expect(delta.full).toBe(false);
        expect(delta.items.map((i) => i.path)).toEqual(["D:\\Movies\\C.mkv"]);
        expect(delta.removed).toEqual([makeServerFileId("D:\\Movies\\A.mkv")]);
        expect(delta.revision).toBe(4);

        expect(idx.list(4).items).toHaveLength(0);
        expect(idx.list(4).full).toBe(false);
        expect(idx.list(99).full).toBe(true);
        expect(idx.list(0).full).toBe(true);
        // re-adding a removed file clears its tombstone
        idx.upsert(file("D:\\Movies\\A.mkv"));
        expect(idx.list(4).removed).toEqual([]);
    });

    it("pruneUnder drops rows under the root that were not seen; other roots untouched", () => {
        const db = openMemoryMediaDb();
        const idx = new LibraryIndex(db);
        idx.upsert(file("D:\\Movies\\A.mkv"));
        idx.upsert(file("D:\\Movies\\Sub\\B.mkv"));
        idx.upsert(file("E:\\Other\\C.mkv"));
        const gone = idx.pruneUnder("D:\\Movies\\", ["D:\\Movies\\A.mkv"]);
        expect(gone).toEqual([makeServerFileId("D:\\Movies\\Sub\\B.mkv")]);
        expect(idx.list().items.map((i) => i.path).sort()).toEqual(["D:\\Movies\\A.mkv", "E:\\Other\\C.mkv"]);
        expect(idx.pruneUnder("D:\\Movies", ["D:\\Movies\\A.mkv"])).toEqual([]);
    });

    it("matchTitle: no key → null without network; with key → cached search + pickMatch", async () => {
        const db = openMemoryMediaDb();
        let calls = 0;
        const fetch: FetchLike = async () => {
            calls++;
            return {
                ok: true, status: 200,
                json: async () => ({
                    page: 1, total_pages: 1,
                    results: [
                        { id: 1, media_type: "movie", title: "The Godfather Part II", release_date: "1974-12-20", popularity: 80, genre_ids: [] },
                        { id: 238, media_type: "movie", title: "The Godfather", release_date: "1972-03-14", popularity: 90, genre_ids: [] },
                        { id: 9, media_type: "tv", name: "The Godfather", first_air_date: "1972-01-01", popularity: 5, genre_ids: [] },
                    ],
                }),
            };
        };
        const nokey = new LibraryIndex(db, new TmdbClient(db, { fetch }));
        expect(await nokey.matchTitle("The Godfather", 1972, "movie")).toBeNull();
        expect(calls).toBe(0);

        const idx = new LibraryIndex(db, new TmdbClient(db, { fetch, apiKey: "k" }));
        expect(await idx.matchTitle("The Godfather", 1972, "movie")).toBe(238);
        expect(calls).toBe(1);
        expect(await idx.matchTitle("the godfather", 1972, "movie")).toBe(238); // cached (case-insensitive key)
        expect(calls).toBe(1);
        const row = await idx.upsertMatched(file("D:\\Movies\\The.Godfather.1972.mkv"));
        expect(row.tmdbId).toBe(238);
    });
});

describe("pickMatch", () => {
    const card = (p: Partial<TitleCard>): TitleCard => ({ kind: "movie", tmdbId: 0, title: "", posterPath: null, backdropPath: null, genreIds: [], ...p });
    it("prefers exact title + year, respects kind, null when nothing plausible", () => {
        const results = [
            card({ tmdbId: 1, title: "Alien", releaseDate: "1979-05-25", popularity: 50 }),
            card({ tmdbId: 2, title: "Aliens", releaseDate: "1986-07-18", popularity: 60 }),
            card({ tmdbId: 3, kind: "tv", title: "Alien", releaseDate: "2024-01-01", popularity: 100 }),
        ];
        expect(pickMatch(results, "Alien", 1979, "movie")).toBe(1);
        expect(pickMatch(results, "Aliens", 1986, "movie")).toBe(2);
        expect(pickMatch(results, "Alien", null, "tv")).toBe(3);
        expect(pickMatch(results, "Zzz", 2000, "movie")).toBeNull();
        expect(pickMatch([], "Alien", 1979, "movie")).toBeNull();
    });
});

describe("library hooks", () => {
    it("showHintFor walks past season folders", () => {
        expect(showHintFor("D:\\TV\\Breaking Bad\\Season 03\\ep.mkv", ["D:\\TV"])).toBe("Breaking Bad");
        expect(showHintFor("D:\\TV\\flat.mkv", ["D:\\TV"])).toBeNull();
        expect(showHintFor("E:\\elsewhere\\x.mkv", ["D:\\TV"])).toBeNull();
    });

    it("onScanComplete upserts + prunes under the root; onFilesChanged removes", async () => {
        const db = openMemoryMediaDb();
        const idx = new LibraryIndex(db);
        idx.upsert(file("D:\\Movies\\Old.mkv"));
        const hooks = createMediaLibraryHooks(idx, { getRoots: () => ["D:\\Movies"] });
        await hooks.onScanComplete("D:\\Movies", [
            { filepath: "D:\\Movies\\New.mkv", fileSize: 10, mtime: 5.7, parsedTitle: "New", parsedYear: null, parsedSeason: null, parsedEpisode: null },
        ]);
        expect(idx.list().items.map((i) => i.path)).toEqual(["D:\\Movies\\New.mkv"]);
        expect(idx.list().items[0]!.mtime).toBe(6);
        await hooks.onFilesChanged([], ["D:\\Movies\\New.mkv"]);
        expect(idx.count()).toBe(0);
    });
});
