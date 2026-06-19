"use client";

import {
    createContext,
    useContext,
    useState,
    useRef,
    useCallback,
    useEffect,
    type ReactNode,
} from "react";
import { getCinemaSettings } from "@/hooks/use-cinema-settings";
import type { Track } from "@/db/schema";
import { audioPreloadCache } from "@/lib/audio-preload-cache";
import { useRenderCount, dlog } from "@/lib/dev-debugger";

type RepeatMode = "off" | "one" | "all";

/** Serializable description of a playable video — passed through server
 *  actions so it must contain only primitive / JSON-safe fields. */
export interface VideoMedia {
    fileId: number;
    movieId?: number | null;
    episodeId?: number | null;
    /** Show id when this video is an episode — used for per-show prefs. */
    showId?: number | null;
    title: string;
    subtitle?: string;
    poster?: string | null;
    hlsUrl: string;
    directUrl?: string | null;
    durationSec?: number | null;
    startSec?: number;
    /** TMDB / IMDB metadata for subtitle picker. */
    subtitleQuery?: {
        title?: string;
        tmdbId?: number;
        imdbId?: string;
        kind?: "movie" | "tv";
        season?: number;
        episode?: number;
    };
    /** Optional intro skip range (seconds). UI shows "Skip Intro" while playhead is inside. */
    introMarker?: { start: number; end: number };
    /** Optional chapters for the chapter-skip UI. */
    chapters?: Array<{ start: number; title: string }>;
    /** WebVTT URL with sprite#xywh cues for scrubber preview thumbnails. */
    thumbsVttUrl?: string;
    /** Optional recap window (start/end in seconds) when previous episode
     *  chromaprint match yields one. */
    recapMarker?: { start: number; end: number };
    /** Time (s) where end-credits start — drives the Skip Credits button. */
    creditsStartSec?: number;
    /** EBU R128 normalization gain in dB (negative or positive). */
    loudnessGainDb?: number;
    /** Per-stream audio tracks parsed from ffprobe. */
    audioTracks?: Array<{ index: number; lang?: string; label?: string; codec?: string }>;
    /** Embedded subtitle streams (text-based: subrip/ass/mov_text/webvtt).
     *  Each entry points to the companion's WebVTT extraction endpoint —
     *  the actual ffmpeg conversion only happens when the browser fetches
     *  the URL, so listing them is free. Image-based subs (PGS, DVDsub)
     *  are filtered out server-side. */
    embeddedSubtitles?: Array<{
        src: string;
        lang: string;
        label: string;
        sdh?: boolean;
        forced?: boolean;
        codec?: string;
        default?: boolean;
    }>;
    /** Should playback begin automatically when this media loads?
     *  Defaults to true. Set to false when restoring a previously-
     *  playing video on page reload — we want the user to press play. */
    autoplay?: boolean;
}

interface PlayerState {
    currentTrack: Track | null;
    isPlaying: boolean;
    duration: number;
    currentTime: number;
    volume: number;
    queue: Track[];
    queueIndex: number;
    shuffle: boolean;
    repeat: RepeatMode;
    isNowPlayingOpen: boolean;
    requestedView: string | null;
    playHistory: Track[];
    /** When set, the player is in video mode. Audio is paused. */
    currentVideo: VideoMedia | null;
    videoQueue: VideoMedia[];
    videoQueueIndex: number;
    videoCurrentTime: number;
    videoDuration: number;
    /** True when video is playing in a floating PiP-style overlay. */
    videoDetached: boolean;
    /** Which media drove the bar most recently (most-recent-wins UI). */
    lastMediaType: "audio" | "video" | null;
}

interface PlayerActions {
    play: (track: Track, queue?: Track[]) => void;
    pause: () => void;
    resume: () => void;
    togglePlay: () => void;
    next: () => void;
    prev: () => void;
    seek: (time: number) => void;
    setVolume: (volume: number) => void;
    setQueue: (tracks: Track[], startIndex?: number) => void;
    addToQueue: (track: Track) => void;
    removeFromQueue: (index: number) => void;
    moveInQueue: (from: number, to: number) => void;
    clearQueue: () => void;
    playFromQueue: (index: number) => void;
    toggleShuffle: () => void;
    toggleRepeat: () => void;
    openNowPlaying: () => void;
    openNowPlayingView: (view: string) => void;
    closeNowPlaying: () => void;
    toggleNowPlaying: () => void;
    clearRequestedView: () => void;
    getAnalyserNode: () => AnalyserNode | null;
    getAudioNodes: () => { ctx: AudioContext; source: MediaElementAudioSourceNode; analyser: AnalyserNode } | null;
    getVideoNodes: () => { ctx: AudioContext; source: MediaElementAudioSourceNode; analyser: AnalyserNode } | null;
    // ─── Video ──────────────────────────────────────────────────────
    playVideo: (video: VideoMedia, queue?: VideoMedia[]) => void;
    closeVideo: () => void;
    nextVideo: () => void;
    prevVideo: () => void;
    seekVideo: (time: number) => void;
    videoTogglePlay: () => void;
    setVideoDetached: (detached: boolean) => void;
    /** Called by the canonical <VideoPlayer> mount to register its <video>
     *  element. Pipes audio into the shared AudioContext and mirrors
     *  play/pause/seek into PlayerState. Pass null to unregister. */
    registerVideoElement: (el: HTMLVideoElement | null) => void;
    /** Apply EBU R128 normalization gain (in dB). Pass 0/undefined to reset. */
    setVideoGainDb: (db: number | undefined) => void;
    /** Append a video to the end of the video queue. */
    addToVideoQueue: (video: VideoMedia) => void;
    /** Insert a video right after the currently-playing one (Play Next). */
    playVideoNext: (video: VideoMedia) => void;
}

