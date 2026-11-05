"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertCircle, Download, HardDrive, Pause, Play, RotateCcw, Trash2, WifiOff } from "lucide-react";
import {
    AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
    AlertDialogTitle, AlertDialogTrigger, AlertDialogAction, Button, EmptyState, ErrorState, Progress, Skeleton,
} from "@mmo/ui";
import { useMmo } from "@/components/mmo/mmo-provider";
import { useOfflineList } from "@/components/mmo/offline/use-offline";
import { posterUrl, scopeOf } from "@/lib/mmo/offline/keys";
import { formatBytes, percent, sum } from "@/lib/mmo/offline/math";
import type { OfflineManager } from "@/lib/mmo/offline/manager";
import type { OfflineItem } from "@/lib/mmo/offline/types";

function useOnline(): boolean {
    const [online, setOnline] = useState(true);
    useEffect(() => {
        const sync = () => setOnline(navigator.onLine);
        sync();
        window.addEventListener("online", sync);
        window.addEventListener("offline", sync);
        return () => { window.removeEventListener("online", sync); window.removeEventListener("offline", sync); };
    }, []);
    return online;
}

export function DownloadsView() {
    const t = useTranslations("mx.offline");
    const { server, clients, profile } = useMmo();
    const serverId = server?.deviceId ?? null;
    const profileId = clients?.profiles.profileId ?? null;
    const scope = serverId && profileId ? scopeOf(serverId, profileId) : null;
    const { items, error, manager, reload } = useOfflineList(scope);
    const online = useOnline();
    const profileName = profile?.name ?? profileId ?? "";

    // Live server credentials for queued downloads + the scope the static offline shell should show.
    useEffect(() => {
        if (!manager || !clients || !serverId || !scope) return;
        manager.setCreds(serverId, { token: clients.cfg.token, userId: clients.cfg.userId });
        manager.rememberScope(scope);
        void manager.ensureShell();
    }, [manager, clients, serverId, scope]);

    if (!manager) {
        return (
            <section aria-labelledby="od-title">
                <Header />
                <EmptyState icon={<AlertCircle aria-hidden />} tone="warning" title={t("page.unsupported")} />
            </section>
        );
    }

    return (
        <section aria-labelledby="od-title">
            <Header>
                {items && items.length > 0 ? <DeleteAll items={items} manager={manager} scope={scope} profile={profileName} /> : null}
            </Header>
            <p className="-mt-2 mb-4 text-sm text-muted-foreground">{t("page.subtitle", { profile: profileName })}</p>
            {!online ? (
                <p role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                    <WifiOff aria-hidden className="size-4" />{t("page.offlineBanner")}
                </p>
            ) : null}
            <StorageMeter manager={manager} items={items} />
            {error ? (
                <ErrorState title={t("page.error")} onRetry={reload} />
            ) : items === null ? (
                <div aria-busy className="grid gap-3">
                    <span className="sr-only">{t("page.loading")}</span>
                    {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
                </div>
            ) : items.length === 0 ? (
                <EmptyState
                    icon={<Download aria-hidden />}
                    title={t("empty.title")}
                    description={t("empty.body")}
                    actions={<Button render={<Link href="/media" />}>{t("empty.cta")}</Button>}
                />
            ) : (
                <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,26rem),1fr))]" aria-label={t("page.count", { count: items.length })}>
                    {items.map((i) => <Row key={i.key} item={i} manager={manager} />)}
                </ul>
            )}
        </section>
    );
}

function Header({ children }: { children?: React.ReactNode }) {
    const t = useTranslations("mx.offline.page");
    return (
        <div className="mx-page-head">
            <h1 id="od-title" className="mx-page-title">{t("title")}</h1>
            {children}
        </div>
    );
}

function StorageMeter({ manager, items }: { manager: OfflineManager; items: OfflineItem[] | null }) {
    const t = useTranslations("mx.offline.storage");
    const locale = useLocale();
    const [est, setEst] = useState<{ usage: number | null; quota: number | null } | null>(null);
    const [persisted, setPersisted] = useState<boolean | null>(null);
    const used = useMemo(() => sum((items ?? []).map((i) => (i.status === "done" ? i.size ?? 0 : i.bytes))), [items]);
    const doneCount = items?.filter((i) => i.status === "done").length ?? 0;

    useEffect(() => {
        let alive = true;
        void manager.estimate().then((e) => { if (alive) setEst(e); });
        void navigator.storage?.persisted?.().then((p) => { if (alive) setPersisted(p); }).catch(() => undefined);
        return () => { alive = false; };
    }, [manager, doneCount]);

    const free = est?.quota ? Math.max(0, est.quota - (est.usage ?? 0)) : null;
    const total = free !== null ? used + free : null;
    return (
        <div className="surface mb-6 grid gap-2 rounded-xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 font-medium"><HardDrive aria-hidden className="size-4" />{t("label")}</span>
                <span className="text-muted-foreground tabular-nums">
                    {t("used", { used: formatBytes(used, locale) })}
                    {" · "}
                    {free !== null ? t("available", { free: formatBytes(free, locale) }) : t("unknown")}
                </span>
            </div>
            <Progress value={total ? Math.min(100, (used / total) * 100) : 0} aria-label={t("label")} aria-valuetext={t("used", { used: formatBytes(used, locale) })} />
            {persisted !== null ? <p className="text-xs text-muted-foreground">{persisted ? t("persisted") : t("notPersisted")}</p> : null}
        </div>
    );
}

