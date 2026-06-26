/**
 * Centralized TanStack Query keys.
 *
 * One source of truth so queries and the mutations that invalidate them never
 * drift. Keys are arrays: [domain, sub, ...params].
 */

import type { TrackFilters } from "@/actions/tracks";

export const queryKeys = {
    tracks: {
        all: ["tracks"] as const,
        list: (filters: Partial<TrackFilters>) => ["tracks", "list", filters] as const,
        genres: ["tracks", "genres"] as const,
        tags: ["tracks", "tags"] as const,
        keys: ["tracks", "keys"] as const,
    },
    playlists: {
        all: ["playlists"] as const,
        list: ["playlists", "list"] as const,
        forTrack: (trackId: number) => ["playlists", "for-track", trackId] as const,
        recommended: ["playlists", "recommended"] as const,
    },
    analysis: {
        scope: ["analysis", "scope"] as const,
        health: ["analysis", "health"] as const,
        status: ["analysis", "status"] as const,
        batches: ["analysis", "batches"] as const,
    },
    savedSearches: ["saved-searches"] as const,
    devices: {
        local: ["devices", "local"] as const,
        folders: (id: string) => ["devices", "folders", id] as const,
    },
} as const;
