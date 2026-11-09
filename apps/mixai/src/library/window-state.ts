/**
 * Pure windowing logic for the scroll-less Library list (hardware-browser
 * style): a fixed number of rows (`visible`) is shown starting at `offset`,
 * and a selection `cursor` always stays inside that window. No DOM, no React,
 * so it is unit-tested with `node --test` (window-state.test.ts).
 *
 * Invariants after every action:
 *   - total >= 0, visible >= 1
 *   - 0 <= offset <= max(0, total - visible)
 *   - total === 0 → cursor === 0 && offset === 0
 *   - total > 0  → 0 <= cursor < total && offset <= cursor < offset + visible
 */

export interface WindowState {
    total: number;
    visible: number;
    offset: number;
    cursor: number;
}

export type WindowAction =
    /** Move the cursor by n rows; the window follows the cursor. */
    | { type: "move"; n: number }
    /** Move cursor and window by one page (± visible rows). */
    | { type: "page"; dir: number }
    | { type: "home" }
    | { type: "end" }
    /** Shift the window by n rows (wheel / touch drag); the cursor is dragged along only if it would leave the window. */
    | { type: "scroll"; n: number }
    | { type: "setVisible"; n: number }
    | { type: "setTotal"; n: number }
    /** Select row i (clamped); the window follows. */
    | { type: "jumpTo"; index: number };

export const initialWindow: WindowState = { total: 0, visible: 1, offset: 0, cursor: 0 };

function int(n: number, fallback: number): number {
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
    return n < lo ? lo : n > hi ? hi : n;
}

/** Restore every invariant. `follow` decides which value wins when cursor and offset disagree. */
export function normalize(s: WindowState, follow: "cursor" | "window" = "cursor"): WindowState {
    const total = Math.max(0, int(s.total, 0));
    const visible = Math.max(1, int(s.visible, 1));
    if (total === 0) return { total, visible, offset: 0, cursor: 0 };
    const maxOffset = Math.max(0, total - visible);
    let cursor = clamp(int(s.cursor, 0), 0, total - 1);
    let offset = clamp(int(s.offset, 0), 0, maxOffset);
    if (follow === "cursor") {
        if (cursor < offset) offset = cursor;
        else if (cursor >= offset + visible) offset = cursor - visible + 1;
    } else {
        cursor = clamp(cursor, offset, Math.min(total - 1, offset + visible - 1));
    }
    offset = clamp(offset, 0, maxOffset);
    return { total, visible, offset, cursor };
}

export function windowState(s: WindowState, a: WindowAction): WindowState {
    const n = reduce(s, a);
    return n.total === s.total && n.visible === s.visible && n.offset === s.offset && n.cursor === s.cursor ? s : n;
}

function reduce(s: WindowState, a: WindowAction): WindowState {
    switch (a.type) {
        case "move":
            return normalize({ ...s, cursor: s.cursor + int(a.n, 0) });
        case "page": {
            const d = Math.sign(int(a.dir, 0)) * s.visible;
            return normalize({ ...s, cursor: s.cursor + d, offset: s.offset + d });
        }
        case "home":
            return normalize({ ...s, cursor: 0, offset: 0 });
        case "end":
            return normalize({ ...s, cursor: s.total - 1, offset: s.total });
        case "scroll":
            return normalize({ ...s, offset: s.offset + int(a.n, 0) }, "window");
        case "setVisible":
            return normalize({ ...s, visible: a.n });
        case "setTotal":
            return normalize({ ...s, total: a.n });
        case "jumpTo":
            return normalize({ ...s, cursor: a.index });
    }
}

/** 1-based inclusive range shown, for the position indicator. `from === 0` when empty. */
export function visibleRange(s: WindowState): { from: number; to: number; total: number } {
    if (s.total === 0) return { from: 0, to: 0, total: 0 };
    return { from: s.offset + 1, to: Math.min(s.total, s.offset + s.visible), total: s.total };
}
