// Run: cd apps/mixai; node --test "src/**/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPhrases, phraseAt, type PhraseInput } from "./phrases.ts";
import type { GridModel } from "../grid/markers.ts";

const PPS = 150;
// 120 BPM, 4/4: one bar = 2 s, one 8-bar block = 16 s.
const GRID: GridModel = { bpm: 120, firstBeat: 0, markers: [], fixed: false };
const BLOCK = 16;

/** Build a wave from per-block [low, mid, high] levels (0..255). */
function wave(blocks: [number, number, number][]): PhraseInput {
    const n = blocks.length * BLOCK * PPS;
    const w = { pps: PPS, low: new Uint8Array(n), mid: new Uint8Array(n), high: new Uint8Array(n) };
    blocks.forEach(([lo, mid, hi], b) => {
        const from = b * BLOCK * PPS;
        w.low.fill(lo, from, from + BLOCK * PPS);
        w.mid.fill(mid, from, from + BLOCK * PPS);
        w.high.fill(hi, from, from + BLOCK * PPS);
    });
    return w;
}

const QUIET: [number, number, number] = [10, 60, 50];
const RISE: [number, number, number] = [110, 120, 120];
const FULL: [number, number, number] = [220, 180, 160];
const NO_BASS: [number, number, number] = [20, 150, 140];

test("a club track reads intro, build, main, break, main, outro, on block boundaries", () => {
    const blocks = [QUIET, QUIET, RISE, FULL, FULL, NO_BASS, FULL, FULL, QUIET];
    const p = detectPhrases(wave(blocks), GRID, blocks.length * BLOCK);
    assert.deepEqual(
        p.map((x) => [x.kind, x.fromSec, x.toSec]),
        [
            ["intro", 0, 32],
            ["build", 32, 48],
            ["main", 48, 80],
            ["break", 80, 96],
            ["main", 96, 128],
            ["outro", 128, 144],
        ],
    );
    // Phrases tile the track with no gap and no overlap.
    for (let i = 1; i < p.length; i++) assert.equal(p[i]!.fromSec, p[i - 1]!.toSec);
    assert.equal(phraseAt(p, 85)?.kind, "break");
    assert.equal(phraseAt(p, 144), null);
});

test("a track that is loud from start to end is one main phrase (no invented intro)", () => {
    const blocks = [FULL, FULL, FULL, FULL];
    assert.deepEqual(detectPhrases(wave(blocks), GRID, blocks.length * BLOCK), [{ kind: "main", fromSec: 0, toSec: 64 }]);
});

test("a rise that does not lead into a main block is not called a build", () => {
    const blocks = [FULL, FULL, RISE, NO_BASS, FULL, FULL];
    const kinds = detectPhrases(wave(blocks), GRID, blocks.length * BLOCK).map((x) => x.kind);
    assert.ok(!kinds.includes("build"), kinds.join(","));
});

test("blocks follow the grid: a later first beat and a tempo change move the boundaries", () => {
    const blocks = [QUIET, FULL, FULL, QUIET];
    const w = wave(blocks);
    // First beat at 4 s: the first block boundary is 4 + 16 = 20 s.
    const shifted = detectPhrases(w, { ...GRID, firstBeat: 4 }, 64);
    assert.equal(shifted[0]!.toSec, 20);
    // Half tempo: an 8-bar block lasts 32 s, so a 64 s track has only two blocks; the first one
    // (half quiet, half full) is no longer an intro.
    const fast = detectPhrases(wave([QUIET, FULL, FULL, FULL]), GRID, 64);
    assert.deepEqual(
        fast.map((x) => [x.kind, x.fromSec, x.toSec]),
        [
            ["intro", 0, 16],
            ["main", 16, 64],
        ],
    );
    const slow = detectPhrases(wave([QUIET, FULL, FULL, FULL]), { ...GRID, bpm: 60 }, 64);
    assert.deepEqual(
        slow.map((x) => [x.fromSec, x.toSec]),
        [
            [0, 32],
            [32, 64],
        ],
    );
    assert.notEqual(slow[0]!.kind, "intro");
});

test("no grid, no wave, silence or a track shorter than two blocks gives no phrases", () => {
    const w = wave([FULL, FULL, FULL]);
    assert.deepEqual(detectPhrases(null, GRID, 48), []);
    assert.deepEqual(detectPhrases(w, null, 48), []);
    assert.deepEqual(detectPhrases(w, { ...GRID, bpm: 0 }, 48), []);
    assert.deepEqual(detectPhrases(w, GRID, 0), []);
    // 12 s at 120 BPM is less than one 8-bar block.
    assert.deepEqual(detectPhrases(w, GRID, 12), []);
    assert.deepEqual(detectPhrases(wave([[0, 0, 0], [0, 0, 0], [0, 0, 0]]), GRID, 48), []);
});
