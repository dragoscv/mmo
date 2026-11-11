import test from "node:test";
import assert from "node:assert/strict";
import { gridFromDeck } from "../../grid/markers.ts";
import {
    DEFAULT_WINDOW_INDEX,
    WINDOWS,
    barsReadout,
    beatsPerBar,
    cellIndex,
    clampSeek,
    columnPeak,
    dragTarget,
    effectiveTier,
    isVertical,
    layerSpan,
    marksChanged,
    parseBars,
    phaseScale,
    playheadAnchor,
    scrollColumn,
    seekByBeats,
    stepWindow,
    trackGain,
    visualChanged,
    wrapLoop,
    type Span,
} from "./wave-math.ts";
import type { DeckState } from "../../bridge/types.ts";

function deck(patch: Partial<DeckState> = {}): DeckState {
    return {
        id: "a",
        trackId: "t1",
        title: null,
        artist: null,
        loaded: true,
        playing: false,
        position: 10,
        duration: 120,
        bpm: 120,
        tempo: 1,
        keyLock: false,
        volume: 1,
        eqLow: 0,
        eqMid: 0,
        eqHigh: 0,
        filter: 0,
        crossfaderAssign: "thru",
        cue: false,
        vu: 0,
        hotCues: [null, null, null, null, null, null, null, null],
        loopActive: false,
        loopStart: 0,
        loopEnd: 0,
        firstBeat: 0,
        hasStems: false,
        stemsActive: false,
        stemGains: [1, 1, 1, 1],
        fxKind: 0,
        fxWet: 0,
        fxBeats: 1,
        ...patch,
    };
}

test("zoom steps: 4/8/16/32 s, 8 s by default, clamped at both ends", () => {
    assert.deepEqual([...WINDOWS], [4, 8, 16, 32]);
    assert.equal(WINDOWS[DEFAULT_WINDOW_INDEX], 8);
    assert.equal(stepWindow(1, -1), 0);
    assert.equal(stepWindow(0, -1), 0);
    assert.equal(stepWindow(2, 1), 3);
    assert.equal(stepWindow(3, 1), 3);
});

test("orientation: columns only when the box is clearly taller than wide", () => {
    assert.equal(isVertical(1492, 158), false);
    assert.equal(isVertical(300, 300), false);
    assert.equal(isVertical(264, 500), true);
    assert.equal(isVertical(0, 500), false);
    assert.equal(playheadAnchor(false), 0.5);
    assert.equal(playheadAnchor(true), 1 / 3);
});

test("tier: the solver's tier when horizontal, the column size when vertical", () => {
    assert.equal(effectiveTier("compact", 960, 78, 2), "compact");
    // The solver gives "icon" to a 264 px wide box; as two columns it has room for everything.
    assert.equal(effectiveTier("icon", 264, 500, 2), "full");
    assert.equal(effectiveTier("full", 150, 200, 2), "compact");
    assert.equal(effectiveTier("full", 100, 140, 2), "icon");
    // Four columns of 66 px are too narrow for the full chip.
    assert.equal(effectiveTier("full", 264, 500, 4), "compact");
});

test("one column per device pixel: the peak of the points it covers, a line between points when zoomed in", () => {
    const lane = Uint8Array.from([10, 200, 30, 40, 250, 60, 70, 80]);
    // Zoomed out, 2 points per column: every point lands in exactly one column, none is lost.
    assert.deepEqual([0, 1, 2, 3].map((c) => columnPeak(lane, c, 2)), [200, 40, 250, 80]);
    // 3 points per column: the last column holds what is left.
    assert.deepEqual([0, 1, 2, 3].map((c) => columnPeak(lane, c, 3)), [200, 250, 80, 0]);
    // One point per column = the points themselves.
    assert.deepEqual([0, 1, 7, 8].map((c) => columnPeak(lane, c, 1)), [10, 200, 80, 0]);
    // Zoomed in, 4 columns per point: point 1 (200) has its centre at column 5.5.
    assert.equal(columnPeak(lane, 0, 0.25), 10);
    assert.equal(columnPeak(lane, 5, 0.25), 10 + (200 - 10) * 0.875);
    assert.equal(columnPeak(lane, 6, 0.25), 200 + (30 - 200) * 0.125);
    assert.equal(columnPeak(lane, 31, 0.25), 80);
    assert.equal(columnPeak(lane, 32, 0.25), 0);
    // Never a value from outside the source, never NaN.
    assert.equal(columnPeak(lane, -1, 2), 0);
    assert.equal(columnPeak(lane, 3, 0), 0);
    assert.equal(columnPeak(lane, 3, Number.NaN), 0);
    assert.equal(columnPeak(new Uint8Array(0), 0, 1), 0);
});

