// Run: cd apps/mixai; node --test "src/**/*.test.ts"
//
// The marker-row keyboard contract (WP19-37 review P1-14): the row must not act on keys typed
// in the BPM input inside it, and the BPM field must be committable rather than snapping back
// on every partial value.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    NUDGE_COARSE_SEC,
    NUDGE_SEC,
    bpmDraft,
    commitBpmDraft,
    isRowEvent,
    markerRowAction,
} from "./editor-keys.ts";
import { BPM_STEP } from "./markers.ts";

test("only keys raised by the row itself are the row's to handle", () => {
    const row = { tag: "li" };
    const input = { tag: "input" };
    assert.equal(isRowEvent(row, row), true, "focus on the row");
    assert.equal(isRowEvent(input, row), false, "typed in the BPM input: the row must not act");
    // The regression this guards: Backspace in the input used to delete the whole marker.
    assert.ok(markerRowAction("Backspace")?.kind === "remove", "Backspace is a row action…");
    assert.equal(isRowEvent(input, row), false, "…so it must be gated on the event target");
});

test("arrows nudge, up/down retune, Delete and Backspace remove, everything else is ignored", () => {
    assert.deepEqual(markerRowAction("ArrowLeft"), { kind: "nudge", deltaSec: -NUDGE_SEC });
    assert.deepEqual(markerRowAction("ArrowRight"), { kind: "nudge", deltaSec: NUDGE_SEC });
    assert.deepEqual(markerRowAction("ArrowLeft", true), { kind: "nudge", deltaSec: -NUDGE_COARSE_SEC });
    assert.deepEqual(markerRowAction("ArrowRight", true), { kind: "nudge", deltaSec: NUDGE_COARSE_SEC });
    assert.deepEqual(markerRowAction("ArrowUp"), { kind: "retune", deltaBpm: BPM_STEP });
    assert.deepEqual(markerRowAction("ArrowDown"), { kind: "retune", deltaBpm: -BPM_STEP });
    assert.deepEqual(markerRowAction("Delete"), { kind: "remove" });
    assert.deepEqual(markerRowAction("Backspace"), { kind: "remove" });
    for (const k of ["Tab", "Enter", "a", "1", " ", "Escape", "Home"]) {
        assert.equal(markerRowAction(k), null, `${k} is not a row action`);
    }
    assert.ok(NUDGE_COARSE_SEC > NUDGE_SEC, "Shift is the coarse step");
});

test("a BPM can be typed digit by digit: nothing is committed until the value is valid", () => {
    // Typing "128" over "120.00": every intermediate state used to snap back.
    assert.equal(commitBpmDraft("1"), null, "below the engine minimum");
    assert.equal(commitBpmDraft("12"), null);
    assert.equal(commitBpmDraft("128"), 128, "committed once it is a real tempo");
    assert.equal(commitBpmDraft("128.5"), 128.5);
    assert.equal(commitBpmDraft("128,5"), 128.5, "comma decimal (RO keyboards)");
    assert.equal(commitBpmDraft(""), null);
    assert.equal(commitBpmDraft("   "), null);
    assert.equal(commitBpmDraft("abc"), null);
    assert.equal(commitBpmDraft("-130"), null);
    assert.equal(commitBpmDraft("1200"), null, "above the engine maximum");
    assert.equal(commitBpmDraft("Infinity"), null);
});

test("the resting value of the field is the marker's tempo at 2 decimals", () => {
    assert.equal(bpmDraft(128), "128.00");
    assert.equal(bpmDraft(127.994), "127.99");
    // And it round-trips through a commit.
    assert.equal(commitBpmDraft(bpmDraft(128.25)), 128.25);
});
