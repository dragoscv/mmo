/**
 * Panel lab: render ONE panel at a chosen size and tier inside the running app, without
 * changing the layout (design / QA aid; driven by the dev hooks, unset in normal use).
 * The panel keeps its slot's top-left corner; only its box size and tier change.
 */
import { create } from "zustand";
import type { PanelId, Tier } from "./types.ts";

export interface PanelLabBox {
    w: number;
    h: number;
    tier: Tier;
}

interface PanelLabStore {
    boxes: Partial<Record<PanelId, PanelLabBox>>;
    set: (panel: PanelId, box: PanelLabBox | null) => void;
}

export const usePanelLab = create<PanelLabStore>((set) => ({
    boxes: {},
    set: (panel, box) =>
        set((s) => {
            const boxes = { ...s.boxes };
            if (box) boxes[panel] = box;
            else delete boxes[panel];
            return { boxes };
        }),
}));
