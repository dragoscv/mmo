import { auth } from "@/auth";
import { db } from "@/db";
import { movies, videoCollectionItems, videoCollections, videoFiles, watchProfiles } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { tmdbWatchProviders } from "@/lib/tmdb";
import { getCompanionVideoFlags } from "@/lib/companion-video";
import { WishlistButton } from "@/components/video/wishlist-button";

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
    const [providers, flags, wishlistRow] = await Promise.all([
        movie.tmdbId ? tmdbWatchProviders("movie", movie.tmdbId, "RO") : null,
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
    ]);
    const inWishlist = wishlistRow.length > 0;

    const backdrop = movie.backdropPath ? `https://image.tmdb.org/t/p/original${movie.backdropPath}` : null;
    const cast = (movie.cast as Array<{ name: string; character: string; profile_path: string | null }> | null) ?? [];
    const crew = (movie.crew as Array<{ name: string; job: string }> | null) ?? [];
    const director = crew.find((c) => c.job === "Director");

    return (
        <main>
            <section className="watch-hero" style={{ borderRadius: 0, maxHeight: "90vh" }}>
                {backdrop && <div className="watch-hero-bg" style={{ backgroundImage: `url(${backdrop})` }} />}
                <div className="watch-hero-grain" />
                <div className="watch-hero-fade" />
                <div className="watch-hero-content" style={{ display: "flex", gap: "2rem", alignItems: "flex-end" }}>
                    {movie.posterPath && (
                        <Image
                            src={`https://image.tmdb.org/t/p/w342${movie.posterPath}`}
                            alt={movie.title}
                            width={220}
                            height={330}
                            style={{ borderRadius: "12px", boxShadow: "0 20px 60px rgba(0,0,0,.6)" }}
                            priority
                        />
                    )}
                    <div style={{ flex: 1 }}>
                        <h1 className="watch-hero-title" style={{ viewTransitionName: `movie-${movie.id}` }}>{movie.title}</h1>
                        {movie.tagline && <p className="watch-hero-tagline" style={{ fontStyle: "italic" }}>{movie.tagline}</p>}
                        <div style={{ display: "flex", gap: ".5rem", margin: "1rem 0", flexWrap: "wrap" }}>
                            {movie.year && <span className="watch-pill">{movie.year}</span>}
                            {movie.runtimeMinutes && <span className="watch-pill">{movie.runtimeMinutes} min</span>}
                            {movie.rating != null && <span className="watch-pill">⭐ {movie.rating.toFixed(1)}</span>}
                            {((movie.genres as Array<{ name: string }> | null) ?? []).slice(0, 4).map((g) => (
                                <span key={g.name} className="watch-pill">{g.name}</span>
                            ))}
                        </div>
                        <p style={{ maxWidth: "60ch", lineHeight: 1.6, color: "var(--watch-fg)" }}>{movie.overview}</p>
                        <div style={{ display: "flex", gap: ".75rem", marginTop: "1.5rem", flexWrap: "wrap" }}>
                            {files.length > 0 ? (
                                <Link className="watch-cta watch-cta--accent" href={`/watch/play/${files[0].id}`}>▶ Redă</Link>
                            ) : (
                                <span className="watch-pill">Niciun fișier local — rulează un scan</span>
                            )}
                            {movie.trailerYoutubeId && (
                                <a className="watch-cta" href={`https://www.youtube.com/watch?v=${movie.trailerYoutubeId}`} target="_blank" rel="noopener noreferrer">Trailer</a>
                            )}
                            <WishlistButton movieId={movie.id} initial={inWishlist} />
                        </div>
                    </div>
                </div>
            </section>

            {director && (
                <section style={{ padding: "1.5rem" }}>
                    <p style={{ color: "var(--watch-fg-dim)" }}>Regia: <strong style={{ color: "var(--watch-fg)" }}>{director.name}</strong></p>
                </section>
            )}

            {cast.length > 0 && (
                <section style={{ padding: "1.5rem" }}>
                    <h2 className="watch-row-title">Distribuție</h2>
                    <div className="watch-row-scroll">
                        {cast.slice(0, 12).map((c, i) => (
                            <div key={i} style={{ flex: "0 0 auto", width: 120, textAlign: "center" }}>
                                {c.profile_path ? (
                                    <Image src={`https://image.tmdb.org/t/p/w185${c.profile_path}`} alt={c.name} width={120} height={180}
                                        style={{ borderRadius: 8, objectFit: "cover" }} />
                                ) : (
                                    <div style={{ width: 120, height: 180, background: "var(--watch-bg-2)", borderRadius: 8 }} />
                                )}
                                <div style={{ fontSize: ".8rem", marginTop: ".4rem", fontWeight: 600 }}>{c.name}</div>
                                <div style={{ fontSize: ".75rem", color: "var(--watch-fg-dim)" }}>{c.character}</div>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {providers && (providers.flatrate?.length || providers.rent?.length || providers.free?.length) && (
                <section style={{ padding: "1.5rem" }}>
                    <h2 className="watch-row-title">Streaming în România</h2>
                    <div style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
                        {[...(providers.flatrate ?? []), ...(providers.free ?? []), ...(providers.rent ?? [])].map((p) => (
                            <a key={p.provider_id} href={providers.link} target="_blank" rel="noopener noreferrer"
                                title={p.provider_name}
                                style={{ display: "block", width: 48, height: 48, borderRadius: 8, overflow: "hidden", background: "#fff" }}>
                                <Image src={`https://image.tmdb.org/t/p/w185${p.logo_path}`} alt={p.provider_name} width={48} height={48} />
                            </a>
                        ))}
                    </div>
                </section>
            )}

            {flags?.vidsrcEnabled && movie.tmdbId && (
                <section style={{ padding: "1.5rem" }}>
                    <h2 className="watch-row-title">Sursă externă</h2>
                    <p style={{ color: "var(--watch-fg-dim)", fontSize: ".8rem", marginBottom: ".5rem" }}>
                        Conținut găzduit de terți. Activat manual din setări — folosește pe răspundere proprie.
                    </p>
                    <div style={{ aspectRatio: "16/9", maxWidth: 1280 }}>
                        <iframe
                            src={`https://vidsrc.to/embed/movie/${movie.tmdbId}`}
                            allowFullScreen
                            referrerPolicy="no-referrer"
                            style={{ width: "100%", height: "100%", border: 0, borderRadius: 12 }}
                        />
                    </div>
                </section>
            )}
        </main>
    );
}
