// Run: cd apps/mixai; node --test "src/components/deck-tabs/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { beatAt, gridFromDeck, type GridModel } from "../../grid/markers.ts";
import {
    MARKER_PAGE,
    TAP_KEEP,
    TAP_MIN_TAPS,
    UNDO_DEPTH,
    addTap,
    canScaleTempo,
    downbeatAt,
    pageCount,
    pushUndo,
    retuneAt,
    sameGrid,
    scaleTempo,
    shiftGrid,
    tapBpm,
    type UndoEntry,
} from "./grid-ops.ts";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);
/** Fractional part of a beat position, as the distance to the nearest beat line. */
const offBeat = (g: GridModel, sec: number) => {
    const b = beatAt(g, sec);
    return Math.abs(b - Math.round(b));
};

test("sameGrid: by value, markers included", () => {
    const a = gridFromDeck(120, 0.1, [{ sec: 10, bpm: 130 }]);
    assert.equal(sameGrid(a, a), true);
    assert.equal(sameGrid(a, gridFromDeck(120, 0.1, [{ sec: 10, bpm: 130 }])), true);
    assert.equal(sameGrid(a, gridFromDeck(121, 0.1, [{ sec: 10, bpm: 130 }])), false);
    assert.equal(sameGrid(a, gridFromDeck(120, 0.1, [{ sec: 10, bpm: 131 }])), false);
    assert.equal(sameGrid(a, gridFromDeck(120, 0.1)), false);
});

test("shiftGrid: moves the first beat and every marker", () => {
    const g = gridFromDeck(120, 0.1, [{ sec: 10, bpm: 130 }]);
    const s = shiftGrid(g, 0.05);
    near(s.firstBeat, 0.15);
    assert.equal(s.markers.length, 1);
    near(s.markers[0]!.sec, 10.05);
    assert.equal(s.markers[0]!.bpm, 130);
    assert.equal(s.bpm, 120);
});

test("shiftGrid: zero or junk is a no-op (same object)", () => {
    const g = gridFromDeck(120, 0.1);
    assert.equal(shiftGrid(g, 0), g);
    assert.equal(shiftGrid(g, Number.NaN), g);
});

test("shiftGrid: a constant grid pushed before the file wraps by whole beats", () => {
    const g = gridFromDeck(120, 0.1);
    const s = shiftGrid(g, -0.2);
    // -0.1 s + one beat of 0.5 s: the beat lines are where a plain shift would put them.
    near(s.firstBeat, 0.4);
    near(offBeat(s, 0.9), 0);
    assert.ok(s.firstBeat >= 0);
});

test("shiftGrid: a grid with tempo markers is left alone rather than wrapped", () => {
    const g = gridFromDeck(120, 0.1, [{ sec: 10, bpm: 130 }]);
    assert.equal(shiftGrid(g, -0.2), g);
});

test("downbeatAt: the beat at the playhead becomes a downbeat, no beat line moves", () => {
    const g = gridFromDeck(120, 0);
    // 1.0 s is beat 2 of a 4-beat bar.
    const d = downbeatAt(g, 1.0, 4);
    near(d.firstBeat, 1.0);
    near(offBeat(d, 0.5), 0);
    near(offBeat(d, 7.5), 0);
    const beat = Math.round(beatAt(d, 1.0));
    assert.equal(((beat % 4) + 4) % 4, 0);
});

test("downbeatAt: keeps the earliest such beat of a constant grid", () => {
    const g = gridFromDeck(120, 0);
    // 5.0 s is beat 10 = bar 3, beat 3: the downbeat row is 1.0, 3.0, 5.0 … and 1.0 is the first.
    near(downbeatAt(g, 5.0, 4).firstBeat, 1.0);
});

test("downbeatAt: already a downbeat, junk time or junk tempo is a no-op", () => {
    const g = gridFromDeck(120, 0);
    assert.equal(downbeatAt(g, 2.0, 4), g);
    assert.equal(downbeatAt(g, 0.02, 4), g);
    assert.equal(downbeatAt(g, Number.NaN, 4), g);
});

test("downbeatAt: does not move the first beat across a tempo marker", () => {
    const g = gridFromDeck(120, 0, [{ sec: 0.75, bpm: 130 }]);
    // Beat 2 lies after the marker at 0.75 s: moving the first beat there would change every beat.
    assert.equal(downbeatAt(g, timeOfBeat(g, 2), 4), g);
});

