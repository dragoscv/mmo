// Run: node --test apps/mixai/src/shell/status-math.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    LOAD_CELLS,
    VU_CELLS,
    bufferFrames,
    clockText,
    loadCells,
    loadLevel,
    loadPct,
    modeOf,
    msToNextMinute,
    overrunText,
    recTime,
    shortDevice,
    steadyPct,
    vuCells,
    vuCellsDb,
} from "./status-math.ts";

const lin = (db: number) => 10 ** (db / 20);

test("the meter is silent at and under the floor and full at 0 dBFS", () => {
    assert.equal(vuCells(0), 0);
    assert.equal(vuCells(-1), 0);
    assert.equal(vuCells(Number.NaN), 0);
    assert.equal(vuCells(lin(-48)), 0);
    assert.equal(vuCells(lin(-60)), 0);
    assert.equal(vuCells(1), VU_CELLS);
    assert.equal(vuCells(4), VU_CELLS, "levels over full scale clamp");
});

test("one cell is 3 dB and the top cell means above -3 dBFS", () => {
    assert.equal(vuCells(lin(-47.9)), 1);
    assert.equal(vuCells(lin(-12.1)), 12);
    assert.equal(vuCells(lin(-11.9)), 13);
    assert.equal(vuCells(lin(-3.1)), 15);
    assert.equal(vuCells(lin(-2.9)), 16);
    assert.equal(vuCellsDb(0), null);
    assert.equal(vuCellsDb(12), -12);
    assert.equal(vuCellsDb(VU_CELLS), 0);
});

test("a level that wobbles inside one cell gives the same cell count (idle renders nothing)", () => {
    const seen = new Set<number>();
    for (let db = -20.9; db < -18.05; db += 0.1) seen.add(vuCells(lin(db)));
    assert.deepEqual([...seen], [10]);
});

test("audio load: whole percent, levels at 70 and 100, five cells", () => {
    assert.equal(loadPct(undefined), 0);
    assert.equal(loadPct(0), 0);
    assert.equal(loadPct(0.234), 23);
    assert.equal(loadPct(3.45), 345);
    assert.equal(loadPct(40), 999);
    assert.equal(loadLevel(69), "ok");
    assert.equal(loadLevel(70), "warn");
    assert.equal(loadLevel(99), "warn");
    assert.equal(loadLevel(100), "alert");
    assert.equal(loadCells(0), 0);
    assert.equal(loadCells(1), 1);
    assert.equal(loadCells(20), 1);
    assert.equal(loadCells(21), 2);
    assert.equal(loadCells(70), 4);
    assert.equal(loadCells(100), LOAD_CELLS);
    assert.equal(loadCells(345), LOAD_CELLS);
});

test("the shown load ignores one point of jitter but never hides a level change or zero", () => {
    assert.equal(steadyPct(4, 5), 4);
    assert.equal(steadyPct(4, 3), 4);
    assert.equal(steadyPct(4, 6), 6);
    assert.equal(steadyPct(4, 2), 2);
    assert.equal(steadyPct(69, 70), 70, "ok -> warn shows at once");
    assert.equal(steadyPct(100, 99), 99, "alert -> warn shows at once");
    assert.equal(steadyPct(1, 0), 0);
    assert.equal(steadyPct(0, 1), 0);
});

test("the settled latency is the value seen most often; ties and empty windows keep the shown one", () => {
    assert.equal(modeOf(new Map([[10, 99], [2, 2], [20, 4], [22, 2], [12, 1]]), 0), 10);
    assert.equal(modeOf(new Map(), 10), 10);
    assert.equal(modeOf(new Map([[20, 3], [10, 3]]), 10), 10);
    assert.equal(modeOf(new Map([[10, 3], [20, 3]]), 10), 10);
    assert.equal(modeOf(new Map([[20, 4], [10, 3]]), 10), 20);
    assert.equal(bufferFrames(10, 48_000), 480);
    assert.equal(bufferFrames(5.33, 48_000), 256);
});

test("clock, recording time and overrun text", () => {
    assert.equal(clockText(new Date(2026, 10, 10, 9, 5, 0)), "09:05");
    assert.equal(clockText(new Date(2026, 10, 10, 23, 41, 59)), "23:41");
    assert.equal(msToNextMinute(new Date(2026, 10, 10, 9, 5, 30, 0)), 30_000);
    assert.equal(msToNextMinute(new Date(2026, 10, 10, 9, 5, 59, 990)), 50);
    assert.equal(recTime(0), "00:00");
    assert.equal(recTime(83.9), "01:23");
    assert.equal(recTime(3723), "62:03");
    assert.equal(overrunText(12), "12");
    assert.equal(overrunText(9999), "9999");
    assert.equal(overrunText(10_000), "9999+");
});

test("the short device name keeps what identifies the device", () => {
    assert.equal(shortDevice("Voicemeeter Input (VB-Audio Voicemeeter VAIO)"), "Voicemeeter Input");
    assert.equal(shortDevice("Speakers (DDJ-FLX4)"), "DDJ-FLX4");
    assert.equal(shortDevice("Difuzoare (Realtek(R) Audio)"), "Realtek(R) Audio");
    assert.equal(shortDevice("Headphones (2- High Definition Audio Device)"), "2- High Definition Audio Device");
    assert.equal(shortDevice("  Scarlett 2i2 USB  "), "Scarlett 2i2 USB");
    assert.equal(shortDevice("(Unnamed)"), "Unnamed");
    assert.equal(shortDevice("MASTER 1/2 (Xone:96)"), "MASTER 1/2");
});
