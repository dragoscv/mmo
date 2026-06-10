"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "sidebar-pinned-v1";

function read(): string[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
    } catch {
        return [];
    }
}

function write(hrefs: string[]) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(hrefs));
        window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    } catch {
        // ignore quota / privacy mode failures
    }
}

export function usePinnedHrefs() {
    const [pinned, setPinned] = useState<string[]>(() => read());

    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            if (e.key && e.key !== STORAGE_KEY) return;
            setPinned(read());
        };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, []);

    const toggle = useCallback((href: string) => {
        setPinned((cur) => {
            const next = cur.includes(href) ? cur.filter((h) => h !== href) : [...cur, href];
            write(next);
            return next;
        });
    }, []);

    const isPinned = useCallback((href: string) => pinned.includes(href), [pinned]);

    return { pinned, toggle, isPinned };
}
