"use client";

/**
 * Shared offline state so the pin action (context menu) and the availability
 * badge (table rows) see the same IndexedDB-backed cache. `useOfflineMode` is
 * a per-component hook; this provider lifts it once at the app root.
 */

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useOfflineMode } from "@/hooks/use-offline";
import { audioPreloadCache } from "@/lib/audio-preload-cache";

type OfflineApi = ReturnType<typeof useOfflineMode>;

const OfflineContext = createContext<OfflineApi | null>(null);

export function OfflineProvider({ children }: { children: ReactNode }) {
    const offline = useOfflineMode();

    // Let the player prefer a pinned IndexedDB blob over the network stream,
    // so offline tracks play with no source device reachable.
    useEffect(() => {
        return audioPreloadCache.setOfflineResolver((trackId) =>
            offline.isTrackOffline(trackId) ? offline.getOfflineUrl(trackId) : Promise.resolve(null),
        );
    }, [offline]);

    return <OfflineContext.Provider value={offline}>{children}</OfflineContext.Provider>;
}

/** Access shared offline state. Returns null outside the provider. */
export function useOffline(): OfflineApi | null {
    return useContext(OfflineContext);
}
