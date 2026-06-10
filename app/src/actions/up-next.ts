"use server";

/** Up Next: for each in-progress series the user has, find the next
 *  un-watched episode. Falls back to S1E1 when no progress exists.
 *  Returns up to `limit` items, ordered by most recently watched. */

import { db } from "@/db";
import { watchHistory, tvShows, tvEpisodes, videoFiles, movies } from "@/db/schema";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { getActiveProfileId } from "@/lib/active-profile";

export interface UpNextItem {
    showId: number;
    showTitle: string;
    posterPath: string | null;
    episodeId: number;
    season: number;
    episode: number;
    episodeTitle: string | null;
    fileId: number | null;
}

export async function getUpNextEpisodes(limit = 12): Promise<UpNextItem[]> {
    const profileId = await getActiveProfileId();
    if (!profileId) return [];

    // Find recently watched episodes; collect their showIds.
    const recent = await db.select({
        showId: tvEpisodes.showId,
        episodeId: watchHistory.episodeId,
        watchedAt: watchHistory.watchedAt,
        season: tvEpisodes.seasonNumber,
        episodeNum: tvEpisodes.episodeNumber,
        completed: watchHistory.completed,
    })
        .from(watchHistory)
        .innerJoin(tvEpisodes, eq(tvEpisodes.id, watchHistory.episodeId))
        .where(and(eq(watchHistory.profileId, profileId), eq(watchHistory.kind, "episode")))
        .orderBy(desc(watchHistory.watchedAt))
        .limit(50);

    if (recent.length === 0) return [];

    // Latest watched episode per showId
    const latestPerShow = new Map<number, typeof recent[number]>();
    for (const r of recent) {
        if (!r.showId) continue;
        const prev = latestPerShow.get(r.showId);
        if (!prev || (r.watchedAt && prev.watchedAt && r.watchedAt > prev.watchedAt)) {
            latestPerShow.set(r.showId, r);
        }
    }

    const showIds = [...latestPerShow.keys()];
    if (showIds.length === 0) return [];

    const showsRows = await db.select().from(tvShows).where(inArray(tvShows.id, showIds));
    const showMap = new Map(showsRows.map((s) => [s.id, s]));

    // For each show, find the next episode AFTER the latest watched (or next
    // unwatched if not completed → return same one).
    const out: UpNextItem[] = [];
    for (const showId of showIds) {
        const last = latestPerShow.get(showId)!;
        const show = showMap.get(showId);
        if (!show) continue;
        // If last episode isn't completed, the "next" is itself (resume).
        const targetEp = last.completed
            ? await db.select().from(tvEpisodes)
                .where(and(
                    eq(tvEpisodes.showId, showId),
                    sql`(${tvEpisodes.seasonNumber} > ${last.season} OR (${tvEpisodes.seasonNumber} = ${last.season} AND ${tvEpisodes.episodeNumber} > ${last.episodeNum}))`,
                ))
                .orderBy(asc(tvEpisodes.seasonNumber), asc(tvEpisodes.episodeNumber))
                .limit(1)
                .then((r) => r[0])
            : await db.select().from(tvEpisodes).where(eq(tvEpisodes.id, last.episodeId!)).limit(1).then((r) => r[0]);
        if (!targetEp) continue;
        const file = await db.select({ id: videoFiles.id }).from(videoFiles)
            .where(eq(videoFiles.episodeId, targetEp.id)).limit(1).then((r) => r[0]);
        out.push({
            showId,
            showTitle: show.title,
            posterPath: show.posterPath,
            episodeId: targetEp.id,
            season: targetEp.seasonNumber,
            episode: targetEp.episodeNumber,
            episodeTitle: targetEp.title,
            fileId: file?.id ?? null,
        });
        if (out.length >= limit) break;
    }
    return out;
}

export interface SimilarMovieRec {
    movieId: number;
    title: string;
    posterPath: string | null;
    year: number | null;
    rating: number | null;
    overview: string | null;
}

/** Recommends unwatched movies of the same genres as recently watched ones. */
export async function getSimilarUnwatchedMovies(limit = 12): Promise<SimilarMovieRec[]> {
    const profileId = await getActiveProfileId();
    if (!profileId) return [];

    // Recently watched movie genres (last 30 movies)
    const watched = await db.select({ movieId: watchHistory.movieId })
        .from(watchHistory)
        .where(and(eq(watchHistory.profileId, profileId), eq(watchHistory.kind, "movie")))
        .orderBy(desc(watchHistory.watchedAt))
        .limit(30);
    const watchedIds = watched.map((w) => w.movieId).filter((id): id is number => id != null);
    if (watchedIds.length === 0) return [];

    const watchedMovies = await db.select({ id: movies.id, genres: movies.genres })
        .from(movies).where(inArray(movies.id, watchedIds));
    const genreCounts = new Map<string, number>();
    for (const m of watchedMovies) {
        const gs = (m.genres as string[] | null) ?? [];
        for (const g of gs) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
    }
    const topGenres = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);
    if (topGenres.length === 0) return [];

    // Candidates: movies with any of the top genres, not in watchedIds
    const candidates = await db.select({
        id: movies.id,
        title: movies.title,
        posterPath: movies.posterPath,
        year: movies.year,
        rating: movies.rating,
        overview: movies.overview,
        genres: movies.genres,
    })
        .from(movies)
        .where(and(
            notInArray(movies.id, watchedIds),
            sql`${movies.genres}::jsonb ?| array[${sql.join(topGenres.map((g) => sql`${g}`), sql`, `)}]`,
        ))
        .orderBy(desc(movies.rating))
        .limit(limit);

    return candidates.map((c) => ({
        movieId: c.id,
        title: c.title,
        posterPath: c.posterPath,
        year: c.year,
        rating: c.rating,
        overview: c.overview,
    }));
}
