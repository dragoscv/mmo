"use client";

import { useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import {
    ensureDefaultProfile,
    getActiveProfilePreferences,
    saveActiveProfilePreferencesBulk,
} from "@/actions/profiles";
import {
    collectSyncableLocalStorage,
    clearSyncableLocalStorage,
    isSyncableKey,
} from "@/lib/syncable-keys";

/** Custom event fired by the Profiles UI after switching/importing a profile. */
export const PROFILE_CHANGED_EVENT = "mmo-profile-changed";

/**
 * Reloads the active profile from the DB into localStorage.
 * Clears existing syncable keys first so deletions persist across devices,
 * then writes the new set and broadcasts a synthetic storage event so any
 * `useSyncExternalStore` consumers (theme, EQ, DAW, etc.) re-read.
 */
export async function applyActiveProfileToLocalStorage(): Promise<void> {
    if (typeof window === "undefined") return;
    const dbPrefs = await getActiveProfilePreferences();
    clearSyncableLocalStorage();
    for (const [key, value] of Object.entries(dbPrefs)) {
        try {
            localStorage.setItem(key, value);
        } catch {
            /* quota / serialization issues — skip */
        }
    }
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    window.dispatchEvent(new Event(PROFILE_CHANGED_EVENT));
}

/**
 * Syncs localStorage state with the user's active profile in the DB.
 *
 * Behaviour:
 * - On auth: ensures a default profile exists, pulls active profile entries,
 *   merges into localStorage (DB wins; deletions in DB propagate to all devices).
 *   On a fresh sign-in with no DB entries, the current localStorage is uploaded.
 * - While authenticated: any localStorage write to a *syncable* key triggers a
 *   debounced bulk save to the DB.
 * - Cross-tab: piggybacks on `window.storage` events.
 * - Profile switch: a `mmo-profile-changed` event re-runs the pull.
 */
export function usePreferencesSync() {
    const { data: session, status } = useSession();
    const hasSynced = useRef(false);
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Initial sync when session becomes available
    useEffect(() => {
        if (status !== "authenticated" || !session?.user?.id || hasSynced.current) return;
        hasSynced.current = true;

        (async () => {
            try {
                await ensureDefaultProfile();
                const dbPrefs = await getActiveProfilePreferences();
                const hasDbPrefs = Object.keys(dbPrefs).length > 0;

                if (hasDbPrefs) {
                    // DB wins. Wipe local syncable keys then hydrate from DB so
                    // deletions made on another device propagate here.
                    clearSyncableLocalStorage();
                    for (const [key, value] of Object.entries(dbPrefs)) {
                        try { localStorage.setItem(key, value); } catch { /* skip */ }
                    }
                    window.dispatchEvent(new StorageEvent("storage", { key: null }));
                    window.dispatchEvent(new Event(PROFILE_CHANGED_EVENT));
                } else {
                    // No DB prefs yet → first-time sign-in: upload local state.
                    const localPrefs = collectSyncableLocalStorage();
                    if (localPrefs.length > 0) {
                        await saveActiveProfilePreferencesBulk(localPrefs);
                    }
                }
            } catch {
                // Silent — localStorage continues to work as fallback.
            }
        })();
    }, [status, session?.user?.id]);

    // Debounced reverse-sync: localStorage → active profile.
    useEffect(() => {
        if (status !== "authenticated" || !session?.user?.id) return;

        function scheduleSave() {
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = setTimeout(async () => {
                try {
                    const prefs = collectSyncableLocalStorage();
                    if (prefs.length > 0) {
                        await saveActiveProfilePreferencesBulk(prefs);
                    }
                } catch {
                    /* silent */
                }
            }, 2000);
        }

        function handleStorageEvent(e: StorageEvent) {
            // Targeted change → only schedule if it's a syncable key.
            if (e.key && !isSyncableKey(e.key)) return;
            scheduleSave();
        }

        window.addEventListener("storage", handleStorageEvent);
        // Same-tab custom event used by ThemeProvider, EQ, DAW, etc.
        window.addEventListener("mmo-preference-changed", scheduleSave);

        return () => {
            window.removeEventListener("storage", handleStorageEvent);
            window.removeEventListener("mmo-preference-changed", scheduleSave);
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        };
    }, [status, session?.user?.id]);
}
