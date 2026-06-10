"use client";

import Link from "next/link";
import Image from "next/image";
import { Film } from "lucide-react";
import { useCallback, useRef, useState, type CSSProperties } from "react";
import { PosterContextMenu } from "./poster-context-menu";
import { PosterPreviewHost, TechBadges, type PreviewData, type VideoTech } from "./poster-preview";

interface Props {
    href: string;
    title: string;
    year?: number | null;
    posterPath: string | null;
    /** 0..1, draws a progress bar across the bottom edge. */
    progress?: number;
    /** Resume timestamp (seconds). */
    resumeSec?: number;
    overview?: string | null;
    rating?: number | null;
    /** Optional duration suffix in the caption (e.g. "118 min" or "S2 · E5"). */
    extra?: string | null;
    /** YouTube id; if set, autoplay (muted) inside the hover popover. */
    trailerId?: string | null;
    /** View Transition name for cross-route morph. */
    transitionName?: string;
    watched?: boolean;
    liked?: boolean;
    /** Item exists in the user's local library (shows a HD-style "Local" pill). */
    local?: boolean;
    genres?: string[];
    /** Extra preview data shown in the hover popover / details modal. */
    preview?: {
        backdropPath?: string | null;
        runtime?: number | null;
        ageRating?: string | null;
        cast?: Array<{ name: string; character?: string }>;
        episodeCount?: number | null;
        seasonCount?: number | null;
        tech?: VideoTech | null;
    };
    /** Enables right-click context menu + Netflix-style hover preview. */
    ctx?: {
        kind: "movie" | "tv";
        movieId?: number;
        showId?: number;
        tmdbId?: number | null;
        imdbId?: string | null;
        inWishlist?: boolean;
        customCollections?: Array<{ id: number; name: string }>;
    };
}

const HOVER_PREVIEW_DELAY = 600;

