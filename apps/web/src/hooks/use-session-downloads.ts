"use client";

import { useSyncExternalStore } from "react";

/** Tracks the IDs of library tracks the user has downloaded to their PC during
 *  the current browser session. Backed by a module-scoped Set + listener bag
 *  so every consumer sees the same data and re-renders when it changes. The
 *  set is intentionally NOT persisted: closing the tab clears it. */

const ids = new Set<number>();
const listeners = new Set<() => void>();
// Bumped on every mutation so React's `useSyncExternalStore` sees a fresh
// snapshot value (the Set itself is mutated in place; we cannot rely on its
// reference for change detection).
let version = 0;
let snapshot: ReadonlySet<number> = new Set<number>();

function refreshSnapshot() {
    snapshot = new Set(ids);
}

function emit() {
    version++;
    refreshSnapshot();
    for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

function getSnapshot(): ReadonlySet<number> {
    return snapshot;
}

// SSR snapshot — must be stable across calls or React will warn.
const ssrSnapshot: ReadonlySet<number> = new Set();
function getServerSnapshot(): ReadonlySet<number> {
    return ssrSnapshot;
}

/** Mark a track ID as having been saved to the user's PC this session. */
export function markTrackSavedToPC(id: number) {
    if (ids.has(id)) return;
    ids.add(id);
    emit();
}

/** Build a hidden anchor and trigger the browser download for a library
 *  track. Also marks the ID as saved-this-session. */
export function downloadTrackFile(
    trackId: number,
    suggestedName: string,
) {
    const a = document.createElement("a");
    a.href = `/api/audio/${trackId}?download=1`;
    a.rel = "noopener";
    a.download = suggestedName.replace(/[<>:"/\\|?*]/g, "");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    markTrackSavedToPC(trackId);
}

/** React hook returning the current set of saved-this-session track IDs. */
export function useSessionDownloads(): {
    savedIds: ReadonlySet<number>;
    markSaved: (id: number) => void;
} {
    const savedIds = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
    return { savedIds, markSaved: markTrackSavedToPC };
}

// Silence "version is never read" warnings while keeping it for debugging.
export function __debugSessionDownloadsVersion() {
    return version;
}
