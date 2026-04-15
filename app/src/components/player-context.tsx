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
import type { Track } from "@/db/schema";

type RepeatMode = "off" | "one" | "all";

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
    playHistory: Track[];
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
    closeNowPlaying: () => void;
    toggleNowPlaying: () => void;
    getAnalyserNode: () => AnalyserNode | null;
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
}

function loadPersistedState(): Partial<PlayerState> {
    if (typeof window === "undefined") return {};
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const saved: PersistedState = JSON.parse(raw);
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
            isNowPlayingOpen: false,
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
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
        // localStorage full or unavailable
    }
}

export function PlayerProvider({ children }: { children: ReactNode }) {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);

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
        playHistory: [],
    });

    // Restore persisted state after mount to avoid hydration mismatch
    useEffect(() => {
        const persisted = loadPersistedState();
        if (persisted.currentTrack) {
            setState((prev) => ({ ...prev, ...persisted }));
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
        return {
            currentTrack: newTrack,
            queueIndex: newIndex,
            isPlaying: true,
            currentTime: 0,
            playHistory: history,
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
    const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
    const lastSavedTimeRef = useRef(0);
    const stateRef = useRef(state);
    stateRef.current = state;

    useEffect(() => {
        // Save immediately on track/queue/settings changes
        // But debounce currentTime saves (every 5 seconds)
        const timeDiff = Math.abs(state.currentTime - lastSavedTimeRef.current);
        if (timeDiff >= 5 || state.currentTrack?.id !== undefined) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => {
                savePersistedState(state);
                lastSavedTimeRef.current = state.currentTime;
            }, 500);
        }
        return () => clearTimeout(saveTimerRef.current);
    }, [state.currentTrack?.id, state.queueIndex, state.volume, state.shuffle, state.repeat, state.queue.length, state.playHistory.length, state.currentTime]);

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
                    audio.src = `/api/audio/${nextTrack.id}`;
                    safePlay(audio);
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
            audio.src = `/api/audio/${saved.currentTrack.id}`;
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

    const play = useCallback((track: Track, queue?: Track[]) => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.src = `/api/audio/${track.id}`;
        safePlay(audio);
        setState((s) => {
            const newQueue = queue || s.queue;
            const idx = newQueue.findIndex((t) => t.id === track.id);
            const newIndex = idx >= 0 ? idx : 0;
            return {
                ...s,
                ...withHistory(s, track, newIndex),
                queue: newQueue,
            };
        });
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
                audio.src = `/api/audio/${nextTrack.id}`;
                safePlay(audio);
            }
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
                    audio.src = `/api/audio/${prevTrack.id}`;
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
                audio.src = `/api/audio/${track.id}`;
                safePlay(audio);
            }
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

    const closeNowPlaying = useCallback(() => {
        setState((s) => ({ ...s, isNowPlayingOpen: false }));
    }, []);

    const toggleNowPlaying = useCallback(() => {
        setState((s) => ({ ...s, isNowPlayingOpen: !s.isNowPlayingOpen }));
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
                closeNowPlaying,
                toggleNowPlaying,
                getAnalyserNode,
            }}
        >
            {children}
        </PlayerContext.Provider>
    );
}
