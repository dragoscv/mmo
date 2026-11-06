import { describe, expect, it, vi } from "vitest";

vi.mock("./mmo-provider", () => ({ useMmo: () => ({}) }));
vi.mock("./hero", () => ({ Hero: () => null }));
vi.mock("./row", () => ({ MxRow: () => null, RowSkeleton: () => null }));
vi.mock("./title-card", () => ({ MxTitleCard: () => null }));
vi.mock("./backdrop", () => ({ BackdropProvider: () => null }));

import type { HomeRow, TitleCard } from "@/lib/mmo/media-types";
import { heroCandidates, pickHero } from "./home-screen";

const card = (tmdbId: number, extra: Partial<TitleCard> = {}): TitleCard =>
    ({ kind: "movie", tmdbId, title: `T${tmdbId}`, posterPath: null, backdropPath: `/b${tmdbId}.jpg`, genreIds: [], ...extra }) as TitleCard;
const row = (id: string, items: TitleCard[]): HomeRow => ({ id, title: { en: id, ro: id }, items }) as unknown as HomeRow;

describe("home hero candidates", () => {
    it("skips continue + backdrop-less titles, puts in-library first, dedupes, caps", () => {
        const rows = [
            row("continue", [card(1)]),
            row("top_picks", [card(2), card(3, { backdropPath: null }), card(4, { inLibrary: true }), card(2)]),
            row("new_in_library", [card(5, { inLibrary: true }), ...Array.from({ length: 8 }, (_, i) => card(10 + i))]),
        ];
        const ids = heroCandidates(rows).map((c) => c.tmdbId);
        expect(ids).toEqual([4, 5, 2, 10, 11, 12]);
        expect(pickHero(rows)?.tmdbId).toBe(4);
    });

    it("returns null without candidates", () => {
        expect(pickHero([row("continue", [card(1)])])).toBeNull();
    });
});
