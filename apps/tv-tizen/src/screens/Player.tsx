import { useCallback, useEffect, useRef, useState } from "react";
import type { MmoClient, ProbedVideo, SubsonicAlbum, SubsonicSong } from "../lib/api";
import { keyFromEvent } from "../lib/tv-keys";
import { canDirectPlayOnTizen, isHlsNative, TIZEN_CAPS } from "../lib/playback";
import { fmtClock } from "../lib/format";
import { getProgress, setProgress } from "../lib/progress";
import { t } from "../i18n/messages";
import type Hls from "hls.js";

export type PlayItem =
    | { kind: "video"; video: ProbedVideo }
    | { kind: "audio"; song: SubsonicSong; album: SubsonicAlbum };

interface Props {
    client: MmoClient;
    item: PlayItem;
    queue?: PlayItem[];
    index?: number;
    onExit: () => void;
}

const SEEK_STEP = 10;
const OSD_TIMEOUT = 4000;

export function PlayerScreen({ client, item, queue, index, onExit }: Props) {
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
    const osdTimer = useRef<number | null>(null);

    const showOsd = useCallback(() => {
        setOsd(true);
        if (osdTimer.current) window.clearTimeout(osdTimer.current);
        osdTimer.current = window.setTimeout(() => setOsd(false), OSD_TIMEOUT);
    }, []);

    const video = cur.kind === "video" ? cur.video : null;
    const song = cur.kind === "audio" ? cur.song : null;
    const subs = video?.subtitleTracks ?? [];

    // ─── Source setup ───────────────────────────────────────────────────
    useEffect(() => {
        const el = mediaRef.current;
        if (!el) return;
        let cancelled = false;
        setError(null);
        setTime(0);
        setDuration(0);
        setSubIdx(subs.findIndex((s) => s.forced) >= 0 ? subs.findIndex((s) => s.forced) : -1);

        // Resume: saved position (≥ 10 s) for videos. Direct + native HLS seek on
        // loadedmetadata; hls.js gets `startPosition` in its config.
        const resumeAt = cur.kind === "video" ? (getProgress(cur.video.fileId)?.pos ?? 0) : 0;
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
            const url = client.hlsUrl(v.fileId, { caps: TIZEN_CAPS, quality: "original" });
            if (isHlsNative(el)) {
                el.src = url;
                await el.play().catch(() => undefined);
                return;
            }
            const { default: HlsCtor } = await import("hls.js");
            if (cancelled) return;
            if (!HlsCtor.isSupported()) { setError(t("player.errMse")); return; }
            el.removeEventListener("loadedmetadata", onMeta);
            const hls = new HlsCtor({
                // The server playlist is EVENT while ffmpeg is still writing; keep polling.
                liveDurationInfinity: false,
                maxBufferLength: 60,
                backBufferLength: 30,
                enableWorker: false, // Tizen workers + blob URLs are flaky on older firmware
                startPosition: resumeAt > 0 ? resumeAt : -1,
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
                setProgress(cur.video.fileId, el.currentTime, Number.isFinite(el.duration) ? el.duration : (cur.video.durationSec ?? 0), true);
                client.pauseStream(cur.video.fileId);
            }
            teardown();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cur, client]);

    // ─── Media events ───────────────────────────────────────────────────
    useEffect(() => {
        const el = mediaRef.current;
        if (!el) return;
        const onTime = () => {
            setTime(el.currentTime);
            if (video) setProgress(video.fileId, el.currentTime, Number.isFinite(el.duration) ? el.duration : (video.durationSec ?? 0));
        };
        const onDur = () => setDuration(Number.isFinite(el.duration) ? el.duration : (video?.durationSec ?? 0));
        const onPlay = () => setPaused(false);
        const onPause = () => {
            setPaused(true);
            if (video) setProgress(video.fileId, el.currentTime, Number.isFinite(el.duration) ? el.duration : (video.durationSec ?? 0), true);
        };
        const onEnded = () => next();
        const onErr = () => {
            const code = el.error?.code;
            setError(code === 4 ? t("player.errFormat") : t("player.errMedia", { code: code ?? "?" }));
        };
        el.addEventListener("timeupdate", onTime);
        el.addEventListener("durationchange", onDur);
        el.addEventListener("loadedmetadata", onDur);
        el.addEventListener("play", onPlay);
        el.addEventListener("pause", onPause);
        el.addEventListener("ended", onEnded);
        el.addEventListener("error", onErr);
        return () => {
            el.removeEventListener("timeupdate", onTime);
            el.removeEventListener("durationchange", onDur);
            el.removeEventListener("loadedmetadata", onDur);
            el.removeEventListener("play", onPlay);
            el.removeEventListener("pause", onPause);
            el.removeEventListener("ended", onEnded);
            el.removeEventListener("error", onErr);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cur]);

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
            setCur(queue[n]!);
        } else if (el) {
            el.currentTime = 0;
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
        const max = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : Infinity;
        el.currentTime = Math.max(0, Math.min(max - 0.5, el.currentTime + delta));
    }, []);

    const cycleSubs = useCallback(() => {
        if (subs.length === 0) return;
        setSubIdx((i) => (i + 1 >= subs.length ? -1 : i + 1));
        showOsd();
    }, [subs.length, showOsd]);

    // ─── Keys — the player owns the remote while mounted ─────────────────
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const k = keyFromEvent(e);
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
    }, [togglePlay, seekBy, next, prev, cycleSubs, onExit, showOsd, queue]);

    useEffect(() => { showOsd(); }, [showOsd, cur]);

    const title = video
        ? (video.parsed.season != null ? `${video.parsed.title} S${video.parsed.season}E${video.parsed.episode ?? ""}` : video.parsed.title)
        : song?.title ?? "";
    const subtitle = video
        ? [video.parsed.year, video.videoCodec?.toUpperCase(), video.audioCodec?.toUpperCase(), mode === "hls" ? "HLS" : "Direct"].filter(Boolean).join(" · ")
        : [song?.artist, song?.album].filter(Boolean).join(" · ");
    const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
    const coverId = song?.coverArt ?? (cur.kind === "audio" ? cur.album.coverArt : undefined);

    return (
        <div className="player" onMouseMove={showOsd}>
            {cur.kind === "audio" && coverId && <div className="art-bg" style={{ backgroundImage: `url(${client.coverArtUrl(coverId, 600)})` }} />}
            <video ref={mediaRef} autoPlay playsInline crossOrigin="anonymous" style={cur.kind === "audio" ? { opacity: 0 } : undefined}>
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
                    <button className="btn" onClick={() => seekBy(-SEEK_STEP)}>⟲ 10s</button>
                    <button className={`btn ${paused ? "" : "active"}`} onClick={togglePlay}>{paused ? t("player.play") : t("player.pause")}</button>
                    <button className="btn" onClick={() => seekBy(SEEK_STEP)}>10s ⟳</button>
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
