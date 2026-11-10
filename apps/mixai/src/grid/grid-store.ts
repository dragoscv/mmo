/**
 * Per-deck flexible beatgrid state (WP19-37).
 *
 * The engine owns the grid that plays; this store owns the *editable* form (first beat,
 * starting tempo, tempo-change markers, fixed toggle) so the waveform and the grid editor
 * agree, and pushes every change to the deck through `engine.setGridMarkers`.
 *
 * Two invariants the UI depends on:
 * - **The grid is keyed by track.** Every entry remembers the `trackId` it was edited for, and
 *   `bridge/engine.ts` calls {@link resetDeckGrid} on both load paths, so a freshly loaded track
 *   never shows (or re-sends) the previous track's markers.
 * - **No optimistic state without rollback.** `edit` awaits the IPC call; if the engine rejects
 *   it the store goes back to the grid the engine last accepted and raises `errors[deck]`,
 *   which the editor renders in an alert.
 *
 * The IPC port is *injected* (`setGridBridge`, called by `bridge/engine.ts`) instead of imported,
 * so this module stays free of Tauri and of an import cycle with the bridge, and `node --test`
 * can drive it with a fake.
 */

import { create } from "zustand";
import type { DeckId } from "../bridge/types.ts";
import {
    addMarker,
    gridFromDeck,
    markerIndexNear,
    moveMarker,
    newMarkerBpm,
    normaliseGrid,
    nudgeMarker,
    removeMarker,
    retuneMarker,
    setFixed,
    snapToBeat,
    type GridModel,
} from "./markers.ts";

/** What `grid-store` needs from the engine (the `engine.setGridMarkers` shape). */
export interface GridBridge {
    setGridMarkers(
        deck: DeckId,
        req: { bpm: number; firstBeat: number; markers: GridModel["markers"]; fixed?: boolean },
    ): Promise<unknown>;
}

let bridge: GridBridge | null = null;

/**
 * Install the IPC port. `bridge/engine.ts` calls this with the real engine at import time;
 * tests pass a fake (and `null` to restore the "no engine" / design-mode behaviour, where the
 * edit is kept locally because there is nothing to reject it).
 */
export function setGridBridge(b: GridBridge | null): void {
    bridge = b;
}

/** A deck's editable grid plus the track it belongs to. */
interface DeckGrid {
    /** `DeckState.trackId` of the track this grid was edited for (`null` = empty deck). */
    trackId: string | null;
    grid: GridModel;
}

type Grids = Partial<Record<DeckId, DeckGrid>>;
type Errors = Partial<Record<DeckId, string>>;

/** Longest engine error kept for display. */
const MAX_ERROR_LEN = 200;

function errorText(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e);
    const text = raw.trim() || "unknown error";
    return text.length > MAX_ERROR_LEN ? `${text.slice(0, MAX_ERROR_LEN - 1)}…` : text;
}

interface GridStore {
    grids: Grids;
    /** Last engine rejection per deck (cleared by the next successful edit). */
    errors: Errors;
    /** Replace a deck's grid without touching the engine (e.g. after a load). */
    setGrid: (deck: DeckId, trackId: string | null, grid: GridModel) => void;
    clear: (deck: DeckId) => void;
    /** Drop the error raised by the last rejected edit. */
    dismissError: (deck: DeckId) => void;
    /**
     * Apply `edit` to the deck's grid and push the result to the engine. Resolves with the grid
     * that is actually in the store afterwards: the edited one, or the previous one when the
     * engine rejected the change.
     */
    edit: (
        deck: DeckId,
        trackId: string | null,
        fallback: GridModel,
        edit: (g: GridModel) => GridModel,
    ) => Promise<GridModel>;
}

function dropDeck<T>(map: Partial<Record<DeckId, T>>, deck: DeckId): Partial<Record<DeckId, T>> {
    const next = { ...map };
    delete next[deck];
    return next;
}

