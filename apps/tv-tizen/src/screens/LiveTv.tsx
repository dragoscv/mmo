/**
 * Live TV (WP16-34): group chips with counts, virtualised channel list (number, logo, name, now + progress,
 * next), focused channel for 600 ms → small muted preview (ONE shared <video> + hls.js), OK → full-screen
 * LivePlay, long-press OK / red → options (favourite, hide), green → favourite. Buttons Guide / Recordings /
 * Sources; Sources is an in-screen sub-view (Back closes). Empty: "MixAI ships no channels — add your own".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n/messages";
import type { LiveTvChannel, LiveTvNowNext, LiveTvSource } from "../lib/media-types";
import { keyFromEvent } from "../lib/tv-keys";
import { useScreenActive } from "../nav/Nav";
import type { ScreenProps } from "../nav/ctx";
import { Chips, Empty, ErrorState, GhostButton, Icon, LoadingBlock, ScreenHeader, SecondaryButton, SidePanel, useBackdrop } from "../ui";
import { ChannelLogo, LiveDot, Progress, VList, cachedNowNext, fetchNowNext, hhmm, progressOf, setZapGroup } from "./livetv/common";
import { Sources } from "./livetv/Sources";
import { attachLive, type LiveHandle } from "./livetv/stream";

const ROW_REM = 4;
const PREVIEW_DELAY = 600;
const LONG_PRESS = 600;
const ALL = "__all";
const FAV = "__fav";

export function LiveTv({ ctx }: ScreenProps<"livetv">) {
    const { livetv, nav, lang } = ctx;
    const active = useScreenActive();
    const backdrop = useBackdrop();
    const [sources, setSources] = useState<LiveTvSource[] | null>(null);
    const [channels, setChannels] = useState<LiveTvChannel[] | null>(null);
    const [groups, setGroups] = useState<{ name: string; count: number }[]>([]);
    const [group, setGroup] = useState<string>(ALL);
    const [showHidden, setShowHidden] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [focusIdx, setFocusIdx] = useState(-1);
    const [nn, setNn] = useState<Map<string, LiveTvNowNext>>(new Map());
    const [tick, setTick] = useState(0);
    const [view, setView] = useState<"list" | "sources">("list");
    const [options, setOptions] = useState<LiveTvChannel | null>(null);
    const [previewOn, setPreviewOn] = useState(false);
    const videoRef = useRef<HTMLVideoElement>(null);
    const handle = useRef<LiveHandle | null>(null);
    const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => { if (active) backdrop.show(null); }, [active, backdrop]);

    const load = useCallback(async () => {
        setError(null);
        try {
            const [src, gr] = await Promise.all([livetv.sources(), livetv.groups()]);
            setSources(src);
            setGroups(gr);
            const chs = src.length === 0 ? [] : await livetv.channels({
                group: group !== ALL && group !== FAV ? group : undefined, favourites: group === FAV, hidden: showHidden,
            });
            setChannels(chs);
        } catch (e) {
            setError((e as Error).message);
        }
    }, [livetv, group, showHidden]);
    useEffect(() => { void load(); }, [load]);
    useEffect(() => { setZapGroup(group !== ALL && group !== FAV ? group : null); }, [group]);

    // Progress bars move every 30 s; now/next refetched by the cache TTL.
    useEffect(() => {
        if (!active) return;
        const h = setInterval(() => setTick((x) => x + 1), 30_000);
        return () => clearInterval(h);
    }, [active]);

    const list = channels ?? [];
    const onRange = useCallback((from: number, to: number) => {
        const ids = list.slice(from, to).map((c) => c.id);
        if (ids.length === 0) return;
        void fetchNowNext(livetv, ids).then((m) => setNn((cur) => {
            const out = new Map(cur);
            m.forEach((v, k) => out.set(k, v));
            return out;
        }));
    }, [list, livetv]);
    useEffect(() => { if (tick > 0 && list.length) onRange(Math.max(0, focusIdx - 10), focusIdx + 20); }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── preview (one shared <video>) ────────────────────────────────────
    const stopPreview = useCallback(() => {
        if (previewTimer.current) { clearTimeout(previewTimer.current); previewTimer.current = null; }
        handle.current?.destroy();
        handle.current = null;
        setPreviewOn(false);
    }, []);
    useEffect(() => {
        stopPreview();
        const ch = list[focusIdx];
        if (!active || view !== "list" || !ch) return;
        previewTimer.current = setTimeout(() => {
            const v = videoRef.current;
            if (!v) return;
            v.muted = true;
            const url = livetv.streamUrl(ch.id);
            void attachLive(v, url, { onFatal: () => setPreviewOn(false) }).then((h) => {
                if (list[focusIdx]?.id !== ch.id || !active) { h.destroy(); return; }
                handle.current = h;
                v.play().catch(() => undefined);
            });
        }, PREVIEW_DELAY);
        return stopPreview;
    }, [focusIdx, active, view, list, livetv, stopPreview]);

    // ─── favourites / hide ───────────────────────────────────────────────
    const toggleFav = useCallback(async (ch: LiveTvChannel) => {
        const fav = !ch.favourite;
        setChannels((cur) => cur?.map((c) => (c.id === ch.id ? { ...c, favourite: fav } : c)) ?? cur);
        try { await livetv.setFavourite(ch.id, fav); } catch { void load(); }
    }, [livetv, load]);
    const toggleHidden = useCallback(async (ch: LiveTvChannel) => {
        const hidden = !ch.hidden;
        setChannels((cur) => (showHidden ? cur?.map((c) => (c.id === ch.id ? { ...c, hidden } : c)) : cur?.filter((c) => c.id !== ch.id)) ?? cur);
        try { await livetv.updateChannel(ch.id, { hidden }); } catch { void load(); }
    }, [livetv, load, showHidden]);

    // ─── keys on channel rows: long-press OK → options, green → favourite, red → options ──
    const press = useRef<{ id: string; at: number; long: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
    useEffect(() => {
        if (!active || view !== "list") return;
        const chOf = (el: Element | null) => {
            const id = (el as HTMLElement | null)?.closest<HTMLElement>("[data-channel-id]")?.getAttribute("data-channel-id");
            return id ? list.find((c) => c.id === id) ?? null : null;
        };
        const down = (e: KeyboardEvent) => {
            if (options) return;
            const ch = chOf(document.activeElement);
            if (!ch) return;
            const k = keyFromEvent(e);
            if (k === "green") { void toggleFav(ch); e.preventDefault(); e.stopImmediatePropagation(); return; }
            if (k === "red") { setOptions(ch); e.preventDefault(); e.stopImmediatePropagation(); return; }
            if (k !== "enter") return;
            e.preventDefault();
            e.stopImmediatePropagation();
            // Synthetic keys (e2e driver, hub) never send keyup → short press now.
            if (!e.isTrusted) { nav.push({ name: "livePlay", channelId: ch.id }); return; }
            if (press.current) return; // auto-repeat while held
            const timer = setTimeout(() => { if (press.current) { press.current.long = true; setOptions(ch); } }, LONG_PRESS);
            press.current = { id: ch.id, at: Date.now(), long: false, timer };
        };
        const up = (e: KeyboardEvent) => {
            const p = press.current;
            if (!p || keyFromEvent(e) !== "enter") return;
            clearTimeout(p.timer);
            press.current = null;
            e.preventDefault();
            if (!p.long) nav.push({ name: "livePlay", channelId: p.id });
        };
        window.addEventListener("keydown", down, true);
        window.addEventListener("keyup", up, true);
        return () => {
            window.removeEventListener("keydown", down, true);
            window.removeEventListener("keyup", up, true);
            if (press.current) { clearTimeout(press.current.timer); press.current = null; }
        };
    }, [active, view, list, options, toggleFav, nav]);

    const chipItems = useMemo(() => {
        const total = groups.reduce((s, g) => s + g.count, 0);
        return [
            { id: ALL, label: t("lt.all", { n: total }) },
            { id: FAV, label: t("lt.favourites"), icon: "star" as const },
            ...groups.map((g) => ({ id: g.name, label: `${g.name} · ${g.count}` })),
        ];
    }, [groups]);

    if (view === "sources") {
        return <Sources ctx={ctx} onClose={() => { setView("list"); void load(); }} />;
    }

    const now = Date.now();
    const focused = list[focusIdx] ?? null;
    const fnn = focused ? nn.get(focused.id) ?? cachedNowNext(focused.id) : null;

    const header = (
        <div className="lt-top">
            <ScreenHeader title={t("screen.livetv")}
                sub={sources && sources.length > 0 ? t("lt.summary", { channels: list.length, sources: sources.length }) : undefined}
                right={
                    <div className="mu-hero-actions" data-focus-row="lt-actions" style={{ marginTop: 0 }}>
                        <SecondaryButton icon="guide" label={t("screen.guide")} onClick={() => nav.push({ name: "guide" })} focusKey="lt:guide" testId="lt-guide" disabled={!sources?.length} />
                        <SecondaryButton icon="record" label={t("screen.recordings")} onClick={() => nav.push({ name: "recordings" })} focusKey="lt:recordings" />
                        <SecondaryButton icon="server" label={t("lt.sources")} onClick={() => setView("sources")} focusKey="lt:sources" testId="lt-sources" />
                    </div>
                } />
            {sources && sources.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                    <Chips rowId="lt-groups" value={group} items={chipItems} onChange={(id) => { setFocusIdx(-1); setGroup(id); }} />
                    <GhostButton icon={showHidden ? "check" : "close"} label={showHidden ? t("lt.hideHidden") : t("lt.showHidden")} focusKey="lt:hidden" onClick={() => setShowHidden((v) => !v)} />
                </div>
            )}
        </div>
    );

    let body: ReactNode;
    if (error) body = <ErrorState message={error} onRetry={() => { void load(); }} />;
    else if (sources === null || channels === null) body = <LoadingBlock lines={6} />;
    else if (sources.length === 0) {
        body = <Empty icon="livetv" title={t("lt.emptyTitle")} message={t("lt.emptyMsg")} action={{ label: t("lt.addSource"), icon: "plus", onClick: () => setView("sources") }} />;
    } else if (list.length === 0) {
        const refreshing = sources.some((s) => !s.lastRefresh && !s.lastError);
        body = <Empty icon="livetv" title={refreshing ? t("lt.refreshing") : t("lt.noChannels")} message={refreshing ? undefined : t("lt.noChannelsMsg")}
            action={{ label: t("common.retry"), icon: "refresh", onClick: () => { void load(); } }} />;
    } else {
        body = (
            <div className="lt-body">
                <VList listId="lt-channels" className="lt-list" items={list} rowRem={ROW_REM} focusIndex={focusIdx} onRange={onRange}
                    itemKey={(c) => c.id}
                    renderItem={(c, i) => {
                        const x = nn.get(c.id) ?? cachedNowNext(c.id);
                        return (
                            <button type="button" className="lt-ch" data-focusable="" data-focus-key={`lt-ch:${c.id}`} data-channel-id={c.id}
                                onFocus={() => setFocusIdx(i)} onClick={() => nav.push({ name: "livePlay", channelId: c.id })}
                                aria-label={[c.number, c.name, x?.now?.title].filter(Boolean).join(", ")}>
                                <span className="lt-ch-num">{c.number ?? i + 1}</span>
                                <ChannelLogo client={livetv} channel={c} />
                                <span className="lt-ch-main">
                                    <span className="lt-ch-name">
                                        {c.name}
                                        {c.favourite && <span className="lt-fav"><Icon name="star" /></span>}
                                        {c.hidden && <span className="badge badge-neutral lt-hidden-tag">{t("lt.hiddenTag")}</span>}
                                        {c.catchup && <span className="badge badge-neutral lt-hidden-tag">{t("lt.catchupTag")}</span>}
                                    </span>
                                    <span className="lt-ch-now">{x?.now?.title ?? t("lt.noGuide")}</span>
                                    {x?.now && (
                                        <span className="lt-ch-meta">
                                            <Progress value={progressOf(x.now, now)} />
                                            {hhmm(x.now.start, lang)}–{hhmm(x.now.stop, lang)}
                                        </span>
                                    )}
                                </span>
                                <span className="lt-ch-next">{x?.next ? `${hhmm(x.next.start, lang)} ${x.next.title}` : ""}</span>
                            </button>
                        );
                    }} />
                <aside className="lt-side" aria-live="polite">
                    <div className="lt-preview">
                        <span className="lt-preview-ph"><Icon name="livetv" /></span>
                        <video ref={videoRef} muted playsInline className={previewOn ? "is-on" : undefined} data-testid="lt-preview"
                            onPlaying={() => { if (handle.current) setPreviewOn(true); }} onTimeUpdate={() => { if (handle.current && !previewOn) setPreviewOn(true); }} />
                    </div>
                    {focused && (
                        <>
                            <div className="lt-side-title"><LiveDot /> {focused.name}</div>
                            {fnn?.now ? (
                                <>
                                    <div className="lt-side-prog">{fnn.now.title}</div>
                                    <Progress value={progressOf(fnn.now, now)} />
                                    <div className="lt-side-next">{hhmm(fnn.now.start, lang)}–{hhmm(fnn.now.stop, lang)}{fnn.now.category ? ` · ${fnn.now.category}` : ""}</div>
                                    {fnn.now.description && <div className="lt-side-desc">{fnn.now.description}</div>}
                                    {fnn.next && <div className="lt-side-next">{t("lt.next")}: {hhmm(fnn.next.start, lang)} {fnn.next.title}</div>}
                                </>
                            ) : <div className="lt-side-next">{t("lt.noGuide")}</div>}
                            <div className="lt-note">{t("lt.listHint")}</div>
                        </>
                    )}
                </aside>
            </div>
        );
    }

    return (
        <div className="lt-screen" data-testid="screen-livetv">
            {header}
            {body}
            <SidePanel open={!!options} title={options?.name ?? ""} onClose={() => setOptions(null)} testId="lt-options"
                items={options ? [
                    { id: "watch", label: t("lt.watch"), icon: "play" },
                    { id: "fav", label: options.favourite ? t("lt.unfavourite") : t("lt.favourite"), icon: "star" },
                    { id: "hide", label: options.hidden ? t("lt.unhide") : t("lt.hide"), icon: "close" },
                ] : []}
                onSelect={(id) => {
                    const ch = options;
                    setOptions(null);
                    if (!ch) return;
                    if (id === "watch") nav.push({ name: "livePlay", channelId: ch.id });
                    if (id === "fav") void toggleFav(ch);
                    if (id === "hide") void toggleHidden(ch);
                }} />
        </div>
    );
}
