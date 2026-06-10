import { Suspense } from "react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { movies, tvShows, tvEpisodes, videoFiles, watchHistory } from "@/db/schema";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { tmdbTrending } from "@/lib/tmdb";
import { PosterCard } from "@/components/video/poster-card";
import { PosterRow } from "@/components/video/poster-row";
import { WatchHero, type HeroFeature } from "@/components/video/watch-hero";
import { AutoBackfill } from "@/components/video/auto-backfill";
import { getActiveProfileId } from "@/lib/active-profile";
import { CompanionOfflineBanner } from "@/components/companion/companion-offline-banner";
import { UpNextRow } from "@/components/watch/up-next-row";
import { WatchlistRow } from "@/components/watch/watchlist-row";
import { getMovieRecommendations, getShowRecommendations } from "@/actions/video-recommendations";
import { fileToTech, pickBestFile } from "@/lib/video-tech";
import { buildMoviePosterProps, buildShowPosterProps, buildTmdbHitPosterProps } from "@/lib/poster-card-builder";
import { getWatchPrefs } from "@/actions/watch-prefs";

export const dynamic = "force-dynamic";

async function safe<T>(fn: () => Promise<T>, fallback: T, tag: string): Promise<T> {
    try { return await fn(); } catch (err) {
        console.error(`[/watch] ${tag} failed:`, err);
        return fallback;
    }
}

async function loadTechByMovie(movieIds: number[]) {
    const map = new Map<number, ReturnType<typeof fileToTech>>();
    if (movieIds.length === 0) return map;
    const rows = await db.select({
        movieId: videoFiles.movieId,
        width: videoFiles.width, height: videoFiles.height,
        hdr: videoFiles.hdr, videoCodec: videoFiles.videoCodec,
        audioCodec: videoFiles.audioCodec, bitrateKbps: videoFiles.bitrateKbps,
        audioTracks: videoFiles.audioTracks, subtitleTracks: videoFiles.subtitleTracks,
    }).from(videoFiles).where(inArray(videoFiles.movieId, movieIds));
    const grouped = new Map<number, typeof rows>();
    for (const r of rows) {
        if (r.movieId == null) continue;
        const arr = grouped.get(r.movieId) ?? [];
        arr.push(r);
        grouped.set(r.movieId, arr);
    }
    for (const [id, arr] of grouped) map.set(id, fileToTech(pickBestFile(arr)));
    return map;
}

async function loadTechByShow(showIds: number[]) {
    const map = new Map<number, ReturnType<typeof fileToTech>>();
    if (showIds.length === 0) return map;
    const rows = await db.select({
        showId: tvEpisodes.showId,
        width: videoFiles.width, height: videoFiles.height,
        hdr: videoFiles.hdr, videoCodec: videoFiles.videoCodec,
        audioCodec: videoFiles.audioCodec, bitrateKbps: videoFiles.bitrateKbps,
        audioTracks: videoFiles.audioTracks, subtitleTracks: videoFiles.subtitleTracks,
    }).from(videoFiles)
        .innerJoin(tvEpisodes, eq(tvEpisodes.id, videoFiles.episodeId))
        .where(inArray(tvEpisodes.showId, showIds));
    const grouped = new Map<number, typeof rows>();
    for (const r of rows) {
        if (r.showId == null) continue;
        const arr = grouped.get(r.showId) ?? [];
        arr.push(r);
        grouped.set(r.showId, arr);
    }
    for (const [id, arr] of grouped) map.set(id, fileToTech(pickBestFile(arr)));
    return map;
}

async function loadLocalTmdbIds(userId: string) {
    const [m, s] = await Promise.all([
        db.select({ tmdbId: movies.tmdbId }).from(movies).where(eq(movies.userId, userId)),
        db.select({ tmdbId: tvShows.tmdbId }).from(tvShows).where(eq(tvShows.userId, userId)),
    ]);
    return {
        movies: new Set(m.map((r) => r.tmdbId).filter((x): x is number => x != null)),
        shows: new Set(s.map((r) => r.tmdbId).filter((x): x is number => x != null)),
    };
}

