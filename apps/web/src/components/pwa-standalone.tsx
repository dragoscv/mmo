"use client";

import { useEffect } from "react";
import { useIsStandalone as useDisplayModeStandalone } from "@mmo/ui";

/**
 * WP4-03 — installed-app detection.
 *
 * Mirrors `isStandaloneEnv()` onto `<html data-standalone="true">` so CSS can
 * react to "we are running as an installed app" (PWA standalone, iOS home
 * screen, Capacitor or Tauri shell) without every component re-deriving it.
 * Tokens already expose the `standalone` Tailwind variant for the pure
 * `display-mode: standalone` media query; the data attribute covers the
 * native shells too (they report `display-mode: browser`).
 */

type StandaloneWindow = Window & {
    Capacitor?: unknown;
    __TAURI_INTERNALS__?: unknown;
    navigator: Navigator & { standalone?: boolean };
};

export function isStandaloneEnv(): boolean {
    if (typeof window === "undefined") return false;
    const w = window as StandaloneWindow;
    return (
        w.matchMedia?.("(display-mode: standalone)").matches === true ||
        w.navigator.standalone === true ||
        w.Capacitor !== undefined ||
        w.__TAURI_INTERNALS__ !== undefined
    );
}

/** Reactive to `display-mode` changes; native shells are detected once on mount. */
export function useIsStandalone(): boolean {
    const displayMode = useDisplayModeStandalone();
    return displayMode || isStandaloneEnv();
}

export function PwaStandalone() {
    const standalone = useIsStandalone();

    useEffect(() => {
        const root = document.documentElement;
        if (standalone) root.dataset.standalone = "true";
        else delete root.dataset.standalone;
    }, [standalone]);

    return null;
}
