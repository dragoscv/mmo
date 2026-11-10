/**
 * Golden fixtures for the layout solver (WP19-34). The TS solver is the source of truth; the
 * Rust port (crates/decks-layout, used by the native apps over decks-ffi) asserts the same file:
 * docs/decks/fixtures/layout-cases.json. Regenerate with `node scripts/gen-layout-fixtures.mjs`.
 */
import { minimumSize, solve, validateLayout } from "./solver.ts";
import { BUILTIN_LAYOUTS, CLASSIC, PANEL_SPECS, STAGE } from "./presets.ts";
import { PANEL_IDS } from "./types.ts";

/** Window widths/heights; the small ones force icon tiers and docking. */
export const FIXTURE_WIDTHS = [360, 600, 800, 1024, 1280, 1600, 1920, 2560, 3440];
export const FIXTURE_HEIGHTS = [300, 480, 720, 900, 1080, 1440];

/** Validator inputs (messages and order must match in every port). */
export const VALIDATION_INPUTS: unknown[] = [
    null,
    "layout",
    [],
    CLASSIC,
    { ...CLASSIC, v: 2, id: "Bad Id", name: "" },
    { ...CLASSIC, columns: [], rows: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    { ...CLASSIC, columns: [0, 1, 21], gap: 40 },
    { ...CLASSIC, gap: "12" },
    { ...CLASSIC, areas: [] },
    {
        ...CLASSIC,
        areas: [
            { panel: "deckA", col: 0, row: 0 },
            { panel: "mixer", col: 0, row: 0 },
            { panel: "nope", col: 1, row: 0 },
            { panel: "deckA", col: 2, row: 0 },
            5,
        ],
    },
    {
        ...CLASSIC,
        areas: [
            { panel: "deckA", col: 0, row: 0, colSpan: 0 },
            { panel: "deckB", col: 2, row: 3, rowSpan: 2 },
            { panel: "mixer", col: 1.5, row: 0 },
            { panel: "clock", col: -1, row: 0 },
            { panel: "library", col: "1", row: 1 },
            { panel: "automix", col: 1, row: 1, colSpan: null, rowSpan: 3 },
        ],
    },
    // P1-11: spans that overflow i64 in the Rust port (2^62 + 2^62, and 1e300 which saturates
    // to i64::MAX there) must be "outside the grid", never a panic or an accepted area.
    {
        ...CLASSIC,
        areas: [
            { panel: "deckA", col: 2 ** 62, row: 0, colSpan: 2 ** 62 },
            { panel: "deckB", col: 0, row: 1e300, rowSpan: 1e300 },
            { panel: "mixer", col: 1, row: 0 },
        ],
    },
    // P1-11: invalid weights (9 columns, 9 rows) skip every per-cell check, so two areas that
    // would overlap on all 81 cells report only the weight errors.
    {
        ...CLASSIC,
        columns: [1, 1, 1, 1, 1, 1, 1, 1, 1],
        rows: [1, 1, 1, 1, 1, 1, 1, 1, 1],
        areas: [
            { panel: "deckA", col: 0, row: 0, colSpan: 9, rowSpan: 9 },
            { panel: "mixer", col: 0, row: 0, colSpan: 9, rowSpan: 9 },
            { panel: "deckB", col: 0, row: 0, colSpan: 9, rowSpan: 9 },
        ],
    },
];

interface Case {
    layout: string;
    w: number;
    h: number;
    solution: ReturnType<typeof solve>;
}

export function fixtureLayouts() {
    return [...BUILTIN_LAYOUTS, STAGE];
}

export function buildFixtures(): string {
    const layouts = fixtureLayouts();
    const cases: Case[] = [];
    for (const l of layouts)
        for (const w of FIXTURE_WIDTHS)
            for (const h of FIXTURE_HEIGHTS) cases.push({ layout: l.id, w, h, solution: solve(l, { w, h }, PANEL_SPECS) });
    const minimum = layouts.map((l) => ({ layout: l.id, size: minimumSize(l, PANEL_SPECS) }));
    const validation = VALIDATION_INPUTS.map((raw) => ({ raw, errors: validateLayout(raw, PANEL_IDS) }));
    const lines = [
        "{",
        `  "generator": "apps/mixai/scripts/gen-layout-fixtures.mjs",`,
        `  "layouts": ${JSON.stringify(layouts)},`,
        `  "minimum": ${JSON.stringify(minimum)},`,
        `  "validation": [`,
        validation.map((v) => `    ${JSON.stringify(v)}`).join(",\n"),
        "  ],",
        `  "cases": [`,
        cases.map((c) => `    ${JSON.stringify(c)}`).join(",\n"),
        "  ]",
        "}",
        "",
    ];
    return lines.join("\n");
}
