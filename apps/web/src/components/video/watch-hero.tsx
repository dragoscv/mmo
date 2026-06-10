import Link from "next/link";
import { Play, Info, Sparkles } from "lucide-react";

export interface HeroFeature {
    id: number;
    kind: "movie" | "show";
    title: string;
    overview: string | null;
    backdropPath: string | null;
    year: number | null;
    runtime?: number | null;
    rating?: number | null;
    genres?: string[] | null;
}

interface Props {
    feature: HeroFeature | null;
}

/** Cinematic billboard at the top of /watch.
 *
 *  When no feature is available (empty library + no TMDB key) we render
 *  a quieter pitch panel instead of a stretched gradient. */
export function WatchHero({ feature }: Props) {
    if (!feature) {
        return (
            <section className="watch-hero" style={{ aspectRatio: "auto", maxHeight: "unset", minHeight: 280 }}>
                <div className="watch-hero-fade" />
                <div className="watch-hero-content" style={{ maxWidth: "min(720px, 90%)" }}>
                    <div className="watch-hero-eyebrow"><Sparkles size={12} /> Welcome to your library</div>
                    <h1 className="watch-hero-title">Your cinema. Your rules.</h1>
                    <p className="watch-hero-overview">
                        Scan a folder of films or TV episodes from a paired companion to start. Posters, plots, cast and trailers are fetched automatically.
                    </p>
                    <div className="watch-hero-actions">
                        <Link href="/devices" className="watch-btn watch-btn-primary">
                            <Play size={16} fill="currentColor" /> Pair a companion
                        </Link>
                        <Link href="/watch/settings" className="watch-btn watch-btn-ghost">
                            <Info size={16} /> Pick a theme
                        </Link>
                    </div>
                </div>
            </section>
        );
    }

    const backdrop = feature.backdropPath
        ? `https://image.tmdb.org/t/p/original${feature.backdropPath}`
        : null;
    const detailHref = feature.kind === "movie"
        ? `/watch/movies/${feature.id}`
        : `/watch/shows/${feature.id}`;

    return (
        <section className="watch-hero">
            {backdrop && (
                <div
                    className="watch-hero-bg"
                    style={{ backgroundImage: `url(${backdrop})` }}
                    aria-hidden
                />
            )}
            <div className="watch-hero-fade" />
            <div className="watch-hero-grain" aria-hidden />
            <div className="watch-hero-content">
                <div className="watch-hero-eyebrow">
                    <Sparkles size={12} />
                    {feature.kind === "movie" ? "Featured film" : "Featured series"}
                </div>
                <h1 className="watch-hero-title">{feature.title}</h1>
                <div className="watch-hero-meta">
                    {feature.year && <span className="watch-hero-meta-chip">{feature.year}</span>}
                    {feature.rating !== undefined && feature.rating !== null && feature.rating > 0 && (
                        <span className="watch-hero-meta-chip">★ {feature.rating.toFixed(1)}</span>
                    )}
                    {feature.runtime && <span className="watch-hero-meta-chip">{feature.runtime} min</span>}
                    {(feature.genres ?? []).slice(0, 3).map((g) => (
                        <span key={g} className="watch-hero-meta-chip">{g}</span>
                    ))}
                </div>
                {feature.overview && <p className="watch-hero-overview">{feature.overview}</p>}
                <div className="watch-hero-actions">
                    <Link href={detailHref} className="watch-btn watch-btn-primary">
                        <Play size={16} fill="currentColor" /> Play
                    </Link>
                    <Link href={detailHref} className="watch-btn watch-btn-ghost">
                        <Info size={16} /> More info
                    </Link>
                </div>
            </div>
        </section>
    );
}
