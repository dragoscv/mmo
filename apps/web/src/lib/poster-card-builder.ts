/**
 * Single source of truth for PosterCard props across the Watch surface.
 *
 * Every list of movies/shows (browse grid, home rows, continue watching,
 * collections, similar titles, …) should call into these builders so the
 * card layout — badges, hover preview, context menu, view-transition name —
 * is identical everywhere.
 */
import { fileToTech, pickBestFile } from "@/lib/video-tech";
import type { ComponentProps } from "react";
import type { PosterCard } from "@/components/video/poster-card";

type Props = Omit<ComponentProps<typeof PosterCard>, "key">;

type CardKind = "movie" | "tv";

interface VideoFileLite {
    width?: number | null;
    height?: number | null;
    hdr?: string | null;
    videoCodec?: string | null;
    audioCodec?: string | null;
    bitrateKbps?: number | null;
    audioTracks?: unknown;
    subtitleTracks?: unknown;
}

interface MovieRow {
    id: number;
    title: string;
    year?: number | null;
    overview?: string | null;
    rating?: number | null;
    posterPath?: string | null;
    backdropPath?: string | null;
    runtimeMinutes?: number | null;
    ageRating?: string | null;
    trailerYoutubeId?: string | null;
    tmdbId?: number | null;
    imdbId?: string | null;
    genres?: unknown;
    cast?: unknown;
}

interface ShowRow {
    id: number;
    title: string;
    firstAirYear?: number | null;
    overview?: string | null;
    rating?: number | null;
    posterPath?: string | null;
    backdropPath?: string | null;
    ageRating?: string | null;
    trailerYoutubeId?: string | null;
    tmdbId?: number | null;
    imdbId?: string | null;
    genres?: unknown;
    cast?: unknown;
}

interface CommonOpts {
    watched?: boolean;
    liked?: boolean;
    inWishlist?: boolean;
    progress?: number;
    resumeSec?: number;
    customCollections?: Array<{ id: number; name: string }>;
    /** Override the `local` pill (defaults to true — these are library rows). */
    local?: boolean;
    /** Override href (e.g., for collection links). */
    href?: string;
}

function genreNames(g: unknown): string[] {
    return Array.isArray(g)
        ? (g as Array<{ name?: string }>).map((x) => x.name).filter((n): n is string => !!n)
        : [];
}

function castList(c: unknown): Array<{ name: string; character?: string }> {
    return Array.isArray(c)
        ? (c as Array<{ name?: string; character?: string }>)
            .filter((x): x is { name: string; character?: string } => !!x.name)
            .slice(0, 10)
        : [];
}

export function buildMoviePosterProps(
    m: MovieRow,
    opts: { files?: VideoFileLite[] } & CommonOpts = {},
): Props {
    return {
        href: opts.href ?? `/watch/movies/${m.id}`,
        title: m.title,
        year: m.year ?? null,
        posterPath: m.posterPath ?? null,
        overview: m.overview ?? null,
        rating: m.rating ?? null,
        trailerId: m.trailerYoutubeId ?? null,
        extra: m.runtimeMinutes ? `${m.runtimeMinutes} min` : null,
        watched: opts.watched,
        liked: opts.liked,
        local: opts.local ?? true,
        progress: opts.progress,
        resumeSec: opts.resumeSec,
        genres: genreNames(m.genres),
        transitionName: `movie-${m.id}`,
        preview: {
            backdropPath: m.backdropPath ?? null,
            runtime: m.runtimeMinutes ?? null,
            ageRating: m.ageRating ?? null,
            cast: castList(m.cast),
            tech: fileToTech(pickBestFile(opts.files ?? [])),
        },
        ctx: {
            kind: "movie",
            movieId: m.id,
            tmdbId: m.tmdbId ?? null,
            imdbId: m.imdbId ?? null,
            inWishlist: opts.inWishlist,
            customCollections: opts.customCollections,
        },
    };
}

export function buildShowPosterProps(
    s: ShowRow,
    opts: CommonOpts & { files?: VideoFileLite[] } = {},
): Props {
    return {
        href: opts.href ?? `/watch/shows/${s.id}`,
        title: s.title,
        year: s.firstAirYear ?? null,
        posterPath: s.posterPath ?? null,
        overview: s.overview ?? null,
        rating: s.rating ?? null,
        trailerId: s.trailerYoutubeId ?? null,
        watched: opts.watched,
        liked: opts.liked,
        local: opts.local ?? true,
        progress: opts.progress,
        resumeSec: opts.resumeSec,
        genres: genreNames(s.genres),
        transitionName: `show-${s.id}`,
        preview: {
            backdropPath: s.backdropPath ?? null,
            ageRating: s.ageRating ?? null,
            cast: castList(s.cast),
            tech: fileToTech(pickBestFile(opts.files ?? [])),
        },
        ctx: {
            kind: "tv",
            showId: s.id,
            tmdbId: s.tmdbId ?? null,
            imdbId: s.imdbId ?? null,
            inWishlist: opts.inWishlist,
            customCollections: opts.customCollections,
        },
    };
}

/** Card props for a TMDB-only hit (Trending / For-you / Similar titles when not in library). */
interface TmdbHit {
    id: number;
    title?: string;
    name?: string;
    release_date?: string;
    first_air_date?: string;
    poster_path?: string | null;
    backdrop_path?: string | null;
    overview?: string | null;
    vote_average?: number | null;
}

export function buildTmdbHitPosterProps(
    hit: TmdbHit,
    kind: CardKind,
    opts: { localId?: number; isLocal?: boolean } = {},
): Props {
    const date = hit.release_date ?? hit.first_air_date;
    const year = date ? parseInt(date.slice(0, 4), 10) : null;
    const title = (kind === "movie" ? (hit.title ?? hit.name) : (hit.name ?? hit.title)) ?? "Untitled";
    const href = opts.localId
        ? (kind === "movie" ? `/watch/movies/${opts.localId}` : `/watch/shows/${opts.localId}`)
        : (kind === "movie" ? `/watch/discover/movie/${hit.id}` : `/watch/discover/tv/${hit.id}`);
    return {
        href,
        title,
        year,
        posterPath: hit.poster_path ?? null,
        overview: hit.overview ?? null,
        rating: hit.vote_average ?? null,
        local: opts.isLocal ?? !!opts.localId,
        // Backdrop powers the hover preview's hero area when the title has
        // no trailer cached locally — otherwise the popover/modal shows an
        // empty grey panel.
        preview: {
            backdropPath: hit.backdrop_path ?? null,
        },
        ctx: {
            kind,
            movieId: kind === "movie" ? opts.localId : undefined,
            showId: kind === "tv" ? opts.localId : undefined,
            tmdbId: hit.id,
        },
    };
}
