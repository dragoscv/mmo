/** Pure layout-editing operations used by the layout editor (unit-tested in editor.test.ts). */
import type { LayoutArea, LayoutDoc, PanelId } from "./types.ts";

const covers = (a: LayoutArea, c: number, r: number) => c >= a.col && c < a.col + (a.colSpan ?? 1) && r >= a.row && r < a.row + (a.rowSpan ?? 1);

/** Place (or move) a panel at a cell, keeping its span clamped; overlapped panels go back to the palette. */
export function placeArea(l: LayoutDoc, panel: PanelId, col: number, row: number): LayoutDoc {
    const cur = l.areas.find((a) => a.panel === panel);
    const cs = Math.max(1, Math.min(cur?.colSpan ?? 1, l.columns.length - col));
    const rs = Math.max(1, Math.min(cur?.rowSpan ?? 1, l.rows.length - row));
    const next: LayoutArea = { panel, col, row, ...(cs > 1 ? { colSpan: cs } : {}), ...(rs > 1 ? { rowSpan: rs } : {}) };
    const cells: [number, number][] = [];
    for (let c = col; c < col + cs; c++) for (let r = row; r < row + rs; r++) cells.push([c, r]);
    const kept = l.areas.filter((a) => a.panel !== panel && !cells.some(([c, r]) => covers(a, c, r)));
    return { ...l, areas: [...kept, next] };
}

export function resizeArea(l: LayoutDoc, panel: PanelId, dc: number, dr: number): LayoutDoc {
    const a = l.areas.find((x) => x.panel === panel);
    if (!a) return l;
    const cs = Math.max(1, Math.min(l.columns.length - a.col, (a.colSpan ?? 1) + dc));
    const rs = Math.max(1, Math.min(l.rows.length - a.row, (a.rowSpan ?? 1) + dr));
    const resized = { ...l, areas: l.areas.map((x) => (x.panel === panel ? { ...x, colSpan: cs, rowSpan: rs } : x)) };
    return placeArea(resized, panel, a.col, a.row);
}

export function setTrackCount(l: LayoutDoc, axis: "columns" | "rows", n: number): LayoutDoc {
    const count = Math.max(1, Math.min(8, n));
    const weights = [...l[axis]];
    while (weights.length < count) weights.push(weights[weights.length - 1] ?? 1);
    weights.length = count;
    const key = axis === "columns" ? "col" : "row";
    const span = axis === "columns" ? "colSpan" : "rowSpan";
    const areas = l.areas.filter((a) => a[key] < count).map((a) => ({ ...a, [span]: Math.min(a[span] ?? 1, count - a[key]) }));
    return { ...l, [axis]: weights, areas };
}
