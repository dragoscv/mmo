/**
 * Shared types for the `media` module (MMO Server "brain" for Media Home).
 * Minimal, JSON-friendly shapes — everything the web / TV clients consume.
 */

export type MediaKind = "movie" | "tv";

export type OfferType = "subscription" | "rent" | "buy" | "free" | "ads";

export interface LaunchData {
    /** Web URL — exact deep link when known, otherwise a provider search URL. */
    web: string;
    android?: { package: string; uri?: string };
    tizen?: { appId: string; payload?: string };
    /** Provider search URL for the title (always present as a fallback). */
    search: string;
}

export interface Offer {
    providerId: number;
    name: string;
    logo: string | null;
    type: OfferType;
    /** Exact deep link (MOTN). Undefined when only TMDB/JustWatch data is available. */
    link?: string;
    launch: LaunchData;
}

export interface Availability {
    offers: Offer[];
    source: "motn" | "tmdb" | "none";
    attribution: string[];
    fetchedAt?: number;
}

export interface Person {
    id: number;
    name: string;
    role: string;
    profilePath: string | null;
}

export interface TitleCard {
    kind: MediaKind;
    tmdbId: number;
    title: string;
    originalTitle?: string;
    overview?: string;
    posterPath: string | null;
    backdropPath: string | null;
    releaseDate?: string;
    voteAverage?: number;
    voteCount?: number;
    popularity?: number;
    genreIds: number[];
    /** Set by the rows builder when the title exists in `library_index`. */
    inLibrary?: boolean;
    /** Progress (0..1) for `continue` rows. */
    progress?: number;
    /** Optional per-row explanation. */
    reason?: string;
}

export interface TitleDetails extends TitleCard {
    runtime?: number;
    status?: string;
    tagline?: string;
    genres: { id: number; name: string }[];
    keywords: { id: number; name: string }[];
    cast: Person[];
    crew: Person[];
    collectionId?: number | null;
    numberOfSeasons?: number;
    numberOfEpisodes?: number;
    externalIds: Record<string, string | number | null>;
    videos: { key: string; site: string; type: string; name: string }[];
    logoPath: string | null;
    certification?: string;
    recommendations: TitleCard[];
    similar: TitleCard[];
    /** Raw TMDB `watch/providers.results[region]` for the availability resolver. */
    watchProviders: Record<string, TmdbRegionProviders>;
}

export interface TmdbProviderRef {
    provider_id: number;
    provider_name: string;
    logo_path: string | null;
    display_priority?: number;
}

export interface TmdbRegionProviders {
    link?: string;
    flatrate?: TmdbProviderRef[];
    rent?: TmdbProviderRef[];
    buy?: TmdbProviderRef[];
    free?: TmdbProviderRef[];
    ads?: TmdbProviderRef[];
}

export interface HistoryEntry {
    kind: MediaKind;
    tmdbId: number;
    /** Epoch ms of the last watch. */
    watchedAt: number;
    /** 0..1 fraction watched. */
    completion: number;
    /** Optional explicit rating 0..10. */
    rating?: number;
    dismissed?: boolean;
}

export interface LibraryIndexRow {
    serverFileId: string;
    kind: MediaKind;
    tmdbId: number | null;
    season: number | null;
    episode: number | null;
    path: string;
    size: number;
    mtime: number;
    updatedAt: number;
    /** Global revision at which this row was last written. */
    rev?: number;
}

export interface ProgressEntry {
    profileId: string;
    kind: MediaKind;
    tmdbId: number;
    season: number;
    episode: number;
    positionSec: number;
    durationSec: number;
    completed: boolean;
    updatedAt: number;
    /** Global revision at which this row was last written (delta sync watermark). */
    rev?: number;
}

export interface TrackPlay {
    id: number;
    profileId: string;
    trackKey: string;
    playedAt: number;
    durationSec: number;
    completed: boolean;
    rev?: number;
}

export interface HomeRow {
    id: string;
    title: { ro: string; en: string };
    kind: "mixed" | MediaKind;
    items: TitleCard[];
    reason?: string;
}

export interface MediaLogger {
    debug: (msg: string, fields?: Record<string, unknown>) => void;
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>, err?: unknown) => void;
    error: (msg: string, err: unknown, fields?: Record<string, unknown>) => void;
}
