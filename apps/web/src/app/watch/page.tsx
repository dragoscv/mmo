import { Suspense } from "react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { movies, tvShows, videoFiles } from "@/db/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { WatchHero, type HeroFeature } from "@/components/video/watch-hero";
import { AutoBackfill } from "@/components/video/auto-backfill";
import { CompanionOfflineBanner } from "@/components/companion/companion-offline-banner";
import { UpNextRow } from "@/components/watch/up-next-row";
import { WatchlistRow } from "@/components/watch/watchlist-row";
import {
    ContinueWatchingRow, ForYouMoviesRow, ForYouShowsRow, RecentMoviesRow, RecentShowsRow, RowSkeleton, TrendingRow, safe,
} from "@/components/watch/rows";
import { getWatchPrefs } from "@/actions/watch-prefs";
import { notSignedInFor } from "@/components/empty-state-server";

export const dynamic = "force-dynamic";

export default async function WatchHome() {
    const session = await auth();
    const userId = session?.user?.id;
    const t = await getTranslations("watch.rows");
    if (!userId) return notSignedInFor("watch");

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
