// Run: node --test apps/mixai/src/components/mixer/knob-math.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DETENT, arcPath, arcRange, dragPos, isBipolar, keyValue, knobSteps, posToAngle, posToValue, valueToPos, type KnobScale } from "./knob-math.ts";

const EQ: KnobScale = { min: -26, max: 6, center: 0 };
const TRIM: KnobScale = { min: -24, max: 12, center: 0 };
const MASTER: KnobScale = { min: 0, max: 1, center: 1 };
const WET: KnobScale = { min: 0, max: 1, center: 0.5, bipolar: false };
const BOOTH: KnobScale = { min: 0, max: 1.5, center: 0 };

test("a knob is bipolar only when its detent is strictly inside the range (and not forced one-sided)", () => {
    assert.equal(isBipolar(EQ), true);
    assert.equal(isBipolar(TRIM), true);
    assert.equal(isBipolar(MASTER), false, "detent at the maximum");
    assert.equal(isBipolar(BOOTH), false, "detent at the minimum");
    assert.equal(isBipolar(WET), false, "forced one-sided");
    assert.equal(isBipolar({ min: 0, max: 1 }), false);
});

test("the detent of a lopsided range sits at 12 o'clock", () => {
    assert.equal(valueToPos(0, EQ), 0.5);
    assert.equal(posToAngle(valueToPos(0, EQ)), 0);
    assert.equal(posToAngle(valueToPos(-26, EQ)), -135);
    assert.equal(posToAngle(valueToPos(6, EQ)), 135);
    // Each half is linear on its own side.
    assert.equal(valueToPos(-13, EQ), 0.25);
    assert.equal(valueToPos(3, EQ), 0.75);
    // One-sided knobs stay linear over the whole range.
    assert.equal(valueToPos(0.25, WET), 0.25);
    assert.equal(valueToPos(0.75, BOOTH), 0.5);
});

test("value → travel → value round-trips, and the ends and the detent come back exact", () => {
    for (const s of [EQ, TRIM, MASTER, WET, BOOTH]) {
        assert.equal(posToValue(0, s), s.min);
        assert.equal(posToValue(1, s), s.max);
        for (let i = 0; i <= 40; i++) {
            const v = s.min + (i / 40) * (s.max - s.min);
            assert.ok(Math.abs(posToValue(valueToPos(v, s), s) - v) < 1e-9, `${v}`);
        }
    }
    assert.equal(posToValue(0.5, EQ), 0);
    assert.equal(posToValue(valueToPos(0, TRIM), TRIM), 0);
});

test("out-of-range input is clamped, and a degenerate range does not divide by zero", () => {
    assert.equal(valueToPos(99, EQ), 1);
    assert.equal(valueToPos(-99, EQ), 0);
    assert.equal(posToValue(7, EQ), 6);
    assert.equal(posToValue(-7, EQ), -26);
    assert.equal(valueToPos(3, { min: 2, max: 2 }), 0);
});

test("the lit arc starts at the detent on a bipolar knob and at the minimum otherwise", () => {
    assert.deepEqual(arcRange(0.5, true), [0.5, 0.5]);
    assert.deepEqual(arcRange(0.8, true), [0.5, 0.8]);
    assert.deepEqual(arcRange(0.2, true), [0.2, 0.5]);
    assert.deepEqual(arcRange(0.2, false), [0, 0.2]);
});

test("dragging: 180 px for the full travel, Shift is finer, and only a coarse drag snaps to the detent", () => {
    assert.equal(dragPos(0, 180, false, false), 1);
    assert.equal(dragPos(0.5, -90, false, false), 0);
    assert.equal(dragPos(0, 180, true, false).toFixed(3), "0.300");
    assert.equal(dragPos(0.4, 0.1 * 180 - 1, false, true), 0.5, "within the detent");
    assert.notEqual(dragPos(0.4, (0.1 + DETENT) * 180 + 1, false, true), 0.5, "past the detent");
    assert.notEqual(dragPos(0.4, 0.1 * 600 - 3, true, true), 0.5, "fine drag never snaps");
    assert.notEqual(dragPos(0.4, 0.1 * 180 - 1, false, false), 0.5, "one-sided knobs have no detent");
});

const DB = knobSteps(EQ, 0.5, 0.1);

