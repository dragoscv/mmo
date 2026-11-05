import { describe, expect, it } from "vitest";
import type { HomeRow, LibraryIndexRow, MediaTitleResponse, ProgressEntry, VersionedFile } from "@/lib/mmo/media-types";
import {
    barScale, bestFile, cleanName, collectionRows, fold, genreList, gridMove, groupLibrary, letterIndex, letterOf,
    matchesQuery, playHref, previewTarget, progressRatio, sortEntries, versionChoices, watchedKeys, type LibEntry,
} from "./lib";

const row = (o: Partial<LibraryIndexRow> & { serverFileId: string; path: string }): LibraryIndexRow => ({
    kind: "movie", tmdbId: null, season: null, episode: null, size: 1, mtime: 1, updatedAt: 1, ...o,
});

const vf = (id: string, rank: number, extra: Partial<VersionedFile> = {}): VersionedFile => ({
    ...row({ serverFileId: id, path: `/m/${id}.mkv` }),
    version: { resolution: null, hdr: null, edition: null, remux: false, label: id, rank },
    ...extra,
});

const prog = (o: Partial<ProgressEntry>): ProgressEntry => ({
    profileId: "p", kind: "movie", tmdbId: 1, season: 0, episode: 0, positionSec: 0, durationSec: 0, completed: false, updatedAt: 0, ...o,
});

describe("text helpers", () => {
    it("folds Romanian diacritics", () => {
        expect(fold("Știință și Țară Îmbătrânită")).toBe("stiinta si tara imbatranita");
    });
    it("cleans release names", () => {
        expect(cleanName("The.Matrix.1999.2160p.UHD.BluRay")).toBe("The Matrix");
        expect(cleanName("Dune_Part_Two (2024) [WEB-DL]")).toBe("Dune Part Two");
    });
    it("matches queries diacritic-insensitively and ignores empty queries", () => {
        expect(matchesQuery("Moromeții", "morome")).toBe(true);
        expect(matchesQuery("Moromeții", "  ")).toBe(false);
    });
});

describe("groupLibrary", () => {
    const rows: LibraryIndexRow[] = [
        row({ serverFileId: "a", tmdbId: 10, path: "/m/Alien.1979.1080p.mkv", mtime: 5 }),
        row({ serverFileId: "b", tmdbId: 10, path: "/m/Alien.1979.2160p.mkv", mtime: 9 }),
        row({ serverFileId: "c", path: "/m/Unknown.Film.720p.mkv", mtime: 3 }),
        row({ serverFileId: "d", kind: "tv", path: "/tv/Show Name/Season 1/s01e01.mkv", season: 1, episode: 1 }),
        row({ serverFileId: "e", kind: "tv", path: "/tv/Show Name/Season 2/s02e01.mkv", season: 2, episode: 1 }),
    ];
    it("groups movie files by tmdbId and keeps the best resolution + newest mtime", () => {
        const g = groupLibrary(rows, "movie");
        expect(g).toHaveLength(2);
        const alien = g.find((e) => e.tmdbId === 10);
        expect(alien?.files).toHaveLength(2);
        expect(alien?.addedAt).toBe(9);
        expect(alien?.res).toBe("4K");
        expect(g.find((e) => e.tmdbId == null)?.guess).toBe("Unknown Film");
    });
    it("groups unmatched episodes by show folder (skipping Season N)", () => {
        const g = groupLibrary(rows, "tv");
        expect(g).toHaveLength(1);
        expect(g[0]?.guess).toBe("Show Name");
        expect(g[0]?.files).toHaveLength(2);
    });
    it("handles 1000+ titles quickly", () => {
        const many = Array.from({ length: 5000 }, (_, i) => row({ serverFileId: `f${i}`, tmdbId: i % 1500, path: `/m/T${i}.mkv`, mtime: i }));
        const t0 = performance.now();
        const g = groupLibrary(many, "movie");
        const sorted = sortEntries(g, "az", (e) => ({ name: e.guess, year: null, rating: null }));
        expect(g).toHaveLength(1500);
        expect(sorted).toHaveLength(1500);
        expect(performance.now() - t0).toBeLessThan(1000);
    });
});

describe("watchedKeys", () => {
    it("marks completed movies and fully watched shows", () => {
        const movie: LibEntry = { key: "movie:1", kind: "movie", tmdbId: 1, files: [], addedAt: 0, guess: "", res: "SD" };
        const show: LibEntry = {
            key: "tv:2", kind: "tv", tmdbId: 2, addedAt: 0, guess: "", res: "SD",
            files: [row({ serverFileId: "x", kind: "tv", path: "x", season: 1, episode: 1 }), row({ serverFileId: "y", kind: "tv", path: "y", season: 1, episode: 2 })],
        };
        const half = watchedKeys([movie, show], [prog({ tmdbId: 1, completed: true }), prog({ kind: "tv", tmdbId: 2, season: 1, episode: 1, completed: true })]);
        expect([...half]).toEqual(["movie:1"]);
        const all = watchedKeys([show], [prog({ kind: "tv", tmdbId: 2, season: 1, episode: 1, completed: true }), prog({ kind: "tv", tmdbId: 2, season: 1, episode: 2, completed: true })]);
        expect(all.has("tv:2")).toBe(true);
    });
});

