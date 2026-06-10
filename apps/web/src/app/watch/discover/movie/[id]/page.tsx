import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { db } from "@/db";
import { movies } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
    tmdbMovie,
    tmdbMovieCredits,
    tmdbMovieVideos,
    tmdbMovieSimilar,
    tmdbMovieRecommendations,
    tmdbWatchProvidersMulti,
} from "@/lib/tmdb";
import { getCompanionVideoFlags } from "@/lib/companion-video";
import { getWatchPrefs } from "@/actions/watch-prefs";
import { MovieDetailLayout } from "@/components/video/movie-detail-layout";
import { TrailerButton } from "@/components/video/trailer-modal";
import { StreamSourcePicker } from "@/components/video/stream-source-picker";
import { ExternalProvidersRow } from "@/components/video/external-providers-row";

export const dynamic = "force-dynamic";

export default async function DiscoverMovie({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const tmdbId = parseInt(id, 10);
    if (!Number.isFinite(tmdbId)) notFound();

    const session = await auth();
    const userId = session?.user?.id;

    // If the user already has this movie locally, jump straight to its page.
    if (userId) {
        const local = await db.select({ id: movies.id }).from(movies)
            .where(and(eq(movies.userId, userId), eq(movies.tmdbId, tmdbId)))
            .limit(1);
        if (local[0]) redirect(`/watch/movies/${local[0].id}`);
    }

    const prefs = await getWatchPrefs();
    const [tm, credits, videos, providers, similarHits, recHits, flags] = await Promise.all([
        tmdbMovie(tmdbId),
        tmdbMovieCredits(tmdbId),
        tmdbMovieVideos(tmdbId),
        tmdbWatchProvidersMulti("movie", tmdbId, prefs.regions),
        tmdbMovieSimilar(tmdbId).catch(() => []),
        tmdbMovieRecommendations(tmdbId).catch(() => []),
        getCompanionVideoFlags(),
    ]);
    if (!tm) notFound();

    const trailer = videos.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official)
        ?? videos.find((v) => v.site === "YouTube" && v.type === "Trailer");
    const year = tm.release_date ? parseInt(tm.release_date.slice(0, 4), 10) : null;

    // Build local-index for similar/rec rows so any already-owned title links to /watch/movies/[id].
    let localIndex: Map<number, number> | undefined;
    if (userId) {
        const ids = Array.from(new Set([...similarHits, ...recHits].map((h) => h.id))).filter((x): x is number => !!x);
        const matches = ids.length
            ? await db.select({ id: movies.id, tmdbId: movies.tmdbId }).from(movies)
                .where(and(eq(movies.userId, userId), inArray(movies.tmdbId, ids)))
            : [];
        localIndex = new Map<number, number>();
        for (const m of matches) if (m.tmdbId != null) localIndex.set(m.tmdbId, m.id);
    }

    const director = credits?.crew.find((c) => c.job === "Director");

    return (
        <MovieDetailLayout
            title={tm.title}
            tagline={tm.tagline ?? null}
            overview={tm.overview ?? null}
            year={year}
            runtimeMinutes={tm.runtime ?? null}
            rating={tm.vote_average ?? null}
            genres={tm.genres ?? []}
            posterPath={tm.poster_path ?? null}
            backdropPath={tm.backdrop_path ?? null}
            trailerYoutubeId={trailer?.key ?? null}
            posterTransitionName={`tmdb-movie-${tm.id}`}
            backHref="/watch"
            backLabel="Înapoi"
            eyebrow={<span>Pe TMDB · neîn bibliotecă</span>}
            primaryActions={
                <>
                    <TrailerButton trailerYoutubeId={trailer?.key} title={tm.title} variant="primary" />
                    <Link href={`/search?q=${encodeURIComponent(tm.title)}`} className="watch-cta">
                        🔍 Caută local
                    </Link>
                    <a
                        href={`https://www.themoviedb.org/movie/${tmdbId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="watch-cta"
                    >
                        Vezi pe TMDB ↗
                    </a>
                </>
            }
            creatorLine={director ? (
                <>Director: <strong style={{ color: "var(--watch-fg)" }}>{director.name}</strong></>
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
            streamPicker={
                flags?.vidsrcEnabled ? (
                    <section style={{ padding: "1.5rem" }}>
                        <h2 className="watch-row-title">External sources</h2>
                        <StreamSourcePicker kind="movie" tmdbId={tmdbId} />
                    </section>
                ) : null
            }
            similar={similarHits}
            recommendations={recHits}
            localIndex={localIndex}
            kind="movie"
        />
    );
}