test("keyboard steps are the same size in dB on both sides of the detent (lopsided EQ)", () => {
    // The bug this replaces: keys stepped the travel, so −26..+6 dB moved 0.52 dB down, 0.12 dB up.
    assert.equal(keyValue(0, "ArrowUp", false, EQ, DB), 0.5);
    assert.equal(keyValue(0, "ArrowDown", false, EQ, DB), -0.5);
    assert.equal(keyValue(0, "ArrowRight", true, EQ, DB), 0.1);
    assert.equal(keyValue(0, "ArrowLeft", true, EQ, DB), -0.1);
    // Ten presses each way from the detent land on ±5 dB, and come back to exactly 0.
    let up = 0;
    let down = 0;
    for (let i = 0; i < 10; i++) {
        up = keyValue(up, "ArrowUp", false, EQ, DB)!;
        down = keyValue(down, "ArrowDown", false, EQ, DB)!;
    }
    assert.equal(up, 5);
    assert.equal(down, -5);
    for (let i = 0; i < 10; i++) {
        up = keyValue(up, "ArrowDown", false, EQ, DB)!;
        down = keyValue(down, "ArrowUp", false, EQ, DB)!;
    }
    assert.equal(up, 0);
    assert.equal(down, 0);
    // Default steps (no explicit size) are equal on both sides too: 1 % of the range.
    const d = knobSteps(EQ);
    assert.equal(d.step, 0.32);
    assert.equal(keyValue(0, "ArrowUp", false, EQ)! - 0, 0 - keyValue(0, "ArrowDown", false, EQ)!);
});

test("keyboard: a value between two steps (after a drag) moves to the next grid line, never past it", () => {
    assert.equal(keyValue(0.2, "ArrowUp", false, EQ, DB), 0.5);
    assert.equal(keyValue(0.2, "ArrowDown", false, EQ, DB), 0);
    assert.equal(keyValue(-0.2, "ArrowUp", false, EQ, DB), 0, "back onto the detent");
    assert.equal(keyValue(-0.2, "ArrowDown", false, EQ, DB), -0.5);
    assert.equal(keyValue(1.3, "ArrowUp", true, EQ, DB), 1.4);
    // Float noise does not swallow or double a step.
    assert.equal(keyValue(0.1 + 0.2, "ArrowUp", true, EQ, DB), 0.4);
    assert.equal(keyValue(0.1 + 0.2, "ArrowDown", true, EQ, DB), 0.2);
});

test("keyboard: pages are a whole number of steps, Home / End the ends, everything clamps, other keys ignored", () => {
    assert.equal(DB.page, 3, "about 10 % of 32 dB, in 0.5 dB steps");
    assert.equal(keyValue(0, "PageUp", false, EQ, DB), 3);
    assert.equal(keyValue(0, "PageDown", false, EQ, DB), -3);
    assert.equal(keyValue(5, "PageUp", false, EQ, DB), 6);
    assert.equal(keyValue(5.8, "ArrowUp", false, EQ, DB), 6);
    assert.equal(keyValue(6, "ArrowUp", false, EQ, DB), 6);
    assert.equal(keyValue(-26, "ArrowDown", false, EQ, DB), -26);
    assert.equal(keyValue(-3, "Home", false, EQ, DB), -26);
    assert.equal(keyValue(-3, "End", false, EQ, DB), 6);
    assert.equal(keyValue(-3, "a", false, EQ, DB), null);
    assert.equal(keyValue(-3, " ", false, EQ, DB), null);
    // One-sided knobs step from the minimum: 1 % of the range, pages 10 %.
    assert.equal(keyValue(0.5, "ArrowUp", false, MASTER), 0.51);
    assert.equal(keyValue(0.5, "ArrowDown", true, MASTER), 0.4975);
    assert.equal(keyValue(0.5, "PageUp", false, MASTER), 0.6);
    assert.equal(keyValue(0.995, "ArrowUp", false, MASTER), 1);
    assert.equal(keyValue(0.75, "ArrowUp", false, BOOTH), 0.765);
    // A degenerate range does not move or divide by zero.
    assert.equal(keyValue(2, "ArrowUp", false, { min: 2, max: 2 }), 2);
});

test("arc paths are clockwise and use the large-arc flag only past 180°", () => {
    assert.equal(arcPath(10, 10, 8, 0, 90), "M 10 2 A 8 8 0 0 1 18 10");
    assert.match(arcPath(10, 10, 8, -135, 135), / 0 1 1 /);
    assert.match(arcPath(10, 10, 8, -135, 0), / 0 0 1 10 2$/);
});
