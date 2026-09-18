/**
 * Media Home wire types (WP11-02). These mirror the shapes the MMO Server
 * `/media/*` module returns (server/src/media, WP10) so the web merge layer
 * and the row components compile before the endpoints land. Keep in sync
 * with `server/openapi.yaml` once WP10-07 publishes the spec.
 */

export type MediaKind = "movie" | "tv";

/** Where a title can be played locally — one entry per MMO Server that owns a file. */
export interface TitleSource {
    serverId: string;
    serverName: string;
    /** Server-side video file id (`/video/*` endpoints). */
    fileId: number;
    /** e.g. "2160p", "1080p", "720p". */
    quality?: string;
}

export interface TitleCard {
    kind: MediaKind;
    tmdbId: number;
    title: string;
    year?: number | null;
    poster?: string | null;
    backdrop?: string | null;
    /** Title-treatment PNG (TMDB `logos`) for the hero. */
    logo?: string | null;
    rating?: number | null;
    /** 0..1 progress for Continue rows. */
    progress?: number | null;
    /** True when at least one server has a local file. */
    inLibrary: boolean;
    sources?: TitleSource[];
}

/** One horizontal row on Media Home. `title` is bilingual so a server can label rows without web i18n. */
export interface HomeRow {
    id: string;
    title: { ro: string; en: string };
    kind: MediaKind | "mixed";
    items: TitleCard[];
    /** Optional one-line "why this row" (curator / because-you-watched). */
    reason?: { ro: string; en: string } | null;
}

/** A streaming provider offer for a title (deep link or search fallback). */
export interface Offer {
    providerId: string;
    name: string;
    logo?: string | null;
    type: "subscription" | "free" | "rent" | "buy" | "ads";
    /** Exact deep link when known (MOTN / JustWatch). */
    link?: string | null;
    launch: {
        web: string;
        android?: string | null;
        tizen?: string | null;
        /** Provider-side search URL used when `link` is missing. */
        search: string;
    };
}

/** Title merged across servers (same tmdbId) — what the web renders. */
export interface MergedTitle extends Omit<TitleCard, "sources" | "inLibrary"> {
    sources: TitleSource[];
    inLibrary: boolean;
}

export interface MediaServer {
    id: string;
    name: string;
    online: boolean;
    apiUrl: string;
    lastSeenAt: Date | null;
}
