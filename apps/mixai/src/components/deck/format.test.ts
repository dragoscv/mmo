// Run: cd apps/mixai; node --test "src/**/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    clampSeek,
    clampTempo,
    deckArrangement,
    formatClock,
    formatTempo,
    keySeekTarget,
    oppositeDeck,
    platterAngle,
    playingBpm,
    progressOf,
    rulerBeats,
    sameDeckExcept,
    seekFraction,
    splitBpm,
    stripChanged,
    tempoPosition,
    tempoShifted,
} from "./format.ts";
import { deckMessages } from "../../i18n/messages-deck.ts";

test("tempo is clamped to the fader range and formatted signed with one decimal", () => {
    assert.equal(clampTempo(2), 1.5);
    assert.equal(clampTempo(0.1), 0.5);
    assert.equal(clampTempo(Number.NaN), 1);
    assert.equal(formatTempo(1), "+0.0%");
    assert.equal(formatTempo(1.012), "+1.2%");
    assert.equal(formatTempo(0.996), "\u22120.4%");
    // Rounds to zero: never a signed zero.
    assert.equal(formatTempo(0.99996), "+0.0%");
    assert.equal(formatTempo(1.5), "+50.0%");
    assert.equal(tempoShifted(1.0004), false);
    assert.equal(tempoShifted(1.001), true);
    assert.equal(tempoPosition(1), 0.5);
    assert.equal(tempoPosition(0.5), 0);
    assert.equal(tempoPosition(9), 1);
});

test("BPM splits into a whole part and two decimals", () => {
    assert.deepEqual(splitBpm(129.2), { main: "129", frac: "20" });
    assert.deepEqual(splitBpm(126), { main: "126", frac: "00" });
    // Carries into the whole part instead of printing ".100".
    assert.deepEqual(splitBpm(127.999), { main: "128", frac: "00" });
    assert.deepEqual(splitBpm(120.186), { main: "120", frac: "19" });
    assert.equal(splitBpm(0), null);
    assert.equal(splitBpm(Number.NaN), null);
});

test("the playing tempo prefers the engine clock and falls back to grid x fader", () => {
    const deck = { loaded: true, bpm: 120, tempo: 1.05 };
    assert.equal(playingBpm(deck, 127.5), 127.5);
    assert.equal(playingBpm(deck, 0), 126);
    assert.equal(playingBpm(deck, null), 126);
    assert.equal(playingBpm({ ...deck, loaded: false }, 127.5), 0);
    assert.equal(playingBpm({ ...deck, bpm: 0 }, 127.5), 0);
});

test("spoken clock and the opposite deck", () => {
    assert.equal(formatClock(83.9), "1:23");
    assert.equal(formatClock(-4), "0:00");
    assert.equal(formatClock(600), "10:00");
    assert.deepEqual(["a", "b", "c", "d"].map((d) => oppositeDeck(d as "a")), ["b", "a", "d", "c"]);
});

test("seeking: pointer fraction, end guard and slider keys", () => {
    assert.equal(seekFraction(150, 100, 200), 0.25);
    assert.equal(seekFraction(50, 100, 200), 0);
    assert.equal(seekFraction(900, 100, 200), 1);
    assert.equal(seekFraction(10, 0, 0), 0);
    assert.equal(clampSeek(500, 200), 199.95);
    assert.equal(clampSeek(-3, 200), 0);
    assert.equal(clampSeek(10, 0), 0);
    assert.equal(keySeekTarget("ArrowRight", 100, 200), 102);
    assert.equal(keySeekTarget("ArrowLeft", 100, 200), 98);
    assert.equal(keySeekTarget("ArrowLeft", 1, 200), 0);
    assert.equal(keySeekTarget("PageUp", 100, 200), 120);
    assert.equal(keySeekTarget("PageDown", 100, 200), 80);
    assert.equal(keySeekTarget("ArrowRight", 199.9, 200), 199.95);
    assert.equal(keySeekTarget("Home", 100, 200), 0);
    assert.equal(keySeekTarget("End", 100, 200), null);
    assert.equal(keySeekTarget("a", 100, 200), null);
    assert.equal(keySeekTarget("ArrowRight", 0, 0), null);
});

