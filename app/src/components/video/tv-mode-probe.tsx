"use client";

import { useEffect } from "react";
import { bindArrowKeys } from "@/lib/focus-nav";

/**
 * Detect TV-like surfaces (UA, low pointer fidelity) and enable
 * D-pad navigation + TV CSS overrides. No-op on mouse/touch devices.
 */
export function TvModeProbe() {
    useEffect(() => {
        if (typeof window === "undefined") return;
        const ua = navigator.userAgent || "";
        const isAndroidTv = /Android.*TV|GoogleTV|BRAVIA|AFT[A-Z]+/i.test(ua);
        const isCoarseNoHover = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
        const fromQuery = new URLSearchParams(window.location.search).has("tv");
        const enable = isAndroidTv || fromQuery || (isCoarseNoHover && window.innerWidth > 1280);
        if (!enable) return;
        document.documentElement.classList.add("tv-mode");
        const unbind = bindArrowKeys();
        return () => {
            document.documentElement.classList.remove("tv-mode");
            unbind();
        };
    }, []);
    return null;
}
