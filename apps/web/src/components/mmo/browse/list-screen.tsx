"use client";

/** My list (`/media/list`): the active profile's watchlist (`/media/watchlist`) as a poster grid, remove per card. */
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Heart, X } from "lucide-react";
import { Button, EmptyState } from "@mmo/ui";
import type { TitleCard } from "@/lib/mmo/media-types";
import { BackdropProvider } from "../backdrop";
import { MxTitleCard } from "../title-card";
import { ErrorBlock, GridSkeleton, PosterGrid, Unsupported, useMediaScope } from "./common";
import { useAsync } from "./use-async";

export function ListScreen() {
    const t = useTranslations("mx.browse.list");
    const { media, scope } = useMediaScope();
    const { load, retry } = useAsync<TitleCard[]>(scope ? `${scope}|watchlist` : null, async (attempt) => {
        if (!media) return null;
        if (attempt > 0) media.invalidate();
        const w = await media.watchlist();
        return w ? w.items : null;
    });
    const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const remove = async (c: TitleCard) => {
        if (!media) return;
        const key = `${c.kind}:${c.tmdbId}`;
        setBusy(key);
        setError(null);
        setRemoved((s) => new Set(s).add(key));
        try {
            await media.watchlistRemove(c.kind, c.tmdbId);
        } catch {
            setRemoved((s) => { const n = new Set(s); n.delete(key); return n; });
            setError(t("removeError", { title: c.title }));
        } finally {
            setBusy(null);
        }
    };

    const items = load.s === "ok" ? load.data.filter((c) => !removed.has(`${c.kind}:${c.tmdbId}`)) : [];
    return (
        <BackdropProvider>
            <div className="mx-page-head">
                <div>
                    <h1 className="mx-page-title">{t("title")}</h1>
                    {load.s === "ok" ? <p className="mxb-count" role="status">{t("count", { count: items.length })}</p> : null}
                </div>
            </div>
            {error ? <p className="text-destructive mb-4 text-sm" role="alert">{error}</p> : null}
            {load.s === "loading" ? <GridSkeleton label={t("loading")} count={12} /> : null}
            {load.s === "error" ? <ErrorBlock error={load.error} onRetry={retry} /> : null}
            {load.s === "unsupported" ? <Unsupported /> : null}
            {load.s === "ok" && items.length === 0 ? (
                <EmptyState
                    icon={<Heart aria-hidden />}
                    title={t("empty")}
                    description={t("emptyBody")}
                    actions={<Button render={<Link href="/media/search" />}>{t("browse")}</Button>}
                />
            ) : null}
            {items.length > 0 ? (
                <PosterGrid label={t("title")}>
                    {items.map((c) => {
                        const key = `${c.kind}:${c.tmdbId}`;
                        return (
                            <li key={key} className="mxb-list-item">
                                <MxTitleCard item={c} />
                                <button type="button" className="mxb-remove" onClick={() => void remove(c)} disabled={busy === key} aria-label={t("remove", { title: c.title })} title={t("remove", { title: c.title })}>
                                    <X aria-hidden className="size-4" />
                                </button>
                            </li>
                        );
                    })}
                </PosterGrid>
            ) : null}
        </BackdropProvider>
    );
}
