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
}

type PlayerContextType = PlayerState & PlayerActions;

const PlayerContext = createContext<PlayerContextType | null>(null);

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used within PlayerProvider");
  return ctx;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
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
  });

  // We need a ref for repeat/shuffle so the ended handler sees latest values
  const repeatRef = useRef(state.repeat);
  const shuffleRef = useRef(state.shuffle);
  useEffect(() => {
    repeatRef.current = state.repeat;
  }, [state.repeat]);
  useEffect(() => {
    shuffleRef.current = state.shuffle;
  }, [state.shuffle]);

  useEffect(() => {
    const audio = new Audio();
    audio.volume = state.volume;
    audioRef.current = audio;

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
          audio.play();
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
          audio.play();
          return {
            ...s,
            currentTrack: nextTrack,
            queueIndex: nextIdx,
            isPlaying: true,
            currentTime: 0,
          };
        }
        return { ...s, isPlaying: false };
      });
    });
    audio.addEventListener("error", () => {
      setState((s) => ({ ...s, isPlaying: false }));
    });

    return () => {
      audio.pause();
      audio.src = "";
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const play = useCallback((track: Track, queue?: Track[]) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = `/api/audio/${track.id}`;
    audio.play();
    setState((s) => {
      const newQueue = queue || s.queue;
      const idx = newQueue.findIndex((t) => t.id === track.id);
      return {
        ...s,
        currentTrack: track,
        isPlaying: true,
        currentTime: 0,
        queue: newQueue,
        queueIndex: idx >= 0 ? idx : 0,
      };
    });
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setState((s) => ({ ...s, isPlaying: false }));
  }, []);

  const resume = useCallback(() => {
    audioRef.current?.play();
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
        audio.play();
      }
      return {
        ...s,
        currentTrack: nextTrack,
        queueIndex: nextIdx,
        isPlaying: true,
        currentTime: 0,
      };
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
          audio.play();
        }
        return {
          ...s,
          currentTrack: prevTrack,
          queueIndex: prevIdx,
          isPlaying: true,
          currentTime: 0,
        };
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
        audio.play();
      }
      return {
        ...s,
        currentTrack: track,
        queueIndex: index,
        isPlaying: true,
        currentTime: 0,
      };
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
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
}
