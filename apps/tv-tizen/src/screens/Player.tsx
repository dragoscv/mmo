/**
 * Player (WP15 playback + WP16-32 OSD / skip / up next / Watch Together).
 *
 * Playback (unchanged WP15 rules): direct play when `lib/playback.ts` allows it, else HLS `q=original`+caps
 * started AT the resume position (`?start=`; the element clock is relative → `offsetRef`), `pauseStream` on
 * pause/unmount, progress via `reportProgress`. Audio track switching on HLS restarts the session with
 * `audio=<n>` at the current absolute position (server 3.7: one audio track per HLS stream); direct play uses
 * `video.audioTracks` when the engine exposes it, else falls back to HLS with `audio=<n>`.
 *
 * Keys: hidden OSD → OK toggles play (or skips intro when the pill is up), ←/→ seek with hold acceleration
 * (10 → 30 → 60 s) + sprite preview, ↑/↓ open the OSD. Visible OSD → D-pad moves focus inside its scope,
 * ←/→ on the scrub bar scrub, Back hides it; Back again exits. Overlays (panels, Up Next, dialogs) own
 * D-pad + Back while open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type Hls from "hls.js";
import type { MmoClient } from "../lib/api";
import type { ServerConfig } from "../lib/config";
import { focusEl } from "../lib/focus";
import { fmtClock } from "../lib/format";
import { ServerHttp } from "../lib/http";
import type { MediaClient } from "../lib/media";
import { canDirectPlayOnTizen, isHlsNative, TIZEN_CAPS } from "../lib/playback";
import { playerBus } from "../lib/player-bus";
import { getProgress } from "../lib/progress";
import { reportProgress, type TitleRef } from "../lib/progress-sync";
import { useScreenFormat, videoBox, type ScreenFormatKey } from "../lib/screen-format";
import { keyFromEvent } from "../lib/tv-keys";
import { t } from "../i18n/messages";
import { consumeBack } from "../nav/back";
import type { ScreenCtx } from "../nav/ctx";
import { useNav } from "../nav/Nav";
import type { PlayItem } from "../nav/routes";
import { Dialog, SidePanel, useFocusScope, type SidePanelItem } from "../ui";
import {
    episodeName, fetchChapters, fetchCredits, fetchSpan, hubMediaOf, NO_MARKERS, resolveNextEpisode,
    type Markers, type NextEpisode, type Span,
} from "./player/data";
import {
    bitrateLabel, channelsLabel, endsAt, HOLD_GAP_MS, pickAudio, pickSubtitle, resolutionLabel, seekStep, spriteGrid,
    subtitleOrder,
} from "./player/model";
import { Osd, type OsdButton } from "./player/Osd";
import { Bubbles, InfoSheet, UpNextCard, type Bubble } from "./player/Panels";
import { langName } from "./player/prefs";
import { usePlayerPrefs } from "./player/usePlayerPrefs";
import { useRoomSync } from "./player/useRoomSync";
import { activeCues, parseVtt, type Cue } from "./player/vtt";
import { platformKind } from "../platform";
import "./player/player.css";

export type { PlayItem };

interface Props {
    client: MmoClient;
    media?: MediaClient | null;
    item: PlayItem;
    queue?: PlayItem[];
    index?: number;
    onExit: () => void;
    /** False while a keep-alive screen above covers the player (keys go elsewhere). Default true. */
    active?: boolean;
    /** Full screen context (hub, profiles, cfg). Optional for back-compat; without it Watch Together,
     *  profile prefs and the profile-scoped data stay off. */
    ctx?: ScreenCtx | null;
}

const OSD_TIMEOUT = 4000;
const SCRUB_COMMIT_MS = 700;
const UP_NEXT_LEAD_SEC = 30;
const UP_NEXT_COUNTDOWN = 10;
const STILL_WATCHING_AFTER = 3;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const FORMATS: ScreenFormatKey[] = ["auto", "16:9", "21:9", "32:9"];
const SLEEP_OPTIONS = [0, 15, 30, 60, -1];

/** Survives the player switching to the next episode (Android `PlaybackSession`). */
const session = { streak: 0, pendingAuto: false };

type Panel = "audio" | "subs" | "subStyle" | "speed" | "format" | "sleep" | "info" | null;
type Mode = "direct" | "hls" | "audio";
interface Load { n: number; at: number | null; audio: number; forceHls: boolean }

/** `{baseUrl, token, userId}` from the client's own media URL (used when no ctx is passed). */
function cfgFromClient(client: MmoClient): ServerConfig {
    const u = client.directUrl("x");
    const m = /^(https?:\/\/[^/]+)\/video\/direct\/x\?(.*)$/.exec(u);
    const q = new URLSearchParams(m?.[2] ?? "");
    return { baseUrl: m?.[1] ?? "", token: q.get("t") ?? "", userId: q.get("u") ?? "" };
}

/** Query of an HLS URL without auth params (safe to expose for device inspection). */
function publicQuery(url: string): string {
    const q = new URLSearchParams(url.split("?")[1] ?? "");
    q.delete("t");
    q.delete("u");
    return q.toString();
}

function inSpan(s: Span | null, tSec: number): boolean { return !!s && tSec >= s.start && tSec < s.end - 1; }

