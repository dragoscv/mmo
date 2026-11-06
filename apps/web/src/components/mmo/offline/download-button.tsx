"use client";

/**
 * Download-for-offline button (WP16-42). Mount on title / episode / album pages:
 *   <DownloadButton item={{ serverId, profileId, kind, id, title, poster, durationSec, url }} />
 * `url` = the ORIGINAL file with credentials (see `lib/mmo/offline/urls.ts`):
 *   video → `offlineVideoUrl(clients.cfg, serverFileId)`; track → `clients.music.streamUrl(track)`.
 * States: download → queued → n% (press = pause) → paused (press = resume) → downloaded (press = open
 * /media/downloads) → error (press = retry). Progress is announced through a polite live region.
 */
import { useEffect, useMemo } from "react";
import Link from "@/components/host/host-context";
import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2, Download, Pause, Play } from "lucide-react";
import { Button, cn, type ButtonProps } from "@mmo/ui";
import { DOWNLOADS_ROUTE, buildKey, stripAuth, type OfflineKind } from "@/lib/mmo/offline/keys";
import { percent } from "@/lib/mmo/offline/math";
import { useOfflineItem } from "./use-offline";

export interface DownloadButtonItem {
    serverId: string;
    profileId: string;
    kind: OfflineKind;
    id: string;
    title: string;
    /** Secondary line in the downloads list (show · S1E2, artist · album). */
    subtitle?: string | null;
    poster?: string | null;
    durationSec?: number | null;
    url: string;
}

export interface DownloadButtonProps {
    item: DownloadButtonItem;
    /** `icon` = round icon-only button (cards, track rows); `default` shows the label. */
    variant?: "default" | "icon";
    size?: ButtonProps["size"];
    className?: string;
}

/** Announce at most every 10 % so screen readers are not flooded. */
const LIVE_STEP = 10;

export function DownloadButton({ item, variant = "default", size, className }: DownloadButtonProps) {
    const t = useTranslations("mx.offline.button");
    const key = useMemo(() => {
        try { return buildKey(item); } catch { return null; }
    }, [item]);
    const { item: rec, manager } = useOfflineItem(key);

    const status = rec?.status ?? null;
    const pct = rec ? percent(rec.bytes, rec.size) : null;

    // Queued downloads survive a reload without credentials; hand the live ones back (memory only).
    useEffect(() => {
        if (!manager) return;
        try {
            const { creds } = stripAuth(item.url);
            if (creds.token) manager.setCreds(item.serverId, { token: creds.token, userId: creds.userId ?? "" });
        } catch { /* not an absolute URL */ }
    }, [manager, item.url, item.serverId]);

    // Announcement derived from status; progress is bucketed to LIVE_STEP % so the text (and the
    // screen-reader announcement) only changes every 10 %.
    const title = item.title;
    const live = status === "queued" ? t("live.queued", { title })
        : status === "done" ? t("live.done", { title })
        : status === "error" ? t("live.error", { title })
        : status === "downloading" && pct !== null ? t("live.progress", { title, percent: Math.floor(pct / LIVE_STEP) * LIVE_STEP })
        : "";

    const icon = variant === "icon";
    const btnSize = size ?? (icon ? "icon" : "default");
    const liveRegion = <span className="sr-only" role="status" aria-live="polite">{live}</span>;

    if (!manager || !key) {
        return (
            <Button variant="outline" size={btnSize} disabled className={className} aria-label={t("unavailable")} title={t("unavailable")}>
                <Download aria-hidden className="size-4" />
                {icon ? null : <span>{t("download")}</span>}
            </Button>
        );
    }

    if (status === "done") {
        return (
            <>
                <Button
                    variant="secondary"
                    size={btnSize}
                    className={className}
                    render={<Link href={DOWNLOADS_ROUTE} />}
                    aria-label={t("doneNamed", { title: item.title })}
                    data-offline-state="done"
                >
                    <CheckCircle2 aria-hidden className="size-4 text-primary" />
                    {icon ? null : <span>{t("done")}</span>}
                </Button>
                {liveRegion}
            </>
        );
    }

    let label: string;
    let aria: string;
    let Icon = Download;
    let onClick: () => void;
    let pressed: boolean | undefined;
    if (status === "downloading" || status === "queued") {
        const p = pct ?? 0;
        label = status === "queued" ? t("queued") : t("progress", { percent: p });
        aria = t("progressNamed", { title: item.title, percent: p });
        Icon = Pause;
        pressed = false;
        onClick = () => void manager.pause(key);
    } else if (status === "paused") {
        label = t("paused");
        aria = t("pausedNamed", { title: item.title });
        Icon = Play;
        pressed = true;
        onClick = () => void manager.resume(key);
    } else if (status === "error") {
        label = t("error");
        aria = t("errorNamed", { title: item.title });
        Icon = AlertCircle;
        onClick = () => void manager.enqueue(item);
    } else {
        label = t("download");
        aria = t("downloadNamed", { title: item.title });
        onClick = () => void manager.enqueue(item);
    }
    const ring = status === "downloading" && pct !== null ? pct : null;

    return (
        <>
            <Button
                variant={status === "error" ? "destructive" : "outline"}
                size={btnSize}
                className={cn("relative tabular-nums", className)}
                onClick={onClick}
                aria-label={aria}
                aria-pressed={pressed}
                data-offline-state={status ?? "none"}
                title={icon ? label : undefined}
            >
                {ring !== null ? (
                    <span
                        aria-hidden
                        className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left rounded-full bg-primary transition-transform"
                        style={{ transform: `scaleX(${ring / 100})` }}
                    />
                ) : null}
                <Icon aria-hidden className="size-4" />
                {icon ? null : <span>{label}</span>}
            </Button>
            {liveRegion}
        </>
    );
}
