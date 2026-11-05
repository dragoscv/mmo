"use client";

/**
 * Keyed async loader: state is derived from `{ key, result }`, so a new key reads as "loading" without a
 * synchronous setState inside the effect (react-hooks/set-state-in-effect). `run(attempt)` gets the retry count
 * (callers drop caches when `attempt > 0`); a `null` resolution means "server without this endpoint".
 */
import { useCallback, useEffect, useEffectEvent, useMemo, useState, useSyncExternalStore } from "react";
import type { Load } from "./common";

const LOADING: Load<never> = { s: "loading" };

export function useAsync<T>(key: string | null, run: (attempt: number) => Promise<T | null>): { load: Load<T>; retry: () => void } {
    const [attempt, setAttempt] = useState(0);
    const full = key == null ? null : `${key}#${attempt}`;
    const [res, setRes] = useState<{ key: string; load: Load<T> } | null>(null);
    const exec = useEffectEvent((n: number) => run(n));

    useEffect(() => {
        if (full == null) return;
        let alive = true;
        exec(attempt)
            .then((data) => { if (alive) setRes({ key: full, load: data == null ? { s: "unsupported" } : { s: "ok", data } }); })
            .catch((error: unknown) => { if (alive) setRes({ key: full, load: { s: "error", error } }); });
        return () => { alive = false; };
    }, [full, attempt]);

    const retry = useCallback(() => setAttempt((n) => n + 1), []);
    return { load: res && res.key === full ? res.load : LOADING, retry };
}

// ─── localStorage-backed string list (hydration-safe) ────────────────────

const EVT = "mixai-web:local-list";
const EMPTY = "[]";

export function readList(key: string): string[] {
    try {
        const j = JSON.parse(localStorage.getItem(key) ?? EMPTY) as unknown;
        return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : [];
    } catch { return []; }
}

export function writeList(key: string, list: string[]): void {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* quota */ }
    window.dispatchEvent(new Event(EVT));
}

/** Raw JSON snapshot (a primitive, so React can compare it); server snapshot is always `[]`. */
export function useLocalList(key: string): string[] {
    const raw = useSyncExternalStore(
        (cb) => {
            window.addEventListener("storage", cb);
            window.addEventListener(EVT, cb);
            return () => { window.removeEventListener("storage", cb); window.removeEventListener(EVT, cb); };
        },
        () => { try { return localStorage.getItem(key) ?? EMPTY; } catch { return EMPTY; } },
        () => EMPTY,
    );
    return useMemo(() => {
        try {
            const j = JSON.parse(raw) as unknown;
            return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : [];
        } catch { return []; }
    }, [raw]);
}
