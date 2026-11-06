"use client";

/**
 * Horizontal row with roving keyboard focus (←/→ move within, ↑/↓ jump to the same column of the
 * previous/next row — rows are found via `[data-mx-row]`). Native scroll + snap, no carousel lib.
 */
import Link from "@/components/host/host-context";
import { useId, type KeyboardEvent, type ReactNode } from "react";

export function MxRow({ title, reason, seeAllHref, seeAllLabel, children, testId }: {
    title: string; reason?: string; seeAllHref?: string; seeAllLabel?: string; children: ReactNode; testId?: string;
}) {
    const id = useId();
    return (
        <section aria-labelledby={id} data-testid={testId}>
            <div className="mx-row-head">
                <div>
                    <h2 id={id} className="mx-row-title">{title}</h2>
                    {reason ? <p className="mx-row-reason">{reason}</p> : null}
                </div>
                {seeAllHref ? <Link href={seeAllHref} className="text-muted-foreground text-sm hover:underline">{seeAllLabel}</Link> : null}
            </div>
            <ul className="mx-row-track" data-mx-row onKeyDown={rowKeys}>
                {children}
            </ul>
        </section>
    );
}

function focusables(el: Element | null): HTMLElement[] {
    return el ? Array.from(el.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")) : [];
}

export function rowKeys(e: KeyboardEvent<HTMLElement>) {
    const track = e.currentTarget;
    const items = focusables(track);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    let target: HTMLElement | undefined;
    if (e.key === "ArrowRight") target = items[Math.min(items.length - 1, i + 1)];
    else if (e.key === "ArrowLeft") target = items[Math.max(0, i - 1)];
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const rows = Array.from(document.querySelectorAll("[data-mx-row]"));
        const r = rows.indexOf(track);
        const other = rows[e.key === "ArrowDown" ? r + 1 : r - 1];
        if (!other) return;
        const left = (document.activeElement as HTMLElement).getBoundingClientRect().left;
        const cand = focusables(other);
        target = cand.reduce<HTMLElement | undefined>((best, el) => {
            const d = Math.abs(el.getBoundingClientRect().left - left);
            return !best || d < Math.abs(best.getBoundingClientRect().left - left) ? el : best;
        }, undefined);
    } else return;
    if (!target) return;
    e.preventDefault();
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

export function RowSkeleton({ count = 8 }: { count?: number }) {
    return (
        <div aria-hidden className="mx-skel-row">
            {Array.from({ length: count }, (_, i) => <div key={i} className="mx-skel-card bg-muted animate-pulse" />)}
        </div>
    );
}
