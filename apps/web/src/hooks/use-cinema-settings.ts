"use client";

/** Cinema settings — persistent prefs for video playback (autoplay, subs,
 *  PiP). Mirrors the `useDAWSettings` / `useLiveSettings` pattern:
 *  external store + localStorage. */

import { useSyncExternalStore } from "react";

export interface CinemaSettings {
    /** Auto-advance to next episode when one ends. */
    autoplayNextEpisode: boolean;
    /** Countdown seconds shown before auto-advance (0 = instant). */
    autoplayCountdownSec: number;
    /** Preferred subtitle languages, in priority order (ISO codes). */
    subtitleLangPriority: string[];
    /** Prefer SDH (closed-captions style) when picking subtitles. */
    preferSdh: boolean;
    /** When navigating away from /watch/*, auto-detach video to PiP. */
    autoDetachOnNavigate: boolean;
    /** Survive page reload by persisting current video + position. */
    persistAcrossReload: boolean;
    /** Pause when the document is hidden (tab switch). */
    pauseOnHidden: boolean;
    /** Enable keyboard shortcuts (J/K/L, space, F, etc.). */
    enableShortcuts: boolean;
    /** EQ preset name to auto-apply while a video is active (null = keep current). */
    cinemaEqPreset: string | null;
    /** Prefer chromaprint fingerprinting for intro detection when fpcalc is
     *  available on the companion host. Falls back to silence-detect when not. */
    useChromaprintIntro: boolean;
    /** Apply EBU R128 loudness normalization gain via Web Audio. */
    loudnessNormalization: boolean;
    /** Auto-stop playback after N minutes. null = disabled. */
    sleepTimerMin: number | null;
    /** Per-show preferred audio track (matched by lang code first, then index). */
    preferredAudioByShow: Record<string, { lang?: string; index?: number }>;
}

export const DEFAULT_CINEMA_SETTINGS: CinemaSettings = {
    autoplayNextEpisode: true,
    autoplayCountdownSec: 5,
    subtitleLangPriority: ["en", "ro"],
    preferSdh: true,
    autoDetachOnNavigate: true,
    persistAcrossReload: true,
    pauseOnHidden: false,
    enableShortcuts: true,
    cinemaEqPreset: "Cinema",
    useChromaprintIntro: false,
    loudnessNormalization: true,
    sleepTimerMin: null,
    preferredAudioByShow: {},
};

const STORAGE_KEY = "mmo-cinema-settings";

function load(): CinemaSettings {
    if (typeof window === "undefined") return { ...DEFAULT_CINEMA_SETTINGS };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return { ...DEFAULT_CINEMA_SETTINGS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...DEFAULT_CINEMA_SETTINGS };
}

function save(s: CinemaSettings) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
        window.dispatchEvent(new Event("mmo-preference-changed"));
    } catch { /* ignore */ }
}

let current = typeof window === "undefined" ? { ...DEFAULT_CINEMA_SETTINGS } : load();
const listeners = new Set<() => void>();
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }
function getSnapshot() { return current; }

export function getCinemaSettings(): CinemaSettings { return current; }

export function updateCinemaSettings(patch: Partial<CinemaSettings>) {
    current = { ...current, ...patch };
    save(current);
    listeners.forEach(fn => fn());
}

export function resetCinemaSettings() {
    current = { ...DEFAULT_CINEMA_SETTINGS };
    save(current);
    listeners.forEach(fn => fn());
}

export function useCinemaSettings() {
    const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return { ...s, update: updateCinemaSettings, reset: resetCinemaSettings };
}
