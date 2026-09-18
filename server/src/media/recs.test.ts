import { describe, it, expect } from "vitest";
import {
    buildProfile, cosine, decay, diversify, excludeSeen, rrfMerge, scoreCandidates, watchWeight, weightedRating,
    historyHash, HALF_LIFE_MS,
} from "./recs";
import type { HistoryEntry, TitleCard, TitleDetails } from "./types";

const card = (id: number, genreIds: number[] = [], extra: Partial<TitleCard> = {}): TitleCard => ({
    kind: "movie", tmdbId: id, title: `T${id}`, posterPath: null, backdropPath: null, genreIds, ...extra,
});

const details = (id: number, genreIds: number[], keywords: number[] = [], cast: number[] = [], collectionId: number | null = null): TitleDetails => ({
    ...card(id, genreIds),
    genres: [], keywords: keywords.map((k) => ({ id: k, name: `k${k}` })),
    cast: cast.map((c) => ({ id: c, name: `c${c}`, role: "", profilePath: null })),
    crew: [], externalIds: {}, videos: [], logoPath: null, recommendations: [], similar: [], watchProviders: {}, collectionId,
});

const NOW = 1_700_000_000_000;

describe("decay / weights", () => {
    it("halves at one half-life", () => {
        expect(decay(0)).toBe(1);
        expect(decay(HALF_LIFE_MS)).toBeCloseTo(0.5, 6);
        expect(decay(2 * HALF_LIFE_MS)).toBeCloseTo(0.25, 6);
    });
    it("completion and rating drive the watch weight; dismissed is negative", () => {
        expect(watchWeight({ kind: "movie", tmdbId: 1, watchedAt: 0, completion: 1 })).toBe(1);
        expect(watchWeight({ kind: "movie", tmdbId: 1, watchedAt: 0, completion: 0 })).toBeCloseTo(0.2);
        expect(watchWeight({ kind: "movie", tmdbId: 1, watchedAt: 0, completion: 1, rating: 10 })).toBeCloseTo(1.6);
        expect(watchWeight({ kind: "movie", tmdbId: 1, watchedAt: 0, completion: 1, dismissed: true })).toBeLessThan(0);
    });
});

describe("buildProfile", () => {
    const lib = new Map<number, TitleDetails>([
        [1, details(1, [28, 12], [100], [7])],
        [2, details(2, [18], [200], [8])],
    ]);
    const lookup = (_k: string, id: number) => lib.get(id) ?? null;

    it("is empty for empty history (cold start)", () => {
        const p = buildProfile([], lookup, NOW);
        expect(p.mass).toBe(0);
        expect(p.features.size).toBe(0);
    });
    it("weights recent complete watches more than old partial ones", () => {
        const history: HistoryEntry[] = [
            { kind: "movie", tmdbId: 1, watchedAt: NOW, completion: 1 },
            { kind: "movie", tmdbId: 2, watchedAt: NOW - 4 * HALF_LIFE_MS, completion: 0.3 },
        ];
        const p = buildProfile(history, lookup, NOW);
        expect(p.features.get("g:28")!).toBeGreaterThan(p.features.get("g:18")!);
        expect(p.features.has("k:100")).toBe(true);
        expect(p.features.has("c:7")).toBe(true);
        expect(p.mass).toBeGreaterThan(1);
    });
    it("is deterministic", () => {
        const history: HistoryEntry[] = [{ kind: "movie", tmdbId: 1, watchedAt: NOW - 1000, completion: 0.8 }];
        const a = buildProfile(history, lookup, NOW);
        const b = buildProfile(history, lookup, NOW);
        expect([...a.features.entries()]).toEqual([...b.features.entries()]);
    });
});

describe("scoring", () => {
    it("cosine is 1 for identical single feature, 0 for disjoint", () => {
        const p = new Map([["g:1", 1]]);
        expect(cosine(p, ["g:1"])).toBeCloseTo(1);
        expect(cosine(p, ["g:2"])).toBe(0);
    });
    it("weightedRating shrinks towards the prior with few votes", () => {
        expect(weightedRating(0, 10, 500, 6.5)).toBe(6.5);
        expect(weightedRating(1_000_000, 8, 500, 6.5)).toBeCloseTo(8, 2);
        const few = weightedRating(10, 10, 500, 6.5);
        expect(few).toBeGreaterThan(6.5);
        expect(few).toBeLessThan(7);
    });
    it("ranks profile-similar candidates first, ties broken by id", () => {
        const profile = buildProfile([{ kind: "movie", tmdbId: 1, watchedAt: NOW, completion: 1 }], () => details(1, [28]), NOW);
        const cands = [card(30, [18], { voteAverage: 7, voteCount: 1000 }), card(20, [28], { voteAverage: 7, voteCount: 1000 }), card(10, [99])];
        const out = scoreCandidates(profile, cands).map((s) => s.card.tmdbId);
        expect(out[0]).toBe(20);
        expect(out.indexOf(30)).toBeLessThan(out.indexOf(10));
    });
});

describe("rrfMerge", () => {
    it("promotes items present in several lists and keeps stable order", () => {
        const a = [card(1), card(2), card(3)];
        const b = [card(3), card(4)];
        const out = rrfMerge([a, b]).map((c) => c.tmdbId);
        expect(out[0]).toBe(3);
        expect(out).toEqual([3, 1, 2, 4]);
    });
    it("dedupes across kinds separately", () => {
        const out = rrfMerge([[card(1)], [{ ...card(1), kind: "tv" }]]);
        expect(out).toHaveLength(2);
    });
});

describe("diversify / exclude", () => {
    it("limits items per collection", () => {
        const items = [card(1), card(2), card(3), card(4)];
        const col = (c: TitleCard) => (c.tmdbId <= 3 ? 77 : null);
        expect(diversify(items, 2, col).map((c) => c.tmdbId)).toEqual([1, 2, 4]);
    });
    it("excludes completed and dismissed history, keeps partially watched", () => {
        const items = [card(1), card(2), card(3)];
        const history: HistoryEntry[] = [
            { kind: "movie", tmdbId: 1, watchedAt: 0, completion: 0.95 },
            { kind: "movie", tmdbId: 2, watchedAt: 0, completion: 0.1, dismissed: true },
            { kind: "movie", tmdbId: 3, watchedAt: 0, completion: 0.4 },
        ];
        expect(excludeSeen(items, history).map((c) => c.tmdbId)).toEqual([3]);
        expect(excludeSeen(items, [], ["movie:3"]).map((c) => c.tmdbId)).toEqual([1, 2]);
    });
    it("historyHash is order-independent", () => {
        const h1: HistoryEntry[] = [{ kind: "movie", tmdbId: 1, watchedAt: 0, completion: 1 }, { kind: "tv", tmdbId: 2, watchedAt: 0, completion: 0.5 }];
        const h2 = [...h1].reverse();
        expect(historyHash(h1)).toBe(historyHash(h2));
        expect(historyHash(h1, ["a"])).not.toBe(historyHash(h1, ["b"]));
    });
});
