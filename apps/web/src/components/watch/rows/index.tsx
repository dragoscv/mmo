/**
 * Row components extracted from `app/watch/page.tsx` (WP11-03) so Media Home
 * and the Watch hub share one implementation. Server components; every
 * loader is wrapped in `safe()` so one failing query never blanks a page.
 */
import { getTranslations } from "next-intl/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { movies, tvEpisodes, tvShows, videoFiles, watchHistory } from "@/db/schema";
import { tmdbTrending } from "@/lib/tmdb";
import { PosterCard } from "@/components/video/poster-card";
import { PosterRow } from "@/components/video/poster-row";
import { getActiveProfileId } from "@/lib/active-profile";
import { getMovieRecommendations, getShowRecommendations } from "@/actions/video-recommendations";
import { fileToTech, pickBestFile } from "@/lib/video-tech";
import { buildMoviePosterProps, buildShowPosterProps, buildTmdbHitPosterProps } from "@/lib/poster-card-builder";

export async function safe<T>(fn: () => Promise<T>, fallback: T, tag: string): Promise<T> {
    try { return await fn(); } catch (err) {
        console.error(`[/watch] ${tag} failed:`, err);
        return fallback;
    }
}

export async function loadTechByMovie(movieIds: number[]) {
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

export async function loadTechByShow(showIds: number[]) {
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

export async function loadLocalTmdbIds(userId: string) {
    const [m, s] = await Promise.all([
        db.select({ tmdbId: movies.tmdbId }).from(movies).where(eq(movies.userId, userId)),
        db.select({ tmdbId: tvShows.tmdbId }).from(tvShows).where(eq(tvShows.userId, userId)),
    ]);
    return {
        movies: new Set(m.map((r) => r.tmdbId).filter((x): x is number => x != null)),
        shows: new Set(s.map((r) => r.tmdbId).filter((x): x is number => x != null)),
    };
}

const EMPTY_LOCAL = () => ({ movies: new Set<number>(), shows: new Set<number>() });

export function RowSkeleton({ title }: { title: string }) {
    return (
        <section className="watch-row">
            <header className="watch-row-head"><h2>{title}</h2></header>
            <div className="watch-row-scroll" style={{ opacity: 0.4 }}>
                {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} style={{ flex: "0 0 var(--watch-poster-w)", aspectRatio: "2/3", borderRadius: "var(--watch-radius)", background: "var(--watch-surface)" }} />
                ))}
            </div>
        </section>
    );
}

export async function ContinueWatchingRow() {
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

export async function RecentMoviesRow({ userId }: { userId: string }) {
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

export async function RecentShowsRow({ userId }: { userId: string }) {
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

export async function TrendingRow({ userId }: { userId: string }) {
    const trending = await safe(() => tmdbTrending("movie", "week"), [], "tmdb-trending");
    if (trending.length === 0) return null;
    const local = await safe(() => loadLocalTmdbIds(userId), EMPTY_LOCAL(), "local-index");
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

export async function ForYouMoviesRow() {
    const session = await auth();
    const userId = session?.user?.id ?? "";
    const { items } = await safe(() => getMovieRecommendations(20), { items: [], localIndex: new Map() }, "rec-movies");
    if (items.length === 0) return null;
    const local = await safe(() => loadLocalTmdbIds(userId), EMPTY_LOCAL(), "local-index-fyou-m");
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

export async function ForYouShowsRow() {
    const session = await auth();
    const userId = session?.user?.id ?? "";
    const { items } = await safe(() => getShowRecommendations(20), { items: [], localIndex: new Map() }, "rec-shows");
    if (items.length === 0) return null;
    const local = await safe(() => loadLocalTmdbIds(userId), EMPTY_LOCAL(), "local-index-fyou-s");
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
