"use client";

/**
 * Pushes the user's saved WatchPrefs into:
 *   - `document.documentElement` as CSS vars (subtitle styling)
 *   - `window.__mmoWatchPrefs` so the <video> player can pick a default track
 *
 * Mount once high in the tree (watch layout / settings layout).
 */

import { useEffect } from "react";
import { getWatchPrefs } from "@/actions/watch-prefs";
import type { WatchPrefs } from "@/lib/watch-prefs";

declare global {
    interface Window {
        __mmoWatchPrefs?: WatchPrefs;
    }
}

export function WatchPrefsHydrator() {
    useEffect(() => {
        let alive = true;
        (async () => {
            const prefs = await getWatchPrefs();
            if (!alive) return;
            window.__mmoWatchPrefs = prefs;
            const r = document.documentElement.style;
            r.setProperty("--mmo-sub-scale", String(prefs.subtitleStyle.fontScale));
            r.setProperty("--mmo-sub-outline",
                prefs.subtitleStyle.outline === "none" ? "none"
                    : prefs.subtitleStyle.outline === "thick" ? "2px 2px 4px #000, -2px -2px 4px #000, 2px -2px 4px #000, -2px 2px 4px #000"
                        : "1px 1px 2px #000, -1px -1px 2px #000");
            r.setProperty("--mmo-sub-bg",
                prefs.subtitleStyle.background === "solid" ? "rgba(0,0,0,.85)"
                    : prefs.subtitleStyle.background === "soft" ? "rgba(0,0,0,.35)"
                        : "transparent");
            r.setProperty("--mmo-sub-color", prefs.subtitleStyle.color);
        })();
        return () => { alive = false; };
    }, []);
    return null;
}
