// Run: node --test apps/mixai/src/layout/solver.test.ts (Node >= 23 strips TS types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import { minimumSize, pickTier, solve, tracks, validateLayout } from "./solver.ts";
import { BUILTIN_LAYOUTS, CLASSIC, PANEL_SPECS, STAGE } from "./presets.ts";
import { PANEL_IDS } from "./types.ts";

test("tracks split the size by weight and keep the gaps", () => {
    const t = tracks(1012, [1, 1], 12);
    assert.deepEqual(t, [
        { start: 0, size: 500 },
        { start: 512, size: 500 },
    ]);
});

test("every built-in layout validates", () => {
    for (const l of [...BUILTIN_LAYOUTS, STAGE]) assert.deepEqual(validateLayout(l, PANEL_IDS), [], l.id);
});

test("validator rejects overlaps, unknown panels and missing decks", () => {
    const bad = {
        ...CLASSIC,
        areas: [
            { panel: "deckA", col: 0, row: 0 },
            { panel: "mixer", col: 0, row: 0 },
            { panel: "nope", col: 1, row: 0 },
        ],
    };
    const errs = validateLayout(bad, PANEL_IDS);
    assert.ok(errs.some((e) => e.includes("overlaps")));
    assert.ok(errs.some((e) => e.includes("unknown panel")));
    assert.ok(errs.some((e) => e.includes("deckB")));
});

test("pickTier falls back full -> compact -> icon -> null", () => {
    const s = PANEL_SPECS.library;
    assert.equal(pickTier({ x: 0, y: 0, w: 900, h: 400 }, s), "full");
    assert.equal(pickTier({ x: 0, y: 0, w: 400, h: 200 }, s), "compact");
    assert.equal(pickTier({ x: 0, y: 0, w: 210, h: 100 }, s), "icon");
    assert.equal(pickTier({ x: 0, y: 0, w: 100, h: 50 }, s), null);
});

test("no placement ever leaves the container and nothing overlaps (sweep)", () => {
    for (const layout of BUILTIN_LAYOUTS) {
        for (let w = 1024; w <= 3840; w += 97) {
            for (let h = 640; h <= 2160; h += 89) {
                const sol = solve(layout, { w, h }, PANEL_SPECS);
                for (const p of sol.placements) {
                    assert.ok(p.rect.x >= -0.01 && p.rect.y >= -0.01, `${layout.id} ${w}x${h} ${p.panel} negative`);
                    assert.ok(p.rect.x + p.rect.w <= w + 0.01 && p.rect.y + p.rect.h <= h + 0.01, `${layout.id} ${w}x${h} ${p.panel} outside`);
                }
                for (let i = 0; i < sol.placements.length; i++)
                    for (let j = i + 1; j < sol.placements.length; j++) {
                        const a = sol.placements[i]!.rect;
                        const b = sol.placements[j]!.rect;
                        const overlap = a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
                        assert.ok(!overlap, `${layout.id} ${w}x${h} overlap`);
                    }
                // Essential panels are never docked.
                for (const d of sol.docked) assert.ok(!PANEL_SPECS[d].essential, `${layout.id} docked essential ${d}`);
            }
        }
    }
});

test("non-essential placements always fit their tier minimum", () => {
    for (const layout of BUILTIN_LAYOUTS)
        for (let w = 1024; w <= 3440; w += 131)
            for (let h = 700; h <= 1440; h += 113) {
                const sol = solve(layout, { w, h }, PANEL_SPECS);
                for (const p of sol.placements) {
                    if (PANEL_SPECS[p.panel].essential) continue;
                    const m = PANEL_SPECS[p.panel].min[p.tier];
                    assert.ok(p.rect.w + 0.5 >= m.w && p.rect.h + 0.5 >= m.h, `${layout.id} ${w}x${h} ${p.panel}@${p.tier}`);
                }
            }
});

test("classic at 1920x1080 shows full decks; at 1366x768 they degrade, library docks or shrinks", () => {
    const big = solve(CLASSIC, { w: 1896, h: 1000 }, PANEL_SPECS);
    assert.equal(big.placements.find((p) => p.panel === "deckA")?.tier, "full");
    const small = solve(CLASSIC, { w: 1342, h: 700 }, PANEL_SPECS);
    assert.notEqual(small.placements.find((p) => p.panel === "deckA")?.tier, "full");
});

test("at its minimum size an essential panel fits its icon tier", () => {
    for (const layout of BUILTIN_LAYOUTS) {
        const m = minimumSize(layout, PANEL_SPECS);
        const sol = solve(layout, m, PANEL_SPECS);
        for (const p of sol.placements) {
            if (!PANEL_SPECS[p.panel].essential) continue;
            const icon = PANEL_SPECS[p.panel].min.icon;
            assert.ok(p.rect.w + 0.6 >= icon.w && p.rect.h + 0.6 >= icon.h, `${layout.id} ${m.w}x${m.h} ${p.panel}`);
        }
    }
});

test("a docked panel always has a host, even when only essential panels are placed", () => {
    const tiny = {
        v: 1 as const,
        id: "tiny-lib",
        name: "Tiny library",
        columns: [5, 3, 5],
        rows: [12, 1],
        areas: [
            { panel: "deckA" as const, col: 0, row: 0 },
            { panel: "mixer" as const, col: 1, row: 0 },
            { panel: "deckB" as const, col: 2, row: 0 },
            { panel: "library" as const, col: 1, row: 1 },
        ],
    };
    const sol = solve(tiny, { w: 1100, h: 700 }, PANEL_SPECS);
    assert.deepEqual(sol.docked, ["library"]);
    assert.ok(sol.dock, "dock slot exists");
});
