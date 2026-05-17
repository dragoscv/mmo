"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { discoverCompanion, probeCompanion } from "@/lib/native-companion";

export type CompanionStatus = "unknown" | "discovering" | "online" | "offline";

export interface CompanionStatusValue {
    status: CompanionStatus;
    /** Resolved companion base URL (e.g. http://127.0.0.1:17899) or null. */
    apiUrl: string | null;
    beacon: { version: string; platform: string; capabilities: string[] } | null;
    /** Timestamp (ms) of the most recent probe / discovery completion. */
    lastCheckedAt: number;
    /** Trigger a re-discovery on demand (e.g. "Retry" button). */
    refresh: () => Promise<void>;
}

const CTX = createContext<CompanionStatusValue>({
    status: "unknown",
    apiUrl: null,
    beacon: null,
    lastCheckedAt: 0,
    refresh: async () => { },
});

// Re-probe every 30 s when offline (cheap — single AbortController-bounded
// fetch to the cached URL, falls back to discovery on miss). When online
// we re-probe every 90 s to detect the companion going down.
const REPROBE_OFFLINE_MS = 30_000;
const REPROBE_ONLINE_MS = 90_000;

/**
 * Single source of truth for "is the companion running?". Mounted once
 * in the root layout. Replaces the per-component discovery loops that
 * used to fire 4–5 redundant probes on every page load.
 */
export function CompanionStatusProvider({ children }: { children: React.ReactNode }) {
    const [value, setValue] = useState<CompanionStatusValue>(() => ({
        status: "unknown",
        apiUrl: null,
        beacon: null,
        lastCheckedAt: 0,
        refresh: async () => { },
    }));
    const inFlight = useRef<Promise<void> | null>(null);

    const doDiscover = useCallback(async () => {
        if (inFlight.current) return inFlight.current;
        const run = (async () => {
            setValue((v) => ({ ...v, status: v.status === "online" ? "online" : "discovering" }));
            // Fast path: if we already have a URL, ping it first.
            const current = value.apiUrl;
            if (current) {
                const beacon = await probeCompanion(current);
                if (beacon) {
                    setValue({
                        status: "online",
                        apiUrl: current,
                        beacon,
                        lastCheckedAt: Date.now(),
                        refresh: doDiscover,
                    });
                    return;
                }
            }
            const hit = await discoverCompanion();
            if (hit) {
                setValue({
                    status: "online",
                    apiUrl: hit.apiUrl,
                    beacon: hit.beacon,
                    lastCheckedAt: Date.now(),
                    refresh: doDiscover,
                });
            } else {
                setValue({
                    status: "offline",
                    apiUrl: null,
                    beacon: null,
                    lastCheckedAt: Date.now(),
                    refresh: doDiscover,
                });
            }
        })();
        inFlight.current = run;
        try { await run; } finally { inFlight.current = null; }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value.apiUrl]);

    useEffect(() => {
        // Bind the latest refresh fn into the value so consumers always
        // call the current closure.
        setValue((v) => ({ ...v, refresh: doDiscover }));
    }, [doDiscover]);

    useEffect(() => {
        void doDiscover();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Expose status on window for debugging — surfaces in dev tools as
    // `__mmoCompanion` without pulling in React DevTools.
    useEffect(() => {
        if (typeof window === "undefined") return;
        (window as unknown as { __mmoCompanion: CompanionStatusValue }).__mmoCompanion = value;
    }, [value]);

    useEffect(() => {
        const interval = value.status === "online" ? REPROBE_ONLINE_MS : REPROBE_OFFLINE_MS;
        const t = setInterval(() => { void doDiscover(); }, interval);
        return () => clearInterval(t);
    }, [value.status, doDiscover]);

    // When the tab regains focus, re-probe immediately so the user
    // doesn't wait for the next interval after un-pausing their laptop.
    useEffect(() => {
        const onVisibility = () => {
            if (document.visibilityState === "visible") void doDiscover();
        };
        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("focus", onVisibility);
        return () => {
            document.removeEventListener("visibilitychange", onVisibility);
            window.removeEventListener("focus", onVisibility);
        };
    }, [doDiscover]);

    return <CTX.Provider value={value}>{children}</CTX.Provider>;
}

/** Read the shared companion status. Safe to call from any client component. */
export function useCompanionStatus(): CompanionStatusValue {
    return useContext(CTX);
}
