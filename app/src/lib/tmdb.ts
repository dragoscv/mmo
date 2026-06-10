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
import { cookies } from "next/headers";
import { cache } from "react";

const TMDB_BASE = "https://api.themoviedb.org/3";
const FALLBACK_LANG = "en-US";

/** Read the user's preferred locale (mmo-locale cookie) and map to a TMDB language code. */
const getTmdbLang = cache(async (): Promise<string> => {
    const envOverride = process.env.TMDB_DEFAULT_LANG;
    if (envOverride) return envOverride;
    try {
        const c = await cookies();
        const loc = c.get("mmo-locale")?.value;
        if (loc === "en") return "en-US";
        return "ro-RO";
    } catch {
        return "ro-RO";
    }
});

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
    vote_count?: number;
    popularity?: number;
    genre_ids?: number[];
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
    const data = await tmdb<{ results: TmdbSearchHit[] }>(path, { query, language: await getTmdbLang(), include_adult: "false" });
    if (!data) return [];
    return (data.results ?? []).map((r) => kind === "movie" ? { ...r, media_type: "movie" as const } : kind === "tv" ? { ...r, media_type: "tv" as const } : r);
}

export async function tmdbMovie(id: number): Promise<TmdbMovie | null> {
    const ro = await tmdb<TmdbMovie>(`/movie/${id}`, { language: await getTmdbLang(), append_to_response: "external_ids" });
    if (ro && ro.overview) return ro;
    const en = await tmdb<TmdbMovie>(`/movie/${id}`, { language: FALLBACK_LANG, append_to_response: "external_ids" });
    if (ro && en) return { ...ro, overview: ro.overview ?? en.overview, tagline: ro.tagline ?? en.tagline };
    return ro ?? en;
}

export async function tmdbTv(id: number): Promise<TmdbTv | null> {
    const ro = await tmdb<TmdbTv>(`/tv/${id}`, { language: await getTmdbLang(), append_to_response: "external_ids" });
    if (ro && ro.overview) return ro;
    const en = await tmdb<TmdbTv>(`/tv/${id}`, { language: FALLBACK_LANG, append_to_response: "external_ids" });
    if (ro && en) return { ...ro, overview: ro.overview ?? en.overview };
    return ro ?? en;
}

export async function tmdbMovieCredits(id: number): Promise<TmdbCredits | null> {
    return tmdb<TmdbCredits>(`/movie/${id}/credits`, { language: await getTmdbLang() });
}

export async function tmdbTvCredits(id: number): Promise<TmdbCredits | null> {
    return tmdb<TmdbCredits>(`/tv/${id}/credits`, { language: await getTmdbLang() });
}

export async function tmdbMovieVideos(id: number): Promise<TmdbVideo[]> {
    const data = await tmdb<{ results: TmdbVideo[] }>(`/movie/${id}/videos`, { language: await getTmdbLang() });
    let arr = data?.results ?? [];
    if (arr.length === 0) {
        const en = await tmdb<{ results: TmdbVideo[] }>(`/movie/${id}/videos`, { language: FALLBACK_LANG });
        arr = en?.results ?? [];
    }
    return arr.filter((v) => v.site === "YouTube");
}

export async function tmdbTvVideos(id: number): Promise<TmdbVideo[]> {
    const data = await tmdb<{ results: TmdbVideo[] }>(`/tv/${id}/videos`, { language: await getTmdbLang() });
    let arr = data?.results ?? [];
    if (arr.length === 0) {
        const en = await tmdb<{ results: TmdbVideo[] }>(`/tv/${id}/videos`, { language: FALLBACK_LANG });
        arr = en?.results ?? [];
    }
    return arr.filter((v) => v.site === "YouTube");
}

export async function tmdbMovieRecommendations(id: number): Promise<TmdbSearchHit[]> {
    const data = await tmdb<{ results: TmdbSearchHit[] }>(`/movie/${id}/recommendations`, { language: await getTmdbLang() });
    return (data?.results ?? []).map((r) => ({ ...r, media_type: "movie" as const }));
}

export async function tmdbTvRecommendations(id: number): Promise<TmdbSearchHit[]> {
    const data = await tmdb<{ results: TmdbSearchHit[] }>(`/tv/${id}/recommendations`, { language: await getTmdbLang() });
    return (data?.results ?? []).map((r) => ({ ...r, media_type: "tv" as const }));
}

