// Run: cd apps/mixai; node --test "src/**/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridFromDeck } from "../grid/markers.ts";
import { CORRECTION, SNAP_SEC, barsBetween, correct, formatBars, nextCueAhead, phaseOffset, predict, remainWarn, remainingSec, splitTime } from "./deck-time.ts";

const deck = (over: Partial<{ loaded: boolean; playing: boolean; duration: number; position: number; tempo: number }>) => ({
    loaded: true,
    playing: true,
    duration: 300,
    position: 0,
    tempo: 1,
    ...over,
});

test("remaining time follows the tempo and never goes negative", () => {
    assert.equal(remainingSec(deck({ position: 240 })), 60);
    assert.equal(remainingSec(deck({ position: 240, tempo: 1.5 })), 40);
    assert.equal(remainingSec(deck({ position: 400 })), 0);
    assert.equal(remainingSec(deck({ duration: 0 })), 0);
    // A zero / negative tempo is treated as 1 (never a division by zero).
    assert.equal(remainingSec(deck({ position: 290, tempo: 0 })), 10);
});

test("the end-of-track warning has two levels and only a playing, loaded deck warns", () => {
    assert.equal(remainWarn(deck({ position: 269 })), "none");
    assert.equal(remainWarn(deck({ position: 270 })), "soon"); // exactly 30 s left
    assert.equal(remainWarn(deck({ position: 284.9 })), "soon");
    assert.equal(remainWarn(deck({ position: 285 })), "now"); // exactly 15 s left
    assert.equal(remainWarn(deck({ position: 299 })), "now");
    // Faster tempo = the warning comes earlier in track time.
    assert.equal(remainWarn(deck({ position: 256, tempo: 1.5 })), "soon");
    assert.equal(remainWarn(deck({ position: 299, playing: false })), "none");
    assert.equal(remainWarn(deck({ position: 299, loaded: false })), "none");
    assert.equal(remainWarn(deck({ duration: 0, position: 0 })), "none");
});

test("splitTime gives m:ss and tenths, clamped at zero", () => {
    assert.deepEqual(splitTime(192.47), { main: "03:12", frac: "4" });
    assert.deepEqual(splitTime(59.99), { main: "00:59", frac: "9" });
    assert.deepEqual(splitTime(600), { main: "10:00", frac: "0" });
    assert.deepEqual(splitTime(-3), { main: "00:00", frac: "0" });
    assert.deepEqual(splitTime(Number.NaN), { main: "00:00", frac: "0" });
});

test("barsBetween counts whole bars and the beat inside the next one", () => {
    const g = gridFromDeck(120, 0); // 0.5 s per beat, 2 s per bar
    assert.deepEqual(barsBetween(g, 0, 24.6), { bars: 12, beat: 2 });
    assert.equal(formatBars(barsBetween(g, 0, 25)!), "12.3");
    assert.deepEqual(barsBetween(g, 10, 10), { bars: 0, beat: 1 });
    // 3/4 time.
    assert.deepEqual(barsBetween(g, 0, 3.2, 3), { bars: 2, beat: 1 });
    // Target behind the playhead, or no usable grid.
    assert.equal(barsBetween(g, 10, 5), null);
    assert.equal(barsBetween(null, 0, 5), null);
    // A tempo change is honoured: 60 s at 120 BPM then 60 s at 60 BPM = 120 + 60 beats.
    const flex = gridFromDeck(120, 0, [{ sec: 60, bpm: 60 }]);
    assert.deepEqual(barsBetween(flex, 0, 120), { bars: 45, beat: 1 });
});

test("nextCueAhead picks the nearest cue after the playhead", () => {
    const cues = [30, null, 10, 90, null, null, null, null];
    assert.deepEqual(nextCueAhead(cues, 0), { slot: 2, sec: 10 });
    assert.deepEqual(nextCueAhead(cues, 10), { slot: 0, sec: 30 }); // the cue we stand on is not "ahead"
    assert.deepEqual(nextCueAhead(cues, 31), { slot: 3, sec: 90 });
    assert.equal(nextCueAhead(cues, 95), null);
    assert.equal(nextCueAhead([], 0), null);
});

test("the playhead extrapolates between reports, corrects softly and snaps on a seek", () => {
    const h = { pos: 10, at: 1000 };
    assert.equal(predict(h, 1500, 1), 10.5);
    assert.equal(predict(h, 1500, 0), 10); // paused
    assert.equal(predict(h, 1500, -1), 9.5); // reverse
    // First report: taken as is.
    assert.deepEqual(correct(null, 4, 50, 1), { pos: 4, at: 50 });
    // Small error (report 20 ms ahead of the prediction): only a share of it is applied.
    const soft = correct(h, 10.52, 1500, 1);
    assert.ok(Math.abs(soft.pos - (10.5 + 0.02 * CORRECTION)) < 1e-9);
    assert.equal(soft.at, 1500);
    // Repeated reports converge on the engine instead of drifting.
    let cur = { pos: 0, at: 0 };
    for (let i = 1; i <= 60; i++) cur = correct(cur, i * 0.033 + 0.05, i * 33, 1);
    assert.ok(Math.abs(cur.pos - (60 * 0.033 + 0.05)) < 0.005, `converged to ${cur.pos}`);
    // A jump larger than SNAP_SEC is a seek.
    assert.deepEqual(correct(h, 10.5 + SNAP_SEC + 0.01, 1500, 1), { pos: 10.5 + SNAP_SEC + 0.01, at: 1500 });
    assert.deepEqual(correct(h, 200, 1500, 1), { pos: 200, at: 1500 });
});

test("phaseOffset wraps into [-0.5, 0.5)", () => {
    assert.ok(Math.abs(phaseOffset(8.25, 4.0) - 0.25) < 1e-9);
    assert.ok(Math.abs(phaseOffset(8.0, 4.25) + 0.25) < 1e-9);
    assert.ok(Math.abs(phaseOffset(3.9, 7.1) + 0.2) < 1e-9);
    assert.equal(phaseOffset(2.5, 2.0), -0.5);
    assert.equal(phaseOffset(5, 9), 0);
});
