/**
 * Undo for the GRID tab. Every edit made from the editor goes through {@link editGrid}, which
 * remembers the grid that was there before; {@link undoGrid} puts it back through the same
 * store call (`useGridStore.edit`), so the engine sees an ordinary grid change.
 *
 * One stack per deck, for the track the deck holds (a new track starts empty).
 */
import { create } from "zustand";
import type { DeckId } from "@/bridge/types";
import { useGridStore } from "@/grid/grid-store";
import type { GridModel } from "@/grid/markers";
import { pushUndo, sameGrid, type UndoEntry } from "./grid-ops";

interface DeckUndo {
    trackId: string | null;
    stack: UndoEntry[];
}

interface GridUndoStore {
    decks: Partial<Record<DeckId, DeckUndo>>;
}

export const useGridUndo = create<GridUndoStore>(() => ({ decks: {} }));

function stackOf(deck: DeckId, trackId: string | null): UndoEntry[] {
    const d = useGridUndo.getState().decks[deck];
    return d && d.trackId === trackId ? d.stack : [];
}

function setStack(deck: DeckId, trackId: string | null, stack: UndoEntry[]): void {
    useGridUndo.setState((s) => ({ decks: { ...s.decks, [deck]: { trackId, stack } } }));
}

/** The grid the editor shows right now: the stored one for this track, else `fallback`. */
function currentGrid(deck: DeckId, trackId: string | null, fallback: GridModel): GridModel {
    const entry = useGridStore.getState().grids[deck];
    return entry && entry.trackId === trackId ? entry.grid : fallback;
}

/** True when there is a grid edit to undo on `deck` for `trackId`. */
export function useCanUndoGrid(deck: DeckId, trackId: string | null): boolean {
    return useGridUndo((s) => {
        const d = s.decks[deck];
        return !!d && d.trackId === trackId && d.stack.length > 0;
    });
}

/**
 * Run a grid edit (`run` = a `gridActions.*` call or `useGridStore.edit`) and remember the grid
 * before it. Edits that changed nothing, or that the engine refused (the store rolls those
 * back), leave no undo step.
 */
export async function editGrid(
    deck: DeckId,
    trackId: string | null,
    fallback: GridModel,
    tag: string,
    run: () => Promise<GridModel>,
    mergeMs?: number,
): Promise<GridModel> {
    const before = currentGrid(deck, trackId, fallback);
    const { stack, pushed } = pushUndo(stackOf(deck, trackId), before, tag, Date.now(), mergeMs);
    const entry = pushed ? stack.at(-1) : undefined;
    setStack(deck, trackId, stack);
    const after = await run();
    if (entry && sameGrid(after, before)) {
        setStack(
            deck,
            trackId,
            stackOf(deck, trackId).filter((e) => e !== entry),
        );
    }
    return after;
}

/** Put back the grid from before the last editor edit. */
export async function undoGrid(deck: DeckId, trackId: string | null, fallback: GridModel): Promise<void> {
    const stack = stackOf(deck, trackId);
    const top = stack.at(-1);
    if (!top) return;
    setStack(deck, trackId, stack.slice(0, -1));
    const after = await useGridStore.getState().edit(deck, trackId, fallback, () => top.grid);
    // The engine refused the old grid (the store rolled back): keep the step so it can be retried.
    if (!sameGrid(after, top.grid)) setStack(deck, trackId, [...stackOf(deck, trackId), top]);
}
