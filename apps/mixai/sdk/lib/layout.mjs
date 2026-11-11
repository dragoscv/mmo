// Port of apps/mixai/src/layout/solver.ts validateLayout + PANEL_IDS (types.ts). Keep in sync.

export const PANEL_IDS = [
    "deckA", "deckB", "deckC", "deckD", "clock", "mixer", "crossfader", "library", "automix", "sampler", "plugins", "waves",
];

/** Ids of presets.ts BUILTIN_LAYOUTS: what a skin's `style.layout` may name besides a layout of its own pack. */
export const BUILTIN_LAYOUT_IDS = ["pro", "pro-vertical", "classic", "performance", "library", "four-deck", "ultrawide"];

/** Validation errors for a layout. Empty = valid. */
export function validateLayout(raw, known = PANEL_IDS) {
    const errs = [];
    // An array is an object here, exactly like solver.ts (the golden fixtures cover `[]`).
    if (!raw || typeof raw !== "object") return ["not an object"];
    const l = raw;
    if (l.v !== 1) errs.push("v must be 1");
    if (typeof l.id !== "string" || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(l.id)) errs.push("id must be a lowercase slug");
    if (typeof l.name !== "string" || l.name.length === 0 || l.name.length > 60) errs.push("name 1..60 chars");
    const okWeights = (w) => Array.isArray(w) && w.length >= 1 && w.length <= 8 && w.every((x) => typeof x === "number" && x > 0 && x <= 20);
    const columnsOk = okWeights(l.columns);
    if (!columnsOk) errs.push("columns: 1..8 weights in (0, 20]");
    const rowsOk = okWeights(l.rows);
    if (!rowsOk) errs.push("rows: 1..8 weights in (0, 20]");
    const gridOk = columnsOk && rowsOk;
    if (l.gap !== undefined && (typeof l.gap !== "number" || l.gap < 0 || l.gap > 32)) errs.push("gap 0..32");
    if (!Array.isArray(l.areas) || l.areas.length === 0) return [...errs, "areas required"];
    const nc = Array.isArray(l.columns) ? l.columns.length : 0;
    const nr = Array.isArray(l.rows) ? l.rows.length : 0;
    const seen = new Set();
    const occupied = new Set();
    for (const [i, a] of l.areas.entries()) {
        if (!a || !known.includes(a.panel)) {
            errs.push(`areas[${i}]: unknown panel`);
            continue;
        }
        if (seen.has(a.panel)) errs.push(`areas[${i}]: ${a.panel} used twice`);
        seen.add(a.panel);
        // No usable grid to place this area in; the weights error already says why (and 10 000
        // declared rows must not cost 1e8 set operations).
        if (!gridOk) continue;
        const cs = a.colSpan ?? 1;
        const rs = a.rowSpan ?? 1;
        const int = (n) => Number.isInteger(n) && n >= 0;
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
    for (const p of ["deckA", "deckB", "mixer"]) if (!seen.has(p)) errs.push(`missing essential panel ${p}`);
    return errs;
}
