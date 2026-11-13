/**
 * The tracks the Library has loaded from the companion (in its current search and sort order,
 * before the view filters). Written by the Library; read by features that need "the library" without
 * fetching it again (next-track suggestions, set builder, song requests). Empty while the Library
 * is not mounted or not connected: `fetched` tells that apart from a library that really is empty.
 */
import { create } from "zustand";
import type { LibraryTrack } from "../bridge/types.ts";

interface LibraryPool {
    tracks: readonly LibraryTrack[];
    /** Search text the pool was fetched with ("" = the whole library, up to the page limit). */
    query: string;
    /** Tracks the companion reports for that query (may exceed `tracks.length`). */
    total: number;
    /**
     * The Library has stored an answer of the companion. False while the Library is not shown
     * (stage mode, the local-files source), before its first answer, and after it went away:
     * `tracks` is empty then and says nothing about the library.
     */
    fetched: boolean;
    /** Store a result. `fetched` defaults to true (a caller that stores a result has one); the Library passes false until the companion answered and when it goes away. */
    set: (tracks: readonly LibraryTrack[], query: string, total: number, fetched?: boolean) => void;
}

export const useLibraryPool = create<LibraryPool>((set) => ({
    tracks: [],
    query: "",
    total: 0,
    fetched: false,
    set: (tracks, query, total, fetched = true) => set({ tracks, query, total, fetched }),
}));
