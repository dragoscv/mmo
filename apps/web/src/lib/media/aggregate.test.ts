import { describe, expect, it } from "vitest";
import { mergeRows, mergeTitlesByTmdbId, type ServerResult } from "./aggregate";
import type { HomeRow, TitleCard } from "./types";

const card = (over: Partial<TitleCard> & Pick<TitleCard, "tmdbId">): TitleCard => ({
    kind: "movie",
    title: `T${over.tmdbId}`,
    inLibrary: false,
    ...over,
});

const server = <T,>(serverId: string, data: T): ServerResult<T> => ({ serverId, name: `srv-${serverId}`, data });

describe("mergeTitlesByTmdbId", () => {
    it("dedupes the same tmdbId across servers and unions sources", () => {
        const a = server("A", [card({ tmdbId: 1, inLibrary: true, sources: [{ serverId: "A", serverName: "srv-A", fileId: 10, quality: "1080p" }] })]);
        const b = server("B", [card({ tmdbId: 1, inLibrary: true, sources: [{ serverId: "B", serverName: "srv-B", fileId: 77, quality: "2160p" }] })]);
        const out = mergeTitlesByTmdbId([a, b]);
        expect(out).toHaveLength(1);
        expect(out[0]!.sources.map((s) => s.serverId)).toEqual(["A", "B"]);
        expect(out[0]!.inLibrary).toBe(true);
    });

    it("keeps movie and tv with the same tmdbId apart", () => {
        const out = mergeTitlesByTmdbId([server("A", [card({ tmdbId: 5 }), card({ tmdbId: 5, kind: "tv" })])]);
        expect(out).toHaveLength(2);
    });

    it("dedupes identical sources (same server + file) and attributes untagged ones", () => {
        const src = { serverId: "", serverName: "", fileId: 3 };
        const out = mergeTitlesByTmdbId([
            server("A", [card({ tmdbId: 2, sources: [src] })]),
            server("A", [card({ tmdbId: 2, sources: [src] })]),
        ]);
        expect(out[0]!.sources).toEqual([{ serverId: "A", serverName: "srv-A", fileId: 3 }]);
        expect(out[0]!.inLibrary).toBe(true);
    });

    it("keeps the max progress and fills missing artwork from later servers", () => {
        const out = mergeTitlesByTmdbId([
            server("A", [card({ tmdbId: 9, progress: 0.2, poster: null, rating: 7.1 })]),
            server("B", [card({ tmdbId: 9, progress: 0.8, poster: "/p.jpg", rating: 6.9 })]),
            server("C", [card({ tmdbId: 9, progress: null })]),
        ]);
        expect(out[0]!.progress).toBe(0.8);
        expect(out[0]!.poster).toBe("/p.jpg");
        expect(out[0]!.rating).toBe(7.1);
    });

    it("preserves first-seen order and leaves non-library titles without sources", () => {
        const out = mergeTitlesByTmdbId([
            server("A", [card({ tmdbId: 3 }), card({ tmdbId: 1 })]),
            server("B", [card({ tmdbId: 1 }), card({ tmdbId: 2 })]),
        ]);
        expect(out.map((t) => t.tmdbId)).toEqual([3, 1, 2]);
        expect(out.every((t) => t.sources.length === 0 && !t.inLibrary)).toBe(true);
    });
});

describe("mergeRows", () => {
    const row = (id: string, items: TitleCard[], over: Partial<HomeRow> = {}): HomeRow => ({
        id,
        title: { ro: id, en: id },
        kind: "mixed",
        items,
        ...over,
    });

    it("collapses rows with the same id and merges their items by tmdbId", () => {
        const out = mergeRows([
            server("A", [row("continue", [card({ tmdbId: 1, progress: 0.3 })]), row("trending", [card({ tmdbId: 4 })])]),
            server("B", [row("trending", [card({ tmdbId: 4 }), card({ tmdbId: 5 })]), row("continue", [card({ tmdbId: 1, progress: 0.6 })])]),
        ]);
        expect(out.map((r) => r.id)).toEqual(["continue", "trending"]);
        expect(out[0]!.items).toHaveLength(1);
        expect(out[0]!.items[0]!.progress).toBe(0.6);
        expect(out[1]!.items.map((i) => i.tmdbId)).toEqual([4, 5]);
    });

    it("keeps the first non-null reason", () => {
        const out = mergeRows([
            server("A", [row("because", [], { reason: null })]),
            server("B", [row("because", [], { reason: { ro: "pentru că", en: "because" } })]),
        ]);
        expect(out[0]!.reason).toEqual({ ro: "pentru că", en: "because" });
    });

    it("returns an empty list for no servers", () => {
        expect(mergeRows([])).toEqual([]);
    });
});
