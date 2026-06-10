import { auth } from "@/auth";
import { db } from "@/db";
import { movies, videoCollectionItems, videoCollections, videoFiles, watchProfiles } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { tmdbWatchProvidersMulti, tmdbMovieSimilar, tmdbMovieRecommendations } from "@/lib/tmdb";
import { getCompanionVideoFlags } from "@/lib/companion-video";
import { WishlistButton } from "@/components/video/wishlist-button";
import { PlayHereMenu } from "@/components/video/play-here-menu";
import { PreRemuxButton } from "@/components/video/pre-remux-button";
import { PlayNextButton, AddToQueueButton } from "@/components/video/queue-buttons";
import { ExternalRatingsPanel } from "@/components/video/external-ratings-panel";
import { StreamSourcePicker } from "@/components/video/stream-source-picker";
import { ExternalProvidersRow } from "@/components/video/external-providers-row";
import { TrailerButton } from "@/components/video/trailer-modal";
import { MovieDetailLayout } from "@/components/video/movie-detail-layout";
import { refreshMovieRatings } from "@/actions/external-ratings";
import { getWatchPrefs } from "@/actions/watch-prefs";
import type { ExternalRatings } from "@/lib/ratings/scrape";
import { fileToTech, pickBestFile } from "@/lib/video-tech";
import { TechBadges } from "@/components/video/poster-preview";

export const dynamic = "force-dynamic";

