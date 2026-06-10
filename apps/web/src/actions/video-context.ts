"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { movies, tvShows, videoCollections, videoCollectionItems, videoRatings, watchHistory, watchProfiles } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getActiveProfileId, ensureDefaultWatchProfile } from "@/lib/active-profile";
import { revalidatePath } from "next/cache";
import { tmdbMovie, tmdbTv, tmdbMovieCredits, tmdbTvCredits, tmdbMovieVideos, tmdbTvVideos, pickTrailer } from "@/lib/tmdb";

async function activeProfile(): Promise<number | null> {
    let id = await getActiveProfileId();
    if (!id) id = await ensureDefaultWatchProfile();
    return id;
}

export async function markUnwatched(input: { movieId?: number; episodeId?: number }) {
    const session = await auth();
    if (!session?.user?.id) return { error: "unauthorized" } as const;
    const profileId = await activeProfile();
    if (!profileId) return { error: "no profile" } as const;
    const where = input.movieId
        ? and(eq(watchHistory.profileId, profileId), eq(watchHistory.movieId, input.movieId))
        : input.episodeId
            ? and(eq(watchHistory.profileId, profileId), eq(watchHistory.episodeId, input.episodeId))
            : null;
    if (!where) return { error: "no target" } as const;
    await db.delete(watchHistory).where(where);
    revalidatePath("/watch");
    return { ok: true } as const;
}

export async function rateItem(input: { movieId?: number; showId?: number; rating: number | null }) {
    const session = await auth();
    if (!session?.user?.id) return { error: "unauthorized" } as const;
    const profileId = await activeProfile();
    if (!profileId) return { error: "no profile" } as const;
    if (input.rating !== null && (input.rating < 1 || input.rating > 10)) {
        return { error: "rating out of range" } as const;
    }
    const where = input.movieId
        ? and(eq(videoRatings.profileId, profileId), eq(videoRatings.movieId, input.movieId))
        : input.showId
            ? and(eq(videoRatings.profileId, profileId), eq(videoRatings.showId, input.showId))
            : null;
    if (!where) return { error: "no target" } as const;

    if (input.rating === null) {
        await db.delete(videoRatings).where(where);
    } else {
        const existing = await db.select().from(videoRatings).where(where).limit(1);
        if (existing[0]) {
            await db.update(videoRatings).set({ rating: input.rating, ratedAt: new Date() }).where(eq(videoRatings.id, existing[0].id));
        } else {
            await db.insert(videoRatings).values({
                profileId,
                kind: input.movieId ? "movie" : "show",
                movieId: input.movieId ?? null,
                showId: input.showId ?? null,
                rating: input.rating,
            });
        }
    }
    revalidatePath("/watch");
    return { ok: true } as const;
}

export async function addToCustomCollection(input: { collectionId: number; movieId?: number; showId?: number }) {
    const session = await auth();
    if (!session?.user?.id) return { error: "unauthorized" } as const;
    const profileId = await activeProfile();
    if (!profileId) return { error: "no profile" } as const;
    // Verify ownership of the collection
    const coll = await db.select().from(videoCollections)
        .where(and(eq(videoCollections.id, input.collectionId), eq(videoCollections.profileId, profileId)))
        .limit(1);
    if (!coll[0]) return { error: "not found" } as const;
    await db.insert(videoCollectionItems).values({
        collectionId: input.collectionId,
        kind: input.movieId ? "movie" : "show",
        movieId: input.movieId ?? null,
        showId: input.showId ?? null,
    });
    revalidatePath("/watch/collections");
    return { ok: true } as const;
}

export async function listCustomCollections() {
    const session = await auth();
    if (!session?.user?.id) return [] as Array<{ id: number; name: string; kind: string }>;
    const profileId = await activeProfile();
    if (!profileId) return [];
    const rows = await db.select({
        id: videoCollections.id, name: videoCollections.name, kind: videoCollections.kind,
    }).from(videoCollections)
        .innerJoin(watchProfiles, eq(watchProfiles.id, videoCollections.profileId))
        .where(eq(videoCollections.profileId, profileId));
    return rows;
}

/** Re-fetch TMDB metadata for a single movie or show. */
export async function refreshMetadata(input: { movieId?: number; showId?: number }) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { error: "unauthorized" } as const;

    if (input.movieId) {
        const row = await db.select().from(movies).where(and(eq(movies.userId, userId), eq(movies.id, input.movieId))).limit(1);
        if (!row[0]?.tmdbId) return { error: "no tmdb" } as const;
        const tmdb = await tmdbMovie(row[0].tmdbId);
        if (!tmdb) return { error: "tmdb fetch failed" } as const;
        const credits = await tmdbMovieCredits(tmdb.id).catch(() => null);
        const videos = await tmdbMovieVideos(tmdb.id).catch(() => null);
        const trailer = videos ? pickTrailer(videos) : null;
        await db.update(movies).set({
            imdbId: tmdb.imdb_id ?? row[0].imdbId,
            title: tmdb.title ?? row[0].title,
            overview: tmdb.overview ?? row[0].overview,
            tagline: tmdb.tagline ?? row[0].tagline,
            runtimeMinutes: tmdb.runtime ?? row[0].runtimeMinutes,
            posterPath: tmdb.poster_path ?? row[0].posterPath,
            backdropPath: tmdb.backdrop_path ?? row[0].backdropPath,
            trailerYoutubeId: trailer?.key ?? row[0].trailerYoutubeId,
            genres: tmdb.genres ?? row[0].genres,
            cast: credits?.cast ? credits.cast.slice(0, 20) : row[0].cast,
            crew: credits?.crew ? credits.crew.filter((c) => ["Director", "Writer", "Producer"].includes(c.job)).slice(0, 10) : row[0].crew,
            rating: tmdb.vote_average ?? row[0].rating,
            ratingCount: tmdb.vote_count ?? row[0].ratingCount,
            updatedAt: new Date(),
        }).where(eq(movies.id, row[0].id));
        revalidatePath(`/watch/movies/${input.movieId}`);
        return { ok: true } as const;
    }
    if (input.showId) {
        const row = await db.select().from(tvShows).where(and(eq(tvShows.userId, userId), eq(tvShows.id, input.showId))).limit(1);
        if (!row[0]?.tmdbId) return { error: "no tmdb" } as const;
        const tmdb = await tmdbTv(row[0].tmdbId);
        if (!tmdb) return { error: "tmdb fetch failed" } as const;
        const credits = await tmdbTvCredits(tmdb.id).catch(() => null);
        const videos = await tmdbTvVideos(tmdb.id).catch(() => null);
        const trailer = videos ? pickTrailer(videos) : null;
        await db.update(tvShows).set({
            title: tmdb.name ?? row[0].title,
            overview: tmdb.overview ?? row[0].overview,
            posterPath: tmdb.poster_path ?? row[0].posterPath,
            backdropPath: tmdb.backdrop_path ?? row[0].backdropPath,
            trailerYoutubeId: trailer?.key ?? row[0].trailerYoutubeId,
            genres: tmdb.genres ?? row[0].genres,
            cast: credits?.cast ? credits.cast.slice(0, 20) : row[0].cast,
            rating: tmdb.vote_average ?? row[0].rating,
            ratingCount: tmdb.vote_count ?? row[0].ratingCount,
            status: tmdb.status ?? row[0].status,
            updatedAt: new Date(),
        }).where(eq(tvShows.id, row[0].id));
        revalidatePath(`/watch/shows/${input.showId}`);
        return { ok: true } as const;
    }
    return { error: "no target" } as const;
}
