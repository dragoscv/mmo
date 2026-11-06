"use client";

/**
 * `/media/live/play/[channelId]` (WP16-41) — full-screen live player, port of tv-tizen `LivePlay.tsx`.
 * TWO <video> slots: the front plays, the back holds the preloaded neighbour in the direction of the last
 * zap, so a zap is a swap (tens of ms) instead of a cold HLS start. ↑/PageUp = next channel, ↓/PageDown =
 * previous, digits = number entry (commits after 1.5 s or 4 digits, Enter commits now), Backspace/L = last
 * channel, Space/K = pause, M = mute, F = fullscreen, G = mini guide strip, R = record, Esc = back.
 * Zap time key → `playing` is pushed to `window.__mixaiZap` and logged as `[perf] zap`.
 * Catch-up: `?start=<ms>&dur=<min>` plays `catchupUrl` (no zapping preload while in catch-up).
 */
import { useHref, useRouter } from "@/components/host/host-context";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
    ArrowLeft, ChevronDown, ChevronUp, Disc3, History, ListVideo, Loader2, Maximize, Minimize, Pause, Play, Radio, Volume2, VolumeX,
} from "lucide-react";
import { toast } from "sonner";
import { Button, ErrorState } from "@mmo/ui";
import type { LiveTvChannel, LiveTvNowNext } from "@/lib/mmo/media-types";
import { playerBus } from "@/lib/mmo/player-bus";
import { useMmo } from "../mmo-provider";
import { ChannelLogo, LiveDot, Progress, errorText, fetchNowNext, useLiveFormat, useNow } from "./common";
import { DIGIT_COMMIT_MS, aroundIds, channelByNumber, neighbourIndex, progressOf, pushDigit } from "./live-logic";
import { attachStream, type StreamHandle } from "./stream";

declare global {
    interface Window { __mixaiZap?: number[]; __mixaiLiveOpen?: number }
}

const OSD_MS = 5000;
const PRELOAD_DELAY_MS = 800;
const ZAP_GROUP_KEY = "mixai:live:zapGroup";

interface Slot { channelId: string | null; handle: StreamHandle | null; ready: boolean }
interface Catchup { start: number; dur: number }

function pushZap(ms: number): void {
    const v = Math.round(ms);
    (window.__mixaiZap ??= []).push(v);
    console.info("[perf] zap", v);
}

