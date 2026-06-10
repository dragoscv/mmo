"use client";

/**
 * In-page YouTube trailer modal. Replaces the "open trailer in a new tab"
 * pattern used across the watch detail surfaces. Mounts a portal at the
 * end of <body>, locks page scroll, autoplays with controls + sound
 * enabled (user-initiated, so the browser allows audio), and closes on
 * Escape / backdrop click / X button.
 *
 * Usage:
 *   <TrailerButton trailerYoutubeId={movie.trailerYoutubeId} title={movie.title} />
 *   <TrailerButton trailerYoutubeId={trailer.key} title={tm.title} variant="primary" />
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Play, X } from "lucide-react";

interface TrailerButtonProps {
    trailerYoutubeId: string | null | undefined;
    title: string;
    /** "ghost" matches the existing `watch-cta` look, "primary" is filled. */
    variant?: "ghost" | "primary";
    label?: string;
    className?: string;
}

export function TrailerButton({
    trailerYoutubeId,
    title,
    variant = "ghost",
    label = "Trailer",
    className,
}: TrailerButtonProps) {
    const [open, setOpen] = useState(false);
    if (!trailerYoutubeId) return null;

    const base = variant === "primary" ? "watch-cta watch-cta--accent" : "watch-cta";

    return (
        <>
            <button
                type="button"
                className={className ?? base}
                onClick={() => setOpen(true)}
                aria-haspopup="dialog"
            >
                <Play size={14} fill="currentColor" style={{ marginRight: 6 }} aria-hidden />
                {label}
            </button>
            {open && (
                <TrailerModal
                    trailerYoutubeId={trailerYoutubeId}
                    title={title}
                    onClose={() => setOpen(false)}
                />
            )}
        </>
    );
}

interface TrailerModalProps {
    trailerYoutubeId: string;
    title: string;
    onClose: () => void;
}

export function TrailerModal({ trailerYoutubeId, title, onClose }: TrailerModalProps) {
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

    const stop = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

    // Match HeroTrailer's exact embed URL shape (which works) — just with
    // sound on and controls visible since this is an explicit play action.
    // `origin` is required when `enablejsapi=1` is set on some browsers,
    // otherwise the player renders as an opaque black frame.
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const src = `https://www.youtube-nocookie.com/embed/${trailerYoutubeId}`
        + `?autoplay=1&controls=1&modestbranding=1&playsinline=1&rel=0&enablejsapi=1`
        + (origin ? `&origin=${encodeURIComponent(origin)}` : "");

    if (typeof document === "undefined") return null;

    return createPortal(
        <div
            className="trailer-modal-backdrop"
            data-mounted={mounted ? "1" : "0"}
            onClick={onClose}
            role="presentation"
        >
            <div
                className="trailer-modal"
                data-mounted={mounted ? "1" : "0"}
                role="dialog"
                aria-modal="true"
                aria-label={`${title} – trailer`}
                onClick={stop}
            >
                <button
                    type="button"
                    className="trailer-modal-close"
                    onClick={onClose}
                    aria-label="Close trailer"
                >
                    <X size={20} />
                </button>
                <div className="trailer-modal-frame">
                    <iframe
                        key={trailerYoutubeId}
                        src={src}
                        title={`${title} trailer`}
                        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                        allowFullScreen
                        referrerPolicy="strict-origin-when-cross-origin"
                        loading="eager"
                    />
                </div>
            </div>
        </div>,
        document.body,
    );
}
