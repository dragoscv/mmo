/**
 * The tracks the Library has loaded from the companion (in its current search and sort order,
 * before the view filters). Written by the Library; read by features that need "the library" without
 * fetching it again (next-track suggestions, set builder, song requests). Empty while the Library
 * is not mounted or not connected.
 */
import { create } from "zustand";
import type { LibraryTrack } from "../bridge/types.ts";

interface LibraryPool {
    tracks: readonly LibraryTrack[];
    /** Search text the pool was fetched with ("" = the whole library, up to the page limit). */
    query: string;
    /** Tracks the companion reports for that query (may exceed `tracks.length`). */
    total: number;
    set: (tracks: readonly LibraryTrack[], query: string, total: number) => void;
}

export const useLibraryPool = create<LibraryPool>((set) => ({
    tracks: [],
    query: "",
    total: 0,
    set: (tracks, query, total) => set({ tracks, query, total }),
}));
