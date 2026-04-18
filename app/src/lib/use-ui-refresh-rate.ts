"use client";

/**
 * useUIRefreshHz — user-controllable refresh rate (in Hz) for "realtime"
 * widgets like the Coach and the Tuner. Persisted to localStorage and
 * synced across components in the same window via a custom event.
 *
 * useThrottledValue — wraps a fast-changing value and only re-emits at
 * the configured rate, so consumer components don't re-render every frame.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "live-ui-refresh-hz";
const EVENT_NAME = "mmo-ui-refresh-hz-changed";

export const UI_REFRESH_HZ_MIN = 1;
export const UI_REFRESH_HZ_MAX = 30;
export const UI_REFRESH_HZ_DEFAULT = 4;

function readStored(): number {
    if (typeof window === "undefined") return UI_REFRESH_HZ_DEFAULT;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return UI_REFRESH_HZ_DEFAULT;
        const n = parseFloat(raw);
        if (!isFinite(n)) return UI_REFRESH_HZ_DEFAULT;
        return Math.max(UI_REFRESH_HZ_MIN, Math.min(UI_REFRESH_HZ_MAX, n));
    } catch {
        return UI_REFRESH_HZ_DEFAULT;
    }
}

export function useUIRefreshHz(): [number, (hz: number) => void] {
    const [hz, setHzState] = useState<number>(UI_REFRESH_HZ_DEFAULT);

    // Hydrate after mount to avoid SSR mismatch
    useEffect(() => {
        setHzState(readStored());
        const onChange = () => setHzState(readStored());
        window.addEventListener(EVENT_NAME, onChange);
        const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY) onChange(); };
        window.addEventListener("storage", onStorage);
        return () => {
            window.removeEventListener(EVENT_NAME, onChange);
            window.removeEventListener("storage", onStorage);
        };
    }, []);

    const setHz = useCallback((next: number) => {
        const clamped = Math.max(UI_REFRESH_HZ_MIN, Math.min(UI_REFRESH_HZ_MAX, next));
        try {
            localStorage.setItem(STORAGE_KEY, String(clamped));
            window.dispatchEvent(new Event(EVENT_NAME));
        } catch { /* noop */ }
        setHzState(clamped);
    }, []);

    return [hz, setHz];
}

/**
 * Returns a throttled snapshot of `value` that only updates at the given rate.
 * The latest value is always captured in a ref, so the next tick will pick up
 * the freshest value (no lost final update).
 */
export function useThrottledValue<T>(value: T, hz: number): T {
    const latestRef = useRef(value);
    latestRef.current = value;
    const [snap, setSnap] = useState(value);

    useEffect(() => {
        const interval = Math.max(16, Math.round(1000 / Math.max(UI_REFRESH_HZ_MIN, hz)));
        // Emit immediately so the first paint reflects the current value at the new rate
        setSnap(latestRef.current);
        const id = window.setInterval(() => {
            setSnap(prev => {
                const next = latestRef.current;
                return Object.is(prev, next) ? prev : next;
            });
        }, interval);
        return () => window.clearInterval(id);
    }, [hz]);

    return snap;
}
