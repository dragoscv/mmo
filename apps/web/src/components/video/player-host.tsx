"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { usePathname, useSearchParams } from "next/navigation";
import { usePlayer } from "@/components/player-context";
import { useEQ } from "@/components/eq-context";
import { VideoPlayer } from "@/components/video/player";
import { SubtitlePicker } from "@/components/video/subtitle-picker";
import { SubtitleUploadButton } from "@/components/video/subtitle-upload-button";
import { BookmarkPanel } from "@/components/video/bookmark-panel";
import { WatchPartyPanel, ReactionBurst } from "@/components/video/watch-party-panel";
import { saveProgress, pushDiscordPresence } from "@/actions/video-playback";
import { createPartyRoom } from "@/actions/watch-party";
import { getShowPrefs } from "@/actions/show-prefs";
import { useCinemaSettings } from "@/hooks/use-cinema-settings";
import { useWatchParty } from "@/hooks/use-watch-party";
import { X, Minimize2, Maximize2, PictureInPicture2, SkipForward } from "lucide-react";

/** Canonical mount for the active video. Mounted once at the root layout.
 *  Portals its <VideoPlayer> into one of two surfaces:
 *    - `#np-video-tab-mount`    when Now Playing is open AND the Video tab is active
 *    - `#video-floating-mount`  otherwise, as a draggable PiP-style overlay
 *  This keeps a single <video> element alive across navigation so playback
 *  never pauses when the user switches pages or tabs. */
