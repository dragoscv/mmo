"use client";

/**
 * Cinematic web player (WP16-39). Shared by the owner route `/media/play/[kind]/[tmdbId]` and the public guest
 * page `/together` (no MmoProvider dependency: everything comes in through props).
 *
 * Playback: always the server's HLS (`/video/stream/:id?q=original&start=&caps=&audio=`), hls.js on MSE
 * browsers, native HLS on Safari/iOS. The session starts AT the wanted position, so the element clock is
 * relative (`offsetRef`). Seeks inside the produced range move `currentTime`; far seeks restart the session.
 * Audio track = `audio=<n>` (one track per HLS session, server ≥ 3.7) → reload at the current position.
 * Video is never re-encoded by request: `q=original` always.
 *
 * Keys: Space/K play-pause, ←/→ J/L ±10 s, ↑/↓ volume, M mute, F fullscreen, C subtitles, 0–9 jump, Esc back
 * (panel → fullscreen → exit). Mouse idle 3 s hides the OSD; touch tap toggles it, double tap on a side ±10 s.
 */
import "./player.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type PointerEvent as ReactPointerEvent } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import type Hls from "hls.js";
import {
    ArrowLeft, AudioLines, Captions, Cast, Info, Loader2, Maximize, Minimize, Moon, Pause, PictureInPicture2, Play,
    RotateCcw, RotateCw, Settings, SkipForward, Square, Users, Volume1, Volume2, VolumeX,
} from "lucide-react";
import type { HubClient } from "@/lib/mmo/hub";
import type { MediaClient } from "@/lib/mmo/media";
import type { HubAck, HubDevice, MediaKind, VersionedFile } from "@/lib/mmo/media-types";
import { playerBus, type PlayerCommand } from "@/lib/mmo/player-bus";
import { tmdbImg } from "@/lib/media/normalize";
import { fetchFileInfo, fetchMarkers, NO_MARKERS, pauseStream, prefersNativeHls, type Markers, type Span } from "./data";
import {
    bitrateLabel, browserCaps, channelsLabel, endsAtDate, FITS, formatTime, hlsUrl, hubMediaOf, inSpan, isCompleted, keyAction,
    keyBelongsToControl, normLang, OSD_IDLE_MS, PAUSE_KILL_MS, pickAudio, pickSubtitle, PROGRESS_INTERVAL_MS, resolutionLabel,
    SLEEP_OPTIONS, SPEEDS, spriteUrl as buildSpriteUrl, STILL_WATCHING_AFTER, SUB_BGS, SUB_SIZES, subtitleOrder, subtitleUrl,
    UP_NEXT_COUNTDOWN, UP_NEXT_LEAD_SEC, type FileInfo, type Fit, type PlayerPrefs, type StreamAuth, type SubBg, type SubSize,
} from "./model";
import { Bubbles, RadioList, SidePanel, StillWatching, UpNextCard, type Bubble } from "./panels";
import type { NextUpInfo } from "./resolve";
import { ScrubBar } from "./scrub-bar";
import { TogetherPanel, roomErrorKey, useRoomChat } from "./together-panel";
import { useRoomSync } from "./use-room-sync";
import { activeCues, parseVtt, type Cue } from "./vtt";

export interface PlayerSource {
    fileId: string;
    path?: string | null;
    title: string;
    /** "S1 · E2 — Name" line. */
    subtitle?: string | null;
    kind?: MediaKind;
    tmdbId?: number;
    season?: number | null;
    episode?: number | null;
    posterPath?: string | null;
    backdropPath?: string | null;
    overview?: string | null;
    runtimeSec?: number | null;
}

export interface RemoteApi {
    device(id: string): HubDevice | null;
    send(id: string, action: string, args?: Record<string, unknown>): Promise<HubAck | null>;
}

export interface CastSlot {
    Picker: ComponentType<{ fileId: string; positionSec: number; onSent(d: HubDevice): void }>;
    remote: RemoteApi;
}

export interface CinemaPlayerProps {
    baseUrl: string;
    auth: StreamAuth;
    source: PlayerSource;
    startSec: number;
    prefs: PlayerPrefs;
    versions?: VersionedFile[];
    onSwitchFile?(fileId: string, atSec: number): void;
    /** Progress writes (owner only). */
    media?: MediaClient | null;
    hub: HubClient | null;
    guest?: boolean;
    nextUp?: NextUpInfo | null;
    nextUpStill?: string | null;
    onPlayNext?(): void;
    onExit(): void;
    /** `?room=` deep link: join this room once the hub is connected. */
    joinRoomId?: string | null;
    cast?: CastSlot;
    /** Open the Watch Together panel on mount (guest page). */
    openTogether?: boolean;
    /** Hub `play {fileId,…}` received while this page is open (a new title): the route navigates. */
    onRemotePlay?(args: Record<string, unknown>): boolean;
}

type PanelId = "audio" | "subs" | "settings" | "info" | "together" | "cast" | null;
interface Load { n: number; at: number; audio: number }

/** Survives the route switching to the next episode (autoplay streak for "Still watching?"). */
const session = { streak: 0, pendingAuto: false };
const VOL_KEY = "mixai-web:player:volume";
const DOUBLE_TAP_MS = 300;

function readVolume(): { v: number; muted: boolean } {
    try {
        const raw = localStorage.getItem(VOL_KEY);
        const j = raw ? (JSON.parse(raw) as { v?: unknown; muted?: unknown }) : null;
        const v = typeof j?.v === "number" && j.v >= 0 && j.v <= 1 ? j.v : 1;
        return { v, muted: j?.muted === true };
    } catch {
        return { v: 1, muted: false };
    }
}

