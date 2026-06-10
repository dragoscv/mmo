import { auth } from "@/auth";
import { db } from "@/db";
import { tvShows, tvEpisodes, tvSeasons, videoFiles } from "@/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { PlayHereButton } from "@/components/video/play-here-button";
import { PlayNextButton, AddToQueueButton } from "@/components/video/queue-buttons";
import { MarkWatchedButton } from "@/components/video/mark-watched-button";
import { ExternalRatingsPanel } from "@/components/video/external-ratings-panel";
import { StreamSourcePicker } from "@/components/video/stream-source-picker";
import { ExternalProvidersRow } from "@/components/video/external-providers-row";
import { TrailerButton } from "@/components/video/trailer-modal";
import { MovieDetailLayout } from "@/components/video/movie-detail-layout";
import { refreshShowRatings } from "@/actions/external-ratings";
import { getCompanionVideoFlags } from "@/lib/companion-video";
import { tmdbWatchProvidersMulti, tmdbTvSimilar, tmdbTvRecommendations } from "@/lib/tmdb";
import { getWatchPrefs } from "@/actions/watch-prefs";
import type { ExternalRatings } from "@/lib/ratings/scrape";

export const dynamic = "force-dynamic";

export default async function ShowDetail({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const showId = Number(id);
    if (!Number.isFinite(showId)) return notFound();

    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return notFound();

    const show = await db.select().from(tvShows)
        .where(and(eq(tvShows.userId, userId), eq(tvShows.id, showId)))
        .limit(1).then(r => r[0]);
    if (!show) return notFound();

    const episodes = await db.select().from(tvEpisodes)
        .where(eq(tvEpisodes.showId, showId))
        .orderBy(asc(tvEpisodes.seasonNumber), asc(tvEpisodes.episodeNumber));

    const allEpisodeIds = episodes.map((e) => e.id);
    const fileRows = allEpisodeIds.length > 0
        ? await db.select().from(videoFiles).where(eq(videoFiles.userId, userId))
        : [];
    const epFile = new Map<number, number>();
    for (const f of fileRows) if (f.episodeId) epFile.set(f.episodeId, f.id);

    const bySeason = new Map<number, typeof episodes>();
    for (const e of episodes) {
        const arr = bySeason.get(e.seasonNumber) ?? [];
        arr.push(e);
        bySeason.set(e.seasonNumber, arr);
    }

    const prefs = await getWatchPrefs();
    const [flags, providers, similarHits, recHits, seasonRows] = await Promise.all([
        getCompanionVideoFlags(),
        show.tmdbId ? tmdbWatchProvidersMulti("tv", show.tmdbId, prefs.regions) : null,
        show.tmdbId ? tmdbTvSimilar(show.tmdbId).catch(() => []) : Promise.resolve([]),
        show.tmdbId ? tmdbTvRecommendations(show.tmdbId).catch(() => []) : Promise.resolve([]),
        db.select().from(tvSeasons).where(eq(tvSeasons.showId, showId)).orderBy(asc(tvSeasons.seasonNumber)),
    ]);

    const seasonsForPicker = seasonRows
        .filter((s) => s.seasonNumber > 0)
        .map((s) => ({
            season: s.seasonNumber,
            episodeCount: s.episodeCount ?? bySeason.get(s.seasonNumber)?.length ?? 1,
            label: s.name ?? `Sezonul ${s.seasonNumber}`,
        }));
    if (seasonsForPicker.length === 0) {
        for (const [season, eps] of bySeason.entries()) {
            if (season > 0) seasonsForPicker.push({ season, episodeCount: eps.length, label: `Sezonul ${season}` });
        }
        seasonsForPicker.sort((a, b) => a.season - b.season);
    }

    const similarAll = [...similarHits, ...recHits];
    const similarTmdbIds = Array.from(new Set(similarAll.map((h) => h.id))).filter((x): x is number => !!x);
    const localMatches = similarTmdbIds.length
        ? await db.select({ id: tvShows.id, tmdbId: tvShows.tmdbId }).from(tvShows)
            .where(and(eq(tvShows.userId, userId), inArray(tvShows.tmdbId, similarTmdbIds)))
        : [];
    const localIndex = new Map<number, number>();
    for (const s of localMatches) if (s.tmdbId != null) localIndex.set(s.tmdbId, s.id);

    const cast = (show.cast as Array<{ name: string; character: string; profile_path: string | null }> | null) ?? [];
    const totalEpisodes = episodes.length;
    const totalSeasons = bySeason.size;

    return (
        <MovieDetailLayout
            title={show.title}
            tagline={show.status ?? null}
            overview={show.overview}
            year={show.firstAirYear}
            runtimeMinutes={null}
            rating={show.rating}
            genres={(show.genres as Array<{ name: string }> | null) ?? []}
            posterPath={show.posterPath}
            backdropPath={show.backdropPath}
            trailerYoutubeId={show.trailerYoutubeId ?? null}
            posterTransitionName={`show-${show.id}`}
            backHref="/watch/shows"
            backLabel="Back to series"
            heroExtraPills={
                <>
                    {totalSeasons > 0 && (
                        <span className="watch-pill">{totalSeasons} {totalSeasons === 1 ? "sezon" : "sezoane"}</span>
                    )}
                    {totalEpisodes > 0 && (
                        <span className="watch-pill">{totalEpisodes} ep.</span>
                    )}
                </>
            }
            primaryActions={
                <TrailerButton trailerYoutubeId={show.trailerYoutubeId} title={show.title} />
            }
            ratings={
                <ExternalRatingsPanel
                    initial={(show.externalRatings as ExternalRatings | null) ?? null}
                    fetchedAt={show.externalRatingsFetchedAt ?? null}
                    refreshAction={async () => {
                        "use server";
                        return refreshShowRatings(show.id);
                    }}
                />
            }
            cast={cast}
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
                flags?.vidsrcEnabled && show.tmdbId && seasonsForPicker.length > 0 ? (
                    <section style={{ padding: "1.5rem" }}>
                        <h2 className="watch-row-title">Surse externe</h2>
                        <StreamSourcePicker
                            kind="tv"
                            tmdbId={show.tmdbId}
                            imdbId={show.imdbId ?? undefined}
                            seasons={seasonsForPicker}
                        />
                    </section>
                ) : null
            }
            extraSections={
                <>
                    {[...bySeason.entries()].sort(([a], [b]) => a - b).map(([season, eps]) => (
                        <section key={season} style={{ padding: "1.5rem" }}>
                            <h2 className="watch-row-title">Sezonul {season}</h2>
                            <ul style={{ display: "grid", gap: ".5rem", listStyle: "none", padding: 0 }}>
                                {eps.map((e) => {
                                    const fileId = epFile.get(e.id);
                                    return (
                                        <li key={e.id} style={{ display: "flex", gap: "1rem", padding: ".75rem", borderRadius: 8, background: "var(--watch-bg-2)" }}>
                                            <div style={{ minWidth: 80, fontVariantNumeric: "tabular-nums", color: "var(--watch-fg-dim)" }}>
                                                E{String(e.episodeNumber).padStart(2, "0")}
                                            </div>
                                            <div style={{ flex: 1 }}>
                                                <strong>{e.title ?? `Episod ${e.episodeNumber}`}</strong>
                                                {e.overview && <p style={{ color: "var(--watch-fg-dim)", fontSize: ".85rem", marginTop: ".25rem" }}>{e.overview}</p>}
                                            </div>
                                            {fileId ? (
                                                <div style={{ display: "flex", gap: ".5rem" }}>
                                                    <PlayHereButton fileId={fileId} label="▶" />
                                                    <Link className="watch-cta" href={`/watch/play/${fileId}`}>Cinema</Link>
                                                    <PlayNextButton fileId={fileId} />
                                                    <AddToQueueButton fileId={fileId} />
                                                    <MarkWatchedButton episodeId={e.id} />
                                                </div>
                                            ) : (
                                                <span className="watch-pill">indisponibil</span>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    ))}
                </>
            }
            similar={similarHits}
            recommendations={recHits}
            localIndex={localIndex}
            kind="tv"
        />
    );
}
