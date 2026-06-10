"use client";

/**
 * Netflix-style poster preview: a popover that appears on hover (anchored to the
 * card, rendered through a body portal so it ignores all stacking contexts) and
 * an expanded modal that opens via the chevron / "Vezi detalii" button.
 *
 * Both surfaces use the View Transitions API when available so the poster image
 * morphs smoothly between the grid cell, the popover, and the modal.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Play, Plus, ThumbsUp, Check, ChevronDown, X, Info, Film } from "lucide-react";
import { toast } from "sonner";
import { toggleWishlist } from "@/actions/video-collections";
import { markWatched } from "@/actions/video-playback";
import { markUnwatched, rateItem } from "@/actions/video-context";

export interface PreviewData {
    kind: "movie" | "tv";
    href: string;
    title: string;
    year?: number | null;
    posterPath: string | null;
    backdropPath?: string | null;
    overview?: string | null;
    rating?: number | null;
    runtime?: number | null;
    ageRating?: string | null;
    genres?: string[];
    cast?: Array<{ name: string; character?: string }>;
    trailerId?: string | null;
    watched?: boolean;
    liked?: boolean;
    transitionName?: string;
    movieId?: number;
    showId?: number;
    inWishlist?: boolean;
    /** For shows. */
    episodeCount?: number | null;
    seasonCount?: number | null;
    /** Technical badges (resolution, HDR, codecs, audio). */
    tech?: VideoTech | null;
}

export interface VideoTech {
    width?: number | null;
    height?: number | null;
    hdr?: string | null;
    videoCodec?: string | null;
    audioCodec?: string | null;
    audioChannels?: number | null;
    audioLangs?: string[];
    subtitleLangs?: string[];
}

interface AnchorRect { top: number; left: number; width: number; height: number; }

function useViewTransition() {
    return useCallback((fn: () => void) => {
        const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
        if (typeof doc.startViewTransition === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            doc.startViewTransition(fn);
        } else {
            fn();
        }
    }, []);
}

/* ─────────────────────── Popover ───────────────────────────────────────── */

