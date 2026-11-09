// Run: node --test apps/mixai/src/layout/editor.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeArea, resizeArea, setTrackCount } from "./editor-ops.ts";
import { CLASSIC } from "./presets.ts";
import { validateLayout } from "./solver.ts";
import { PANEL_IDS } from "./types.ts";

test("placing a panel removes the panels it overlaps and stays valid", () => {
    const l = placeArea(CLASSIC, "sampler", 2, 3);
    assert.ok(l.areas.some((a) => a.panel === "sampler" && a.col === 2 && a.row === 3));
    assert.ok(!l.areas.some((a) => a.panel === "automix"));
    assert.deepEqual(validateLayout(l, PANEL_IDS), []);
});

test("moving a panel keeps its span clamped to the grid", () => {
    const l = placeArea(CLASSIC, "library", 2, 3);
    const lib = l.areas.find((a) => a.panel === "library")!;
    assert.equal(lib.col, 2);
    assert.equal(lib.colSpan ?? 1, 1);
});

test("resize grows within the grid and evicts overlapped panels", () => {
    const l = resizeArea(CLASSIC, "automix", 0, 0);
    assert.deepEqual(l.areas.find((a) => a.panel === "automix"), CLASSIC.areas.find((a) => a.panel === "automix"));
    const g = resizeArea(CLASSIC, "clock", 0, 2);
    const clock = g.areas.find((a) => a.panel === "clock")!;
    assert.equal(clock.rowSpan, 3);
    assert.ok(!g.areas.some((a) => a.panel === "mixer"));
});

test("track count changes drop areas outside and clamp spans", () => {
    const l = setTrackCount(CLASSIC, "rows", 2);
    assert.equal(l.rows.length, 2);
    for (const a of l.areas) assert.ok(a.row + (a.rowSpan ?? 1) <= 2);
    const more = setTrackCount(CLASSIC, "columns", 5);
    assert.equal(more.columns.length, 5);
    assert.equal(setTrackCount(CLASSIC, "columns", 99).columns.length, 8);
});
