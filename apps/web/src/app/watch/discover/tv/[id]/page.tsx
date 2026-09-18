import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { db } from "@/db";
import { tvShows } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
    tmdbTv,
    tmdbTvCredits,
    tmdbTvVideos,
    tmdbTvSimilar,
    tmdbTvRecommendations,
    tmdbWatchProvidersMulti,
} from "@/lib/tmdb";
import { getWatchPrefs } from "@/actions/watch-prefs";
import { MovieDetailLayout } from "@/components/video/movie-detail-layout";
import { TrailerButton } from "@/components/video/trailer-modal";
import { ExternalProvidersRow } from "@/components/video/external-providers-row";

export const dynamic = "force-dynamic";

export default async function DiscoverTv({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const tmdbId = parseInt(id, 10);
    if (!Number.isFinite(tmdbId)) notFound();

    const session = await auth();
    const userId = session?.user?.id;

    if (userId) {
        const local = await db.select({ id: tvShows.id }).from(tvShows)
            .where(and(eq(tvShows.userId, userId), eq(tvShows.tmdbId, tmdbId)))
            .limit(1);
        if (local[0]) redirect(`/watch/shows/${local[0].id}`);
    }

    const prefs = await getWatchPrefs();
    const [tv, credits, videos, providers, similarHits, recHits] = await Promise.all([
        tmdbTv(tmdbId),
        tmdbTvCredits(tmdbId),
        tmdbTvVideos(tmdbId),
        tmdbWatchProvidersMulti("tv", tmdbId, prefs.regions),
        tmdbTvSimilar(tmdbId).catch(() => []),
        tmdbTvRecommendations(tmdbId).catch(() => []),
    ]);
    if (!tv) notFound();

    const trailer = videos.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official)
        ?? videos.find((v) => v.site === "YouTube" && v.type === "Trailer");
    const year = tv.first_air_date ? parseInt(tv.first_air_date.slice(0, 4), 10) : null;
    const title = tv.name;

    let localIndex: Map<number, number> | undefined;
    if (userId) {
        const ids = Array.from(new Set([...similarHits, ...recHits].map((h) => h.id))).filter((x): x is number => !!x);
        const matches = ids.length
            ? await db.select({ id: tvShows.id, tmdbId: tvShows.tmdbId }).from(tvShows)
                .where(and(eq(tvShows.userId, userId), inArray(tvShows.tmdbId, ids)))
            : [];
        localIndex = new Map<number, number>();
        for (const m of matches) if (m.tmdbId != null) localIndex.set(m.tmdbId, m.id);
    }

    const creator = credits?.crew.find((c) => c.job === "Creator" || c.job === "Executive Producer");

    return (
        <MovieDetailLayout
            title={title}
            tagline={null}
            overview={tv.overview ?? null}
            year={year}
            runtimeMinutes={null}
            rating={tv.vote_average ?? null}
            genres={tv.genres ?? []}
            posterPath={tv.poster_path ?? null}
            backdropPath={tv.backdrop_path ?? null}
            trailerYoutubeId={trailer?.key ?? null}
            posterTransitionName={`tmdb-show-${tv.id}`}
            backHref="/watch"
            backLabel="Înapoi"
            eyebrow={<span>Pe TMDB · neîn bibliotecă</span>}
            heroExtraPills={
                <>
                    {tv.number_of_seasons ? (
                        <span className="watch-pill">{tv.number_of_seasons} {tv.number_of_seasons === 1 ? "sezon" : "sezoane"}</span>
                    ) : null}
                    {tv.number_of_episodes ? (
                        <span className="watch-pill">{tv.number_of_episodes} ep.</span>
                    ) : null}
                </>
            }
            primaryActions={
                <>
                    <TrailerButton trailerYoutubeId={trailer?.key} title={title} variant="primary" />
                    <Link href={`/search?q=${encodeURIComponent(title)}`} className="watch-cta">
                        🔍 Caută local
                    </Link>
                    <a
                        href={`https://www.themoviedb.org/tv/${tmdbId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="watch-cta"
                    >
                        Vezi pe TMDB ↗
                    </a>
                </>
            }
            creatorLine={creator ? (
                <>{creator.job === "Creator" ? "Creator" : "Producător executiv"}: <strong style={{ color: "var(--watch-fg)" }}>{creator.name}</strong></>
            ) : undefined}
            cast={credits?.cast ?? []}
            providers={
                providers && (providers.flatrate?.length || providers.rent?.length || providers.free?.length || providers.buy?.length) ? (
                    <ExternalProvidersRow
                        link={providers.link}
                        flatrate={providers.flatrate}
                        rent={providers.rent}
                        buy={providers.buy}
                        free={providers.free}
                    />
                ) : null
            }
            similar={similarHits}
            recommendations={recHits}
            localIndex={localIndex}
            kind="tv"
        />
    );
}
