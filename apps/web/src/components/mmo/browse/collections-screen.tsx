"use client";

/**
 * Collections (`/media/collections`): the server has no collections endpoint; Home builds franchise rows
 * (`collection:<id>`, TMDB collection parts) from what the profile watched. This page lists those rows from the
 * cached/revalidated `/media/home` — one grid per franchise.
 */
import Link from "@/components/host/host-context";
import { useMemo, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Library } from "lucide-react";
import { Button, EmptyState } from "@mmo/ui";
import type { MediaHome } from "@/lib/mmo/media-types";
import { BackdropProvider } from "../backdrop";
import { MxTitleCard } from "../title-card";
import { ErrorBlock, GridSkeleton, PosterGrid, Unsupported, useMediaScope } from "./common";
import { collectionRows } from "./lib";
import { useAsync } from "./use-async";

const noop = () => () => undefined;

export function CollectionsScreen() {
    const t = useTranslations("mx.browse.collections");
    const locale = useLocale() === "en" ? "en" : "ro";
    const { media, scope } = useMediaScope();
    const hydrated = useSyncExternalStore(noop, () => true, () => false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scope changes with the active profile (homeCached is per profile)
    const cached = useMemo(() => (hydrated ? media?.homeCached() ?? null : null), [hydrated, media, scope]);
    const fetched = useAsync<MediaHome>(scope ? `${scope}|home` : null, async (attempt) => {
        if (!media) return null;
        const c = media.homeCached();
        const fresh = await media.revalidateHome(!c || attempt > 0);
        return fresh ?? c;
    });
    // Cached home paints instantly; a failed revalidation keeps showing it.
    const load = fetched.load.s === "ok" || !cached ? fetched.load : { s: "ok" as const, data: cached };
    const rows = load.s === "ok" ? collectionRows(load.data.rows) : [];
    return (
        <BackdropProvider>
            <div className="mx-page-head">
                <h1 className="mx-page-title">{t("title")}</h1>
            </div>
            {load.s === "loading" ? <GridSkeleton count={12} label={t("loading")} /> : null}
            {load.s === "error" ? <ErrorBlock error={load.error} onRetry={fetched.retry} /> : null}
            {load.s === "unsupported" ? <Unsupported /> : null}
            {load.s === "ok" && rows.length === 0 ? (
                <EmptyState icon={<Library aria-hidden />} title={t("empty")} description={t("emptyBody")} actions={<Button render={<Link href="/media/browse/movie" />}>{t("browse")}</Button>} />
            ) : null}
            <div className="mx-rows">
                {rows.map((r) => (
                    <section key={r.id} aria-labelledby={`mxb-col-${r.id}`} className="mxb-section">
                        <h2 id={`mxb-col-${r.id}`} className="mxb-h2">{r.title[locale]} <span className="mxb-count">({t("count", { count: r.items.length })})</span></h2>
                        <PosterGrid label={r.title[locale]}>
                            {r.items.map((c) => <li key={`${c.kind}:${c.tmdbId}`}><MxTitleCard item={c} /></li>)}
                        </PosterGrid>
                    </section>
                ))}
            </div>
        </BackdropProvider>
    );
}
