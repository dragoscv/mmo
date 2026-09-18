import { describe, expect, it } from "vitest";
import type { ServerResult } from "./aggregate";
import { normalizeCard, normalizeRows, pickTrailerKey, progressFraction, tmdbImg, type WireTitleResponse } from "./normalize";
import { groupSourcesByServer, isPreferredOffer, mergeTitleResponses, offerHref, orderOffersByPreference } from "./title";
import { buildServerChips, filterRowsByServers, pickHeroCandidates } from "./home";
import type { HomeRow, MediaServer } from "./types";

const srv = <T,>(id: string, data: T): ServerResult<T> => ({ serverId: id, name: `srv-${id}`, data });

const wireTitle = (over: Partial<WireTitleResponse> = {}): WireTitleResponse => ({
    title: {
        kind: "movie", tmdbId: 550, title: "Fight Club", releaseDate: "1999-10-15", voteAverage: 8.4,
        posterPath: "/p.jpg", backdropPath: "/b.jpg", genres: [{ id: 18, name: "Drama" }],
        videos: [{ key: "teaser1", site: "YouTube", type: "Teaser", name: "t" }, { key: "tr1", site: "YouTube", type: "Trailer", name: "tr" }],
        cast: [{ id: 1, name: "Brad", role: "Tyler", profilePath: null }],
    },
    availability: { offers: [], source: "none", attribution: [] },
    files: [],
    progress: [],
    ...over,
});

describe("normalize", () => {
    it("maps wire cards to TitleCard (year from releaseDate, rating from voteAverage)", () => {
        const c = normalizeCard({ kind: "tv", tmdbId: 1, title: "X", releaseDate: "2020-02-02", voteAverage: 7.25, posterPath: "/x.jpg", genreIds: [1] });
        expect(c).toMatchObject({ kind: "tv", tmdbId: 1, year: 2020, rating: 7.25, poster: "/x.jpg", inLibrary: false, sources: [] });
    });
    it("normalizes rows and string reasons", () => {
        const rows = normalizeRows({ rows: [{ id: "r", title: { ro: "A", en: "B" }, kind: "mixed", items: [], reason: "why" }] });
        expect(rows[0]!.reason).toEqual({ ro: "why", en: "why" });
    });
    it("prefers a YouTube Trailer over a Teaser", () => {
        expect(pickTrailerKey(wireTitle().title.videos)).toBe("tr1");
    });
    it("tmdbImg builds sized URLs and passes absolute ones through", () => {
        expect(tmdbImg("/a.jpg", "w500")).toBe("https://image.tmdb.org/t/p/w500/a.jpg");
        expect(tmdbImg("https://x/y.png", "w92")).toBe("https://x/y.png");
        expect(tmdbImg(null, "w92")).toBeNull();
    });
    it("progressFraction takes the best entry and treats completed as 1", () => {
        expect(progressFraction([{ positionSec: 30, durationSec: 100, completed: false }, { positionSec: 0, durationSec: 0, completed: true }])).toBe(1);
        expect(progressFraction({ positionSec: 25, durationSec: 100, completed: false })).toBe(0.25);
        expect(progressFraction(null)).toBeNull();
    });
});