export default async function WatchHome() {
    const session = await auth();
    const userId = session?.user?.id;
    const t = await getTranslations("watch.rows");
    if (!userId) {
        return (
            <div style={{ padding: "4rem 2rem" }}>
                <h1>Watch</h1>
                <p>Autentifică-te pentru a-ți vedea biblioteca.</p>
            </div>
        );
    }

    const hasLocalSeed = await safe(
        () => db.select({ id: videoFiles.id }).from(videoFiles).where(eq(videoFiles.userId, userId)).limit(1),
        [],
        "local-seed",
    );
    const hasLocal = hasLocalSeed.length > 0;

    const heroFeature = await safe(() => pickHero(userId), null, "hero");
    const prefs = await safe(() => getWatchPrefs(), null, "watch-prefs");
    const localOnly = prefs?.localOnly ?? false;

    return (
        <main>
            <WatchHero feature={heroFeature} />

            <AutoBackfill />

            <CompanionOfflineBanner />

            <Suspense fallback={<RowSkeleton title={t("continue")} />}>
                <ContinueWatchingRow />
            </Suspense>

            <Suspense fallback={<RowSkeleton title="Up Next" />}>
                <UpNextRow />
            </Suspense>

            <Suspense fallback={<RowSkeleton title="Watchlist" />}>
                <WatchlistRow />
            </Suspense>

            {!localOnly && (
                <>
                    <Suspense fallback={<RowSkeleton title={t("forYouMovies")} />}>
                        <ForYouMoviesRow />
                    </Suspense>

                    <Suspense fallback={<RowSkeleton title={t("forYouShows")} />}>
                        <ForYouShowsRow />
                    </Suspense>
                </>
            )}

            <Suspense fallback={<RowSkeleton title={t("recentMovies")} />}>
                <RecentMoviesRow userId={userId} />
            </Suspense>

            <Suspense fallback={<RowSkeleton title={t("recentShows")} />}>
                <RecentShowsRow userId={userId} />
            </Suspense>

            {!localOnly && (
                <Suspense fallback={<RowSkeleton title={t("trending")} />}>
                    <TrendingRow userId={userId} />
                </Suspense>
            )}

            {!hasLocal && (
                <div className="watch-empty">
                    <p>Configurează un companion și rulează un scan pentru a-ți vedea filmele locale.</p>
                    <p style={{ marginTop: "1rem" }}>
                        <Link href="/settings" className="watch-btn watch-btn-ghost">Setări &rarr;</Link>
                    </p>
                </div>
            )}
        </main>
    );
}

async function pickHero(userId: string): Promise<HeroFeature | null> {
    const movieRow = await db.select().from(movies)
        .where(and(eq(movies.userId, userId), isNotNull(movies.backdropPath), isNotNull(movies.overview)))
        .orderBy(sql`random()`)
        .limit(1);
    if (movieRow[0]) {
        const m = movieRow[0];
        const genres = Array.isArray(m.genres) ? (m.genres as Array<{ name: string }>).map((g) => g.name).slice(0, 3) : [];
        return {
            id: m.id, kind: "movie", title: m.title, overview: m.overview,
            backdropPath: m.backdropPath, year: m.year, runtime: m.runtimeMinutes,
            rating: m.rating, genres,
        };
    }
    const showRow = await db.select().from(tvShows)
        .where(and(eq(tvShows.userId, userId), isNotNull(tvShows.backdropPath), isNotNull(tvShows.overview)))
        .orderBy(sql`random()`)
        .limit(1);
    if (showRow[0]) {
        const s = showRow[0];
        const genres = Array.isArray(s.genres) ? (s.genres as Array<{ name: string }>).map((g) => g.name).slice(0, 3) : [];
        return {
            id: s.id, kind: "show", title: s.title, overview: s.overview,
            backdropPath: s.backdropPath, year: s.firstAirYear, runtime: null,
            rating: s.rating, genres,
        };
    }
    return null;
}

function RowSkeleton({ title }: { title: string }) {
    return (
        <section className="watch-row">
            <header className="watch-row-head"><h2>{title}</h2></header>
            <div className="watch-row-scroll" style={{ opacity: 0.4 }}>
                {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} style={{ flex: "0 0 var(--watch-poster-w)", aspectRatio: "2/3", borderRadius: "var(--watch-radius)", background: "rgba(255,255,255,0.04)" }} />
                ))}
            </div>
        </section>
    );
}

async function ContinueWatchingRow() {
    const profileId = await safe(() => getActiveProfileId(), null, "active-profile");
    if (!profileId) return null;
    const rows = await safe(
        () => db.select({ h: watchHistory, m: movies }).from(watchHistory)
            .leftJoin(movies, eq(movies.id, watchHistory.movieId))
            .where(and(eq(watchHistory.profileId, profileId), eq(watchHistory.completed, false)))
            .orderBy(desc(watchHistory.watchedAt))
            .limit(15),
        [],
        "continue-watching",
    );
    if (rows.length === 0) return null;
    const movieIds = rows.map((r) => r.m?.id).filter((x): x is number => x != null);
    const techMap = await safe(() => loadTechByMovie(movieIds), new Map(), "continue-tech");
    const t = await getTranslations("watch.rows");
    return (
        <PosterRow title={t("continue")} glow seeAllHref="/watch/continue">
            {rows.map(({ h, m }) => m ? (
                <PosterCard
                    key={h.id}
                    {...buildMoviePosterProps(m, {
                        progress: h.durationSec && h.durationSec > 0 ? h.positionSec / h.durationSec : undefined,
                        resumeSec: h.positionSec ?? undefined,
                    })}
                    preview={{
                        backdropPath: m.backdropPath,
                        runtime: m.runtimeMinutes,
                        ageRating: m.ageRating,
                        tech: techMap.get(m.id) ?? null,
                    }}
                />
            ) : null)}
        </PosterRow>
    );
}

