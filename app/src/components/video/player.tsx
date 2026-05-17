"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type Hls from "hls.js";

export interface VideoPlayerProps {
    hlsUrl: string;
    directUrl?: string | null;
    poster?: string | null;
    title: string;
    subtitle?: string;
    durationHint?: number | null;
    /** Called with current playback position (seconds) every 5s and on pause/end. */
    onProgress?: (positionSec: number, durationSec: number, ended: boolean) => void;
    /** Discord rich-presence push (companion-side). */
    onPresence?: (state: { title: string; subtitle?: string; progressSec: number; durationSec: number; paused: boolean }) => void;
    /** Initial start offset (seconds). */
    startSec?: number;
    subtitleTracks?: Array<{ src: string; lang: string; label: string; default?: boolean }>;
    audioTracks?: Array<{ index: number; label: string; lang: string | null }>;
}

type AspectMode = "fit" | "fill" | "16:9" | "4:3" | "21:9";

export function VideoPlayer(props: VideoPlayerProps) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const hlsRef = useRef<Hls | null>(null);
    const [playing, setPlaying] = useState(false);
    const [position, setPosition] = useState(0);
    const [duration, setDuration] = useState(props.durationHint ?? 0);
    const [volume, setVolume] = useState(1);
    const [muted, setMuted] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [pipActive, setPipActive] = useState(false);
    const [aspect, setAspect] = useState<AspectMode>("fit");
    const [zoom, setZoom] = useState(1);
    const [fullscreen, setFullscreen] = useState(false);
    const [hlsError, setHlsError] = useState<string | null>(null);

    // Initialise playback (HLS via hls.js, direct via native)
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        let cancelled = false;

        const useDirect = !!props.directUrl && !props.hlsUrl;
        if (useDirect && props.directUrl) {
            v.src = props.directUrl;
            if (props.startSec) v.currentTime = props.startSec;
            return;
        }

        if (v.canPlayType("application/vnd.apple.mpegurl")) {
            v.src = props.hlsUrl;
            if (props.startSec) v.currentTime = props.startSec;
            return;
        }

        (async () => {
            const HlsMod = (await import("hls.js")).default;
            if (cancelled) return;
            if (!HlsMod.isSupported()) {
                if (props.directUrl) {
                    v.src = props.directUrl;
                    if (props.startSec) v.currentTime = props.startSec;
                } else {
                    setHlsError("Browserul nu suportă HLS.");
                }
                return;
            }
            const hls = new HlsMod({ enableWorker: true, lowLatencyMode: false });
            hls.loadSource(props.hlsUrl);
            hls.attachMedia(v);
            hls.on(HlsMod.Events.MANIFEST_PARSED, () => {
                if (props.startSec) v.currentTime = props.startSec;
            });
            hls.on(HlsMod.Events.ERROR, (_e, data) => {
                if (data.fatal) {
                    setHlsError(`${data.type}: ${data.details}`);
                    if (props.directUrl) {
                        hls.destroy();
                        v.src = props.directUrl;
                    }
                }
            });
            hlsRef.current = hls;
        })();

        return () => {
            cancelled = true;
            hlsRef.current?.destroy();
            hlsRef.current = null;
        };
    }, [props.hlsUrl, props.directUrl, props.startSec]);

    // Wire up media events + progress reporting
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;

        const onTime = () => setPosition(v.currentTime);
        const onDur = () => setDuration(v.duration || 0);
        const onPlay = () => setPlaying(true);
        const onPause = () => setPlaying(false);
        const onVol = () => { setVolume(v.volume); setMuted(v.muted); };
        const onEnter = () => setPipActive(true);
        const onLeave = () => setPipActive(false);

        v.addEventListener("timeupdate", onTime);
        v.addEventListener("durationchange", onDur);
        v.addEventListener("play", onPlay);
        v.addEventListener("pause", onPause);
        v.addEventListener("volumechange", onVol);
        v.addEventListener("enterpictureinpicture", onEnter);
        v.addEventListener("leavepictureinpicture", onLeave);

        return () => {
            v.removeEventListener("timeupdate", onTime);
            v.removeEventListener("durationchange", onDur);
            v.removeEventListener("play", onPlay);
            v.removeEventListener("pause", onPause);
            v.removeEventListener("volumechange", onVol);
            v.removeEventListener("enterpictureinpicture", onEnter);
            v.removeEventListener("leavepictureinpicture", onLeave);
        };
    }, []);

    // Periodic progress save + Discord presence
    useEffect(() => {
        if (!playing || duration <= 0) return;
        const id = setInterval(() => {
            props.onProgress?.(position, duration, false);
            props.onPresence?.({ title: props.title, subtitle: props.subtitle, progressSec: position, durationSec: duration, paused: false });
        }, 5000);
        return () => clearInterval(id);
    }, [playing, position, duration, props]);

    useEffect(() => {
        if (!playing) {
            props.onPresence?.({ title: props.title, subtitle: props.subtitle, progressSec: position, durationSec: duration, paused: true });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playing]);

    const togglePlay = useCallback(() => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) void v.play(); else v.pause();
    }, []);

    const seek = (s: number) => {
        const v = videoRef.current;
        if (!v || !isFinite(s)) return;
        v.currentTime = Math.max(0, Math.min(duration || s, s));
    };

    const togglePiP = async () => {
        const v = videoRef.current;
        if (!v) return;
        try {
            if (document.pictureInPictureElement) await document.exitPictureInPicture();
            else await v.requestPictureInPicture();
        } catch { /* PiP not supported / user blocked */ }
    };

    const toggleFullscreen = async () => {
        const root = videoRef.current?.parentElement;
        if (!root) return;
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
                setFullscreen(false);
            } else {
                await root.requestFullscreen();
                setFullscreen(true);
            }
        } catch { /* fullscreen not supported */ }
    };

    const cycleAspect = () => {
        const modes: AspectMode[] = ["fit", "fill", "16:9", "4:3", "21:9"];
        setAspect((a) => modes[(modes.indexOf(a) + 1) % modes.length]);
    };

    const aspectStyle = (): React.CSSProperties => {
        const base: React.CSSProperties = { transform: `scale(${zoom})`, transformOrigin: "center" };
        switch (aspect) {
            case "fill": return { ...base, objectFit: "cover", width: "100%", height: "100%" };
            case "16:9": return { ...base, aspectRatio: "16/9", objectFit: "contain", width: "100%", height: "auto" };
            case "4:3": return { ...base, aspectRatio: "4/3", objectFit: "contain", width: "auto", height: "100%" };
            case "21:9": return { ...base, aspectRatio: "21/9", objectFit: "contain", width: "100%", height: "auto" };
            case "fit":
            default: return { ...base, objectFit: "contain", width: "100%", height: "100%" };
        }
    };

    return (
        <div
            className="vp-root"
            onMouseMove={() => setShowControls(true)}
            onMouseLeave={() => setShowControls(false)}
        >
            <video
                ref={videoRef}
                poster={props.poster ?? undefined}
                playsInline
                onClick={togglePlay}
                onDoubleClick={toggleFullscreen}
                style={aspectStyle()}
                crossOrigin="anonymous"
            >
                {(props.subtitleTracks ?? []).map((t, i) => (
                    <track key={i} kind="subtitles" src={t.src} srcLang={t.lang} label={t.label} default={t.default} />
                ))}
            </video>

            {hlsError && (
                <div className="vp-error">HLS: {hlsError}</div>
            )}

            <div className={`vp-controls${showControls || !playing ? " is-visible" : ""}`}>
                <div className="vp-title">
                    <strong>{props.title}</strong>
                    {props.subtitle && <span> — {props.subtitle}</span>}
                </div>

                <div className="vp-progress-row">
                    <span className="vp-time">{fmt(position)}</span>
                    <input
                        type="range"
                        min={0}
                        max={duration || 0}
                        step={0.1}
                        value={position}
                        onChange={(e) => seek(parseFloat(e.target.value))}
                        className="vp-progress"
                        aria-label="Seek"
                    />
                    <span className="vp-time">{fmt(duration)}</span>
                </div>

                <div className="vp-buttons">
                    <button onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>{playing ? "⏸" : "▶"}</button>
                    <button onClick={() => seek(position - 10)} aria-label="Înapoi 10s">⏪10</button>
                    <button onClick={() => seek(position + 10)} aria-label="Înainte 10s">10⏩</button>

                    <div className="vp-spacer" />

                    <label className="vp-vol">
                        <button onClick={() => { const v = videoRef.current; if (v) v.muted = !v.muted; }} aria-label="Mute">{muted || volume === 0 ? "🔇" : "🔊"}</button>
                        <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume}
                            onChange={(e) => { const v = videoRef.current; if (!v) return; v.muted = false; v.volume = parseFloat(e.target.value); }} />
                    </label>

                    <button onClick={cycleAspect} aria-label="Aspect ratio">{aspect}</button>
                    <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} aria-label="Zoom -">−</button>
                    <button onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.1).toFixed(2)))} aria-label="Zoom +">+</button>
                    <span className="vp-zoom">{zoom.toFixed(1)}x</span>

                    {document.pictureInPictureEnabled && (
                        <button onClick={togglePiP} aria-label="Picture in Picture">{pipActive ? "⬛PiP" : "▭PiP"}</button>
                    )}
                    <button onClick={toggleFullscreen} aria-label="Fullscreen">{fullscreen ? "⛶" : "⛶"}</button>
                </div>
            </div>

            <style>{`
                .vp-root { position: relative; width: 100%; height: 100%; background: #000; overflow: hidden; }
                .vp-root video { width: 100%; height: 100%; display: block; }
                .vp-controls {
                    position: absolute; left: 0; right: 0; bottom: 0;
                    padding: 1rem 1.25rem .9rem;
                    background: linear-gradient(0deg, rgba(0,0,0,.85) 0%, transparent 100%);
                    color: #fff;
                    opacity: 0; transition: opacity 240ms;
                    pointer-events: none;
                }
                .vp-controls.is-visible { opacity: 1; pointer-events: auto; }
                .vp-title { font-size: .9rem; margin-bottom: .5rem; opacity: .9; }
                .vp-progress-row { display: flex; align-items: center; gap: .75rem; }
                .vp-progress { flex: 1; appearance: none; height: 4px; background: rgba(255,255,255,.25); border-radius: 2px; }
                .vp-progress::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #ff3366; cursor: pointer; }
                .vp-time { font-variant-numeric: tabular-nums; font-size: .8rem; opacity: .8; min-width: 4ch; }
                .vp-buttons { display: flex; align-items: center; gap: .5rem; margin-top: .5rem; flex-wrap: wrap; }
                .vp-buttons button {
                    background: rgba(255,255,255,.08); color: #fff; border: 1px solid rgba(255,255,255,.12);
                    border-radius: 8px; padding: .4rem .6rem; cursor: pointer; font-size: .85rem;
                    transition: background 150ms;
                }
                .vp-buttons button:hover { background: rgba(255,255,255,.18); }
                .vp-spacer { flex: 1; }
                .vp-vol { display: inline-flex; align-items: center; gap: .35rem; }
                .vp-vol input { width: 80px; }
                .vp-zoom { font-size: .75rem; opacity: .7; min-width: 3ch; }
                .vp-error { position: absolute; top: 1rem; left: 1rem; background: rgba(255,0,0,.6); color: #fff; padding: .5rem .75rem; border-radius: 6px; font-size: .8rem; }
            `}</style>
        </div>
    );
}

function fmt(s: number) {
    if (!isFinite(s) || s < 0) return "--:--";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
