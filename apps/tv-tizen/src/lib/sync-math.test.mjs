// node --experimental-strip-types --test src/lib/sync-math.test.mjs — same cases as server/src/hub/sync-math.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
    ClockEstimator, driftAction, expectedPosition, leadTimeMs, sampleFrom,
    DRIFT_START_MS, DRIFT_STOP_MS, DRIFT_SEEK_MS, CLOCK_WINDOW, CLOCK_ALPHA,
} from "./sync-math.ts";

test("constants match the server", () => {
    assert.equal(DRIFT_START_MS, 120);
    assert.equal(DRIFT_STOP_MS, 40);
    assert.equal(DRIFT_SEEK_MS, 1500);
    assert.equal(CLOCK_WINDOW, 8);
    assert.equal(CLOCK_ALPHA, 0.4);
});

test("sampleFrom: symmetric path gives the true offset", () => {
    // client 0 → server receives at 1050 (offset 1000, one-way 50) → replies at 1060 → client gets 120
    const s = sampleFrom(0, 1050, 1060, 120);
    assert.equal(s.offsetMs, 995);
    assert.equal(s.rttMs, 110);
    assert.equal(sampleFrom(100, 50, 50, 90).rttMs, 0, "negative RTT clamps to 0");
});

test("ClockEstimator trusts the lowest RTT and smooths with EMA 0.4", () => {
    const c = new ClockEstimator();
    c.add({ offsetMs: 100, rttMs: 50 });
    assert.equal(c.offsetMs, 100);
    c.add({ offsetMs: 300, rttMs: 400 }); // worse RTT → best is still the first sample
    assert.equal(c.offsetMs, 100);
    c.add({ offsetMs: 200, rttMs: 10 }); // new best → EMA step
    assert.equal(c.offsetMs, 100 + 0.4 * (200 - 100));
    assert.equal(c.rttMs, 10);
});

test("ClockEstimator keeps only the last 8 samples", () => {
    const c = new ClockEstimator();
    c.add({ offsetMs: 5, rttMs: 1 });
    for (let i = 0; i < 8; i++) c.add({ offsetMs: 50, rttMs: 100 });
    assert.equal(c.count, 8);
    assert.equal(c.rttMs, 100, "the rtt=1 sample fell out of the window");
});

test("expectedPosition advances only while playing", () => {
    assert.equal(expectedPosition({ playing: false, positionSec: 10, atServerMs: 0 }, 5000), 10);
    assert.equal(expectedPosition({ playing: true, positionSec: 10, atServerMs: 1000 }, 3000), 12);
    assert.equal(expectedPosition({ playing: true, positionSec: 10, atServerMs: 1000, rate: 2 }, 2000), 12);
    assert.equal(expectedPosition({ playing: true, positionSec: 10, atServerMs: 5000 }, 3000), 10, "future anchor never rewinds");
});

test("driftAction hysteresis: start 120 ms, stop 40 ms, seek 1.5 s, rate ±5 %", () => {
    assert.deepEqual(driftAction(10.1, 10, false), { kind: "none" }, "100 ms idle → no correction yet");
    assert.equal(driftAction(10.13, 10, false).kind, "rate", "130 ms → start");
    assert.equal(driftAction(10.06, 10, true).kind, "rate", "60 ms while correcting → keep going");
    assert.deepEqual(driftAction(10.03, 10, true), { kind: "none" }, "30 ms → stop");
    assert.deepEqual(driftAction(11.6, 10, false), { kind: "seek", positionSec: 10 });
    assert.deepEqual(driftAction(8.4, 10, true), { kind: "seek", positionSec: 10 });
    const ahead = driftAction(10.2, 10, false);
    assert.equal(ahead.kind, "rate");
    assert.equal(ahead.rate, 0.95, "ahead by 200 ms → slow down to 0.95");
    const behind = driftAction(9.0, 10, true);
    assert.equal(behind.kind, "rate");
    assert.equal(behind.rate, 1.05, "behind by 1 s → clamp at +5 %");
});

test("leadTimeMs = max RTT + 150 clamped 150..2000", () => {
    assert.equal(leadTimeMs([]), 150);
    assert.equal(leadTimeMs([10, 80]), 230);
    assert.equal(leadTimeMs([5000]), 2000);
});