describe("sortEntries", () => {
    const items = [
        { key: "a", addedAt: 1, name: "Zorro", year: 1998, rating: 6 },
        { key: "b", addedAt: 3, name: " Árvore", year: 2020, rating: null },
        { key: "c", addedAt: 2, name: "Matrix", year: null, rating: 8.7 },
    ];
    const info = (e: (typeof items)[number]) => ({ name: e.name, year: e.year, rating: e.rating });
    it.each([
        ["recent", ["b", "c", "a"]],
        ["az", ["b", "c", "a"]],
        ["year", ["b", "a", "c"]],
        ["rating", ["c", "a", "b"]],
    ] as const)("sorts by %s", (sort, expected) => {
        expect(sortEntries(items, sort, info).map((x) => x.key)).toEqual(expected);
    });
    it("does not mutate the input", () => {
        const before = items.map((x) => x.key);
        sortEntries(items, "az", info);
        expect(items.map((x) => x.key)).toEqual(before);
    });
});

describe("A–Z buckets", () => {
    it("buckets letters, digits and symbols", () => {
        expect(letterOf("Ștefan")).toBe("S");
        expect(letterOf("12 Angry Men")).toBe("#");
        expect(letterOf("  alien")).toBe("A");
    });
    it("indexes the first item of each bucket", () => {
        const idx = letterIndex(["300", "Alien", "Aliens", "Batman", "Ștrumfii"]);
        expect(Object.fromEntries(idx)).toEqual({ "#": 0, A: 1, B: 3, S: 4 });
    });
});

describe("genreList", () => {
    it("orders by frequency, then name", () => {
        const d = (genres: string[]) => ({ title: "", posterPath: null, backdropPath: null, year: null, rating: 0, genres });
        expect(genreList([d(["Drama", "Comedy"]), d(["Drama"]), null, d(["Action"])])).toEqual(["Drama", "Action", "Comedy"]);
    });
});

describe("play targets", () => {
    const base = (o: Partial<MediaTitleResponse>): MediaTitleResponse => ({
        title: {
            kind: "movie", tmdbId: 7, title: "X", posterPath: null, backdropPath: null, genreIds: [], genres: [], logoPath: null,
            recommendations: [], similar: [],
        },
        availability: { offers: [], source: "none", attribution: [] },
        files: [], progress: [], serverId: null, serverName: "s", ...o,
    });
    it("picks the best version unless one is chosen", () => {
        const files = [vf("hd", 2), vf("uhd", 5)];
        expect(bestFile(files)?.serverFileId).toBe("uhd");
        expect(bestFile(files, "hd")?.serverFileId).toBe("hd");
        expect(bestFile(files, "gone")?.serverFileId).toBe("uhd");
        expect(versionChoices(files).map((f) => f.serverFileId)).toEqual(["uhd", "hd"]);
    });
    it("resumes a movie", () => {
        const tg = previewTarget(base({ files: [vf("a", 1)], progress: [prog({ tmdbId: 7, positionSec: 600, durationSec: 1800 })] }));
        expect(tg?.resumeSec).toBe(600);
        expect(tg?.leftMin).toBe(20);
        expect(tg?.season).toBe(0);
    });
    it("plays the first unwatched local episode of a show", () => {
        const ep = (id: string, s: number, e: number) => vf(id, 1, { season: s, episode: e, kind: "tv" });
        const d = base({
            title: { ...base({}).title, kind: "tv" },
            files: [ep("e2", 1, 2), ep("e1", 1, 1), ep("e3", 2, 1)],
            progress: [prog({ kind: "tv", tmdbId: 7, season: 1, episode: 1, completed: true })],
        });
        const tg = previewTarget(d);
        expect([tg?.season, tg?.episode, tg?.file.serverFileId]).toEqual([1, 2, "e2"]);
    });
    it("returns null when nothing is local", () => {
        expect(previewTarget(base({}))).toBeNull();
    });
    it("builds player links", () => {
        expect(playHref("movie", 5)).toBe("/media/play/movie/5");
        expect(playHref("movie", 5, { file: "abc" })).toBe("/media/play/movie/5?file=abc");
        expect(playHref("tv", 9, { season: 2, episode: 3 })).toBe("/media/play/tv/9?s=2&e=3");
    });
    it("computes progress ratios", () => {
        expect(progressRatio(null)).toBeNull();
        expect(progressRatio(prog({ completed: true }))).toBe(1);
        expect(progressRatio(prog({ positionSec: 30, durationSec: 120 }))).toBe(0.25);
        expect(progressRatio(prog({ positionSec: 0, durationSec: 120 }))).toBeNull();
    });
});

describe("misc", () => {
    it("scales bars to the max", () => {
        expect(barScale([0, 5, 10])).toEqual([0, 0.5, 1]);
        expect(barScale([0, 0])).toEqual([0, 0]);
    });
    it("keeps only non-empty collection rows", () => {
        const r = (id: string, n: number): HomeRow => ({ id, title: { ro: id, en: id }, kind: "movie", items: Array.from({ length: n }, () => ({ kind: "movie", tmdbId: 1, title: "", posterPath: null, backdropPath: null, genreIds: [] })) });
        expect(collectionRows([r("continue", 2), r("collection:1", 3), r("collection:2", 0)]).map((x) => x.id)).toEqual(["collection:1"]);
    });
    it("moves in a grid", () => {
        // 10 items, 4 columns
        expect(gridMove(0, "ArrowRight", 4, 10)).toBe(1);
        expect(gridMove(0, "ArrowLeft", 4, 10)).toBeNull();
        expect(gridMove(1, "ArrowDown", 4, 10)).toBe(5);
        expect(gridMove(7, "ArrowDown", 4, 10)).toBe(9); // last row shorter → last item
        expect(gridMove(9, "ArrowDown", 4, 10)).toBeNull();
        expect(gridMove(5, "ArrowUp", 4, 10)).toBe(1);
        expect(gridMove(5, "Home", 4, 10)).toBe(0);
        expect(gridMove(5, "End", 4, 10)).toBe(9);
        expect(gridMove(5, "Enter", 4, 10)).toBeNull();
    });
});
