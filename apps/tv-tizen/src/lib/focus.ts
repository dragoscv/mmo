/**
 * Spatial D-pad navigation over every `[data-focusable]` element currently in
 * the DOM. Geometry-based: from the focused rect, pick the nearest candidate in
 * the pressed direction. Simple, framework-free, good enough for rows + grids.
 */

const SELECTOR = "[data-focusable]:not([disabled])";
/** Rows opt in with `data-focus-row="<id>"`; ↑/↓ into such a row restores the last focused card. */
const ROW_SELECTOR = "[data-focus-row]";
const lastInRow = new Map<string, HTMLElement>();
let rowMemoryInstalled = false;

function rowOf(el: HTMLElement): HTMLElement | null {
    return el.closest<HTMLElement>(ROW_SELECTOR);
}

/** Idempotent; called from the App once. Tracks focus per row via `focusin`. */
export function installRowMemory(): void {
    if (rowMemoryInstalled || typeof document === "undefined") return;
    rowMemoryInstalled = true;
    document.addEventListener("focusin", (e) => {
        const el = e.target as HTMLElement | null;
        if (!el || !el.matches?.(SELECTOR)) return;
        const row = rowOf(el);
        const id = row?.getAttribute("data-focus-row");
        if (id) lastInRow.set(id, el);
    });
}

/** Element to land on when entering `row` vertically: the remembered one, else `fallback`. */
function rememberedIn(row: HTMLElement | null, fallback: HTMLElement): HTMLElement {
    const id = row?.getAttribute("data-focus-row");
    const mem = id ? lastInRow.get(id) : undefined;
    if (mem && mem !== fallback && mem.isConnected && mem.matches(SELECTOR)) {
        const r = mem.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return mem;
    }
    return fallback;
}

export function focusables(root: ParentNode = document): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(SELECTOR)).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    });
}

export function currentFocus(): HTMLElement | null {
    const el = document.activeElement as HTMLElement | null;
    return el && el.matches(SELECTOR) ? el : null;
}

export function focusFirst(root: ParentNode = document): boolean {
    const el = focusables(root)[0];
    if (!el) return false;
    el.focus();
    return true;
}

type Dir = "up" | "down" | "left" | "right";

function center(r: DOMRect): { x: number; y: number } {
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function moveFocus(dir: Dir): boolean {
    const from = currentFocus();
    if (!from) return focusFirst();
    const fr = from.getBoundingClientRect();
    const fc = center(fr);
    const horizontal = dir === "left" || dir === "right";
    // Two passes: 1) candidates that overlap the source on the perpendicular
    // axis (same row / same column) — 2) anything inside a 45° cone. Without
    // pass 1, a card in the next row that is 20 px to the right beats the card
    // 300 px to the right in the same row.
    let bestAligned: HTMLElement | null = null; let alignedScore = Infinity;
    let bestCone: HTMLElement | null = null; let coneScore = Infinity;
    // Vertical: candidates in the nearest band (row) win regardless of column,
    // otherwise ↓ from column 5 skips a 2-card row and lands on a button far below.
    let nearest: { el: HTMLElement; r: DOMRect; primary: number; secondary: number } | null = null;
    const band: Array<{ el: HTMLElement; r: DOMRect; primary: number; secondary: number }> = [];
    for (const el of focusables()) {
        if (el === from) continue;
        const r = el.getBoundingClientRect();
        const c = center(r);
        const dx = c.x - fc.x;
        const dy = c.y - fc.y;
        let primary: number;
        let secondary: number;
        switch (dir) {
            case "left": primary = -dx; secondary = Math.abs(dy); break;
            case "right": primary = dx; secondary = Math.abs(dy); break;
            case "up": primary = -dy; secondary = Math.abs(dx); break;
            case "down": primary = dy; secondary = Math.abs(dx); break;
        }
        // Must be strictly in the requested direction (allow small overlap).
        if (primary <= 2) continue;
        if (!horizontal) {
            const cand = { el, r, primary, secondary };
            band.push(cand);
            if (!nearest || primary < nearest.primary) nearest = cand;
            continue;
        }
        // "Aligned" = overlaps by at least 40 % of the smaller extent on the
        // perpendicular axis; a 20 px graze must not beat a card straight below.
        const overlapPx = horizontal
            ? Math.min(r.bottom, fr.bottom) - Math.max(r.top, fr.top)
            : Math.min(r.right, fr.right) - Math.max(r.left, fr.left);
        const minExtent = horizontal ? Math.min(r.height, fr.height) : Math.min(r.width, fr.width);
        const overlaps = overlapPx >= minExtent * 0.4;
        const score = primary + secondary * 2;
        if (overlaps) {
            if (score < alignedScore) { alignedScore = score; bestAligned = el; }
        } else if (secondary <= primary) {
            if (score < coneScore) { coneScore = score; bestCone = el; }
        }
    }
    let best = bestAligned ?? bestCone;
    if (!horizontal && nearest) {
        const nr = nearest.r;
        // Same band = vertical overlap with the nearest candidate.
        const inBand = band.filter((c) => Math.min(c.r.bottom, nr.bottom) - Math.max(c.r.top, nr.top) > 0);
        inBand.sort((a, b) => a.secondary - b.secondary || a.primary - b.primary);
        best = inBand[0]?.el ?? nearest.el;
    }
    if (!best) return false;
    if (!horizontal) {
        const fromRow = rowOf(from);
        const toRow = rowOf(best);
        if (toRow && toRow !== fromRow) best = rememberedIn(toRow, best);
    }
    best.focus();
    best.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    return true;
}
