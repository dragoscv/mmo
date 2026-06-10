import Image from "next/image";
import type { ReactNode } from "react";
import { HeroTrailer } from "@/components/video/hero-trailer";
import { WatchBackButton } from "@/components/video/watch-back-button";
import { SimilarTitlesRow } from "@/components/video/similar-titles-row";
import type { TmdbSearchHit } from "@/lib/tmdb";

/**
 * Shared layout for any movie-detail surface (local library OR TMDB-only
 * discover). Both pages assemble the same section order: hero with autoplay
 * trailer → details → ratings → cast → providers → external sources → similar
 * → recommendations. Library-only sections (file specs, external ratings,
 * wishlist/play buttons) are passed through slot props.
 */
export interface MovieDetailLayoutProps {
    // ─── Hero ─────────────────────────────────────────────────────────
    title: string;
    tagline?: string | null;
    overview?: string | null;
    year?: number | null;
    runtimeMinutes?: number | null;
    rating?: number | null;
    genres?: Array<{ name: string }>;
    posterPath: string | null;
    backdropPath: string | null;
    trailerYoutubeId: string | null;
    /** View-transition handle for poster morph across pages. */
    posterTransitionName?: string;
    /** "Pe TMDB · neîn bibliotecă" or empty for library titles. */
    eyebrow?: ReactNode;
    /** Pills appended after the genres pills row (e.g. tech badges). */
    heroExtraPills?: ReactNode;
    /** Buttons row: PlayHere / Cinema / Trailer / Wishlist OR Trailer / Search / TMDB. */
    primaryActions: ReactNode;
    /** Where the back button returns to. */
    backHref?: string;
    backLabel?: string;

    // ─── Sub-hero sections ────────────────────────────────────────────
    /** Director / "Created by" line under the hero. */
    creatorLine?: ReactNode;
    /** Full details panel (file specs, crew dl, etc.). Library page passes MovieDetailsPanel. */
    details?: ReactNode;
    /** External ratings panel — library-only (DB-cached). */
    ratings?: ReactNode;
    /** TMDB cast (with profile_path images). */
    cast?: Array<{ name: string; character?: string | null; profile_path?: string | null }>;
    /** ExternalProvidersRow — both pages. */
    providers?: ReactNode;
    /** StreamSourcePicker — both pages. */
    streamPicker?: ReactNode;
    /** Arbitrary page-specific sections placed before similar/recommendations (e.g. TV seasons list). */
    extraSections?: ReactNode;
    /** "Similar titles" TMDB row. */
    similar?: TmdbSearchHit[];
    /** "You might also like" TMDB row. */
    recommendations?: TmdbSearchHit[];
    /** Maps TMDB id → local DB id for deep-linking owned titles in similar rows. */
    localIndex?: Map<number, number>;
    /** "movie" or "tv" — drives href shape in similar rows. */
    kind?: "movie" | "tv";
}