test("the wave scrolls by whole columns: a move inside a column draws nothing new", () => {
    // 186.5 device px per second (1492 px showing 8 s).
    assert.equal(scrollColumn(10, 186.5), 1865);
    assert.equal(scrollColumn(10.002, 186.5), 1865);
    assert.equal(scrollColumn(10.004, 186.5), 1866);
    assert.equal(scrollColumn(0, 186.5), 0);
    assert.equal(scrollColumn(Number.NaN, 186.5), 0);
});

test("a quiet track is scaled up, at most four times", () => {
    assert.equal(trackGain(255), 1);
    assert.equal(trackGain(127.5), 2);
    assert.equal(trackGain(10), 4);
    assert.equal(trackGain(0), 1);
});

test("seeks stay inside the track and never land on its very end", () => {
    assert.equal(clampSeek(-3, 100), 0);
    assert.equal(clampSeek(500, 100), 99.95);
    assert.equal(clampSeek(Number.NaN, 100), 0);
    // Dragging the wave 100 px to the left at 50 px/s moves the playhead 2 s forward.
    assert.equal(dragTarget(40, -100, 50, 100), 42);
    assert.equal(dragTarget(1, 100, 50, 100), 0);
    assert.equal(dragTarget(40, 10, 0, 100), 40);
});

test("arrow keys move by whole beats on the deck's grid and keep the offset in the beat", () => {
    const grid = gridFromDeck(120, 0.1);
    assert.ok(Math.abs(seekByBeats(grid, 10.3, 1, 100) - 10.8) < 1e-9);
    assert.ok(Math.abs(seekByBeats(grid, 10.3, -4, 100) - 8.3) < 1e-9);
    assert.equal(seekByBeats(grid, 0.2, -1, 100), 0);
    // No grid: half a second per "beat".
    assert.equal(seekByBeats(null, 10, 1, 100), 10.5);
});

test("beat cells: the bar position of the deck, -1 when it has no beat", () => {
    const d = (beat: number, barPhase: number | null, bpm = 120) => ({ id: "a" as const, bpm, beat, barPhase, keyShift: 0, slip: false, quantize: false, syncLock: false });
    assert.equal(beatsPerBar(null), 4);
    assert.equal(beatsPerBar({ beatsPerBar: 3 }), 3);
    assert.equal(beatsPerBar({ beatsPerBar: 0 }), 4);
    assert.equal(cellIndex(null, "a"), -1);
    assert.equal(cellIndex({ beatsPerBar: 4, decks: [d(6.4, null)] }, "a"), 2);
    assert.equal(cellIndex({ beatsPerBar: 4, decks: [d(6.4, 0.2)] }, "a"), 0);
    assert.equal(cellIndex({ beatsPerBar: 4, decks: [d(-0.5, null)] }, "a"), 3);
    assert.equal(cellIndex({ beatsPerBar: 4, decks: [d(6.4, null, 0)] }, "a"), -1);
    assert.equal(cellIndex({ beatsPerBar: 4, decks: [d(6.4, null)] }, "b"), -1);
});

