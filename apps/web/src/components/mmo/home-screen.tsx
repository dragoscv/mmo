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
    return heroCandidates(rows)[0] ?? null;
}

/** Hero pool: titles with a backdrop outside `continue`, in-library first, unique, at most [n]. */
export function heroCandidates(rows: HomeRow[], n = 6): TitleCard[] {
    const pool = rows.filter((r) => r.id !== "continue").flatMap((r) => r.items).filter((i) => i.backdropPath);
    const ordered = [...pool.filter((i) => i.inLibrary), ...pool.filter((i) => !i.inLibrary)];
    const seen = new Set<string>();
    return ordered.filter((i) => { const k = `${i.kind}:${i.tmdbId}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, n);
}

/**
 * The billboard reads best with the title's logo art (critic: subject presence). Probe the candidates'
 * details (cached per title by MediaClient) and switch once to the first with a logo; the first
 * candidate shows meanwhile and stays when none has one.
 */
function usePreferredHero(rows: HomeRow[]): TitleCard | null {
    const { clients } = useMmo();
    const candidates = heroCandidates(rows);
    const sig = candidates.map((c) => `${c.kind}:${c.tmdbId}`).join(",");
    const [preferred, setPreferred] = useState<{ sig: string; key: string } | null>(null);
    useEffect(() => {
        if (!clients || !sig) return;
        let alive = true;
        void (async () => {
            for (const k of sig.split(",")) {
                const [kind, id] = k.split(":");
                const r = await clients.media.mediaTitle(kind as TitleCard["kind"], Number(id)).catch(() => null);
                if (!alive) return;
                if (r?.title?.logoPath) { setPreferred({ sig, key: k }); return; }
            }
        })();
        return () => { alive = false; };
    }, [clients, sig]);
    const hit = preferred?.sig === sig ? candidates.find((c) => `${c.kind}:${c.tmdbId}` === preferred.key) : undefined;
    return hit ?? candidates[0] ?? null;
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
    const hero = usePreferredHero(rows);

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