export function MovieDetailLayout({
    title,
    tagline,
    overview,
    year,
    runtimeMinutes,
    rating,
    genres = [],
    posterPath,
    backdropPath,
    trailerYoutubeId,
    posterTransitionName,
    eyebrow,
    heroExtraPills,
    primaryActions,
    backHref = "/watch",
    backLabel = "Înapoi",
    creatorLine,
    details,
    ratings,
    cast = [],
    providers,
    streamPicker,
    extraSections,
    similar = [],
    recommendations = [],
    localIndex,
    kind = "movie",
}: MovieDetailLayoutProps) {
    return (
        <main>
            <section className="watch-hero" style={{ borderRadius: 0, maxHeight: "90vh" }}>
                <HeroTrailer
                    trailerId={trailerYoutubeId}
                    backdropPath={backdropPath}
                    title={title}
                />
                <div className="watch-hero-grain" />
                <div className="watch-hero-fade" />
                <div className="watch-hero-back-wrap">
                    <WatchBackButton fallbackHref={backHref} label={backLabel} />
                </div>
                <div
                    className="watch-hero-content"
                    style={{ display: "flex", gap: "2rem", alignItems: "flex-end", maxWidth: "none" }}
                >
                    {posterPath && (
                        <Image
                            src={`https://image.tmdb.org/t/p/w342${posterPath}`}
                            alt={title}
                            width={220}
                            height={330}
                            style={{
                                borderRadius: "12px",
                                boxShadow: "0 20px 60px rgba(0,0,0,.6)",
                                viewTransitionName: posterTransitionName,
                            }}
                            priority
                        />
                    )}
                    <div style={{ flex: 1 }}>
                        {eyebrow && (
                            <div className="watch-detail-eyebrow" style={{ marginBottom: ".5rem" }}>
                                {eyebrow}
                            </div>
                        )}
                        <h1 className="watch-hero-title">{title}</h1>
                        {tagline && (
                            <p className="watch-hero-tagline" style={{ fontStyle: "italic" }}>{tagline}</p>
                        )}
                        <div
                            style={{
                                display: "flex",
                                gap: ".5rem",
                                margin: "1rem 0",
                                flexWrap: "wrap",
                                alignItems: "center",
                            }}
                        >
                            {year != null && <span className="watch-pill">{year}</span>}
                            {runtimeMinutes != null && <span className="watch-pill">{runtimeMinutes} min</span>}
                            {rating != null && rating > 0 && (
                                <span className="watch-pill">⭐ {rating.toFixed(1)}</span>
                            )}
                            {genres.slice(0, 4).map((g) => (
                                <span key={g.name} className="watch-pill">{g.name}</span>
                            ))}
                            {heroExtraPills}
                        </div>
                        {overview && (
                            <p style={{ maxWidth: "60ch", lineHeight: 1.6, color: "var(--watch-fg)" }}>
                                {overview}
                            </p>
                        )}
                        <div
                            style={{
                                display: "flex",
                                gap: ".75rem",
                                marginTop: "1.5rem",
                                flexWrap: "wrap",
                            }}
                        >
                            {primaryActions}
                        </div>
                    </div>
                </div>
            </section>

            {creatorLine && (
                <section style={{ padding: "1.5rem" }}>
                    <p style={{ color: "var(--watch-fg-dim)" }}>{creatorLine}</p>
                </section>
            )}

            {details}
            {ratings}

            {cast.length > 0 && (
                <section style={{ padding: "1.5rem" }}>
                    <h2 className="watch-row-title">Cast</h2>
                    <div className="watch-row-scroll">
                        {cast.slice(0, 12).map((c, i) => (
                            <div
                                key={`${c.name}-${i}`}
                                style={{ flex: "0 0 auto", width: 120, textAlign: "center" }}
                            >
                                {c.profile_path ? (
                                    <Image
                                        src={`https://image.tmdb.org/t/p/w185${c.profile_path}`}
                                        alt={c.name}
                                        width={120}
                                        height={180}
                                        style={{ borderRadius: 8, objectFit: "cover" }}
                                    />
                                ) : (
                                    <div
                                        style={{
                                            width: 120,
                                            height: 180,
                                            background: "var(--watch-bg-2)",
                                            borderRadius: 8,
                                        }}
                                    />
                                )}
                                <div style={{ fontSize: ".8rem", marginTop: ".4rem", fontWeight: 600 }}>
                                    {c.name}
                                </div>
                                {c.character && (
                                    <div style={{ fontSize: ".75rem", color: "var(--watch-fg-dim)" }}>
                                        {c.character}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {providers}
            {streamPicker}
            {extraSections}

            {similar.length > 0 && (
                <SimilarTitlesRow
                    title="Similar titles"
                    items={similar}
                    localIndex={localIndex}
                    kind={kind}
                />
            )}
            {recommendations.length > 0 && (
                <SimilarTitlesRow
                    title="You might also like"
                    items={recommendations}
                    localIndex={localIndex}
                    kind={kind}
                />
            )}
        </main>
    );
}
