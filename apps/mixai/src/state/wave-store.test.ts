// Run: cd apps/mixai; node --test "src/**/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { lanePeak, parseBandWave, parseOverviewPeaks, parseStemLanes } from "./wave-store.ts";

function wire(pps: number, low: number[], mid: number[], high: number[]): ArrayBuffer {
    const n = low.length;
    const buf = new ArrayBuffer(8 + 3 * n);
    const v = new DataView(buf);
    v.setUint32(0, pps, true);
    v.setUint32(4, n, true);
    new Uint8Array(buf, 8).set([...low, ...mid, ...high]);
    return buf;
}

test("parseBandWave reads the header and the three lanes (same bytes as Rust BandWave::to_bytes)", () => {
    // Rust test `band_wave_wire_form_is_header_plus_three_lanes` asserts exactly these bytes.
    const buf = new Uint8Array([150, 0, 0, 0, 2, 0, 0, 0, 1, 2, 3, 4, 5, 6]).buffer;
    const w = parseBandWave(buf, "t1");
    assert.ok(w);
    assert.equal(w.pps, 150);
    assert.equal(w.len, 2);
    assert.deepEqual([...w.low], [1, 2]);
    assert.deepEqual([...w.mid], [3, 4]);
    assert.deepEqual([...w.high], [5, 6]);
    assert.equal(w.trackId, "t1");
});

test("parseBandWave rejects empty, truncated and inconsistent buffers", () => {
    assert.equal(parseBandWave(null, null), null);
    assert.equal(parseBandWave(new ArrayBuffer(0), null), null);
    assert.equal(parseBandWave(new ArrayBuffer(7), null), null);
    // Header says 3 points but only 2 per lane follow.
    const short = wire(150, [1, 2], [3, 4], [5, 6]);
    new DataView(short).setUint32(4, 3, true);
    assert.equal(parseBandWave(short, null), null);
    // Zero points per second or zero length carries no wave.
    assert.equal(parseBandWave(wire(0, [1], [1], [1]), null), null);
    assert.equal(parseBandWave(wire(150, [], [], []), null), null);
});

test("lanePeak takes the max over a clamped range and never reads outside the lane", () => {
    const lane = new Uint8Array([10, 200, 30, 40]);
    assert.equal(lanePeak(lane, 0, 4), 200);
    assert.equal(lanePeak(lane, 2, 4), 40);
    // Fractional bounds cover every touched point.
    assert.equal(lanePeak(lane, 0.2, 1.1), 200);
    // An empty or inverted range still covers one point.
    assert.equal(lanePeak(lane, 2, 2), 30);
    // Out of range on both sides.
    assert.equal(lanePeak(lane, -5, 99), 200);
    assert.equal(lanePeak(lane, 10, 12), 0);
});

test("parseStemLanes reads the mask and the four lanes (same bytes as Rust stem_lanes_bytes)", () => {
    // Rust test `stem_lanes_wire_form_is_header_mask_and_four_padded_lanes` asserts these bytes.
    const buf = new Uint8Array([150, 0, 0, 0, 3, 0, 0, 0, 0b1010, 0, 0, 0, 0, 0, 0, 1, 2, 3, 0, 0, 0, 7, 8, 0]).buffer;
    const s = parseStemLanes(buf, "t1");
    assert.ok(s);
    assert.equal(s.pps, 150);
    assert.equal(s.len, 3);
    assert.equal(s.lanes[0], null);
    assert.deepEqual([...s.lanes[1]!], [1, 2, 3]);
    assert.equal(s.lanes[2], null);
    assert.deepEqual([...s.lanes[3]!], [7, 8, 0]);
    assert.equal(s.trackId, "t1");
});

test("parseStemLanes rejects empty, stem-less and truncated buffers", () => {
    assert.equal(parseStemLanes(null, null), null);
    assert.equal(parseStemLanes(new ArrayBuffer(0), null), null);
    // Header only (no stems loaded): len 0, mask 0.
    assert.equal(parseStemLanes(new Uint8Array([150, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer, null), null);
    // Mask 0 with a length is not a stem set.
    assert.equal(parseStemLanes(new Uint8Array([150, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]).buffer, null), null);
    // One byte short.
    assert.equal(parseStemLanes(new Uint8Array([150, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1]).buffer, null), null);
});

test("parseOverviewPeaks folds Int16 min/max pairs into 0..255 bins", () => {
    const pairs: [number, number][] = [
        [-32768, 100],
        [-10, 16384],
        [0, 0],
        [-8192, 4096],
    ];
    const buf = new ArrayBuffer(pairs.length * 4);
    const v = new DataView(buf);
    pairs.forEach(([lo, hi], i) => {
        v.setInt16(i * 4, lo, true);
        v.setInt16(i * 4 + 2, hi, true);
    });
    // One bin per pair: |min| or |max|, whichever is larger.
    assert.deepEqual([...parseOverviewPeaks(buf, 4)!], [255, 128, 0, 64]);
    // Two bins: max of each half.
    assert.deepEqual([...parseOverviewPeaks(buf, 2)!], [255, 64]);
    // More bins than pairs: never more values than pairs.
    assert.equal(parseOverviewPeaks(buf, 100)!.length, 4);
    // Malformed: empty, not a multiple of 4 bytes, no bins.
    assert.equal(parseOverviewPeaks(new ArrayBuffer(0), 4), null);
    assert.equal(parseOverviewPeaks(new ArrayBuffer(6), 4), null);
    assert.equal(parseOverviewPeaks(buf, 0), null);
    assert.equal(parseOverviewPeaks(null, 4), null);
});