export function PosterPopover({
    data, anchor, onClose, onOpenModal,
}: {
    data: PreviewData;
    anchor: AnchorRect;
    onClose: () => void;
    onOpenModal: () => void;
}) {
    const router = useRouter();
    const [, startTransition] = useTransition();
    const ref = useRef<HTMLDivElement>(null);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        const t = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(t);
    }, []);

    // Close when mouse leaves both the anchor area and the popover, with a small grace delay.
    useEffect(() => {
        const grace = 120;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onMove = (e: MouseEvent) => {
            const x = e.clientX, y = e.clientY;
            const inAnchor = x >= anchor.left && x <= anchor.left + anchor.width
                && y >= anchor.top && y <= anchor.top + anchor.height;
            const r = ref.current?.getBoundingClientRect();
            const inPop = !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
            if (inAnchor || inPop) {
                if (timer) { clearTimeout(timer); timer = null; }
            } else if (!timer) {
                timer = setTimeout(() => onClose(), grace);
            }
        };
        const onScroll = () => onClose();
        window.addEventListener("mousemove", onMove, { passive: true });
        window.addEventListener("scroll", onScroll, { passive: true, capture: true });
        return () => {
            if (timer) clearTimeout(timer);
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("scroll", onScroll, true);
        };
    }, [anchor, onClose]);

    const pos = useMemo(() => {
        const scale = 1.55;
        const w = Math.max(280, Math.min(380, anchor.width * scale));
        const cx = anchor.left + anchor.width / 2;
        const cy = anchor.top + anchor.height / 2;
        // Estimate height: media (16:9 of w) + info pane (~190px)
        const h = Math.round(w * 9 / 16) + 200;
        let left = Math.round(cx - w / 2);
        let top = Math.round(cy - h / 2);
        const pad = 12;
        const vw = window.innerWidth, vh = window.innerHeight;
        if (left < pad) left = pad;
        if (left + w > vw - pad) left = vw - pad - w;
        if (top < pad + 60) top = pad + 60; // leave room for sticky filter bar
        if (top + h > vh - pad) top = vh - pad - h;
        return { left, top, width: w };
    }, [anchor]);

    const onPlay = () => router.push(data.href);
    const onWishlist = () => startTransition(async () => {
        try {
            await toggleWishlist(data.kind === "movie"
                ? { movieId: data.movieId! } : { tvShowId: data.showId! });
            toast.success(data.inWishlist ? "Scos din wishlist" : "Adăugat în wishlist");
        } catch { toast.error("Acțiune eșuată"); }
    });
    const onLike = () => startTransition(async () => {
        try {
            await rateItem({ movieId: data.movieId, showId: data.showId, rating: 9 });
            toast.success("Apreciat");
        } catch { toast.error("Acțiune eșuată"); }
    });
    const onWatched = () => startTransition(async () => {
        try {
            if (data.watched) {
                await markUnwatched({ movieId: data.movieId });
                toast.success("Marcat ca nevăzut");
            } else {
                await markWatched({ movieId: data.movieId });
                toast.success("Marcat vizionat");
            }
        } catch { toast.error("Acțiune eșuată"); }
    });

    const style: CSSProperties = {
        position: "fixed",
        left: pos.left, top: pos.top, width: pos.width,
        zIndex: 1000,
        transformOrigin: "center center",
        transform: mounted ? "scale(1)" : "scale(0.85)",
        opacity: mounted ? 1 : 0,
        transition: "opacity 220ms ease, transform 320ms cubic-bezier(.2,.9,.3,1.2)",
        willChange: "transform, opacity",
    };

    const posterUrl = data.posterPath ? `https://image.tmdb.org/t/p/w500${data.posterPath}` : null;
    const backdropUrl = data.backdropPath ? `https://image.tmdb.org/t/p/w780${data.backdropPath}` : null;
    // Backdrop (16:9) is always the better base for the preview's hero
    // area than the poster (2:3). Falls through to the poster only when
    // we have no backdrop, and to a placeholder when neither exists.
    const mediaUrl = backdropUrl ?? posterUrl;
    const yt = data.trailerId
        ? `https://www.youtube-nocookie.com/embed/${data.trailerId}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&rel=0&loop=1&playlist=${data.trailerId}&enablejsapi=1`
        : null;

    // Track how long the trailer has been visible so the details page can
    // resume the YouTube iframe at roughly the same playhead, giving the
    // Netflix-style "trailer keeps playing" feel across the route change.
    const openedAtRef = useRef<number>(Date.now());
    useEffect(() => {
        openedAtRef.current = Date.now();
        const trailerId = data.trailerId;
        return () => {
            if (!trailerId) return;
            try {
                const seconds = Math.floor((Date.now() - openedAtRef.current) / 1000);
                sessionStorage.setItem(
                    `mmo:trailer-resume:${trailerId}`,
                    JSON.stringify({ seconds, at: Date.now() }),
                );
            } catch {
                /* sessionStorage unavailable — non-fatal */
            }
        };
    }, [data.trailerId]);

    return (
        <div ref={ref} role="dialog" aria-label={`Previzualizare ${data.title}`} className="poster-preview" style={style}>
            <div className="poster-preview-media">
                {mediaUrl ? (
                    <Image src={mediaUrl} alt={data.title} fill sizes="380px" className="poster-preview-img" />
                ) : (
                    <div className="poster-preview-placeholder"><Film size={32} aria-hidden /></div>
                )}
                {yt && (
                    <iframe className="poster-preview-trailer" src={yt} title={`${data.title} trailer`}
                        allow="autoplay; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" />
                )}
                <div className="poster-preview-shade" />
            </div>
            <div className="poster-preview-body">
                <div className="poster-preview-row">
                    <button type="button" onClick={onPlay} className="poster-preview-btn poster-preview-btn--primary" title="Redă">
                        <Play size={16} fill="currentColor" />
                    </button>
                    {(data.movieId || data.showId) ? (
                        <>
                            <button type="button" onClick={onWishlist} className="poster-preview-btn"
                                title={data.inWishlist ? "Scoate din wishlist" : "Adaugă în wishlist"}
                                aria-pressed={data.inWishlist}>
                                {data.inWishlist ? <Check size={14} /> : <Plus size={14} />}
                            </button>
                            <button type="button" onClick={onLike} className="poster-preview-btn"
                                title="Îmi place" aria-pressed={data.liked}>
                                <ThumbsUp size={14} />
                            </button>
                            <button type="button" onClick={onWatched} className="poster-preview-btn"
                                title={data.watched ? "Marchează nevăzut" : "Marchează vizionat"}
                                aria-pressed={data.watched}>
                                <Check size={14} />
                            </button>
                        </>
                    ) : null}
                    <button type="button" onClick={onOpenModal}
                        className="poster-preview-btn poster-preview-btn--more"
                        title="Vezi detalii" style={{ marginLeft: "auto" }}>
                        <ChevronDown size={16} />
                    </button>
                </div>
                <div className="poster-preview-title">{data.title}</div>
                <div className="poster-preview-meta">
                    {data.rating != null && data.rating > 0 && <span className="poster-preview-rating">★ {data.rating.toFixed(1)}</span>}
                    {data.year && <span>{data.year}</span>}
                    {data.runtime ? <span>{formatRuntime(data.runtime)}</span> : null}
                    {data.ageRating && <span className="poster-preview-badge">{data.ageRating}</span>}
                    {data.kind === "tv" && data.seasonCount ? (
                        <span>{data.seasonCount} {data.seasonCount === 1 ? "sezon" : "sezoane"}</span>
                    ) : null}
                </div>
                {data.genres && data.genres.length > 0 && (
                    <div className="poster-preview-genres">
                        {data.genres.slice(0, 3).map((g, i) => (
                            <span key={g}>
                                {i > 0 && <span aria-hidden> • </span>}{g}
                            </span>
                        ))}
                    </div>
                )}
                {data.tech && <TechBadges tech={data.tech} />}
                {data.overview && <p className="poster-preview-overview">{data.overview}</p>}
            </div>
        </div>
    );
}