async function RecentMoviesRow({ userId }: { userId: string }) {
    const rows = await safe(
        () => db.select().from(movies).where(eq(movies.userId, userId)).orderBy(desc(movies.addedAt)).limit(20),
        [],
        "recent-movies",
    );
    if (rows.length === 0) return null;
    const techMap = await safe(() => loadTechByMovie(rows.map((m) => m.id)), new Map(), "recent-movies-tech");
    const t = await getTranslations("watch.rows");
    return (
        <PosterRow title={t("recentMovies")} seeAllHref="/watch/movies">
            {rows.map((m) => (
                <PosterCard
                    key={m.id}
                    {...buildMoviePosterProps(m)}
                    preview={{
                        backdropPath: m.backdropPath,
                        runtime: m.runtimeMinutes,
                        ageRating: m.ageRating,
                        tech: techMap.get(m.id) ?? null,
                    }}
                />
            ))}
        </PosterRow>
    );
}

async function RecentShowsRow({ userId }: { userId: string }) {
    const rows = await safe(
        () => db.select().from(tvShows).where(eq(tvShows.userId, userId)).orderBy(desc(tvShows.addedAt)).limit(20),
        [],
        "recent-shows",
    );
    if (rows.length === 0) return null;
    const techMap = await safe(() => loadTechByShow(rows.map((s) => s.id)), new Map(), "recent-shows-tech");
    const t = await getTranslations("watch.rows");
    return (
        <PosterRow title={t("recentShows")} seeAllHref="/watch/shows">
            {rows.map((s) => (
                <PosterCard
                    key={s.id}
                    {...buildShowPosterProps(s)}
                    preview={{
                        backdropPath: s.backdropPath,
                        ageRating: s.ageRating,
                        tech: techMap.get(s.id) ?? null,
                    }}
                />
            ))}
        </PosterRow>
    );
}

async function TrendingRow({ userId }: { userId: string }) {
    const trending = await safe(() => tmdbTrending("movie", "week"), [], "tmdb-trending");
    if (trending.length === 0) return null;
    const local = await safe(() => loadLocalTmdbIds(userId), { movies: new Set<number>(), shows: new Set<number>() }, "local-index");
    const t = await getTranslations("watch.rows");
    return (
        <PosterRow title={t("trending")} glow>
            {trending.slice(0, 20).map((it) => (
                <PosterCard
                    key={it.id}
                    {...buildTmdbHitPosterProps(it, "movie", { isLocal: local.movies.has(it.id) })}
                />
            ))}
        </PosterRow>
    );
}

async function ForYouMoviesRow() {
    const session = await auth();
    const userId = session?.user?.id ?? "";
    const { items } = await safe(() => getMovieRecommendations(20), { items: [], localIndex: new Map() }, "rec-movies");
    if (items.length === 0) return null;
    const local = await safe(() => loadLocalTmdbIds(userId), { movies: new Set<number>(), shows: new Set<number>() }, "local-index-fyou-m");
    const t = await getTranslations("watch.rows");
    return (
        <PosterRow title={t("forYouMovies")} glow>
            {items.map((it) => (
                <PosterCard
                    key={`rec-m-${it.id}`}
                    {...buildTmdbHitPosterProps(it, "movie", { isLocal: local.movies.has(it.id) })}
                />
            ))}
        </PosterRow>
    );
}

async function ForYouShowsRow() {
    const session = await auth();
    const userId = session?.user?.id ?? "";
    const { items } = await safe(() => getShowRecommendations(20), { items: [], localIndex: new Map() }, "rec-shows");
    if (items.length === 0) return null;
    const local = await safe(() => loadLocalTmdbIds(userId), { movies: new Set<number>(), shows: new Set<number>() }, "local-index-fyou-s");
    const t = await getTranslations("watch.rows");
    return (
        <PosterRow title={t("forYouShows")}>
            {items.map((it) => (
                <PosterCard
                    key={`rec-s-${it.id}`}
                    {...buildTmdbHitPosterProps(it, "tv", { isLocal: local.shows.has(it.id) })}
                />
            ))}
        </PosterRow>
    );
}
