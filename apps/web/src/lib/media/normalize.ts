/**
 * Server wire → web types (WP11-03/04). The MMO Server `media` module
 * (server/src/media/types.ts) speaks TMDB-flavoured field names
 * (`posterPath`, `voteAverage`, `releaseDate`); the web row components use
 * the shorter `TitleCard` shape from `./types`. Everything here is pure and
 * unit-tested; no I/O.
 */

import type {
    Availability,
    HomeRow,
    MediaKind,
    Offer,
    TitleCard,
    TitleDetails,
    TitleSource,
} from "./types";

// ─── Wire shapes (subset of server/src/media/types.ts) ───────────────────────

export interface WireCard {
    kind: MediaKind;
    tmdbId: number;
    title: string;
    overview?: string;
    posterPath?: string | null;
    backdropPath?: string | null;
    logoPath?: string | null;
    releaseDate?: string;
    voteAverage?: number;
    genreIds?: number[];
    inLibrary?: boolean;
    progress?: number;
}

export interface WireRow {
    id: string;
    title: { ro: string; en: string };
    kind: MediaKind | "mixed";
    items: WireCard[];
    reason?: string | { ro: string; en: string };
}

export interface WireHome {
    serverId?: string | null;
    serverName?: string;
    region?: string;
    rows: WireRow[];
}

export interface WireFile {
    serverFileId?: string;
    fileId?: string;
    path: string;
    quality?: string | null;
    season?: number | null;
    episode?: number | null;
}

export interface WireProgress {
    positionSec: number;
    durationSec: number;
    completed: boolean;
    season?: number;
    episode?: number;
}

export interface WireOffer {
    providerId: number | string;
    name: string;
    logo?: string | null;
    type: Offer["type"];
    link?: string | null;
    launch: { web: string; android?: unknown; tizen?: unknown; search: string };
}

export interface WireTitle extends WireCard {
    tagline?: string;
    runtime?: number;
    genres?: Array<{ id: number; name: string }>;
    cast?: Array<{ id: number; name: string; role: string; profilePath: string | null }>;
    videos?: Array<{ key: string; site: string; type: string; name: string }>;
    certification?: string;
    numberOfSeasons?: number;
    numberOfEpisodes?: number;
    similar?: WireCard[];
    recommendations?: WireCard[];
}

export interface WireTitleResponse {
    serverId?: string | null;
    serverName?: string;
    title: WireTitle;
    availability?: { offers?: WireOffer[]; source?: Availability["source"]; attribution?: string[] } | null;
    files?: WireFile[];
    progress?: WireProgress[] | WireProgress | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export const yearOf = (date: string | undefined | null): number | null => {
    if (!date) return null;
    const y = parseInt(date.slice(0, 4), 10);
    return Number.isFinite(y) ? y : null;
};

/** TMDB image URL for a relative path (`/abc.jpg`) — null-safe. */
export function tmdbImg(path: string | null | undefined, size: "w92" | "w185" | "w342" | "w500" | "w780" | "w1280" | "original"): string | null {
    if (!path) return null;
    if (/^https?:\/\//.test(path)) return path;
    return `https://image.tmdb.org/t/p/${size}${path}`;
}

export function normalizeCard(c: WireCard): TitleCard {
    return {
        kind: c.kind,
        tmdbId: c.tmdbId,
        title: c.title,
        year: yearOf(c.releaseDate),
        overview: c.overview ?? null,
        poster: c.posterPath ?? null,
        backdrop: c.backdropPath ?? null,
        logo: c.logoPath ?? null,
        rating: c.voteAverage ?? null,
        genreIds: c.genreIds ?? [],
        progress: c.progress ?? null,
        inLibrary: c.inLibrary ?? false,
        sources: [],
    };
}

export function normalizeRows(home: WireHome): HomeRow[] {
    return (home.rows ?? []).map((r) => ({
        id: r.id,
        title: r.title,
        kind: r.kind,
        items: (r.items ?? []).map(normalizeCard),
        reason: typeof r.reason === "string" ? { ro: r.reason, en: r.reason } : (r.reason ?? null),
    }));
}

export function pickTrailerKey(videos: WireTitle["videos"]): string | null {
    if (!videos?.length) return null;
    const yt = videos.filter((v) => v.site === "YouTube");
    const byType = (t: string) => yt.find((v) => v.type === t);
    return (byType("Trailer") ?? byType("Teaser") ?? yt[0])?.key ?? null;
}

export function normalizeTitle(t: WireTitle): TitleDetails {
    const base = normalizeCard(t);
    const { inLibrary: _i, sources: _s, ...card } = base;
    return {
        ...card,
        tagline: t.tagline ?? null,
        runtime: t.runtime ?? null,
        genres: (t.genres ?? []).map((g) => g.name),
        cast: (t.cast ?? []).slice(0, 12),
        trailerKey: pickTrailerKey(t.videos),
        certification: t.certification ?? null,
        numberOfSeasons: t.numberOfSeasons ?? null,
        numberOfEpisodes: t.numberOfEpisodes ?? null,
        similar: (t.similar ?? []).map(normalizeCard),
        recommendations: (t.recommendations ?? []).map(normalizeCard),
    };
}

export function normalizeOffer(o: WireOffer): Offer {
    return {
        providerId: String(o.providerId),
        name: o.name,
        logo: o.logo ?? null,
        type: o.type,
        link: o.link ?? null,
        launch: { web: o.launch.web, search: o.launch.search },
    };
}

export function normalizeAvailability(a: WireTitleResponse["availability"]): Availability {
    return {
        offers: (a?.offers ?? []).map(normalizeOffer),
        source: a?.source ?? "none",
        attribution: a?.attribution ?? [],
    };
}

export function filesToSources(files: WireFile[] | undefined, serverId: string, serverName: string): TitleSource[] {
    return (files ?? []).map((f) => ({
        serverId,
        serverName,
        fileId: f.fileId ?? f.serverFileId ?? f.path,
        quality: f.quality ?? undefined,
        season: f.season ?? null,
        episode: f.episode ?? null,
        path: f.path,
    }));
}

export function progressFraction(p: WireTitleResponse["progress"]): number | null {
    const list = Array.isArray(p) ? p : p ? [p] : [];
    let best: number | null = null;
    for (const e of list) {
        const f = e.completed ? 1 : e.durationSec > 0 ? Math.min(1, e.positionSec / e.durationSec) : 0;
        best = best === null ? f : Math.max(best, f);
    }
    return best;
}
