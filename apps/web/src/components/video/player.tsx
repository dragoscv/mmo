"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type Hls from "hls.js";
import {
    Play,
    Pause,
    Volume2,
    VolumeX,
    Volume1,
    Volume,
    Maximize,
    Minimize,
    PictureInPicture2,
    SkipBack,
    SkipForward,
    ZoomIn,
    ZoomOut,
    Subtitles,
    Languages,
} from "lucide-react";
import { getCinemaSettings, updateCinemaSettings } from "@/hooks/use-cinema-settings";
import { withCaps } from "@/lib/media-capabilities";

export interface VideoPlayerProps {
    hlsUrl?: string | null;
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
    audioTracks?: Array<{ index: number; label?: string; lang?: string | null; codec?: string }>;
    /** Show id — used to persist preferred audio track per series. */
    showId?: number | null;
    /** Chapter markers rendered as ticks on the scrubber. */
    chapters?: Array<{ start: number; title: string }>;
    /** WebVTT URL with `sprite.jpg#xywh` cues for scrubber hover previews. */
    thumbsVttUrl?: string;
    /** Receive the underlying <video> element when it mounts/unmounts.
     *  Used by `PlayerProvider` to pipe video audio into the shared
     *  AudioContext and to sync play/pause/seek from external controls. */
    onVideoElementReady?: (el: HTMLVideoElement | null) => void;
    /** Render the title bar inside the player? Default true. The Now Playing
     *  view sets this to false because the surrounding layout already shows
     *  the title. */
    showTitleOverlay?: boolean;
    /** Render the bottom controls? Default true. Set to false when an
     *  external surface (e.g. the audio bar) drives playback. */
    showControls?: boolean;
    /** Auto-play after the source is ready? Default true. Set to false
     *  when restoring a previously-playing video on page reload — the
     *  user expects to press play themselves. */
    autoplay?: boolean;
}

type AspectMode = "fit" | "fill" | "16:9" | "4:3" | "21:9";

interface ThumbCue { start: number; end: number; sprite: string; x: number; y: number; w: number; h: number }