export async function tmdbMovieSimilar(id: number): Promise<TmdbSearchHit[]> {
    const data = await tmdb<{ results: TmdbSearchHit[] }>(`/movie/${id}/similar`, { language: await getTmdbLang() });
    return (data?.results ?? []).map((r) => ({ ...r, media_type: "movie" as const }));
}

export async function tmdbTvSimilar(id: number): Promise<TmdbSearchHit[]> {
    const data = await tmdb<{ results: TmdbSearchHit[] }>(`/tv/${id}/similar`, { language: await getTmdbLang() });
    return (data?.results ?? []).map((r) => ({ ...r, media_type: "tv" as const }));
}

export async function tmdbWatchProviders(kind: "movie" | "tv", id: number, country = "RO"): Promise<TmdbWatchProviders | null> {
    const data = await tmdb<{ results: Record<string, TmdbWatchProviders> }>(`/${kind}/${id}/watch/providers`);
    return data?.results?.[country] ?? null;
}

/** Fetch watch providers for multiple regions and merge by provider id.
 *  Returns one merged result with a `regions` array per provider, so the UI
 *  can show e.g. "Netflix (US, RO)". The first region in `countries` wins
 *  for the `link` field. */
export async function tmdbWatchProvidersMulti(
    kind: "movie" | "tv",
    id: number,
    countries: string[],
): Promise<{
    link: string | null;
    flatrate: Array<TmdbWatchProvider & { regions: string[] }>;
    rent: Array<TmdbWatchProvider & { regions: string[] }>;
    buy: Array<TmdbWatchProvider & { regions: string[] }>;
    free: Array<TmdbWatchProvider & { regions: string[] }>;
} | null> {
    const data = await tmdb<{ results: Record<string, TmdbWatchProviders> }>(`/${kind}/${id}/watch/providers`);
    if (!data?.results) return null;
    let link: string | null = null;
    const merge = (bucket: "flatrate" | "rent" | "buy" | "free") => {
        const map = new Map<number, TmdbWatchProvider & { regions: string[] }>();
        for (const country of countries) {
            const r = data.results[country];
            if (!r) continue;
            if (!link && r.link) link = r.link;
            for (const p of r[bucket] ?? []) {
                const ex = map.get(p.provider_id);
                if (ex) {
                    if (!ex.regions.includes(country)) ex.regions.push(country);
                } else {
                    map.set(p.provider_id, { ...p, regions: [country] });
                }
            }
        }
        return Array.from(map.values()).sort((a, b) => a.display_priority - b.display_priority);
    };
    return {
        link,
        flatrate: merge("flatrate"),
        rent: merge("rent"),
        buy: merge("buy"),
        free: merge("free"),
    };
}

export async function tmdbTvSeason(showId: number, season: number): Promise<{
    episodes: Array<{
        id: number; episode_number: number; season_number: number;
        name: string; overview: string | null; air_date: string | null;
        still_path: string | null; runtime: number | null; vote_average: number;
    }>;
} | null> {
    return tmdb(`/tv/${showId}/season/${season}`, { language: await getTmdbLang() });
}

export async function tmdbTrending(kind: "movie" | "tv", window: "day" | "week" = "week"): Promise<TmdbSearchHit[]> {
    const data = await tmdb<{ results: TmdbSearchHit[] }>(`/trending/${kind}/${window}`, { language: await getTmdbLang() });
    return (data?.results ?? []).map((r) => ({ ...r, media_type: kind }));
}

/** Combined movie + TV credits for an actor/crew member, sorted by popularity desc. */
export async function tmdbPersonCredits(personId: number): Promise<TmdbSearchHit[]> {
    const data = await tmdb<{ cast: TmdbSearchHit[]; crew: TmdbSearchHit[] }>(
        `/person/${personId}/combined_credits`,
        { language: await getTmdbLang() },
    );
    const cast = data?.cast ?? [];
    // Drop unreleased / very low-vote entries
    return cast
        .filter((c) => (c.vote_count ?? 0) >= 50 && (c.vote_average ?? 0) >= 6)
        .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
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
