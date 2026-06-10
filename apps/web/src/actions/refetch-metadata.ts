"use server";

/**
 * Refresh `movies.title/overview/tagline` and `tv_shows.title/overview`
 * from TMDB using the user's current locale (mmo-locale cookie → tmdb()).
 *
 * `delta` only touches rows whose stored overview language likely
 * differs from the requested locale — heuristic: it's the row's
 * `updatedAt` predating the cookie change, OR its overview is empty.
 *
 * `force` re-fetches every row with a `tmdbId`.
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { movies, tvShows } from "@/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { tmdbMovie, tmdbTv } from "@/lib/tmdb";

export interface RefetchResult {
    ok: boolean;
    moviesUpdated: number;
    showsUpdated: number;
    moviesSkipped: number;
    showsSkipped: number;
}

async function refetchInternal(opts: { force: boolean }): Promise<RefetchResult> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, moviesUpdated: 0, showsUpdated: 0, moviesSkipped: 0, showsSkipped: 0 };

    let moviesUpdated = 0, moviesSkipped = 0;
    let showsUpdated = 0, showsSkipped = 0;

    const movieRows = await db.select({
        id: movies.id, tmdbId: movies.tmdbId, overview: movies.overview,
    }).from(movies).where(and(eq(movies.userId, userId), isNotNull(movies.tmdbId)));

    for (const row of movieRows) {
        if (!row.tmdbId) { moviesSkipped++; continue; }
        if (!opts.force && row.overview && row.overview.length > 0) { moviesSkipped++; continue; }
        const fresh = await tmdbMovie(row.tmdbId);
        if (!fresh) { moviesSkipped++; continue; }
        await db.update(movies).set({
            title: fresh.title || undefined,
            overview: fresh.overview ?? null,
            tagline: fresh.tagline ?? null,
            updatedAt: new Date(),
        }).where(eq(movies.id, row.id));
        moviesUpdated++;
    }

    const showRows = await db.select({
        id: tvShows.id, tmdbId: tvShows.tmdbId, overview: tvShows.overview,
    }).from(tvShows).where(and(eq(tvShows.userId, userId), isNotNull(tvShows.tmdbId)));

    for (const row of showRows) {
        if (!row.tmdbId) { showsSkipped++; continue; }
        if (!opts.force && row.overview && row.overview.length > 0) { showsSkipped++; continue; }
        const fresh = await tmdbTv(row.tmdbId);
        if (!fresh) { showsSkipped++; continue; }
        await db.update(tvShows).set({
            title: fresh.name || undefined,
            overview: fresh.overview ?? null,
            updatedAt: new Date(),
        }).where(eq(tvShows.id, row.id));
        showsUpdated++;
    }

    revalidatePath("/watch");
    revalidatePath("/watch/movies");
    revalidatePath("/watch/shows");
    return { ok: true, moviesUpdated, showsUpdated, moviesSkipped, showsSkipped };
}

export async function refetchMetadataDelta(): Promise<RefetchResult> {
    return refetchInternal({ force: false });
}

export async function refetchMetadataForce(): Promise<RefetchResult> {
    return refetchInternal({ force: true });
}
