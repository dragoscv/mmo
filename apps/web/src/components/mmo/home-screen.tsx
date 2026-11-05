"use client";

/**
 * Home (WP16-37): last `/media/home` for the active profile renders synchronously from
 * localStorage (`MediaClient.homeCached`), then `revalidateHome()` swaps in fresh rows when the
 * server etag moved. Timing is exposed as `window.__mixaiPerf.home` (first paint, cached flag).
 */
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Clapperboard, RefreshCw } from "lucide-react";
import { Button, EmptyState } from "@mmo/ui";
import type { HomeRow, MediaHome, TitleCard } from "@/lib/mmo/media-types";
import { BackdropProvider } from "./backdrop";
import { Hero } from "./hero";
import { useMmo } from "./mmo-provider";
import { MxRow, RowSkeleton } from "./row";
import { MxTitleCard } from "./title-card";

declare global { interface Window { __mixaiPerf?: Record<string, unknown> } }

export function pickHero(rows: HomeRow[]): TitleCard | null {
    const pool = rows.filter((r) => r.id !== "continue").flatMap((r) => r.items).filter((i) => i.backdropPath);
    return pool.find((i) => i.inLibrary) ?? pool[0] ?? null;
}

export function MediaHomeScreen() {
    const { profile } = useMmo();
    // Remount per profile so the cached home of the new profile renders synchronously.
    return <HomeBody key={profile?.id ?? "none"} />;
}

function HomeBody() {
    const t = useTranslations("mx.shell");
    const locale = useLocale() === "en" ? "en" : "ro";
    const { clients, server } = useMmo();
    const [home, setHome] = useState<MediaHome | null>(() => clients?.media.homeCached() ?? null);
    const [state, setState] = useState<"idle" | "loading" | "error">(home ? "idle" : "loading");

    useEffect(() => {
        if (!clients) return;
        const t0 = performance.now();
        const cached = clients.media.homeCached();
        if (cached) {
            requestAnimationFrame(() => {
                window.__mixaiPerf = { ...(window.__mixaiPerf ?? {}), home: { firstPaintMs: Math.round(performance.now() - t0), sinceNavMs: Math.round(performance.now()), cached: true } };
            });
        }
        let alive = true;
        clients.media.revalidateHome(!cached).then((fresh) => {
            if (!alive) return;
            if (fresh) setHome(fresh);
            setState("idle");
            if (!cached) window.__mixaiPerf = { ...(window.__mixaiPerf ?? {}), home: { firstPaintMs: Math.round(performance.now() - t0), sinceNavMs: Math.round(performance.now()), cached: false } };
        }).catch(() => { if (alive) setState(cached ? "idle" : "error"); });
        return () => { alive = false; };
    }, [clients]);

    const rows = home?.rows.filter((r) => r.items.length > 0) ?? [];
    const hero = pickHero(rows);

    if (state === "loading" && !home) {
        return (
            <div className="mx-rows pt-24" aria-busy>
                <p className="sr-only">{t("home.loading")}</p>
                {Array.from({ length: 3 }, (_, i) => <RowSkeleton key={i} />)}
            </div>
        );
    }
    if (state === "error" && !home) {
        return (
            <EmptyState
                tone="error"
                icon={<Clapperboard aria-hidden />}
                title={t("home.error")}
                description={t("offline.title", { server: server?.name || "MMO Server" })}
                actions={<Button onClick={() => location.reload()}><RefreshCw aria-hidden className="size-4" /> {t("home.retry")}</Button>}
            />
        );
    }
    if (rows.length === 0) {
        return <EmptyState icon={<Clapperboard aria-hidden />} title={t("home.empty")} description={t("home.emptyBody")} />;
    }
    return (
        <BackdropProvider>
            {hero ? <Hero item={hero} /> : <div className="pt-20" />}
            <div className="mx-rows" data-testid="media-home-rows">
                {rows.map((row) => {
                    const landscape = row.id === "continue";
                    return (
                        <MxRow key={row.id} title={row.title[locale]} reason={row.reason} testId={`row-${row.id}`}>
                            {row.items.map((it) => (
                                <li key={`${it.kind}:${it.tmdbId}`}><MxTitleCard item={it} variant={landscape ? "landscape" : "poster"} /></li>
                            ))}
                        </MxRow>
                    );
                })}
            </div>
        </BackdropProvider>
    );
}
