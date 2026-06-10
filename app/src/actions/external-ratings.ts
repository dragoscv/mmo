"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { movies, tvShows } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { fetchExternalRatings } from "@/lib/ratings/scrape";

/**
 * Fetch IMDB + RT + CineMagia scores for a movie and persist to the row.
 * Triggered manually from the detail page (and by the auto-backfill nudge
 * when ratings are stale > 7 days).
 */
export async function refreshMovieRatings(movieId: number) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) throw new Error("unauthorized");

    const row = await db.select().from(movies)
        .where(and(eq(movies.userId, userId), eq(movies.id, movieId)))
        .limit(1).then((r) => r[0]);
    if (!row) throw new Error("not found");

    // Best-effort RT slug from title (RT uses lowercase + underscores).
    const rtSlug = row.title
        ? row.title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
        : null;

    const ratings = await fetchExternalRatings({
        imdbId: row.imdbId,
        rtSlug,
        title: row.title,
        year: row.year,
    });

    await db.update(movies)
        .set({ externalRatings: ratings, externalRatingsFetchedAt: new Date() })
        .where(eq(movies.id, movieId));

    revalidatePath(`/watch/movies/${movieId}`);
    return ratings;
}

export async function refreshShowRatings(showId: number) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) throw new Error("unauthorized");

    const row = await db.select().from(tvShows)
        .where(and(eq(tvShows.userId, userId), eq(tvShows.id, showId)))
        .limit(1).then((r) => r[0]);
    if (!row) throw new Error("not found");

    const rtSlug = row.title
        ? row.title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
        : null;

    const ratings = await fetchExternalRatings({
        imdbId: row.imdbId,
        rtSlug,
        title: row.title,
        year: row.firstAirYear,
    });

    await db.update(tvShows)
        .set({ externalRatings: ratings, externalRatingsFetchedAt: new Date() })
        .where(eq(tvShows.id, showId));

    revalidatePath(`/watch/shows/${showId}`);
    return ratings;
}
