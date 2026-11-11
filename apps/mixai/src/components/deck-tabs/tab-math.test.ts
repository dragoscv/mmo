// Run: cd apps/mixai; node --test "src/components/deck-tabs/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridFromDeck } from "../../grid/markers.ts";
import {
    DEV_TRACK_ID_BASE,
    LOOP_SIZES,
    beatsLabel,
    deckPropsEqual,
    fmtCueTime,
    fmtLoopTime,
    isLibraryTrackId,
    loopBeats,
    loopLabel,
    matchLoopSize,
    sameFields,
    soloIndex,
    stemGains,
    stemMuted,
} from "./tab-math.ts";

test("fmtCueTime: whole seconds, floored; junk is 0:00", () => {
    assert.equal(fmtCueTime(0), "0:00");
    assert.equal(fmtCueTime(65.9), "1:05");
    assert.equal(fmtCueTime(600), "10:00");
    assert.equal(fmtCueTime(-3), "0:00");
    assert.equal(fmtCueTime(Number.NaN), "0:00");
});

test("fmtLoopTime: tenths, floored", () => {
    assert.equal(fmtLoopTime(0), "0:00.0");
    assert.equal(fmtLoopTime(65.47), "1:05.4");
    assert.equal(fmtLoopTime(Number.POSITIVE_INFINITY), "0:00.0");
});

test("beatsLabel: fractions as 1/n, whole beats as numbers", () => {
    assert.equal(beatsLabel(0.125), "1/8");
    assert.equal(beatsLabel(0.5), "1/2");
    assert.equal(beatsLabel(4), "4");
    assert.equal(beatsLabel(3.5), "3.5");
    assert.equal(beatsLabel(0.3), "0.3");
    assert.equal(beatsLabel(0), "0");
    assert.equal(beatsLabel(Number.NaN), "0");
    assert.deepEqual(
        LOOP_SIZES.map((b) => beatsLabel(b)),
        ["1/8", "1/4", "1/2", "1", "2", "4", "8", "16", "32"],
    );
});

test("loopBeats: length of a loop on the grid; null without a loop or a grid", () => {
    const g = gridFromDeck(120, 0);
    assert.ok(Math.abs((loopBeats(g, 0, 2) ?? 0) - 4) < 1e-9);
    assert.ok(Math.abs((loopBeats(g, 10, 10.25) ?? 0) - 0.5) < 1e-9);
    assert.equal(loopBeats(g, 2, 2), null);
    assert.equal(loopBeats(g, 3, 2), null);
    assert.equal(loopBeats(null, 0, 2), null);
});

test("matchLoopSize: the tab's size within 2 %", () => {
    assert.equal(matchLoopSize(4), 4);
    assert.equal(matchLoopSize(4.05), 4);
    assert.equal(matchLoopSize(4.2), null);
    assert.equal(matchLoopSize(0.126), 0.125);
    assert.equal(matchLoopSize(3), null);
    assert.equal(matchLoopSize(null), null);
    assert.equal(matchLoopSize(Number.NaN), null);
});

test("loopLabel: musical size when near one, else the measured beats", () => {
    assert.equal(loopLabel(4.01), "4");
    assert.equal(loopLabel(0.126), "1/8");
    assert.equal(loopLabel(3), "3");
    assert.equal(loopLabel(1 / 3), "1/3");
    assert.equal(loopLabel(5.5), "5.5");
});

test("isLibraryTrackId: positive whole ids; the dev range is excluded in a development build only", () => {
    assert.equal(isLibraryTrackId("12"), true);
    assert.equal(isLibraryTrackId(String(DEV_TRACK_ID_BASE - 1)), true);
    // Production (and `node --test`): a library with 900 000+ tracks keeps every id.
    assert.equal(isLibraryTrackId(String(DEV_TRACK_ID_BASE)), true);
    assert.equal(isLibraryTrackId("900001"), true);
    assert.equal(isLibraryTrackId("900001", false), true);
    assert.equal(isLibraryTrackId("12345678", false), true);
    // Development build: demo tracks loaded by window.__decks.load are not in the companion library.
    assert.equal(isLibraryTrackId(String(DEV_TRACK_ID_BASE), true), false);
    assert.equal(isLibraryTrackId("900001", true), false);
    assert.equal(isLibraryTrackId(String(DEV_TRACK_ID_BASE - 1), true), true);
    assert.equal(isLibraryTrackId("12", true), true);
    assert.equal(isLibraryTrackId("0"), false);
    assert.equal(isLibraryTrackId("-3"), false);
    assert.equal(isLibraryTrackId("1.5"), false);
    assert.equal(isLibraryTrackId(" 12"), false);
    assert.equal(isLibraryTrackId("C:\\music\\a.mp3"), false);
    assert.equal(isLibraryTrackId("C:\\music\\a.mp3", true), false);
    assert.equal(isLibraryTrackId(""), false);
    assert.equal(isLibraryTrackId(null), false);
    assert.equal(isLibraryTrackId(undefined), false);
});

test("stem gains: defaults, mute threshold, solo derived from the gains", () => {
    assert.deepEqual(stemGains(undefined), [1, 1, 1, 1]);
    assert.deepEqual(stemGains([0, 0.5]), [0, 0.5, 1, 1]);
    assert.equal(stemMuted(0), true);
    assert.equal(stemMuted(0.001), true);
    assert.equal(stemMuted(0.002), false);
    assert.equal(soloIndex([0, 1, 0, 0]), 1);
    assert.equal(soloIndex([0, 0, 0, 0.4]), 3);
    assert.equal(soloIndex([1, 1, 0, 0]), null);
    assert.equal(soloIndex([1, 1, 1, 1]), null);
    assert.equal(soloIndex([0, 0, 0, 0]), null);
});

test("sameFields: only the named fields count; arrays element by element", () => {
    const a = { x: 1, cues: [1, null, 3], pos: 10 };
    assert.equal(sameFields(a, a, ["x"]), true);
    assert.equal(sameFields(a, { ...a, pos: 11 }, ["x", "cues"]), true);
    assert.equal(sameFields(a, { ...a, cues: [1, null, 3] }, ["cues"]), true);
    assert.equal(sameFields(a, { ...a, cues: [1, 2, 3] }, ["cues"]), false);
    assert.equal(sameFields(a, { ...a, cues: [1, null] }, ["cues"]), false);
    assert.equal(sameFields(a, { ...a, x: 2 }, ["x"]), false);
});

test("deckPropsEqual: the deck by its fields, every other prop by identity", () => {
    type Deck = { loaded: boolean; position: number };
    type Props = { deck: Deck; deckId: string; className?: string };
    const eq = deckPropsEqual<Deck, Props>(["loaded"]);
    const deck = { loaded: true, position: 1 };
    assert.equal(eq({ deck, deckId: "a" }, { deck: { loaded: true, position: 2 }, deckId: "a" }), true);
    assert.equal(eq({ deck, deckId: "a" }, { deck: { loaded: false, position: 1 }, deckId: "a" }), false);
    assert.equal(eq({ deck, deckId: "a" }, { deck, deckId: "b" }), false);
    assert.equal(eq({ deck, deckId: "a" }, { deck, deckId: "a", className: "x" }), false);
});