function timeOfBeat(g: GridModel, beat: number): number {
    // Bisect beatAt (monotonic) so the test does not depend on timeAt.
    let lo = 0;
    let hi = 60;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (beatAt(g, mid) < beat) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

test("scaleTempo: doubles and halves every tempo; refuses to leave the valid range", () => {
    const g = gridFromDeck(120, 0.1, [{ sec: 10, bpm: 130 }]);
    assert.equal(canScaleTempo(g, 2), true);
    const x2 = scaleTempo(g, 2);
    assert.equal(x2.bpm, 240);
    assert.equal(x2.markers[0]!.bpm, 260);
    near(x2.firstBeat, 0.1);
    const back = scaleTempo(x2, 0.5);
    assert.equal(back.bpm, 120);
    assert.equal(back.markers[0]!.bpm, 130);

    const fast = gridFromDeck(250, 0);
    assert.equal(canScaleTempo(fast, 2), false);
    assert.equal(scaleTempo(fast, 2), fast);
    const slow = gridFromDeck(30, 0);
    assert.equal(canScaleTempo(slow, 0.5), false);
    assert.equal(scaleTempo(slow, 0.5), slow);
    // One marker out of range is enough to refuse.
    assert.equal(canScaleTempo(gridFromDeck(120, 0, [{ sec: 10, bpm: 230 }]), 2), false);
});

test("retuneAt: the starting tempo before the first marker, the governing marker after it", () => {
    const g = gridFromDeck(120, 0, [{ sec: 10, bpm: 130 }]);
    const before = retuneAt(g, 5, 128);
    assert.equal(before.bpm, 128);
    assert.equal(before.markers[0]!.bpm, 130);
    const after = retuneAt(g, 12, 140);
    assert.equal(after.bpm, 120);
    assert.equal(after.markers[0]!.bpm, 140);
    assert.equal(retuneAt(g, 5, 0), g);
    assert.equal(retuneAt(g, 5, Number.NaN), g);
    assert.equal(retuneAt(gridFromDeck(120, 0), 30, 126.5).bpm, 126.5);
});

test("addTap: a run of taps; a long pause restarts it, a bounce is ignored", () => {
    assert.deepEqual(addTap([], 1000), [1000]);
    assert.deepEqual(addTap([1000], 1500), [1000, 1500]);
    assert.deepEqual(addTap([1000, 1500], 4000), [4000]);
    assert.deepEqual(addTap([1000, 1500], 1550), [1000, 1500]);
    let taps: number[] = [];
    for (let i = 0; i < TAP_KEEP + 5; i++) taps = addTap(taps, 1000 + i * 500);
    assert.equal(taps.length, TAP_KEEP);
    assert.equal(taps.at(-1), 1000 + (TAP_KEEP + 4) * 500);
});

test("tapBpm: needs four taps; averages the run to 0.1 BPM", () => {
    assert.equal(TAP_MIN_TAPS, 4);
    assert.equal(tapBpm([0, 500, 1000]), null);
    assert.equal(tapBpm([0, 500, 1000, 1500]), 120);
    assert.equal(tapBpm([0, 469, 938, 1406, 1875]), 128);
    assert.equal(tapBpm([5, 5, 5, 5]), null);
    // 10 BPM is not a tempo the grid accepts.
    assert.equal(tapBpm([0, 6000, 12000, 18000]), null);
});

test("pushUndo: equal tags close together are one step; others push; depth is capped", () => {
    const g0 = gridFromDeck(120, 0);
    const g1 = gridFromDeck(120, 0.01);
    const first = pushUndo([], g0, "shift", 1000);
    assert.equal(first.pushed, true);
    assert.equal(first.stack.length, 1);

    const merged = pushUndo(first.stack, g1, "shift", 1500);
    assert.equal(merged.pushed, false);
    assert.equal(merged.stack.length, 1);
    // The step still undoes to the grid before the FIRST edit of the run.
    assert.equal(merged.stack[0]!.grid, g0);
    assert.equal(merged.stack[0]!.at, 1500);

    assert.equal(pushUndo(merged.stack, g1, "shift", 2600).pushed, true);
    assert.equal(pushUndo(merged.stack, g1, "tap", 1600).pushed, true);
    assert.equal(pushUndo(merged.stack, g1, "", 1600).pushed, true);
    assert.equal(pushUndo([{ grid: g0, tag: "", at: 1000 }], g1, "", 1100).pushed, true);

    let stack: UndoEntry[] = [];
    for (let i = 0; i < UNDO_DEPTH + 10; i++) stack = pushUndo(stack, g0, `t${i}`, i * 5000).stack;
    assert.equal(stack.length, UNDO_DEPTH);
    assert.equal(stack.at(-1)!.tag, `t${UNDO_DEPTH + 9}`);
    assert.equal(stack[0]!.tag, "t10");
});

test("pageCount: six markers to a page, never zero pages", () => {
    assert.equal(MARKER_PAGE, 6);
    assert.equal(pageCount(0), 1);
    assert.equal(pageCount(6), 1);
    assert.equal(pageCount(7), 2);
    assert.equal(pageCount(13), 3);
    assert.equal(pageCount(5, 2), 3);
});