export function VideoPlayerHost() {
    const player = usePlayer();
    const eq = useEQ();
    const cinema = useCinemaSettings();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const partyParam = searchParams?.get("party") ?? null;
    const [partyRoomId, setPartyRoomId] = useState<string | null>(partyParam);
    const [partyShareUrl, setPartyShareUrl] = useState<string | null>(null);
    useEffect(() => { setPartyRoomId(partyParam); }, [partyParam]);
    const party = useWatchParty(partyRoomId, "You");
    const lastProgressSent = useRef(0);
    const [tabMount, setTabMount] = useState<HTMLElement | null>(null);
    const [tracks, setTracks] = useState<Array<{ src: string; lang: string; label: string; default?: boolean }>>([]);
    const [showCountdown, setShowCountdown] = useState<number | null>(null);
    const [floatingFocused, setFloatingFocused] = useState(false);
    const prevAudioPresetRef = useRef<string | null>(null);
    const prevVolumeRef = useRef<number | null>(null);

    // Poll for the in-tab mount target — only exists when NP view is open
    // and the user is on the Video tab.
    useEffect(() => {
        if (!player.currentVideo) return;
        let raf = 0;
        const tick = () => {
            const el = document.getElementById("np-video-tab-mount");
            setTabMount((cur) => (cur === el ? cur : el));
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [player.currentVideo?.fileId]);

    useEffect(() => {
        // Seed the player's subtitle track list with embedded MKV/MP4
        // streams (text-based only). Auto-pick a default based on the
        // user's cinema language priority + SDH preference; the user
        // can switch via the native CC menu or replace with an online
        // subtitle via the SubtitlePicker.
        const embedded = player.currentVideo?.embeddedSubtitles ?? [];
        if (!embedded.length) {
            setTracks([]);
        } else {
            const prios = cinema.subtitleLangPriority?.length ? cinema.subtitleLangPriority : ["en"];
            const preferSdh = cinema.preferSdh ?? false;
            let defaultIdx = -1;
            for (const lc of prios) {
                const matches = embedded
                    .map((t, i) => ({ t, i }))
                    .filter(({ t }) => t.lang.toLowerCase() === lc.toLowerCase() && !t.forced);
                if (!matches.length) continue;
                const sorted = [...matches].sort((a, b) => {
                    const sdhA = a.t.sdh ? 1 : 0;
                    const sdhB = b.t.sdh ? 1 : 0;
                    return preferSdh ? sdhB - sdhA : sdhA - sdhB;
                });
                defaultIdx = sorted[0].i;
                break;
            }
            setTracks(embedded.map((t, i) => ({
                src: t.src,
                lang: t.lang,
                label: t.label,
                default: i === defaultIdx,
            })));
        }
        lastProgressSent.current = 0;
        setShowCountdown(null);
    }, [player.currentVideo?.fileId, player.currentVideo?.embeddedSubtitles, cinema.subtitleLangPriority, cinema.preferSdh]);

    // Cinema EQ preset auto-switch: remember audio preset, apply cinema one
    // while video is active, restore on close.
    useEffect(() => {
        if (!cinema.cinemaEqPreset) return;
        if (player.currentVideo) {
            if (prevAudioPresetRef.current == null) {
                prevAudioPresetRef.current = eq.activePreset ?? "Flat";
            }
            if (eq.activePreset !== cinema.cinemaEqPreset) {
                eq.applyPreset(cinema.cinemaEqPreset);
            }
        } else if (prevAudioPresetRef.current != null) {
            eq.applyPreset(prevAudioPresetRef.current);
            prevAudioPresetRef.current = null;
        }
    }, [player.currentVideo?.fileId, cinema.cinemaEqPreset, eq, player.currentVideo]);

    // Auto-duck: drop volume to 70% on first video activation, restore on close.
    useEffect(() => {
        if (player.currentVideo) {
            if (prevVolumeRef.current == null) {
                const v = player.volume ?? 0.8;
                prevVolumeRef.current = v;
                player.setVolume(Math.max(0, Math.min(1, v * 0.7)));
            }
        } else if (prevVolumeRef.current != null) {
            player.setVolume(prevVolumeRef.current);
            prevVolumeRef.current = null;
        }
    }, [player.currentVideo?.fileId, player]);

    // Auto-detach to PiP when leaving /watch/*
    useEffect(() => {
        if (!cinema.autoDetachOnNavigate) return;
        if (!player.currentVideo) return;
        if (!pathname?.startsWith("/watch")) {
            if (!player.videoDetached) player.setVideoDetached(true);
        }
    }, [pathname, cinema.autoDetachOnNavigate, player.currentVideo, player.videoDetached, player]);

    // Pause when the page is hidden (if setting enabled)
    useEffect(() => {
        if (!cinema.pauseOnHidden) return;
        const onVis = () => {
            if (document.hidden && player.currentVideo) {
                player.videoTogglePlay();
            }
        };
        document.addEventListener("visibilitychange", onVis);
        return () => document.removeEventListener("visibilitychange", onVis);
    }, [cinema.pauseOnHidden, player]);

    const inTab = !player.videoDetached && player.isNowPlayingOpen && !!tabMount;

    // Keyboard shortcuts — only active when the video surface "owns" the focus:
    // i.e. NP Video tab is open OR floating PiP is hovered/focused.
    useEffect(() => {
        if (!cinema.enableShortcuts) return;
        if (!player.currentVideo) return;
        const surfaceOwnsFocus = inTab || floatingFocused;
        if (!surfaceOwnsFocus) return;
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
            const cur = player.videoCurrentTime;
            const dur = player.videoDuration;
            switch (e.key) {
                case " ":
                case "k":
                case "K":
                    e.preventDefault(); player.videoTogglePlay(); break;
                case "j":
                case "J":
                    e.preventDefault(); player.seekVideo(Math.max(0, cur - 10)); break;
                case "l":
                case "L":
                    e.preventDefault(); player.seekVideo(Math.min(dur, cur + 10)); break;
                case "ArrowLeft":
                    e.preventDefault(); player.seekVideo(Math.max(0, cur - 5)); break;
                case "ArrowRight":
                    e.preventDefault(); player.seekVideo(Math.min(dur, cur + 5)); break;
                case "ArrowUp":
                    e.preventDefault(); player.setVolume(Math.min(1, (player.volume ?? 0.8) + 0.05)); break;
                case "ArrowDown":
                    e.preventDefault(); player.setVolume(Math.max(0, (player.volume ?? 0.8) - 0.05)); break;
                case "f":
                case "F": {
                    e.preventDefault();
                    const root = document.querySelector(".vp-root") as HTMLElement | null;
                    if (root) {
                        if (document.fullscreenElement) document.exitFullscreen();
                        else root.requestFullscreen().catch(() => { /* user gesture */ });
                    }
                    break;
                }
                case "p":
                case "P":
                    e.preventDefault(); player.setVideoDetached(!player.videoDetached); break;
                case "N":
                    if (e.shiftKey) { e.preventDefault(); player.nextVideo(); }
                    break;
                case "m":
                case "M": {
                    e.preventDefault();
                    const v = document.querySelector("video") as HTMLVideoElement | null;
                    if (v) v.muted = !v.muted;
                    break;
                }
                case "c":
                case "C": {
                    e.preventDefault();
                    const v = document.querySelector("video") as HTMLVideoElement | null;
                    if (v && v.textTracks.length) {
                        const anyShowing = Array.from(v.textTracks).some((tt) => tt.mode === "showing");
                        Array.from(v.textTracks).forEach((tt, i) => {
                            tt.mode = anyShowing ? "disabled" : (i === 0 ? "showing" : "disabled");
                        });
                    }
                    break;
                }
                case ".":
                    if (e.shiftKey) {
                        e.preventDefault();
                        const chs = player.currentVideo?.chapters ?? [];
                        const nxt = chs.find(c => c.start > cur + 0.5);
                        if (nxt) player.seekVideo(nxt.start);
                    }
                    break;
                case ",":
                    if (e.shiftKey) {
                        e.preventDefault();
                        const chs = player.currentVideo?.chapters ?? [];
                        const prev = [...chs].reverse().find(c => c.start < cur - 1);
                        if (prev) player.seekVideo(prev.start);
                    }
                    break;
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [cinema.enableShortcuts, player, inTab, floatingFocused]);

    // EBU R128 loudness normalization (applied through the shared audio graph).
    useEffect(() => {
        const enabled = cinema.loudnessNormalization;
        player.setVideoGainDb(enabled ? player.currentVideo?.loudnessGainDb : undefined);
    }, [player, player.currentVideo?.loudnessGainDb, player.currentVideo?.fileId, cinema.loudnessNormalization]);

    // Sleep timer — ticks down once per minute of playback; stops video at 0.
    const [sleepRemainSec, setSleepRemainSec] = useState<number | null>(null);
    useEffect(() => {
        setSleepRemainSec(cinema.sleepTimerMin != null ? cinema.sleepTimerMin * 60 : null);
    }, [cinema.sleepTimerMin, player.currentVideo?.fileId]);
    useEffect(() => {
        if (sleepRemainSec == null || !player.isPlaying) return;
        if (sleepRemainSec <= 0) {
            player.closeVideo();
            setSleepRemainSec(null);
            return;
        }
        const t = setTimeout(() => setSleepRemainSec((r) => (r == null ? null : r - 1)), 1000);
        return () => clearTimeout(t);
    }, [sleepRemainSec, player.isPlaying, player]);

    // Autoplay-next countdown when an episode ends.
    useEffect(() => {
        if (!cinema.autoplayNextEpisode) return;
        if (!player.currentVideo) return;
        const next = player.videoQueue[player.videoQueueIndex + 1];
        if (!next) return;
        if (player.videoDuration > 0 && player.videoCurrentTime >= player.videoDuration - 0.5) {
            if (cinema.autoplayCountdownSec <= 0) {
                player.nextVideo();
                return;
            }
            if (showCountdown == null) setShowCountdown(cinema.autoplayCountdownSec);
        }
    }, [player.videoCurrentTime, player.videoDuration, player.videoQueue, player.videoQueueIndex, cinema.autoplayNextEpisode, cinema.autoplayCountdownSec, player, showCountdown]);

    useEffect(() => {
        if (showCountdown == null) return;
        if (showCountdown <= 0) {
            setShowCountdown(null);
            player.nextVideo();
            return;
        }
        const t = setTimeout(() => setShowCountdown((c) => (c == null ? null : c - 1)), 1000);
        return () => clearTimeout(t);
    }, [showCountdown, player]);

    const onProgress = useCallback((positionSec: number, durationSec: number, ended: boolean) => {
        const v = player.currentVideo;
        if (!v) return;
        const now = Date.now();
        if (!ended && now - lastProgressSent.current < 4500) return;
        lastProgressSent.current = now;
        void saveProgress({
            movieId: v.movieId ?? undefined,
            episodeId: v.episodeId ?? undefined,
            fileId: v.fileId,
            positionSec,
            durationSec,
            completed: ended,
        });
    }, [player.currentVideo]);

    const onPresence = useCallback((s: { title: string; subtitle?: string; progressSec: number; durationSec: number; paused: boolean }) => {
        void pushDiscordPresence(s);
    }, []);

    // Watch Party host: broadcast play/pause/seek to the room.
    const lastStateBroadcastRef = useRef(0);
    useEffect(() => {
        if (!party.connected || !party.isHost) return;
        const v = player.currentVideo;
        if (!v) return;
        const now = Date.now();
        if (now - lastStateBroadcastRef.current < 400) return;
        lastStateBroadcastRef.current = now;
        party.sendState({
            playing: player.isPlaying,
            timeSec: player.videoCurrentTime,
            fileId: String(v.fileId),
            title: v.title,
        });
    }, [party, player.currentVideo, player.isPlaying, player.videoCurrentTime]);

    // Watch Party guest: follow host state — seek when drift > 1.5s, match play/pause.
    useEffect(() => {
        if (!party.connected || party.isHost || !party.state) return;
        if (!player.currentVideo) return;
        const drift = Math.abs(player.videoCurrentTime - party.state.timeSec);
        if (drift > 1.5) {
            player.seekVideo(party.state.timeSec);
        }
        if (party.state.playing !== player.isPlaying) {
            player.videoTogglePlay();
        }
    }, [party.connected, party.isHost, party.state, player]);

    // Watch Party: when a skip-to-chapter vote passes, every member jumps.
    const lastVoteHandledRef = useRef<string | null>(null);
    useEffect(() => {
        const r = party.lastVoteResult;
        if (!r || !r.passed) return;
        if (lastVoteHandledRef.current === r.id) return;
        lastVoteHandledRef.current = r.id;
        player.seekVideo(r.targetTimeSec);
    }, [party.lastVoteResult, player]);

    // Auto-apply per-show preferences (EQ preset, loudness, skip intro/recap)
    // whenever a new show episode loads.
    const lastPrefsShowRef = useRef<number | null>(null);
    useEffect(() => {
        const showId = player.currentVideo?.showId ?? null;
        if (!showId || lastPrefsShowRef.current === showId) return;
        lastPrefsShowRef.current = showId;
        void (async () => {
            const prefs = await getShowPrefs(showId);
            if (!prefs) return;
            if (prefs.eqPreset) eq.applyPreset(prefs.eqPreset);
            if (typeof prefs.loudnessNormalization === "boolean") {
                cinema.update({ loudnessNormalization: prefs.loudnessNormalization });
            }
        })();
    }, [player.currentVideo?.showId, eq, cinema]);

    const addTrack = useCallback((t: { src: string; lang: string; label: string }) => {
        setTracks((cur) => {
            const without = cur.filter((x) => x.lang !== t.lang);
            return [...without, { ...t, default: true }];
        });
    }, []);

    if (!player.currentVideo) return null;

    const video = player.currentVideo;
    const intro = video.introMarker;
    const inIntro = intro && player.videoCurrentTime >= intro.start && player.videoCurrentTime < intro.end;
    const recap = video.recapMarker;
    const inRecap = recap && player.videoCurrentTime >= recap.start && player.videoCurrentTime < recap.end;
    const nextItem = player.videoQueue[player.videoQueueIndex + 1];
    const credits = video.creditsStartSec;
    const inCredits = credits != null && player.videoCurrentTime >= credits && nextItem != null;

    const playerNode = (
        <div style={{ position: "relative", width: "100%", height: "100%" }}>
            <VideoPlayer
                hlsUrl={video.hlsUrl}
                directUrl={video.directUrl}
                poster={video.poster}
                title={video.title}
                subtitle={video.subtitle}
                durationHint={video.durationSec}
                startSec={video.startSec}
                autoplay={video.autoplay !== false}
                subtitleTracks={tracks}
                chapters={video.chapters}
                thumbsVttUrl={video.thumbsVttUrl}
                audioTracks={video.audioTracks}
                showId={video.showId}
                onProgress={onProgress}
                onPresence={onPresence}
                onVideoElementReady={player.registerVideoElement}
                showTitleOverlay={!inTab}
            />
            <div style={{ position: "absolute", top: inTab ? 64 : 12, right: 12, zIndex: 30, display: "flex", gap: 8 }}>
                <SubtitlePicker
                    query={video.subtitleQuery ?? { title: video.title }}
                    onPick={addTrack}
                    autoSelectLangs={cinema.subtitleLangPriority}
                    preferSdh={cinema.preferSdh}
                />
                <SubtitleUploadButton onPick={addTrack} />
                <BookmarkPanel
                    movieId={video.movieId}
                    episodeId={video.episodeId}
                    fileId={video.fileId}
                    currentTime={player.videoCurrentTime}
                    onSeek={player.seekVideo}
                />
                {sleepRemainSec != null && (
                    <div title="Sleep timer" style={{ ...hostBtnStyle, padding: "6px 10px", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                        {Math.floor(sleepRemainSec / 60)}:{String(sleepRemainSec % 60).padStart(2, "0")}
                    </div>
                )}
                <WatchPartyPanel
                    party={party}
                    shareUrl={partyShareUrl}
                    hostBtnStyle={hostBtnStyle}
                    onClose={() => { setPartyRoomId(null); setPartyShareUrl(null); }}
                    onCreate={async () => {
                        const res = await createPartyRoom();
                        if ("ok" in res) {
                            setPartyRoomId(res.roomId);
                            const base = typeof window !== "undefined" ? window.location.origin + window.location.pathname : "";
                            setPartyShareUrl(`${base}${res.shareUrl}`);
                        }
                    }}
                />
                {inTab ? (
                    <button type="button" onClick={() => player.setVideoDetached(true)} title="Detach to floating window (P)" style={hostBtnStyle}>
                        <PictureInPicture2 size={16} />
                    </button>
                ) : (
                    <>
                        <button type="button" onClick={() => { player.setVideoDetached(false); player.openNowPlayingView("video"); }} title="Open in Now Playing" style={hostBtnStyle}>
                            <Maximize2 size={16} />
                        </button>
                        <button type="button" onClick={() => player.closeVideo()} title="Close video" style={{ ...hostBtnStyle, background: "rgba(220,40,60,0.85)" }}>
                            <X size={16} />
                        </button>
                    </>
                )}
            </div>

            {/* Skip intro */}
            {inIntro && intro && (
                <button
                    type="button"
                    onClick={() => player.seekVideo(intro.end)}
                    style={{
                        position: "absolute", bottom: 80, right: 24, zIndex: 35,
                        background: "rgba(0,0,0,0.85)", color: "#fff",
                        border: "1px solid rgba(255,255,255,0.25)",
                        padding: "10px 16px", borderRadius: 999,
                        cursor: "pointer", fontSize: 13, fontWeight: 600,
                        display: "flex", alignItems: "center", gap: 6,
                        backdropFilter: "blur(8px)",
                    }}
                    title="Skip the intro"
                >
                    <SkipForward size={14} /> Skip intro
                </button>
            )}

            {/* Skip recap */}
            {inRecap && recap && !inIntro && (
                <button
                    type="button"
                    onClick={() => player.seekVideo(recap.end)}
                    style={{
                        position: "absolute", bottom: 80, right: 24, zIndex: 35,
                        background: "rgba(0,0,0,0.85)", color: "#fff",
                        border: "1px solid rgba(255,255,255,0.25)",
                        padding: "10px 16px", borderRadius: 999,
                        cursor: "pointer", fontSize: 13, fontWeight: 600,
                        display: "flex", alignItems: "center", gap: 6,
                        backdropFilter: "blur(8px)",
                    }}
                    title="Skip the recap"
                >
                    <SkipForward size={14} /> Skip recap
                </button>
            )}

            {/* Skip credits → next episode */}
            {inCredits && nextItem && (
                <button
                    type="button"
                    onClick={() => player.nextVideo()}
                    style={{
                        position: "absolute", bottom: 80, right: 24, zIndex: 35,
                        background: "rgba(0,0,0,0.85)", color: "#fff",
                        border: "1px solid rgba(255,255,255,0.25)",
                        padding: "10px 16px", borderRadius: 999,
                        cursor: "pointer", fontSize: 13, fontWeight: 600,
                        display: "flex", alignItems: "center", gap: 6,
                        backdropFilter: "blur(8px)",
                    }}
                    title="Play next episode"
                >
                    <SkipForward size={14} /> Next episode
                </button>
            )}

            {/* Netflix-style full overlay countdown */}
            {showCountdown != null && showCountdown > 0 && nextItem && (
                <NextEpisodeOverlay
                    countdown={showCountdown}
                    total={cinema.autoplayCountdownSec}
                    next={nextItem}
                    onPlayNow={() => { setShowCountdown(null); player.nextVideo(); }}
                    onCancel={() => setShowCountdown(null)}
                />
            )}

            {/* Watch party reaction burst overlay */}
            {party.connected && <ReactionBurst reactions={party.reactions} />}
        </div>
    );

    return (
        <StableVideoSurface
            inTab={inTab}
            tabMount={tabMount}
            onFocusChange={setFloatingFocused}
        >
            {playerNode}
        </StableVideoSurface>
    );
}

/** Renders `children` exactly once into a stable detached `<div>` we own,
 *  then DOM-moves that div between the tab slot and the floating frame as
 *  `inTab` toggles. Because the React tree never changes shape and the
 *  underlying DOM element is reparented (not recreated), the inner
 *  `<video>` element — and therefore active playback — survives the
 *  switch. Without this, swapping between `createPortal(…, tabMount)`
 *  and `<FloatingVideoFrame>…</FloatingVideoFrame>` unmounts the player. */
function StableVideoSurface({
    children, inTab, tabMount, onFocusChange,
}: {
    children: React.ReactNode;
    inTab: boolean;
    tabMount: HTMLElement | null;
    onFocusChange: (f: boolean) => void;
}) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    if (hostRef.current == null && typeof document !== "undefined") {
        const el = document.createElement("div");
        el.style.width = "100%";
        el.style.height = "100%";
        hostRef.current = el;
    }
    const [floatingSlot, setFloatingSlot] = useState<HTMLDivElement | null>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const target = inTab && tabMount ? tabMount : floatingSlot;
        if (target && host.parentNode !== target) {
            target.appendChild(host);
        }
    }, [inTab, tabMount, floatingSlot]);

    useEffect(() => () => {
        // Detach on unmount so React's garbage collector can release the host.
        hostRef.current?.remove();
        hostRef.current = null;
    }, []);

    return (
        <>
            {hostRef.current && createPortal(children, hostRef.current)}
            {!inTab && (
                <FloatingVideoFrame onFocusChange={onFocusChange}>
                    <div ref={setFloatingSlot} style={{ width: "100%", height: "100%" }} />
                </FloatingVideoFrame>
            )}
        </>
    );
}

const hostBtnStyle: React.CSSProperties = {
    background: "rgba(0,0,0,0.7)",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 8,
    padding: "6px 8px",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    backdropFilter: "blur(8px)",
};

function NextEpisodeOverlay({ countdown, total, next, onPlayNow, onCancel }: {
    countdown: number;
    total: number;
    next: { title: string; subtitle?: string; poster?: string | null };
    onPlayNow: () => void;
    onCancel: () => void;
}) {
    const radius = 36;
    const circ = 2 * Math.PI * radius;
    const progress = total > 0 ? 1 - (countdown / total) : 0;
    return (
        <div
            style={{
                position: "absolute", inset: 0, zIndex: 60,
                background: "radial-gradient(ellipse at center, rgba(0,0,0,0.75), rgba(0,0,0,0.92))",
                display: "flex", alignItems: "center", justifyContent: "center",
                backdropFilter: "blur(4px)",
            }}
        >
            <div style={{
                display: "flex", gap: 24, alignItems: "center",
                padding: "24px 32px", maxWidth: 720,
                background: "rgba(15,15,18,0.85)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 16,
                boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
            }}>
                {next.poster && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={next.poster} alt="" style={{ width: 120, height: 180, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} />
                )}
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, opacity: 0.6, textTransform: "uppercase", letterSpacing: 1 }}>Next up</div>
                    <h3 style={{ fontSize: 22, fontWeight: 700, margin: "4px 0", color: "#fff" }}>{next.title}</h3>
                    {next.subtitle && <div style={{ fontSize: 13, opacity: 0.75, color: "#fff" }}>{next.subtitle}</div>}
                    <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                        <button
                            type="button"
                            onClick={onPlayNow}
                            style={{
                                background: "#fff", color: "#000",
                                border: "none", borderRadius: 8,
                                padding: "10px 20px", fontWeight: 600,
                                cursor: "pointer", fontSize: 13,
                            }}
                        >
                            Play now
                        </button>
                        <button
                            type="button"
                            onClick={onCancel}
                            style={{
                                background: "rgba(255,255,255,0.15)", color: "#fff",
                                border: "1px solid rgba(255,255,255,0.25)", borderRadius: 8,
                                padding: "10px 20px", fontWeight: 600,
                                cursor: "pointer", fontSize: 13,
                            }}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
                <div style={{ position: "relative", width: 90, height: 90, flexShrink: 0 }}>
                    <svg width="90" height="90" viewBox="0 0 90 90" style={{ transform: "rotate(-90deg)" }}>
                        <circle cx="45" cy="45" r={radius} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="6" />
                        <circle
                            cx="45" cy="45" r={radius} fill="none"
                            stroke="#fff" strokeWidth="6" strokeLinecap="round"
                            strokeDasharray={circ}
                            strokeDashoffset={circ * (1 - progress)}
                            style={{ transition: "stroke-dashoffset 1s linear" }}
                        />
                    </svg>
                    <div style={{
                        position: "absolute", inset: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 28, fontWeight: 700, color: "#fff",
                    }}>{countdown}</div>
                </div>
            </div>
        </div>
    );
}

function FloatingVideoFrame({ children, onFocusChange }: { children: React.ReactNode; onFocusChange: (f: boolean) => void }) {
    const player = usePlayer();
    const [pos, setPos] = useState<{ x: number; y: number; w: number; h: number }>(() => {
        if (typeof window === "undefined") return { x: 16, y: 16, w: 360, h: 200 };
        try {
            const raw = localStorage.getItem("mmo-video-pip");
            if (raw) return JSON.parse(raw);
        } catch { /* ignore */ }
        return {
            x: Math.max(16, window.innerWidth - 376),
            y: Math.max(16, window.innerHeight - 320),
            w: 360,
            h: 200,
        };
    });
    const drag = useRef<{ ox: number; oy: number; px: number; py: number } | null>(null);

    useEffect(() => {
        try { localStorage.setItem("mmo-video-pip", JSON.stringify(pos)); } catch { /* ignore */ }
    }, [pos]);

    const onMouseDown = (e: React.MouseEvent) => {
        drag.current = { ox: e.clientX, oy: e.clientY, px: pos.x, py: pos.y };
        const onMove = (ev: MouseEvent) => {
            if (!drag.current) return;
            const dx = ev.clientX - drag.current.ox;
            const dy = ev.clientY - drag.current.oy;
            setPos((p) => ({ ...p, x: Math.max(0, drag.current!.px + dx), y: Math.max(0, drag.current!.py + dy) }));
        };
        const onUp = () => {
            drag.current = null;
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    };

    return (
        <div
            tabIndex={0}
            onMouseEnter={() => onFocusChange(true)}
            onMouseLeave={() => onFocusChange(false)}
            onFocus={() => onFocusChange(true)}
            onBlur={() => onFocusChange(false)}
            style={{
                position: "fixed",
                left: pos.x, top: pos.y, width: pos.w, height: pos.h,
                zIndex: 55, background: "#000",
                borderRadius: 12, overflow: "hidden",
                boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
                border: "1px solid rgba(255,255,255,0.08)",
                resize: "both", minWidth: 200, minHeight: 120,
                outline: "none",
            }}
            onMouseDown={onMouseDown}
        >
            {children}
            <div
                style={{
                    position: "absolute", top: 0, left: 0, right: 0, height: 18,
                    cursor: "move",
                    background: "linear-gradient(180deg, rgba(0,0,0,0.5), transparent)",
                    zIndex: 25,
                }}
            />
            {player.videoDetached && (
                <button
                    type="button"
                    onClick={() => player.setVideoDetached(false)}
                    title="Reattach to Now Playing"
                    style={{
                        position: "absolute", top: 4, left: 4, zIndex: 30,
                        background: "rgba(0,0,0,0.7)", color: "#fff",
                        border: "1px solid rgba(255,255,255,0.15)",
                        borderRadius: 6, padding: "3px 6px",
                        cursor: "pointer", fontSize: 11,
                    }}
                >
                    <Minimize2 size={12} />
                </button>
            )}
        </div>
    );
}