function Row({ item, manager }: { item: OfflineItem; manager: OfflineManager }) {
    const t = useTranslations("mx.offline");
    const locale = useLocale();
    const pct = percent(item.bytes, item.size);
    const title = item.title;
    const sizeLine = item.size
        ? item.status === "done" ? formatBytes(item.size, locale) : t("item.size", { done: formatBytes(item.bytes, locale), total: formatBytes(item.size, locale) })
        : item.bytes > 0 ? formatBytes(item.bytes, locale) : null;
    const statusText = item.status === "downloading"
        ? pct !== null ? t("status.downloading", { percent: pct }) : t("status.downloadingUnknown", { bytes: formatBytes(item.bytes, locale) })
        : t(`status.${item.status}`);
    const errorText = item.status === "error" && item.error
        ? t(`errors.${item.error.code}`, { status: item.error.status ?? "", free: formatBytes(item.error.free ?? 0, locale) })
        : null;
    const busy = item.status === "downloading" || item.status === "queued";

    return (
        <li className="surface flex gap-3 rounded-xl p-3" data-status={item.status}>
            <div className={item.kind === "track" ? "size-20 shrink-0" : "h-24 w-16 shrink-0"}>
                {item.hasPoster ? (
                    // eslint-disable-next-line @next/next/no-img-element -- served by the SW from Cache Storage, not optimisable
                    <img src={posterUrl(item.key)} alt="" className="size-full rounded-lg bg-muted object-cover" loading="lazy" />
                ) : (
                    <div aria-hidden className="size-full rounded-lg bg-muted" />
                )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="min-w-0">
                    <p className="truncate font-semibold">{title}</p>
                    <p className="truncate text-sm text-muted-foreground">
                        {[t(`item.kind.${item.kind}`), item.subtitle, sizeLine].filter(Boolean).join(" · ")}
                    </p>
                </div>
                {item.status !== "done" ? (
                    <div className="grid gap-1">
                        <Progress
                            value={pct ?? 0}
                            indeterminate={item.status === "downloading" && pct === null}
                            aria-label={t("item.progressLabel", { title })}
                            indicatorClassName={item.status === "error" ? "bg-destructive" : undefined}
                        />
                        <p className={item.status === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground tabular-nums"}>
                            {errorText ?? statusText}
                        </p>
                    </div>
                ) : null}
                <div className="mt-auto flex flex-wrap gap-2">
                    {item.status === "done" ? (
                        <Button size="sm" render={<Link href={`/media/downloads/play/${encodeURIComponent(item.key)}`} />} aria-label={t("item.playNamed", { title })}>
                            <Play aria-hidden className="size-4" />{t("item.play")}
                        </Button>
                    ) : busy ? (
                        <Button size="sm" variant="outline" onClick={() => void manager.pause(item.key)} aria-label={t("item.pauseNamed", { title })}>
                            <Pause aria-hidden className="size-4" />{t("item.pause")}
                        </Button>
                    ) : item.status === "paused" ? (
                        <Button size="sm" variant="outline" onClick={() => void manager.resume(item.key)} aria-label={t("item.resumeNamed", { title })}>
                            <Play aria-hidden className="size-4" />{t("item.resume")}
                        </Button>
                    ) : (
                        <Button size="sm" variant="outline" onClick={() => void manager.resume(item.key)} aria-label={t("item.retryNamed", { title })}>
                            <RotateCcw aria-hidden className="size-4" />{t("item.retry")}
                        </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => void manager.remove(item.key)} aria-label={t("item.deleteNamed", { title })}>
                        <Trash2 aria-hidden className="size-4" />{t("item.delete")}
                    </Button>
                </div>
            </div>
        </li>
    );
}

function DeleteAll({ items, manager, scope, profile }: { items: OfflineItem[]; manager: OfflineManager; scope: string | null; profile: string }) {
    const t = useTranslations("mx.offline");
    const locale = useLocale();
    const size = sum(items.map((i) => (i.status === "done" ? i.size ?? 0 : i.bytes)));
    return (
        <AlertDialog>
            <AlertDialogTrigger render={<Button variant="outline" />}>
                <Trash2 aria-hidden className="size-4" />{t("page.deleteAll")}
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
                <AlertDialogHeader>
                    <AlertDialogTitle>{t("confirm.title")}</AlertDialogTitle>
                    <AlertDialogDescription>
                        {t("confirm.body", { count: items.length, size: formatBytes(size, locale), profile })}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>{t("confirm.cancel")}</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => { if (scope) void manager.removeAll(scope); }}>
                        {t("confirm.confirm")}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
