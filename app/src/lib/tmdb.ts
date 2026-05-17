/**
 * TMDB API client (v3) — server-side only.
 *
 * Free tier, RO + EN localised data, watch providers (JustWatch backed),
 * trailers (YouTube), credits, recommendations, videos.
 *
 * All requests funnel through `tmdb()` so caching + auth + rate limiting
 * live in one place. Keyed by `TMDB_API_KEY` env (v3 key). When the key
 * is missing every call returns null so the rest of the app can render
 * an empty-state without throwing.
 */

import "server-only";

const TMDB_BASE = "https://api.themoviedb.org/3";
const DEFAULT_LANG = process.env.TMDB_DEFAULT_LANG ?? "ro-RO";
const FALLBACK_LANG = "en-US";

export interface TmdbMovie {
    id: number;
    imdb_id?: string | null;
    title: string;
    original_title: string;
    overview: string | null;
    tagline?: string | null;
    release_date: string | null;
    runtime: number | null;
    poster_path: string | null;
    backdrop_path: string | null;
    vote_average: number;
    vote_count: number;
    genres: Array<{ id: number; name: string }>;
}

export interface TmdbTv {
    id: number;
    name: string;
    original_name: string;
    overview: string | null;
    first_air_date: string | null;
    poster_path: string | null;
    backdrop_path: string | null;
    vote_average: number;
    vote_count: number;
    number_of_seasons: number | null;
    number_of_episodes: number | null;
    status: string | null;
    genres: Array<{ id: number; name: string }>;
}

export interface TmdbCredits {
    cast: Array<{ id: number; name: string; character: string; profile_path: string | null; order: number }>;
    crew: Array<{ id: number; name: string; job: string; department: string; profile_path: string | null }>;
}

export interface TmdbVideo {
    id: string;
    key: string;
    name: string;
    site: string;
    type: string;
    official: boolean;
}

export interface TmdbWatchProvider {
    provider_id: number;
    provider_name: string;
    logo_path: string;
    display_priority: number;
}

export interface TmdbWatchProviders {
    link: string;
    flatrate?: TmdbWatchProvider[];
    rent?: TmdbWatchProvider[];
    buy?: TmdbWatchProvider[];
    ads?: TmdbWatchProvider[];
    free?: TmdbWatchProvider[];
}

export interface TmdbSearchHit {
    id: number;
    media_type: "movie" | "tv" | "person";
    title?: string;
    name?: string;
    poster_path: string | null;
    backdrop_path: string | null;
    release_date?: string;
    first_air_date?: string;
    vote_average?: number;
    overview?: string | null;
}

async function tmdb<T>(p: string, params: Record<string, string | number | undefined> = {}, opts: { cache?: number } = {}): Promise<T | null> {
    const key = process.env.TMDB_API_KEY;
    if (!key) return null;
    const url = new URL(TMDB_BASE + p);
    url.searchParams.set("api_key", key);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    try {
        const res = await fetch(url.toString(), {
            next: { revalidate: opts.cache ?? 3600 },
        });
        if (!res.ok) return null;
        return await res.json() as T;
    } catch {
        return null;
    }
}

export async function tmdbSearch(query: string, kind?: "movie" | "tv" | "multi"): Promise<TmdbSearchHit[]> {
    const path = kind === "movie" ? "/search/movie" : kind === "tv" ? "/search/tv" : "/search/multi";
    const data = await tmdb<{ results: TmdbSearchHit[] }>(path, { query, language: DEFAULT_LANG, include_adult: "false" });
    if (!data) return [];
    return (data.results ?? []).map((r) => kind === "movie" ? { ...r, media_type: "movie" as const } : kind === "tv" ? { ...r, media_type: "tv" as const } : r);
}

export async function tmdbMovie(id: number): Promise<TmdbMovie | null> {
    const ro = await tmdb<TmdbMovie>(`/movie/${id}`, { language: DEFAULT_LANG, append_to_response: "external_ids" });
    if (ro && ro.overview) return ro;
    const en = await tmdb<TmdbMovie>(`/movie/${id}`, { language: FALLBACK_LANG, append_to_response: "external_ids" });
    if (ro && en) return { ...ro, overview: ro.overview ?? en.overview, tagline: ro.tagline ?? en.tagline };
    return ro ?? en;
}