export function LivePlayer({ channelId, catchup: initialCatchup }: { channelId: string; catchup: Catchup | null }) {
    const t = useTranslations("mx.live.player");
    const { clients } = useMmo();
    const livetv = clients?.livetv ?? null;
    const router = useRouter();
    const mapHref = useHref();
    const fmt = useLiveFormat();
    const now = useNow(15_000);
    const rootRef = useRef<HTMLDivElement>(null);
    const vidA = useRef<HTMLVideoElement>(null);
    const vidB = useRef<HTMLVideoElement>(null);
    const vid = (i: number): HTMLVideoElement | null => (i === 0 ? vidA : vidB).current;
    const slots = useRef<[Slot, Slot]>([{ channelId: null, handle: null, ready: false }, { channelId: null, handle: null, ready: false }]);
    const frontRef = useRef(0);
    const [shown, setShown] = useState(0);
    const [channels, setChannels] = useState<LiveTvChannel[] | null>(null);
    const [curId, setCurId] = useState(channelId);
    const curRef = useRef(channelId);
    const lastRef = useRef<string | null>(null);
    const dirRef = useRef<1 | -1>(1);
    const zapT0 = useRef<{ id: string; t0: number } | null>(null);
    const openT0 = useRef(0);
    const [osd, setOsd] = useState(true);
    const [strip, setStrip] = useState(false);
    const [digits, setDigits] = useState("");
    const digitsRef = useRef("");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [paused, setPaused] = useState(false);
    const [muted, setMuted] = useState(false);
    const mutedRef = useRef(false);
    useEffect(() => { mutedRef.current = muted; }, [muted]);
    const [fullscreen, setFullscreen] = useState(false);
    const [nn, setNn] = useState<Map<string, LiveTvNowNext>>(new Map());
    const [catchup, setCatchup] = useState<Catchup | null>(initialCatchup);
    const catchupRef = useRef(catchup);
    useEffect(() => { catchupRef.current = catchup; }, [catchup]);
    const osdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const digitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const preloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => { openT0.current = performance.now(); }, []);

    // ─── channel list (zap order = the group picked on the list, else all) ──
    useEffect(() => {
        if (!livetv) return;
        let alive = true;
        void (async () => {
            let g = "";
            try { g = sessionStorage.getItem(ZAP_GROUP_KEY) ?? ""; } catch { /* ignore */ }
            let list = await livetv.channels(g ? { group: g } : {}).catch(() => [] as LiveTvChannel[]);
            if (!list.some((c) => c.id === channelId)) list = await livetv.channels({ hidden: true }).catch(() => list);
            if (alive) setChannels(list);
        })();
        return () => { alive = false; };
    }, [livetv, channelId]);

    const idx = useMemo(() => channels?.findIndex((c) => c.id === curId) ?? -1, [channels, curId]);
    const cur = channels && idx >= 0 ? channels[idx]! : null;
    const neighbour = useCallback((id: string, d: 1 | -1): LiveTvChannel | null => {
        if (!channels) return null;
        const n = neighbourIndex(channels.length, channels.findIndex((c) => c.id === id), d);
        return n >= 0 ? channels[n]! : null;
    }, [channels]);
    const stripIds = useMemo(() => (channels ? aroundIds(channels, idx, 3) : []), [channels, idx]);

    useEffect(() => {
        if (!livetv || !stripIds.length) return;
        let alive = true;
        void fetchNowNext(livetv, stripIds).then((m) => {
            if (alive) setNn((c) => { const o = new Map(c); m.forEach((v, k) => o.set(k, v)); return o; });
        });
        return () => { alive = false; };
    }, [livetv, stripIds, Math.floor(now / 60_000)]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── OSD ─────────────────────────────────────────────────────────────
    const showOsd = useCallback((sticky = false) => {
        setOsd(true);
        if (osdTimer.current) clearTimeout(osdTimer.current);
        if (!sticky) osdTimer.current = setTimeout(() => setOsd(false), OSD_MS);
    }, []);
    // Initial OSD auto-hide (state already starts visible).
    useEffect(() => {
        osdTimer.current = setTimeout(() => setOsd(false), OSD_MS);
    }, []);

    // ─── slots ───────────────────────────────────────────────────────────
    const load = useCallback(async (slot: number, id: string, url: string, preload: boolean, vod = false) => {
        if (!livetv) return;
        const s = slots.current[slot]!;
        s.handle?.destroy();
        s.handle = null;
        s.channelId = id;
        s.ready = false;
        const v = vid(slot);
        if (!v) return;
        v.muted = preload || mutedRef.current;
        const h = await attachStream(v, url, {
            preload, vod,
            onFatal: (m) => {
                if (slots.current[slot]!.channelId !== id || frontRef.current !== slot) return;
                setLoading(false);
                setError(m === "unsupported" ? t("unsupported") : m);
            },
        });
        if (slots.current[slot]!.channelId !== id) { h.destroy(); return; }
        s.handle = h;
        if (!preload) v.play().catch(() => undefined);
    }, [livetv, t]);

    const schedulePreload = useCallback((fromId: string) => {
        if (!livetv) return;
        if (preloadTimer.current) clearTimeout(preloadTimer.current);
        preloadTimer.current = setTimeout(() => {
            const n = neighbour(fromId, dirRef.current);
            const back = 1 - frontRef.current;
            if (!n || n.id === fromId || slots.current[back]!.channelId === n.id) return;
            void load(back, n.id, livetv.streamUrl(n.id), true);
        }, PRELOAD_DELAY_MS);
    }, [neighbour, load, livetv]);

    // Initial start (live, or catch-up from the guide).
    const started = useRef(false);
    useEffect(() => {
        if (!livetv || started.current) return;
        started.current = true;
        const c = catchupRef.current;
        void load(0, channelId, c ? livetv.catchupUrl(channelId, c.start, c.dur) : livetv.streamUrl(channelId), false, !!c);
    }, [livetv, channelId, load]);

    // Media events on both elements.
    const scheduleRef = useRef(schedulePreload);
    useEffect(() => { scheduleRef.current = schedulePreload; }, [schedulePreload]);
    useEffect(() => {
        const offs: Array<() => void> = [];
        [0, 1].forEach((slot) => {
            const v = vid(slot);
            if (!v) return;
            const onPlaying = () => {
                const s = slots.current[slot]!;
                s.ready = true;
                if (frontRef.current !== slot) return;
                setShown(slot);
                const other = vid(1 - slot);
                if (other && !other.paused) other.pause();
                setLoading(false);
                setError(null);
                setPaused(false);
                const z = zapT0.current;
                if (z && z.id === s.channelId) { pushZap(performance.now() - z.t0); zapT0.current = null; }
                if (window.__mixaiLiveOpen === undefined) window.__mixaiLiveOpen = Math.round(performance.now() - openT0.current);
                if (s.channelId && !catchupRef.current) scheduleRef.current(s.channelId);
            };
            const onWaiting = () => { if (frontRef.current === slot) setLoading(true); };
            const onPause = () => { if (frontRef.current === slot) setPaused(true); };
            const onCanPlay = () => { slots.current[slot]!.ready = true; };
            let lastT = 0;
            const onTime = () => {
                if (frontRef.current !== slot || v.currentTime === lastT) return;
                lastT = v.currentTime;
                setLoading(false);
                setShown(slot);
            };
            v.addEventListener("playing", onPlaying);
            v.addEventListener("waiting", onWaiting);
            v.addEventListener("pause", onPause);
            v.addEventListener("canplay", onCanPlay);
            v.addEventListener("timeupdate", onTime);
            offs.push(() => {
                v.removeEventListener("playing", onPlaying);
                v.removeEventListener("waiting", onWaiting);
                v.removeEventListener("pause", onPause);
                v.removeEventListener("canplay", onCanPlay);
                v.removeEventListener("timeupdate", onTime);
            });
        });
        return () => offs.forEach((f) => f());
    }, []);

    // Tear down on unmount.
    useEffect(() => {
        const s = slots.current;
        const timers = [osdTimer, digitTimer, preloadTimer];
        return () => {
            for (const x of s) { x.handle?.destroy(); x.handle = null; x.channelId = null; }
            for (const tm of timers) if (tm.current) clearTimeout(tm.current);
            playerBus.setNowPlaying(null);
        };
    }, []);

    // ─── zapping ─────────────────────────────────────────────────────────
    const zapTo = useCallback((target: LiveTvChannel) => {
        if (!livetv) return;
        const fromId = curRef.current;
        if (target.id === fromId && !catchupRef.current) { showOsd(); return; }
        zapT0.current = { id: target.id, t0: performance.now() };
        if (preloadTimer.current) clearTimeout(preloadTimer.current);
        lastRef.current = fromId;
        curRef.current = target.id;
        setCurId(target.id);
        setCatchup(null);
        catchupRef.current = null;
        setError(null);
        showOsd(strip);
        window.history.replaceState(window.history.state, "", mapHref(`/media/live/play/${encodeURIComponent(target.id)}`));
        const f = frontRef.current;
        const b = 1 - f;
        const bs = slots.current[b]!;
        const oldFront = vid(f);
        const bv = vid(b);
        if (bs.channelId === target.id && bs.handle && bv) {
            bv.muted = mutedRef.current;
            bs.handle.promote();
            frontRef.current = b;
            if (oldFront) { oldFront.muted = true; oldFront.pause(); }
            if (bs.ready) setShown(b);
            bv.play().catch(() => undefined);
            setLoading(!bs.ready);
        } else {
            frontRef.current = b;
            setLoading(true);
            if (oldFront) oldFront.muted = true;
            void load(b, target.id, livetv.streamUrl(target.id), false);
        }
    }, [livetv, load, showOsd, strip, mapHref]);

    const zap = useCallback((d: 1 | -1) => {
        dirRef.current = d;
        const n = neighbour(curRef.current, d);
        if (n) zapTo(n);
    }, [neighbour, zapTo]);

    const lastChannel = useCallback(() => {
        const id = lastRef.current;
        const ch = id ? channels?.find((c) => c.id === id) : null;
        if (ch) zapTo(ch); else toast(t("noLastChannel"));
    }, [channels, zapTo, t]);

    const commitDigits = useCallback((value: string) => {
        if (digitTimer.current) clearTimeout(digitTimer.current);
        digitsRef.current = "";
        setDigits("");
        if (!channels || !value) return;
        const ch = channelByNumber(channels, value);
        if (ch) zapTo(ch); else toast(t("noChannelNumber", { n: value }));
    }, [channels, zapTo, t]);

    const typeDigit = useCallback((d: string) => {
        const r = pushDigit(digitsRef.current, d);
        digitsRef.current = r.buf;
        setDigits(r.buf);
        if (digitTimer.current) clearTimeout(digitTimer.current);
        if (r.commit) { commitDigits(r.buf); return; }
        digitTimer.current = setTimeout(() => commitDigits(digitsRef.current), DIGIT_COMMIT_MS);
    }, [commitDigits]);

    const retry = useCallback(() => {
        if (!livetv) return;
        setError(null);
        setLoading(true);
        const c = catchupRef.current;
        void load(frontRef.current, curRef.current, c ? livetv.catchupUrl(curRef.current, c.start, c.dur) : livetv.streamUrl(curRef.current), false, !!c);
    }, [load, livetv]);

    const backToLive = useCallback(() => {
        if (!livetv) return;
        setCatchup(null);
        catchupRef.current = null;
        window.history.replaceState(window.history.state, "", mapHref(`/media/live/play/${encodeURIComponent(curRef.current)}`));
        setLoading(true);
        void load(frontRef.current, curRef.current, livetv.streamUrl(curRef.current), false);
    }, [load, livetv, mapHref]);

    const recordNow = useCallback(async () => {
        if (!livetv) return;
        const ch = channels?.find((c) => c.id === curRef.current);
        if (!ch) return;
        const p = nn.get(ch.id)?.now;
        try {
            if (p) await livetv.record({ channelId: ch.id, programme: p.start });
            else await livetv.record({ channelId: ch.id, start: Date.now(), stop: Date.now() + 3_600_000, title: ch.name });
            toast.success(t("recordScheduled", { title: p?.title ?? ch.name }));
        } catch (e) {
            toast.error(t("recordFailed", { msg: errorText(e) }));
        }
    }, [channels, nn, livetv, t]);

    const togglePause = useCallback(() => {
        const v = vid(frontRef.current);
        if (!v) return;
        if (v.paused) v.play().catch(() => undefined); else v.pause();
    }, []);

    const toggleMute = useCallback(() => {
        setMuted((m) => {
            const v = vid(frontRef.current);
            if (v) v.muted = !m;
            return !m;
        });
    }, []);

    const toggleFullscreen = useCallback(() => {
        const el = rootRef.current;
        if (!el) return;
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        else void el.requestFullscreen?.().catch(() => undefined);
    }, []);
    useEffect(() => {
        const on = () => setFullscreen(!!document.fullscreenElement);
        document.addEventListener("fullscreenchange", on);
        return () => document.removeEventListener("fullscreenchange", on);
    }, []);

    const exit = useCallback(() => {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        if (window.history.length > 1) router.back(); else router.push("/media/live");
    }, [router]);

    // ─── keys ────────────────────────────────────────────────────────────
    useEffect(() => {
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const el = e.target as HTMLElement | null;
            if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
            const k = e.key;
            let handled = true;
            if (/^\d$/.test(k)) typeDigit(k);
            else if (k === "ArrowUp" || k === "PageUp" || k === "ChannelUp") zap(1);
            else if (k === "ArrowDown" || k === "PageDown" || k === "ChannelDown") zap(-1);
            else if (k === "Enter" && digitsRef.current) commitDigits(digitsRef.current);
            else if (k === "Backspace" || k === "l" || k === "L") lastChannel();
            else if (k === " " || k === "k" || k === "K" || k === "MediaPlayPause") { if (el?.tagName === "BUTTON" && k === " ") handled = false; else togglePause(); }
            else if (k === "m" || k === "M") toggleMute();
            else if (k === "f" || k === "F") toggleFullscreen();
            else if (k === "g" || k === "G" || k === "i" || k === "I") { setStrip((s) => { showOsd(!s); return !s; }); }
            else if (k === "r" || k === "R") void recordNow();
            else if (k === "Escape") { if (strip) { setStrip(false); showOsd(); } else if (!document.fullscreenElement) exit(); else handled = false; }
            else handled = false;
            if (handled) { e.preventDefault(); showOsd(strip); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [zap, typeDigit, commitDigits, lastChannel, togglePause, toggleMute, toggleFullscreen, recordNow, exit, showOsd, strip]);

    // ─── hub / remote ────────────────────────────────────────────────────
    useEffect(() => playerBus.subscribe((cmd) => {
        switch (cmd.type) {
            case "pause": vid(frontRef.current)?.pause(); return true;
            case "resume": void vid(frontRef.current)?.play().catch(() => undefined); return true;
            case "toggle": togglePause(); return true;
            case "next": zap(1); return true;
            case "previous": zap(-1); return true;
            case "stop": exit(); return true;
            case "volume": { const v = vid(frontRef.current); if (v) v.volume = Math.max(0, Math.min(1, cmd.level)); return true; }
            default: return false;
        }
    }), [togglePause, zap, exit]);

    const curNow = cur ? nn.get(cur.id)?.now ?? null : null;
    const curNext = cur ? nn.get(cur.id)?.next ?? null : null;
    useEffect(() => {
        if (!cur) return;
        playerBus.setNowPlaying({
            kind: "live", playing: !paused, positionSec: 0,
            media: { kind: "live", channelId: cur.id, title: cur.name },
            title: curNow?.title ?? cur.name, subtitle: cur.name, artUrl: livetv?.logoUrl(cur) ?? null, updatedAt: Date.now(),
        });
    }, [cur, curNow, paused, livetv]);

    if (!livetv) return null;

    return (
        <div ref={rootRef} className="lv-player dark" data-osd={osd || paused || !!error ? "" : undefined}
            onMouseMove={() => showOsd(strip)} onClick={(e) => { if (e.target === e.currentTarget) showOsd(strip); }}
            role="application" aria-label={t("label", { name: cur?.name ?? "" })} aria-roledescription={t("roleDescription")}>
            <video ref={vidA} className="lv-player-video" data-shown={shown === 0 ? "" : undefined} playsInline aria-hidden={shown !== 0} tabIndex={-1}
                onDoubleClick={toggleFullscreen} />
            <video ref={vidB} className="lv-player-video" data-shown={shown === 1 ? "" : undefined} playsInline aria-hidden={shown !== 1} tabIndex={-1}
                onDoubleClick={toggleFullscreen} />

            {loading && !error ? <div className="lv-player-spinner" role="status" aria-label={t("loading")}><Loader2 aria-hidden className="size-10" /></div> : null}
            {error ? (
                <div className="lv-player-error">
                    <ErrorState detail={error} onRetry={retry} />
                </div>
            ) : null}
            {digits ? <div className="lv-player-digits" aria-live="assertive" aria-label={t("typedNumber", { n: digits })}>{digits}</div> : null}

            <div className="lv-osd-top">
                <Button variant="ghost" size="icon" onClick={exit} aria-label={t("back")}><ArrowLeft aria-hidden /></Button>
                {catchup ? (
                    <span className="lv-osd-badge"><History aria-hidden className="size-4" />{t("catchup", { time: fmt.dateTime(catchup.start) })}</span>
                ) : <LiveDot label={t("live")} />}
            </div>

            <div className="lv-osd" aria-live="polite">
                {cur ? (
                    <div className="lv-osd-info">
                        <ChannelLogo channel={cur} livetv={livetv} size="lg" />
                        <div className="lv-osd-text">
                            <p className="lv-osd-ch">{cur.number ? <span className="lv-num">{cur.number}</span> : null}{cur.name}</p>
                            {curNow ? (
                                <>
                                    <p className="lv-osd-title">{curNow.title}</p>
                                    <div className="lv-osd-prog">
                                        <span>{fmt.time(curNow.start)}</span>
                                        <Progress value={progressOf(curNow, now)} label={t("progress")} />
                                        <span>{fmt.time(curNow.stop)}</span>
                                    </div>
                                </>
                            ) : <p className="lv-dim">{t("noInfo")}</p>}
                            {curNext ? <p className="lv-dim">{t("next", { time: fmt.time(curNext.start), title: curNext.title })}</p> : null}
                        </div>
                    </div>
                ) : null}
                <div className="lv-osd-controls" role="toolbar" aria-label={t("controls")}>
                    <Button variant="ghost" size="icon" onClick={() => zap(-1)} aria-label={t("prev")} aria-keyshortcuts="ArrowDown"><ChevronDown aria-hidden /></Button>
                    <Button variant="ghost" size="icon" onClick={togglePause} aria-label={paused ? t("play") : t("pause")} aria-keyshortcuts="Space">
                        {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => zap(1)} aria-label={t("nextChannel")} aria-keyshortcuts="ArrowUp"><ChevronUp aria-hidden /></Button>
                    <Button variant="ghost" size="icon" onClick={toggleMute} aria-label={muted ? t("unmute") : t("mute")} aria-keyshortcuts="M">
                        {muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
                    </Button>
                    {catchup ? <Button variant="ghost" size="sm" onClick={backToLive}><Radio aria-hidden />{t("backToLive")}</Button> : null}
                    <span className="lv-osd-spacer" />
                    <Button variant="ghost" size="sm" onClick={() => void recordNow()} aria-keyshortcuts="R"><Disc3 aria-hidden />{t("record")}</Button>
                    <Button variant="ghost" size="sm" aria-pressed={strip} onClick={() => setStrip((s) => { showOsd(!s); return !s; })} aria-keyshortcuts="G">
                        <ListVideo aria-hidden />{t("guide")}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={toggleFullscreen} aria-label={fullscreen ? t("exitFullscreen") : t("fullscreen")} aria-keyshortcuts="F">
                        {fullscreen ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
                    </Button>
                </div>
                {strip && channels ? (
                    <ul className="lv-strip" aria-label={t("stripLabel")}>
                        {stripIds.map((id) => {
                            const ch = channels.find((c) => c.id === id);
                            if (!ch) return null;
                            const p = nn.get(id)?.now ?? null;
                            return (
                                <li key={id}>
                                    <button type="button" className="lv-strip-item" aria-current={id === curId ? "true" : undefined} onClick={() => zapTo(ch)}>
                                        <ChannelLogo channel={ch} livetv={livetv} size="sm" />
                                        <span className="lv-strip-text">
                                            <span className="lv-strip-ch">{ch.number ? `${ch.number} ` : ""}{ch.name}</span>
                                            <span className="lv-strip-title">{p?.title ?? t("noInfo")}</span>
                                            {p ? <Progress value={progressOf(p, now)} /> : null}
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                ) : null}
            </div>
        </div>
    );
}