type PlayerContextType = PlayerState & PlayerActions;

const PlayerContext = createContext<PlayerContextType | null>(null);

export function usePlayer() {
    const ctx = useContext(PlayerContext);
    if (!ctx) throw new Error("usePlayer must be used within PlayerProvider");
    return ctx;
}

const STORAGE_KEY = "music-organizer-player";

interface PersistedState {
    currentTrack: Track | null;
    queue: Track[];
    queueIndex: number;
    volume: number;
    shuffle: boolean;
    repeat: RepeatMode;
    currentTime: number;
    playHistory: Track[];
    isNowPlayingOpen?: boolean;
    currentVideo?: VideoMedia | null;
    videoQueue?: VideoMedia[];
    videoQueueIndex?: number;
    videoCurrentTime?: number;
    lastMediaType?: "audio" | "video" | null;
}

function loadPersistedState(): Partial<PlayerState> {
    if (typeof window === "undefined") return {};
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const saved: PersistedState = JSON.parse(raw);
        const restoreNowPlaying = localStorage.getItem("mmo-restore-now-playing") === "true";
        return {
            currentTrack: saved.currentTrack ?? null,
            queue: saved.queue ?? [],
            queueIndex: saved.queueIndex ?? -1,
            volume: saved.volume ?? 0.8,
            shuffle: saved.shuffle ?? false,
            repeat: saved.repeat ?? "off",
            currentTime: saved.currentTime ?? 0,
            playHistory: saved.playHistory ?? [],
            isPlaying: false,
            isNowPlayingOpen: restoreNowPlaying ? (saved.isNowPlayingOpen ?? false) : false,
            currentVideo: saved.currentVideo ?? null,
            videoQueue: saved.videoQueue ?? [],
            videoQueueIndex: saved.videoQueueIndex ?? -1,
            videoCurrentTime: saved.videoCurrentTime ?? 0,
            lastMediaType: saved.lastMediaType ?? null,
        };
    } catch {
        return {};
    }
}

