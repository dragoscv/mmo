/**
 * Defines which localStorage keys are persisted to the user's active profile in the DB.
 *
 * Strategy: prefix-based capture (any key matching a prefix is synced) plus an
 * explicit list for non-prefixed keys. This avoids the maintenance burden of an
 * allowlist and ensures *all* per-app state (window/panel layouts, effect chains,
 * plugin params, mixer/EQ config, MIDI mapping, theming, etc.) is preserved.
 */

/** Prefixes — any localStorage key starting with one of these is syncable. */
export const SYNCABLE_KEY_PREFIXES = [
    "mmo-",                  // app-wide ("My Music Organizer") namespace
    "music-organizer-",      // legacy app namespace (player, EQ, etc.)
    "daw_",                  // DAW dockview layout, etc.
    "daw-",                  // DAW clipboard, misc
    "live-widget-",          // live streaming grid layouts
    "analysis-widget-",      // floating widget positions
    "mixer-waveforms-",      // mixer-specific UI state
    "visualizations-",       // viz favourites, custom shaders
] as const;

/** Exact keys (no prefix) — explicit list for the rest. */
export const SYNCABLE_KEYS = [
    "theme",
    "sidebar-collapsed",
    "webrtc-quality",
    "waveform-mode",
    "ui-refresh-rate",
    "daw-clipboard",
    "analysis-modal-open",
] as const;

export type SyncableKey = (typeof SYNCABLE_KEYS)[number];

/** Returns true if the given localStorage key should be synced to the DB. */
export function isSyncableKey(key: string): boolean {
    if ((SYNCABLE_KEYS as readonly string[]).includes(key)) return true;
    for (const prefix of SYNCABLE_KEY_PREFIXES) {
        if (key.startsWith(prefix)) return true;
    }
    return false;
}

/** Snapshots every syncable key currently in localStorage. */
export function collectSyncableLocalStorage(): Array<{ key: string; value: string }> {
    if (typeof window === "undefined") return [];
    const out: Array<{ key: string; value: string }> = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !isSyncableKey(key)) continue;
        const value = localStorage.getItem(key);
        if (value !== null) out.push({ key, value });
    }
    return out;
}

/** Removes every syncable key from localStorage. */
export function clearSyncableLocalStorage(): void {
    if (typeof window === "undefined") return;
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && isSyncableKey(key)) toRemove.push(key);
    }
    for (const key of toRemove) localStorage.removeItem(key);
}