export function PlayerScreen({ client, media = null, item, queue, index, onExit, active = true, ctx = null }: Props) {
    const nav = useNav();
    const hub = ctx?.hub ?? null;
    const mediaRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<Hls | null>(null);
    const osdRef = useRef<HTMLDivElement>(null);
    const http = useMemo(() => new ServerHttp(ctx?.cfg ?? cfgFromClient(client)), [ctx, client]);
    const prefs = usePlayerPrefs(ctx, media, http);

    const initialAudio = item.kind === "video" ? pickAudio(item.video, prefs) : 0;
    const [cur, setCur] = useState<PlayItem>(item);
    const [refOverride, setRefOverride] = useState<TitleRef | null>(null);
    const [qIndex, setQIndex] = useState(index ?? 0);
    const [load, setLoad] = useState<Load>({ n: 0, at: null, audio: initialAudio, forceHls: false });
    const [time, setTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [buffered, setBuffered] = useState(0);
    const [paused, setPaused] = useState(false);
    const [osd, setOsd] = useState(true);
    const [osdFocus, setOsdFocus] = useState<{ key: string; n: number } | null>({ key: "osd:play", n: 0 });
    const [panel, setPanel] = useState<Panel>(null);
    const [error, setError] = useState<string | null>(null);
    const [mode, setMode] = useState<Mode>("direct");
    const [hlsQuery, setHlsQuery] = useState("");
    const [subIdx, setSubIdx] = useState(() => (item.kind === "video" ? pickSubtitle(item.video, prefs, initialAudio) : -1));
    const [cues, setCues] = useState<Cue[]>([]);
    const [subSize, setSubSize] = useState(prefs.subSize);
    const [subBg, setSubBg] = useState(prefs.subBg);
    useEffect(() => { setSubSize(prefs.subSize); setSubBg(prefs.subBg); }, [prefs]);
    const [rate, setRate] = useState(1);
    const [videoAspect, setVideoAspect] = useState(0);
    const [fmt, setFmt, squeeze] = useScreenFormat();
    const [pending, setPending] = useState<number | null>(null);
    const [markers, setMarkers] = useState<Markers>(NO_MARKERS);
    const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
    const [nextEp, setNextEp] = useState<NextEpisode | null>(null);
    const [epName, setEpName] = useState<string | null>(null);
    const [upNext, setUpNext] = useState<"hidden" | "shown" | "dismissed">("hidden");
    const [countdown, setCountdown] = useState<number | null>(null);
    const [stillAsk, setStillAsk] = useState(false);
    const [sleepMin, setSleepMin] = useState(0);
    const [sleepAt, setSleepAt] = useState(0);
    const [sprite, setSprite] = useState<"none" | "loading" | "ok" | "failed">("none");
    const [toast, setToast] = useState<string | null>(null);
    const [bubbles, setBubbles] = useState<Bubble[]>([]);

    const osdTimer = useRef<number | null>(null);
    const toastTimer = useRef<number | null>(null);
    /** HLS sessions start at `?start=<sec>`; the element's time is relative to it. */
    const offsetRef = useRef(0);
    const modeRef = useRef<Mode>("direct");
    modeRef.current = mode;
    const scrubTimer = useRef<number | null>(null);
    const hold = useRef({ at: 0, count: 0 });
    const bubbleId = useRef(0);
    const wasPlayingWhenCovered = useRef(false);

    const video = cur.kind === "video" ? cur.video : null;
    const song = cur.kind === "audio" ? cur.song : null;
    const subs = video?.subtitleTracks ?? [];
    const titleRef: TitleRef | null = refOverride ?? (cur.kind === "video" ? cur.ref ?? null : null);
    const fileId = video?.fileId ?? null;

    const absTime = useCallback((el: HTMLMediaElement) => offsetRef.current + el.currentTime, []);
    const absDuration = (el: HTMLMediaElement) =>
        offsetRef.current > 0 || modeRef.current === "hls"
            ? (video?.durationSec ?? (Number.isFinite(el.duration) ? offsetRef.current + el.duration : 0))
            : (Number.isFinite(el.duration) ? el.duration : (video?.durationSec ?? 0));
    const save = (el: HTMLMediaElement, force: boolean) => {
        if (!video) return;
        reportProgress(media, video.fileId, titleRef, absTime(el), absDuration(el), force);
    };

    const flash = useCallback((msg: string) => {
        setToast(msg);
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), 3500);
    }, []);

    // ─── OSD visibility ─────────────────────────────────────────────────
    const armHide = useCallback(() => {
        if (osdTimer.current) window.clearTimeout(osdTimer.current);
        osdTimer.current = window.setTimeout(() => {
            const el = mediaRef.current;
            if (el && el.paused) return; // stays up while paused
            setOsd(false);
        }, OSD_TIMEOUT);
    }, []);
    const showOsd = useCallback((focusKey: string | null = null) => {
        setOsd(true);
        if (focusKey) setOsdFocus((f) => ({ key: focusKey, n: (f?.n ?? 0) + 1 }));
        armHide();
    }, [armHide]);
    const hideOsd = useCallback(() => {
        if (osdTimer.current) window.clearTimeout(osdTimer.current);
        setOsd(false);
    }, []);

    // ─── Source setup ───────────────────────────────────────────────────
    useEffect(() => {
        const el = mediaRef.current;
        if (!el) return;
        let cancelled = false;
        setError(null);
        offsetRef.current = 0;

        // Resume: explicit restart point (seek/audio switch) > server position from Title > local store (≥ 10 s).
        const savedAt = cur.kind === "video" ? (cur.resumeSec && cur.resumeSec > 10 ? cur.resumeSec : (getProgress(cur.video.fileId)?.pos ?? 0)) : 0;
        const resumeAt = load.at ?? savedAt;
        const onMeta = () => {
            if (resumeAt > 0 && Number.isFinite(el.duration) && resumeAt < el.duration - 5) el.currentTime = resumeAt;
            // Direct play with a non-default audio track: the engine's AudioTrackList, else HLS with audio=<n>.
            if (cur.kind === "video" && load.audio > 0 && modeRef.current === "direct") {
                const list = (el as HTMLVideoElement & { audioTracks?: { length: number; [i: number]: { enabled: boolean } } }).audioTracks;
                if (list && list.length > load.audio) {
                    for (let i = 0; i < list.length; i++) list[i]!.enabled = i === load.audio;
                } else {
                    setLoad((l) => ({ ...l, n: l.n + 1, at: el.currentTime, forceHls: true }));
                }
            }
        };
        el.addEventListener("loadedmetadata", onMeta, { once: true });

        const teardown = () => {
            if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
            el.removeEventListener("loadedmetadata", onMeta);
            el.removeAttribute("src");
            el.load();
        };

        (async () => {
            if (cur.kind === "audio") {
                setMode("audio");
                modeRef.current = "audio";
                el.src = client.streamUrl(cur.song.id);
                await el.play().catch(() => undefined);
                return;
            }
            const v = cur.video;
            if (canDirectPlayOnTizen(v) && !load.forceHls) {
                setMode("direct");
                modeRef.current = "direct";
                setHlsQuery("");
                el.src = client.directUrl(v.fileId);
                await el.play().catch(() => undefined);
                return;
            }
            setMode("hls");
            modeRef.current = "hls";
            el.removeEventListener("loadedmetadata", onMeta);
            const startSec = resumeAt > 0 ? Math.floor(resumeAt) : 0;
            offsetRef.current = startSec;
            const url = client.hlsUrl(v.fileId, { caps: TIZEN_CAPS, quality: "original", startSec }) + (load.audio > 0 ? `&audio=${load.audio}` : "");
            setHlsQuery(publicQuery(url));
            if (isHlsNative(el)) {
                // Tizen's native player starts an EVENT playlist (ffmpeg still writing) near its live edge —
                // measured 40 s past `start` on the Odyssey. The session starts AT the wanted position, so pin
                // element time 0 once metadata is in.
                const pin = () => { if (el.currentTime > 1.5) el.currentTime = 0; };
                el.addEventListener("loadedmetadata", pin, { once: true });
                el.addEventListener("playing", pin, { once: true });
                el.src = url;
                await el.play().catch(() => undefined);
                return;
            }
            const { default: HlsCtor, FetchLoader } = await import("hls.js");
            if (cancelled) return;
            if (!HlsCtor.isSupported()) { setError(t("player.errMse")); return; }
            const hls = new HlsCtor({
                // The server playlist is EVENT while ffmpeg is still writing; keep polling.
                liveDurationInfinity: false,
                maxBufferLength: 60,
                backBufferLength: 30,
                enableWorker: false, // Tizen workers + blob URLs are flaky on older firmware
                startPosition: 0,
                // Desktop (Tauri): fetch is routed through the native HTTP client (LAN http, no CORS) — XHR is not.
                ...(platformKind() === "desktop" ? { loader: FetchLoader } : {}),
            });
            hlsRef.current = hls;
            hls.on(HlsCtor.Events.ERROR, (_e, data) => {
                if (data.fatal) setError(`HLS: ${data.type} / ${data.details}`);
            });
            hls.loadSource(url);
            hls.attachMedia(el);
            hls.on(HlsCtor.Events.MANIFEST_PARSED, () => { el.play().catch(() => undefined); });
        })().catch((e: Error) => setError(e.message));

        return () => {
            cancelled = true;
            if (cur.kind === "video") {
                save(el, true);
                client.pauseStream(cur.video.fileId);
            }
            teardown();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cur, client, load]);

    // ─── Media events ───────────────────────────────────────────────────
    useEffect(() => {
        const el = mediaRef.current;
        if (!el) return;
        const onTime = () => {
            setTime(absTime(el));
            save(el, false);
            const b = el.buffered;
            for (let i = 0; i < b.length; i++) {
                if (b.start(i) <= el.currentTime + 0.5 && el.currentTime <= b.end(i)) { setBuffered(offsetRef.current + b.end(i)); break; }
            }
        };
        const onDur = () => setDuration(absDuration(el));
        const onSize = () => { if (el.videoWidth > 0 && el.videoHeight > 0) setVideoAspect(el.videoWidth / el.videoHeight); };
        const onPlay = () => setPaused(false);
        const onPause = () => {
            setPaused(true);
            save(el, true);
        };
        const onEnded = () => onEndedRef.current();
        const onErr = () => {
            const code = el.error?.code;
            setError(code === 4 ? t("player.errFormat") : t("player.errMedia", { code: code ?? "?" }));
            // Native HLS reports any HTTP failure as "format error": ask the server for the real cause.
            const src = el.currentSrc;
            if (code === 4 && src) {
                fetch(src, { cache: "no-store" }).then(async (r) => {
                    if (r.ok) return;
                    const j = (await r.json().catch(() => null)) as { code?: string; error?: string } | null;
                    setError(j?.code === "file_missing" ? t("player.errMissing") : t("player.errServer", { msg: j?.error ?? String(r.status) }));
                }).catch(() => setError(t("player.errNetwork")));
            }
        };
        el.addEventListener("timeupdate", onTime);
        el.addEventListener("durationchange", onDur);
        el.addEventListener("loadedmetadata", onDur);
        el.addEventListener("loadedmetadata", onSize);
        el.addEventListener("resize", onSize);
        el.addEventListener("play", onPlay);
        el.addEventListener("pause", onPause);
        el.addEventListener("ended", onEnded);
        el.addEventListener("error", onErr);
        return () => {
            el.removeEventListener("timeupdate", onTime);
            el.removeEventListener("durationchange", onDur);
            el.removeEventListener("loadedmetadata", onDur);
            el.removeEventListener("loadedmetadata", onSize);
            el.removeEventListener("resize", onSize);
            el.removeEventListener("play", onPlay);
            el.removeEventListener("pause", onPause);
            el.removeEventListener("ended", onEnded);
            el.removeEventListener("error", onErr);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cur, mode]);

    // Keep the user rate across source reloads (rooms force 1; useRoomSync restores baseRate on leave).
    useEffect(() => {
        const el = mediaRef.current;
        if (el && !roomRef.current) el.playbackRate = rate;
    }, [rate, load, cur]);

    // ─── Per-item data: markers, next episode, episode name ─────────────
    useEffect(() => {
        setMarkers(NO_MARKERS);
        setSkipped(new Set());
        setNextEp(null);
        setEpName(null);
        setUpNext("hidden");
        setCountdown(null);
        setSprite("none");
        if (!video) return;
        let alive = true;
        const id = video.fileId;
        void Promise.all([
            fetchSpan(http, "intro", id), fetchSpan(http, "recap", id), fetchCredits(http, id), fetchChapters(http, id),
        ]).then(([intro, recap, credits, chapters]) => { if (alive) setMarkers({ intro, recap, credits, chapters }); });
        if (media && titleRef) {
            void resolveNextEpisode(media, client, titleRef).then((n) => { if (alive) setNextEp(n); });
            void episodeName(media, titleRef).then((n) => { if (alive) setEpName(n); });
        }
        // Autoplay streak for "Still watching?".
        if (session.pendingAuto) { session.streak += 1; session.pendingAuto = false; } else session.streak = 0;
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cur]);

    // ─── Subtitles: custom renderer (see player/vtt.ts for why not ::cue) ─
    useEffect(() => {
        setCues([]);
        if (!video || subIdx < 0) return;
        let alive = true;
        // First request per file makes the server extract every text track in one ffmpeg pass (measured 180 s
        // for 55 tracks on a 4K remux); say so instead of looking broken.
        const slow = window.setTimeout(() => { if (alive) flash(t("pl.subLoading")); }, 1500);
        fetch(client.subtitleUrl(video.fileId, subIdx), { cache: "force-cache" })
            .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
            .then((txt) => { if (alive) setCues(parseVtt(txt)); })
            .catch(() => { if (alive) flash(t("pl.subError")); })
            .finally(() => window.clearTimeout(slow));
        return () => { alive = false; window.clearTimeout(slow); };
    }, [video, subIdx, client, flash]);

    // ─── Seeking ────────────────────────────────────────────────────────
    const seekAbs = useCallback((target: number) => {
        const el = mediaRef.current;
        if (!el || !video && cur.kind !== "audio") return;
        const total = absDuration(el);
        const tgt = Math.max(0, Math.min((total > 0 ? total : Infinity) - 0.5, target));
        if (modeRef.current === "hls") {
            // The server reads at 2x realtime, so far seeks may land past what it has produced:
            // restart the session at the target instead of stalling.
            const local = tgt - offsetRef.current;
            const s = el.seekable;
            const end = s.length > 0 ? s.end(s.length - 1) : 0;
            if (local < 0 || local > end - 1) {
                if (video) client.pauseStream(video.fileId);
                setLoad((l) => ({ ...l, n: l.n + 1, at: Math.floor(tgt) }));
                return;
            }
            el.currentTime = local;
            return;
        }
        el.currentTime = tgt;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, video, cur]);

    // ─── Watch Together ─────────────────────────────────────────────────
    const pushBubble = useCallback((text: string, kind: Bubble["kind"]) => {
        const id = ++bubbleId.current;
        setBubbles((b) => [...b.slice(-12), { id, text, kind }]);
        window.setTimeout(() => setBubbles((b) => b.filter((x) => x.id !== id)), kind === "react" ? 3000 : 6000);
    }, []);
    const room = useRoomSync({
        hub,
        fileId,
        media: video ? hubMediaOf(video, titleRef) : null,
        getEl: () => mediaRef.current,
        absTime: () => (mediaRef.current ? absTime(mediaRef.current) : 0),
        seekAbs,
        baseRate: () => rate,
        onChat: (c) => pushBubble(`${c.fromName}: ${c.text}`, "chat"),
        onReaction: (r) => pushBubble(r.emoji, "react"),
    });
    const roomRef = useRef(false);
    roomRef.current = room.inRoom;

    // ─── Transport ──────────────────────────────────────────────────────
    const togglePlay = useCallback(() => {
        const el = mediaRef.current;
        if (!el) return;
        if (room.inRoom) { if (el.paused) room.play(); else room.pause(); return; }
        if (el.paused) el.play().catch(() => undefined);
        else { el.pause(); if (video) client.pauseStream(video.fileId); }
    }, [client, video, room]);

    const doSeek = useCallback((target: number) => {
        if (room.inRoom) room.seek(target); else seekAbs(target);
    }, [room, seekAbs]);

    const seekBy = useCallback((delta: number) => {
        const el = mediaRef.current;
        if (el) doSeek(absTime(el) + delta);
    }, [doSeek, absTime]);

    /** Hold-accelerated scrub: accumulate a pending target, commit after a pause in the key repeats. */
    const scrub = useCallback((dir: 1 | -1) => {
        const el = mediaRef.current;
        if (!el) return;
        const now = Date.now();
        hold.current = now - hold.current.at < HOLD_GAP_MS ? { at: now, count: hold.current.count + 1 } : { at: now, count: 0 };
        const step = seekStep(hold.current.count);
        const total = absDuration(el);
        setPending((p) => {
            const base = p ?? absTime(el);
            return Math.max(0, Math.min(total > 0 ? total - 1 : Infinity, base + dir * step));
        });
        if (video && sprite === "none") setSprite("loading");
        if (scrubTimer.current) window.clearTimeout(scrubTimer.current);
        scrubTimer.current = window.setTimeout(() => commitScrubRef.current(), SCRUB_COMMIT_MS);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [absTime, video, sprite]);

    const pendingRef = useRef<number | null>(null);
    pendingRef.current = pending;
    const commitScrub = useCallback(() => {
        if (scrubTimer.current) { window.clearTimeout(scrubTimer.current); scrubTimer.current = null; }
        const target = pendingRef.current;
        if (target === null) return;
        setPending(null);
        doSeek(target);
    }, [doSeek]);
    const commitScrubRef = useRef(commitScrub);
    commitScrubRef.current = commitScrub;

    // Sprite: requested lazily on the first scrub (the server builds it in its idle analysis queue).
    const spriteUrl = video ? client.spriteUrl(video.fileId) : null;
    const grid = useMemo(() => spriteGrid(video?.durationSec ?? duration), [video, duration]);
    useEffect(() => {
        if (sprite !== "loading" || !spriteUrl) return;
        const img = new Image();
        let alive = true;
        img.onload = () => { if (alive) setSprite("ok"); };
        img.onerror = () => {
            if (!alive) return;
            setSprite("failed");
            // 503 while the server builds it → allow another try after 30 s.
            window.setTimeout(() => setSprite((s) => (s === "failed" ? "none" : s)), 30_000);
        };
        img.src = spriteUrl;
        return () => { alive = false; };
    }, [sprite, spriteUrl]);

    // ─── Queue / next episode ───────────────────────────────────────────
    const playItem = useCallback((it: PlayItem, ref: TitleRef | null) => {
        setRefOverride(ref);
        setCur(it);
        setPending(null);
        setPanel(null);
        setStillAsk(false);
        const a = it.kind === "video" ? pickAudio(it.video, prefs) : 0;
        setLoad((l) => ({ n: l.n + 1, at: null, audio: a, forceHls: false }));
        setSubIdx(it.kind === "video" ? pickSubtitle(it.video, prefs, a) : -1);
        setTime(0);
        setDuration(0);
        setBuffered(0);
    }, [prefs]);

    const playNextEpisode = useCallback(async (auto: boolean) => {
        const n = nextEp;
        if (!n || !titleRef) return false;
        try {
            const v = await client.resolveVideo(n.fileId, n.path);
            session.pendingAuto = auto;
            playItem({ kind: "video", video: v, ref: { ...titleRef, season: n.season, episode: n.episode } }, { ...titleRef, season: n.season, episode: n.episode });
            return true;
        } catch (e) {
            flash(t("pl.nextError", { message: (e as Error).message }));
            return false;
        }
    }, [nextEp, titleRef, client, playItem, flash]);

    const next = useCallback(() => {
        if (queue && qIndex + 1 < queue.length) {
            const n = qIndex + 1;
            setQIndex(n);
            playItem(queue[n]!, null);
            return;
        }
        if (nextEp) { void playNextEpisode(false); return; }
        onExit();
    }, [queue, qIndex, onExit, nextEp, playNextEpisode, playItem]);

    const prev = useCallback(() => {
        const el = mediaRef.current;
        if (queue && qIndex > 0 && el && absTime(el) < 3) {
            const n = qIndex - 1;
            setQIndex(n);
            playItem(queue[n]!, null);
        } else if (el) {
            doSeek(0);
        }
    }, [queue, qIndex, absTime, doSeek, playItem]);

    const exitNow = useCallback(() => {
        const el = mediaRef.current;
        if (el) { el.pause(); save(el, true); }
        onExit();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onExit]);

    /** Autoplay (countdown end / ended): asks "Still watching?" after 3 unattended autoplays. */
    const autoAdvance = useCallback(() => {
        setCountdown(null);
        if (sleepMin < 0) { exitNow(); return; }
        if (session.streak >= STILL_WATCHING_AFTER) {
            mediaRef.current?.pause();
            setUpNext("dismissed");
            setStillAsk(true);
            return;
        }
        void playNextEpisode(true);
    }, [sleepMin, exitNow, playNextEpisode]);

    const onEndedRef = useRef<() => void>(() => undefined);
    onEndedRef.current = () => {
        if (queue && qIndex + 1 < queue.length) { next(); return; }
        if (nextEp && prefs.autoplayNext && !room.inRoom && upNext !== "dismissed") { autoAdvance(); return; }
        exitNow();
    };

    // Up Next: from the credits marker (else 30 s before the end) when a next episode exists.
    const upNextAt = nextEp && duration > 0 ? Math.min(markers.credits ?? Infinity, duration - UP_NEXT_LEAD_SEC) : Infinity;
    useEffect(() => {
        if (upNext === "hidden" && time >= upNextAt && time < duration - 0.5) {
            setUpNext("shown");
            setCountdown(prefs.autoplayNext && !room.inRoom && sleepMin >= 0 ? UP_NEXT_COUNTDOWN : null);
            hideOsd();
        }
        if (upNext === "shown" && time < upNextAt - 5) { setUpNext("hidden"); setCountdown(null); }
    }, [time, upNextAt, upNext, duration, prefs.autoplayNext, room.inRoom, sleepMin, hideOsd]);
    useEffect(() => {
        if (countdown === null || upNext !== "shown") return;
        if (countdown <= 0) { autoAdvance(); return; }
        const h = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
        return () => window.clearTimeout(h);
    }, [countdown, upNext, autoAdvance]);

    // ─── Skip intro / recap ─────────────────────────────────────────────
    const skipSpan: { key: string; span: Span; label: string } | null =
        inSpan(markers.recap, time) && !skipped.has("recap") ? { key: "recap", span: markers.recap!, label: t("pl.skipRecap") }
        : inSpan(markers.intro, time) && !skipped.has("intro") ? { key: "intro", span: markers.intro!, label: t("pl.skipIntro") }
        : null;
    const doSkip = useCallback(() => {
        if (!skipSpan) return;
        setSkipped((s) => new Set(s).add(skipSpan.key));
        doSeek(skipSpan.span.end);
    }, [skipSpan, doSeek]);
    // Auto-skip (profile pref), solo playback only.
    useEffect(() => {
        if (!skipSpan || !prefs.skipIntro || room.inRoom) return;
        setSkipped((s) => new Set(s).add(skipSpan.key));
        doSeek(skipSpan.span.end);
        flash(skipSpan.key === "intro" ? t("pl.introSkipped") : t("pl.recapSkipped"));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [skipSpan?.key, prefs.skipIntro, room.inRoom]);
    // The pill takes focus when it appears with the OSD hidden.
    useEffect(() => {
        if (!skipSpan || osd) return;
        const h = requestAnimationFrame(() => {
            const el = osdRef.current?.querySelector<HTMLElement>('[data-focus-key="osd:skip"]');
            if (el) focusEl(el, false);
        });
        return () => cancelAnimationFrame(h);
    }, [skipSpan?.key, osd]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Sleep timer ────────────────────────────────────────────────────
    useEffect(() => {
        if (sleepAt <= 0) return;
        const h = window.setTimeout(() => { flash(t("pl.sleepDone")); exitNow(); }, Math.max(0, sleepAt - Date.now()));
        return () => window.clearTimeout(h);
    }, [sleepAt, exitNow, flash]);

    // ─── Focus scope + first focus when the OSD opens ───────────────────
    const overlayOpen = panel !== null || upNext === "shown" || stillAsk;
    useFocusScope(osdRef, osd && !overlayOpen && active);
    useEffect(() => {
        if (!osd || overlayOpen || !osdFocus) return;
        const el = osdRef.current?.querySelector<HTMLElement>(`[data-focus-key="${osdFocus.key}"]`);
        if (el) focusEl(el, false);
    }, [osd, osdFocus, overlayOpen]);

    // Pause solo playback while a screen covers the player (e.g. Watch Together opened from the OSD).
    useEffect(() => {
        const el = mediaRef.current;
        if (!el || room.inRoom) return;
        if (!active) { wasPlayingWhenCovered.current = !el.paused; el.pause(); }
        else if (wasPlayingWhenCovered.current) { wasPlayingWhenCovered.current = false; el.play().catch(() => undefined); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    // ─── Keys — the player owns the remote while mounted ─────────────────
    const keyState = { osd, overlayOpen, skip: !!skipSpan };
    const keyRef = useRef(keyState);
    keyRef.current = keyState;
    useEffect(() => {
        if (!active) return;
        const stop = (e: KeyboardEvent) => { e.preventDefault(); e.stopImmediatePropagation(); };
        const onKey = (e: KeyboardEvent) => {
            const k = keyFromEvent(e);
            const s = keyRef.current;
            session.streak = 0;
            if (k === "back") {
                stop(e);
                if (consumeBack()) return;
                if (pendingRef.current !== null) { setPending(null); return; }
                if (s.osd) { hideOsd(); return; }
                exitNow();
                return;
            }
            switch (k) {
                case "playpause": togglePlay(); showOsd(); stop(e); return;
                case "play": if (mediaRef.current?.paused) togglePlay(); showOsd(); stop(e); return;
                case "pause": if (!mediaRef.current?.paused) togglePlay(); showOsd(); stop(e); return;
                case "stop": stop(e); exitNow(); return;
                case "rewind": scrub(-1); showOsd("osd:scrub"); stop(e); return;
                case "fastforward": scrub(1); showOsd("osd:scrub"); stop(e); return;
                case "chup": stop(e); prev(); return;
                case "chdown": stop(e); next(); return;
                case "info": stop(e); setPanel("info"); return;
                default: break;
            }
            if (s.overlayOpen) return; // panels / Up Next / dialogs: the App moves focus + clicks.
            if (!s.osd) {
                switch (k) {
                    case "enter": if (s.skip) doSkipRef.current(); else { togglePlay(); showOsd(); } break;
                    case "left": scrub(-1); showOsd("osd:scrub"); break;
                    case "right": scrub(1); showOsd("osd:scrub"); break;
                    case "up": case "down": showOsd("osd:play"); break;
                    default: showOsd(); return;
                }
                stop(e);
                return;
            }
            armHide();
            const onScrub = (document.activeElement as HTMLElement | null)?.getAttribute("data-focus-key") === "osd:scrub";
            if (onScrub && (k === "left" || k === "right")) { scrub(k === "left" ? -1 : 1); stop(e); return; }
            if (onScrub && k === "enter") { if (pendingRef.current !== null) commitScrubRef.current(); else togglePlay(); stop(e); return; }
            // Anything else: the App's focus navigation inside the OSD scope.
        };
        // capture=true so App's global handler only sees what we let through.
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [active, togglePlay, scrub, next, prev, exitNow, showOsd, hideOsd, armHide]);
    const doSkipRef = useRef(doSkip);
    doSkipRef.current = doSkip;

    // ─── Player bus: remote commands in, now-playing out ─────────────────
    useEffect(() => playerBus.subscribe((cmd) => {
        const el = mediaRef.current;
        if (!el) return false;
        switch (cmd.type) {
            case "pause": if (room.inRoom) room.pause(); else el.pause(); break;
            case "resume": if (room.inRoom) room.play(); else el.play().catch(() => undefined); break;
            case "toggle": togglePlay(); break;
            case "seek": doSeek(cmd.positionSec); break;
            case "seekBy": seekBy(cmd.deltaSec); break;
            case "stop": exitNow(); break;
            case "next": next(); break;
            case "previous": prev(); break;
            case "rate": if (!room.inRoom) setRate(cmd.rate); break;
            case "volume": el.volume = Math.max(0, Math.min(1, cmd.level > 1 ? cmd.level / 100 : cmd.level)); break;
        }
        showOsd();
        return true;
    }), [togglePlay, doSeek, seekBy, next, prev, exitNow, showOsd, room]);

    useEffect(() => {
        playerBus.setNowPlaying({
            kind: cur.kind,
            playing: !paused,
            positionSec: time,
            durationSec: duration > 0 ? duration : undefined,
            media: video ? hubMediaOf(video, titleRef) : { kind: "track", title: song?.title, durationSec: song?.duration },
            title: video ? video.parsed.title : song?.title ?? "",
            subtitle: video ? (epName ?? undefined) : [song?.artist, song?.album].filter(Boolean).join(" · "),
            artUrl: song?.coverArt ? client.coverArtUrl(song.coverArt, 200) : null,
            updatedAt: Date.now(),
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cur, paused, Math.floor(time)]);
    useEffect(() => () => {
        playerBus.setNowPlaying(null);
        if (osdTimer.current) window.clearTimeout(osdTimer.current);
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        if (scrubTimer.current) window.clearTimeout(scrubTimer.current);
    }, []);

    useEffect(() => { showOsd("osd:play"); }, [showOsd, cur]);
    // Still-watching streak reached at episode start (e.g. remote-started autoplays).
    useEffect(() => { if (paused) armHide(); }, [paused, armHide]);

    // ─── Panels ─────────────────────────────────────────────────────────
    const audioItems: SidePanelItem[] = (video?.audioTracks ?? []).map((a, i) => ({
        id: String(i),
        label: [langName(a.lang ?? "") || t("pl.track", { n: i + 1 }), a.title].filter(Boolean).join(" · "),
        sub: `${a.codec.toUpperCase()} ${channelsLabel(a.channels)}`,
    }));
    const subItems: SidePanelItem[] = [
        { id: "off", label: t("pl.subOff") },
        ...(video ? subtitleOrder(video).map((i) => {
            const s = subs[i]!;
            return { id: String(i), label: [langName(s.lang ?? "") || t("player.sub", { n: i + 1 }), s.title].filter(Boolean).join(" · "), sub: s.forced ? t("pl.forced") : s.codec.toUpperCase() };
        }) : []),
        { id: "style", label: t("pl.subStyle"), icon: "settings" as const, sub: `${t(`pl.size.${subSize}`)} · ${t(`pl.bg.${subBg}`)}` },
    ];
    const subStyleItems: SidePanelItem[] = [
        ...(["small", "medium", "large", "xlarge"] as const).map((s) => ({ id: `size:${s}`, label: t("pl.subSize"), sub: t(`pl.size.${s}`) })),
        ...(["none", "shadow", "box"] as const).map((b) => ({ id: `bg:${b}`, label: t("pl.subBg"), sub: t(`pl.bg.${b}`) })),
    ];

    const pickAudioTrack = (idx: number) => {
        setPanel(null);
        const el = mediaRef.current;
        if (!el || !video || idx === load.audio) return;
        const at = absTime(el);
        if (mode === "direct") {
            const list = (el as HTMLVideoElement & { audioTracks?: { length: number; [i: number]: { enabled: boolean } } }).audioTracks;
            if (list && list.length > idx) {
                for (let i = 0; i < list.length; i++) list[i]!.enabled = i === idx;
                setLoad((l) => ({ ...l, audio: idx }));
                return;
            }
        }
        client.pauseStream(video.fileId);
        setLoad((l) => ({ n: l.n + 1, at: Math.floor(at), audio: idx, forceHls: true }));
        flash(t("pl.audioSwitching"));
    };

    // ─── Render ─────────────────────────────────────────────────────────
    const curAudio = video?.audioTracks[load.audio];
    const infoRows: Array<[string, string]> = video ? [
        [t("pl.info.file"), video.path.split(/[\\/]/).pop() ?? ""],
        [t("pl.info.container"), (video.container ?? "").toUpperCase()],
        [t("pl.info.video"), [video.videoCodec?.toUpperCase(), resolutionLabel(video.width, video.height)].filter(Boolean).join(" · ")],
        [t("pl.info.hdr"), video.hdr && video.hdr !== "sdr" ? video.hdr.toUpperCase() : "SDR"],
        [t("pl.info.audio"), curAudio ? `${curAudio.codec.toUpperCase()} ${channelsLabel(curAudio.channels)}${curAudio.lang ? ` · ${langName(curAudio.lang)}` : ""}` : (video.audioCodec ?? "").toUpperCase()],
        [t("pl.info.mode"), mode === "hls" ? t("pl.mode.hls") : t("pl.mode.direct")],
        [t("pl.info.bitrate"), bitrateLabel(video.sizeBytes, video.durationSec)],
        [t("pl.info.size"), `${(video.sizeBytes / 1e9).toFixed(2)} GB`],
        [t("pl.info.squeeze"), squeeze === 1 ? "1" : squeeze.toFixed(3)],
    ] : [];

    const title = video ? video.parsed.title : song?.title ?? "";
    const se = titleRef?.season != null ? `S${titleRef.season} E${titleRef.episode ?? ""}` : video?.parsed.season != null ? `S${video.parsed.season} E${video.parsed.episode ?? ""}` : "";
    const line = video
        ? [se, epName, se ? null : video.parsed.year].filter(Boolean).join(" · ")
        : [song?.artist, song?.album].filter(Boolean).join(" · ");
    const coverId = song?.coverArt ?? (cur.kind === "audio" ? cur.album.coverArt : undefined);
    // Ultrawide: in layout units #root is k×100vw wide; the film box is computed for the real panel.
    const box = squeeze !== 1 && cur.kind === "video" ? videoBox(videoAspect, squeeze) : null;
    const videoStyle = cur.kind === "audio"
        ? { opacity: 0 }
        : box ? { width: `${box.w * 100}%`, height: `${box.h * 100}%` } : undefined;
    const hasNext = (!!queue && qIndex + 1 < queue.length) || !!nextEp;
    const sleepLabel = sleepMin === 0 ? t("pl.off") : sleepMin < 0 ? t("pl.sleepEnd") : t("pl.sleepMin", { n: sleepMin });

    const buttons: OsdButton[] = [
        { id: "back10", icon: "back10", label: t("pl.back10"), onClick: () => seekBy(-10) },
        { id: "play", icon: paused ? "play" : "pause", label: paused ? t("player.play") : t("player.pause"), onClick: togglePlay },
        { id: "fwd10", icon: "fwd10", label: t("pl.fwd10"), onClick: () => seekBy(10) },
    ];
    if (video) {
        buttons.push(
            { id: "audio", icon: "audio", label: t("pl.audio"), onClick: () => setPanel("audio"), disabled: video.audioTracks.length < 2, value: curAudio ? langName(curAudio.lang ?? "") : undefined },
            { id: "subs", icon: "subtitles", label: t("pl.subtitles"), onClick: () => setPanel("subs"), active: subIdx >= 0, value: subIdx >= 0 ? langName(subs[subIdx]?.lang ?? "") : t("pl.off") },
            { id: "speed", icon: "speed", label: t("pl.speed"), onClick: () => setPanel("speed"), active: rate !== 1, disabled: room.inRoom, value: `${rate}×` },
            { id: "format", icon: "aspect", label: t("pl.format"), onClick: () => setPanel("format"), value: fmt === "auto" ? t("pl.auto") : fmt },
            { id: "sleep", icon: "moon", label: t("pl.sleep"), onClick: () => setPanel("sleep"), active: sleepMin !== 0, value: sleepLabel },
            { id: "info", icon: "info", label: t("pl.info"), onClick: () => setPanel("info") },
        );
    }
    if (hasNext) buttons.push({ id: "next", icon: "next", label: t("pl.nextEpisode"), onClick: next });
    if (video && hub) buttons.push({ id: "together", icon: "group", label: t("pl.together"), onClick: () => nav.push({ name: "together" }), active: room.inRoom });

    const textCues = activeCues(cues, time);

    return (
        <div className={`player${osd ? " osd-on" : ""}`} data-testid="player" data-mode={mode} data-audio={load.audio} data-hls={hlsQuery || undefined}
            onMouseMove={() => showOsd()}>
            {cur.kind === "audio" && coverId && <div className="art-bg" style={{ backgroundImage: `url(${client.coverArtUrl(coverId, 600)})` }} />}
            <video ref={mediaRef} autoPlay playsInline className={box ? "fit-box" : undefined} style={videoStyle} />
            {textCues.length > 0 && (
                <div className={`pl-subs pl-subs-${subSize} pl-subs-bg-${subBg}${osd ? " is-raised" : ""}`} aria-live="off">
                    {textCues.map((c, i) => <div key={i} className="pl-cue"><span>{c}</span></div>)}
                </div>
            )}
            {cur.kind === "audio" && (
                <div className="now">
                    {coverId && <img src={client.coverArtUrl(coverId, 600)} alt="" />}
                    <div>
                        <div className="t">{song?.title}</div>
                        <div className="s">{line}</div>
                        {queue && <div className="s">{qIndex + 1} / {queue.length}</div>}
                    </div>
                </div>
            )}
            {error && <div className="toast error">{error}</div>}
            {room.waiting && <div className="pl-waiting" role="status">{t("pl.waitingOthers")}</div>}
            <Osd
                rootRef={osdRef}
                visible={osd && !overlayOpen}
                title={title}
                line={line}
                badge={(
                    <div className="pl-badges">
                        {video && <span className="badge badge-neutral">{mode === "hls" ? t("pl.mode.hls") : t("pl.mode.direct")}</span>}
                        {video?.hdr && video.hdr !== "sdr" && <span className="badge badge-neutral">{video.hdr.toUpperCase()}</span>}
                        {room.inRoom && <span className="badge badge-success">{t("pl.inRoom", { n: room.room?.members.length ?? 1 })}</span>}
                        {sleepMin !== 0 && <span className="badge badge-warning">{sleepLabel}</span>}
                    </div>
                )}
                time={time}
                duration={duration}
                buffered={buffered}
                pending={pending}
                markers={markers}
                sprite={sprite === "ok" && spriteUrl && grid ? { url: spriteUrl, grid } : null}
                endsAt={endsAt(duration - (pending ?? time), rate)}
                buttons={buttons}
                skip={skipSpan && !overlayOpen ? { label: skipSpan.label, onSkip: doSkip } : null}
            />
            <Bubbles items={bubbles} />
            {toast && <div className="pl-toast" role="status">{toast}</div>}

            <SidePanel open={panel === "audio"} title={t("pl.audio")} items={audioItems} value={String(load.audio)}
                onSelect={(id) => pickAudioTrack(Number(id))} onClose={() => setPanel(null)} testId="panel-audio" />
            <SidePanel open={panel === "subs"} title={t("pl.subtitles")} items={subItems} value={subIdx >= 0 ? String(subIdx) : "off"}
                onSelect={(id) => {
                    if (id === "style") { setPanel("subStyle"); return; }
                    setSubIdx(id === "off" ? -1 : Number(id));
                    setPanel(null);
                }} onClose={() => setPanel(null)} testId="panel-subs" />
            <SidePanel open={panel === "subStyle"} title={t("pl.subStyle")} items={subStyleItems} value={null}
                onSelect={(id) => {
                    const [kind, v] = id.split(":");
                    if (kind === "size") setSubSize(v as typeof subSize);
                    if (kind === "bg") setSubBg(v as typeof subBg);
                }}
                footer={<div className="pl-panel-note">{t("pl.subStyleNow", { size: t(`pl.size.${subSize}`), bg: t(`pl.bg.${subBg}`) })}</div>}
                onClose={() => setPanel("subs")} testId="panel-substyle" />
            <SidePanel open={panel === "speed"} title={t("pl.speed")} items={SPEEDS.map((s) => ({ id: String(s), label: s === 1 ? t("pl.normal") : `${s}×` }))}
                value={String(rate)} onSelect={(id) => { setRate(Number(id)); setPanel(null); }} onClose={() => setPanel(null)} testId="panel-speed" />
            <SidePanel open={panel === "format"} title={t("pl.format")} items={FORMATS.map((f) => ({ id: f, label: f === "auto" ? t("pl.auto") : f }))}
                value={fmt} onSelect={(id) => { setFmt(id as ScreenFormatKey); setPanel(null); }} onClose={() => setPanel(null)} testId="panel-format" />
            <SidePanel open={panel === "sleep"} title={t("pl.sleep")}
                items={SLEEP_OPTIONS.map((m) => ({ id: String(m), label: m === 0 ? t("pl.off") : m < 0 ? t("pl.sleepEnd") : t("pl.sleepMin", { n: m }) }))}
                value={String(sleepMin)}
                onSelect={(id) => {
                    const m = Number(id);
                    setSleepMin(m);
                    setSleepAt(m > 0 ? Date.now() + m * 60_000 : 0);
                    setPanel(null);
                    if (m !== 0) flash(m > 0 ? t("pl.sleepSet", { n: m }) : t("pl.sleepEnd"));
                }} onClose={() => setPanel(null)} testId="panel-sleep" />
            {panel === "info" && <InfoSheet rows={infoRows} onClose={() => setPanel(null)} />}
            {upNext === "shown" && nextEp && (
                <UpNextCard next={nextEp} countdown={countdown}
                    onPlay={() => { setCountdown(null); void playNextEpisode(false); }}
                    onCancel={() => { setUpNext("dismissed"); setCountdown(null); }} />
            )}
            <Dialog open={stillAsk} title={t("pl.stillWatching")} message={t("pl.stillWatchingMsg")} icon="play"
                confirmLabel={t("pl.continue")} cancelLabel={t("pl.stop")}
                onConfirm={() => { session.streak = 0; setStillAsk(false); void playNextEpisode(false); }}
                onCancel={() => { setStillAsk(false); exitNow(); }} testId="still-watching" />
            <span className="pl-sr" aria-live="polite">{pending !== null ? fmtClock(pending) : ""}</span>
        </div>
    );
}
