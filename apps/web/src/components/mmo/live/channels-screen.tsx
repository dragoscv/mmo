"use client";

/**
 * `/media/live` (WP16-41) — channel list: group chips (+ Favourites), favourites-first toggle, search; each row
 * shows logo, number, name and now/next with progress. On wide screens a muted hls.js preview of the
 * focused/hovered channel sits beside the list (debounced 450 ms, one <video>). Enter/click opens the player.
 * Keyboard: ↑/↓ move between rows, Enter plays, F toggles favourite, `/` focuses the search.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { Heart, Play, Radio, Search, Settings2, Star } from "lucide-react";
import { toast } from "sonner";
import { Button, EmptyState, ErrorState, Input, Skeleton, Switch } from "@mmo/ui";
import type { LiveTvChannel, LiveTvNowNext, LiveTvSource } from "@/lib/mmo/media-types";
import { useMmo } from "../mmo-provider";
import { ChannelLogo, LiveDot, LiveHeader, Progress, errorText, useLiveFormat, useNow, useNowNext } from "./common";
import { FAV_GROUP, filterChannels, progressOf } from "./live-logic";
import { attachStream, type StreamHandle } from "./stream";

const FAV_FIRST_KEY = "mixai:live:favFirst";
const ZAP_GROUP_KEY = "mixai:live:zapGroup";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; channels: LiveTvChannel[]; sources: LiveTvSource[]; groups: { name: string; count: number }[] };

export function ChannelsScreen() {
    const t = useTranslations("mx.live.channels");
    const tc = useTranslations("mx.live.common");
    const { clients } = useMmo();
    const livetv = clients?.livetv ?? null;
    const router = useRouter();
    const fmt = useLiveFormat();
    const now = useNow(30_000);
    const [load, setLoad] = useState<Load>({ state: "loading" });
    const [query, setQuery] = useState("");
    const [group, setGroup] = useState("");
    // Read once on the client; the toolbar only renders after the client-side load, so SSR never sees it.
    const [favFirst, setFavFirst] = useState(() => {
        try { return typeof window === "undefined" || localStorage.getItem(FAV_FIRST_KEY) !== "0"; } catch { return true; }
    });
    const [focusId, setFocusId] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const searchRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLUListElement>(null);

    useEffect(() => {
        if (!livetv) return;
        let alive = true;
        void Promise.all([livetv.channels(), livetv.sources(), livetv.groups()])
            .then(([channels, sources, groups]) => { if (alive) setLoad({ state: "ok", channels, sources, groups }); })
            .catch((e: unknown) => { if (alive) setLoad({ state: "error", message: errorText(e) }); });
        return () => { alive = false; };
    }, [livetv, reloadKey]);

    const all = useMemo(() => (load.state === "ok" ? load.channels : []), [load]);
    const visible = useMemo(() => filterChannels(all, { query, group, favouritesFirst: favFirst }), [all, query, group, favFirst]);
    const nn = useNowNext(livetv, useMemo(() => visible.slice(0, 400).map((c) => c.id), [visible]));
    const focused = visible.find((c) => c.id === focusId) ?? visible[0] ?? null;
    const hasFav = all.some((c) => c.favourite);

    const play = useCallback((ch: LiveTvChannel) => {
        try { sessionStorage.setItem(ZAP_GROUP_KEY, group === FAV_GROUP ? "" : group); } catch { /* ignore */ }
        router.push(`/media/live/play/${encodeURIComponent(ch.id)}`);
    }, [group, router]);

    const toggleFav = useCallback(async (ch: LiveTvChannel) => {
        if (!livetv || load.state !== "ok") return;
        const fav = !ch.favourite;
        setLoad({ ...load, channels: load.channels.map((c) => (c.id === ch.id ? { ...c, favourite: fav } : c)) });
        try {
            await livetv.setFavourite(ch.id, fav);
            toast.success(fav ? t("favAdded", { name: ch.name }) : t("favRemoved", { name: ch.name }));
        } catch (e) {
            setLoad((cur) => (cur.state === "ok" ? { ...cur, channels: cur.channels.map((c) => (c.id === ch.id ? { ...c, favourite: !fav } : c)) } : cur));
            toast.error(t("favFailed", { msg: errorText(e) }));
        }
    }, [livetv, load, t]);

    const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
        const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-lv-row]") ?? []);
        const i = rows.indexOf(document.activeElement as HTMLElement);
        if (i < 0) return;
        let n = -1;
        if (e.key === "ArrowDown") n = Math.min(rows.length - 1, i + 1);
        else if (e.key === "ArrowUp") n = Math.max(0, i - 1);
        else if (e.key === "Home") n = 0;
        else if (e.key === "End") n = rows.length - 1;
        else if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey) {
            const ch = visible[i];
            if (ch) { e.preventDefault(); void toggleFav(ch); }
            return;
        }
        if (n >= 0) { e.preventDefault(); rows[n]?.focus(); rows[n]?.scrollIntoView({ block: "nearest" }); }
    };

    if (!livetv) return null;
    const header = <LiveHeader title={t("title")} />;

    if (load.state === "loading") {
        return (
            <div className="lv-page">
                {header}
                <div className="lv-split" aria-busy="true" aria-label={tc("loading")}>
                    <ul className="lv-list">{Array.from({ length: 8 }, (_, i) => <li key={i}><Skeleton className="lv-row-skel" /></li>)}</ul>
                </div>
            </div>
        );
    }
    if (load.state === "error") {
        return (
            <div className="lv-page">
                {header}
                <ErrorState detail={load.message} onRetry={() => { setLoad({ state: "loading" }); setReloadKey((k) => k + 1); }} />
            </div>
        );
    }
    if (!load.sources.length) {
        return (
            <div className="lv-page">
                {header}
                <EmptyState
                    icon={<Radio aria-hidden />}
                    title={t("noSources.title")}
                    description={t("noSources.body")}
                    actions={<Button render={<Link href="/media/live/sources?add=1" />}><Settings2 aria-hidden />{t("noSources.cta")}</Button>}
                />
            </div>
        );
    }
    if (!all.length) {
        return (
            <div className="lv-page">
                {header}
                <EmptyState icon={<Radio aria-hidden />} title={t("noChannels.title")} description={t("noChannels.body")}
                    actions={<Button variant="outline" render={<Link href="/media/live/sources" />}>{t("noChannels.cta")}</Button>} />
            </div>
        );
    }

    return (
        <div className="lv-page">
            {header}
            <div className="lv-toolbar">
                <label className="lv-search">
                    <Search aria-hidden className="size-4" />
                    <span className="sr-only">{t("search")}</span>
                    <Input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} />
                </label>
                <label className="lv-switch">
                    <Switch checked={favFirst} onCheckedChange={(v) => {
                        setFavFirst(v);
                        try { localStorage.setItem(FAV_FIRST_KEY, v ? "1" : "0"); } catch { /* ignore */ }
                    }} />
                    <span>{t("favFirst")}</span>
                </label>
                <span className="lv-count" aria-live="polite">{t("count", { count: visible.length })}</span>
            </div>
            <div className="lv-chips" role="toolbar" aria-label={t("groups")}>
                <button type="button" className="lv-chip" aria-pressed={group === ""} onClick={() => setGroup("")}>{t("allGroups")}</button>
                {hasFav ? (
                    <button type="button" className="lv-chip" aria-pressed={group === FAV_GROUP} onClick={() => setGroup(FAV_GROUP)}>
                        <Star aria-hidden className="size-3.5" />{t("favourites")}
                    </button>
                ) : null}
                {load.groups.map((g) => (
                    <button key={g.name} type="button" className="lv-chip" aria-pressed={group === g.name} onClick={() => setGroup(g.name)}>
                        {g.name || t("ungrouped")}<span className="lv-chip-n">{g.count}</span>
                    </button>
                ))}
            </div>

            <div className="lv-split">
                {visible.length === 0 ? (
                    <EmptyState variant="inline" icon={<Search aria-hidden />} title={t("noMatch.title")} description={t("noMatch.body")}
                        actions={<Button variant="outline" onClick={() => { setQuery(""); setGroup(""); }}>{t("noMatch.reset")}</Button>} />
                ) : (
                    <ul ref={listRef} className="lv-list" aria-label={t("listLabel")} onKeyDown={onListKey}>
                        {visible.map((ch) => {
                            const n = nn.get(ch.id);
                            const cur = n?.now ?? null;
                            const next = n?.next ?? null;
                            return (
                                <li key={ch.id} className="lv-row" data-focused={focused?.id === ch.id ? "" : undefined}
                                    onMouseEnter={() => setFocusId(ch.id)}>
                                    <button type="button" data-lv-row className="lv-row-main" onClick={() => play(ch)} onFocus={() => setFocusId(ch.id)}
                                        aria-label={t("playChannel", { name: ch.name, now: cur?.title ?? t("noInfo") })}>
                                        <span className="lv-num">{ch.number ?? ""}</span>
                                        <ChannelLogo channel={ch} livetv={livetv} />
                                        <span className="lv-row-text">
                                            <span className="lv-row-name">{ch.name}</span>
                                            {cur ? (
                                                <span className="lv-row-now">
                                                    <span className="lv-row-title">{cur.title}</span>
                                                    <span className="lv-row-time">{fmt.range(cur.start, cur.stop)}</span>
                                                </span>
                                            ) : <span className="lv-row-now lv-dim">{t("noInfo")}</span>}
                                            {cur ? <Progress value={progressOf(cur, now)} /> : null}
                                            {next ? <span className="lv-row-next">{t("next", { time: fmt.time(next.start), title: next.title })}</span> : null}
                                        </span>
                                    </button>
                                    <button type="button" className="lv-fav" aria-pressed={ch.favourite}
                                        aria-label={ch.favourite ? t("unfavourite", { name: ch.name }) : t("favourite", { name: ch.name })}
                                        onClick={() => void toggleFav(ch)}>
                                        <Heart aria-hidden className="size-4" data-on={ch.favourite ? "" : undefined} />
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
                {focused ? <Preview channel={focused} onPlay={() => play(focused)} nowNext={nn.get(focused.id) ?? null} now={now} /> : null}
            </div>
        </div>
    );
}

function Preview({ channel, onPlay, nowNext, now }: {
    channel: LiveTvChannel; onPlay: () => void; nowNext: LiveTvNowNext | null; now: number;
}) {
    const t = useTranslations("mx.live.channels");
    const { clients } = useMmo();
    const livetv = clients?.livetv ?? null;
    const fmt = useLiveFormat();
    const videoRef = useRef<HTMLVideoElement>(null);
    const [wide, setWide] = useState(false);
    const [state, setState] = useState<"idle" | "loading" | "playing" | "error">("idle");

    useEffect(() => {
        const mq = window.matchMedia("(min-width: 1100px)");
        const on = () => setWide(mq.matches);
        on();
        mq.addEventListener("change", on);
        return () => mq.removeEventListener("change", on);
    }, []);

    useEffect(() => {
        const v = videoRef.current;
        if (!wide || !v || !livetv) return;
        let handle: StreamHandle | null = null;
        let cancelled = false;
        setState("loading");
        const timer = setTimeout(() => {
            v.muted = true;
            void attachStream(v, livetv.streamUrl(channel.id), { preload: false, onFatal: () => { if (!cancelled) setState("error"); } })
                .then((h) => {
                    if (cancelled) { h.destroy(); return; }
                    handle = h;
                    v.play().catch(() => undefined);
                });
        }, 450);
        const onPlaying = () => setState("playing");
        v.addEventListener("playing", onPlaying);
        return () => {
            cancelled = true;
            clearTimeout(timer);
            v.removeEventListener("playing", onPlaying);
            handle?.destroy();
        };
    }, [channel.id, livetv, wide]);

    if (!wide || !livetv) return null;
    const cur = nowNext?.now ?? null;
    const next = nowNext?.next ?? null;
    return (
        <aside className="lv-preview" aria-label={t("preview", { name: channel.name })}>
            <div className="lv-preview-video dark">
                <video ref={videoRef} muted playsInline aria-hidden tabIndex={-1} />
                {state !== "playing" ? (
                    <div className="lv-preview-overlay">
                        <ChannelLogo channel={channel} livetv={livetv} size="lg" />
                        <span>{state === "error" ? t("previewError") : t("previewLoading")}</span>
                    </div>
                ) : null}
                <LiveDot label={t("live")} />
            </div>
            <div className="lv-preview-body">
                <p className="lv-preview-ch">{channel.number ? `${channel.number} · ` : ""}{channel.name}</p>
                {cur ? (
                    <>
                        <h2 className="lv-preview-title">{cur.title}</h2>
                        <p className="lv-dim">{fmt.range(cur.start, cur.stop)}{cur.category ? ` · ${cur.category}` : ""}</p>
                        <Progress value={progressOf(cur, now)} label={t("progress")} />
                        {cur.description ? <p className="lv-preview-desc">{cur.description}</p> : null}
                    </>
                ) : <p className="lv-dim">{t("noInfo")}</p>}
                {next ? <p className="lv-row-next">{t("next", { time: fmt.time(next.start), title: next.title })}</p> : null}
                <Button onClick={onPlay}><Play aria-hidden />{t("watch")}</Button>
            </div>
        </aside>
    );
}
