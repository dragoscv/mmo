"use client";

/**
 * useLiveSettings — persistent display & audio preferences for the Live page.
 * Modeled on use-daw-settings.ts (external store + useSyncExternalStore).
 */

import { useSyncExternalStore } from "react";
import type { NoteNotation } from "@/lib/note-notation";

export type LiveAccent = "rose" | "violet" | "emerald" | "cyan" | "amber";
export type CoachVerbosity = "minimal" | "normal" | "verbose";

export interface LiveSettings {
    // Audio
    audioOutputDeviceId: string;

    // Display — note notation
    noteNotation1: NoteNotation;
    noteNotation2: NoteNotation | "none";

    // Display — refresh & smoothing
    /** Realtime widget refresh rate (Hz). Stored in the same key as the
     *  toolbar slider, so changes from either UI stay in sync. */
    refreshHz: number;
    /** Minimum time (ms) the Tuner keeps showing a value before allowing it to
     *  swap to the next reading. Higher = calmer display, lower = more
     *  responsive. */
    tunerStickinessMs: number;
    /** Same idea for Coach tip rows. Defaults higher because text is harder to
     *  read than a meter when it flickers. */
    coachStickinessMs: number;
    /** Coach tip verbosity. */
    coachVerbosity: CoachVerbosity;

    // Personalization
    accent: LiveAccent;
    /** Show the cents value next to the note in the Tuner & Coach header. */
    showCents: boolean;
}

export const DEFAULT_LIVE_SETTINGS: LiveSettings = {
    audioOutputDeviceId: "default",
    noteNotation1: "anglo" as NoteNotation,
    noteNotation2: "none" as NoteNotation | "none",
    refreshHz: 4,
    tunerStickinessMs: 600,
    coachStickinessMs: 1500,
    coachVerbosity: "normal",
    accent: "rose",
    showCents: true,
};

const STORAGE_KEY = "mmo-live-settings";
const REFRESH_HZ_LEGACY_KEY = "live-ui-refresh-hz";
const REFRESH_HZ_EVENT = "mmo-ui-refresh-hz-changed";

function load(): LiveSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const merged = raw
            ? { ...DEFAULT_LIVE_SETTINGS, ...JSON.parse(raw) }
            : { ...DEFAULT_LIVE_SETTINGS };
        // One-way migration: if the toolbar slider previously wrote to the legacy
        // key, prefer that value so we don't lose the user's setting.
        const legacy = localStorage.getItem(REFRESH_HZ_LEGACY_KEY);
        if (legacy) {
            const n = parseFloat(legacy);
            if (isFinite(n)) merged.refreshHz = Math.max(1, Math.min(30, n));
        }
        return merged;
    } catch {
        return { ...DEFAULT_LIVE_SETTINGS };
    }
}

function save(s: LiveSettings) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
        // Mirror to legacy key so the LiveProvider meter loop (which reads it
        // directly to throttle without subscribing to React state) picks up.
        localStorage.setItem(REFRESH_HZ_LEGACY_KEY, String(s.refreshHz));
        window.dispatchEvent(new Event(REFRESH_HZ_EVENT));
        window.dispatchEvent(new Event("mmo-preference-changed"));
    } catch { /* ignore */ }
}

let current = typeof window === "undefined" ? { ...DEFAULT_LIVE_SETTINGS } : load();
const listeners = new Set<() => void>();

function getSnapshot() { return current; }
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }

export function getLiveSettings(): LiveSettings { return current; }

export function updateLiveSettings(patch: Partial<LiveSettings>) {
    current = { ...current, ...patch };
    save(current);
    listeners.forEach(fn => fn());
}

export function resetLiveSettings() {
    current = { ...DEFAULT_LIVE_SETTINGS };
    save(current);
    listeners.forEach(fn => fn());
}

/** Get active notation formats (1 or 2 entries) without a hook. */
export function getActiveLiveNotations(): NoteNotation[] {
    return current.noteNotation2 === "none" ? [current.noteNotation1] : [current.noteNotation1, current.noteNotation2];
}

export function useLiveSettings() {
    const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const noteNotations: NoteNotation[] = s.noteNotation2 === "none" ? [s.noteNotation1] : [s.noteNotation1, s.noteNotation2];
    return {
        ...s,
        update: updateLiveSettings,
        reset: resetLiveSettings,
        noteNotations,
    };
}
