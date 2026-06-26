"use client";

/**
 * Per-route scroll restoration.
 *
 * App Router doesn't restore scroll for client navigations the way a native app
 * would (and our main scroll happens inside a scroll container, not window). We
 * save the scroll position of the primary scroll container keyed by the full
 * URL (path + query) and restore it when you navigate back to that URL — so the
 * library list returns to where you left it instead of jumping to the top.
 */

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const STORE_KEY = "muzicai-scroll-positions";
const MAX_ENTRIES = 50;

type PositionMap = Record<string, number>;

function loadPositions(): PositionMap {
    try {
        return JSON.parse(sessionStorage.getItem(STORE_KEY) || "{}");
    } catch {
        return {};
    }
}

function savePositions(map: PositionMap) {
    try {
        // Bound the map so it can't grow unbounded.
        const entries = Object.entries(map);
        const trimmed = entries.slice(-MAX_ENTRIES);
        sessionStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(trimmed)));
    } catch {
        /* quota / private mode */
    }
}

/** The app's main scroll container. Falls back to window scrolling. */
function getScroller(): HTMLElement | null {
    return document.querySelector<HTMLElement>("[data-scroll-container]");
}

export function ScrollRestoration() {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const key = `${pathname}?${searchParams.toString()}`;
    const keyRef = useRef(key);
    useEffect(() => {
        keyRef.current = key;
    }, [key]);

    useEffect(() => {
        const scroller = getScroller();
        const positions = loadPositions();

        // Restore on mount / key change. rAF so the new content has laid out.
        const saved = positions[key];
        const raf = requestAnimationFrame(() => {
            if (saved == null) return;
            if (scroller) scroller.scrollTop = saved;
            else window.scrollTo(0, saved);
        });

        // Save continuously (throttled) while on this route.
        let ticking = false;
        const onScroll = () => {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                const pos = scroller ? scroller.scrollTop : window.scrollY;
                const map = loadPositions();
                map[keyRef.current] = pos;
                savePositions(map);
                ticking = false;
            });
        };

        const target: HTMLElement | Window = scroller ?? window;
        target.addEventListener("scroll", onScroll, { passive: true });

        return () => {
            // Save final position on unmount/navigation away.
            const pos = scroller ? scroller.scrollTop : window.scrollY;
            const map = loadPositions();
            map[key] = pos;
            savePositions(map);
            target.removeEventListener("scroll", onScroll);
            cancelAnimationFrame(raf);
        };
    }, [key]);

    return null;
}
