/**
 * Pure maths of the segmented level meters (no React, no DOM): tested with `node --test`.
 * A level is the engine's linear peak follower (0..1); the meter is linear in dB from
 * `floorDb` to 0 dBFS. Cell `i` (0 = bottom / left) is lit while the level is above the
 * cell's lower edge, so the colour zone of a cell is the zone of that edge.
 */

export const VU = {
    floorDb: -36,
    /** Amber from here … */
    hotDb: -9,
    /** … red from here. */
    clipDb: -3,
    /** Cell length and gap along the meter, CSS px (keep in sync with `.mx-vu` in mixer.css). */
    cell: 4,
    gap: 2,
    minCells: 3,
    maxCells: 48,
    /** Peak-hold time before the peak cell falls back to the current level. */
    holdMs: 1200,
    /** Shortest time between two updates of the accessible value (aria-valuenow / -valuetext). */
    ariaMs: 500,
} as const;

export type VuZone = "ok" | "hot" | "clip";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Level in dBFS (−Infinity for silence). */
export function vuDb(level: number): number {
    return level > 0 ? 20 * Math.log10(level) : -Infinity;
}

/** Position of a level on the meter, 0..1. */
export function vuFraction(level: number): number {
    if (!(level > 0)) return 0;
    return clamp((vuDb(level) - VU.floorDb) / (0 - VU.floorDb), 0, 1);
}

/** Number of lit cells out of `cells` (0 for silence or anything at / below the floor). */
export function vuLit(level: number, cells: number): number {
    if (cells <= 0) return 0;
    const f = vuFraction(level);
    if (f <= 0) return 0;
    return Math.min(cells, Math.max(1, Math.ceil(f * cells - 1e-9)));
}

/** Colour zone of cell `i` (0-based from the quiet end) in a meter of `cells` cells. */
export function cellZone(i: number, cells: number): VuZone {
    const db = VU.floorDb + (i / Math.max(1, cells)) * (0 - VU.floorDb);
    return db >= VU.clipDb ? "clip" : db >= VU.hotDb ? "hot" : "ok";
}

/** How many cells fit a meter `length` px long (0 while the meter is not measured yet). */
export function cellCount(length: number): number {
    if (!(length > 0)) return 0;
    return clamp(Math.floor((length + VU.gap) / (VU.cell + VU.gap)), VU.minCells, VU.maxCells);
}

/** `aria-valuenow` (0..100) of a level. */
export function vuPercent(level: number): number {
    return Math.round(vuFraction(level) * 100);
}

/** `aria-valuetext` of an audible level, e.g. "-12 dB". */
export function vuDbText(level: number): string {
    return `${Math.round(vuDb(level))} dB`;
}

/**
 * `clip-path` that shows the first `lit` of `cells` cells of the lit layer (vertical: from the
 * bottom, horizontal: from the left). Cells are `flex: 1` with `VU.gap` between them, so cell
 * `i` ends at `(100% + gap) · (i + 1) / cells − gap`; the cut sits in the middle of the gap
 * after the last lit cell. "" = nothing lit (the stylesheet default clips the whole layer).
 */
export function vuLitClip(lit: number, cells: number, orientation: "vertical" | "horizontal"): string {
    if (!(cells > 0) || !(lit > 0)) return "";
    if (lit >= cells) return "inset(0)";
    const f = Number((lit / cells).toFixed(5));
    const rest = `calc(100% - (100% + ${VU.gap}px) * ${f} + ${VU.gap / 2}px)`;
    return orientation === "vertical" ? `inset(${rest} 0 0 0)` : `inset(0 ${rest} 0 0)`;
}
