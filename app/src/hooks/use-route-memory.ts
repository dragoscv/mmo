"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "route-memory";

/** Pages that have URL state worth preserving */
const STATEFUL_ROUTES = ["/library", "/playlists"];

function getSnapshot(): Record<string, string> {
    try {
        return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
        return {};
    }
}

let memoryCache: Record<string, string> = {};
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

function getStoreSnapshot() {
    return memoryCache;
}

function initCache() {
    if (typeof window !== "undefined") {
        memoryCache = getSnapshot();
    }
}

function persist(path: string, search: string) {
    memoryCache = { ...memoryCache, [path]: search };
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(memoryCache));
    } catch {
        // ignore
    }
    for (const cb of listeners) cb();
}

function clearPath(path: string) {
    const next = { ...memoryCache };
    delete next[path];
    memoryCache = next;
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(memoryCache));
    } catch {
        // ignore
    }
    for (const cb of listeners) cb();
}

/**
 * Save the current page's search params to sessionStorage whenever they change.
 * Call this in pages that have URL-based state (library, playlists).
 */
export function useRouteMemorySave(path: string, searchParams: string) {
    useEffect(() => {
        initCache();
    }, []);

    useEffect(() => {
        if (searchParams) {
            persist(path, searchParams);
        } else {
            clearPath(path);
        }
    }, [path, searchParams]);
}

/**
 * Clear saved state for a route (for reset buttons).
 */
export function clearRouteMemory(path: string) {
    clearPath(path);
}

/**
 * Get the saved href for a route, including query params if any were saved.
 * Returns the bare path if nothing was saved.
 */
export function useRouteMemoryHrefs(): Record<string, string> {
    const [hrefs, setHrefs] = useState<Record<string, string>>({});

    useEffect(() => {
        initCache();
        // Build initial hrefs
        updateHrefs();

        // Subscribe to changes
        const unsub = subscribe(updateHrefs);
        return unsub;
    }, []);

    function updateHrefs() {
        const result: Record<string, string> = {};
        for (const route of STATEFUL_ROUTES) {
            const saved = memoryCache[route];
            result[route] = saved ? `${route}?${saved}` : route;
        }
        setHrefs(result);
    }

    return hrefs;
}