test("the ruler picks the finest unit that stays readable", () => {
    assert.equal(rulerBeats(20), 1);
    assert.equal(rulerBeats(4), 4); // 16 px per bar
    assert.equal(rulerBeats(1.6), 16); // 4 bars = 25.6 px (one bar would be 6.4 px)
    assert.equal(rulerBeats(1.6, 3), 12);
    assert.equal(rulerBeats(0.01), 0);
    assert.equal(rulerBeats(0), 0);
});

test("the platter turns at 33 1/3 rpm and progress is clamped", () => {
    assert.ok(Math.abs(platterAngle(1.8) - 0) < 1e-6 || Math.abs(platterAngle(1.8) - 360) < 1e-6);
    assert.ok(Math.abs(platterAngle(0.9) - 180) < 1e-6);
    assert.equal(platterAngle(Number.NaN), 0);
    assert.equal(progressOf({ position: 50, duration: 200 }), 0.25);
    assert.equal(progressOf({ position: 500, duration: 200 }), 1);
    assert.equal(progressOf({ position: 5, duration: 0 }), 0);
});

test("a deck object is steady while only ignored fields change", () => {
    const a = { position: 1, vu: 0.2, tempo: 1, hotCues: [null, 4] as (number | null)[] };
    // A new snapshot always brings fresh arrays: equal content is not a change.
    assert.equal(sameDeckExcept(a, { ...a, position: 2, vu: 0.9, hotCues: [null, 4] }, ["position", "vu"]), true);
    assert.equal(sameDeckExcept(a, { ...a, position: 2 }, ["vu"]), false);
    assert.equal(sameDeckExcept(a, { ...a, tempo: 1.01 }, ["position", "vu"]), false);
    assert.equal(sameDeckExcept(a, { ...a, hotCues: [null, 5] }, ["position", "vu"]), false);
    assert.equal(sameDeckExcept(a, { ...a, hotCues: [null] }, ["position", "vu"]), false);
    assert.equal(sameDeckExcept(a, a, []), true);
});

test("the overview strip redraws only for the fields it draws", () => {
    const s = { position: 10, duration: 200, loaded: true, loopActive: false, loopStart: 0, loopEnd: 0, hotCues: [null, 12] as (number | null)[] };
    assert.equal(stripChanged(s, { ...s, hotCues: [null, 12] }), false);
    assert.equal(stripChanged(s, { ...s, position: 10.03 }), true);
    assert.equal(stripChanged(s, { ...s, loopActive: true }), true);
    assert.equal(stripChanged(s, { ...s, hotCues: [3, 12] }), true);
    // Fields the strip does not draw (vu, tempo, ...) are not part of the comparison at all.
    assert.equal(stripChanged(s, { ...s, vu: 0.7, tempo: 1.2 } as typeof s), false);
});

test("touch mode steps down to an arrangement whose 44 px rows fit the box", () => {
    // Without touch mode (or before the first measurement) the tier decides.
    assert.equal(deckArrangement("full", false, 250), "full");
    assert.equal(deckArrangement("compact", false, 190), "compact");
    assert.equal(deckArrangement("full", true, 0), "full");
    // Touch: the full arrangement needs the 319 px layout box.
    assert.equal(deckArrangement("full", true, 319), "full");
    assert.equal(deckArrangement("full", true, 318), "compact");
    assert.equal(deckArrangement("full", true, 250), "compact");
    assert.equal(deckArrangement("compact", true, 319), "compact");
    assert.equal(deckArrangement("compact", true, 249), "bare");
    assert.equal(deckArrangement("compact", true, 190), "bare");
    assert.equal(deckArrangement("icon", true, 110), "icon");
    assert.equal(deckArrangement("icon", false, 319), "icon");
});

test("the deck catalogue uses comma-below Romanian letters and proper minus signs stay out of it", () => {
    for (const [k, v] of Object.entries(deckMessages.ro)) assert.equal(/[\u015F\u0163\u015E\u0162]/.test(v), false, `${k} uses cedilla instead of comma-below`);
    // Every phrase kind the overview can label has a name in both locales.
    for (const kind of ["Intro", "Break", "Build", "Main", "Outro"]) {
        const key = `deckui.phrase${kind}` as keyof typeof deckMessages.en;
        assert.ok(deckMessages.en[key], `${key} missing in en`);
        assert.ok(deckMessages.ro[key], `${key} missing in ro`);
    }
});
