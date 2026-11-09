/**
 * Zero-scroll layout solver. Pure and deterministic, so it is unit-tested over
 * hundreds of window sizes (solver.test.ts) and portable to Kotlin/Swift.
 *
 * 1. Split the container into weighted columns/rows (fr semantics, fixed gap).
 * 2. Each area gets the union rect of its cells.
 * 3. Per panel, pick the richest tier whose minimum size fits that rect.
 * 4. A panel that fits no tier is docked: it becomes a tab in the dock host,
 *    the largest non-essential placed panel. Essential panels (decks, mixer)
 *    are never docked; they fall back to `icon` and the component guarantees it
 *    never overflows at that tier.
 */

import { TIERS, type LayoutDoc, type PanelId, type PanelSpec, type Placement, type Rect, type Solution, type Tier } from "./types.ts";

export const DEFAULT_GAP = 12;

/** Split `total` px into weighted tracks with `gap` px between them. */
export function tracks(total: number, weights: number[], gap: number): { start: number; size: number }[] {
    const n = weights.length;
    if (n === 0) return [];
    const sum = weights.reduce((a, b) => a + Math.max(0, b), 0) || n;
    const free = Math.max(0, total - gap * (n - 1));
    const out: { start: number; size: number }[] = [];
    let at = 0;
    for (const w of weights) {
        const size = (free * Math.max(0, w)) / sum;
        out.push({ start: at, size });
        at += size + gap;
    }
    return out;
}

export function fits(rect: Rect, min: { w: number; h: number }): boolean {
    // Half-pixel tolerance: fr math produces fractional sizes.
    return rect.w + 0.5 >= min.w && rect.h + 0.5 >= min.h;
}

export function pickTier(rect: Rect, spec: PanelSpec): Tier | null {
    for (const tier of TIERS) if (fits(rect, spec.min[tier])) return tier;
    return null;
}

export function solve(layout: LayoutDoc, size: { w: number; h: number }, specs: Record<PanelId, PanelSpec>): Solution {
    const gap = layout.gap ?? DEFAULT_GAP;
    const cols = tracks(size.w, layout.columns, gap);
    const rows = tracks(size.h, layout.rows, gap);
    const placements: Placement[] = [];
    const docked: PanelId[] = [];

    for (const a of layout.areas) {
        const c0 = cols[a.col];
        const r0 = rows[a.row];
        const c1 = cols[Math.min(cols.length - 1, a.col + (a.colSpan ?? 1) - 1)];
        const r1 = rows[Math.min(rows.length - 1, a.row + (a.rowSpan ?? 1) - 1)];
        if (!c0 || !r0 || !c1 || !r1) continue; // area outside the grid: ignored (validator rejects it)
        const rect: Rect = { x: c0.start, y: r0.start, w: c1.start + c1.size - c0.start, h: r1.start + r1.size - r0.start };
        const spec = specs[a.panel];
        const tier = pickTier(rect, spec);
        if (tier) placements.push({ panel: a.panel, rect, tier });
        else if (spec.essential) placements.push({ panel: a.panel, rect, tier: "icon" });
        else docked.push(a.panel);
    }

    let dock: Rect | null = null;
    if (docked.length > 0) {
        const bySize = (a: Placement, b: Placement) => b.rect.w * b.rect.h - a.rect.w * a.rect.h;
        // Prefer a non-essential host; else share the largest slot (an essential panel
        // becomes the first tab) so a docked panel never disappears.
        const host = [...placements.filter((p) => !specs[p.panel].essential)].sort(bySize)[0] ?? [...placements].sort(bySize)[0];
        if (host) dock = host.rect;
    }
    return { placements, docked, dock };
}

/** Validation errors for a (user or marketplace) layout. Empty = valid. */
export function validateLayout(raw: unknown, known: readonly PanelId[]): string[] {
    const errs: string[] = [];
    if (!raw || typeof raw !== "object") return ["not an object"];
    const l = raw as Partial<LayoutDoc>;
    if (l.v !== 1) errs.push("v must be 1");
    if (typeof l.id !== "string" || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(l.id)) errs.push("id must be a lowercase slug");
    if (typeof l.name !== "string" || l.name.length === 0 || l.name.length > 60) errs.push("name 1..60 chars");
    const okWeights = (w: unknown) => Array.isArray(w) && w.length >= 1 && w.length <= 8 && w.every((x) => typeof x === "number" && x > 0 && x <= 20);
    if (!okWeights(l.columns)) errs.push("columns: 1..8 weights in (0, 20]");
    if (!okWeights(l.rows)) errs.push("rows: 1..8 weights in (0, 20]");
    if (l.gap !== undefined && (typeof l.gap !== "number" || l.gap < 0 || l.gap > 32)) errs.push("gap 0..32");
    if (!Array.isArray(l.areas) || l.areas.length === 0) return [...errs, "areas required"];
    const nc = Array.isArray(l.columns) ? l.columns.length : 0;
    const nr = Array.isArray(l.rows) ? l.rows.length : 0;
    const seen = new Set<string>();
    const occupied = new Set<string>();
    for (const [i, a] of l.areas.entries()) {
        if (!a || !known.includes(a.panel)) {
            errs.push(`areas[${i}]: unknown panel`);
            continue;
        }
        if (seen.has(a.panel)) errs.push(`areas[${i}]: ${a.panel} used twice`);
        seen.add(a.panel);
        const cs = a.colSpan ?? 1;
        const rs = a.rowSpan ?? 1;
        const int = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
        if (!int(a.col) || !int(a.row) || !int(cs) || !int(rs) || cs < 1 || rs < 1 || a.col + cs > nc || a.row + rs > nr) {
            errs.push(`areas[${i}]: ${a.panel} outside the grid`);
            continue;
        }
        for (let c = a.col; c < a.col + cs; c++)
            for (let r = a.row; r < a.row + rs; r++) {
                const k = `${c},${r}`;
                if (occupied.has(k)) errs.push(`areas[${i}]: ${a.panel} overlaps cell ${k}`);
                occupied.add(k);
            }
    }
    for (const p of ["deckA", "deckB", "mixer"] as const) if (!seen.has(p)) errs.push(`missing essential panel ${p}`);
    return errs;
}

/**
 * Smallest window (px) at which every panel of the layout fits at least its
 * icon tier without docking an essential panel. The editor shows it and the
 * shell sets it as the native window minimum.
 */
export function minimumSize(layout: LayoutDoc, specs: Record<PanelId, PanelSpec>): { w: number; h: number } {
    const gap = layout.gap ?? DEFAULT_GAP;
    const need = (weights: number[], axis: "w" | "h", key: "col" | "row", span: "colSpan" | "rowSpan") => {
        const sum = weights.reduce((a, b) => a + b, 0);
        let best = 0;
        for (const a of layout.areas) {
            const spec = specs[a.panel];
            if (!spec.essential) continue;
            const s = a[span] ?? 1;
            const share = weights.slice(a[key], a[key] + s).reduce((x, y) => x + y, 0) / sum;
            const ownGaps = gap * (s - 1);
            const total = (spec.min.icon[axis] - ownGaps) / share + gap * (weights.length - 1);
            best = Math.max(best, total);
        }
        return Math.ceil(best);
    };
    return { w: need(layout.columns, "w", "col", "colSpan"), h: need(layout.rows, "h", "row", "rowSpan") };
}