export async function tmdbTv(id: number): Promise<TmdbTv | null> {
    const ro = await tmdb<TmdbTv>(`/tv/${id}`, { language: DEFAULT_LANG, append_to_response: "external_ids" });
    if (ro && ro.overview) return ro;
    const en = await tmdb<TmdbTv>(`/tv/${id}`, { language: FALLBACK_LANG, append_to_response: "external_ids" });
    if (ro && en) return { ...ro, overview: ro.overview ?? en.overview };
    return ro ?? en;
}

export async function tmdbMovieCredits(id: number): Promise<TmdbCredits | null> {
    return tmdb<TmdbCredits>(`/movie/${id}/credits`, { language: DEFAULT_LANG });
}

export async function tmdbTvCredits(id: number): Promise<TmdbCredits | null> {
    return tmdb<TmdbCredits>(`/tv/${id}/credits`, { language: DEFAULT_LANG });
}

export async function tmdbMovieVideos(id: number): Promise<TmdbVideo[]> {
    const data = await tmdb<{ results: TmdbVideo[] }>(`/movie/${id}/videos`, { language: DEFAULT_LANG });
    let arr = data?.results ?? [];
    if (arr.length === 0) {
        const en = await tmdb<{ results: TmdbVideo[] }>(`/movie/${id}/videos`, { language: FALLBACK_LANG });
        arr = en?.results ?? [];
    }
    return arr.filter((v) => v.site === "YouTube");
}

export async function tmdbTvVideos(id: number): Promise<TmdbVideo[]> {
    const data = await tmdb<{ results: TmdbVideo[] }>(`/tv/${id}/videos`, { language: DEFAULT_LANG });
    let arr = data?.results ?? [];
    if (arr.length === 0) {
        const en = await tmdb<{ results: TmdbVideo[] }>(`/tv/${id}/videos`, { language: FALLBACK_LANG });
        arr = en?.results ?? [];
    }
    return arr.filter((v) => v.site === "YouTube");
}

export async function tmdbMovieRecommendations(id: number): Promise<TmdbSearchHit[]> {
    const data = await tmdb<{ results: TmdbSearchHit[] }>(`/movie/${id}/recommendations`, { language: DEFAULT_LANG });
    return (data?.results ?? []).map((r) => ({ ...r, media_type: "movie" as const }));
}

export async function tmdbTvRecommendations(id: number): Promise<TmdbSearchHit[]> {
    const data = await tmdb<{ results: TmdbSearchHit[] }>(`/tv/${id}/recommendations`, { language: DEFAULT_LANG });
    return (data?.results ?? []).map((r) => ({ ...r, media_type: "tv" as const }));
}

export async function tmdbWatchProviders(kind: "movie" | "tv", id: number, country = "RO"): Promise<TmdbWatchProviders | null> {
    const data = await tmdb<{ results: Record<string, TmdbWatchProviders> }>(`/${kind}/${id}/watch/providers`);
    return data?.results?.[country] ?? null;
}

export async function tmdbTvSeason(showId: number, season: number): Promise<{
    episodes: Array<{
        id: number; episode_number: number; season_number: number;
        name: string; overview: string | null; air_date: string | null;
        still_path: string | null; runtime: number | null; vote_average: number;
    }>;
} | null> {
    return tmdb(`/tv/${showId}/season/${season}`, { language: DEFAULT_LANG });
}

export async function tmdbTrending(kind: "movie" | "tv", window: "day" | "week" = "week"): Promise<TmdbSearchHit[]> {
    const data = await tmdb<{ results: TmdbSearchHit[] }>(`/trending/${kind}/${window}`, { language: DEFAULT_LANG });
    return (data?.results ?? []).map((r) => ({ ...r, media_type: kind }));
}

/** Build a TMDB poster URL. Use `tmdbImageProxyUrl()` to route through
 *  the companion-side cache instead when one is available. */
export function tmdbImage(p: string | null | undefined, size: "w185" | "w300" | "w500" | "w780" | "original" = "w500"): string | null {
    if (!p) return null;
    return `https://image.tmdb.org/t/p/${size}${p}`;
}

/** Pick the best trailer from a list of TMDB videos. */
export function pickTrailer(videos: TmdbVideo[]): TmdbVideo | null {
    if (!videos || videos.length === 0) return null;
    return (
        videos.find((v) => v.type === "Trailer" && v.official) ??
        videos.find((v) => v.type === "Trailer") ??
        videos.find((v) => v.type === "Teaser") ??
        videos[0]
    );
}
