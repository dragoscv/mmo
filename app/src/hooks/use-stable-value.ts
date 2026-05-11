"use client";

/**
 * useStableValue — hold the latest value for at least `minHoldMs` before
 * letting it change, smoothing rapid fluctuations from realtime sources.
 *
 * Latency is bounded: once `minHoldMs` has elapsed since the last accepted
 * change, the next incoming value is published immediately. There's no
 * trailing-edge delay on the final value either — a timer ensures the most
 * recent input is always reflected.
 */

import { useEffect, useRef, useState } from "react";

export function useStableValue<T>(value: T, minHoldMs: number): T {
    const [held, setHeld] = useState<T>(value);
    const lastChangeAtRef = useRef(0);
    const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latestRef = useRef(value);
    useEffect(() => { latestRef.current = value; });

    useEffect(() => {
        if (Object.is(value, held)) return;
        const now = performance.now();
        const elapsed = now - lastChangeAtRef.current;
        if (elapsed >= minHoldMs) {
            // Enough time has passed — accept the new value immediately.
            lastChangeAtRef.current = now;
            setHeld(value);
            if (pendingTimerRef.current) {
                clearTimeout(pendingTimerRef.current);
                pendingTimerRef.current = null;
            }
        } else if (!pendingTimerRef.current) {
            // Schedule one trailing-edge update so we eventually settle on
            // whatever the latest value is by then.
            const wait = minHoldMs - elapsed;
            pendingTimerRef.current = setTimeout(() => {
                pendingTimerRef.current = null;
                lastChangeAtRef.current = performance.now();
                setHeld(latestRef.current);
            }, wait);
        }
    }, [value, held, minHoldMs]);

    useEffect(() => () => {
        if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    }, []);

    return held;
}
