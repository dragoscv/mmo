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
    /** Track each cue point was set on: a cue point never carries over to another track. */
    cueTrack: Record<DeckId, string | null>;
    tab: Record<DeckId, DeckTab>;
    trimDb: Record<DeckId, number>;
    setCuePoint: (deck: DeckId, sec: number, trackId: string | null) => void;
    setTab: (deck: DeckId, tab: DeckTab) => void;
    setTrimDb: (deck: DeckId, db: number) => void;
}

const all = <T,>(v: T): Record<DeckId, T> => ({ a: v, b: v, c: v, d: v });

/**
 * The main cue point of `deck` for the track it holds now: the stored point when it was set on
 * this track (clamped to the track's length), else the start of the track.
 */
export function cuePointFor(ui: Pick<DeckUi, "cuePoint" | "cueTrack">, deck: DeckId, trackId: string | null, duration: number): number {
    if (ui.cueTrack[deck] !== trackId) return 0;
    const sec = ui.cuePoint[deck];
    if (!Number.isFinite(sec) || sec <= 0) return 0;
    return Number.isFinite(duration) && duration > 0 ? Math.min(sec, duration) : sec;
}

export const useDeckUi = create<DeckUi>((set) => ({
    cuePoint: all(0),
    cueTrack: all<string | null>(null),
    tab: all<DeckTab>("cues"),
    trimDb: all(0),
    setCuePoint: (deck, sec, trackId) => set((s) => ({ cuePoint: { ...s.cuePoint, [deck]: Math.max(0, sec) }, cueTrack: { ...s.cueTrack, [deck]: trackId } })),
    setTab: (deck, tab) => set((s) => ({ tab: { ...s.tab, [deck]: tab } })),
    setTrimDb: (deck, db) => set((s) => ({ trimDb: { ...s.trimDb, [deck]: db } })),
}));
