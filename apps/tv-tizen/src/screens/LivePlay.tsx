/**
 * Live player (WP16-34) — full screen, TWO <video> slots for fast zapping: the front plays, the back holds the
 * preloaded neighbour (direction of the last zap). CH+/Up = next, CH−/Down = previous, PRE-CH/yellow = last
 * channel, digits = number entry (commit after 1.5 s), OK/Info = banner + mini-guide strip, red = record now,
 * Back closes the strip, then leaves. The banner (logo, number, name, now/next + progress) shows at once on
 * a zap. Zap time key → `playing` is logged (`[perf] zap`) and kept in `window.__mixaiZap`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/messages";
import type { LiveTvChannel, LiveTvNowNext } from "../lib/media-types";
import { playerBus } from "../lib/player-bus";
import { squeezeFactor, videoBox } from "../lib/screen-format";
import { keyFromEvent } from "../lib/tv-keys";
import { focusByKey } from "../lib/focus";
import { consumeBack } from "../nav/back";
import { useScreenActive } from "../nav/Nav";
import type { ScreenProps } from "../nav/ctx";
import { digitFromEvent, ErrorState, PrimaryButton, Row, SecondaryButton } from "../ui";
import { ChannelLogo, LiveDot, Progress, fetchNowNext, getZapGroup, hhmm, progressOf, takeCatchup, type CatchupRequest } from "./livetv/common";
import { attachLive, type LiveHandle } from "./livetv/stream";

declare global {
    interface Window { __mixaiZap?: number[]; __mixaiLiveOpen?: number }
}

const BANNER_MS = 5000;
const DIGIT_COMMIT_MS = 1500;
const PRELOAD_DELAY_MS = 800;
const KEY_PRECH = 10190;

interface Slot { channelId: string | null; handle: LiveHandle | null; ready: boolean }

function pushZap(ms: number): void {
    const w = window;
    (w.__mixaiZap ??= []).push(Math.round(ms));
    console.info("[perf] zap", Math.round(ms));
}

export function LivePlay({ ctx, params }: ScreenProps<"livePlay">) {
    const { livetv, nav, lang } = ctx;
    const active = useScreenActive();
    const vidA = useRef<HTMLVideoElement>(null);
    const vidB = useRef<HTMLVideoElement>(null);
    const vid = (i: number): HTMLVideoElement | null => (i === 0 ? vidA : vidB).current;
    const slotA = useRef<Slot>({ channelId: null, handle: null, ready: false });
    const slotB = useRef<Slot>({ channelId: null, handle: null, ready: false });
    const slotOf = (i: number): Slot => (i === 0 ? slotA : slotB).current;
    /** Slot receiving input/audio (`front`) vs the slot that is visible (`shown`, flips once the new one plays). */
    const frontRef = useRef(0);
    const [shown, setShown] = useState(0);
    const [channels, setChannels] = useState<LiveTvChannel[] | null>(null);
    const [curId, setCurId] = useState(params.channelId);
    const curRef = useRef(params.channelId);
    const lastRef = useRef<string | null>(null);
    const dirRef = useRef<1 | -1>(1);
    const zapT0 = useRef<{ id: string; t0: number } | null>(null);
    const openT0 = useRef(performance.now());
    const [banner, setBanner] = useState(true);
    const [strip, setStrip] = useState(false);
    const [digits, setDigits] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [toast, setToast] = useState<string | null>(null);
    const [nn, setNn] = useState<Map<string, LiveTvNowNext>>(new Map());
    const [aspect, setAspect] = useState(16 / 9);
    const [paused, setPaused] = useState(false);
    const [catchup, setCatchup] = useState<CatchupRequest | null>(() => takeCatchup(params.channelId));
    const catchupRef = useRef(catchup);
    catchupRef.current = catchup;
    const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const digitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const preloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const squeeze = squeezeFactor();

    // ─── channel list (zap order = the list's group, else all) ───────────
    useEffect(() => {
        let alive = true;
        void (async () => {
            const g = getZapGroup();
            let list = await livetv.channels(g ? { group: g } : {}).catch(() => [] as LiveTvChannel[]);
            if (!list.some((c) => c.id === params.channelId)) list = await livetv.channels({ hidden: true }).catch(() => list);
            if (alive) setChannels(list);
        })();
        return () => { alive = false; };
    }, [livetv, params.channelId]);

    const idx = useMemo(() => channels?.findIndex((c) => c.id === curId) ?? -1, [channels, curId]);
    const cur = channels && idx >= 0 ? channels[idx]! : null;
    const neighbour = useCallback((id: string, d: 1 | -1): LiveTvChannel | null => {
        if (!channels || channels.length < 2) return null;
        const i = channels.findIndex((c) => c.id === id);
        return channels[(i + d + channels.length) % channels.length] ?? null;
    }, [channels]);

    // now/next for current ± 2
    useEffect(() => {
        if (!channels || idx < 0) return;
        const ids = [-2, -1, 0, 1, 2].map((d) => channels[(idx + d + channels.length) % channels.length]!.id);
        void fetchNowNext(livetv, Array.from(new Set(ids))).then((m) => setNn((c) => { const o = new Map(c); m.forEach((v, k) => o.set(k, v)); return o; }));
    }, [channels, idx, livetv]);

    // ─── banner / toast ──────────────────────────────────────────────────
    const showBanner = useCallback((sticky = false) => {
        setBanner(true);
        if (bannerTimer.current) clearTimeout(bannerTimer.current);
        if (!sticky) bannerTimer.current = setTimeout(() => setBanner(false), BANNER_MS);
    }, []);
    const flash = useCallback((msg: string) => {
        setToast(msg);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 3000);
    }, []);

    // ─── slots ───────────────────────────────────────────────────────────
    const load = useCallback(async (slot: number, id: string, url: string, preload: boolean) => {
        const s = slotOf(slot);
        s.handle?.destroy();
        s.handle = null;
        s.channelId = id;
        s.ready = false;
        const v = vid(slot);
        if (!v) return;
        v.muted = preload;
        const h = await attachLive(v, url, {
            preload,
            onFatal: (m) => { if (slotOf(slot).channelId === id && frontRef.current === slot) setError(m); },
        });
        if (slotOf(slot).channelId !== id) { h.destroy(); return; }
        s.handle = h;
        if (!preload) v.play().catch(() => undefined);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const schedulePreload = useCallback((fromId: string) => {
        if (preloadTimer.current) clearTimeout(preloadTimer.current);
        preloadTimer.current = setTimeout(() => {
            const n = neighbour(fromId, dirRef.current);
            const back = 1 - frontRef.current;
            if (!n || n.id === fromId || slotOf(back).channelId === n.id) return;
            void load(back, n.id, livetv.streamUrl(n.id), true);
        }, PRELOAD_DELAY_MS);
    }, [neighbour, load, livetv]);

    // Initial start (live, or a catch-up hand-off from the Guide).
    useEffect(() => {
        void load(0, params.channelId, catchup ? catchup.url : livetv.streamUrl(params.channelId), false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Media events on both elements.
    useEffect(() => {
        const offs: Array<() => void> = [];
        [0, 1].forEach((slot) => {
            const v = vid(slot);
            if (!v) return;
            const onPlaying = () => {
                const s = slotOf(slot);
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
                if (s.channelId && !catchupRef.current) schedulePreload(s.channelId);
            };
            const onWaiting = () => { if (frontRef.current === slot) setLoading(true); };
            const onPause = () => { if (frontRef.current === slot) setPaused(true); };
            const onSize = () => { if (frontRef.current === slot && v.videoWidth > 0 && v.videoHeight > 0) setAspect(v.videoWidth / v.videoHeight); };
            const onCanPlay = () => { slotOf(slot).ready = true; };
            // Tizen does not always re-fire `playing` after a swap/stall: progress clears the spinner.
            let lastT = 0;
            const onTime = () => {
                if (frontRef.current !== slot || v.currentTime === lastT) return;
                lastT = v.currentTime;
                setLoading(false);
                setShown(slot);
            };
            v.addEventListener("timeupdate", onTime);
            v.addEventListener("playing", onPlaying);
            v.addEventListener("waiting", onWaiting);
            v.addEventListener("pause", onPause);
            v.addEventListener("loadedmetadata", onSize);
            v.addEventListener("resize", onSize);
            v.addEventListener("canplay", onCanPlay);
            offs.push(() => {
                v.removeEventListener("playing", onPlaying);
                v.removeEventListener("waiting", onWaiting);
                v.removeEventListener("pause", onPause);
                v.removeEventListener("loadedmetadata", onSize);
                v.removeEventListener("resize", onSize);
                v.removeEventListener("canplay", onCanPlay);
                v.removeEventListener("timeupdate", onTime);
            });
        });
        return () => offs.forEach((f) => f());
    }, [schedulePreload]); // eslint-disable-line react-hooks/exhaustive-deps

    // Tear everything down on unmount.
    useEffect(() => () => {
        for (const s of [slotA.current, slotB.current]) { s.handle?.destroy(); s.handle = null; s.channelId = null; }
        for (const tm of [bannerTimer, digitTimer, preloadTimer, toastTimer]) if (tm.current) clearTimeout(tm.current);
        playerBus.setNowPlaying(null);
    }, []);

    // Pause while covered by another keep-alive screen (e.g. Guide pushed on top).
    useEffect(() => {
        const v = vid(frontRef.current);
        if (!v) return;
        if (!active) v.pause(); else if (v.paused && slotOf(frontRef.current).handle) v.play().catch(() => undefined);
    }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── zapping ─────────────────────────────────────────────────────────
    const zapTo = useCallback((target: LiveTvChannel) => {
        const fromId = curRef.current;
        if (target.id === fromId && !catchupRef.current) { showBanner(); return; }
        zapT0.current = { id: target.id, t0: performance.now() };
        if (preloadTimer.current) clearTimeout(preloadTimer.current);
        lastRef.current = fromId;
        curRef.current = target.id;
        setCurId(target.id);
        setCatchup(null);
        setError(null);
        showBanner(strip);
        const f = frontRef.current;
        const b = 1 - f;
        const bs = slotOf(b);
        const oldFront = vid(f);
        const bv = vid(b);
        if (bs.channelId === target.id && bs.handle && bv) {
            // Preloaded → swap now.
            bv.muted = false;
            bs.handle.promote();
            frontRef.current = b;
            if (oldFront) { oldFront.muted = true; oldFront.pause(); }
            if (bs.ready) setShown(b);
            bv.play().catch(() => undefined);
            setLoading(!bs.ready);
        } else {
            // Cold: load into the back slot and show it as soon as it plays (old picture stays meanwhile).
            frontRef.current = b;
            setLoading(true);
            if (oldFront) oldFront.muted = true;
            void load(b, target.id, livetv.streamUrl(target.id), false);
        }
    }, [load, livetv, showBanner, strip]); // eslint-disable-line react-hooks/exhaustive-deps

    const zap = useCallback((d: 1 | -1) => {
        dirRef.current = d;
        const n = neighbour(curRef.current, d);
        if (n) zapTo(n);
    }, [neighbour, zapTo]);

    const lastChannel = useCallback(() => {
        const id = lastRef.current;
        const ch = id ? channels?.find((c) => c.id === id) : null;
        if (ch) zapTo(ch); else flash(t("lt.noLastChannel"));
    }, [channels, zapTo, flash]);

    const commitDigits = useCallback((value: string) => {
        setDigits("");
        if (!channels || !value) return;
        const ch = channels.find((c) => (c.number ?? "") === value) ?? channels.find((c) => Number(c.number) === Number(value)) ?? channels[Number(value) - 1];
        if (ch) zapTo(ch); else flash(t("lt.noChannelNumber", { n: value }));
    }, [channels, zapTo, flash]);

    const retry = useCallback(() => {
        setError(null);
        setLoading(true);
        const f = frontRef.current;
        void load(f, curRef.current, catchupRef.current ? catchupRef.current.url : livetv.streamUrl(curRef.current), false);
    }, [load, livetv]);

    const recordNow = useCallback(async () => {
        const ch = channels?.find((c) => c.id === curRef.current);
        if (!ch) return;
        const now = nn.get(ch.id)?.now;
        try {
            if (now) await livetv.record({ channelId: ch.id, programme: now.start });
            else await livetv.record({ channelId: ch.id, start: Date.now(), stop: Date.now() + 3_600_000, title: ch.name });
            flash(t("lt.recordScheduled", { title: now?.title ?? ch.name }));
        } catch (e) {
            flash(t("lt.recordFailed", { msg: (e as Error).message }));
        }
    }, [channels, nn, livetv, flash]);

    const togglePause = useCallback(() => {
        const v = vid(frontRef.current);
        if (!v) return;
        if (v.paused) v.play().catch(() => undefined); else v.pause();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const exit = useCallback(() => { if (!nav.pop()) nav.resetTo({ name: "livetv" }); }, [nav]);

    // ─── keys (capture phase: the global D-pad never sees them unless the strip is open) ──
    useEffect(() => {
        if (!active) return;
        try {
            const dev = typeof tizen !== "undefined" ? tizen?.tvinputdevice : undefined;
            dev?.registerKey("PreviousChannel");
        } catch { /* unsupported */ }
        const onKey = (e: KeyboardEvent) => {
            const k = keyFromEvent(e);
            const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
            if (k === "back") {
                stop();
                if (consumeBack()) return;
                if (digits) { setDigits(""); return; }
                if (strip) { setStrip(false); showBanner(); return; }
                if (banner) { setBanner(false); return; }
                exit();
                return;
            }
            const d = digitFromEvent(e);
            if (d !== null) {
                stop();
                const v = (digits + d).slice(0, 4);
                setDigits(v);
                if (digitTimer.current) clearTimeout(digitTimer.current);
                digitTimer.current = setTimeout(() => commitDigits(v), DIGIT_COMMIT_MS);
                return;
            }
            if (e.keyCode === KEY_PRECH || k === "yellow") { stop(); lastChannel(); return; }
            switch (k) {
                case "chup": stop(); zap(1); return;
                case "chdown": stop(); zap(-1); return;
                case "red": stop(); void recordNow(); return;
                case "green": stop(); nav.push({ name: "guide" }); return;
                case "info": stop(); if (banner && !strip) setBanner(false); else showBanner(); return;
                case "playpause": case "play": case "pause": stop(); togglePause(); showBanner(); return;
                case "stop": stop(); exit(); return;
                default: break;
            }
            if (strip) { showBanner(true); return; } // arrows + OK → focus system (strip / actions)
            if (error) return; // ErrorState buttons get focus
            switch (k) {
                case "up": stop(); zap(1); return;
                case "down": stop(); zap(-1); return;
                case "enter":
                    stop();
                    if (digits) { if (digitTimer.current) clearTimeout(digitTimer.current); commitDigits(digits); return; }
                    setStrip(true);
                    showBanner(true);
                    requestAnimationFrame(() => focusByKey(`lp-strip:${curRef.current}`));
                    return;
                case "left": case "right": stop(); showBanner(); return;
                default: return;
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [active, digits, strip, banner, error, zap, lastChannel, commitDigits, recordNow, togglePause, exit, showBanner, nav]);

    // ─── player bus ──────────────────────────────────────────────────────
    useEffect(() => playerBus.subscribe((cmd) => {
        const v = vid(frontRef.current);
        switch (cmd.type) {
            case "pause": v?.pause(); break;
            case "resume": v?.play().catch(() => undefined); break;
            case "toggle": togglePause(); break;
            case "next": zap(1); break;
            case "previous": zap(-1); break;
            case "stop": exit(); break;
            case "volume": if (v) v.volume = Math.max(0, Math.min(1, cmd.level > 1 ? cmd.level / 100 : cmd.level)); break;
            default: return false;
        }
        return true;
    }), [zap, togglePause, exit]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!cur) return;
        const now = nn.get(cur.id)?.now;
        playerBus.setNowPlaying({
            kind: "live", playing: !paused, positionSec: 0,
            media: { kind: "live", channelId: cur.id, title: now ? `${cur.name} · ${now.title}` : cur.name },
            title: cur.name, subtitle: now?.title, artUrl: livetv.logoUrl(cur), updatedAt: Date.now(),
        });
    }, [cur, paused, nn, livetv]);

    // ─── render ──────────────────────────────────────────────────────────
    const box = squeeze !== 1 ? videoBox(aspect, squeeze) : null;
    const vStyle = box ? { width: `${box.w * 100}%`, height: `${box.h * 100}%` } : undefined;
    const x = cur ? nn.get(cur.id) : null;
    const nowMs = Date.now();

    return (
        <div className="lp" data-testid="screen-liveplay">
            {[0, 1].map((i) => (
                <video key={i} ref={i === 0 ? vidA : vidB} playsInline data-slot={i}
                    className={`${shown === i ? "is-front" : ""}${box ? " fit-box" : ""}`} style={vStyle} />
            ))}
            {loading && !error && <div className="lp-spinner" aria-label={t("common.loading")} />}
            {error && (
                <div className="lp-error">
                    <ErrorState title={t("lt.playError")} message={error} onRetry={retry} />
                </div>
            )}
            {digits && <div className="lp-digits" data-testid="lp-digits">{digits}</div>}
            {toast && <div className="lp-toast" role="status">{toast}</div>}
            <div className={`lp-banner${banner || strip ? "" : " is-hidden"}`} data-testid="lp-banner" aria-live="polite">
                <div className="lp-banner-head">
                    {cur && <ChannelLogo client={livetv} channel={cur} size="3.4rem" />}
                    <span className="lp-num">{cur?.number ?? (idx >= 0 ? idx + 1 : "")}</span>
                    <span className="lp-name">{catchup ? null : <LiveDot />} {cur?.name ?? "…"}</span>
                    {catchup && <span className="badge badge-warning">{t("lt.catchup")}</span>}
                    {paused && <span className="badge badge-neutral">{t("player.pause")}</span>}
                    <span className="lp-clock">{hhmm(nowMs, lang)}</span>
                </div>
                <div className="lp-progs">
                    <div className="lp-prog">
                        <div className="lp-prog-label">{catchup ? t("lt.catchup") : t("lt.now")}</div>
                        <div className="lp-prog-title">{catchup?.title ?? x?.now?.title ?? t("lt.noGuide")}</div>
                        {(catchup ?? x?.now) && (
                            <>
                                <Progress value={catchup ? 0 : progressOf(x?.now, nowMs)} />
                                <div className="lp-prog-time">{hhmm((catchup ?? x!.now!).start, lang)}–{hhmm((catchup ?? x!.now!).stop, lang)}</div>
                            </>
                        )}
                    </div>
                    <div className="lp-prog">
                        <div className="lp-prog-label">{t("lt.next")}</div>
                        <div className="lp-prog-title">{x?.next?.title ?? "—"}</div>
                        {x?.next && <div className="lp-prog-time">{hhmm(x.next.start, lang)}–{hhmm(x.next.stop, lang)}</div>}
                    </div>
                </div>
                {strip && channels && (
                    <>
                        <div className="lp-actions" data-focus-row="lp-actions">
                            <PrimaryButton icon="record" label={t("lt.recordNow")} onClick={() => { void recordNow(); }} focusKey="lp:record" />
                            <SecondaryButton icon="guide" label={t("screen.guide")} onClick={() => nav.push({ name: "guide" })} focusKey="lp:guide" />
                            <SecondaryButton icon="refresh" label={t("lt.lastChannel")} onClick={lastChannel} focusKey="lp:last" />
                        </div>
                        <div className="lp-strip">
                            <Row rowId="lp-strip" items={channels} itemWidthRem={13} heightRem={4.8} itemKey={(c) => c.id}
                                renderItem={(c) => {
                                    const cn = nn.get(c.id);
                                    return (
                                        <button type="button" className={`lp-chip${c.id === curId ? " is-current" : ""}`} data-focusable="" data-focus-key={`lp-strip:${c.id}`}
                                            onClick={() => { setStrip(false); zapTo(c); }}
                                            onFocus={() => { void fetchNowNext(livetv, [c.id]).then((m) => setNn((o) => { const n = new Map(o); m.forEach((v, k) => n.set(k, v)); return n; })); }}>
                                            <span className="lp-chip-name">{c.number ? `${c.number} · ` : ""}{c.name}</span>
                                            <span className="lp-chip-now">{cn?.now?.title ?? ""}</span>
                                        </button>
                                    );
                                }} />
                        </div>
                    </>
                )}
                {!strip && <div className="lt-note" style={{ marginTop: "0.6rem" }}>{t("lt.playHint")}</div>}
            </div>
        </div>
    );
}