export default async function MovieDetail({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const movieId = Number(id);
    if (!Number.isFinite(movieId)) return notFound();

    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return notFound();

    const movie = await db.select().from(movies)
        .where(and(eq(movies.userId, userId), eq(movies.id, movieId)))
        .limit(1).then(r => r[0]);
    if (!movie) return notFound();

    const files = await db.select().from(videoFiles)
        .where(and(eq(videoFiles.userId, userId), eq(videoFiles.movieId, movieId)));
    const prefs = await getWatchPrefs();
    const [providers, flags, wishlistRow, similarHits, recHits] = await Promise.all([
        movie.tmdbId ? tmdbWatchProvidersMulti("movie", movie.tmdbId, prefs.regions) : null,
        getCompanionVideoFlags(),
        db.select({ id: videoCollectionItems.id })
            .from(videoCollectionItems)
            .innerJoin(videoCollections, eq(videoCollections.id, videoCollectionItems.collectionId))
            .innerJoin(watchProfiles, eq(watchProfiles.id, videoCollections.profileId))
            .where(and(
                eq(watchProfiles.userId, userId),
                eq(videoCollections.kind, "wishlist"),
                eq(videoCollectionItems.movieId, movieId),
            )).limit(1),
        movie.tmdbId ? tmdbMovieSimilar(movie.tmdbId).catch(() => []) : Promise.resolve([]),
        movie.tmdbId ? tmdbMovieRecommendations(movie.tmdbId).catch(() => []) : Promise.resolve([]),
    ]);
    const inWishlist = wishlistRow.length > 0;

    const similarAll = [...similarHits, ...recHits];
    const similarTmdbIds = Array.from(new Set(similarAll.map((h) => h.id))).filter((x): x is number => !!x);
    const localMatches = similarTmdbIds.length
        ? await db.select({ id: movies.id, tmdbId: movies.tmdbId }).from(movies)
            .where(and(eq(movies.userId, userId), inArray(movies.tmdbId, similarTmdbIds)))
        : [];
    const localIndex = new Map<number, number>();
    for (const m of localMatches) if (m.tmdbId != null) localIndex.set(m.tmdbId, m.id);

    const cast = (movie.cast as Array<{ name: string; character: string; profile_path: string | null }> | null) ?? [];
    const crew = (movie.crew as Array<{ name: string; job: string }> | null) ?? [];
    const director = crew.find((c) => c.job === "Director");
    const tech = fileToTech(pickBestFile(files));

    return (
        <MovieDetailLayout
            title={movie.title}
            tagline={movie.tagline}
            overview={movie.overview}
            year={movie.year}
            runtimeMinutes={movie.runtimeMinutes}
            rating={movie.rating}
            genres={(movie.genres as Array<{ name: string }> | null) ?? []}
            posterPath={movie.posterPath}
            backdropPath={movie.backdropPath}
            trailerYoutubeId={movie.trailerYoutubeId ?? null}
            posterTransitionName={`movie-${movie.id}`}
            backHref="/watch/movies"
            backLabel="Back to movies"
            heroExtraPills={tech ? <TechBadges tech={tech} verbose /> : null}
            primaryActions={
                <>
                    {files.length > 0 ? (
                        <>
                            <PlayHereMenu fileId={files[0].id} />
                            <Link className="watch-cta" href={`/watch/play/${files[0].id}`}>Cinema</Link>
                            <PlayNextButton fileId={files[0].id} />
                            <AddToQueueButton fileId={files[0].id} />
                            <PreRemuxButton fileId={files[0].id} />
                        </>
                    ) : (
                        <span className="watch-pill">No local file — run a scan</span>
                    )}
                    <TrailerButton trailerYoutubeId={movie.trailerYoutubeId} title={movie.title} />
                    <WishlistButton movieId={movie.id} initial={inWishlist} />
                </>
            }
            creatorLine={director ? (
                <>Director: <strong style={{ color: "var(--watch-fg)" }}>{director.name}</strong></>
            ) : undefined}
            details={<MovieDetailsPanel movie={movie} crew={crew} files={files} />}
            ratings={
                <ExternalRatingsPanel
                    initial={(movie.externalRatings as ExternalRatings | null) ?? null}
                    fetchedAt={movie.externalRatingsFetchedAt ?? null}
                    refreshAction={async () => {
                        "use server";
                        return refreshMovieRatings(movie.id);
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
                flags?.vidsrcEnabled && movie.tmdbId ? (
                    <section style={{ padding: "1.5rem" }}>
                        <h2 className="watch-row-title">External sources</h2>
                        <StreamSourcePicker
                            kind="movie"
                            tmdbId={movie.tmdbId}
                            imdbId={movie.imdbId ?? undefined}
                        />
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

function formatBytes(n: number | null | undefined): string | null {
    if (!n) return null;
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function formatRuntime(min: number | null | undefined): string | null {
    if (!min) return null;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

type DetailsMovie = {
    title: string;
    originalTitle: string | null;
    year: number | null;
    runtimeMinutes: number | null;
    ageRating: string | null;
    rating: number | null;
    ratingCount: number | null;
    tagline: string | null;
    overview: string | null;
    imdbId: string | null;
    tmdbId: number | null;
    addedAt: Date | null;
    updatedAt: Date | null;
    genres: unknown;
};

type DetailsFile = {
    id: number;
    path: string | null;
    container: string | null;
    videoCodec: string | null;
    audioCodec: string | null;
    width: number | null;
    height: number | null;
    durationSec: number | null;
    bitrateKbps: number | null;
    hdr: string | null;
    sizeBytes: number | null;
    audioTracks: unknown;
    subtitleTracks: unknown;
};

function MovieDetailsPanel({
    movie,
    crew,
    files,
}: {
    movie: DetailsMovie;
    crew: Array<{ name: string; job: string }>;
    files: DetailsFile[];
}) {
    const writers = crew.filter((c) => c.job === "Screenplay" || c.job === "Writer" || c.job === "Story");
    const producers = crew.filter((c) => c.job === "Producer" || c.job === "Executive Producer");
    const dop = crew.find((c) => c.job === "Director of Photography");
    const composer = crew.find((c) => c.job === "Original Music Composer" || c.job === "Music");
    const genres = ((movie.genres as Array<{ name: string }> | null) ?? []).map((g) => g.name);

    return (
        <section className="movie-details">
            <h2 className="watch-row-title">Details</h2>
            <div className="movie-details-grid">
                <dl className="movie-details-dl">
                    {movie.originalTitle && movie.originalTitle !== movie.title && (
                        <><dt>Original title</dt><dd>{movie.originalTitle}</dd></>
                    )}
                    {movie.year != null && <><dt>Year</dt><dd>{movie.year}</dd></>}
                    {formatRuntime(movie.runtimeMinutes) && <><dt>Runtime</dt><dd>{formatRuntime(movie.runtimeMinutes)}</dd></>}
                    {movie.ageRating && <><dt>Age rating</dt><dd>{movie.ageRating}</dd></>}
                    {movie.rating != null && (
                        <><dt>TMDB rating</dt><dd>⭐ {movie.rating.toFixed(1)}{movie.ratingCount ? ` (${movie.ratingCount.toLocaleString("en-US")} votes)` : ""}</dd></>
                    )}
                    {genres.length > 0 && <><dt>Genres</dt><dd>{genres.join(", ")}</dd></>}
                    {writers.length > 0 && <><dt>{writers.length === 1 ? "Writer" : "Writers"}</dt><dd>{writers.slice(0, 4).map((w) => w.name).join(", ")}</dd></>}
                    {dop && <><dt>Cinematography</dt><dd>{dop.name}</dd></>}
                    {composer && <><dt>Music</dt><dd>{composer.name}</dd></>}
                    {producers.length > 0 && <><dt>{producers.length === 1 ? "Producer" : "Producers"}</dt><dd>{producers.slice(0, 4).map((p) => p.name).join(", ")}</dd></>}
                    {(movie.imdbId || movie.tmdbId) && (
                        <><dt>External</dt><dd>
                            {movie.imdbId && <a href={`https://www.imdb.com/title/${movie.imdbId}/`} target="_blank" rel="noopener noreferrer">IMDb</a>}
                            {movie.imdbId && movie.tmdbId && " · "}
                            {movie.tmdbId && <a href={`https://www.themoviedb.org/movie/${movie.tmdbId}`} target="_blank" rel="noopener noreferrer">TMDB</a>}
                        </dd></>
                    )}
                    {movie.addedAt && <><dt>Added to library</dt><dd>{new Date(movie.addedAt).toISOString().slice(0, 10)}</dd></>}
                </dl>

                {movie.tagline || movie.overview ? (
                    <div className="movie-details-synopsis">
                        {movie.tagline && <p className="movie-details-tagline">“{movie.tagline}”</p>}
                        {movie.overview && <p className="movie-details-overview">{movie.overview}</p>}
                    </div>
                ) : null}
            </div>

            {files.length > 0 && (
                <div className="movie-details-files">
                    <h3 className="movie-details-subhead">{files.length === 1 ? "File" : `Files (${files.length})`}</h3>
                    {files.map((f) => {
                        const audio = Array.isArray(f.audioTracks) ? (f.audioTracks as Array<{ codec?: string; channels?: number; language?: string; lang?: string; title?: string | null }>) : [];
                        const subs = Array.isArray(f.subtitleTracks) ? (f.subtitleTracks as Array<{ language?: string; lang?: string; codec?: string; title?: string | null }>) : [];
                        return (
                            <div key={f.id} className="movie-details-file">
                                <p className="movie-details-file-path" title={f.path ?? ""}>{f.path?.split(/[\\/]/).pop() ?? "—"}</p>
                                <dl className="movie-details-dl movie-details-dl--compact">
                                    {f.container && <><dt>Container</dt><dd>{f.container.toUpperCase()}</dd></>}
                                    {f.width && f.height && <><dt>Resolution</dt><dd>{f.width}×{f.height}</dd></>}
                                    {f.videoCodec && <><dt>Video codec</dt><dd>{f.videoCodec.toUpperCase()}</dd></>}
                                    {f.bitrateKbps && <><dt>Bitrate</dt><dd>{(f.bitrateKbps / 1000).toFixed(1)} Mbps</dd></>}
                                    {f.hdr && f.hdr.toLowerCase() !== "sdr" && <><dt>HDR</dt><dd>{f.hdr.toUpperCase()}</dd></>}
                                    {formatBytes(f.sizeBytes) && <><dt>Size</dt><dd>{formatBytes(f.sizeBytes)}</dd></>}
                                    {f.durationSec && <><dt>Duration</dt><dd>{formatRuntime(Math.round(f.durationSec / 60))}</dd></>}
                                    {audio.length > 0 && (
                                        <><dt>Audio tracks</dt><dd>{audio.map((a) => `${(a.language ?? a.lang ?? "?").toUpperCase()} ${a.codec?.toUpperCase() ?? ""}${a.channels ? ` ${a.channels === 6 ? "5.1" : a.channels === 8 ? "7.1" : a.channels === 2 ? "Stereo" : "Mono"}` : ""}${a.title ? ` — ${a.title}` : ""}`).join(" · ") || `${audio.length}`}</dd></>
                                    )}
                                    {subs.length > 0 && (
                                        <><dt>Subtitles</dt><dd>{subs.map((s) => (s.language ?? s.lang ?? "?").toUpperCase()).join(", ")}</dd></>
                                    )}
                                </dl>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
