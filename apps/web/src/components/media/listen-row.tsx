"use client";

/**
 * Horizontal scroll row for square cards (WP11-05). Same a11y contract as
 * `MediaRow`: `role="list"` on the scroller, `role="listitem"` children,
 * prev/next arrows, ArrowLeft/ArrowRight paging when the scroller has
 * focus, scroll-snap, and instant scrolling under reduced motion.
 * Full width on ultrawide — the row owns its own horizontal padding.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, cn, usePrefersReducedMotion } from "@mmo/ui";

export interface ListenRowProps {
    title: string;
    /** Optional "See all" link / action rendered next to the title. */
    action?: ReactNode;
    children: ReactNode;
    className?: string;
    /** Accessible names for the paging arrows. */
    labels: { prev: string; next: string };
}

export function ListenRow({ title, action, children, className, labels }: ListenRowProps) {
    const id = useId();
    const scroller = useRef<HTMLDivElement>(null);
    const reduced = usePrefersReducedMotion();
    const [edge, setEdge] = useState<{ start: boolean; end: boolean }>({ start: true, end: true });

    const measure = useCallback(() => {
        const el = scroller.current;
        if (!el) return;
        const max = el.scrollWidth - el.clientWidth;
        setEdge({ start: el.scrollLeft <= 1, end: el.scrollLeft >= max - 1 });
    }, []);

    useEffect(() => {
        const el = scroller.current;
        if (!el) return;
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        el.addEventListener("scroll", measure, { passive: true });
        return () => { ro.disconnect(); el.removeEventListener("scroll", measure); };
    }, [measure]);

    const page = useCallback((dir: 1 | -1) => {
        const el = scroller.current;
        if (!el) return;
        el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.8), behavior: reduced ? "auto" : "smooth" });
    }, [reduced]);

    return (
        <section aria-labelledby={id} data-slot="listen-row" className={cn("group/row relative", className)}>
            <header className="mb-3 flex items-center justify-between gap-3">
                <h2 id={id} className="font-heading text-lg font-semibold tracking-tight">{title}</h2>
                <div className="flex items-center gap-1">
                    {action}
                    <Button variant="ghost" size="icon" aria-label={labels.prev} disabled={edge.start} onClick={() => page(-1)} className="hidden sm:inline-flex">
                        <ChevronLeft aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={labels.next} disabled={edge.end} onClick={() => page(1)} className="hidden sm:inline-flex">
                        <ChevronRight aria-hidden />
                    </Button>
                </div>
            </header>
            <div
                ref={scroller}
                role="list"
                tabIndex={0}
                aria-label={title}
                onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "ArrowRight") { e.preventDefault(); page(1); }
                    else if (e.key === "ArrowLeft") { e.preventDefault(); page(-1); }
                }}
                className={cn(
                    "-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2",
                    "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 rounded-lg",
                    reduced ? "scroll-auto" : "scroll-smooth",
                )}
            >
                {children}
            </div>
        </section>
    );
}

/** Square-card skeleton row used as the Suspense fallback. */
export function ListenRowSkeleton({ cards = 8 }: { cards?: number }) {
    return (
        <section aria-busy data-slot="listen-row-skeleton" className="mb-8">
            <div className="skeleton mb-3 h-5 w-40 rounded-md" />
            <div className="flex gap-3 overflow-hidden">
                {Array.from({ length: cards }, (_, i) => (
                    <div key={i} className="w-40 shrink-0 space-y-2">
                        <div className="skeleton aspect-square w-full rounded-xl" />
                        <div className="skeleton h-3.5 w-3/4 rounded" />
                        <div className="skeleton h-3 w-1/2 rounded" />
                    </div>
                ))}
            </div>
        </section>
    );
}
