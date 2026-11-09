// Run: node --test apps/mixai/src/shell/governor.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { GOVERNOR, fpsOf, initialGovernor, stepGovernor, type GovernorState } from "./governor.ts";

function run(s: GovernorState, frameMs: number, totalMs: number): GovernorState {
    for (let t = 0; t < totalMs; t += frameMs) s = stepGovernor(s, frameMs);
    return s;
}

test("60 fps never reduces", () => {
    assert.equal(run(initialGovernor, 16.7, 60_000).reduced, false);
});

test("sustained 40 fps reduces after the reduce window", () => {
    const s = run(initialGovernor, 25, 3000);
    assert.equal(s.reduced, true);
});

test("a short hitch does not reduce", () => {
    let s = run(initialGovernor, 16.7, 2000);
    s = run(s, 40, 300);
    s = run(s, 16.7, 2000);
    assert.equal(s.reduced, false);
});

test("restores only after a sustained good period (hysteresis)", () => {
    let s = run(initialGovernor, 25, 3000);
    assert.equal(s.reduced, true);
    s = run(s, 16.7, GOVERNOR.restoreAfterMs / 2);
    assert.equal(s.reduced, true);
    s = run(s, 16.7, GOVERNOR.restoreAfterMs + 2000);
    assert.equal(s.reduced, false);
});

test("pauses (hidden tab) are ignored", () => {
    const s = stepGovernor(initialGovernor, 5000);
    assert.deepEqual(s, initialGovernor);
    assert.equal(fpsOf(16.7), 60);
});
