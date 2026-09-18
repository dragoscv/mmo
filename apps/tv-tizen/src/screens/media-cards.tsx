import { useEffect, useRef, useState } from "react";
import type { MediaClient } from "../lib/media";
import type { HomeRow, TitleCard } from "../lib/media-types";
import { getLocale, t } from "../i18n/messages";
import { SkeletonCard } from "./cards";

export function yearOf(c: TitleCard): string | null {
    return c.releaseDate ? c.releaseDate.slice(0, 4) : null;
}

export function cardMeta(c: TitleCard): string {
    return [t(c.kind === "tv" ? "home.heroMeta.tv" : "home.heroMeta.movie"), yearOf(c), c.voteAverage ? `★ ${c.voteAverage.toFixed(1)}` : null]
        .filter(Boolean).join(" · ");
}

/** Poster (2:3) card for a `TitleCard`. */
export function TitlePosterCard({ c, media, onClick }: { c: TitleCard; media: MediaClient; onClick: () => void }) {
    const poster = media.image(c.posterPath, "w500");
    const pct = c.progress != null && c.progress > 0 ? Math.min(100, Math.round(c.progress * 100)) : null;
    return (
        <button className="card poster media-card" data-focusable onClick={onClick} data-testid="media-card" data-tmdb={`${c.kind}:${c.tmdbId}`}>
            {poster ? <img className="art" src={poster} alt="" loading="lazy" /> : <div className="art placeholder">🎬</div>}
            {c.inLibrary && <span className="badge in-library" data-testid="in-library">{t("home.inLibrary")}</span>}
            <div className="meta">
                <div className="title">{c.title}</div>
                <div className="sub">{[yearOf(c), c.voteAverage ? `★ ${c.voteAverage.toFixed(1)}` : null].filter(Boolean).join(" · ")}</div>
            </div>
            {pct != null && <div className="progress" data-testid="progress"><div style={{ width: `${pct}%` }} /></div>}
        </button>
    );
}

export function MediaRow({ row, media, onOpen }: { row: HomeRow; media: MediaClient; onOpen: (c: TitleCard) => void }) {
    if (row.items.length === 0) return null;
    const title = row.title[getLocale()] ?? row.title.ro;
    return (
        <section className="row media-row" data-focus-row={`media:${row.id}`} data-testid="media-row" data-row-id={row.id}>
            <h2 className="row-title">{title}</h2>
            <div className="row-track">
                {row.items.map((c) => <TitlePosterCard key={`${c.kind}:${c.tmdbId}`} c={c} media={media} onClick={() => onOpen(c)} />)}
            </div>
        </section>
    );
}

export function SkeletonRows({ n = 3 }: { n?: number }) {
    return (
        <>
            {Array.from({ length: n }, (_, i) => (
                <section className="row" key={i} data-testid="row-skeleton">
                    <div className="skeleton skeleton-line" style={{ width: 280, height: "1.1rem", marginBottom: 14 }} />
                    <div className="row-track" aria-busy="true">
                        {Array.from({ length: 7 }, (_, j) => <SkeletonCard key={j} />)}
                    </div>
                </section>
            ))}
        </>
    );
}

export const HERO_ROTATE_MS = 12_000;

/** Billboard over the first few titles: backdrop w1280, logo w500 or title, meta, one CTA. Rotates every 12 s unless focused. */
export function HeroBillboard({ items, media, onOpen }: { items: TitleCard[]; media: MediaClient; onOpen: (c: TitleCard) => void }) {
    const [idx, setIdx] = useState(0);
    const [focused, setFocused] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const n = items.length;

    useEffect(() => {
        if (n < 2 || focused) return;
        const h = window.setInterval(() => setIdx((i) => (i + 1) % n), HERO_ROTATE_MS);
        return () => window.clearInterval(h);
    }, [n, focused]);

    const c = items[idx % Math.max(1, n)];
    if (!c) return null;
    const backdrop = media.image(c.backdropPath ?? c.posterPath, "w1280");
    const hasSources = !!c.inLibrary;
    return (
        <div className="hero" ref={root} data-testid="hero" data-tmdb={`${c.kind}:${c.tmdbId}`}
            onFocus={() => setFocused(true)} onBlur={(e) => { if (!root.current?.contains(e.relatedTarget as Node | null)) setFocused(false); }}>
            {backdrop && <div className="hero-bg" style={{ backgroundImage: `url("${backdrop}")` }} />}
            <div className="hero-fade" />
            <div className="hero-body">
                <div className="hero-title" data-testid="hero-title">{c.title}</div>
                <div className="hero-meta">{cardMeta(c)}{c.reason ? ` · ${c.reason}` : ""}</div>
                {c.overview && <p className="hero-overview">{c.overview}</p>}
                <div className="btn-row">
                    <button className="btn" data-focusable data-testid="hero-cta" onClick={() => onOpen(c)}>
                        {hasSources ? `▶ ${t("home.play")}` : t("home.whereToWatch")}
                    </button>
                    {n > 1 && <span className="hero-dots" aria-hidden="true">{items.slice(0, 8).map((_, i) => <i key={i} className={i === idx % n ? "on" : ""} />)}</span>}
                </div>
            </div>
        </div>
    );
}
