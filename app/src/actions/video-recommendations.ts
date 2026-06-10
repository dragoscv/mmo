"use server";

/**
 * Hybrid recommendation engine that mixes:
 *   - "Similar" of recently watched
 *   - "Similar" of highly rated
 *   - TMDB trending filtered by user's preferred genres
 *   - Top-billed cast from rated titles
 *
 * Results exclude items already in the library and items the user
 * marked as hidden (Ban from context menu).
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { movies, tvShows, watchHistory, videoRatings } from "@/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getActiveProfileId } from "@/lib/active-profile";
import {
    tmdbMovieSimilar, tmdbTrending, tmdbPersonCredits,
    type TmdbSearchHit,
} from "@/lib/tmdb";
import { getWatchPrefs } from "./watch-prefs";

interface MovieRecResult {
    items: TmdbSearchHit[];
    /** Map tmdbId -> local DB id so PosterCard can deep-link. */
    localIndex: Map<number, number>;
}

export async function getMovieRecommendations(limit = 24): Promise<MovieRecResult> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { items: [], localIndex: new Map() };
    const profileId = await getActiveProfileId();
    const prefs = await getWatchPrefs();
    const hidden = new Set(prefs.hiddenMovieTmdbIds);

    // 1. Recently watched movies (joined to movies to read tmdbId + genres + cast)
    const recentWatched = profileId
        ? await db.select({ m: movies }).from(watchHistory)
            .innerJoin(movies, eq(movies.id, watchHistory.movieId))
            .where(and(eq(watchHistory.profileId, profileId), eq(movies.userId, userId)))
            .orderBy(desc(watchHistory.watchedAt))
            .limit(20)
        : [];

    // 2. Highly rated movies
    const topRated = profileId
        ? await db.select({ m: movies, r: videoRatings.rating }).from(videoRatings)
            .innerJoin(movies, eq(movies.id, videoRatings.movieId))
            .where(and(eq(videoRatings.profileId, profileId), eq(movies.userId, userId)))
            .orderBy(desc(videoRatings.rating))
            .limit(10)
        : [];

    // Pool the seeds
    type Seed = { tmdbId: number; cast?: Array<{ id: number; name: string }> };
    const seeds = new Map<number, Seed>();
    for (const w of recentWatched) {
        if (w.m.tmdbId) seeds.set(w.m.tmdbId, { tmdbId: w.m.tmdbId, cast: w.m.cast as Seed["cast"] });
    }
    for (const t of topRated) {
        if (t.m.tmdbId) seeds.set(t.m.tmdbId, { tmdbId: t.m.tmdbId, cast: t.m.cast as Seed["cast"] });
    }

    // 3. Fetch similar for up to 5 seeds in parallel
    const seedList = Array.from(seeds.values()).slice(0, 5);
    const similarBatches = await Promise.all(
        seedList.map((s) => tmdbMovieSimilar(s.tmdbId).catch(() => [] as TmdbSearchHit[])),
    );

    // 4. Cast-driven: pick top 2 favorite actors from top-rated, fetch their credits
    const actorIds = new Set<number>();
    for (const t of topRated.slice(0, 3)) {
        const cast = t.m.cast as Array<{ id: number; name: string }> | null;
        if (Array.isArray(cast)) for (const c of cast.slice(0, 2)) if (c.id) actorIds.add(c.id);
    }
    const personBatches = await Promise.all(
        Array.from(actorIds).slice(0, 4).map((id) => tmdbPersonCredits(id).catch(() => [] as TmdbSearchHit[])),
    );

    // 5. Genre-aware trending — pull genres from recent watched, filter trending later
    const favoriteGenreIds = new Set<number>();
    for (const w of recentWatched) {
        const gs = w.m.genres as Array<{ id?: number }> | null;
        if (Array.isArray(gs)) for (const g of gs) if (g.id) favoriteGenreIds.add(g.id);
    }
    const trending = await tmdbTrending("movie", "week").catch(() => [] as TmdbSearchHit[]);

    // Merge with weighted scoring
    const merged = new Map<number, { hit: TmdbSearchHit; score: number }>();
    function add(hit: TmdbSearchHit, weight: number) {
        if (!hit.id || hidden.has(hit.id)) return;
        const existing = merged.get(hit.id);
        if (existing) { existing.score += weight; return; }
        merged.set(hit.id, { hit, score: weight + (hit.vote_average ?? 0) * 0.1 });
    }
    for (const batch of similarBatches) for (const h of batch) add(h, 3);
    for (const batch of personBatches) for (const h of batch) add(h, 2);
    for (const h of trending) {
        const ids = (h.genre_ids ?? []) as number[];
        const matchesGenre = ids.some((id) => favoriteGenreIds.has(id));
        add(h, matchesGenre ? 2 : 0.5);
    }

    // Exclude already-in-library
    const candidateIds = Array.from(merged.keys());
    if (candidateIds.length === 0) return { items: [], localIndex: new Map() };
    const owned = await db.select({ tmdbId: movies.tmdbId }).from(movies)
        .where(and(eq(movies.userId, userId), inArray(movies.tmdbId, candidateIds)));
    const ownedSet = new Set(owned.map((o) => o.tmdbId).filter((x): x is number => x != null));

    const ranked = Array.from(merged.values())
        .filter((x) => x.hit.id != null && !ownedSet.has(x.hit.id))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.hit);

    return { items: ranked, localIndex: new Map() }; // empty local index — by definition not owned
}

