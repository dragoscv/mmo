/**
 * Decks Marketplace: catalogue from mixai.ro, filter chips + search, try for
 * 30 s or install. Every download is sha256-checked in TS and fully verified
 * again in Rust (packs.inspect / install) before it touches the UI.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Download, Play, RefreshCw, Search, Store, WifiOff } from "lucide-react";
import { Button, EmptyState, Input, SkeletonGrid, ToggleGroup, ToggleGroupItem } from "@mmo/ui";
import { absoluteUrl, downloadPack, type MarketPack } from "@/bridge/marketplace";
import { packs } from "@/bridge/packs";
import { useT, type MessageKey, type Translate } from "@/i18n";
import { useMarketStore } from "@/packs/market-store";
import { PackCard } from "@/packs/PackCard";
import { usePackStore } from "@/packs/pack-store";
import { useCompanionStore } from "@/state/companion-store";
import { PackError } from "./AppearanceExtras";

const FILTERS = ["all", "skin", "layout", "bundle", "free", "pro"] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_LABEL: Record<Filter, MessageKey> = {
    all: "pack.filterAll",
    skin: "pack.filterSkins",
    layout: "pack.filterLayouts",
    bundle: "pack.filterBundles",
    free: "pack.filterFree",
    pro: "pack.filterPro",
};

function matches(p: MarketPack, filter: Filter, q: string): boolean {
    if (filter === "free" && p.pro) return false;
    if (filter === "pro" && !p.pro) return false;
    if ((filter === "skin" || filter === "layout" || filter === "bundle") && p.kind !== filter) return false;
    if (!q) return true;
    const hay = [p.name, p.author, p.description, ...p.tags].join(" ").toLowerCase();
    return q
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((w) => hay.includes(w));
}

const strip = (s: string) => s.replace(/^Error:\s*/, "");

function downloadError(e: unknown, t: Translate): string {
    const m = e instanceof Error ? e.message : String(e);
    if (m === "pro_required") return "pro_required";
    if (m === "sha256_mismatch") return t("pack.errSha");
    if (m === "too_large") return t("pack.errTooLarge");
    return t("pack.errDownload", { detail: m });
}

/** Market errors are either "pro_required" or an already-translated sentence. */
function MarketError({ error }: { error: string | undefined }) {
    if (!error) return null;
    if (error === "pro_required") return <PackError error="pro" />;
    return (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
        </p>
    );
}

function MarketCard({ p }: { p: MarketPack }) {
    const t = useT();
    const installed = usePackStore((s) => s.installed.find((x) => x.manifest.id === p.id));
    const busy = useMarketStore((s) => s.busy[p.id]);
    const error = useMarketStore((s) => s.errors[p.id]);
    const market = useMarketStore.getState;

    const fetchBytes = async (): Promise<Uint8Array | null> => {
        market().setError(p.id, null);
        try {
            return await downloadPack(p, useCompanionStore.getState().deviceToken || null);
        } catch (e) {
            market().setError(p.id, downloadError(e, t));
            return null;
        }
    };

    const onTry = async () => {
        market().setBusy(p.id, "try");
        try {
            const bytes = await fetchBytes();
            if (!bytes) return;
            const info = await packs.inspect(bytes);
            if (!info) {
                market().setError(p.id, t("pack.notNative"));
                return;
            }
            usePackStore.getState().startTry(info, bytes, { fromMarket: true });
        } catch (e) {
            market().setError(p.id, t("pack.refused", { detail: strip(String(e)) }));
        } finally {
            market().setBusy(p.id, null);
        }
    };

    const onInstall = async () => {
        market().setBusy(p.id, "install");
        try {
            const bytes = await fetchBytes();
            if (!bytes) return;
            const done = await usePackStore.getState().install(bytes, { fromMarket: true });
            if (!done) {
                const err = usePackStore.getState().error;
                market().setError(p.id, err === "pro" ? "pro_required" : err ? t("pack.refused", { detail: strip(err) }) : t("pack.notNative"));
            }
        } finally {
            market().setBusy(p.id, null);
        }
    };

    const sameVersion = installed?.manifest.version === p.version;
    const canTry = p.kind === "skin" || p.kind === "bundle";

    return (
        <PackCard
            name={p.name}
            author={p.author}
            trust={p.trust}
            previewSrc={absoluteUrl(p.previewUrl)}
            pro={p.pro}
            size={p.size}
            description={p.description}
            actions={
                <>
                    {canTry ? (
                        <Button variant="outline" size="xs" loading={busy === "try"} disabled={!!busy} aria-label={t("pack.tryAria", { name: p.name })} onClick={() => void onTry()}>
                            <Play aria-hidden /> {t("pack.try")}
                        </Button>
                    ) : null}
                    {installed && sameVersion ? (
                        <Button variant="secondary" size="xs" disabled>
                            {t("pack.installed")}
                        </Button>
                    ) : (
                        <Button size="xs" loading={busy === "install"} disabled={!!busy} onClick={() => void onInstall()}>
                            {installed ? <RefreshCw aria-hidden /> : <Download aria-hidden />} {installed ? t("pack.update") : t("pack.install")}
                        </Button>
                    )}
                </>
            }
            footer={<MarketError error={error} />}
        />
    );
}

