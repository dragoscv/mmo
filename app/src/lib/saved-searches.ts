/**
 * Saved-search ("smart crate") domain types and Zod validation.
 *
 * The filter shape mirrors the /library page's URL search params 1:1
 * — both consume the same keys, both produce the same keys. That's
 * why a saved search is just `{name, filters: LibraryParams}`: there's
 * no rules engine, no DSL, just persisted `?genre=&minBpm=&...` state.
 */

import { z } from "zod";

/**
 * Single source of truth for the param keys library understands. If the
 * library page ever grows a new filter, add the key here and it'll be
 * accepted by saved searches as well.
 */
export const SAVED_SEARCH_KEYS = [
    "search",
    "genre",
    "energy",
    "key",
    "favorites",
    "tag",
    "rating",
    "minBpm",
    "maxBpm",
    "album",
    "artist",
    "year",
    "label",
    "subgenre",
    "mood",
    "sort",
    "order",
] as const;

export type SavedSearchKey = (typeof SAVED_SEARCH_KEYS)[number];

/** Stored filter payload: all keys are optional strings. */
export const savedSearchFiltersSchema = z
    .object(Object.fromEntries(
        SAVED_SEARCH_KEYS.map((k) => [k, z.string().min(1).max(200).optional()]),
    ) as Record<SavedSearchKey, z.ZodOptional<z.ZodString>>)
    .strict();

export type SavedSearchFilters = z.infer<typeof savedSearchFiltersSchema>;

export const savedSearchInputSchema = z.object({
    name: z.string().min(1).max(60),
    icon: z.string().min(1).max(40).optional(),
    filters: savedSearchFiltersSchema,
});

export type SavedSearchInput = z.infer<typeof savedSearchInputSchema>;

/**
 * Convert a stored filters object into a query string suitable for
 * `/library?...`. Drops empty values so the URL stays tidy.
 */
export function filtersToQueryString(filters: SavedSearchFilters): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== "") params.set(key, value);
    }
    const s = params.toString();
    return s ? `?${s}` : "";
}

/**
 * Pull a saved-search payload out of a raw `searchParams` record (the
 * shape passed by Next.js to server components). Strips unknown keys
 * and any values that are empty / not strings.
 */
export function extractFiltersFromParams(
    raw: Record<string, string | undefined>,
): SavedSearchFilters {
    const out: Record<string, string> = {};
    for (const key of SAVED_SEARCH_KEYS) {
        const v = raw[key];
        if (typeof v === "string" && v.length > 0) out[key] = v;
    }
    return savedSearchFiltersSchema.parse(out);
}

/** True when the filter payload would meaningfully restrict the library. */
export function hasMeaningfulFilters(filters: SavedSearchFilters): boolean {
    // sort/order alone aren't restrictive — they just reorder.
    return Object.entries(filters).some(
        ([k, v]) => k !== "sort" && k !== "order" && typeof v === "string" && v.length > 0,
    );
}
