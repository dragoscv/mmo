import { useCallback, useEffect, useRef, useState } from "react";
import type { MmoClient } from "../lib/api";
import type { MediaClient } from "../lib/media";
import { reportProgress, type TitleRef } from "../lib/progress-sync";
import { keyFromEvent } from "../lib/tv-keys";
import { canDirectPlayOnTizen, isHlsNative, TIZEN_CAPS } from "../lib/playback";
import { fmtClock } from "../lib/format";
import { getProgress } from "../lib/progress";
import { squeezeFactor, videoBox } from "../lib/screen-format";
import { playerBus } from "../lib/player-bus";
import { consumeBack } from "../nav/back";
import type { PlayItem } from "../nav/routes";
import { t } from "../i18n/messages";
import { Icon } from "../ui/icons";
import type Hls from "hls.js";

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
}

const SEEK_STEP = 10;
const OSD_TIMEOUT = 4000;

export function PlayerScreen({ client, media = null, item, queue, index, onExit, active = true }: Props) {
    const mediaRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<Hls | null>(null);
    const [cur, setCur] = useState<PlayItem>(item);
    const [qIndex, setQIndex] = useState(index ?? 0);
    const [time, setTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [paused, setPaused] = useState(false);
    const [osd, setOsd] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [mode, setMode] = useState<"direct" | "hls" | "audio">("direct");
    const [subIdx, setSubIdx] = useState<number>(-1);
    const [videoAspect, setVideoAspect] = useState(0);
    const squeeze = squeezeFactor();
    const osdTimer = useRef<number | null>(null);
    /** HLS sessions start at `?start=<sec>`; the element's time is relative to it. */
    const offsetRef = useRef(0);
    const [reloadAt, setReloadAt] = useState<number | null>(null);

    const showOsd = useCallback(() => {
        setOsd(true);
        if (osdTimer.current) window.clearTimeout(osdTimer.current);
        osdTimer.current = window.setTimeout(() => setOsd(false), OSD_TIMEOUT);
    }, []);

    const video = cur.kind === "video" ? cur.video : null;
    const song = cur.kind === "audio" ? cur.song : null;
    const subs = video?.subtitleTracks ?? [];
    const titleRef: TitleRef | null = cur.kind === "video" ? cur.ref ?? null : null;
    const absTime = (el: HTMLMediaElement) => offsetRef.current + el.currentTime;
    const absDuration = (el: HTMLMediaElement) =>
        offsetRef.current > 0 || mode === "hls"
            ? (video?.durationSec ?? (Number.isFinite(el.duration) ? offsetRef.current + el.duration : 0))
            : (Number.isFinite(el.duration) ? el.duration : (video?.durationSec ?? 0));
    const save = (el: HTMLMediaElement, force: boolean) => {
        if (!video) return;
        reportProgress(media, video.fileId, titleRef, absTime(el), absDuration(el), force);
    };

    // ─── Source setup ───────────────────────────────────────────────────
    useEffect(() => {
        const el = mediaRef.current;
        if (!el) return;
        let cancelled = false;
        setError(null);
        setTime(0);
        setDuration(0);
        setSubIdx(subs.findIndex((s) => s.forced) >= 0 ? subs.findIndex((s) => s.forced) : -1);
        offsetRef.current = 0;

        // Resume: server position when the Title screen passed one, else the local
        // store (≥ 10 s). Direct seeks on loadedmetadata; HLS asks the server to
        // start AT that position (`?start=`), so resume is instant and never
        // waits for ffmpeg to produce everything before it.
        const savedAt = cur.kind === "video" ? (cur.resumeSec && cur.resumeSec > 10 ? cur.resumeSec : (getProgress(cur.video.fileId)?.pos ?? 0)) : 0;
        const resumeAt = reloadAt ?? savedAt;
        const onMeta = () => {
            if (resumeAt > 0 && Number.isFinite(el.duration) && resumeAt < el.duration - 5) el.currentTime = resumeAt;
        };
        if (resumeAt > 0) el.addEventListener("loadedmetadata", onMeta, { once: true });

        const teardown = () => {
            if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
            el.removeEventListener("loadedmetadata", onMeta);
            el.removeAttribute("src");
            el.load();
        };

        (async () => {
            if (cur.kind === "audio") {
                setMode("audio");
                el.src = client.streamUrl(cur.song.id);
                await el.play().catch(() => undefined);
                return;
            }
            const v = cur.video;
            if (canDirectPlayOnTizen(v)) {
                setMode("direct");
                el.src = client.directUrl(v.fileId);
                await el.play().catch(() => undefined);
                return;
            }
            setMode("hls");
            el.removeEventListener("loadedmetadata", onMeta);
            const startSec = resumeAt > 0 ? Math.floor(resumeAt) : 0;
            offsetRef.current = startSec;
            const url = client.hlsUrl(v.fileId, { caps: TIZEN_CAPS, quality: "original", startSec });
            if (isHlsNative(el)) {
                el.src = url;
                await el.play().catch(() => undefined);
                return;
            }
            const { default: HlsCtor } = await import("hls.js");
            if (cancelled) return;
            if (!HlsCtor.isSupported()) { setError(t("player.errMse")); return; }
            const hls = new HlsCtor({
                // The server playlist is EVENT while ffmpeg is still writing; keep polling.
                liveDurationInfinity: false,
                maxBufferLength: 60,
                backBufferLength: 30,
                enableWorker: false, // Tizen workers + blob URLs are flaky on older firmware
                startPosition: 0,
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
    }, [cur, client, reloadAt]);

    // ─── Media events ───────────────────────────────────────────────────
    useEffect(() => {
        const el = mediaRef.current;
        if (!el) return;
        const onTime = () => {
            setTime(absTime(el));
            save(el, false);
        };
        const onDur = () => setDuration(absDuration(el));
        const onSize = () => { if (el.videoWidth > 0 && el.videoHeight > 0) setVideoAspect(el.videoWidth / el.videoHeight); };
        const onPlay = () => setPaused(false);
        const onPause = () => {
            setPaused(true);
            save(el, true);
        };
        const onEnded = () => next();
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

    // Subtitle track selection → toggle `mode` on the <track> elements.
    useEffect(() => {
        const el = mediaRef.current;
        if (!el) return;
        const tracks = el.textTracks;
        for (let i = 0; i < tracks.length; i++) {
            const t = tracks[i];
            if (!t) continue;
            t.mode = String(i) === String(subIdx) ? "showing" : "hidden";
        }
    }, [subIdx, cur]);

    const next = useCallback(() => {
        if (queue && qIndex + 1 < queue.length) {
            const n = qIndex + 1;
            setQIndex(n);
            setReloadAt(null);
            setCur(queue[n]!);
        } else {
            onExit();
        }
    }, [queue, qIndex, onExit]);

    const prev = useCallback(() => {
        const el = mediaRef.current;
        if (queue && qIndex > 0 && el && el.currentTime < 3) {
            const n = qIndex - 1;
            setQIndex(n);
            setReloadAt(null);
            setCur(queue[n]!);
        } else if (el) {
            if (offsetRef.current > 0) setReloadAt(0);
            else el.currentTime = 0;
        }
    }, [queue, qIndex]);

    const togglePlay = useCallback(() => {
        const el = mediaRef.current;
        if (!el) return;
        if (el.paused) el.play().catch(() => undefined);
        else { el.pause(); if (video) client.pauseStream(video.fileId); }
    }, [client, video]);

    const seekBy = useCallback((delta: number) => {
        const el = mediaRef.current;
        if (!el) return;
        const total = absDuration(el);
        const target = Math.max(0, Math.min((total > 0 ? total : Infinity) - 0.5, absTime(el) + delta));
        if (mode === "hls") {
            // The server reads at 2x realtime, so far seeks may land past what it
            // has produced: restart the session at the target instead of stalling.
            const local = target - offsetRef.current;
            const s = el.seekable;
            const end = s.length > 0 ? s.end(s.length - 1) : 0;
            if (local < 0 || local > end - 1) { client.pauseStream(video!.fileId); setReloadAt(Math.floor(target)); return; }
            el.currentTime = local;
            return;
        }
        el.currentTime = target;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, client, video]);

    const cycleSubs = useCallback(() => {
        if (subs.length === 0) return;
        setSubIdx((i) => (i + 1 >= subs.length ? -1 : i + 1));
        showOsd();
    }, [subs.length, showOsd]);

    // ─── Keys — the player owns the remote while mounted ─────────────────
    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent) => {
            const k = keyFromEvent(e);
            if (k === "back" && consumeBack()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
            switch (k) {
                case "playpause": case "enter": togglePlay(); showOsd(); break;
                case "play": mediaRef.current?.play().catch(() => undefined); showOsd(); break;
                case "pause": mediaRef.current?.pause(); showOsd(); break;
                case "left": case "rewind": seekBy(-SEEK_STEP); showOsd(); break;
                case "right": case "fastforward": seekBy(SEEK_STEP); showOsd(); break;
                case "up": if (queue) prev(); showOsd(); break;
                case "down": if (queue) next(); else showOsd(); break;
                case "yellow": cycleSubs(); break;
                case "stop": case "back": onExit(); break;
                default: showOsd(); return;
            }
            e.preventDefault();
            e.stopImmediatePropagation();
        };
        // capture=true so App's global handler never sees these.
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [togglePlay, seekBy, next, prev, cycleSubs, onExit, showOsd, queue, active]);

    // ─── Player bus: remote commands in, now-playing out ─────────────────
    useEffect(() => playerBus.subscribe((cmd) => {
        const el = mediaRef.current;
        if (!el) return false;
        switch (cmd.type) {
            case "pause": el.pause(); break;
            case "resume": el.play().catch(() => undefined); break;
            case "toggle": togglePlay(); break;
            case "seek": seekBy(cmd.positionSec - absTime(el)); break;
            case "seekBy": seekBy(cmd.deltaSec); break;
            case "stop": onExit(); break;
            case "next": next(); break;
            case "previous": prev(); break;
            case "rate": el.playbackRate = cmd.rate; break;
            case "volume": el.volume = Math.max(0, Math.min(1, cmd.level > 1 ? cmd.level / 100 : cmd.level)); break;
        }
        showOsd();
        return true;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [togglePlay, seekBy, next, prev, onExit, showOsd]);

    useEffect(() => {
        const v = cur.kind === "video" ? cur.video : null;
        const s = cur.kind === "audio" ? cur.song : null;
        playerBus.setNowPlaying({
            kind: cur.kind,
            playing: !paused,
            positionSec: time,
            durationSec: duration > 0 ? duration : undefined,
            media: v
                ? { fileId: v.fileId, kind: titleRef?.kind ?? "movie", tmdbId: titleRef?.tmdbId, season: titleRef?.season ?? v.parsed.season ?? undefined, episode: titleRef?.episode ?? v.parsed.episode ?? undefined, title: v.parsed.title, durationSec: v.durationSec ?? undefined }
                : { kind: "track", title: s?.title, durationSec: s?.duration },
            title: v ? v.parsed.title : s?.title ?? "",
            subtitle: v ? undefined : [s?.artist, s?.album].filter(Boolean).join(" · "),
            artUrl: s?.coverArt ? client.coverArtUrl(s.coverArt, 200) : null,
            updatedAt: Date.now(),
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cur, paused, Math.floor(time)]);
    useEffect(() => () => playerBus.setNowPlaying(null), []);

    useEffect(() => { showOsd(); }, [showOsd, cur]);

    const title = video
        ? (video.parsed.season != null ? `${video.parsed.title} S${video.parsed.season}E${video.parsed.episode ?? ""}` : video.parsed.title)
        : song?.title ?? "";
    const subtitle = video
        ? [video.parsed.year, video.videoCodec?.toUpperCase(), video.audioCodec?.toUpperCase(), mode === "hls" ? "HLS" : "Direct"].filter(Boolean).join(" · ")
        : [song?.artist, song?.album].filter(Boolean).join(" · ");
    const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
    const coverId = song?.coverArt ?? (cur.kind === "audio" ? cur.album.coverArt : undefined);
    // Ultrawide: in layout units #root is k×100vw wide; the film box is computed for the real panel.
    const box = squeeze !== 1 && cur.kind === "video" ? videoBox(videoAspect, squeeze) : null;
    const videoStyle = cur.kind === "audio"
        ? { opacity: 0 }
        : box ? { width: `${box.w * 100}%`, height: `${box.h * 100}%` } : undefined;

    return (
        <div className="player" onMouseMove={showOsd}>
            {cur.kind === "audio" && coverId && <div className="art-bg" style={{ backgroundImage: `url(${client.coverArtUrl(coverId, 600)})` }} />}
            <video ref={mediaRef} autoPlay playsInline crossOrigin="anonymous" className={box ? "fit-box" : undefined} style={videoStyle}>
                {video && subs.map((s, i) => (
                    <track key={`${video.fileId}-${i}`} kind="subtitles" src={client.subtitleUrl(video.fileId, i)}
                        srcLang={s.lang ?? undefined} label={s.title ?? s.lang ?? t("player.sub", { n: i + 1 })} default={i === subIdx} />
                ))}
            </video>
            {cur.kind === "audio" && (
                <div className="now">
                    {coverId && <img src={client.coverArtUrl(coverId, 600)} alt="" />}
                    <div>
                        <div className="t">{song?.title}</div>
                        <div className="s">{subtitle}</div>
                        {queue && <div className="s">{qIndex + 1} / {queue.length}</div>}
                    </div>
                </div>
            )}
            {error && <div className="toast error">{error}</div>}
            <div className={`osd ${osd || paused ? "" : "hidden"}`}>
                <div className="title">{title} <span className="dim">— {subtitle}</span></div>
                <div className="bar"><div style={{ width: `${pct}%` }} /></div>
                <div className="times"><span>{fmtClock(time)}</span><span>{fmtClock(duration)}</span></div>
                <div className="controls">
                    <button className="btn" onClick={() => seekBy(-SEEK_STEP)} aria-label="-10s"><Icon name="back10" /></button>
                    <button className={`btn ${paused ? "" : "active"}`} onClick={togglePlay}>{paused ? t("player.play") : t("player.pause")}</button>
                    <button className="btn" onClick={() => seekBy(SEEK_STEP)} aria-label="+10s"><Icon name="fwd10" /></button>
                    {subs.length > 0 && (
                        <button className={`btn ${subIdx >= 0 ? "active" : ""}`} onClick={cycleSubs}>
                            {t("player.subtitles", { track: subIdx >= 0 ? (subs[subIdx]?.title ?? subs[subIdx]?.lang ?? subIdx + 1) : t("player.subOff") })}
                        </button>
                    )}
                    {queue && <button className="btn" onClick={next}>{t("player.next")}</button>}
                </div>
                <div className="hint">
                    {[t("player.hint.seek"), subs.length > 0 ? t("player.hint.subs") : null, queue ? t("player.hint.queue") : null, t("player.hint.back")].filter(Boolean).join(" · ")}
                </div>
            </div>
        </div>
    );
}
