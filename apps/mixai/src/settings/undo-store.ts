/**
 * In-memory undo for settings changes made by the modal (apply / profile
 * switch / reset). Each entry is a full `collect()` snapshot (incl. library).
 */
import { create } from "zustand";
import { popUndo, pushUndo } from "./undo-core";
import type { Sections } from "./settings-io";
import { apply, collect } from "./settings-live";

interface UndoEntry {
    label: string;
    snapshot: Sections;
}

interface UndoStore {
    stack: UndoEntry[];
    /** Bumped after every apply/undo so panes with local state remount. */
    rev: number;
    /** Last status line for the modal live region. */
    status: string | null;
    setStatus: (status: string | null) => void;
    /** Snapshot the live state, then run `fn`. */
    run: (label: string, fn: () => Promise<void> | void) => Promise<void>;
    /** Restore the last snapshot; returns its label (null when empty). */
    undo: () => Promise<string | null>;
}

export const useUndoStore = create<UndoStore>((set, get) => ({
    stack: [],
    rev: 0,
    status: null,
    setStatus: (status) => set({ status }),
    run: async (label, fn) => {
        const snapshot = await collect({ includeLibrary: true });
        set({ stack: pushUndo(get().stack, { label, snapshot }) });
        await fn();
        set({ rev: get().rev + 1 });
    },
    undo: async () => {
        const [top, rest] = popUndo(get().stack);
        if (!top) return null;
        set({ stack: rest });
        await apply(top.snapshot);
        set({ rev: get().rev + 1 });
        return top.label;
    },
}));
