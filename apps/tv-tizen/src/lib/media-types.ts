/**
 * Minimal copies of the `/media/*` wire types from `server/src/media/types.ts`
 * (canonical: `packages/sdk/src/generated/mmo-server.d.ts`). Copied because this
 * app's tsconfig has no `paths` alias for `@mmo/sdk` and stays dependency-free.
 */

export type MediaKind = "movie" | "tv";

export type OfferType = "subscription" | "rent" | "buy" | "free" | "ads";

/** Concrete URLs — the server resolves its URL builders before serialising. */
export interface LaunchData {
    web: string;
    android?: { package: string; uri?: string };
    tizen?: { appId: string; payload?: string };
    search: string;
}

export interface Offer {
    providerId: number;
    name: string;
    logo: string | null;
    type: OfferType;
    link?: string;
    launch: LaunchData;
}

export interface Availability {
    offers: Offer[];
    source: "motn" | "tmdb" | "none";
    attribution: string[];
    fetchedAt?: number;
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
    inLibrary?: boolean;
    /** 0..1 for `continue` rows. */
    progress?: number;
    reason?: string;
}

export interface TitleDetails extends TitleCard {
    runtime?: number;
    status?: string;
    tagline?: string;
    genres: { id: number; name: string }[];
    numberOfSeasons?: number;
    numberOfEpisodes?: number;
    logoPath: string | null;
    certification?: string;
    recommendations: TitleCard[];
    similar: TitleCard[];
}

export interface HomeRow {
    id: string;
    title: { ro: string; en: string };
    kind: "mixed" | MediaKind;
    items: TitleCard[];
    reason?: string;
}

export interface MediaHome {
    region: string;
    profile: string;
    configured: boolean;
    revision: number;
    libraryEtag: string | null;
    serverId: string | null;
    serverName: string;
    rows: HomeRow[];
}

export interface MediaStatus {
    configured: boolean;
    tmdb: boolean;
    motn: boolean;
    region: string;
    language: string;
    revision: number;
    libraryEtag: string | null;
    libraryCount: number;
    serverId: string | null;
    serverName: string;
}

export interface MediaEtag {
    revision: number;
    libraryEtag: string | null;
}

export interface LibraryIndexRow {
    /** Same id `/video/direct/:fileId` expects. */
    serverFileId: string;
    kind: MediaKind;
    tmdbId: number | null;
    season: number | null;
    episode: number | null;
    path: string;
    size: number;
    mtime: number;
    updatedAt: number;
    rev?: number;
}

export interface LibraryIndex {
    revision: number;
    full: boolean;
    items: LibraryIndexRow[];
    removed: string[];
    serverId: string | null;
    serverName: string;
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
    rev?: number;
}

export interface ProgressInput {
    profileId?: string;
    kind: MediaKind;
    tmdbId: number;
    season?: number;
    episode?: number;
    positionSec: number;
    durationSec: number;
    completed?: boolean;
    updatedAt?: number;
}

export interface MediaTitleResponse {
    title: TitleDetails;
    availability: Availability;
    files: LibraryIndexRow[];
    progress: ProgressEntry[];
    serverId: string | null;
    serverName: string;
}

export interface MediaSearchPage {
    page: number;
    totalPages: number;
    results: TitleCard[];
}
