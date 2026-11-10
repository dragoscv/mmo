// Run: cd apps/mixai; node --test "src/**/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    addMarker,
    beatAt,
    beatLines,
    bpmAt,
    fromBeatGrid,
    gridFromDeck,
    markerIndexNear,
    mergeMarkers,
    moveMarker,
    newMarkerBpm,
    normaliseGrid,
    nudgeMarker,
    removeMarker,
    retuneMarker,
    setFixed,
    snapToBeat,
    timeAt,
    toBeatGrid,
    type GridModel,
} from "./markers.ts";

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const variable = (): GridModel =>
    normaliseGrid({
        bpm: 120,
        firstBeat: 0.5,
        markers: [
            { sec: 16.5, bpm: 128 },
            { sec: 31.5, bpm: 124 },
        ],
        fixed: false,
    });

test("a constant grid is beats from the first beat", () => {
    const g = gridFromDeck(120, 0.5);
    near(bpmAt(g, 100), 120);
    near(beatAt(g, 1.0), 1);
    near(timeAt(g, 4), 2.5);
    near(snapToBeat(g, 2.4), 2.5);
});

test("markers bend the grid at the marker and keep the last tempo after it", () => {
    const g = variable();
    near(beatAt(g, 16.5), 32);
    near(bpmAt(g, 10), 120);
    near(bpmAt(g, 20), 128);
    near(bpmAt(g, 40), 124);
    near(beatAt(g, 31.5), 64);
    near(timeAt(g, 64), 31.5);
    near(timeAt(g, 64 + 124), 31.5 + 60, 1e-7);
});

test("equal tempos, duplicates and junk are merged away", () => {
    assert.deepEqual(
        mergeMarkers(120, [
            { sec: 30, bpm: 128.02 }, // same tempo as the previous marker (within tolerance)
            { sec: 10, bpm: 126 }, // replaced by the one 0.4 ms later
            { sec: 10.0004, bpm: 128 },
            { sec: 20, bpm: 128 }, // no change
            { sec: 40, bpm: Number.NaN },
            { sec: 50, bpm: 0 },
        ]),
        [{ sec: 10.0004, bpm: 128 }],
    );
    // A marker at (or before) the first beat becomes the starting tempo.
    const g = normaliseGrid({ bpm: 120, firstBeat: 0.5, markers: [{ sec: 0.2, bpm: 126 }], fixed: false });
    near(g.bpm, 126);
    assert.equal(g.markers.length, 0);
    // A negative first beat is clamped.
    near(normaliseGrid({ bpm: 120, firstBeat: -3, markers: [], fixed: false }).firstBeat, 0);
});

test("fixed ignores the markers but keeps them", () => {
    const g = setFixed(variable(), true);
    assert.equal(g.markers.length, 2, "markers are kept");
    near(bpmAt(g, 40), 120);
    near(beatAt(g, 30.5), 60);
    near(timeAt(g, 60), 30.5);
    // And switching it off brings them back.
    const off = setFixed(g, false);
    near(bpmAt(off, 40), 124);
});

test("beat lines cover the window, mark downbeats and are bounded", () => {
    const g = variable();
    const lines = beatLines(g, 0, 4);
    // Beat −1 lands exactly on 0.0 s (first beat 0.5 s at 120 BPM), so it is in the window.
    assert.deepEqual(
        lines.map((l) => l.beat),
        [-1, 0, 1, 2, 3, 4, 5, 6, 7],
    );
    near(lines[0]!.sec, 0);
    near(lines[1]!.sec, 0.5);
    assert.deepEqual(
        lines.filter((l) => l.downbeat).map((l) => l.beat),
        [0, 4],
    );
    // Lines follow the tempo change.
    const after = beatLines(g, 16.5, 17.5);
    near(after[1]!.sec - after[0]!.sec, 60 / 128, 1e-9);
    assert.ok(beatLines(g, 0, 1e6, 4, 500).length <= 500, "bounded");
    assert.equal(beatLines(g, 5, 5).length, 0);
});

test("adding, moving, nudging, retuning and removing markers", () => {
    let g = gridFromDeck(120, 0.5);
    g = addMarker(g, 16.5, 128);
    assert.equal(g.markers.length, 1);
    // Same tempo again changes nothing.
    g = addMarker(g, 24, 128);
    assert.equal(g.markers.length, 1);
    // Same position replaces.
    g = addMarker(g, 16.5004, 126);
    assert.equal(g.markers.length, 1);
    near(g.markers[0]!.bpm, 126);

    const i = markerIndexNear(g, 16.6, 0.2);
    assert.equal(i, 0);
    assert.equal(markerIndexNear(g, 40, 0.2), -1);

    g = moveMarker(g, i, 17);
    near(g.markers[0]!.sec, 17);
    g = nudgeMarker(g, 0, -0.01);
    near(g.markers[0]!.sec, 16.99);
    g = retuneMarker(g, 0, 130);
    near(g.markers[0]!.bpm, 130);
    // Invalid input is ignored, not applied.
    assert.deepEqual(retuneMarker(g, 0, 0), g);
    assert.deepEqual(addMarker(g, 20, Number.NaN), g);
    assert.deepEqual(removeMarker(g, 7), g);

    g = removeMarker(g, 0);
    assert.equal(g.markers.length, 0);

    // A new marker at the playhead starts one step above the running tempo, so it survives.
    const base = gridFromDeck(120, 0.5);
    near(newMarkerBpm(base, 10), 120.1);
    assert.equal(addMarker(base, 10.5, newMarkerBpm(base, 10.5)).markers.length, 1);
    assert.equal(addMarker(base, 10.5, 120).markers.length, 0, "same tempo merges away");
});

test("round trip through the engine BeatGrid", () => {
    const g = variable();
    const bg = toBeatGrid(g);
    assert.equal(bg.anchors?.length, 4, "two markers + start + trailing");
    near(bg.anchors![1]!.beat, 32);
    const back = fromBeatGrid(bg);
    near(back.bpm, g.bpm);
    near(back.firstBeat, g.firstBeat);
    assert.equal(back.markers.length, 2);
    near(back.markers[0]!.sec, 16.5, 1e-7);
    near(back.markers[0]!.bpm, 128, 1e-7);

    // A fixed grid crosses as a constant one; the markers stay in the model.
    const fixedBg = toBeatGrid(setFixed(g, true));
    assert.equal(fixedBg.anchors?.length, 0);
    near(fixedBg.bpm, 120);
    assert.equal(fromBeatGrid(fixedBg).markers.length, 0);
    // Constant grids survive too.
    const c = fromBeatGrid(toBeatGrid(gridFromDeck(128, 0.25)));
    near(c.bpm, 128);
    near(c.firstBeat, 0.25);
});
