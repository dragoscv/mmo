// Run: node --test apps/mixai/src/components/mixer/vu-math.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { VU, cellCount, cellZone, vuDbText, vuFraction, vuLit, vuLitClip, vuPercent } from "./vu-math.ts";

const lin = (db: number) => 10 ** (db / 20);

test("the lit layer is cut in the middle of the gap after the last lit cell", () => {
    assert.equal(vuLitClip(0, 10, "vertical"), "", "nothing lit: the stylesheet clips everything");
    assert.equal(vuLitClip(3, 0, "vertical"), "");
    assert.equal(vuLitClip(10, 10, "vertical"), "inset(0)");
    assert.equal(vuLitClip(12, 10, "horizontal"), "inset(0)");
    assert.equal(vuLitClip(3, 10, "vertical"), "inset(calc(100% - (100% + 2px) * 0.3 + 1px) 0 0 0)");
    assert.equal(vuLitClip(3, 10, "horizontal"), "inset(0 calc(100% - (100% + 2px) * 0.3 + 1px) 0 0)");
    // Geometry: for any meter length the cut lies strictly inside the gap after cell `lit - 1`.
    for (const cells of [3, 10, 32, 48]) {
        const len = cells * VU.cell + (cells - 1) * VU.gap + 3; // any length: cells stretch
        const pitch = (len + VU.gap) / cells;
        for (let lit = 1; lit < cells; lit++) {
            const f = Number((lit / cells).toFixed(5));
            const cut = (len + VU.gap) * f - VU.gap / 2; // lit length left visible
            const cellEnd = pitch * lit - VU.gap;
            assert.ok(cut > cellEnd && cut < cellEnd + VU.gap, `${cells} cells, ${lit} lit: cut ${cut} not in (${cellEnd}, ${cellEnd + VU.gap})`);
        }
    }
});

test("silence and anything at the floor light nothing; full scale lights every cell", () => {
    for (const cells of [3, 10, 32, 48]) {
        assert.equal(vuLit(0, cells), 0);
        assert.equal(vuLit(-1, cells), 0);
        assert.equal(vuLit(Number.NaN, cells), 0);
        assert.equal(vuLit(lin(VU.floorDb), cells), 0);
        assert.equal(vuLit(1, cells), cells);
        assert.equal(vuLit(4, cells), cells, "over full scale stays clamped");
    }
    assert.equal(vuLit(0.5, 0), 0, "an unmeasured meter has no cells");
});

test("any signal above the floor lights at least one cell and the count never decreases with level", () => {
    assert.equal(vuLit(lin(VU.floorDb + 0.1), 32), 1);
    let prev = 0;
    for (let db = VU.floorDb; db <= 0; db += 0.25) {
        const n = vuLit(lin(db), 32);
        assert.ok(n >= prev, `${db} dB: ${n} < ${prev}`);
        prev = n;
    }
    assert.equal(prev, 32);
});

test("the meter is linear in dB", () => {
    assert.equal(vuFraction(lin(-18)).toFixed(3), "0.500");
    assert.equal(vuPercent(lin(-9)), 75);
    assert.equal(vuPercent(0), 0);
    assert.equal(vuPercent(1), 100);
});

test("a lit cell's zone is the zone of the level that lights it", () => {
    const cells = 36; // 1 dB per cell
    // -10 dB lights cells 0..25, all below the amber threshold.
    const n = vuLit(lin(-10), cells);
    assert.equal(n, 26);
    for (let i = 0; i < n; i++) assert.equal(cellZone(i, cells), "ok", `cell ${i}`);
    // The cell that starts at -9 dB is amber, the one at -3 dB is red; zones only go up.
    assert.equal(cellZone(27, cells), "hot");
    assert.equal(cellZone(32, cells), "hot");
    assert.equal(cellZone(33, cells), "clip");
    assert.equal(cellZone(35, cells), "clip");
    const rank = { ok: 0, hot: 1, clip: 2 } as const;
    for (const c of [3, 7, 16, 48]) for (let i = 1; i < c; i++) assert.ok(rank[cellZone(i, c)] >= rank[cellZone(i - 1, c)]);
    // Every meter, however short, ends in a red cell and starts green.
    for (const c of [3, 4, 10]) {
        assert.equal(cellZone(0, c), "ok");
        assert.equal(cellZone(c - 1, c), c >= 12 ? "clip" : cellZone(c - 1, c));
    }
});

test("cell count follows the measured length within its bounds", () => {
    assert.equal(cellCount(0), 0);
    assert.equal(cellCount(-5), 0);
    assert.equal(cellCount(10), VU.minCells);
    assert.equal(cellCount(190), 32);
    assert.equal(cellCount(62), 10);
    assert.equal(cellCount(5000), VU.maxCells);
});

test("dB text is a whole number of dB", () => {
    assert.equal(vuDbText(1), "0 dB");
    assert.equal(vuDbText(lin(-12)), "-12 dB");
    assert.equal(vuDbText(0.5), "-6 dB");
});
