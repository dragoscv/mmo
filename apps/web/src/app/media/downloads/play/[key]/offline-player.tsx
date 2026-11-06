"use client";

import Link from "@/components/host/host-context";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, HardDrive } from "lucide-react";
import { Button, EmptyState, ErrorState, Skeleton } from "@mmo/ui";
import { useOfflineItem } from "@/components/mmo/offline/use-offline";
import { mediaUrl, parseKey, posterUrl } from "@/lib/mmo/offline/keys";

/** Route params may arrive decoded or still percent-encoded depending on the router path. */
export function resolveRouteKey(raw: string): string | null {
    if (parseKey(raw)) return raw;
    try {
        const once = decodeURIComponent(raw);
        return parseKey(once) ? once : null;
    } catch {
        return null;
    }
}

export function OfflinePlayer({ rawKey }: { rawKey: string }) {
    const t = useTranslations("mx.offline.player");
    const key = resolveRouteKey(rawKey);
    const { item, manager } = useOfflineItem(key);
    const [failed, setFailed] = useState(false);

    const back = (
        <Button variant="ghost" render={<Link href="/media/downloads" />}>
            <ArrowLeft aria-hidden className="size-4" />{t("back")}
        </Button>
    );

    if (!key || !manager || item === null || (item && item.status !== "done")) {
        return (
            <section className="grid gap-4 py-4">
                <div>{back}</div>
                <EmptyState icon={<HardDrive aria-hidden />} title={t("missing")} />
            </section>
        );
    }
    if (item === undefined) {
        return (
            <section className="grid gap-4 py-4" aria-busy>
                <div>{back}</div>
                <span className="sr-only">{t("loading")}</span>
                <Skeleton className="aspect-video w-full rounded-xl" />
            </section>
        );
    }

    const src = mediaUrl(key);
    return (
        <section className="grid gap-4 py-4" aria-labelledby="od-play-title">
            <div>{back}</div>
            <div>
                <h1 id="od-play-title" className="mx-page-title">{item.title}</h1>
                <p className="text-sm text-muted-foreground">{[item.subtitle, t("offline")].filter(Boolean).join(" · ")}</p>
            </div>
            {failed ? <ErrorState title={t("error")} /> : null}
            {item.kind === "track" ? (
                <div className="grid max-w-xl gap-4">
                    {item.hasPoster ? (
                        // eslint-disable-next-line @next/next/no-img-element -- served by the SW from Cache Storage
                        <img src={posterUrl(key)} alt="" className="aspect-square w-full max-w-sm rounded-xl bg-muted object-cover" />
                    ) : null}
                    <audio controls autoPlay src={src} aria-label={item.title} className="w-full" onError={() => setFailed(true)} />
                </div>
            ) : (
                <video
                    controls
                    autoPlay
                    playsInline
                    src={src}
                    poster={item.hasPoster ? posterUrl(key) : undefined}
                    aria-label={item.title}
                    className="max-h-[80dvh] w-full rounded-xl bg-foreground"
                    onError={() => setFailed(true)}
                />
            )}
        </section>
    );
}
