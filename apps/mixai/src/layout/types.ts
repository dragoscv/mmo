/**
 * Layout model for MixAI Decks (zero-scroll shell).
 *
 * A layout is pure data (JSON, shareable through `.mixaipack`): a grid of
 * weighted columns/rows and panel areas on it. The solver (./solver.ts) turns a
 * layout + window size into concrete rectangles and picks a *tier* per panel
 * (full -> compact -> icon). Whatever cannot fit even as an icon goes to the
 * dock (tabs in a shared slot). Nothing in the shell ever scrolls.
 *
 * The same schema is meant for the Compose and SwiftUI apps (docs/decks/layouts.md).
 */

export const PANEL_IDS = [
    "deckA",
    "deckB",
    "deckC",
    "deckD",
    "clock",
    "mixer",
    "crossfader",
    "library",
    "automix",
    "sampler",
    "plugins",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

export const TIERS = ["full", "compact", "icon"] as const;
export type Tier = (typeof TIERS)[number];

/** Minimum size (CSS px) a panel needs to render a given tier without overflow. */
export interface PanelSpec {
    id: PanelId;
    min: Record<Tier, { w: number; h: number }>;
    /** Panels that must never be docked (transport-critical). */
    essential?: boolean;
}

export interface LayoutArea {
    panel: PanelId;
    col: number;
    row: number;
    colSpan?: number;
    rowSpan?: number;
}

export interface LayoutDoc {
    /** Schema version. */
    v: 1;
    id: string;
    name: string;
    /** Column weights (fr). */
    columns: number[];
    /** Row weights (fr). */
    rows: number[];
    areas: LayoutArea[];
    /** Gap between cells in px (default 12). */
    gap?: number;
}

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Placement {
    panel: PanelId;
    rect: Rect;
    tier: Tier;
}

export interface Solution {
    placements: Placement[];
    /** Panels that did not fit; rendered as tabs in the dock slot. */
    docked: PanelId[];
    /** Rect of the dock slot (the largest cell that held a docked panel), if any. */
    dock: Rect | null;
}
