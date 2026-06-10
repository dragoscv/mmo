"use client";

/**
 * Client-side Watch theme provider.
 *
 * Reads/writes the active theme id to localStorage under
 * `mmo:watch-theme` and reflects it as `data-watch-theme` on
 * `.watch-shell`. Pre-hydration script in `<head>` (rendered by the
 * server layout) applies the same attribute before React mounts so
 * the page doesn't flash the default theme on hard navigation.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_WATCH_THEME, isWatchThemeId, type WatchThemeId } from "./themes";

const STORAGE_KEY = "mmo:watch-theme";

interface Ctx {
    theme: WatchThemeId;
    setTheme: (id: WatchThemeId) => void;
}

const WatchThemeCtx = createContext<Ctx | null>(null);

export function WatchThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setThemeState] = useState<WatchThemeId>(() => {
        if (typeof window === "undefined") return DEFAULT_WATCH_THEME;
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return isWatchThemeId(stored) ? stored : DEFAULT_WATCH_THEME;
    });

    // Mirror to DOM. The pre-hydration script already did this for first
    // paint; this effect handles in-app theme switches.
    useEffect(() => {
        const shells = document.querySelectorAll<HTMLElement>(".watch-shell");
        shells.forEach((el) => {
            el.dataset.watchTheme = theme;
        });
        // Also tag <html> so any portal-mounted overlays (modals, toasts)
        // can read the active theme via CSS attribute selectors.
        document.documentElement.dataset.watchTheme = theme;
    }, [theme]);

    const setTheme = useCallback((id: WatchThemeId) => {
        setThemeState(id);
        try { window.localStorage.setItem(STORAGE_KEY, id); } catch { /* quota */ }
    }, []);

    return <WatchThemeCtx.Provider value={{ theme, setTheme }}>{children}</WatchThemeCtx.Provider>;
}

export function useWatchTheme(): Ctx {
    const ctx = useContext(WatchThemeCtx);
    if (!ctx) throw new Error("useWatchTheme must be used inside <WatchThemeProvider>");
    return ctx;
}

/** Inline script applied to <head> so the first paint already has the
 *  correct theme attribute — no FOUC when the user reloads while a
 *  non-default theme is active. */
export const WATCH_THEME_PREHYDRATE_SCRIPT = `
(function(){try{var t=localStorage.getItem("${STORAGE_KEY}");var ok=["mmo","netflix","plex","disney","hbo"].indexOf(t)>=0;document.documentElement.dataset.watchTheme=ok?t:"${DEFAULT_WATCH_THEME}";}catch(e){}})();
`.trim();