/* ─────────────────────── Details modal ─────────────────────────────────── */

export function PosterDetailsModal({
    data, onClose,
}: {
    data: PreviewData;
    onClose: () => void;
}) {
    const router = useRouter();
    const [, startTransition] = useTransition();
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        const t = requestAnimationFrame(() => setMounted(true));
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            cancelAnimationFrame(t);
            document.removeEventListener("keydown", onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [onClose]);

    const backdrop = data.backdropPath ? `https://image.tmdb.org/t/p/w1280${data.backdropPath}` : null;
    const poster = data.posterPath ? `https://image.tmdb.org/t/p/w780${data.posterPath}` : null;
    const heroImage = backdrop ?? poster;
    const yt = data.trailerId
        ? `https://www.youtube-nocookie.com/embed/${data.trailerId}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&rel=0&loop=1&playlist=${data.trailerId}`
        : null;

    const onPlay = () => router.push(data.href);
    const onWishlist = () => startTransition(async () => {
        try {
            await toggleWishlist(data.kind === "movie"
                ? { movieId: data.movieId! } : { tvShowId: data.showId! });
            toast.success(data.inWishlist ? "Scos din wishlist" : "Adăugat în wishlist");
        } catch { toast.error("Acțiune eșuată"); }
    });

    return (
        <div className="poster-modal-backdrop" data-mounted={mounted ? "1" : "0"} onClick={onClose} role="presentation">
            <div className="poster-modal" data-mounted={mounted ? "1" : "0"}
                role="dialog" aria-modal="true" aria-labelledby="poster-modal-title"
                onClick={(e) => e.stopPropagation()}>
                <button type="button" className="poster-modal-close" onClick={onClose} aria-label="Închide">
                    <X size={20} />
                </button>
                <div className="poster-modal-hero">
                    {heroImage && (
                        <Image src={heroImage} alt={data.title} fill priority sizes="(max-width: 1100px) 100vw, 1100px" className="poster-modal-img" />
                    )}
                    {yt && (
                        <iframe className="poster-modal-trailer" src={yt} title={`${data.title} trailer`}
                            allow="autoplay; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" />
                    )}
                    <div className="poster-modal-fade" />
                    <div className="poster-modal-hero-info">
                        <h2 id="poster-modal-title" className="poster-modal-title">{data.title}</h2>
                        <div className="poster-modal-actions">
                            <button type="button" className="poster-modal-btn poster-modal-btn--play" onClick={onPlay}>
                                <Play size={18} fill="currentColor" /> Redă
                            </button>
                            {(data.movieId || data.showId) && (
                                <button type="button" className="poster-modal-btn" onClick={onWishlist}
                                    aria-pressed={data.inWishlist}>
                                    {data.inWishlist ? <Check size={18} /> : <Plus size={18} />}
                                </button>
                            )}
                            <Link href={data.href} className="poster-modal-btn poster-modal-btn--info">
                                <Info size={16} /> Pagina completă
                            </Link>
                        </div>
                    </div>
                </div>
                <div className="poster-modal-body">
                    <div className="poster-modal-meta">
                        {data.rating != null && data.rating > 0 && <span className="poster-modal-rating">★ {data.rating.toFixed(1)}</span>}
                        {data.year && <span>{data.year}</span>}
                        {data.runtime ? <span>{formatRuntime(data.runtime)}</span> : null}
                        {data.ageRating && <span className="poster-modal-pill">{data.ageRating}</span>}
                        {data.kind === "tv" && data.seasonCount ? (
                            <span>{data.seasonCount} {data.seasonCount === 1 ? "sezon" : "sezoane"}{data.episodeCount ? ` · ${data.episodeCount} episoade` : ""}</span>
                        ) : null}
                    </div>
                    {data.overview && <p className="poster-modal-overview">{data.overview}</p>}
                    {data.tech && (
                        <div className="poster-modal-tech">
                            <div className="poster-modal-label">Fișier video</div>
                            <TechBadges tech={data.tech} verbose />
                        </div>
                    )}
                    <div className="poster-modal-grid">
                        {data.genres && data.genres.length > 0 && (
                            <div>
                                <div className="poster-modal-label">Genuri</div>
                                <div className="poster-modal-tags">
                                    {data.genres.map((g) => <span key={g} className="poster-modal-tag">{g}</span>)}
                                </div>
                            </div>
                        )}
                        {data.cast && data.cast.length > 0 && (
                            <div>
                                <div className="poster-modal-label">Distribuție</div>
                                <div className="poster-modal-cast">
                                    {data.cast.slice(0, 8).map((c) => (
                                        <span key={c.name} className="poster-modal-cast-item">
                                            <strong>{c.name}</strong>
                                            {c.character ? <em>{c.character}</em> : null}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

/* ─────────────────────── Host (per-card) ───────────────────────────────── */

/**
 * Mounts at the bottom of <PosterCard> and renders the popover/modal portals
 * when triggered. Keeps state local so each card owns its own preview lifecycle.
 */
export function PosterPreviewHost({
    data, anchorEl, openPopover, openModal, onClose, onClosePopover, onOpenModal,
}: {
    data: PreviewData;
    anchorEl: HTMLElement | null;
    openPopover: boolean;
    openModal: boolean;
    onClose: () => void;
    onClosePopover: () => void;
    onOpenModal: () => void;
}) {
    const [anchor, setAnchor] = useState<AnchorRect | null>(null);
    useEffect(() => {
        if (openPopover && anchorEl) {
            const r = anchorEl.getBoundingClientRect();
            setAnchor({ top: r.top, left: r.left, width: r.width, height: r.height });
        }
    }, [openPopover, anchorEl]);
    if (typeof document === "undefined") return null;
    return createPortal(
        <>
            {openPopover && anchor && (
                <PosterPopover data={data} anchor={anchor} onClose={onClosePopover}
                    onOpenModal={onOpenModal} />
            )}
            {openModal && <PosterDetailsModal data={data} onClose={onClose} />}
        </>,
        document.body,
    );
}

/* ─────────────────────── Helpers ───────────────────────────────────────── */

function formatRuntime(min: number): string {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
function resolutionLabel(w?: number | null, h?: number | null): string | null {
    if (!h) return null;
    if (h >= 2000) return "4K";
    if (h >= 1400) return "1440p";
    if (h >= 1000) return "1080p";
    if (h >= 700) return "720p";
    if (h >= 400) return "480p";
    return w && h ? `${w}×${h}` : null;
}

function channelsLabel(ch?: number | null): string | null {
    if (!ch) return null;
    if (ch >= 8) return "7.1";
    if (ch >= 6) return "5.1";
    if (ch >= 2) return "Stereo";
    return "Mono";
}

export function TechBadges({ tech, verbose = false }: { tech: VideoTech; verbose?: boolean }) {
    const res = resolutionLabel(tech.width, tech.height);
    const ch = channelsLabel(tech.audioChannels);
    const items: Array<{ key: string; label: string; tone?: string }> = [];
    if (res) items.push({ key: "res", label: res, tone: "res" });
    if (tech.hdr && tech.hdr.toLowerCase() !== "sdr") items.push({ key: "hdr", label: tech.hdr.toUpperCase(), tone: "hdr" });
    if (verbose && tech.videoCodec) items.push({ key: "vc", label: tech.videoCodec.toUpperCase() });
    if (tech.audioCodec) items.push({ key: "ac", label: tech.audioCodec.toUpperCase(), tone: "audio" });
    if (ch) items.push({ key: "ch", label: ch, tone: "audio" });
    if (verbose && tech.audioLangs && tech.audioLangs.length > 0) {
        items.push({ key: "lang", label: tech.audioLangs.slice(0, 3).map((l) => l.toUpperCase()).join(" / "), tone: "lang" });
    }
    if (verbose && tech.subtitleLangs && tech.subtitleLangs.length > 0) {
        items.push({ key: "sub", label: `CC ${tech.subtitleLangs.slice(0, 3).map((l) => l.toUpperCase()).join("/")}`, tone: "sub" });
    }
    if (items.length === 0) return null;
    return (
        <div className="tech-badges">
            {items.map((it) => (
                <span key={it.key} className={`tech-badge${it.tone ? ` tech-badge--${it.tone}` : ""}`}>{it.label}</span>
            ))}
        </div>
    );
}
export function previewChildrenSlot(_: ReactNode) { return null; }