export const useGridStore = create<GridStore>((set, get) => ({
    grids: {},
    errors: {},
    setGrid: (deck, trackId, grid) =>
        set((s) => ({
            grids: { ...s.grids, [deck]: { trackId, grid: normaliseGrid(grid) } },
            errors: dropDeck(s.errors, deck),
        })),
    clear: (deck) => set((s) => ({ grids: dropDeck(s.grids, deck), errors: dropDeck(s.errors, deck) })),
    dismissError: (deck) => set((s) => ({ errors: dropDeck(s.errors, deck) })),
    edit: async (deck, trackId, fallback, edit) => {
        const previous = storedFor(get().grids[deck], trackId);
        const next = normaliseGrid(edit(previous ?? fallback));
        set((s) => ({ grids: { ...s.grids, [deck]: { trackId, grid: next } }, errors: dropDeck(s.errors, deck) }));
        const port = bridge;
        // No engine (plain `vite` / Storybook): the local edit is all there is.
        if (!port) return next;
        try {
            await port.setGridMarkers(deck, {
                bpm: next.bpm,
                firstBeat: next.firstBeat,
                markers: next.markers,
                fixed: next.fixed,
            });
            return next;
        } catch (e) {
            // Roll back only if nothing newer landed meanwhile (a later edit owns the state then).
            const current = get().grids[deck];
            if (current?.grid !== next) return current?.grid ?? next;
            set((s) => ({
                grids: previous ? { ...s.grids, [deck]: { trackId, grid: previous } } : dropDeck(s.grids, deck),
                errors: { ...s.errors, [deck]: errorText(e) },
            }));
            return previous ?? fallback;
        }
    },
}));

/** The stored grid when it belongs to `trackId`, else `undefined` (stale entry from another track). */
function storedFor(entry: DeckGrid | undefined, trackId: string | null): GridModel | undefined {
    return entry && entry.trackId === trackId ? entry.grid : undefined;
}

/**
 * Forget `deck`'s grid because a new track is being loaded, and optionally seed the new one
 * (constant grid from the track's BPM). Called by `bridge/engine.ts` on both load paths, so the
 * freshly loaded track never inherits the previous track's markers.
 */
export function resetDeckGrid(deck: DeckId, trackId: string | null, seed?: GridModel): void {
    const store = useGridStore.getState();
    if (seed) store.setGrid(deck, trackId, seed);
    else store.clear(deck);
}

/** The deck's editable grid for `trackId`, or `undefined` when it has not been edited yet. */
export function useDeckGrid(deck: DeckId, trackId: string | null): GridModel | undefined {
    return useGridStore((s) => storedFor(s.grids[deck], trackId));
}

/** Engine rejection to show for `deck`, if any. */
export function useDeckGridError(deck: DeckId): string | undefined {
    return useGridStore((s) => s.errors[deck]);
}

/** Grid for `deck`, falling back to the constant grid of the deck snapshot. */
export function deckGridOr(deck: DeckId, trackId: string | null, bpm: number, firstBeat: number): GridModel {
    return storedFor(useGridStore.getState().grids[deck], trackId) ?? gridFromDeck(bpm, firstBeat);
}

// ---- actions used by the editor and the keyboard --------------------------

/**
 * Every action awaits the engine and resolves with the grid left in the store (rolled back when
 * the engine rejected it). Callers that do not care may `void` the promise — the rejection is
 * already handled and surfaced through `errors[deck]`.
 */
export const gridActions = {
    toggleFixed(deck: DeckId, trackId: string | null, fallback: GridModel): Promise<GridModel> {
        return useGridStore.getState().edit(deck, trackId, fallback, (g) => setFixed(g, !g.fixed));
    },
    /**
     * Add a tempo change at the playhead, snapped to the nearest beat. It starts one step
     * above the running tempo (a marker at the same tempo is not a change and would merge away).
     */
    addAtPlayhead(deck: DeckId, trackId: string | null, fallback: GridModel, sec: number): Promise<GridModel> {
        return useGridStore
            .getState()
            .edit(deck, trackId, fallback, (g) => addMarker(g, snapToBeat(g, sec), newMarkerBpm(g, sec)));
    },
    move(deck: DeckId, trackId: string | null, fallback: GridModel, index: number, sec: number): Promise<GridModel> {
        return useGridStore.getState().edit(deck, trackId, fallback, (g) => moveMarker(g, index, sec));
    },
    nudge(deck: DeckId, trackId: string | null, fallback: GridModel, index: number, deltaSec: number): Promise<GridModel> {
        return useGridStore.getState().edit(deck, trackId, fallback, (g) => nudgeMarker(g, index, deltaSec));
    },
    retune(deck: DeckId, trackId: string | null, fallback: GridModel, index: number, bpm: number): Promise<GridModel> {
        return useGridStore.getState().edit(deck, trackId, fallback, (g) => retuneMarker(g, index, bpm));
    },
    remove(deck: DeckId, trackId: string | null, fallback: GridModel, index: number): Promise<GridModel> {
        return useGridStore.getState().edit(deck, trackId, fallback, (g) => removeMarker(g, index));
    },
    /** Index of the marker nearest to `sec` (−1 when none is close enough). */
    nearest(deck: DeckId, trackId: string | null, fallback: GridModel, sec: number, tolerance: number): number {
        return markerIndexNear(storedFor(useGridStore.getState().grids[deck], trackId) ?? fallback, sec, tolerance);
    },
};
