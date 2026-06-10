import { describe, it, expect } from "vitest";
import {
    extractFiltersFromParams,
    filtersToQueryString,
    hasMeaningfulFilters,
    savedSearchInputSchema,
    SAVED_SEARCH_KEYS,
} from "./saved-searches";

describe("saved-searches", () => {
    it("extracts only known keys with non-empty string values", () => {
        const out = extractFiltersFromParams({
            genre: "tech-house",
            minBpm: "124",
            maxBpm: "",
            page: "2", // unknown key, should drop
            mood: undefined,
        });
        expect(out).toEqual({ genre: "tech-house", minBpm: "124" });
    });

    it("round-trips filters through query string", () => {
        const filters = { genre: "techno", minBpm: "128", key: "8A" } as const;
        const qs = filtersToQueryString(filters);
        expect(qs).toBe("?genre=techno&minBpm=128&key=8A");
    });

    it("returns empty string when no filters", () => {
        expect(filtersToQueryString({})).toBe("");
    });

    it("hasMeaningfulFilters ignores sort/order", () => {
        expect(hasMeaningfulFilters({ sort: "addedAt", order: "desc" })).toBe(false);
        expect(hasMeaningfulFilters({ genre: "techno" })).toBe(true);
    });

    it("rejects names that are too long", () => {
        const huge = "a".repeat(61);
        expect(() => savedSearchInputSchema.parse({ name: huge, filters: {} })).toThrow();
    });

    it("accepts a minimal valid payload", () => {
        const parsed = savedSearchInputSchema.parse({
            name: "Warmup",
            filters: { genre: "tech-house", minBpm: "122", maxBpm: "126" },
        });
        expect(parsed.name).toBe("Warmup");
        expect(parsed.filters.minBpm).toBe("122");
    });

    it("SAVED_SEARCH_KEYS includes the canonical library filter keys", () => {
        for (const k of ["search", "genre", "minBpm", "maxBpm", "key", "rating", "tag"] as const) {
            expect(SAVED_SEARCH_KEYS).toContain(k);
        }
    });

    it("strips empty strings during extract but keeps long valid ones", () => {
        const out = extractFiltersFromParams({
            search: "",
            artist: "Charlotte de Witte",
            label: "",
            year: "2024",
        });
        expect(out).toEqual({ artist: "Charlotte de Witte", year: "2024" });
    });
});