export function PosterCard({
    href, title, year, posterPath, progress, resumeSec,
    overview, rating, extra, trailerId, transitionName,
    watched, liked, local, genres, preview, ctx,
}: Props) {
    const src = posterPath ? `https://image.tmdb.org/t/p/w342${posterPath}` : null;
    const style: CSSProperties = transitionName
        ? ({ ["--vt-name" as string]: transitionName, viewTransitionName: transitionName } as CSSProperties)
        : {};

    const anchorRef = useRef<HTMLAnchorElement>(null);
    const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [openPopover, setOpenPopover] = useState(false);
    const [openModal, setOpenModal] = useState(false);

    const hasPreview = !!ctx || !!overview;

    const onEnter = useCallback(() => {
        if (!hasPreview) return;
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => setOpenPopover(true), HOVER_PREVIEW_DELAY);
    }, [hasPreview]);

    const onLeave = useCallback(() => {
        if (hoverTimer.current) {
            clearTimeout(hoverTimer.current);
            hoverTimer.current = null;
        }
    }, []);

    const data: PreviewData | null = hasPreview
        ? {
            kind: ctx?.kind ?? (href.includes("/tv/") || href.includes("/shows/") ? "tv" : "movie"),
            href, title, year, posterPath,
            backdropPath: preview?.backdropPath ?? null,
            overview: overview ?? null,
            rating: rating ?? null,
            runtime: preview?.runtime ?? null,
            ageRating: preview?.ageRating ?? null,
            genres: genres ?? [],
            cast: preview?.cast ?? [],
            trailerId: trailerId ?? null,
            watched, liked,
            transitionName,
            movieId: ctx?.movieId,
            showId: ctx?.showId,
            inWishlist: ctx?.inWishlist,
            episodeCount: preview?.episodeCount ?? null,
            seasonCount: preview?.seasonCount ?? null,
            tech: preview?.tech ?? null,
        }
        : null;

    const card = (
        <Link
            ref={anchorRef}
            href={href}
            className="poster-card"
            aria-label={`${title}${year ? ` (${year})` : ""}`}
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
            role="listitem"
        >
            {src ? (
                <Image
                    src={src}
                    alt={title}
                    width={342}
                    height={513}
                    className="poster-card-img"
                    style={style}
                    sizes="(max-width: 640px) 45vw, (max-width: 1280px) 22vw, 180px"
                    loading="lazy"
                />
            ) : (
                <div className="poster-card-placeholder" style={style}>
                    <Film aria-hidden />
                    <span>{title}</span>
                </div>
            )}

            {(rating != null && rating > 0) || watched || liked || local ? (
                <div className="poster-card-badges">
                    <div style={{ display: "flex", gap: "0.35rem" }}>
                        {watched && <span className="poster-badge poster-badge--watched" title="Watched">✓</span>}
                        {liked && <span className="poster-badge poster-badge--liked" title="Liked">♥</span>}
                        {local && <span className="poster-badge poster-badge--local" title="In your library">LOCAL</span>}
                    </div>
                    {rating != null && rating > 0 && (
                        <span className="poster-badge poster-badge--rating" title={`TMDB ${rating.toFixed(1)}`}>★ {rating.toFixed(1)}</span>
                    )}
                </div>
            ) : null}

            {preview?.tech && (
                <div className="poster-card-tech">
                    <TechBadges tech={preview.tech} />
                </div>
            )}

            <div className="poster-card-caption">
                <span className="poster-card-caption-title">{title}</span>
                {(year || extra) && (
                    <span className="poster-card-caption-meta">
                        {year}{year && extra ? " · " : ""}{extra ?? ""}
                    </span>
                )}
            </div>

            {progress !== undefined && progress > 0 && (
                <div
                    className="poster-card-progress"
                    style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
                />
            )}
            {progress !== undefined && progress > 0 && resumeSec !== undefined && resumeSec > 0 && (
                <ProgressRing pct={progress} resumeSec={resumeSec} />
            )}
        </Link>
    );

    const wrapped = ctx && (ctx.movieId || ctx.showId) ? (
        <PosterContextMenu
            href={href}
            kind={ctx.kind}
            movieId={ctx.movieId}
            showId={ctx.showId}
            tmdbId={ctx.tmdbId ?? null}
            imdbId={ctx.imdbId ?? null}
            inWishlist={ctx.inWishlist}
            watched={watched}
            customCollections={ctx.customCollections}
        >
            {card}
        </PosterContextMenu>
    ) : card;

    return (
        <>
            {wrapped}
            {data && (
                <PosterPreviewHost
                    data={data}
                    anchorEl={anchorRef.current}
                    openPopover={openPopover && !openModal}
                    openModal={openModal}
                    onClose={() => { setOpenModal(false); setOpenPopover(false); }}
                    onClosePopover={() => setOpenPopover(false)}
                    onOpenModal={() => { setOpenPopover(false); setOpenModal(true); }}
                />
            )}
        </>
    );
}

function ProgressRing({ pct, resumeSec }: { pct: number; resumeSec: number }) {
    const r = 14;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - Math.max(0, Math.min(1, pct)));
    const m = Math.floor(resumeSec / 60);
    const s = Math.floor(resumeSec % 60);
    return (
        <div
            style={{
                position: "absolute", top: 8, right: 8, zIndex: 4,
                width: 36, height: 36, display: "grid", placeItems: "center",
                background: "rgba(0,0,0,0.6)", borderRadius: "50%",
                backdropFilter: "blur(4px)",
            }}
            title={`Reia la ${m}:${String(s).padStart(2, "0")}`}
        >
            <svg width={36} height={36} viewBox="0 0 36 36" style={{ position: "absolute", inset: 0 }}>
                <circle cx={18} cy={18} r={r} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth={2.5} />
                <circle cx={18} cy={18} r={r} fill="none" stroke="var(--watch-accent,#fff)" strokeWidth={2.5}
                    strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
                    transform="rotate(-90 18 18)" />
            </svg>
            <span style={{ fontSize: "0.65rem", fontWeight: 700, color: "#fff" }}>
                {m}:{String(s).padStart(2, "0")}
            </span>
        </div>
    );
}
