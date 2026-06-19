"use client";

/**
 * useAvailabilityRefresh — keeps track availability badges live.
 *
 * Availability (connected/disconnected) is computed server-side from each
 * source device's heartbeat (devices.lastSeenAt, 90s window). Companions
 * announce every ~30s, so a device going offline/online is reflected within
 * a couple of minutes. Rather than open a WebSocket (which is mixed-content
 * blocked when the web app is on HTTPS and the companion on LAN), we simply
 * re-run the server component on a gentle interval via router.refresh().
 *
 * - Pauses while the tab is hidden (no point refreshing a backgrounded tab).
 * - Refreshes immediately when the tab regains focus, so switching back shows
 *   current state without waiting for the next tick.
 *
 * Mount once per page that shows availability (e.g. the library). Safe to
 * mount unconditionally; it's a no-op cost beyond one refresh per interval.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const DEFAULT_INTERVAL_MS = 45_000;

export function useAvailabilityRefresh(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    const router = useRouter();
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const lastRefreshRef = useRef(Date.now());

    useEffect(() => {
        const tick = () => {
            // Skip when the tab is hidden — resumes on visibility change.
            if (document.visibilityState !== "visible") return;
            lastRefreshRef.current = Date.now();
            router.refresh();
        };

        timerRef.current = setInterval(tick, intervalMs);

        const onVisible = () => {
            if (document.visibilityState !== "visible") return;
            // If we've been away longer than the interval, refresh now so the
            // user sees current availability immediately on return.
            if (Date.now() - lastRefreshRef.current >= intervalMs) {
                lastRefreshRef.current = Date.now();
                router.refresh();
            }
        };
        document.addEventListener("visibilitychange", onVisible);

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [router, intervalMs]);
}