test("phase bar: half a beat fills the half-track; coarse steps under reduced motion", () => {
    assert.equal(phaseScale(0, false), 0);
    assert.equal(phaseScale(0.25, false), 0.5);
    assert.equal(phaseScale(-0.5, false), -1);
    assert.equal(phaseScale(3, false), 1);
    assert.equal(phaseScale(Number.NaN, false), 0);
    assert.equal(phaseScale(0.26, true), 0.5);
    assert.ok(Object.is(phaseScale(-0.0001, false), 0), "never -0 (it would be written to the DOM as a change)");
});

test("layers: one mirrored lane each when stacked, halves growing from the centre in overlay", () => {
    const s: Span = { a0: 0, a1: 0, dir: 0 };
    assert.deepEqual({ ...layerSpan(s, 0, 1, 100, false) }, { a0: 0, a1: 100, dir: 0 });
    assert.deepEqual({ ...layerSpan(s, 0, 2, 100, true) }, { a0: 0, a1: 50, dir: -1 });
    assert.deepEqual({ ...layerSpan(s, 1, 2, 100, true) }, { a0: 50, a1: 100, dir: 1 });
    assert.deepEqual({ ...layerSpan(s, 2, 4, 100, true) }, { a0: 50, a1: 75, dir: 1 });
    assert.deepEqual({ ...layerSpan(s, 0, 1, 100, true) }, { a0: 0, a1: 100, dir: 0 });
});

test("a prediction that runs past the end of an active loop continues from its start", () => {
    assert.equal(wrapLoop(10.5, 9.8, true, 8, 10), 8.5);
    assert.equal(wrapLoop(9.5, 9, true, 8, 10), 9.5);
    assert.equal(wrapLoop(10.5, 9.8, false, 8, 10), 10.5);
    // The playhead was already past the loop (the loop was set behind it): no wrap.
    assert.equal(wrapLoop(12.5, 12, true, 8, 10), 12.5);
    assert.equal(wrapLoop(10.5, 9.8, true, 10, 10), 10.5);
});

test("bars readout: to the next hot cue, else to the end; a string key that changes once per beat", () => {
    const grid = gridFromDeck(120, 0);
    const cues = [null, null, 20, null, null, null, null, null];
    // 10 s → 20 s at 120 BPM = 20 beats = 5 bars.
    assert.equal(barsReadout(deck({ hotCues: cues }), grid, 4), "3|5|1");
    assert.deepEqual(parseBars("3|5|1"), { cue: 3, bars: 5, beat: 1 });
    // No cue ahead: to the end of the track (110 s = 220 beats = 55 bars), cue 0.
    assert.equal(barsReadout(deck(), grid, 4), "0|55|1");
    assert.equal(barsReadout(deck({ hotCues: cues, position: 10.2 }), grid, 4), barsReadout(deck({ hotCues: cues, position: 10.3 }), grid, 4));
    assert.equal(barsReadout(deck({ loaded: false }), grid, 4), "");
    assert.equal(barsReadout(deck(), null, 4), "");
    assert.equal(parseBars(""), null);
    assert.equal(parseBars("a|b|c"), null);
});

test("only what a lane draws counts as a visual change (not the VU, a fader or an EQ)", () => {
    const a = deck();
    assert.equal(visualChanged(a, deck({ vu: 0.8, volume: 0.3, eqLow: -6, filter: 0.4, cue: true })), false);
    assert.equal(visualChanged(a, deck({ position: 10.01 })), true);
    // The position alone is not a change of the marks (the frame loop compares pixel columns).
    assert.equal(marksChanged(a, deck({ position: 10.01, vu: 0.5 })), false);
    assert.equal(marksChanged(a, deck({ position: 10.01, loopActive: true })), true);
    assert.equal(marksChanged(a, deck({ hotCues: [1, null, null, null, null, null, null, null] })), true);
    assert.equal(visualChanged(a, deck({ loopActive: true })), true);
    assert.equal(visualChanged(a, deck({ hotCues: [1, null, null, null, null, null, null, null] })), true);
    assert.equal(visualChanged(a, deck({ stemsActive: true })), true);
    assert.equal(visualChanged(a, deck({ stemGains: [1, 0, 1, 1] })), true);
    assert.equal(visualChanged(a, deck({ trackId: "t2" })), true);
});