export function MarketplaceTab() {
    const t = useT();
    const catalog = useMarketStore((s) => s.catalog);
    const loading = useMarketStore((s) => s.loading);
    const loadError = useMarketStore((s) => s.loadError);
    const [filter, setFilter] = useState<Filter>("all");
    const [query, setQuery] = useState("");
    const [attempt, setAttempt] = useState(0);
    const searchId = useId();

    useEffect(() => {
        const ac = new AbortController();
        void useMarketStore.getState().load(ac.signal);
        return () => ac.abort();
    }, [attempt]);

    const list = useMemo(() => (catalog?.packs ?? []).filter((p) => matches(p, filter, query.trim())), [catalog, filter, query]);

    let body;
    if (loading && !catalog) {
        body = (
            <div className="grid gap-2">
                <p role="status" className="sr-only">
                    {t("pack.loading")}
                </p>
                <SkeletonGrid count={6} aspect="aspect-video" className="grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]" />
            </div>
        );
    } else if (loadError && !catalog) {
        body = (
            <div role="status">
                <EmptyState
                    variant="inline"
                    icon={<WifiOff aria-hidden />}
                    title={t("pack.offlineTitle")}
                    description={t("pack.offlineBody")}
                    actions={
                        <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                            <RefreshCw aria-hidden /> {t("pack.retry")}
                        </Button>
                    }
                />
            </div>
        );
    } else if (list.length === 0) {
        body = (
            <div role="status">
                <EmptyState variant="inline" icon={<Store aria-hidden />} title={t("pack.emptyTitle")} description={t("pack.emptyBody")} />
            </div>
        );
    } else {
        body = (
            <>
                <p role="status" className="text-xs text-muted-foreground">
                    {t("pack.count", { n: list.length })}
                </p>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
                    {list.map((p) => (
                        <MarketCard key={p.id} p={p} />
                    ))}
                </div>
            </>
        );
    }

    return (
        <div data-setting-id="marketplace.store" className="grid min-w-0 gap-4">
            <div className="grid gap-1">
                <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">{t("pack.marketTitle")}</h3>
                <p className="text-xs text-muted-foreground">{t("pack.marketHint")}</p>
            </div>

            <div className="flex min-w-0 flex-wrap items-center gap-3" data-setting-id="marketplace.filters">
                <ToggleGroup<Filter>
                    aria-label={t("pack.filterLabel")}
                    value={[filter]}
                    onValueChange={(v) => {
                        const next = v[0];
                        if (next) setFilter(next);
                    }}
                    variant="outline"
                    className="flex flex-wrap gap-1.5 shadow-none"
                >
                    {FILTERS.map((f) => (
                        <ToggleGroupItem key={f} value={f} size="sm" className="flex-none rounded-full border-l first:rounded-full last:rounded-full">
                            {t(FILTER_LABEL[f])}
                        </ToggleGroupItem>
                    ))}
                </ToggleGroup>
                <div className="relative min-w-40 flex-1">
                    <label htmlFor={searchId} className="sr-only">
                        {t("pack.search")}
                    </label>
                    <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input id={searchId} type="search" value={query} placeholder={t("pack.search")} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
                </div>
            </div>

            {body}
        </div>
    );
}
