"use client";

/** Bridges the localStorage-backed CinemaSettings store with the active
 *  profile's `prefs.cinema` in the DB. On mount we hydrate from the server
 *  (last-write-wins), then debounce-push every local change back. */

import { useEffect, useRef } from "react";
import { getCinemaSettings, updateCinemaSettings, type CinemaSettings } from "@/hooks/use-cinema-settings";
import { getCinemaSettingsForProfile, saveCinemaSettingsForProfile } from "@/actions/cinema-settings-sync";

export function CinemaSettingsSync() {
    const lastSerialized = useRef<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const remote = await getCinemaSettingsForProfile();
            if (cancelled || !remote) return;
            // Apply remote → local store. updateCinemaSettings will fire the
            // change event, which our save listener below ignores because
            // serialized form will already match `lastSerialized`.
            const merged = { ...getCinemaSettings(), ...remote } as CinemaSettings;
            lastSerialized.current = JSON.stringify(merged);
            updateCinemaSettings(merged);
        })();
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        let t: ReturnType<typeof setTimeout> | null = null;
        const onChange = () => {
            if (t) clearTimeout(t);
            t = setTimeout(() => {
                const cur = getCinemaSettings();
                const serialized = JSON.stringify(cur);
                if (serialized === lastSerialized.current) return;
                lastSerialized.current = serialized;
                void saveCinemaSettingsForProfile(cur as unknown as Record<string, unknown>);
            }, 800);
        };
        window.addEventListener("mmo-preference-changed", onChange);
        return () => {
            window.removeEventListener("mmo-preference-changed", onChange);
            if (t) clearTimeout(t);
        };
    }, []);

    return null;
}
