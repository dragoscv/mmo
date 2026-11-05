"use client";

/**
 * Shared building blocks for the browse pages: skeleton grid, error/unsupported states, a keyboard-navigable
 * poster grid (arrows move by the real rendered column count, Home/End jump) and a library card.
 */
import Link from "next/link";
import { memo, useCallback, type KeyboardEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, RefreshCw, ServerOff } from "lucide-react";
import { Button, EmptyState } from "@mmo/ui";
import { ApiError } from "@/lib/mmo/api";
import { tmdbImg } from "@/lib/media/normalize";
import { useBackdrop } from "../backdrop";
import { useMmo } from "../mmo-provider";
import { stillUrl } from "../player/model";
import { tagPosterForMorph, titleHref } from "../title-card";
import { gridMove, type LibDetails, type LibEntry } from "./lib";

export type Load<T> = { s: "loading" } | { s: "ok"; data: T } | { s: "error"; error: unknown } | { s: "unsupported" };

/** Media client + a cache key scoped to the target server and active profile (null until a client exists). */
export function useMediaScope() {
    const { clients, server, profile } = useMmo();
    const media = clients?.media ?? null;
    return { media, scope: media ? `${server?.baseUrl ?? ""}|${profile?.id ?? media.profile}` : null };
}

export function GridSkeleton({ count = 18, wide = false, label }: { count?: number; wide?: boolean; label?: string }) {
    return (
        <div aria-busy>
            {label ? <p className="sr-only" role="status">{label}</p> : null}
            <div className={`mx-grid${wide ? " mx-grid-wide" : ""}`} aria-hidden>
                {Array.from({ length: count }, (_, i) => (
                    <div key={i} className="mxb-skel">
                        <div className={`mxb-skel-img bg-muted animate-pulse${wide ? " mxb-skel-wide" : ""}`} />
                        <div className="mxb-skel-line bg-muted animate-pulse" />
                    </div>
                ))}
            </div>
        </div>
    );
}

/** Error with retry; 403 → age-restricted copy; `null` responses (old server) use `<Unsupported/>`. */
export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
    const t = useTranslations("mx.browse.state");
    const restricted = error instanceof ApiError && error.status === 403;
    const message = error instanceof Error ? error.message : String(error);
    return (
        <EmptyState
            tone="error"
            icon={<AlertTriangle aria-hidden />}
            title={restricted ? t("restricted") : t("error")}
            description={restricted ? t("restrictedBody") : t("errorBody", { message })}
            actions={onRetry && !restricted ? <Button onClick={onRetry}><RefreshCw aria-hidden className="size-4" /> {t("retry")}</Button> : undefined}
        />
    );
}

export function Unsupported() {
    const t = useTranslations("mx.browse.state");
    return <EmptyState icon={<ServerOff aria-hidden />} title={t("unsupported")} description={t("unsupportedBody")} />;
}

function focusablesIn(el: HTMLElement): HTMLElement[] {
    // Cards are the direct link child of each <li> (secondary buttons such as "Remove" stay Tab-only).
    return Array.from(el.querySelectorAll<HTMLElement>(":scope > li > a[href]"));
}

/** Columns actually rendered: items sharing the first item's top offset. */
export function renderedColumns(items: HTMLElement[]): number {
    const first = items[0];
    if (!first) return 1;
    const top = first.getBoundingClientRect().top;
    let n = 0;
    for (const el of items) { if (Math.abs(el.getBoundingClientRect().top - top) < 4) n++; else break; }
    return Math.max(1, n);
}

/** onKeyDown for a `<ul class="mx-grid">` whose `<li>` children each hold one card link. */
export function useGridKeys() {
    return useCallback((e: KeyboardEvent<HTMLElement>) => {
        const items = focusablesIn(e.currentTarget);
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (i < 0) return;
        const n = gridMove(i, e.key, renderedColumns(items), items.length);
        if (n == null) return;
        const target = items[n];
        if (!target) return;
        e.preventDefault();
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }, []);
}

export function PosterGrid({ children, label, wide = false, onKeyDown, gridRef }: {
    children: ReactNode; label: string; wide?: boolean; onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void; gridRef?: (el: HTMLUListElement | null) => void;
}) {
    const keys = useGridKeys();
    return (
        <ul ref={gridRef} className={`mx-grid mxb-grid${wide ? " mx-grid-wide" : ""}`} aria-label={label} onKeyDown={(e) => { onKeyDown?.(e); if (!e.defaultPrevented) keys(e); }}>
            {children}
        </ul>
    );
}

/** Poster card for a library entry (details may still be loading → guessed name, no poster). */
export const LibCard = memo(function LibCard({ entry, details, progress, sub }: {
    entry: LibEntry; details: LibDetails | null; progress?: number | null; sub?: string;
}) {
    const { set } = useBackdrop();
    const { server } = useMmo();
    const title = details?.title ?? entry.guess;
    const img = tmdbImg(details?.posterPath ?? null, "w342");
    const fileId = entry.files[0]?.serverFileId;
    const still = !img && server && fileId ? stillUrl(server.baseUrl, fileId, { kind: "token", token: server.token, userId: server.userId }) : null;
    const subtitle = sub ?? [details?.year, details?.rating ? `★ ${details.rating.toFixed(1)}` : null, entry.res !== "SD" ? entry.res : null].filter(Boolean).join(" · ");
    const body = (
        <>
            <span className="mx-card-img">
                {img
                    // eslint-disable-next-line @next/next/no-img-element -- TMDB CDN poster
                    ? <img src={img} alt="" loading="lazy" decoding="async" />
                    : (
                        <>
                            {/* eslint-disable-next-line @next/next/no-img-element -- server still frame, hidden if it fails */}
                            {still ? <img src={still} alt="" loading="lazy" decoding="async" className="mx-card-still" onError={(e) => { e.currentTarget.hidden = true; }} /> : null}
                            <span className="mx-card-fallback" data-still={still ? "" : undefined}>{title}</span>
                        </>
                    )}
                {typeof progress === "number" && progress > 0 ? (
                    <span className="mx-card-progress" aria-hidden><span style={{ width: `${Math.round(Math.min(1, progress) * 100)}%` }} /></span>
                ) : null}
            </span>
            <span className="mx-card-title">{title}</span>
            {subtitle ? <span className="mx-card-sub">{subtitle}</span> : null}
        </>
    );
    if (entry.tmdbId == null) return <div className="mx-card mxb-card-static">{body}</div>;
    const focus = () => set(details?.backdropPath);
    return (
        <Link href={titleHref(entry.kind, entry.tmdbId)} className="mx-card" onMouseEnter={focus} onFocus={focus} onClick={img ? tagPosterForMorph : undefined} prefetch={false}>
            {body}
        </Link>
    );
});
