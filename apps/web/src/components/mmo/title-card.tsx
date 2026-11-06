"use client";

/** Poster/landscape card for a server `TitleCard`; hover/focus drives the shared backdrop. */
import Link from "@/components/host/host-context";
import { memo, type MouseEvent } from "react";
import type { TitleCard } from "@/lib/mmo/media-types";
import { tmdbImg } from "@/lib/media/normalize";
import { useBackdrop } from "./backdrop";

export function titleHref(kind: string, tmdbId: number): string {
    return `/media/${kind}/${tmdbId}`;
}

/** Shared element name of the poster → title morph; the title page poster carries it too. */
export const POSTER_VT = "mx-poster";

/** Give only the clicked card's poster the shared name (names must be unique while the transition snapshots). */
export function tagPosterForMorph(e: MouseEvent<HTMLElement>) {
    const img = e.currentTarget.querySelector<HTMLElement>(".mx-card-img img");
    if (!img) return;
    // Duplicate names abort the transition: clear earlier tags and the current title page poster.
    document.querySelectorAll<HTMLElement>(`[data-vt-poster], [style*="${POSTER_VT}"]`).forEach((el) => { el.style.viewTransitionName = ""; el.removeAttribute("data-vt-poster"); });
    img.style.viewTransitionName = POSTER_VT;
    img.setAttribute("data-vt-poster", "");
}

export const MxTitleCard = memo(function MxTitleCard({ item, variant = "poster", sub }: { item: TitleCard; variant?: "poster" | "landscape"; sub?: string }) {
    const { set } = useBackdrop();
    const img = variant === "landscape" ? tmdbImg(item.backdropPath ?? item.posterPath, "w780") : tmdbImg(item.posterPath, "w342");
    const year = item.releaseDate?.slice(0, 4);
    const subtitle = sub ?? [year, item.voteAverage ? `★ ${item.voteAverage.toFixed(1)}` : null].filter(Boolean).join(" · ");
    const focus = () => set(item.backdropPath);
    return (
        <Link href={titleHref(item.kind, item.tmdbId)} className="mx-card" data-variant={variant} onMouseEnter={focus} onFocus={focus} onClick={variant === "poster" ? tagPosterForMorph : undefined} prefetch={false}>
            <span className="mx-card-img">
                {img
                    // eslint-disable-next-line @next/next/no-img-element -- TMDB CDN, sized per variant
                    ? <img src={img} alt="" loading="lazy" decoding="async" />
                    : <span className="mx-card-fallback">{item.title}</span>}
                {typeof item.progress === "number" && item.progress > 0 ? (
                    <span className="mx-card-progress" aria-hidden><span style={{ width: `${Math.round(Math.min(1, item.progress) * 100)}%` }} /></span>
                ) : null}
            </span>
            <span className="mx-card-title">{item.title}</span>
            {subtitle ? <span className="mx-card-sub">{subtitle}</span> : null}
        </Link>
    );
});
