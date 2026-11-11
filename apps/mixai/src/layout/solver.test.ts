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

test("invalid weights skip the per-cell checks (huge pack input stays cheap, P1-11)", () => {
    const n = 10_000;
    const bad = {
        ...CLASSIC,
        columns: Array(n).fill(1),
        rows: Array(n).fill(1),
        areas: [
            { panel: "deckA", col: 0, row: 0, colSpan: n, rowSpan: n },
            { panel: "deckB", col: 0, row: 0, colSpan: n, rowSpan: n },
            { panel: "mixer", col: 0, row: 0 },
        ],
    };
    const t = performance.now();
    const errs = validateLayout(bad, PANEL_IDS);
    assert.deepEqual(errs, ["columns: 1..8 weights in (0, 20]", "rows: 1..8 weights in (0, 20]"]);
    assert.ok(performance.now() - t < 500, "validator must not walk 1e8 cells");
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

test("classic at 1920x1080 shows full decks; in a narrow window they degrade", () => {
    const big = solve(CLASSIC, { w: 1896, h: 1000 }, PANEL_SPECS);
    assert.equal(big.placements.find((p) => p.panel === "deckA")?.tier, "full");
    // Decks 1.5: a deck is full from 480x250, so 1366x768 still shows full decks.
    const laptop = solve(CLASSIC, { w: 1342, h: 700 }, PANEL_SPECS);
    assert.equal(laptop.placements.find((p) => p.panel === "deckA")?.tier, "full");
    const small = solve(CLASSIC, { w: 1000, h: 600 }, PANEL_SPECS);
    assert.equal(small.placements.find((p) => p.panel === "deckA")?.tier, "compact");
});

test("pro (default) keeps full decks, mixer and waveform band from 1500x969 down to 1366x768", () => {
    const pro = BUILTIN_LAYOUTS[0]!;
    assert.equal(pro.id, "pro");
    const tier = (w: number, h: number, panel: string) => solve({ ...pro, gap: 2 }, { w, h }, PANEL_SPECS).placements.find((p) => p.panel === panel)?.tier;
    // Workspace = window minus the 36 px title bar and 4 px shell padding.
    for (const [w, h] of [[1492, 929], [1912, 1040]] as const) {
        for (const panel of ["waves", "deckA", "deckB", "mixer", "library"]) assert.equal(tier(w, h, panel), "full", `${panel} at ${w}x${h}`);
    }
    assert.equal(tier(1358, 728, "deckA"), "full");
    assert.equal(tier(1358, 728, "waves"), "full");
    assert.equal(solve({ ...pro, gap: 2 }, { w: 1358, h: 728 }, PANEL_SPECS).docked.length, 0);
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

test("solver still matches the golden fixtures shared with the Rust port (WP19-34)", async () => {
    const { readFileSync } = await import("node:fs");
    const { buildFixtures } = await import("./fixtures.ts");
    const url = new URL("../../../../docs/decks/fixtures/layout-cases.json", import.meta.url);
    const committed = readFileSync(url, "utf8").replace(/\r\n/g, "\n");
    // Byte-equal: any solver/preset/validator change must regenerate the file
    // (node scripts/gen-layout-fixtures.mjs) so crates/decks-layout is re-checked against it.
    assert.equal(buildFixtures(), committed, "docs/decks/fixtures/layout-cases.json is stale");
    assert.ok(JSON.parse(committed).cases.length >= 300);
});