function parseThumbsVtt(text: string, baseUrl: string): ThumbCue[] {
    const out: ThumbCue[] = [];
    const blocks = text.replace(/\r/g, "").split(/\n\n+/);
    const tRe = /(\d+):(\d+):(\d+)\.(\d+)\s*-->\s*(\d+):(\d+):(\d+)\.(\d+)/;
    const toSec = (h: string, m: string, s: string, ms: string) => +h * 3600 + +m * 60 + +s + +ms / 1000;
    for (const block of blocks) {
        const lines = block.split("\n").filter(Boolean);
        if (!lines.length) continue;
        const timing = lines.find((l) => tRe.test(l));
        const cueLine = lines.find((l) => /#xywh=/.test(l));
        if (!timing || !cueLine) continue;
        const tm = tRe.exec(timing)!;
        const start = toSec(tm[1], tm[2], tm[3], tm[4]);
        const end = toSec(tm[5], tm[6], tm[7], tm[8]);
        const [spriteRel, frag] = cueLine.split("#xywh=");
        const [x, y, w, h] = frag.split(",").map(Number);
        const sprite = new URL(spriteRel.trim(), baseUrl).toString();
        out.push({ start, end, sprite, x, y, w, h });
    }
    return out;
}

export function VideoPlayer(props: VideoPlayerProps) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const hlsRef = useRef<Hls | null>(null);
    const [playing, setPlaying] = useState(false);
    const [position, setPosition] = useState(0);
    const [duration, setDuration] = useState(props.durationHint ?? 0);
    // When the user seeks past what ffmpeg has transcoded, we reload
    // the HLS source with `?start=<sec>` and bump this key. The load
    // effect depends on it, restarting playback from the new offset.
    const [reloadKey, setReloadKey] = useState(0);
    const [reloadStart, setReloadStart] = useState<number | null>(null);
    // Seconds in the source where the *current* HLS playlist starts.
    // `v.currentTime` is playlist-local; absolute position is
    // `streamOffsetRef.current + v.currentTime`.
    const streamOffsetRef = useRef(0);
    const [volume, setVolume] = useState(1);
    const [muted, setMuted] = useState(false);
    const [showControlsState, setShowControls] = useState(true);
    const [pipActive, setPipActive] = useState(false);
    const [aspect, setAspect] = useState<AspectMode>("fit");
    const [zoom, setZoom] = useState(1);
    const [fullscreen, setFullscreen] = useState(false);
    const [hlsError, setHlsError] = useState<string | null>(null);
    const [buffering, setBuffering] = useState(false);
    const [thumbCues, setThumbCues] = useState<ThumbCue[]>([]);
    const [hoverPreview, setHoverPreview] = useState<{ x: number; cue: ThumbCue; time: number } | null>(null);
    const [subDelayMs, setSubDelayMs] = useState(0);
    const lastDelayRef = useRef(0);
    const [audioTrackIdx, setAudioTrackIdx] = useState<number>(-1);
    // Marks that the most recent pause asked the companion to stop
    // ffmpeg. When the user presses Play we must re-spawn a session
    // from the current position instead of trying to resume the
    // (now-deleted) HLS playlist.
    const pausedKilledRef = useRef(false);
    const pauseKillTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Initialise playback: always try direct first; fall back to HLS on error.
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        let cancelled = false;
        let triedHls = false;

        const cleanupHls = () => {
            hlsRef.current?.destroy();
            hlsRef.current = null;
        };

        const loadHls = async () => {
            if (triedHls || cancelled) return;
            triedHls = true;
            if (!props.hlsUrl) {
                setHlsError("Direct playback failed and no HLS fallback is available.");
                return;
            }
            cleanupHls();
            const startAt = reloadStart ?? props.startSec ?? 0;
            streamOffsetRef.current = startAt;
            const withStart = startAt > 0 ? `${props.hlsUrl}${props.hlsUrl.includes("?") ? "&" : "?"}start=${Math.floor(startAt)}` : props.hlsUrl;
            const urlWithStart = withCaps(withStart);
            const allowAutoplay = (props.autoplay ?? true) || reloadStart != null;
            if (v.canPlayType("application/vnd.apple.mpegurl")) {
                v.src = urlWithStart;
                if (allowAutoplay) v.play().catch(() => {});
                return;
            }
            const HlsMod = (await import("hls.js")).default;
            if (cancelled) return;
            if (!HlsMod.isSupported()) {
                setHlsError("Browserul nu suportă HLS.");
                return;
            }
            const hls = new HlsMod({
                enableWorker: true,
                lowLatencyMode: false,
            });
            hls.loadSource(urlWithStart);
            hls.attachMedia(v);
            hls.on(HlsMod.Events.MANIFEST_PARSED, () => {
                if (allowAutoplay) v.play().catch(() => {});
            });
            hls.on(HlsMod.Events.ERROR, (_e, data) => {
                if (data.fatal) setHlsError(`${data.type}: ${data.details}`);
            });
            hlsRef.current = hls;
        };

        const onErrorOnce = () => {
            if (triedHls || cancelled) return;
            void loadHls();
        };

        v.addEventListener("error", onErrorOnce);

        if (props.directUrl) {
            v.src = props.directUrl;
            const startAt = reloadStart ?? props.startSec ?? 0;
            streamOffsetRef.current = 0; // direct URL is absolute already
            if (startAt > 0) v.currentTime = startAt;
            if ((props.autoplay ?? true) || reloadStart != null) v.play().catch(() => {});
        } else if (props.hlsUrl) {
            void loadHls();
        } else {
            setHlsError("No video source available.");
        }

        return () => {
            cancelled = true;
            v.removeEventListener("error", onErrorOnce);
            cleanupHls();
            // Kill the companion's ffmpeg session on teardown — without
            // this the pool's 5-min idle eviction is the only thing that
            // stops it, so navigating away from the player leaves NVENC
            // burning CPU/GPU long after the user has moved on.
            if (props.hlsUrl) {
                try {
                    const u = new URL(props.hlsUrl);
                    const t = u.searchParams.get("t") ?? "";
                    const usr = u.searchParams.get("u") ?? "";
                    const pauseUrl = `${u.origin}${u.pathname.replace(/\/$/, "")}/pause?t=${encodeURIComponent(t)}&u=${encodeURIComponent(usr)}`;
                    // sendBeacon is the right primitive for fire-and-forget
                    // on unmount/unload; fall back to keepalive fetch when
                    // it's unavailable or rejects (some browsers limit body).
                    const sent = typeof navigator !== "undefined" && navigator.sendBeacon
                        ? navigator.sendBeacon(pauseUrl)
                        : false;
                    if (!sent) {
                        void fetch(pauseUrl, { method: "POST", keepalive: true }).catch(() => undefined);
                    }
                } catch { /* malformed URL */ }
            }
        };
        // reloadKey forces re-run when the user seeks past the buffered
        // range — we kick a fresh transcode from the new offset.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.hlsUrl, props.directUrl, props.startSec, reloadKey]);

    // Wire up media events + progress reporting
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        props.onVideoElementReady?.(v);
        return () => {
            props.onVideoElementReady?.(null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot mount/unmount notification
    }, []);

    // Wire up media events + progress reporting
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;

        const onTime = () => setPosition(streamOffsetRef.current + v.currentTime);
        // Prefer the authoritative durationHint (from ffprobe in the DB)
        // when the HLS playlist is still growing — otherwise the displayed
        // duration would step up as new segments are written.
        const onDur = () => {
            const elDur = v.duration || 0;
            const hint = props.durationHint ?? 0;
            // Always prefer the authoritative ffprobe-derived hint when
            // available — HLS event playlists report only the
            // transcoded portion, which would otherwise jitter the UI.
            setDuration(hint > 0 ? hint : elDur);
        };
        const onPlay = () => {
            setPlaying(true);
            // Cancel any pending pause-kill if user resumed quickly.
            if (pauseKillTimerRef.current) {
                clearTimeout(pauseKillTimerRef.current);
                pauseKillTimerRef.current = null;
            }
            if (pausedKilledRef.current && props.hlsUrl) {
                pausedKilledRef.current = false;
                const abs = streamOffsetRef.current + v.currentTime;
                setReloadStart(abs);
                setReloadKey((k) => k + 1);
            } else {
                hlsRef.current?.startLoad();
            }
        };
        const onPause = () => {
            setPlaying(false);
            // Wait a few seconds before killing ffmpeg — short pauses
            // (e.g. user scrubs, or pauses for 2s) shouldn't trigger a
            // session restart on resume. 3s is enough to cover typical
            // pause-to-resume gestures.
            if (pauseKillTimerRef.current) clearTimeout(pauseKillTimerRef.current);
            pauseKillTimerRef.current = setTimeout(() => {
                pauseKillTimerRef.current = null;
                hlsRef.current?.stopLoad();
                if (!props.hlsUrl) return;
                try {
                    const u = new URL(props.hlsUrl);
                    const t = u.searchParams.get("t") ?? "";
                    const usr = u.searchParams.get("u") ?? "";
                    const pauseUrl = `${u.origin}${u.pathname.replace(/\/$/, "")}/pause?t=${encodeURIComponent(t)}&u=${encodeURIComponent(usr)}`;
                    void fetch(pauseUrl, { method: "POST", keepalive: true }).catch(() => undefined);
                    pausedKilledRef.current = true;
                } catch { /* malformed URL */ }
            }, 3000);
        };
        const onVol = () => { setVolume(v.volume); setMuted(v.muted); };
        const onEnter = () => setPipActive(true);
        const onLeave = () => setPipActive(false);
        const onWaiting = () => setBuffering(true);
        const onPlaying = () => setBuffering(false);
        const onCanPlay = () => setBuffering(false);

        v.addEventListener("timeupdate", onTime);
        v.addEventListener("durationchange", onDur);
        v.addEventListener("play", onPlay);
        v.addEventListener("pause", onPause);
        v.addEventListener("volumechange", onVol);
        v.addEventListener("enterpictureinpicture", onEnter);
        v.addEventListener("leavepictureinpicture", onLeave);
        v.addEventListener("waiting", onWaiting);
        v.addEventListener("playing", onPlaying);
        v.addEventListener("canplay", onCanPlay);

        // Tab close / browser quit: fire a beacon so the companion can
        // tear down ffmpeg immediately instead of waiting on the 5-min
        // idle eviction. `pagehide` fires reliably across browsers
        // including bfcache transitions.
        const onPageHide = () => {
            if (!props.hlsUrl) return;
            try {
                const u = new URL(props.hlsUrl);
                const t = u.searchParams.get("t") ?? "";
                const usr = u.searchParams.get("u") ?? "";
                const pauseUrl = `${u.origin}${u.pathname.replace(/\/$/, "")}/pause?t=${encodeURIComponent(t)}&u=${encodeURIComponent(usr)}`;
                if (typeof navigator !== "undefined" && navigator.sendBeacon) navigator.sendBeacon(pauseUrl);
            } catch { /* ignore */ }
        };
        window.addEventListener("pagehide", onPageHide);

        return () => {
            if (pauseKillTimerRef.current) {
                clearTimeout(pauseKillTimerRef.current);
                pauseKillTimerRef.current = null;
            }
            v.removeEventListener("timeupdate", onTime);
            v.removeEventListener("durationchange", onDur);
            v.removeEventListener("play", onPlay);
            v.removeEventListener("pause", onPause);
            v.removeEventListener("volumechange", onVol);
            v.removeEventListener("enterpictureinpicture", onEnter);
            v.removeEventListener("leavepictureinpicture", onLeave);
            v.removeEventListener("waiting", onWaiting);
            v.removeEventListener("playing", onPlaying);
            v.removeEventListener("canplay", onCanPlay);
            window.removeEventListener("pagehide", onPageHide);
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
        const target = Math.max(0, Math.min(duration || s, s));
        const offset = streamOffsetRef.current;
        const local = target - offset;
        // Inside an existing buffered range — native seek works.
        if (local >= 0) {
            const bufs = v.buffered;
            for (let i = 0; i < bufs.length; i++) {
                if (local >= bufs.start(i) - 0.5 && local <= bufs.end(i) + 0.5) {
                    v.currentTime = local;
                    return;
                }
            }
        }
        // Outside what ffmpeg has produced — reload HLS from this offset.
        if (props.hlsUrl) {
            setReloadStart(target);
            setReloadKey((k) => k + 1);
            setPosition(target);
        } else {
            v.currentTime = target;
        }
    };

    // Apply subtitle delay shift to all currently-loaded text track cues.
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        const delta = (subDelayMs - lastDelayRef.current) / 1000;
        if (delta === 0) return;
        for (let i = 0; i < v.textTracks.length; i++) {
            const cues = v.textTracks[i].cues;
            if (!cues) continue;
            for (let j = 0; j < cues.length; j++) {
                const cue = cues[j] as VTTCue;
                cue.startTime += delta;
                cue.endTime += delta;
            }
        }
        lastDelayRef.current = subDelayMs;
    }, [subDelayMs]);

    // Audio-track selection (HLS / multi-stream MP4).
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        const at = (v as HTMLVideoElement & { audioTracks?: { length: number;[i: number]: { enabled: boolean } } }).audioTracks;
        if (!at || audioTrackIdx < 0) return;
        for (let i = 0; i < at.length; i++) at[i].enabled = i === audioTrackIdx;
    }, [audioTrackIdx]);

    // Restore preferred audio track for this show (by lang first, then index).
    useEffect(() => {
        const tracks = props.audioTracks;
        const sid = props.showId;
        if (!tracks?.length || sid == null) return;
        const prefs = getCinemaSettings().preferredAudioByShow ?? {};
        const pref = prefs[String(sid)];
        if (!pref) return;
        let idx = -1;
        if (pref.lang) idx = tracks.findIndex((t) => t.lang === pref.lang);
        if (idx < 0 && pref.index != null) idx = tracks.findIndex((t) => t.index === pref.index);
        if (idx >= 0) setAudioTrackIdx(idx);
    }, [props.audioTracks, props.showId]);

    // Persist user audio-track choice to per-show prefs.
    const setAudioTrack = useCallback((idx: number) => {
        setAudioTrackIdx(idx);
        const sid = props.showId;
        const tracks = props.audioTracks;
        if (sid == null || !tracks?.[idx]) return;
        const t = tracks[idx];
        const cur = getCinemaSettings().preferredAudioByShow ?? {};
        updateCinemaSettings({
            preferredAudioByShow: {
                ...cur,
                [String(sid)]: { lang: t.lang ?? undefined, index: t.index },
            },
        });
    }, [props.showId, props.audioTracks]);

    // Pick the preferred subtitle track based on the user's saved preferences.
    // Reads `window.__mmoWatchPrefs` populated by <WatchPrefsHydrator />.
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        const prefs = (typeof window !== "undefined" && (window as unknown as { __mmoWatchPrefs?: { subtitleLanguages?: string[]; forceSdh?: boolean } }).__mmoWatchPrefs) || null;
        if (!prefs?.subtitleLanguages?.length) return;
        let attempts = 0;
        const pick = () => {
            attempts++;
            const tracks = v.textTracks;
            if (!tracks || tracks.length === 0) {
                if (attempts < 20) setTimeout(pick, 250);
                return;
            }
            // Skip if user already picked one.
            let userPicked = false;
            for (let i = 0; i < tracks.length; i++) if (tracks[i].mode === "showing") userPicked = true;
            if (userPicked) return;
            const order = prefs.subtitleLanguages ?? [];
            let chosen = -1;
            for (const pref of order) {
                const wantSdh = pref.toLowerCase().includes("sdh") || prefs.forceSdh;
                const base = pref.replace(/-sdh$/i, "").toLowerCase();
                for (let i = 0; i < tracks.length; i++) {
                    const t = tracks[i];
                    const lang = (t.language || "").toLowerCase();
                    const label = (t.label || "").toLowerCase();
                    const isSdh = /sdh|cc|captions/i.test(label) || t.kind === "captions";
                    if (lang === base && (!wantSdh || isSdh)) { chosen = i; break; }
                }
                if (chosen >= 0) break;
            }
            if (chosen < 0) {
                // Fallback: first available
                for (const pref of order) {
                    const base = pref.replace(/-sdh$/i, "").toLowerCase();
                    for (let i = 0; i < tracks.length; i++) {
                        if ((tracks[i].language || "").toLowerCase() === base) { chosen = i; break; }
                    }
                    if (chosen >= 0) break;
                }
            }
            if (chosen >= 0) {
                for (let i = 0; i < tracks.length; i++) tracks[i].mode = i === chosen ? "showing" : "disabled";
            }
        };
        const t = setTimeout(pick, 400);
        return () => clearTimeout(t);
    }, [props.subtitleTracks]);

    // Fetch & parse the thumbnail VTT once whenever the URL changes.
    useEffect(() => {
        const url = props.thumbsVttUrl;
        if (!url) { setThumbCues([]); return; }        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(url, { credentials: "omit" });
                if (!res.ok) return;
                const text = await res.text();
                if (cancelled) return;
                const cues = parseThumbsVtt(text, url);
                setThumbCues(cues);
            } catch { /* offline / 503 — silent */ }
        })();
        return () => { cancelled = true; };
    }, [props.thumbsVttUrl]);

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

    const { showControls } = props;
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
                <div
                    className="vp-error"
                    style={{
                        position: "absolute",
                        top: "auto",
                        right: "auto",
                        bottom: "calc(80px + env(safe-area-inset-bottom, 0px))",
                        left: "50%",
                        transform: "translateX(-50%)",
                        maxWidth: "min(560px, calc(100% - 32px))",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        padding: "8px 14px",
                        borderRadius: 8,
                        background: "rgba(180, 30, 30, 0.85)",
                        backdropFilter: "blur(8px)",
                        color: "#fff",
                        fontSize: 12,
                        fontWeight: 500,
                        zIndex: 40,
                        boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
                        pointerEvents: "none",
                        textAlign: "center",
                    }}
                >
                    HLS: {hlsError}
                </div>
            )}

            {buffering && !hlsError && (
                <div
                    style={{
                        position: "absolute", inset: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        pointerEvents: "none", zIndex: 5,
                    }}
                    aria-label="Loading"
                >
                    <div
                        style={{
                            width: 56, height: 56, borderRadius: "50%",
                            border: "3px solid rgba(255,255,255,0.15)",
                            borderTopColor: "rgba(255,255,255,0.85)",
                            animation: "vp-spin 0.9s linear infinite",
                        }}
                    />
                    <style>{`@keyframes vp-spin { to { transform: rotate(360deg); } }`}</style>
                </div>
            )}

            <div className={`vp-controls${(showControls ?? true) && (showControlsState || !playing) ? " is-visible" : ""}`} style={{ display: (showControls ?? true) ? undefined : "none" }}>
                {(props.showTitleOverlay ?? true) && (
                <div className="vp-title">
                    <strong>{props.title}</strong>
                    {props.subtitle && <span> — {props.subtitle}</span>}
                </div>
                )}

                <div className="vp-progress-row">
                    <span className="vp-time">{fmt(position)}</span>
                    <div
                        style={{ position: "relative", flex: 1 }}
                        onMouseMove={(e) => {
                            if (!duration || thumbCues.length === 0) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            const x = e.clientX - rect.left;
                            const time = Math.max(0, Math.min(duration, (x / rect.width) * duration));
                            const cue = thumbCues.find((c) => time >= c.start && time < c.end) ?? thumbCues[thumbCues.length - 1];
                            if (cue) setHoverPreview({ x, cue, time });
                        }}
                        onMouseLeave={() => setHoverPreview(null)}
                    >
                        <input
                            type="range"
                            min={0}
                            max={duration || 0}
                            step={0.1}
                            value={position}
                            onChange={(e) => seek(parseFloat(e.target.value))}
                            className="vp-progress"
                            style={{ width: "100%" }}
                            aria-label="Seek"
                        />
                        {duration > 0 && props.chapters && props.chapters.map((c, i) => (
                            <div
                                key={i}
                                title={c.title}
                                style={{
                                    position: "absolute",
                                    left: `${(c.start / duration) * 100}%`,
                                    top: "50%",
                                    transform: "translate(-50%, -50%)",
                                    width: 2, height: 10,
                                    background: "rgba(255,255,255,0.85)",
                                    pointerEvents: "none",
                                    zIndex: 1,
                                }}
                            />
                        ))}
                        {hoverPreview && (
                            <div
                                style={{
                                    position: "absolute",
                                    left: hoverPreview.x,
                                    bottom: 20,
                                    transform: "translateX(-50%)",
                                    pointerEvents: "none",
                                    zIndex: 5,
                                    background: "rgba(0,0,0,0.75)",
                                    padding: 4,
                                    borderRadius: 6,
                                    boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
                                    display: "flex",
                                    flexDirection: "column",
                                    alignItems: "center",
                                    gap: 2,
                                }}
                            >
                                <div
                                    style={{
                                        width: hoverPreview.cue.w,
                                        height: hoverPreview.cue.h,
                                        backgroundImage: `url(${hoverPreview.cue.sprite})`,
                                        backgroundPosition: `-${hoverPreview.cue.x}px -${hoverPreview.cue.y}px`,
                                        backgroundRepeat: "no-repeat",
                                        borderRadius: 4,
                                    }}
                                />
                                <span style={{ fontSize: 11, color: "white", fontVariantNumeric: "tabular-nums" }}>{fmt(hoverPreview.time)}</span>
                                {(() => {
                                    const chs = props.chapters ?? [];
                                    if (chs.length === 0) return null;
                                    // Find the chapter the hover time falls into.
                                    let cur: { start: number; title: string } | undefined;
                                    for (const c of chs) { if (c.start <= hoverPreview.time) cur = c; else break; }
                                    if (!cur) return null;
                                    return <span style={{ fontSize: 10, color: "rgba(255,255,255,0.75)", maxWidth: 200, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cur.title}</span>;
                                })()}
                            </div>
                        )}
                    </div>
                    <span className="vp-time">{fmt(duration)}</span>
                </div>

                <div className="vp-buttons">
                    <button className="vp-btn vp-btn--primary" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (space)" : "Play (space)"}>
                        {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" style={{ marginLeft: 1 }} />}
                    </button>
                    <button className="vp-btn" onClick={() => seek(position - 10)} aria-label="Înapoi 10s" title="-10s (←)">
                        <SkipBack size={16} />
                        <span className="vp-btn-sub">10</span>
                    </button>
                    <button className="vp-btn" onClick={() => seek(position + 10)} aria-label="Înainte 10s" title="+10s (→)">
                        <span className="vp-btn-sub">10</span>
                        <SkipForward size={16} />
                    </button>

                    <div className="vp-vol-group">
                        <button className="vp-btn" onClick={() => { const v = videoRef.current; if (v) v.muted = !v.muted; }} aria-label={muted ? "Unmute" : "Mute"} title="Mute (m)">
                            {muted || volume === 0 ? <VolumeX size={16} /> : volume < 0.33 ? <Volume size={16} /> : volume < 0.66 ? <Volume1 size={16} /> : <Volume2 size={16} />}
                        </button>
                        <input
                            type="range" min={0} max={1} step={0.01}
                            value={muted ? 0 : volume}
                            onChange={(e) => { const v = videoRef.current; if (!v) return; v.muted = false; v.volume = parseFloat(e.target.value); }}
                            className="vp-vol-slider"
                            aria-label="Volume"
                        />
                    </div>

                    <div className="vp-spacer" />

                    <button className="vp-btn vp-btn--label" onClick={cycleAspect} aria-label="Aspect ratio" title="Aspect ratio (a)">
                        {aspect}
                    </button>
                    <div className="vp-zoom-group">
                        <button className="vp-btn vp-btn--icon-sm" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} aria-label="Zoom out" title="Zoom -">
                            <ZoomOut size={14} />
                        </button>
                        <span className="vp-zoom">{zoom.toFixed(1)}×</span>
                        <button className="vp-btn vp-btn--icon-sm" onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.1).toFixed(2)))} aria-label="Zoom in" title="Zoom +">
                            <ZoomIn size={14} />
                        </button>
                    </div>

                    {(props.subtitleTracks?.length ?? 0) > 0 && (
                        <div className="vp-sub-group" title="Subtitle delay">
                            <Subtitles size={14} className="vp-sub-icon" />
                            <button className="vp-btn vp-btn--icon-sm" onClick={() => setSubDelayMs((d) => d - 50)} aria-label="Subtitle delay -50ms">−</button>
                            <span className="vp-sub-delay">{subDelayMs >= 0 ? "+" : ""}{subDelayMs}ms</span>
                            <button className="vp-btn vp-btn--icon-sm" onClick={() => setSubDelayMs((d) => d + 50)} aria-label="Subtitle delay +50ms">+</button>
                        </div>
                    )}
                    {(props.audioTracks?.length ?? 0) > 1 && (
                        <div className="vp-audio-group">
                            <Languages size={14} className="vp-audio-icon" />
                            <select
                                value={audioTrackIdx}
                                onChange={(e) => setAudioTrack(parseInt(e.target.value, 10))}
                                aria-label="Audio track"
                                className="vp-audio-select"
                            >
                                <option value={-1}>Auto</option>
                                {props.audioTracks!.map((t) => (
                                    <option key={t.index} value={t.index}>{t.label || t.lang || `Track ${t.index + 1}`}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {document.pictureInPictureEnabled && (
                        <button className="vp-btn" onClick={togglePiP} aria-label="Picture in Picture" title="Picture-in-Picture (p)">
                            <PictureInPicture2 size={16} />
                        </button>
                    )}
                    <button className="vp-btn" onClick={toggleFullscreen} aria-label="Fullscreen" title="Fullscreen (f)">
                        {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
                    </button>
                </div>
            </div>

            <style>{`
                .vp-root { position: relative; width: 100%; height: 100%; background: #000; overflow: hidden; }
                .vp-root video { width: 100%; height: 100%; display: block; }

                .vp-controls {
                    position: absolute; left: 0; right: 0; bottom: 0;
                    padding: 2.5rem 1.25rem 1rem;
                    background: linear-gradient(0deg, rgba(0,0,0,.92) 0%, rgba(0,0,0,.6) 55%, transparent 100%);
                    color: #fff;
                    opacity: 0;
                    transform: translateY(8px);
                    transition: opacity 220ms ease, transform 220ms ease;
                    pointer-events: none;
                    -webkit-backdrop-filter: blur(2px);
                    backdrop-filter: blur(2px);
                }
                .vp-controls.is-visible { opacity: 1; transform: none; pointer-events: auto; }

                .vp-title { font-size: .95rem; margin-bottom: .65rem; opacity: .92; letter-spacing: .01em; text-shadow: 0 1px 2px rgba(0,0,0,.5); }
                .vp-title strong { font-weight: 600; }

                /* Progress row */
                .vp-progress-row { display: flex; align-items: center; gap: .85rem; }
                .vp-time { font-variant-numeric: tabular-nums; font-size: .78rem; opacity: .85; min-width: 5ch; letter-spacing: .02em; }
                .vp-progress {
                    flex: 1; appearance: none; -webkit-appearance: none;
                    height: 5px; background: rgba(255,255,255,.18);
                    border-radius: 999px; cursor: pointer;
                    transition: height 140ms ease;
                }
                .vp-progress:hover { height: 7px; }
                .vp-progress::-webkit-slider-thumb {
                    -webkit-appearance: none; appearance: none;
                    width: 14px; height: 14px; border-radius: 50%;
                    background: #ff3366;
                    box-shadow: 0 0 0 4px rgba(255,51,102,.18), 0 2px 6px rgba(0,0,0,.5);
                    cursor: pointer;
                    transition: transform 120ms ease;
                }
                .vp-progress::-webkit-slider-thumb:hover { transform: scale(1.15); }
                .vp-progress::-moz-range-thumb {
                    width: 14px; height: 14px; border: 0; border-radius: 50%;
                    background: #ff3366; cursor: pointer;
                }

                /* Button row */
                .vp-buttons {
                    display: flex; align-items: center; gap: .35rem;
                    margin-top: .65rem; flex-wrap: wrap;
                }

                .vp-btn {
                    display: inline-flex; align-items: center; justify-content: center;
                    gap: .25rem;
                    height: 36px; min-width: 36px; padding: 0 .6rem;
                    background: rgba(255,255,255,.06);
                    color: #fff;
                    border: 1px solid rgba(255,255,255,.08);
                    border-radius: 10px;
                    cursor: pointer; font-size: .78rem; font-weight: 500;
                    line-height: 1;
                    transition: background 140ms ease, border-color 140ms ease, transform 100ms ease, color 140ms ease;
                    -webkit-tap-highlight-color: transparent;
                }
                .vp-btn:hover { background: rgba(255,255,255,.14); border-color: rgba(255,255,255,.16); }
                .vp-btn:active { transform: scale(.96); }
                .vp-btn:focus-visible {
                    outline: none;
                    border-color: rgba(255,51,102,.7);
                    box-shadow: 0 0 0 2px rgba(255,51,102,.25);
                }
                .vp-btn--primary {
                    background: #ff3366;
                    border-color: transparent;
                    width: 44px; height: 44px;
                    border-radius: 50%;
                    box-shadow: 0 4px 14px rgba(255,51,102,.45);
                }
                .vp-btn--primary:hover { background: #ff4775; }
                .vp-btn--label { font-variant-caps: all-small-caps; letter-spacing: .06em; font-weight: 600; }
                .vp-btn--icon-sm { height: 28px; min-width: 28px; padding: 0 .35rem; border-radius: 8px; font-size: .9rem; }
                .vp-btn-sub { font-size: .68rem; font-weight: 600; opacity: .85; font-variant-numeric: tabular-nums; }

                .vp-spacer { flex: 1; }

                /* Grouped pill containers */
                .vp-vol-group, .vp-zoom-group, .vp-sub-group, .vp-audio-group {
                    display: inline-flex; align-items: center; gap: .25rem;
                    padding: 0 .25rem 0 0;
                    background: rgba(255,255,255,.04);
                    border: 1px solid rgba(255,255,255,.06);
                    border-radius: 12px;
                    height: 36px;
                }
                .vp-vol-group .vp-btn,
                .vp-zoom-group .vp-btn,
                .vp-sub-group .vp-btn,
                .vp-audio-group .vp-btn {
                    background: transparent; border-color: transparent;
                }
                .vp-vol-group .vp-btn:hover,
                .vp-zoom-group .vp-btn:hover,
                .vp-sub-group .vp-btn:hover,
                .vp-audio-group .vp-btn:hover {
                    background: rgba(255,255,255,.1);
                }

                .vp-vol-slider {
                    width: 84px; height: 4px;
                    appearance: none; -webkit-appearance: none;
                    background: rgba(255,255,255,.2);
                    border-radius: 999px;
                    margin-right: .5rem;
                    cursor: pointer;
                }
                .vp-vol-slider::-webkit-slider-thumb {
                    -webkit-appearance: none; appearance: none;
                    width: 12px; height: 12px; border-radius: 50%;
                    background: #fff; cursor: pointer;
                    box-shadow: 0 1px 4px rgba(0,0,0,.4);
                }
                .vp-vol-slider::-moz-range-thumb {
                    width: 12px; height: 12px; border: 0; border-radius: 50%;
                    background: #fff; cursor: pointer;
                }

                .vp-zoom { font-size: .72rem; opacity: .9; min-width: 3ch; font-variant-numeric: tabular-nums; text-align: center; }

                .vp-sub-icon, .vp-audio-icon { opacity: .65; margin-left: .5rem; }
                .vp-sub-delay {
                    min-width: 50px; text-align: center;
                    font-variant-numeric: tabular-nums; font-size: .72rem; opacity: .9;
                }

                .vp-audio-select {
                    background: transparent; color: #fff; border: 0;
                    padding: 0 .4rem; font-size: .76rem; font-weight: 500;
                    cursor: pointer; outline: none; max-width: 140px;
                    appearance: none; -webkit-appearance: none;
                    text-overflow: ellipsis;
                }
                .vp-audio-select option { background: #1a1a1a; color: #fff; }

                .vp-error {
                    /* legacy positioning kept by inline style; only kept here for fallback */
                }
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
