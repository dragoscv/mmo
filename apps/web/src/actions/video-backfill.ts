"use server";

/**
 * Backfill TMDB metadata for movies/shows whose `posterPath` (or other
 * core fields) is still null. Runs in two contexts:
 *
 *  1. AutoBackfill (silent) — fired once per browser session from
 *     `<AutoBackfill />` after /watch first paints. Capped at
 *     `DEFAULT_LIMIT` so we never melt the TMDB rate limit.
 *  2. Manual button on /watch/settings — same code path, returns the
 *     same result shape so the UI can render a toast.
 */
import { auth } from "@/auth";
import { db } from "@/db";
import { movies, tvShows } from "@/db/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
    tmdbSearch, tmdbMovie, tmdbTv, tmdbMovieCredits, tmdbTvCredits,
    tmdbMovieVideos, tmdbTvVideos, pickTrailer,
} from "@/lib/tmdb";
import { revalidatePath } from "next/cache";

const DEFAULT_LIMIT = 25;

export interface BackfillResult {
    moviesUpdated: number;
    showsUpdated: number;
    moviesSkipped: number;
    showsSkipped: number;
    error?: string;
}

export async function backfillMissingTmdbMetadata(limit = DEFAULT_LIMIT): Promise<BackfillResult> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { moviesUpdated: 0, showsUpdated: 0, moviesSkipped: 0, showsSkipped: 0, error: "unauthorized" };
    if (!process.env.TMDB_API_KEY) {
        return { moviesUpdated: 0, showsUpdated: 0, moviesSkipped: 0, showsSkipped: 0, error: "TMDB_API_KEY not configured" };
    }

    const cap = Math.max(1, Math.min(100, limit));

    // Pick movies that don't have a poster yet (most common case).
    const movieRows = await db.select()
        .from(movies)
        .where(and(eq(movies.userId, userId), or(isNull(movies.posterPath), isNull(movies.overview))))
        .limit(cap);

    const showRows = await db.select()
        .from(tvShows)
        .where(and(eq(tvShows.userId, userId), or(isNull(tvShows.posterPath), isNull(tvShows.overview))))
        .limit(cap);

    let moviesUpdated = 0, moviesSkipped = 0;
    for (const m of movieRows) {
        try {
            // If we already have a tmdbId, skip the search step.
            const tmdb = m.tmdbId
                ? await tmdbMovie(m.tmdbId)
                : await searchAndFetchMovie(m.title, m.year);
            if (!tmdb) { moviesSkipped++; continue; }
            const credits = await tmdbMovieCredits(tmdb.id).catch(() => null);
            const videos = await tmdbMovieVideos(tmdb.id).catch(() => null);
            const trailer = videos ? pickTrailer(videos) : null;
            await db.update(movies).set({
                tmdbId: tmdb.id,
                imdbId: tmdb.imdb_id ?? m.imdbId,
                title: tmdb.title ?? m.title,
                originalTitle: tmdb.original_title ?? m.originalTitle,
                overview: tmdb.overview ?? m.overview,
                tagline: tmdb.tagline ?? m.tagline,
                year: tmdb.release_date ? parseInt(tmdb.release_date.slice(0, 4), 10) : m.year,
                runtimeMinutes: tmdb.runtime ?? m.runtimeMinutes,
                posterPath: tmdb.poster_path ?? m.posterPath,
                backdropPath: tmdb.backdrop_path ?? m.backdropPath,
                trailerYoutubeId: trailer?.key ?? m.trailerYoutubeId,
                genres: tmdb.genres ?? m.genres,
                cast: credits?.cast ? credits.cast.slice(0, 20) : m.cast,
                crew: credits?.crew
                    ? credits.crew.filter((c) => ["Director", "Writer", "Producer"].includes(c.job)).slice(0, 10)
                    : m.crew,
                rating: tmdb.vote_average ?? m.rating,
                ratingCount: tmdb.vote_count ?? m.ratingCount,
                updatedAt: new Date(),
            }).where(eq(movies.id, m.id));
            moviesUpdated++;
        } catch (err) {
            console.error("[backfill] movie failed", m.id, err);
            moviesSkipped++;
        }
    }

    let showsUpdated = 0, showsSkipped = 0;
    for (const s of showRows) {
        try {
            const tmdb = s.tmdbId
                ? await tmdbTv(s.tmdbId)
                : await searchAndFetchTv(s.title, s.firstAirYear);
            if (!tmdb) { showsSkipped++; continue; }
            const credits = await tmdbTvCredits(tmdb.id).catch(() => null);
            const videos = await tmdbTvVideos(tmdb.id).catch(() => null);
            const trailer = videos ? pickTrailer(videos) : null;
            await db.update(tvShows).set({
                tmdbId: tmdb.id,
                title: tmdb.name ?? s.title,
                originalTitle: tmdb.original_name ?? s.originalTitle,
                overview: tmdb.overview ?? s.overview,
                firstAirYear: tmdb.first_air_date ? parseInt(tmdb.first_air_date.slice(0, 4), 10) : s.firstAirYear,
                posterPath: tmdb.poster_path ?? s.posterPath,
                backdropPath: tmdb.backdrop_path ?? s.backdropPath,
                trailerYoutubeId: trailer?.key ?? s.trailerYoutubeId,
                genres: tmdb.genres ?? s.genres,
                cast: credits?.cast ? credits.cast.slice(0, 20) : s.cast,
                rating: tmdb.vote_average ?? s.rating,
                ratingCount: tmdb.vote_count ?? s.ratingCount,
                status: tmdb.status ?? s.status,
                updatedAt: new Date(),
            }).where(eq(tvShows.id, s.id));
            showsUpdated++;
        } catch (err) {
            console.error("[backfill] show failed", s.id, err);
            showsSkipped++;
        }
    }

    if (moviesUpdated + showsUpdated > 0) {
        revalidatePath("/watch");
        revalidatePath("/watch/movies");
        revalidatePath("/watch/shows");
    }

    return { moviesUpdated, showsUpdated, moviesSkipped, showsSkipped };
}

async function searchAndFetchMovie(title: string, year: number | null) {
    const hits = await tmdbSearch(title, "movie").catch(() => []);
    if (hits.length === 0) return null;
    // Prefer same-year match when we know the year; else fall back to popularity.
    const best = year
        ? hits.find((h) => h.release_date?.startsWith(String(year))) ?? hits[0]
        : hits[0];
    if (!best?.id) return null;
    return await tmdbMovie(best.id).catch(() => null);
}

async function searchAndFetchTv(title: string, year: number | null) {
    const hits = await tmdbSearch(title, "tv").catch(() => []);
    if (hits.length === 0) return null;
    const best = year
        ? hits.find((h) => h.first_air_date?.startsWith(String(year))) ?? hits[0]
        : hits[0];
    if (!best?.id) return null;
    return await tmdbTv(best.id).catch(() => null);
}

/** Cheap "do we even have anything to backfill?" probe used by the
 *  client to decide whether to bother triggering an auto-backfill. */
export async function countMissingTmdb(): Promise<{ movies: number; shows: number }> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { movies: 0, shows: 0 };
    const [mc] = await db.select({ c: sql<number>`count(*)::int` })
        .from(movies)
        .where(and(eq(movies.userId, userId), isNull(movies.posterPath)));
    const [sc] = await db.select({ c: sql<number>`count(*)::int` })
        .from(tvShows)
        .where(and(eq(tvShows.userId, userId), isNull(tvShows.posterPath)));
    return { movies: mc?.c ?? 0, shows: sc?.c ?? 0 };
}