export async function getShowRecommendations(limit = 24): Promise<MovieRecResult> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { items: [], localIndex: new Map() };
    const profileId = await getActiveProfileId();
    const prefs = await getWatchPrefs();
    const hidden = new Set(prefs.hiddenShowTmdbIds);

    // Pool seeds: top-rated shows
    const topRated = profileId
        ? await db.select({ s: tvShows, r: videoRatings.rating }).from(videoRatings)
            .innerJoin(tvShows, eq(tvShows.id, videoRatings.showId))
            .where(and(eq(videoRatings.profileId, profileId), eq(tvShows.userId, userId)))
            .orderBy(desc(videoRatings.rating))
            .limit(10)
        : [];

    const { tmdbTvSimilar } = await import("@/lib/tmdb");
    const similarBatches = await Promise.all(
        topRated.slice(0, 5).map((t) => t.s.tmdbId
            ? tmdbTvSimilar(t.s.tmdbId).catch(() => [] as TmdbSearchHit[])
            : Promise.resolve([] as TmdbSearchHit[])),
    );
    const trending = await tmdbTrending("tv", "week").catch(() => [] as TmdbSearchHit[]);

    const merged = new Map<number, { hit: TmdbSearchHit; score: number }>();
    function add(hit: TmdbSearchHit, weight: number) {
        if (!hit.id || hidden.has(hit.id)) return;
        const existing = merged.get(hit.id);
        if (existing) { existing.score += weight; return; }
        merged.set(hit.id, { hit, score: weight + (hit.vote_average ?? 0) * 0.1 });
    }
    for (const batch of similarBatches) for (const h of batch) add(h, 3);
    for (const h of trending) add(h, 1);

    const candidateIds = Array.from(merged.keys());
    if (candidateIds.length === 0) return { items: [], localIndex: new Map() };
    const owned = await db.select({ tmdbId: tvShows.tmdbId }).from(tvShows)
        .where(and(eq(tvShows.userId, userId), inArray(tvShows.tmdbId, candidateIds)));
    const ownedSet = new Set(owned.map((o) => o.tmdbId).filter((x): x is number => x != null));

    const ranked = Array.from(merged.values())
        .filter((x) => x.hit.id != null && !ownedSet.has(x.hit.id))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.hit);

    return { items: ranked, localIndex: new Map() };
}
