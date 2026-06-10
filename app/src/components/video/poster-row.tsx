"use client";

/**
 * Horizontal poster row with hidden native scrollbar + hover-activated
 * arrow buttons. Snap-scrolling by viewport width. Keyboard arrows on
 * a focused child poster move focus to siblings; left/right arrow at
 * the row level pages by viewport.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
    title: string;
    /** Optional "See all →" link target. */
    seeAllHref?: string;
    /** Inline background glow color (e.g. derived from first poster).
     *  Pass `true` to opt into the default glow color without overriding it. */
    glow?: string | boolean;
    children: ReactNode;
}

export function PosterRow({ title, seeAllHref, glow, children }: Props) {
    const glowColor = typeof glow === "string" ? glow : undefined;
    const glowOn = Boolean(glow);
    const scrollRef = useRef<HTMLDivElement>(null);
    const [atStart, setAtStart] = useState(true);
    const [atEnd, setAtEnd] = useState(false);

    const update = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        setAtStart(el.scrollLeft <= 4);
        setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4);
    }, []);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        update();
        el.addEventListener("scroll", update, { passive: true });
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => {
            el.removeEventListener("scroll", update);
            ro.disconnect();
        };
    }, [update]);

    const scrollBy = useCallback((dir: 1 | -1) => {
        const el = scrollRef.current;
        if (!el) return;
        // 85% of viewport keeps a sliver of the previous batch visible
        // so the user retains spatial context.
        el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
    }, []);

    const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) {
            // Inside an inner poster — let the row handle PageUp/PageDown only.
            if (e.key !== "PageUp" && e.key !== "PageDown") return;
        }
        if (e.key === "ArrowRight" || e.key === "PageDown") {
            e.preventDefault();
            scrollBy(1);
        } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
            e.preventDefault();
            scrollBy(-1);
        }
    }, [scrollBy]);

    return (
        <section className="watch-row" data-glow={glowOn ? "true" : "false"} style={glowColor ? { ["--row-glow" as string]: glowColor } as React.CSSProperties : undefined}>
            <header className="watch-row-head">
                <h2 className="watch-row-title">{title}</h2>
                {seeAllHref && <Link href={seeAllHref} className="watch-row-link">See all →</Link>}
            </header>
            <div className="watch-row-viewport">
                <button
                    type="button"
                    className="watch-row-arrow is-prev"
                    aria-label="Scroll left"
                    data-disabled={atStart}
                    onClick={() => scrollBy(-1)}
                    tabIndex={atStart ? -1 : 0}
                >
                    <ChevronLeft size={20} />
                </button>
                <div
                    className="watch-row-scroll"
                    ref={scrollRef}
                    onKeyDown={onKeyDown}
                    role="list"
                >
                    {children}
                </div>
                <button
                    type="button"
                    className="watch-row-arrow is-next"
                    aria-label="Scroll right"
                    data-disabled={atEnd}
                    onClick={() => scrollBy(1)}
                    tabIndex={atEnd ? -1 : 0}
                >
                    <ChevronRight size={20} />
                </button>
            </div>
        </section>
    );
}
