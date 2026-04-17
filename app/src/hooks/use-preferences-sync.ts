"use client";

import { useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import {
    getUserPreferences,
    saveUserPreferencesBulk,
} from "@/actions/user-preferences";
import { SYNCABLE_KEYS } from "@/lib/syncable-keys";

/**
 * Syncs localStorage preferences with the database for authenticated users.
 * 
 * On first login (no DB prefs): localStorage → DB
 * On subsequent logins (has DB prefs): DB → localStorage
 * While authenticated: localStorage changes are saved to DB periodically
 */
export function usePreferencesSync() {
    const { data: session, status } = useSession();
    const hasSynced = useRef(false);
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Initial sync when session becomes available
    useEffect(() => {
        if (status !== "authenticated" || !session?.user?.id || hasSynced.current) return;
        hasSynced.current = true;

        async function sync() {
            try {
                const dbPrefs = await getUserPreferences();
                const hasDbPrefs = Object.keys(dbPrefs).length > 0;

                if (hasDbPrefs) {
                    // DB has prefs → load them into localStorage
                    for (const [key, value] of Object.entries(dbPrefs)) {
                        localStorage.setItem(key, value);
                    }
                    // Dispatch event so hooks using useSyncExternalStore pick up changes
                    window.dispatchEvent(new StorageEvent("storage", { key: null }));
                } else {
                    // No DB prefs → transfer localStorage to DB (first-time sync)
                    const localPrefs: Array<{ key: string; value: string }> = [];
                    for (const key of SYNCABLE_KEYS) {
                        const value = localStorage.getItem(key);
                        if (value !== null) {
                            localPrefs.push({ key, value });
                        }
                    }
                    if (localPrefs.length > 0) {
                        await saveUserPreferencesBulk(localPrefs);
                    }
                }
            } catch {
                // Silently fail - localStorage still works as fallback
            }
        }

        sync();
    }, [status, session?.user?.id]);

    // Watch for localStorage changes and persist to DB
    useEffect(() => {
        if (status !== "authenticated" || !session?.user?.id) return;

        function handleStorageChange() {
            // Debounce saves to avoid hammering the DB
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = setTimeout(async () => {
                try {
                    const prefs: Array<{ key: string; value: string }> = [];
                    for (const key of SYNCABLE_KEYS) {
                        const value = localStorage.getItem(key);
                        if (value !== null) {
                            prefs.push({ key, value });
                        }
                    }
                    if (prefs.length > 0) {
                        await saveUserPreferencesBulk(prefs);
                    }
                } catch {
                    // Silently fail
                }
            }, 2000);
        }

        window.addEventListener("storage", handleStorageChange);
        // Also listen for custom event for same-tab changes
        window.addEventListener("mmo-preference-changed", handleStorageChange);

        return () => {
            window.removeEventListener("storage", handleStorageChange);
            window.removeEventListener("mmo-preference-changed", handleStorageChange);
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        };
    }, [status, session?.user?.id]);
}