function savePersistedState(s: PlayerState) {
    try {
        const data: PersistedState = {
            currentTrack: s.currentTrack,
            queue: s.queue.slice(0, 200), // Cap to prevent huge payloads
            queueIndex: s.queueIndex,
            volume: s.volume,
            shuffle: s.shuffle,
            repeat: s.repeat,
            currentTime: s.currentTime,
            playHistory: s.playHistory.slice(0, 50),
            isNowPlayingOpen: s.isNowPlayingOpen,
            currentVideo: s.currentVideo,
            videoQueue: s.videoQueue.slice(0, 50),
            videoQueueIndex: s.videoQueueIndex,
            videoCurrentTime: s.videoCurrentTime,
            lastMediaType: s.lastMediaType,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
        // localStorage full or unavailable
    }
}

export function PlayerProvider({ children }: { children: ReactNode }) {
    useRenderCount("PlayerProvider");
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
    const videoElRef = useRef<HTMLVideoElement | null>(null);
    const videoSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
    const videoGainRef = useRef<GainNode | null>(null);
    const videoElListenersRef = useRef<{ el: HTMLVideoElement; cleanup: () => void } | null>(null);

    // Safe play helper — resumes AudioContext (browser autoplay policy) and
    // catches AbortError when src changes mid-play
    const safePlay = (audio: HTMLAudioElement) => {
        if (audioContextRef.current?.state === "suspended") {
            audioContextRef.current.resume();
        }
        audio.play().catch(() => {
            // AbortError is expected when a new load interrupts play()
        });
    };
    const [state, setState] = useState<PlayerState>({
        currentTrack: null,
        isPlaying: false,
        duration: 0,
        currentTime: 0,
        volume: 0.8,
        queue: [],
        queueIndex: -1,
        shuffle: false,
        repeat: "off",
        isNowPlayingOpen: false,
        requestedView: null,
        playHistory: [],
        currentVideo: null,
        videoQueue: [],
        videoQueueIndex: -1,
        videoCurrentTime: 0,
        videoDuration: 0,
        videoDetached: false,
        lastMediaType: null,
    });

    // Restore persisted state after mount to avoid hydration mismatch
    useEffect(() => {
        const persisted = loadPersistedState();
        if (persisted.currentTrack || persisted.currentVideo) {
            // Bake the saved playhead into the VideoMedia so VideoPlayer
            // resumes at the right position on first mount.
            const restoredVideo = persisted.currentVideo
                ? { ...persisted.currentVideo, startSec: persisted.videoCurrentTime ?? persisted.currentVideo.startSec ?? 0, autoplay: false }
                : null;
            // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only localStorage hydration after SSR
            setState((prev) => ({
                ...prev,
                ...persisted,
                currentVideo: restoredVideo,
                lastMediaType: persisted.lastMediaType ?? (restoredVideo ? "video" : persisted.currentTrack ? "audio" : null),
                requestedView: restoredVideo ? "video" : null,
            }));
        }
    }, []);

    // ─── Media Session API — OS media controls ──────────────────────────
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;

        const track = state.currentTrack;
        if (!track) {
            navigator.mediaSession.metadata = null;
            return;
        }

        const artwork: MediaImage[] = track.artworkUrl
            ? [{ src: track.artworkUrl, sizes: "512x512", type: "image/jpeg" }]
            : [];

        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title || track.filename,
            artist: track.artist || "Unknown Artist",
            album: track.album || "",
            artwork,
        });
    }, [state.currentTrack?.id, state.currentTrack?.title, state.currentTrack?.artist, state.currentTrack?.album, state.currentTrack?.artworkUrl, state.currentTrack?.filename]);

    // Update document title for PWA taskbar — persists even when paused
    const lastTrackTitleRef = useRef<string | null>(null);

    const applyTitle = useCallback(() => {
        const newTitle = lastTrackTitleRef.current || "MMO";
        document.title = newTitle;
        const titleEl = document.querySelector("title");
        if (titleEl && titleEl.textContent !== newTitle) {
            titleEl.textContent = newTitle;
        }
    }, []);

    useEffect(() => {
        const track = state.currentTrack;
        if (track) {
            const name = track.title || track.filename;
            const artist = track.artist || "Unknown Artist";
            lastTrackTitleRef.current = `${name} — ${artist} | MMO`;
        }
        applyTitle();
    }, [state.currentTrack?.id, state.currentTrack?.title, state.currentTrack?.artist, state.currentTrack?.filename, applyTitle]);

    // Re-apply title when Next.js overrides it on route changes
    useEffect(() => {
        const titleEl = document.querySelector("title");
        if (!titleEl) return;
        const observer = new MutationObserver(() => {
            if (lastTrackTitleRef.current && titleEl.textContent !== lastTrackTitleRef.current) {
                titleEl.textContent = lastTrackTitleRef.current;
            }
        });
        observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
        return () => observer.disconnect();
    }, []);

    // Update playback state for OS controls
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        navigator.mediaSession.playbackState = state.isPlaying ? "playing" : "paused";
    }, [state.isPlaying]);

    // Update position state for OS seek bar
    useEffect(() => {
        if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
        if (state.duration > 0) {
            try {
                navigator.mediaSession.setPositionState({
                    duration: state.duration,
                    playbackRate: 1,
                    position: Math.min(state.currentTime, state.duration),
                });
            } catch {
                // Invalid state (e.g., position > duration during track change)
            }
        }
    }, [Math.floor(state.currentTime), state.duration]);

    // Helper: transition to a new track, pushing the old one to history
    const withHistory = (s: PlayerState, newTrack: Track, newIndex: number): Partial<PlayerState> => {
        const history = s.currentTrack
            ? [s.currentTrack, ...s.playHistory].slice(0, 100)
            : s.playHistory;
        // Starting audio playback always supersedes video — close any active video.
        if (s.currentVideo) videoElRef.current?.pause();
        return {
            currentTrack: newTrack,
            queueIndex: newIndex,
            isPlaying: true,
            currentTime: 0,
            playHistory: history,
            lastMediaType: "audio",
            // Drop any active video so the bar/now-playing flips to audio.
            currentVideo: null,
            videoQueue: [],
            videoQueueIndex: -1,
            videoCurrentTime: 0,
            videoDuration: 0,
            videoDetached: false,
        };
    };

    // We need a ref for repeat/shuffle so the ended handler sees latest values
    const repeatRef = useRef(state.repeat);
    const shuffleRef = useRef(state.shuffle);
    useEffect(() => {
        repeatRef.current = state.repeat;
    }, [state.repeat]);
    useEffect(() => {
        shuffleRef.current = state.shuffle;
    }, [state.shuffle]);

    // Persist state to localStorage (debounced for currentTime)
    const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const lastSavedTimeRef = useRef(0);
    const stateRef = useRef(state);
    useEffect(() => { stateRef.current = state; });

    useEffect(() => {
        // Save immediately on track/queue/settings changes; debounce
        // currentTime / videoCurrentTime saves (every 5 seconds).
        const audioTimeDiff = Math.abs(state.currentTime - lastSavedTimeRef.current);
        const videoTimeDiff = Math.abs(state.videoCurrentTime - lastSavedTimeRef.current);
        if (audioTimeDiff >= 5 || videoTimeDiff >= 5 || state.currentTrack?.id !== undefined || state.currentVideo?.fileId !== undefined) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => {
                savePersistedState(state);
                lastSavedTimeRef.current = state.currentVideo ? state.videoCurrentTime : state.currentTime;
            }, 500);
        }
        return () => clearTimeout(saveTimerRef.current);
    }, [state.currentTrack?.id, state.currentVideo?.fileId, state.queueIndex, state.videoQueueIndex, state.volume, state.shuffle, state.repeat, state.queue.length, state.videoQueue.length, state.playHistory.length, state.currentTime, state.videoCurrentTime, state.isNowPlayingOpen, state.lastMediaType]);

    // Force save on page unload (refresh/close)
    useEffect(() => {
        const handleUnload = () => {
            savePersistedState(stateRef.current);
        };
        window.addEventListener("beforeunload", handleUnload);
        return () => window.removeEventListener("beforeunload", handleUnload);
    }, []);

    // On mount: create <audio> element and preload saved track (paused)
    useEffect(() => {
        const audio = new Audio();
        audio.volume = state.volume;
        audio.crossOrigin = "anonymous";
        audioRef.current = audio;

        // Setup Web Audio API for visualizations
        try {
            const ctx = new AudioContext();
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            analyser.smoothingTimeConstant = 0.8;
            const source = ctx.createMediaElementSource(audio);
            source.connect(analyser);
            analyser.connect(ctx.destination);
            audioContextRef.current = ctx;
            analyserRef.current = analyser;
            sourceRef.current = source;
        } catch {
            // Web Audio API not available — visualizations won't work
        }

        audio.addEventListener("timeupdate", () => {
            setState((s) => ({ ...s, currentTime: audio.currentTime }));
        });
        audio.addEventListener("loadedmetadata", () => {
            setState((s) => ({ ...s, duration: audio.duration }));
        });
        audio.addEventListener("ended", () => {
            setState((s) => {
                const repeat = repeatRef.current;
                const shuffle = shuffleRef.current;

                // Repeat one: replay same track
                if (repeat === "one") {
                    audio.currentTime = 0;
                    safePlay(audio);
                    return { ...s, currentTime: 0, isPlaying: true };
                }

                // Determine next index
                let nextIdx: number;
                if (shuffle) {
                    // Pick a random track that isn't the current one
                    if (s.queue.length <= 1) return { ...s, isPlaying: false };
                    do {
                        nextIdx = Math.floor(Math.random() * s.queue.length);
                    } while (nextIdx === s.queueIndex && s.queue.length > 1);
                } else {
                    nextIdx = s.queueIndex + 1;
                }

                // Check bounds
                if (nextIdx >= s.queue.length) {
                    if (repeat === "all") {
                        nextIdx = 0; // Loop back
                    } else {
                        return { ...s, isPlaying: false };
                    }
                }

                const nextTrack = s.queue[nextIdx];
                if (nextTrack) {
                    audio.src = audioPreloadCache.getUrl(nextTrack.id);
                    safePlay(audio);
                    // Preload upcoming tracks
                    const upcoming = s.queue.slice(nextIdx + 1, nextIdx + 4).map(t => t.id);
                    if (upcoming.length) audioPreloadCache.preloadMany(upcoming);
                    return { ...s, ...withHistory(s, nextTrack, nextIdx) };
                }
                return { ...s, isPlaying: false };
            });
        });
        audio.addEventListener("error", () => {
            setState((s) => ({ ...s, isPlaying: false }));
        });

        // Restore saved track into audio element (paused) so the bar shows
        const saved = loadPersistedState();
        if (saved.currentTrack) {
            const savedTime = saved.currentTime ?? 0;
            audio.src = audioPreloadCache.getUrl(saved.currentTrack.id);
            // Preload current + next tracks from saved queue
            audioPreloadCache.preload(saved.currentTrack.id).then(url => {
                if (audioRef.current && audioRef.current.src !== url) {
                    const wasTime = audioRef.current.currentTime;
                    audioRef.current.src = url;
                    audioRef.current.addEventListener("loadedmetadata", () => {
                        if (wasTime > 0) audioRef.current!.currentTime = wasTime;
                    }, { once: true });
                }
            }).catch(() => { });
            const savedIdx = saved.queueIndex ?? 0;
            const savedQueue = saved.queue ?? [];
            const nextIds = savedQueue.slice(savedIdx + 1, savedIdx + 4).map(t => t.id);
            if (nextIds.length) audioPreloadCache.preloadMany(nextIds);
            // Seek to saved position once metadata loads
            const restoreTime = () => {
                if (savedTime > 0 && savedTime < audio.duration) {
                    audio.currentTime = savedTime;
                }
                audio.removeEventListener("loadedmetadata", restoreTime);
            };
            audio.addEventListener("loadedmetadata", restoreTime);
        }

        return () => {
            audio.pause();
            audio.src = "";
            audioContextRef.current?.close();
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const getAnalyserNode = useCallback(() => {
        // Resume audio context if it was suspended (browser autoplay policy)
        if (audioContextRef.current?.state === "suspended") {
            audioContextRef.current.resume();
        }
        return analyserRef.current;
    }, []);

    const getAudioNodes = useCallback(() => {
        if (!audioContextRef.current || !sourceRef.current || !analyserRef.current) return null;
        if (audioContextRef.current.state === "suspended") {
            audioContextRef.current.resume();
        }
        return {
            ctx: audioContextRef.current,
            source: sourceRef.current,
            analyser: analyserRef.current,
        };
    }, []);

    const getVideoNodes = useCallback(() => {
        if (!audioContextRef.current || !videoSourceRef.current || !analyserRef.current) return null;
        if (audioContextRef.current.state === "suspended") {
            audioContextRef.current.resume();
        }
        return {
            ctx: audioContextRef.current,
            source: videoSourceRef.current,
            analyser: analyserRef.current,
        };
    }, []);

    const play = useCallback((track: Track, queue?: Track[]) => {
        const audio = audioRef.current;
        if (!audio) return;
        // Prefer a pinned offline blob (no device needed), else network stream.
        // resolveUrl is async (IndexedDB lookup); set a sane src immediately so
        // playback starts fast, then upgrade to the offline blob if one exists.
        audio.src = audioPreloadCache.getUrl(track.id);
        void audioPreloadCache.resolveUrl(track.id).then((url) => {
            const a = audioRef.current;
            // Swap to the offline blob only at the very start of playback so we
            // never restart a stream the user is already hearing.
            if (a && url.startsWith("blob:") && a.currentSrc !== url && a.currentTime < 0.5) {
                const wasPlaying = !a.paused;
                a.src = url;
                if (wasPlaying) void safePlay(a);
            }
        }).catch(() => { });
        audioPreloadCache.preload(track.id).catch(() => { });
        safePlay(audio);
        setState((s) => {
            const newQueue = queue || s.queue;
            const idx = newQueue.findIndex((t) => t.id === track.id);
            const newIndex = idx >= 0 ? idx : 0;
            // Preload next 3 tracks in queue
            const upcoming = newQueue.slice(newIndex + 1, newIndex + 4).map(t => t.id);
            if (upcoming.length) audioPreloadCache.preloadMany(upcoming);
            return {
                ...s,
                ...withHistory(s, track, newIndex),
                queue: newQueue,
            };
        });

        // Auto-queue stems analysis for first-time plays
        if (!track.stemsStatus) {
            import("@/actions/stems").then(({ updateStemsStatus }) => {
                updateStemsStatus(track.id, "pending").catch(() => { });
            });
        }
    }, []);

    const pause = useCallback(() => {
        audioRef.current?.pause();
        setState((s) => ({ ...s, isPlaying: false }));
    }, []);

    const resume = useCallback(() => {
        if (audioRef.current) safePlay(audioRef.current);
        setState((s) => ({ ...s, isPlaying: true }));
    }, []);

    const togglePlay = useCallback(() => {
        if (state.isPlaying) {
            pause();
        } else if (state.currentTrack) {
            resume();
        }
    }, [state.isPlaying, state.currentTrack, pause, resume]);

    const next = useCallback(() => {
        setState((s) => {
            let nextIdx: number;
            if (shuffleRef.current) {
                if (s.queue.length <= 1) return s;
                do {
                    nextIdx = Math.floor(Math.random() * s.queue.length);
                } while (nextIdx === s.queueIndex && s.queue.length > 1);
            } else {
                nextIdx = s.queueIndex + 1;
            }

            if (nextIdx >= s.queue.length) {
                if (repeatRef.current === "all") nextIdx = 0;
                else return s;
            }

            const nextTrack = s.queue[nextIdx];
            if (!nextTrack) return s;
            const audio = audioRef.current;
            if (audio) {
                audio.src = audioPreloadCache.getUrl(nextTrack.id);
                safePlay(audio);
            }
            // Preload upcoming
            const upcoming = s.queue.slice(nextIdx + 1, nextIdx + 4).map(t => t.id);
            if (upcoming.length) audioPreloadCache.preloadMany(upcoming);
            return { ...s, ...withHistory(s, nextTrack, nextIdx) };
        });
    }, []);

    const prev = useCallback(() => {
        const audio = audioRef.current;
        if (audio && audio.currentTime > 3) {
            audio.currentTime = 0;
            return;
        }
        setState((s) => {
            if (s.queueIndex > 0) {
                const prevIdx = s.queueIndex - 1;
                const prevTrack = s.queue[prevIdx];
                if (audio) {
                    audio.src = audioPreloadCache.getUrl(prevTrack.id);
                    safePlay(audio);
                }
                return { ...s, ...withHistory(s, prevTrack, prevIdx) };
            }
            return s;
        });
    }, []);

    const seek = useCallback((time: number) => {
        const audio = audioRef.current;
        if (audio) {
            audio.currentTime = time;
            setState((s) => ({ ...s, currentTime: time }));
        }
    }, []);

    const setVolume = useCallback((volume: number) => {
        const audio = audioRef.current;
        if (audio) audio.volume = volume;
        const v = videoElRef.current;
        if (v) v.volume = volume;
        setState((s) => ({ ...s, volume }));
    }, []);

    const setQueue = useCallback((tracks: Track[], startIndex?: number) => {
        setState((s) => ({
            ...s,
            queue: tracks,
            queueIndex: startIndex ?? s.queueIndex,
        }));
    }, []);

    const addToQueue = useCallback((track: Track) => {
        setState((s) => {
            // Avoid duplicates right after current position
            const exists = s.queue.some((t) => t.id === track.id);
            if (exists) return s;
            // Insert after the current track in the queue
            const insertAt = s.queueIndex + 1;
            const newQueue = [...s.queue];
            newQueue.splice(insertAt, 0, track);
            return { ...s, queue: newQueue };
        });
    }, []);

    const removeFromQueue = useCallback((index: number) => {
        setState((s) => {
            if (index === s.queueIndex) return s; // Can't remove currently playing
            const newQueue = s.queue.filter((_, i) => i !== index);
            const newIndex = index < s.queueIndex ? s.queueIndex - 1 : s.queueIndex;
            return { ...s, queue: newQueue, queueIndex: newIndex };
        });
    }, []);

    const moveInQueue = useCallback((from: number, to: number) => {
        setState((s) => {
            const newQueue = [...s.queue];
            const [moved] = newQueue.splice(from, 1);
            newQueue.splice(to, 0, moved);
            // Adjust current index
            let newIndex = s.queueIndex;
            if (from === s.queueIndex) {
                newIndex = to;
            } else if (from < s.queueIndex && to >= s.queueIndex) {
                newIndex--;
            } else if (from > s.queueIndex && to <= s.queueIndex) {
                newIndex++;
            }
            return { ...s, queue: newQueue, queueIndex: newIndex };
        });
    }, []);

    const clearQueue = useCallback(() => {
        setState((s) => {
            if (!s.currentTrack) return { ...s, queue: [], queueIndex: -1 };
            // Keep only the current track
            return { ...s, queue: [s.currentTrack], queueIndex: 0 };
        });
    }, []);

    const playFromQueue = useCallback((index: number) => {
        setState((s) => {
            const track = s.queue[index];
            if (!track) return s;
            const audio = audioRef.current;
            if (audio) {
                audio.src = audioPreloadCache.getUrl(track.id);
                safePlay(audio);
            }
            // Preload upcoming
            const upcoming = s.queue.slice(index + 1, index + 4).map(t => t.id);
            if (upcoming.length) audioPreloadCache.preloadMany(upcoming);
            return { ...s, ...withHistory(s, track, index) };
        });
    }, []);

    const toggleShuffle = useCallback(() => {
        setState((s) => ({ ...s, shuffle: !s.shuffle }));
    }, []);

    const toggleRepeat = useCallback(() => {
        setState((s) => {
            const modes: RepeatMode[] = ["off", "all", "one"];
            const idx = modes.indexOf(s.repeat);
            return { ...s, repeat: modes[(idx + 1) % 3] };
        });
    }, []);

    const openNowPlaying = useCallback(() => {
        setState((s) => ({ ...s, isNowPlayingOpen: true }));
    }, []);

    const openNowPlayingView = useCallback((view: string) => {
        setState((s) => ({ ...s, isNowPlayingOpen: true, requestedView: view }));
    }, []);

    const closeNowPlaying = useCallback(() => {
        setState((s) => ({ ...s, isNowPlayingOpen: false }));
    }, []);

    const toggleNowPlaying = useCallback(() => {
        setState((s) => ({ ...s, isNowPlayingOpen: !s.isNowPlayingOpen }));
    }, []);

    const clearRequestedView = useCallback(() => {
        setState((s) => ({ ...s, requestedView: null }));
    }, []);

    // ─── Video playback ──────────────────────────────────────────────────
    const playVideo = useCallback((video: VideoMedia, queue?: VideoMedia[]) => {
        // Stop audio completely so the bar/now-playing surfaces flip cleanly to video.
        const audio = audioRef.current;
        if (audio) {
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
        }
        setState((s) => {
            const newQueue = queue && queue.length ? queue : [video];
            const idx = newQueue.findIndex((vv) => vv.fileId === video.fileId);
            return {
                ...s,
                currentTrack: null,
                queue: [],
                queueIndex: -1,
                isPlaying: false,
                currentTime: 0,
                duration: 0,
                currentVideo: video,
                videoQueue: newQueue,
                videoQueueIndex: idx >= 0 ? idx : 0,
                videoCurrentTime: video.startSec ?? 0,
                videoDuration: video.durationSec ?? 0,
                isNowPlayingOpen: true,
                requestedView: "video",
                lastMediaType: "video",
            };
        });
    }, []);

    const addToVideoQueue = useCallback((video: VideoMedia) => {
        setState((s) => {
            // Dedupe by fileId; ignore if already in queue.
            if (s.videoQueue.some(v => v.fileId === video.fileId)) return s;
            return { ...s, videoQueue: [...s.videoQueue, video] };
        });
    }, []);

    const playVideoNext = useCallback((video: VideoMedia) => {
        setState((s) => {
            const filtered = s.videoQueue.filter(v => v.fileId !== video.fileId);
            const insertAt = Math.max(0, s.videoQueueIndex + 1);
            const next = [...filtered.slice(0, insertAt), video, ...filtered.slice(insertAt)];
            return { ...s, videoQueue: next };
        });
    }, []);

        const closeVideo = useCallback(() => {
        videoElRef.current?.pause();
        setState((s) => ({
            ...s,
            currentVideo: null,
            videoQueue: [],
            videoQueueIndex: -1,
            videoCurrentTime: 0,
            videoDuration: 0,
            videoDetached: false,
        }));
    }, []);

    const nextVideo = useCallback(() => {
        setState((s) => {
            const idx = s.videoQueueIndex + 1;
            const nxt = s.videoQueue[idx];
            if (!nxt) return s;
            return {
                ...s,
                currentVideo: nxt,
                videoQueueIndex: idx,
                videoCurrentTime: nxt.startSec ?? 0,
                videoDuration: nxt.durationSec ?? 0,
            };
        });
    }, []);

    const prevVideo = useCallback(() => {
        const v = videoElRef.current;
        if (v && v.currentTime > 3) {
            v.currentTime = 0;
            return;
        }
        setState((s) => {
            const idx = s.videoQueueIndex - 1;
            const p = s.videoQueue[idx];
            if (!p) return s;
            return {
                ...s,
                currentVideo: p,
                videoQueueIndex: idx,
                videoCurrentTime: p.startSec ?? 0,
                videoDuration: p.durationSec ?? 0,
            };
        });
    }, []);

    const seekVideo = useCallback((time: number) => {
        const v = videoElRef.current;
        if (v && isFinite(time)) v.currentTime = Math.max(0, time);
    }, []);

    const videoTogglePlay = useCallback(() => {
        const v = videoElRef.current;
        if (!v) return;
        if (v.paused) {
            void v.play().catch(() => { /* user gesture required */ });
        } else {
            v.pause();
        }
    }, []);

    const setVideoDetached = useCallback((detached: boolean) => {
        setState((s) => ({ ...s, videoDetached: detached }));
    }, []);

    const setVideoGainDb = useCallback((db: number | undefined) => {
        const g = videoGainRef.current;
        if (!g) return;
        const linear = db == null ? 1 : Math.pow(10, db / 20);
        g.gain.value = Math.max(0, Math.min(8, linear));
    }, []);

        const registerVideoElement = useCallback((el: HTMLVideoElement | null) => {
        if (videoElListenersRef.current && videoElListenersRef.current.el !== el) {
            videoElListenersRef.current.cleanup();
            videoElListenersRef.current = null;
        }
        videoElRef.current = el;
        if (!el) return;

        el.volume = stateRef.current.volume;

        const ctx = audioContextRef.current;
        const analyser = analyserRef.current;
        if (ctx && analyser && !videoSourceRef.current) {
            try {
                const src = ctx.createMediaElementSource(el);
                const gain = ctx.createGain();
                src.connect(gain).connect(analyser);
                analyser.connect(ctx.destination);
                videoSourceRef.current = src;
                videoGainRef.current = gain;
            } catch {
                // already attached to another graph (e.g. HMR) — ignore
            }
        }

        const onTime = () => {
            setState((cur) => (cur.currentVideo ? { ...cur, videoCurrentTime: el.currentTime } : cur));
        };
        const onDur = () => {
            setState((cur) => (cur.currentVideo ? { ...cur, videoDuration: el.duration || 0 } : cur));
        };
        const onPlay = () => setState((cur) => ({ ...cur, isPlaying: true }));
        const onPause = () => setState((cur) => ({ ...cur, isPlaying: false }));
        const onEnded = () => {
            const cs = getCinemaSettings();
            setState((cur) => {
                const idx = cur.videoQueueIndex + 1;
                const nxt = cur.videoQueue[idx];
                // Always pause first; VideoPlayerHost's countdown overlay handles advance when
                // autoplayNextEpisode is on. If autoplay is off OR there's no next item, just pause.
                if (!nxt || !cs.autoplayNextEpisode) return { ...cur, isPlaying: false };
                // Countdown > 0: leave state as-is so the overlay can show; it will call nextVideo().
                if (cs.autoplayCountdownSec > 0) return { ...cur, isPlaying: false };
                // Instant advance.
                return { ...cur, currentVideo: nxt, videoQueueIndex: idx, videoCurrentTime: nxt.startSec ?? 0 };
            });
        };

        el.addEventListener("timeupdate", onTime);
        el.addEventListener("durationchange", onDur);
        el.addEventListener("play", onPlay);
        el.addEventListener("pause", onPause);
        el.addEventListener("ended", onEnded);

        videoElListenersRef.current = {
            el,
            cleanup: () => {
                el.removeEventListener("timeupdate", onTime);
                el.removeEventListener("durationchange", onDur);
                el.removeEventListener("play", onPlay);
                el.removeEventListener("pause", onPause);
                el.removeEventListener("ended", onEnded);
            },
        };
    }, []);

    // ─── Media Session action handlers ──────────────────────────────────
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        const ms = navigator.mediaSession;
        ms.setActionHandler("play", () => resume());
        ms.setActionHandler("pause", () => pause());
        ms.setActionHandler("previoustrack", () => prev());
        ms.setActionHandler("nexttrack", () => next());
        ms.setActionHandler("seekto", (details) => {
            if (details.seekTime != null) seek(details.seekTime);
        });
        ms.setActionHandler("seekbackward", (details) => {
            const offset = details.seekOffset || 10;
            const audio = audioRef.current;
            if (audio) seek(Math.max(0, audio.currentTime - offset));
        });
        ms.setActionHandler("seekforward", (details) => {
            const offset = details.seekOffset || 10;
            const audio = audioRef.current;
            if (audio) seek(Math.min(audio.duration || 0, audio.currentTime + offset));
        });
        return () => {
            ms.setActionHandler("play", null);
            ms.setActionHandler("pause", null);
            ms.setActionHandler("previoustrack", null);
            ms.setActionHandler("nexttrack", null);
            ms.setActionHandler("seekto", null);
            ms.setActionHandler("seekbackward", null);
            ms.setActionHandler("seekforward", null);
        };
    }, [resume, pause, prev, next, seek]);

    return (
        <PlayerContext.Provider
            value={{
                ...state,
                play,
                pause,
                resume,
                togglePlay,
                next,
                prev,
                seek,
                setVolume,
                setQueue,
                addToQueue,
                removeFromQueue,
                moveInQueue,
                clearQueue,
                playFromQueue,
                toggleShuffle,
                toggleRepeat,
                openNowPlaying,
                openNowPlayingView,
                closeNowPlaying,
                toggleNowPlaying,
                clearRequestedView,
                getAnalyserNode,
                getAudioNodes,
                getVideoNodes,
                playVideo,
                closeVideo,
                nextVideo,
                prevVideo,
                seekVideo,
                videoTogglePlay,
                setVideoDetached,
                registerVideoElement,
                setVideoGainDb,
                addToVideoQueue,
                playVideoNext,
            }}
        >
            {children}
        </PlayerContext.Provider>
    );
}
