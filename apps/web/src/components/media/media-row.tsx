"use client";

/**
 * MediaRow — horizontal carousel for Media Home (WP11-03).
 *
 * Built on embla-carousel-react 8.6 (`align: start`, `containScroll:
 * trimSnaps`, `watchFocus`) so keyboard focus, pointer drag and the arrow
 * buttons all move the same snap points. Keyboard: ←/→ page, Home/End
 * jump. Reduced motion (`data-motion="reduced"` on <html> or the OS
 * setting) turns off smooth scrolling (`duration: 0`).
 *
 * Item cap instead of a virtualiser: server rows are capped at 24 and the
 * merge never exceeds a few dozen, so a `@tanstack/react-virtual`
 * horizontal window would only add measurement churn that fights embla's
 * own slide layout. We render at most `MAX_ITEMS` (40) and expose a
 * "See all" link when a row is longer.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import useEmblaCarousel from "embla-carousel-react";
import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button, usePrefersReducedMotion } from "@mmo/ui";
import { useTranslations } from "next-intl";

export const MAX_ITEMS = 40;

export interface MediaRowProps {
    title: string;
    /** One-line "why this row". */
    reason?: string | null;
    seeAllHref?: string;
    /** Rendered inside the list; each child becomes one slide. */
    children: ReactNode[];
    /** Full item count when `children` was pre-sliced by the caller. */
    total?: number;
    /** DOM id for aria-labelledby / deep links. */
    id?: string;
}

function useReducedMotionAttr(): boolean {
    const os = usePrefersReducedMotion();
    const [attr, setAttr] = useState(false);
    useEffect(() => {
        const root = document.documentElement;
        const read = () => setAttr(root.getAttribute("data-motion") === "reduced");
        read();
        const mo = new MutationObserver(read);
        mo.observe(root, { attributes: true, attributeFilter: ["data-motion"] });
        return () => mo.disconnect();
    }, []);
    return os || attr;
}

export function MediaRow({ title, reason, seeAllHref, children, total, id }: MediaRowProps) {
    const t = useTranslations("home.row");
    const reduced = useReducedMotionAttr();
    const [viewportRef, embla] = useEmblaCarousel({
        align: "start",
        containScroll: "trimSnaps",
        dragFree: false,
        watchFocus: true,
        skipSnaps: false,
        duration: reduced ? 0 : 25,
    });
    const [canPrev, setCanPrev] = useState(false);
    const [canNext, setCanNext] = useState(false);

    useEffect(() => {
        if (!embla) return;
        const update = () => {
            setCanPrev(embla.canScrollPrev());
            setCanNext(embla.canScrollNext());
        };
        update();
        embla.on("select", update).on("reInit", update);
        return () => {
            embla.off("select", update).off("reInit", update);
        };
    }, [embla]);

    const page = useCallback((dir: 1 | -1) => {
        if (!embla) return;
        const slides = embla.slidesInView();
        const step = Math.max(1, slides.length - 1);
        const cur = embla.selectedScrollSnap();
        const target = dir > 0 ? cur + step : cur - step;
        embla.scrollTo(Math.max(0, Math.min(embla.scrollSnapList().length - 1, target)));
    }, [embla]);

    const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
        // Only handle keys on the row itself (children keep their own semantics).
        const rowLevel = e.target === e.currentTarget;
        switch (e.key) {
            case "ArrowRight": if (rowLevel) { e.preventDefault(); page(1); } break;
            case "ArrowLeft": if (rowLevel) { e.preventDefault(); page(-1); } break;
            case "PageDown": e.preventDefault(); page(1); break;
            case "PageUp": e.preventDefault(); page(-1); break;
            case "Home": e.preventDefault(); embla?.scrollTo(0); break;
            case "End": e.preventDefault(); embla?.scrollTo(embla.scrollSnapList().length - 1); break;
        }
    }, [embla, page]);

    const items = children.slice(0, MAX_ITEMS);
    const count = total ?? children.length;
    const truncated = count > items.length;
    const headingId = id ? `${id}-title` : undefined;

    return (
        <section className="media-row" data-slot="media-row" id={id} aria-labelledby={headingId}>
            <header className="media-row-head">
                <div className="min-w-0">
                    <h2 id={headingId} className="media-row-title">{title}</h2>
                    {reason ? <p className="media-row-reason">{reason}</p> : null}
                </div>
                <div className="flex items-center gap-1">
                    {(seeAllHref || truncated) && seeAllHref ? (
                        <Link href={seeAllHref} className="media-row-link">{t("seeAll", { count })}</Link>
                    ) : null}
                    <Button
                        variant="ghost" size="icon-sm" aria-label={t("prev")}
                        disabled={!canPrev} onClick={() => page(-1)} className="media-row-arrow"
                    >
                        <ChevronLeft aria-hidden />
                    </Button>
                    <Button
                        variant="ghost" size="icon-sm" aria-label={t("next")}
                        disabled={!canNext} onClick={() => page(1)} className="media-row-arrow"
                    >
                        <ChevronRight aria-hidden />
                    </Button>
                </div>
            </header>
            <div
                ref={viewportRef}
                className="media-row-viewport"
                data-reduced={reduced || undefined}
                role="list"
                aria-label={title}
                tabIndex={0}
                onKeyDown={onKeyDown}
            >
                <div className="media-row-track">
                    {items.map((child, i) => (
                        <div key={i} className="media-row-slide" role="presentation">{child}</div>
                    ))}
                    {truncated && seeAllHref ? (
                        <div className="media-row-slide" role="presentation">
                            <Link href={seeAllHref} className="media-row-more" role="listitem">{t("more", { count: count - items.length })}</Link>
                        </div>
                    ) : null}
                </div>
            </div>
        </section>
    );
}
