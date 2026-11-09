// Run: node --test apps/mixai/src/lib/perf.test.ts (Node ≥ 23 strips TS types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    applyRouting,
    beatInBar,
    clampKeyShift,
    DEFAULT_ROUTING,
    formatBeats,
    formatSemitones,
    fourChannelAvailable,
    reconcileDeckFlags,
    shiftCamelot,
} from "./perf.ts";

test("formatBeats renders musical fractions", () => {
    assert.equal(formatBeats(0.125), "1/8");
    assert.equal(formatBeats(0.25), "1/4");
    assert.equal(formatBeats(0.5), "1/2");
    assert.equal(formatBeats(0.75), "3/4");
    assert.equal(formatBeats(1), "1");
    assert.equal(formatBeats(4), "4");
    assert.equal(formatBeats(1.5), "3/2");
    assert.equal(formatBeats(0), "—");
    assert.equal(formatBeats(Number.NaN), "—");
});

test("key shift clamps and formats", () => {
    assert.equal(clampKeyShift(13), 12);
    assert.equal(clampKeyShift(-40), -12);
    assert.equal(clampKeyShift(1.4), 1);
    assert.equal(clampKeyShift(Number.NaN), 0);
    assert.equal(formatSemitones(0), "0");
    assert.equal(formatSemitones(2), "+2");
    assert.equal(formatSemitones(-3), "-3");
});

test("shiftCamelot moves +7 per semitone and keeps the letter", () => {
    assert.equal(shiftCamelot("8A", 0), "8A");
    assert.equal(shiftCamelot("8A", 1), "3A");
    assert.equal(shiftCamelot("8A", -1), "1A");
    assert.equal(shiftCamelot("12b", 2), "2B");
    assert.equal(shiftCamelot("8A", 12), "8A");
    assert.equal(shiftCamelot("xx", 1), null);
    assert.equal(shiftCamelot(null, 1), null);
    assert.equal(shiftCamelot("8A", 0.5), null);
});

test("applyRouting clamps every field", () => {
    const r = applyRouting(DEFAULT_ROUTING, {
        cueMix: 3,
        headphoneLevel: -1,
        boothLevel: 9,
        masterLatencyMs: 999,
        headphoneLatencyMs: Number.NaN,
        splitMono: true,
    });
    assert.equal(r.cueMix, 1);
    assert.equal(r.headphoneLevel, 0);
    assert.equal(r.boothLevel, 1.5);
    assert.equal(r.masterLatencyMs, 250);
    assert.equal(r.headphoneLatencyMs, DEFAULT_ROUTING.headphoneLatencyMs);
    assert.equal(r.splitMono, true);
    assert.equal(r.mode, "auto");
    assert.equal(applyRouting(DEFAULT_ROUTING, { mode: "fourChannel" }).mode, "fourChannel");
});

test("fourChannelAvailable needs ≥4 channels", () => {
    assert.equal(fourChannelAvailable(2), false);
    assert.equal(fourChannelAvailable(4), true);
    assert.equal(fourChannelAvailable(null), false);
});

test("reconcileDeckFlags keeps identity when unchanged", () => {
    const flags = { syncLock: false, quantize: true, slip: false, keyShift: 0 };
    const cur = { a: flags, b: flags, c: flags, d: flags };
    const clock = {
        decks: [{ id: "a" as const, bpm: 128, beat: 1, barPhase: 1, keyShift: 0, slip: false, quantize: true, syncLock: false }],
    };
    assert.equal(reconcileDeckFlags(cur, clock), cur);
    const changed = reconcileDeckFlags(cur, { decks: [{ ...clock.decks[0]!, syncLock: true, keyShift: 2 }] });
    assert.notEqual(changed, cur);
    assert.equal(changed.a.syncLock, true);
    assert.equal(changed.a.keyShift, 2);
    assert.equal(changed.b, cur.b);
    assert.equal(reconcileDeckFlags(cur, null), cur);
});

test("beatInBar uses barPhase, else beat modulo bar", () => {
    assert.equal(beatInBar({ barPhase: 2.7, beat: 10.7, beatsPerBar: 4 }), 2);
    assert.equal(beatInBar({ barPhase: null, beat: 9.2, beatsPerBar: 4 }), 1);
    assert.equal(beatInBar(null), null);
});