describe("mergeTitleResponses", () => {
    it("returns null with no results", () => {
        expect(mergeTitleResponses([])).toBeNull();
    });
    it("unions files across servers and keeps availability from the first server with data", () => {
        const a = srv("A", wireTitle({ files: [{ serverFileId: "f1", path: "/m/a.mkv", quality: "1080p" }] }));
        const b = srv("B", wireTitle({
            files: [{ serverFileId: "f9", path: "/nas/a.mkv", quality: "2160p" }],
            availability: { offers: [{ providerId: 8, name: "Netflix", type: "subscription", launch: { web: "https://netflix.com", search: "https://netflix.com/search?q=Fight" } }], source: "tmdb", attribution: ["JustWatch"] },
            progress: [{ positionSec: 50, durationSec: 100, completed: false }],
        }));
        const m = mergeTitleResponses([a, b], [{ serverId: "C", name: "srv-C", error: "timeout" }])!;
        expect(m.title.title).toBe("Fight Club");
        expect(m.title.year).toBe(1999);
        expect(m.title.trailerKey).toBe("tr1");
        expect(m.title.genres).toEqual(["Drama"]);
        expect(m.sources.map((s) => `${s.serverId}:${s.fileId}`)).toEqual(["A:f1", "B:f9"]);
        expect(m.availability.source).toBe("tmdb");
        expect(m.availability.offers[0]!.providerId).toBe("8");
        expect(m.progress).toBe(0.5);
        expect(m.errors).toHaveLength(1);
    });
    it("groups sources by server", () => {
        const g = groupSourcesByServer([
            { serverId: "A", serverName: "a", fileId: "1" }, { serverId: "B", serverName: "b", fileId: "2" }, { serverId: "A", serverName: "a", fileId: "3" },
        ]);
        expect(g.map((x) => [x.serverId, x.files.length])).toEqual([["A", 2], ["B", 1]]);
    });
    it("offerHref prefers deep link, then web, then search", () => {
        expect(offerHref({ link: "https://deep", launch: { web: "https://web", search: "https://s" } })).toBe("https://deep");
        expect(offerHref({ link: null, launch: { web: "https://web", search: "https://s" } })).toBe("https://web");
        expect(offerHref({ launch: { web: "", search: "https://s" } })).toBe("https://s");
    });
});

describe("home helpers", () => {
    const servers: MediaServer[] = [
        { id: "A", name: "Desk", online: true, apiUrl: "http://a", lastSeenAt: new Date(0) },
        { id: "B", name: "NAS", online: false, apiUrl: "http://b", lastSeenAt: null },
    ];
    const rows: HomeRow[] = [
        {
            id: "continue", title: { ro: "C", en: "C" }, kind: "mixed", items: [
                { kind: "movie", tmdbId: 1, title: "One", inLibrary: true, backdrop: "/1.jpg", rating: 5, sources: [{ serverId: "A", serverName: "Desk" }] },
                { kind: "movie", tmdbId: 2, title: "Two", inLibrary: true, backdrop: "/2.jpg", logo: "/l.png", rating: 9, sources: [{ serverId: "A", serverName: "Desk" }, { serverId: "B", serverName: "NAS" }] },
            ],
        },
        {
            id: "top_picks", title: { ro: "T", en: "T" }, kind: "mixed", items: [
                { kind: "tv", tmdbId: 3, title: "Ext", inLibrary: false, backdrop: "/3.jpg", rating: 8 },
                { kind: "movie", tmdbId: 2, title: "Two", inLibrary: true, sources: [{ serverId: "B", serverName: "NAS" }] },
            ],
        },
    ];
    it("counts distinct titles per server", () => {
        expect(buildServerChips(servers, rows).map((c) => [c.id, c.count])).toEqual([["A", 2], ["B", 1]]);
    });
    it("filters rows to the selected servers and drops external items + empty rows", () => {
        const out = filterRowsByServers(rows, ["B"]);
        expect(out.map((r) => [r.id, r.items.map((i) => i.tmdbId)])).toEqual([["continue", [2]], ["top_picks", [2]]]);
        expect(filterRowsByServers(rows, ["Z"])).toEqual([]);
        expect(filterRowsByServers(rows, [])).toBe(rows);
    });
    it("picks hero candidates with backdrops, logo first then rating, deduped", () => {
        const hero = pickHeroCandidates(rows, 5);
        expect(hero.map((h) => h.tmdbId)).toEqual([2, 3, 1]);
    });
});

describe("preferred providers", () => {
    const offers = [{ providerId: "337" }, { providerId: "8" }, { providerId: "119" }, { providerId: "abc" }];
    it("flags preferred offers by numeric TMDB id", () => {
        expect(isPreferredOffer({ providerId: "8" }, [119, 8])).toBe(true);
        expect(isPreferredOffer({ providerId: "337" }, [119, 8])).toBe(false);
        expect(isPreferredOffer({ providerId: "abc" }, [119, 8])).toBe(false);
    });
    it("orders preferred first in ranking order, rest stable", () => {
        expect(orderOffersByPreference(offers, [119, 8]).map((o) => o.providerId)).toEqual(["119", "8", "337", "abc"]);
        expect(orderOffersByPreference(offers, [])).toBe(offers);
    });
});
