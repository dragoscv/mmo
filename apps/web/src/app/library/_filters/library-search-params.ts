import {
    createSerializer,
    parseAsArrayOf,
    parseAsInteger,
    parseAsString,
    parseAsStringEnum,
} from "nuqs";

/**
 * URL state for /library (WP9-03). The server page reads the very same
 * query keys (`page.tsx`), so every value here serialises exactly the way
 * the old hand-rolled `URLSearchParams` code did:
 *   - multi-value filters are comma-joined (`genre=House,Techno`)
 *   - defaults are omitted from the URL (`clearOnDefault`)
 */

/** Column keys accepted by `buildOrderBy` in lib/cloud-library.ts. */
export const LIBRARY_SORT_KEYS = [
    "addedAt",
    "artist",
    "title",
    "bpm",
    "key",
    "genre",
    "energy",
    "duration",
    "rating",
    "favorite",
    "bitrate",
    "year",
] as const;

export type LibrarySortKey = (typeof LIBRARY_SORT_KEYS)[number];

export const librarySearchParams = {
    search: parseAsString.withDefault(""),
    sort: parseAsStringEnum<LibrarySortKey>([...LIBRARY_SORT_KEYS]).withDefault("addedAt"),
    order: parseAsStringEnum<"asc" | "desc">(["asc", "desc"]).withDefault("desc"),
    page: parseAsInteger.withDefault(1),
    pageSize: parseAsInteger.withDefault(50),
    genre: parseAsArrayOf(parseAsString).withDefault([]),
    key: parseAsArrayOf(parseAsString).withDefault([]),
    tag: parseAsArrayOf(parseAsString).withDefault([]),
    energy: parseAsString.withDefault(""),
    favorites: parseAsString.withDefault(""),
    rating: parseAsString.withDefault(""),
    minBpm: parseAsString.withDefault(""),
    maxBpm: parseAsString.withDefault(""),
    album: parseAsString.withDefault(""),
    artist: parseAsString.withDefault(""),
    year: parseAsString.withDefault(""),
    label: parseAsString.withDefault(""),
    subgenre: parseAsString.withDefault(""),
    mood: parseAsString.withDefault(""),
};

export type LibraryQuery = {
    [K in keyof typeof librarySearchParams]: ReturnType<(typeof librarySearchParams)[K]["parseServerSide"]>;
};

/** Builds `/library?...` for router.prefetch, omitting default values. */
export const serializeLibraryUrl = createSerializer(librarySearchParams, { clearOnDefault: true });
