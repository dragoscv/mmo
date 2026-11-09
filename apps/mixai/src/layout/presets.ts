/**
 * Panel minimum sizes per tier and the built-in layout presets.
 *
 * The minimums are a contract with the components: a panel rendered at tier T
 * inside a rect of at least `min[T]` must not overflow (enforced by the
 * zero-scroll probe in docs/decks/layouts.md and the cloud capture run).
 */

import type { LayoutDoc, PanelId, PanelSpec } from "./types.ts";

const deck: PanelSpec["min"] = {
    full: { w: 460, h: 560 },
    compact: { w: 340, h: 330 },
    icon: { w: 220, h: 150 },
};

export const PANEL_SPECS: Record<PanelId, PanelSpec> = {
    deckA: { id: "deckA", min: deck, essential: true },
    deckB: { id: "deckB", min: deck, essential: true },
    deckC: { id: "deckC", min: deck, essential: true },
    deckD: { id: "deckD", min: deck, essential: true },
    clock: { id: "clock", min: { full: { w: 220, h: 72 }, compact: { w: 160, h: 40 }, icon: { w: 90, h: 28 } } },
    mixer: {
        id: "mixer",
        essential: true,
        min: { full: { w: 240, h: 440 }, compact: { w: 200, h: 260 }, icon: { w: 150, h: 150 } },
    },
    crossfader: {
        id: "crossfader",
        essential: true,
        min: { full: { w: 220, h: 100 }, compact: { w: 180, h: 56 }, icon: { w: 140, h: 36 } },
    },
    library: { id: "library", min: { full: { w: 520, h: 240 }, compact: { w: 320, h: 160 }, icon: { w: 200, h: 96 } } },
    automix: { id: "automix", min: { full: { w: 230, h: 230 }, compact: { w: 190, h: 130 }, icon: { w: 120, h: 56 } } },
    sampler: { id: "sampler", min: { full: { w: 270, h: 250 }, compact: { w: 200, h: 140 }, icon: { w: 120, h: 56 } } },
    plugins: { id: "plugins", min: { full: { w: 220, h: 160 }, compact: { w: 160, h: 96 }, icon: { w: 96, h: 48 } } },
};

/** Classic: decks left/right, mixer centre, utility band below. */
export const CLASSIC: LayoutDoc = {
    v: 1,
    id: "classic",
    name: "Classic",
    columns: [5, 3, 5],
    rows: [1, 9, 2, 6],
    areas: [
        { panel: "deckA", col: 0, row: 0, rowSpan: 3 },
        { panel: "clock", col: 1, row: 0 },
        { panel: "mixer", col: 1, row: 1 },
        { panel: "crossfader", col: 1, row: 2 },
        { panel: "deckB", col: 2, row: 0, rowSpan: 3 },
        { panel: "library", col: 0, row: 3, colSpan: 2 },
        { panel: "automix", col: 2, row: 3 },
    ],
};

/** Performance: decks take the height; library becomes a strip. */
export const PERFORMANCE: LayoutDoc = {
    v: 1,
    id: "performance",
    name: "Performance",
    columns: [5, 3, 5],
    rows: [1, 9, 2, 3],
    areas: [
        { panel: "deckA", col: 0, row: 0, rowSpan: 4 },
        { panel: "clock", col: 1, row: 0 },
        { panel: "mixer", col: 1, row: 1 },
        { panel: "crossfader", col: 1, row: 2 },
        { panel: "sampler", col: 1, row: 3 },
        { panel: "deckB", col: 2, row: 0, rowSpan: 4 },
    ],
};

/** Library: browsing first, decks condensed above. */
export const LIBRARY: LayoutDoc = {
    v: 1,
    id: "library",
    name: "Library",
    columns: [5, 3, 5],
    rows: [6, 2, 9],
    areas: [
        { panel: "deckA", col: 0, row: 0, rowSpan: 2 },
        { panel: "mixer", col: 1, row: 0 },
        { panel: "crossfader", col: 1, row: 1 },
        { panel: "deckB", col: 2, row: 0, rowSpan: 2 },
        { panel: "library", col: 0, row: 2, colSpan: 2 },
        { panel: "automix", col: 2, row: 2 },
    ],
};

/** Four decks (wide windows). */
export const FOUR_DECK: LayoutDoc = {
    v: 1,
    id: "four-deck",
    name: "4 decks",
    columns: [4, 4, 3, 4, 4],
    rows: [1, 9, 2, 5],
    areas: [
        { panel: "deckC", col: 0, row: 0, rowSpan: 3 },
        { panel: "deckA", col: 1, row: 0, rowSpan: 3 },
        { panel: "clock", col: 2, row: 0 },
        { panel: "mixer", col: 2, row: 1 },
        { panel: "crossfader", col: 2, row: 2 },
        { panel: "deckB", col: 3, row: 0, rowSpan: 3 },
        { panel: "deckD", col: 4, row: 0, rowSpan: 3 },
        { panel: "library", col: 0, row: 3, colSpan: 3 },
        { panel: "automix", col: 3, row: 3 },
        { panel: "sampler", col: 4, row: 3 },
    ],
};

/** Ultra-wide: library + utilities in side columns. */
export const ULTRAWIDE: LayoutDoc = {
    v: 1,
    id: "ultrawide",
    name: "Ultra-wide",
    columns: [4, 5, 3, 5, 3],
    rows: [1, 9, 2, 4],
    areas: [
        { panel: "library", col: 0, row: 0, rowSpan: 4 },
        { panel: "deckA", col: 1, row: 0, rowSpan: 4 },
        { panel: "clock", col: 2, row: 0 },
        { panel: "mixer", col: 2, row: 1 },
        { panel: "crossfader", col: 2, row: 2 },
        { panel: "plugins", col: 2, row: 3 },
        { panel: "deckB", col: 3, row: 0, rowSpan: 4 },
        { panel: "automix", col: 4, row: 0, rowSpan: 2 },
        { panel: "sampler", col: 4, row: 2, rowSpan: 2 },
    ],
};

/** Stage mode: only the decks, mixer and crossfader. */
export const STAGE: LayoutDoc = {
    v: 1,
    id: "stage",
    name: "Stage",
    columns: [5, 2, 5],
    rows: [9, 2],
    areas: [
        { panel: "deckA", col: 0, row: 0, rowSpan: 2 },
        { panel: "mixer", col: 1, row: 0 },
        { panel: "crossfader", col: 1, row: 1 },
        { panel: "deckB", col: 2, row: 0, rowSpan: 2 },
    ],
};

export const BUILTIN_LAYOUTS: LayoutDoc[] = [CLASSIC, PERFORMANCE, LIBRARY, FOUR_DECK, ULTRAWIDE];
