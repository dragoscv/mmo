/**
 * UI-only per-deck state that must survive tier changes (the tiered panels
 * remount their blocks): the CDJ-style main cue point, the selected lower tab
 * and the channel trim (the engine has `deck_set_trim` but no trim in its
 * snapshot, so the last value sent lives here).
 */
import { create } from "zustand";
import type { DeckId } from "@/bridge/types";

export type DeckTab = "cues" | "loops" | "fx" | "stems" | "grid";

interface DeckUi {
    cuePoint: Record<DeckId, number>;
    tab: Record<DeckId, DeckTab>;
    trimDb: Record<DeckId, number>;
    setCuePoint: (deck: DeckId, sec: number) => void;
    setTab: (deck: DeckId, tab: DeckTab) => void;
    setTrimDb: (deck: DeckId, db: number) => void;
}

const all = <T,>(v: T): Record<DeckId, T> => ({ a: v, b: v, c: v, d: v });

export const useDeckUi = create<DeckUi>((set) => ({
    cuePoint: all(0),
    tab: all<DeckTab>("cues"),
    trimDb: all(0),
    setCuePoint: (deck, sec) => set((s) => ({ cuePoint: { ...s.cuePoint, [deck]: Math.max(0, sec) } })),
    setTab: (deck, tab) => set((s) => ({ tab: { ...s.tab, [deck]: tab } })),
    setTrimDb: (deck, db) => set((s) => ({ trimDb: { ...s.trimDb, [deck]: db } })),
}));