export function CinemaPlayer(props: CinemaPlayerProps) {
    const { baseUrl, auth, source, prefs, media = null, hub, guest = false, nextUp = null, cast } = props;
    const t = useTranslations("mx.player");
    const format = useFormatter();
    const locale = useLocale();
    const rootRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<Hls | null>(null);
    const offsetRef = useRef(0);
    const fileId = source.fileId;

    const [info, setInfo] = useState<FileInfo | null>(null);
    const [load, setLoad] = useState<Load>({ n: 0, at: Math.max(0, Math.floor(props.startSec)), audio: 0 });
    const [time, setTime] = useState(Math.max(0, props.startSec));
    const [elDuration, setElDuration] = useState(0);
    const [buffered, setBuffered] = useState(0);
    const [paused, setPaused] = useState(true);
    const [waiting, setWaiting] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [osd, setOsd] = useState(true);
    const [panel, setPanel] = useState<PanelId>(props.openTogether ? "together" : null);
    const [vol, setVol] = useState(() => (typeof window === "undefined" ? { v: 1, muted: false } : readVolume()));
    const [rate, setRate] = useState(1);
    const [fit, setFit] = useState<Fit>("contain");
    const [subIdx, setSubIdx] = useState(-1);
    const lastSub = useRef(-1);
    const [cues, setCues] = useState<Cue[]>([]);
    const [subSize, setSubSize] = useState<SubSize>(prefs.subSize);
    const [subBg, setSubBg] = useState<SubBg>(prefs.subBg);
    const [markers, setMarkers] = useState<Markers>(NO_MARKERS);
    const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
    const [upNext, setUpNext] = useState<"hidden" | "shown" | "dismissed">("hidden");
    const [countdown, setCountdown] = useState<number | null>(null);
    const [stillAsk, setStillAsk] = useState(false);
    const [sleepMin, setSleepMin] = useState(0);
    const [sleepAt, setSleepAt] = useState(0);
    const [sprite, setSprite] = useState<"none" | "loading" | "ok" | "failed">("none");
    const [fullscreen, setFullscreen] = useState(false);
    const [toast, setToast] = useState<string | null>(null);
    const [bubbles, setBubbles] = useState<Bubble[]>([]);
    const [remote, setRemote] = useState<HubDevice | null>(null);
    const [now, setNow] = useState(() => Date.now());

    const osdTimer = useRef<number | null>(null);
    const toastTimer = useRef<number | null>(null);
    const lastSave = useRef(0);
    const pauseKill = useRef<{ timer: number | null; killed: boolean }>({ timer: null, killed: false });
    const tap = useRef<{ at: number; side: -1 | 0 | 1 }>({ at: 0, side: 0 });
    const bubbleId = useRef(0);
    const caps = useRef<string[] | null>(null);

    const duration = info?.durationSec ?? source.runtimeSec ?? elDuration;
    const absNow = useCallback(() => {
        const el = videoRef.current;
        return el ? offsetRef.current + el.currentTime : offsetRef.current;
    }, []);

    const flash = useCallback((msg: string) => {
        setToast(msg);
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), 3200);
    }, []);

    // ─── file info + defaults from profile prefs ──────────────────────────
    useEffect(() => {
        const ctrl = new AbortController();
        fetchFileInfo(baseUrl, auth, fileId, source.path, ctrl.signal)
            .then((i) => {
                if (ctrl.signal.aborted || !i) return;
                setInfo(i);
                const a = pickAudio(i.audioTracks, prefs);
                const s = pickSubtitle(i, prefs, a);
                setSubIdx(s);
                if (a > 0) setLoad((l) => ({ n: l.n + 1, at: Math.max(l.at, Math.floor(absNow())), audio: a }));
            })
            .catch(() => undefined);
        return () => ctrl.abort();
        // Info is per file; prefs are applied once per file.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [baseUrl, fileId]);

    // ─── source (HLS) ─────────────────────────────────────────────────────
    useEffect(() => {
        const el = videoRef.current;
        if (!el) return;
        let cancelled = false;
        offsetRef.current = load.at;
        if (!caps.current) {
            const ms = typeof MediaSource !== "undefined" ? MediaSource : null;
            caps.current = browserCaps((m) => (ms ? ms.isTypeSupported(m) : el.canPlayType(m) !== ""));
        }
        const url = hlsUrl(baseUrl, fileId, auth, { startSec: load.at, audio: load.audio, caps: caps.current, quality: "original" });
        const native = prefersNativeHls(el, navigator.userAgent, typeof MediaSource !== "undefined");
        const kick = () => { el.playbackRate = rate; el.play().catch(() => setPaused(true)); };

        if (native) {
            // Safari starts an EVENT playlist (ffmpeg still writing) near its live edge: the session already
            // starts AT the wanted position, so pin element time 0 once metadata is in.
            const pin = () => { if (el.currentTime > 1.5) el.currentTime = 0; };
            el.addEventListener("loadedmetadata", pin, { once: true });
            el.addEventListener("playing", pin, { once: true });
            el.src = url;
            kick();
        } else {
            void import("hls.js").then(({ default: HlsCtor }) => {
                if (cancelled) return;
                if (!HlsCtor.isSupported()) { setError(t("errors.mse")); return; }
                const hls = new HlsCtor({ maxBufferLength: 60, backBufferLength: 30, startPosition: 0, liveDurationInfinity: false });
                hlsRef.current = hls;
                let recovered = false;
                hls.on(HlsCtor.Events.ERROR, (_e, data) => {
                    if (!data.fatal) return;
                    if (!recovered && data.type === HlsCtor.ErrorTypes.NETWORK_ERROR) { recovered = true; hls.startLoad(); return; }
                    if (!recovered && data.type === HlsCtor.ErrorTypes.MEDIA_ERROR) { recovered = true; hls.recoverMediaError(); return; }
                    setError(t("errors.hls", { detail: data.details }));
                });
                hls.on(HlsCtor.Events.MANIFEST_PARSED, kick);
                hls.loadSource(url);
                hls.attachMedia(el);
            }).catch(() => setError(t("errors.generic")));
        }
        return () => {
            cancelled = true;
            hlsRef.current?.destroy();
            hlsRef.current = null;
            el.removeAttribute("src");
            el.load();
        };
        // `rate`/`t` are read at start only; the source changes with `load` / file.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load, baseUrl, fileId]);

    // ─── progress ─────────────────────────────────────────────────────────
    const saveProgress = useCallback((force: boolean, completed?: boolean) => {
        if (!media || guest || !source.kind || !source.tmdbId) return;
        const at = Date.now();
        if (!force && at - lastSave.current < PROGRESS_INTERVAL_MS) return;
        const pos = absNow();
        const dur = duration > 0 ? duration : 0;
        if (pos < 1 && !completed) return;
        lastSave.current = at;
        void media.putProgress([{
            kind: source.kind, tmdbId: source.tmdbId, season: source.season ?? 0, episode: source.episode ?? 0,
            positionSec: Math.floor(completed ? dur || pos : pos), durationSec: Math.floor(dur),
            completed: completed ?? isCompleted(pos, dur), updatedAt: at,
        }]).catch(() => undefined);
    }, [media, guest, source.kind, source.tmdbId, source.season, source.episode, absNow, duration]);
    const saveRef = useRef(saveProgress);
    useEffect(() => { saveRef.current = saveProgress; }, [saveProgress]);

    useEffect(() => {
        const onHide = () => saveRef.current(true);
        window.addEventListener("pagehide", onHide);
        return () => {
            window.removeEventListener("pagehide", onHide);
            saveRef.current(true);
            pauseStream(baseUrl, fileId, auth);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [baseUrl, fileId]);

    // ─── now playing → playerBus (hub `state`) ────────────────────────────
    const hubMedia = useMemo(() => hubMediaOf({
        fileId, kind: source.kind, tmdbId: source.tmdbId, season: source.season, episode: source.episode,
        title: source.title, posterPath: source.posterPath, durationSec: duration,
    }), [fileId, source.kind, source.tmdbId, source.season, source.episode, source.title, source.posterPath, duration]);
    const publish = useCallback((playing: boolean, pos: number) => {
        if (guest) return;
        playerBus.setNowPlaying({
            kind: "video", playing, positionSec: pos, durationSec: duration > 0 ? duration : undefined, media: hubMedia,
            title: source.title, subtitle: source.subtitle ?? undefined, artUrl: tmdbImg(source.posterPath, "w342"), updatedAt: Date.now(),
        });
    }, [guest, duration, hubMedia, source.title, source.subtitle, source.posterPath]);
    useEffect(() => () => { if (!guest) playerBus.setNowPlaying(null); }, [guest]);

    // ─── element events ───────────────────────────────────────────────────
    const onEndedRef = useRef<() => void>(() => undefined);
    useEffect(() => {
        const el = videoRef.current;
        if (!el) return;
        const onTime = () => {
            const abs = offsetRef.current + el.currentTime;
            setTime(abs);
            const b = el.buffered;
            for (let i = 0; i < b.length; i++) {
                if (b.start(i) <= el.currentTime + 0.5 && el.currentTime <= b.end(i)) { setBuffered(offsetRef.current + b.end(i)); break; }
            }
            if (!el.paused) { saveRef.current(false); publish(true, abs); }
        };
        const onDur = () => { if (Number.isFinite(el.duration)) setElDuration(offsetRef.current + el.duration); };
        const onPlay = () => {
            setPaused(false);
            const pk = pauseKill.current;
            if (pk.timer) { window.clearTimeout(pk.timer); pk.timer = null; }
            if (pk.killed) {
                // The server dropped the ffmpeg session while paused: restart it where we are.
                pk.killed = false;
                setLoad((l) => ({ ...l, n: l.n + 1, at: Math.floor(offsetRef.current + el.currentTime) }));
            }
            publish(true, offsetRef.current + el.currentTime);
        };
        const onPause = () => {
            setPaused(true);
            setOsd(true);
            saveRef.current(true);
            publish(false, offsetRef.current + el.currentTime);
            const pk = pauseKill.current;
            if (pk.timer) window.clearTimeout(pk.timer);
            pk.timer = window.setTimeout(() => {
                if (!el.paused) return;
                pk.killed = true;
                pauseStream(baseUrl, fileId, auth);
            }, PAUSE_KILL_MS);
        };
        const onWait = () => setWaiting(true);
        const onReady = () => { setWaiting(false); setError(null); };
        const onEnded = () => onEndedRef.current();
        const onErr = () => {
            const code = el.error?.code;
            if (!code || hlsRef.current) return; // hls.js reports its own errors
            const src = el.currentSrc;
            setError(t("errors.media", { code }));
            if (src) {
                fetch(src, { cache: "no-store" }).then(async (r) => {
                    if (r.ok) return;
                    const j = (await r.json().catch(() => null)) as { code?: string; error?: string } | null;
                    setError(j?.code === "file_missing" ? t("errors.missing") : t("errors.server", { message: j?.error ?? String(r.status) }));
                }).catch(() => setError(t("errors.network")));
            }
        };
        const evs: Array<[string, () => void]> = [
            ["timeupdate", onTime], ["durationchange", onDur], ["loadedmetadata", onDur], ["play", onPlay], ["pause", onPause],
            ["waiting", onWait], ["stalled", onWait], ["playing", onReady], ["canplay", onReady], ["ended", onEnded], ["error", onErr],
        ];
        const pk = pauseKill.current;
        for (const [n, f] of evs) el.addEventListener(n, f);
        return () => {
            for (const [n, f] of evs) el.removeEventListener(n, f);
            if (pk.timer) window.clearTimeout(pk.timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [baseUrl, fileId, publish]);

    // Volume / rate / fullscreen mirrors.
    useEffect(() => {
        const el = videoRef.current;
        if (!el) return;
        el.volume = vol.v;
        el.muted = vol.muted;
        try { localStorage.setItem(VOL_KEY, JSON.stringify(vol)); } catch { /* storage off */ }
    }, [vol]);
    useEffect(() => {
        const onFs = () => setFullscreen(document.fullscreenElement === rootRef.current);
        document.addEventListener("fullscreenchange", onFs);
        return () => document.removeEventListener("fullscreenchange", onFs);
    }, []);
    useEffect(() => {
        const h = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(h);
    }, []);

    // Pause the legacy global music player when a video starts (one sound at a time).
    useEffect(() => {
        const np = playerBus.nowPlaying();
        if (np && np.kind === "audio" && np.playing) playerBus.send({ type: "pause" });
    }, []);

    // ─── markers (skip intro / recap / credits) ───────────────────────────
    useEffect(() => {
        const ctrl = new AbortController();
        void fetchMarkers(baseUrl, auth, fileId, ctrl.signal).then((m) => { if (!ctrl.signal.aborted) setMarkers(m); });
        return () => ctrl.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [baseUrl, fileId]);

    useEffect(() => {
        if (session.pendingAuto) { session.streak += 1; session.pendingAuto = false; } else session.streak = 0;
    }, [fileId]);

    // ─── subtitles ────────────────────────────────────────────────────────
    useEffect(() => {
        if (subIdx < 0) { const h = window.setTimeout(() => setCues([]), 0); return () => window.clearTimeout(h); }
        let alive = true;
        const slow = window.setTimeout(() => { if (alive) flash(t("subs.loading")); }, 1500);
        fetch(subtitleUrl(baseUrl, fileId, subIdx, auth), { cache: "force-cache" })
            .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
            .then((txt) => { if (alive) setCues(parseVtt(txt)); })
            .catch(() => { if (alive) flash(t("subs.error")); })
            .finally(() => window.clearTimeout(slow));
        return () => { alive = false; window.clearTimeout(slow); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [subIdx, baseUrl, fileId]);
    const cueLines = useMemo(() => activeCues(cues, time), [cues, time]);

    // ─── seeking ──────────────────────────────────────────────────────────
    const seekAbs = useCallback((target: number) => {
        const el = videoRef.current;
        if (!el) return;
        const total = duration > 0 ? duration : Infinity;
        const tgt = Math.max(0, Math.min(total - 0.5, target));
        const local = tgt - offsetRef.current;
        const s = el.seekable;
        const end = s.length > 0 ? s.end(s.length - 1) : 0;
        setTime(tgt);
        if (local < 0 || local > end - 1) {
            // The server remuxes at ~2× realtime: far seeks restart the session at the target.
            pauseStream(baseUrl, fileId, auth);
            setWaiting(true);
            setLoad((l) => ({ ...l, n: l.n + 1, at: Math.floor(tgt) }));
            return;
        }
        el.currentTime = local;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [duration, baseUrl, fileId]);

    // ─── Watch Together ───────────────────────────────────────────────────
    const pushBubble = useCallback((text: string, kind: Bubble["kind"]) => {
        const id = ++bubbleId.current;
        setBubbles((b) => [...b.slice(-10), { id, text, kind }]);
        window.setTimeout(() => setBubbles((b) => b.filter((x) => x.id !== id)), kind === "react" ? 3000 : 6000);
    }, []);
    const room = useRoomSync({
        hub, fileId, media: hubMedia, canLoad: !guest,
        getEl: () => videoRef.current,
        absTime: absNow,
        seekAbs,
        baseRate: () => rate,
        onChat: (c) => { if (panel !== "together") pushBubble(`${c.fromName}: ${c.text}`, "chat"); },
        onReaction: (r) => pushBubble(r.emoji, "react"),
    });
    const chat = useRoomChat(hub);
    useEffect(() => {
        if (!hub) return;
        return hub.errors.on((e) => flash(t(`together.${roomErrorKey(e)}`)));
    }, [hub, flash, t]);
    const joined = useRef(false);
    useEffect(() => {
        if (!hub || !props.joinRoomId || joined.current || chat.status !== "connected") return;
        joined.current = true;
        if (hub.room?.roomId !== props.joinRoomId) hub.joinRoom(props.joinRoomId);
    }, [hub, props.joinRoomId, chat.status]);

    // ─── transport ────────────────────────────────────────────────────────
    const play = useCallback(() => {
        const el = videoRef.current;
        if (!el) return;
        if (room.inRoom) { room.play(); return; }
        el.play().catch(() => undefined);
    }, [room]);
    const pause = useCallback(() => {
        const el = videoRef.current;
        if (!el) return;
        if (room.inRoom) { room.pause(); return; }
        el.pause();
    }, [room]);
    const togglePlay = useCallback(() => {
        const el = videoRef.current;
        if (!el) return;
        if (el.paused) play(); else pause();
    }, [play, pause]);
    const doSeek = useCallback((target: number) => {
        if (room.inRoom) room.seek(target); else seekAbs(target);
    }, [room, seekAbs]);
    const seekBy = useCallback((d: number) => doSeek(absNow() + d), [doSeek, absNow]);
    const setVolume = useCallback((v: number) => setVol({ v: Math.max(0, Math.min(1, Math.round(v * 100) / 100)), muted: false }), []);
    const toggleMute = useCallback(() => setVol((x) => ({ ...x, muted: !x.muted })), []);
    const toggleFullscreen = useCallback(() => {
        const root = rootRef.current;
        if (!root) return;
        if (document.fullscreenElement) { void document.exitFullscreen().catch(() => undefined); return; }
        if (root.requestFullscreen) { void root.requestFullscreen().catch(() => undefined); return; }
        // iOS Safari: only the <video> element can go fullscreen.
        const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
        v?.webkitEnterFullscreen?.();
    }, []);
    const [pipSupported, setPipSupported] = useState(false);
    useEffect(() => {
        const h = window.setTimeout(() => setPipSupported("pictureInPictureEnabled" in document && document.pictureInPictureEnabled), 0);
        return () => window.clearTimeout(h);
    }, []);
    const togglePip = useCallback(() => {
        const v = videoRef.current;
        if (!v) return;
        if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
        else void v.requestPictureInPicture().catch(() => flash(t("osd.pipFailed")));
    }, [flash, t]);
    const textSubs = useMemo(() => (info ? subtitleOrder(info.subtitleTracks) : []), [info]);
    const toggleSubs = useCallback(() => {
        if (subIdx >= 0) { lastSub.current = subIdx; setSubIdx(-1); flash(t("subs.offToast")); return; }
        const n = lastSub.current >= 0 ? lastSub.current : textSubs[0] ?? -1;
        if (n < 0) { flash(t("subs.none")); return; }
        setSubIdx(n);
        flash(t("subs.onToast", { name: subLabel(info, n, t("subs.track", { n: n + 1 }), t("subs.forced"), locale) }));
    }, [subIdx, textSubs, info, flash, t, locale]);
    const exitNow = useCallback(() => {
        const el = videoRef.current;
        if (el) el.pause();
        saveRef.current(true);
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        props.onExit();
    }, [props]);

    const switchAudio = useCallback((n: number) => {
        if (n === load.audio) return;
        flash(t("audio.switching"));
        pauseStream(baseUrl, fileId, auth);
        setLoad((l) => ({ n: l.n + 1, at: Math.floor(absNow()), audio: n }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load.audio, absNow, baseUrl, fileId, flash, t]);

    useEffect(() => {
        const el = videoRef.current;
        if (el && !room.inRoom) el.playbackRate = rate;
    }, [rate, room.inRoom, load]);

    // ─── OSD visibility ───────────────────────────────────────────────────
    const armHide = useCallback(() => {
        if (osdTimer.current) window.clearTimeout(osdTimer.current);
        osdTimer.current = window.setTimeout(() => {
            const el = videoRef.current;
            if (!el || el.paused) return;
            setOsd(false);
        }, OSD_IDLE_MS);
    }, []);
    const showOsd = useCallback(() => { setOsd(true); armHide(); }, [armHide]);
    useEffect(() => {
        if (!paused) armHide();
        return () => { if (osdTimer.current) window.clearTimeout(osdTimer.current); };
    }, [paused, armHide]);
    const osdVisible = osd || paused || panel !== null || !!error || remote !== null;

    // ─── next episode / up next / still watching / sleep ──────────────────
    const playNext = useCallback((auto: boolean) => {
        if (!props.onPlayNext) return;
        session.pendingAuto = auto;
        saveRef.current(true, true);
        props.onPlayNext();
    }, [props]);
    const autoAdvance = useCallback(() => {
        setCountdown(null);
        if (sleepMin < 0) { flash(t("settings.sleepDone")); exitNow(); return; }
        if (session.streak >= STILL_WATCHING_AFTER) {
            videoRef.current?.pause();
            setUpNext("dismissed");
            setStillAsk(true);
            return;
        }
        playNext(true);
    }, [sleepMin, exitNow, playNext, flash, t]);
    useEffect(() => {
        onEndedRef.current = () => {
            saveRef.current(true, true);
            if (nextUp && props.onPlayNext && prefs.autoplayNext && !room.inRoom && upNext !== "dismissed") { autoAdvance(); return; }
            if (room.inRoom || guest) return;
            exitNow();
        };
    });

    const upNextAt = nextUp && duration > 0 ? Math.min(markers.credits ?? Infinity, duration - UP_NEXT_LEAD_SEC) : Infinity;
    useEffect(() => {
        if (upNext === "hidden" && time >= upNextAt && time < duration - 0.5) {
            const h = window.setTimeout(() => {
                setUpNext("shown");
                setCountdown(prefs.autoplayNext && !room.inRoom && sleepMin >= 0 ? UP_NEXT_COUNTDOWN : null);
            }, 0);
            return () => window.clearTimeout(h);
        }
        if (upNext === "shown" && time < upNextAt - 5) {
            const h = window.setTimeout(() => { setUpNext("hidden"); setCountdown(null); }, 0);
            return () => window.clearTimeout(h);
        }
    }, [time, upNextAt, upNext, duration, prefs.autoplayNext, room.inRoom, sleepMin]);
    useEffect(() => {
        if (countdown === null || upNext !== "shown") return;
        const h = window.setTimeout(() => {
            if (countdown <= 0) autoAdvance(); else setCountdown((c) => (c === null ? null : c - 1));
        }, countdown <= 0 ? 0 : 1000);
        return () => window.clearTimeout(h);
    }, [countdown, upNext, autoAdvance]);

    const inRecap = inSpan(markers.recap, time) && !skipped.has("recap");
    const inIntro = inSpan(markers.intro, time) && !skipped.has("intro");
    const skipSpan = useMemo<{ key: "intro" | "recap"; span: Span } | null>(() => (
        inRecap && markers.recap ? { key: "recap", span: markers.recap }
        : inIntro && markers.intro ? { key: "intro", span: markers.intro }
        : null
    ), [inRecap, inIntro, markers.recap, markers.intro]);
    const creditsSkip = !nextUp && markers.credits !== null && duration > 0 && time >= markers.credits && time < duration - 3 && !skipped.has("credits");
    const doSkip = useCallback(() => {
        if (skipSpan) {
            setSkipped((s) => new Set(s).add(skipSpan.key));
            doSeek(skipSpan.span.end);
        } else if (creditsSkip) {
            setSkipped((s) => new Set(s).add("credits"));
            if (!room.inRoom && !guest) { saveRef.current(true, true); exitNow(); } else doSeek(Math.max(0, duration - 1));
        }
    }, [skipSpan, creditsSkip, doSeek, room.inRoom, guest, exitNow, duration]);
    const autoSkipKey = skipSpan?.key ?? null;
    useEffect(() => {
        if (!autoSkipKey || !skipSpan || !prefs.skipIntro || room.inRoom) return;
        const end = skipSpan.span.end;
        const h = window.setTimeout(() => {
            setSkipped((s) => new Set(s).add(autoSkipKey));
            doSeek(end);
            flash(autoSkipKey === "intro" ? t("osd.introSkipped") : t("osd.recapSkipped"));
        }, 0);
        return () => window.clearTimeout(h);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoSkipKey, prefs.skipIntro, room.inRoom]);

    useEffect(() => {
        if (sleepAt <= 0) return;
        const h = window.setTimeout(() => { flash(t("settings.sleepDone")); exitNow(); }, Math.max(0, sleepAt - Date.now()));
        return () => window.clearTimeout(h);
    }, [sleepAt, exitNow, flash, t]);
    const setSleep = (m: number) => {
        setSleepMin(m);
        setSleepAt(m > 0 ? Date.now() + m * 60_000 : 0);
        flash(m === 0 ? t("settings.sleepOffToast") : m < 0 ? t("settings.sleepEndToast") : t("settings.sleepSetToast", { count: m }));
    };

    // ─── sprite (lazy: first hover / drag on the scrub bar) ───────────────
    const spriteSrc = buildSpriteUrl(baseUrl, fileId, auth);
    useEffect(() => {
        if (sprite !== "loading") return;
        const img = new Image();
        let alive = true;
        let retry: number | null = null;
        img.onload = () => { if (alive) setSprite("ok"); };
        img.onerror = () => {
            if (!alive) return;
            setSprite("failed");
            retry = window.setTimeout(() => setSprite((s) => (s === "failed" ? "none" : s)), 30_000);
        };
        img.src = spriteSrc;
        return () => { alive = false; if (retry) window.clearTimeout(retry); };
    }, [sprite, spriteSrc]);

    // ─── remote (cast to TV from the player) ──────────────────────────────
    const enterRemote = useCallback((d: HubDevice) => {
        const el = videoRef.current;
        if (el) el.pause();
        saveRef.current(true);
        pauseStream(baseUrl, fileId, auth);
        setPanel(null);
        setRemote(d);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [baseUrl, fileId]);
    const remoteDev = remote && cast ? cast.remote.device(remote.deviceId) ?? remote : remote;
    const remoteNp = remoteDev?.nowPlaying ?? null;
    const remotePos = remoteNp ? remoteNp.positionSec + (remoteNp.playing ? Math.max(0, now - remoteNp.at) / 1000 : 0) : null;
    const remoteSend = useCallback(async (action: string, args: Record<string, unknown> = {}) => {
        if (!remote || !cast) return;
        try {
            const ack = await cast.remote.send(remote.deviceId, action, args);
            if (!ack || ack.ok === false) flash(t("remote.failed", { device: remote.name }));
        } catch {
            flash(t("remote.failed", { device: remote.name }));
        }
    }, [remote, cast, flash, t]);
    const leaveRemote = useCallback(() => {
        const pos = remotePos;
        setRemote(null);
        if (pos !== null && pos > 0) seekAbs(pos);
        window.setTimeout(() => videoRef.current?.play().catch(() => undefined), 50);
    }, [remotePos, seekAbs]);

    // ─── hub remote commands (this browser as a target) + playerBus ───────
    const onRemotePlay = props.onRemotePlay;
    const actions = useRef({ play, pause, togglePlay, doSeek, seekBy, setVolume, exitNow, playNext, onRemotePlay });
    useEffect(() => { actions.current = { play, pause, togglePlay, doSeek, seekBy, setVolume, exitNow, playNext, onRemotePlay }; });
    useEffect(() => {
        if (guest) return;
        const handle = (c: PlayerCommand): boolean => {
            const a = actions.current;
            switch (c.type) {
                case "pause": a.pause(); return true;
                case "resume": a.play(); return true;
                case "toggle": a.togglePlay(); return true;
                case "seek": a.doSeek(c.positionSec); return true;
                case "seekBy": a.seekBy(c.deltaSec); return true;
                case "stop": a.exitNow(); return true;
                case "next": a.playNext(false); return true;
                case "previous": a.doSeek(0); return true;
                case "rate": setRate(c.rate); return true;
                case "volume": a.setVolume(c.level > 1 ? c.level / 100 : c.level); return true;
            }
            return false;
        };
        const unsub = playerBus.subscribe(handle);
        const offCmd = hub?.commands.on((cmd) => {
            const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
            const pc: PlayerCommand | null =
                cmd.action === "pause" ? { type: "pause" }
                : cmd.action === "resume" ? { type: "resume" }
                : cmd.action === "play" && !cmd.args.fileId ? { type: "resume" }
                : cmd.action === "stop" ? { type: "stop" }
                : cmd.action === "next" ? { type: "next" }
                : cmd.action === "previous" ? { type: "previous" }
                : cmd.action === "seek" && n(cmd.args.positionSec) !== undefined ? { type: "seek", positionSec: n(cmd.args.positionSec)! }
                : cmd.action === "volume" && n(cmd.args.level) !== undefined ? { type: "volume", level: n(cmd.args.level)! }
                : null;
            if (!pc) {
                // `play` with a fileId is a new title: the route navigates to it.
                if (cmd.action === "play") {
                    const go = actions.current.onRemotePlay;
                    const ok = go ? go(cmd.args) : false;
                    hub.ack(cmd.seq, ok, ok ? undefined : "unsupported");
                    return;
                }
                hub.ack(cmd.seq, false, "unsupported");
                return;
            }
            hub.ack(cmd.seq, handle(pc));
        });
        return () => { unsub(); offCmd?.(); };
    }, [hub, guest]);

    // ─── keyboard ─────────────────────────────────────────────────────────
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && keyBelongsToControl(e.key, target.tagName, target.getAttribute("role"), target.isContentEditable)) return;
            const k = keyAction(e);
            if (!k) return;
            e.preventDefault();
            e.stopPropagation(); // the root layout's music shortcuts listen on document
            const a = actions.current;
            switch (k.type) {
                case "toggle": if (!remote) a.togglePlay(); break;
                case "seekBy": if (!remote) a.seekBy(k.delta); break;
                case "seekPercent": if (!remote && duration > 0) a.doSeek((duration * k.pct) / 100); break;
                case "volumeBy": setVol((x) => ({ v: Math.max(0, Math.min(1, Math.round((x.v + k.delta) * 100) / 100)), muted: false })); break;
                case "mute": toggleMute(); break;
                case "fullscreen": toggleFullscreen(); break;
                case "subtitles": toggleSubs(); break;
                case "back":
                    if (stillAsk) return;
                    if (panel) { setPanel(null); break; }
                    if (document.fullscreenElement) break; // the browser exits fullscreen itself
                    a.exitNow();
                    break;
            }
            if (k.type !== "back") showOsd();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [remote, duration, toggleMute, toggleFullscreen, toggleSubs, panel, stillAsk, showOsd]);

    // ─── pointer / touch on the stage ─────────────────────────────────────
    const onStagePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.pointerType === "mouse") {
            if (e.button !== 0) return;
            if (panel) { setPanel(null); return; }
            togglePlay();
            showOsd();
            return;
        }
        const r = e.currentTarget.getBoundingClientRect();
        const x = (e.clientX - r.left) / Math.max(1, r.width);
        const side: -1 | 0 | 1 = x < 0.33 ? -1 : x > 0.67 ? 1 : 0;
        const at = Date.now();
        if (side !== 0 && tap.current.side === side && at - tap.current.at < DOUBLE_TAP_MS) {
            tap.current = { at: 0, side: 0 };
            seekBy(side * 10);
            flash(side < 0 ? t("osd.rewound") : t("osd.forwarded"));
            return;
        }
        tap.current = { at, side };
        if (osdVisible && !paused && panel === null) { if (osdTimer.current) window.clearTimeout(osdTimer.current); setOsd(false); }
        else showOsd();
    };

    // ─── render ───────────────────────────────────────────────────────────
    const audioTracks = info?.audioTracks ?? [];
    const subsTracks = info?.subtitleTracks ?? [];
    const remaining = Math.max(0, duration - time);
    const VolIcon = vol.muted || vol.v === 0 ? VolumeX : vol.v < 0.5 ? Volume1 : Volume2;
    const roomCount = chat.room?.members.length ?? 0;
    const episodeLabel = nextUp ? t("upNext.label", { season: nextUp.season, episode: nextUp.episode }) : "";
    const marks = [markers.intro?.end, markers.credits].filter((m): m is number => typeof m === "number");

    return (
        <div
            ref={rootRef}
            className="mxp-root dark"
            data-osd={osdVisible || undefined}
            data-fit={fit}
            data-sub-size={subSize}
            data-sub-bg={subBg}
            onPointerMove={(e) => { if (e.pointerType === "mouse") showOsd(); }}
            role="region"
            aria-label={t("osd.region", { title: source.title })}
        >
            {source.backdropPath && (waiting || !!error) && (
                // eslint-disable-next-line @next/next/no-img-element -- decorative backdrop while the stream starts
                <img className="mxp-backdrop" src={tmdbImg(source.backdropPath, "w1280") ?? undefined} alt="" aria-hidden />
            )}
            <video ref={videoRef} className="mxp-video" playsInline preload="auto" aria-label={source.title} />
            <div className="mxp-stage" onPointerUp={onStagePointerUp} onDoubleClick={(e) => { if (e.target === e.currentTarget) toggleFullscreen(); }} aria-hidden />

            {cueLines.length > 0 && (
                <div className="mxp-cues" aria-live="off">
                    {cueLines.map((l, i) => <p key={i} className="mxp-cue">{l}</p>)}
                </div>
            )}

            {waiting && !error && !remote && (
                <div className="mxp-center" role="status">
                    <Loader2 aria-hidden className="mxp-spin size-12" />
                    <span className="sr-only">{t("osd.buffering")}</span>
                </div>
            )}
            {room.waiting && !error && <div className="mxp-room-wait" role="status">{t("together.waiting")}</div>}

            {error && (
                <div className="mxp-error" role="alert">
                    <p className="mxp-error-title">{t("errors.title")}</p>
                    <p className="mxp-error-body">{error}</p>
                    <div className="mxp-modal-actions">
                        <button type="button" className="mxp-btn mxp-btn-primary" onClick={() => { setError(null); setWaiting(true); setLoad((l) => ({ ...l, n: l.n + 1, at: Math.floor(absNow()) })); }}>{t("errors.retry")}</button>
                        <button type="button" className="mxp-btn" onClick={exitNow}>{t("errors.back")}</button>
                    </div>
                </div>
            )}

            {(skipSpan || creditsSkip) && !remote && upNext !== "shown" && (
                <button type="button" className="mxp-skip" onClick={doSkip}>
                    <SkipForward aria-hidden className="size-4" />
                    {skipSpan ? t(skipSpan.key === "intro" ? "osd.skipIntro" : "osd.skipRecap") : t("osd.skipCredits")}
                </button>
            )}

            <Bubbles items={bubbles} />

            {/* ── top bar ── */}
            <div className="mxp-top" data-mxp-keep>
                <button type="button" className="mxp-icon-btn" onClick={exitNow} aria-label={t("osd.back")}>
                    <ArrowLeft aria-hidden className="size-6" />
                </button>
                <div className="mxp-titles">
                    <h1 className="mxp-title">{source.title}</h1>
                    {source.subtitle && <p className="mxp-subtitle">{source.subtitle}</p>}
                </div>
                {sleepMin !== 0 && <span className="mxp-chip" title={t("settings.sleep")}><Moon aria-hidden className="size-3" />{sleepMin < 0 ? t("settings.sleepEndShort") : t("settings.sleepLeft", { count: Math.max(1, Math.ceil((sleepAt - now) / 60_000)) })}</span>}
                {hub && (
                    <button type="button" className="mxp-icon-btn" data-on={panel === "together" || undefined} onClick={() => setPanel(panel === "together" ? null : "together")}
                        aria-label={t("osd.together")} aria-expanded={panel === "together"}>
                        <Users aria-hidden className="size-5" />
                        {roomCount > 0 && <span className="mxp-badge" aria-hidden>{roomCount}</span>}
                    </button>
                )}
                {cast && !guest && (
                    <button type="button" className="mxp-icon-btn" data-on={panel === "cast" || undefined} onClick={() => setPanel(panel === "cast" ? null : "cast")}
                        aria-label={t("osd.cast")} aria-expanded={panel === "cast"}>
                        <Cast aria-hidden className="size-5" />
                    </button>
                )}
                <button type="button" className="mxp-icon-btn" data-on={panel === "info" || undefined} onClick={() => setPanel(panel === "info" ? null : "info")}
                    aria-label={t("osd.info")} aria-expanded={panel === "info"}>
                    <Info aria-hidden className="size-5" />
                </button>
            </div>

            {/* ── bottom controls ── */}
            {!remote && (
                <div className="mxp-bottom" data-mxp-keep>
                    <ScrubBar time={time} duration={duration} buffered={buffered} marks={marks}
                        spriteSrc={sprite === "ok" ? spriteSrc : null}
                        onWantSprite={() => { if (sprite === "none") setSprite("loading"); }}
                        onSeek={doSeek} />
                    <div className="mxp-controls">
                        <button type="button" className="mxp-icon-btn mxp-play" onClick={togglePlay} aria-label={paused ? t("osd.play") : t("osd.pause")}>
                            {paused ? <Play aria-hidden className="size-7" /> : <Pause aria-hidden className="size-7" />}
                        </button>
                        <button type="button" className="mxp-icon-btn" onClick={() => seekBy(-10)} aria-label={t("osd.rewind")}>
                            <RotateCcw aria-hidden className="size-5" />
                        </button>
                        <button type="button" className="mxp-icon-btn" onClick={() => seekBy(10)} aria-label={t("osd.forward")}>
                            <RotateCw aria-hidden className="size-5" />
                        </button>
                        <div className="mxp-volume">
                            <button type="button" className="mxp-icon-btn" onClick={toggleMute} aria-label={vol.muted ? t("osd.unmute") : t("osd.mute")}>
                                <VolIcon aria-hidden className="size-5" />
                            </button>
                            <input type="range" className="mxp-range" min={0} max={1} step={0.05} value={vol.muted ? 0 : vol.v}
                                onChange={(e) => setVolume(Number(e.target.value))} aria-label={t("osd.volume")}
                                aria-valuetext={t("osd.volumeValue", { percent: Math.round((vol.muted ? 0 : vol.v) * 100) })} />
                        </div>
                        <span className="mxp-time" aria-hidden>{formatTime(time)} / {formatTime(duration)}</span>
                        <span className="mxp-spacer" />
                        {duration > 0 && <span className="mxp-ends">{t("osd.endsAt", { time: format.dateTime(endsAtDate(remaining, rate, now), { hour: "2-digit", minute: "2-digit" }) })}</span>}
                        {nextUp && props.onPlayNext && (
                            <button type="button" className="mxp-icon-btn" onClick={() => playNext(false)} aria-label={t("osd.nextEpisode", { label: episodeLabel })}>
                                <SkipForward aria-hidden className="size-5" />
                            </button>
                        )}
                        <button type="button" className="mxp-icon-btn" data-on={subIdx >= 0 || undefined} onClick={() => setPanel(panel === "subs" ? null : "subs")}
                            aria-label={t("osd.subtitles")} aria-expanded={panel === "subs"}>
                            <Captions aria-hidden className="size-5" />
                        </button>
                        {audioTracks.length > 1 && (
                            <button type="button" className="mxp-icon-btn" onClick={() => setPanel(panel === "audio" ? null : "audio")}
                                aria-label={t("osd.audio")} aria-expanded={panel === "audio"}>
                                <AudioLines aria-hidden className="size-5" />
                            </button>
                        )}
                        <button type="button" className="mxp-icon-btn" onClick={() => setPanel(panel === "settings" ? null : "settings")}
                            aria-label={t("osd.settings")} aria-expanded={panel === "settings"}>
                            <Settings aria-hidden className="size-5" />
                        </button>
                        {pipSupported && (
                            <button type="button" className="mxp-icon-btn" onClick={togglePip} aria-label={t("osd.pip")}>
                                <PictureInPicture2 aria-hidden className="size-5" />
                            </button>
                        )}
                        <button type="button" className="mxp-icon-btn" onClick={toggleFullscreen} aria-label={fullscreen ? t("osd.exitFullscreen") : t("osd.fullscreen")}>
                            {fullscreen ? <Minimize aria-hidden className="size-5" /> : <Maximize aria-hidden className="size-5" />}
                        </button>
                    </div>
                </div>
            )}

            {/* ── remote mode ── */}
            {remote && (
                <div className="mxp-remote" data-mxp-keep>
                    <Cast aria-hidden className="size-10" />
                    <p className="mxp-remote-title">{t("remote.playingOn", { device: remoteDev?.name ?? remote.name })}</p>
                    <p className="mxp-muted" aria-live="polite">
                        {remoteNp ? `${formatTime(remotePos ?? 0)} / ${formatTime(remoteNp.durationSec ?? duration)}` : t("remote.waiting", { device: remote.name })}
                    </p>
                    <div className="mxp-remote-controls">
                        <button type="button" className="mxp-icon-btn" onClick={() => { void remoteSend("seek", { positionSec: Math.max(0, (remotePos ?? 0) - 10) }); }} aria-label={t("osd.rewind")}>
                            <RotateCcw aria-hidden className="size-6" />
                        </button>
                        <button type="button" className="mxp-icon-btn mxp-play" onClick={() => { void remoteSend(remoteNp?.playing ? "pause" : "resume"); }}
                            aria-label={remoteNp?.playing ? t("osd.pause") : t("osd.play")}>
                            {remoteNp?.playing ? <Pause aria-hidden className="size-8" /> : <Play aria-hidden className="size-8" />}
                        </button>
                        <button type="button" className="mxp-icon-btn" onClick={() => { void remoteSend("seek", { positionSec: (remotePos ?? 0) + 10 }); }} aria-label={t("osd.forward")}>
                            <RotateCw aria-hidden className="size-6" />
                        </button>
                        <button type="button" className="mxp-icon-btn" onClick={() => { void remoteSend("stop"); setRemote(null); }} aria-label={t("remote.stop")}>
                            <Square aria-hidden className="size-5" />
                        </button>
                    </div>
                    <button type="button" className="mxp-btn mxp-btn-primary" onClick={leaveRemote}>{t("remote.continueHere")}</button>
                </div>
            )}

            {/* ── panels ── */}
            {panel === "audio" && (
                <SidePanel title={t("audio.title")} onClose={() => setPanel(null)} labelledBy="mxp-p-audio">
                    <RadioList label={t("audio.title")} value={load.audio} onChange={switchAudio}
                        options={audioTracks.map((a, i) => ({
                            value: i,
                            label: a.title || langLabel(a.lang, locale) || t("audio.track", { n: i + 1 }),
                            hint: [a.codec?.toUpperCase(), channelsLabel(a.channels)].filter(Boolean).join(" · "),
                        }))} />
                </SidePanel>
            )}
            {panel === "subs" && (
                <SidePanel title={t("subs.title")} onClose={() => setPanel(null)} labelledBy="mxp-p-subs">
                    {textSubs.length === 0 && <p className="mxp-muted">{t("subs.none")}</p>}
                    <RadioList label={t("subs.title")} value={subIdx} onChange={(v) => { if (v >= 0) lastSub.current = v; setSubIdx(v); }}
                        options={[{ value: -1, label: t("subs.off") }, ...textSubs.map((i) => ({
                            value: i,
                            label: subLabel(info, i, t("subs.track", { n: i + 1 }), t("subs.forced"), locale),
                            hint: subsTracks[i]?.forced ? t("subs.forced") : undefined,
                        }))]} />
                    <RadioList<SubSize> label={t("subs.size")} value={subSize} onChange={setSubSize}
                        options={SUB_SIZES.map((s) => ({ value: s, label: t(`subs.sizes.${s}`) }))} />
                    <RadioList<SubBg> label={t("subs.bg")} value={subBg} onChange={setSubBg}
                        options={SUB_BGS.map((s) => ({ value: s, label: t(`subs.bgs.${s}`) }))} />
                </SidePanel>
            )}
            {panel === "settings" && (
                <SidePanel title={t("settings.title")} onClose={() => setPanel(null)} labelledBy="mxp-p-settings">
                    <RadioList label={t("settings.speed")} value={rate} onChange={(v) => setRate(v)}
                        options={SPEEDS.map((s) => ({ value: s, label: s === 1 ? t("settings.speedNormal") : `${format.number(s)}×` }))} />
                    <RadioList<Fit> label={t("settings.fit")} value={fit} onChange={setFit}
                        options={FITS.map((f) => ({ value: f, label: t(`settings.fits.${f}`) }))} />
                    <RadioList label={t("settings.sleep")} value={sleepMin} onChange={setSleep}
                        options={SLEEP_OPTIONS.map((m) => ({ value: m, label: m === 0 ? t("settings.sleepOff") : m < 0 ? t("settings.sleepEnd") : t("settings.sleepMin", { count: m }) }))} />
                    {props.versions && props.versions.length > 1 && props.onSwitchFile && (
                        <RadioList label={t("settings.versions")} value={fileId}
                            onChange={(id) => { if (id !== fileId) { saveRef.current(true); props.onSwitchFile?.(id, Math.floor(absNow())); } }}
                            options={props.versions.map((v) => ({ value: v.serverFileId, label: v.version?.label || fileName(v.path), hint: formatBytes(v.size, format) }))} />
                    )}
                </SidePanel>
            )}
            {panel === "info" && (
                <SidePanel title={t("info.title")} onClose={() => setPanel(null)} labelledBy="mxp-p-info">
                    <div className="mxp-info">
                        <p className="mxp-info-title">{source.title}</p>
                        {source.subtitle && <p className="mxp-muted">{source.subtitle}</p>}
                        {source.overview && <p className="mxp-info-overview">{source.overview}</p>}
                        <dl className="mxp-dl">
                            <dt>{t("info.duration")}</dt><dd>{duration > 0 ? formatTime(duration) : "—"}</dd>
                            <dt>{t("info.video")}</dt><dd>{[info?.videoCodec?.toUpperCase(), resolutionLabel(info?.width, info?.height)].filter(Boolean).join(" · ") || "—"}</dd>
                            <dt>{t("info.hdr")}</dt><dd>{info?.hdr && info.hdr !== "sdr" ? info.hdr.toUpperCase() : t("info.sdr")}</dd>
                            <dt>{t("info.audio")}</dt><dd>{audioTracks[load.audio] ? [audioTracks[load.audio]!.codec?.toUpperCase(), channelsLabel(audioTracks[load.audio]!.channels), langLabel(audioTracks[load.audio]!.lang, locale)].filter(Boolean).join(" · ") : "—"}</dd>
                            <dt>{t("info.bitrate")}</dt><dd>{bitrateLabel(info?.sizeBytes, info?.durationSec) || "—"}</dd>
                            <dt>{t("info.subtitles")}</dt><dd>{t("info.subCount", { count: textSubs.length })}</dd>
                            <dt>{t("info.file")}</dt><dd className="mxp-break">{fileName(info?.path ?? source.path ?? "") || "—"}</dd>
                        </dl>
                        <p className="mxp-muted">{t("info.original")}</p>
                    </div>
                </SidePanel>
            )}
            {panel === "together" && hub && (
                <SidePanel title={t("together.title")} onClose={() => setPanel(null)} labelledBy="mxp-p-together">
                    <TogetherPanel hub={hub} room={chat.room} status={chat.status} lines={chat.lines} canCreate={!guest}
                        serverBaseUrl={baseUrl} mediaSec={absNow} notify={flash} />
                </SidePanel>
            )}
            {panel === "cast" && cast && (
                <SidePanel title={t("cast.title")} onClose={() => setPanel(null)} labelledBy="mxp-p-cast">
                    <cast.Picker fileId={fileId} positionSec={Math.floor(time)} onSent={enterRemote} />
                </SidePanel>
            )}

            {upNext === "shown" && nextUp && !remote && (
                <UpNextCard name={nextUp.name} label={episodeLabel} stillUrl={props.nextUpStill ?? null} countdown={countdown}
                    onPlay={() => playNext(false)} onCancel={() => { setUpNext("dismissed"); setCountdown(null); }} />
            )}
            {stillAsk && (
                <StillWatching
                    onContinue={() => { session.streak = 0; setStillAsk(false); playNext(false); }}
                    onExit={() => { setStillAsk(false); exitNow(); }} />
            )}

            {toast && <div className="mxp-toast" role="status" aria-live="polite">{toast}</div>}
        </div>
    );
}

type Fmt = ReturnType<typeof useFormatter>;

function langLabel(lang: string | null | undefined, locale: string): string {
    const code = normLang(lang);
    if (!code) return "";
    try {
        return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code.toUpperCase();
    } catch {
        return code.toUpperCase();
    }
}

function subLabel(info: FileInfo | null, i: number, fallback: string, forced: string, locale: string): string {
    const s = info?.subtitleTracks[i];
    if (!s) return fallback;
    const base = s.title || langLabel(s.lang, locale) || fallback;
    return s.forced && !/forc/i.test(base) ? `${base} (${forced})` : base;
}

function fileName(p: string): string {
    return p.split(/[\\/]/).pop() ?? p;
}

function formatBytes(n: number, format: Fmt): string {
    if (!n) return "";
    const gb = n / 1024 ** 3;
    return gb >= 1 ? `${format.number(gb, { maximumFractionDigits: 1 })} GB` : `${format.number(n / 1024 ** 2, { maximumFractionDigits: 0 })} MB`;
}
