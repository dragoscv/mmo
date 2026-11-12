// Run: cd apps/mixai; node --test "src/components/deck-tabs/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridFromDeck } from "../../grid/markers.ts";
import { deckTabsMessages } from "../../i18n/messages-decktabs.ts";
import {
    DEV_TRACK_ID_BASE,
    LOOP_SIZES,
    MUTE_FX_BEATS,
    XF_MAGNET,
    beatsLabel,
    beatsPlural,
    cueLoopBeats,
    cueLoopOffer,
    deckPropsEqual,
    fmtCueTime,
    fmtLoopTime,
    isLibraryTrackId,
    loopBeats,
    loopLabel,
    matchLoopSize,
    muteFxChoice,
    padArmLive,
    padPress,
    sameFields,
    soloIndex,
    stemChanges,
    stemGains,
    stemMuted,
    stemXfValues,
    xfFromSlider,
    xfReadout,
    xfThumb,
    xfToSlider,
    type PadArm,
    type PadArmContext,
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

/** The sentence the UI builds for a beat count (what `useBeatsText` does, without React). */
function beatsSentence(locale: "en" | "ro", key: "decktabs.cueLoop" | "decktabs.loopOnState" | "decktabs.beatLoop" | "decktabs.muteFxBeat", label: string): string {
    const text: string = deckTabsMessages[locale][`${key}.${beatsPlural(label, locale)}`];
    return text.replace("{n}", label);
}

test("beatsPlural: English one / other; a fraction of a beat reads as one", () => {
    assert.equal(beatsPlural("1", "en"), "one");
    for (const n of ["2", "4", "16", "32", "3.5", "0.3", "0"]) assert.equal(beatsPlural(n, "en"), "other", n);
    for (const n of ["1/2", "1/4", "1/8", "1/32"]) assert.equal(beatsPlural(n, "en"), "one", n);
    assert.equal(beatsSentence("en", "decktabs.muteFxBeat", "1"), "Mute FX echo time: 1 beat");
    assert.equal(beatsSentence("en", "decktabs.muteFxBeat", "2"), "Mute FX echo time: 2 beats");
    assert.equal(beatsSentence("en", "decktabs.muteFxBeat", "1/2"), "Mute FX echo time: 1/2 beat");
    assert.equal(beatsSentence("en", "decktabs.cueLoop", "1"), "Cue loop, 1 beat");
    assert.equal(beatsSentence("en", "decktabs.cueLoop", "4"), "Cue loop, 4 beats");
    assert.equal(beatsSentence("en", "decktabs.loopOnState", "1"), "Loop on, 1 beat");
    assert.equal(beatsSentence("en", "decktabs.loopOnState", "16"), "Loop on, 16 beats");
    assert.equal(beatsSentence("en", "decktabs.beatLoop", "4"), "4-beat loop");
});

test("beatsPlural: Romanian 1 bătaie, 2 bătăi, 20 de bătăi (\"de\" from 20 up, except numbers ending in 01-19)", () => {
    assert.equal(beatsPlural("1", "ro"), "one");
    for (const n of ["2", "4", "8", "16", "19", "101", "102", "119", "3.5", "0"]) assert.equal(beatsPlural(n, "ro"), "few", n);
    for (const n of ["20", "21", "32", "64", "100", "120", "200"]) assert.equal(beatsPlural(n, "ro"), "other", n);
    for (const n of ["1/2", "1/4", "1/8"]) assert.equal(beatsPlural(n, "ro"), "one", n);
    assert.equal(beatsSentence("ro", "decktabs.cueLoop", "1"), "Buclă pe cue, 1 bătaie");
    assert.equal(beatsSentence("ro", "decktabs.cueLoop", "2"), "Buclă pe cue, 2 bătăi");
    assert.equal(beatsSentence("ro", "decktabs.cueLoop", "16"), "Buclă pe cue, 16 bătăi");
    assert.equal(beatsSentence("ro", "decktabs.cueLoop", "20"), "Buclă pe cue, 20 de bătăi");
    assert.equal(beatsSentence("ro", "decktabs.cueLoop", "32"), "Buclă pe cue, 32 de bătăi");
    assert.equal(beatsSentence("ro", "decktabs.cueLoop", "1/2"), "Buclă pe cue, 1/2 bătaie");
    assert.equal(beatsSentence("ro", "decktabs.loopOnState", "4"), "Buclă activă, 4 bătăi");
    assert.equal(beatsSentence("ro", "decktabs.loopOnState", "32"), "Buclă activă, 32 de bătăi");
    assert.equal(beatsSentence("ro", "decktabs.muteFxBeat", "1"), "Timpul ecoului Mute FX: 1 bătaie");
    assert.equal(beatsSentence("ro", "decktabs.muteFxBeat", "2"), "Timpul ecoului Mute FX: 2 bătăi");
    assert.equal(beatsSentence("ro", "decktabs.beatLoop", "1"), "Buclă de 1 bătaie");
    assert.equal(beatsSentence("ro", "decktabs.beatLoop", "8"), "Buclă de 8 bătăi");
    assert.equal(beatsSentence("ro", "decktabs.beatLoop", "32"), "Buclă de 32 de bătăi");
});

test("beat sentences: every plural form exists in both languages and no sentence says \"1 beats\" or \"2 beat\"", () => {
    for (const key of ["decktabs.cueLoop", "decktabs.loopOnState", "decktabs.beatLoop", "decktabs.muteFxBeat"] as const)
        for (const form of ["one", "few", "other"] as const)
            for (const locale of ["en", "ro"] as const) assert.ok(deckTabsMessages[locale][`${key}.${form}`].includes("{n}"), `${locale} ${key}.${form}`);
    for (const size of [...LOOP_SIZES, ...MUTE_FX_BEATS, 3, 20, 64]) {
        const label = beatsLabel(size);
        const en = beatsSentence("en", "decktabs.cueLoop", label);
        assert.equal(/ beat$/.test(en), label === "1" || label.includes("/"), en);
        const ro = beatsSentence("ro", "decktabs.cueLoop", label);
        assert.equal(/ bătaie$/.test(ro), label === "1" || label.includes("/"), ro);
        assert.equal(/ de bătăi$/.test(ro), size >= 20, ro);
    }
});

const ARM_DECK: PadArmContext = { loaded: true, loopActive: false, anyCueLoop: false, anySet: false };

test("cueLoopOffer: save while a loop runs, remove when a cue loop exists, else nothing", () => {
    assert.equal(cueLoopOffer({ ...ARM_DECK, loopActive: true }), "save");
    assert.equal(cueLoopOffer({ ...ARM_DECK, loopActive: true, anyCueLoop: true }), "save");
    assert.equal(cueLoopOffer({ ...ARM_DECK, anyCueLoop: true }), "remove");
    assert.equal(cueLoopOffer(ARM_DECK), null);
    assert.equal(cueLoopOffer({ ...ARM_DECK, loaded: false, loopActive: true, anyCueLoop: true }), null);
});

test("padArmLive: an armed action keeps its meaning and is dropped when the deck leaves that state", () => {
    const looping = { ...ARM_DECK, loopActive: true, anySet: true };
    const save: PadArm = { kind: "save", trackId: "7" };
    assert.equal(padArmLive(null, "7", looping), null);
    assert.equal(padArmLive(save, "7", looping), "save");
    // The loop ended: an armed "save" is over. It does NOT become "remove" (scenario B).
    assert.equal(padArmLive(save, "7", { ...looping, loopActive: false, anyCueLoop: true }), null);
    assert.equal(padArmLive(save, "7", { ...looping, loopActive: false }), null);
    // Another track on the deck, or none.
    assert.equal(padArmLive(save, "8", looping), null);
    assert.equal(padArmLive(save, null, looping), null);
    assert.equal(padArmLive({ kind: "save", trackId: null }, null, looping), "save");
    assert.equal(padArmLive(save, "7", { ...looping, loaded: false }), null);
    // "remove" stands while no loop runs and a cue loop exists; a loop that starts ends it.
    const stored = { ...ARM_DECK, anyCueLoop: true, anySet: true };
    const remove: PadArm = { kind: "remove", trackId: "7" };
    assert.equal(padArmLive(remove, "7", stored), "remove");
    assert.equal(padArmLive(remove, "7", { ...stored, loopActive: true }), null);
    assert.equal(padArmLive(remove, "7", { ...stored, anyCueLoop: false }), null);
    // "clear" stands while a cue is set.
    const clear: PadArm = { kind: "clear", trackId: "7" };
    assert.equal(padArmLive(clear, "7", { ...ARM_DECK, anySet: true }), "clear");
    assert.equal(padArmLive(clear, "7", { ...ARM_DECK, anySet: true, loopActive: true }), "clear");
    assert.equal(padArmLive(clear, "7", ARM_DECK), null);
    assert.equal(padArmLive(clear, "9", { ...ARM_DECK, anySet: true }), null);
});

test("padPress: what a pad press does, armed or not", () => {
    const pad = { isSet: true, hasLoop: false, shift: false, alt: false, arm: null, loopActive: false } as const;
    assert.equal(padPress(pad), "jump");
    assert.equal(padPress({ ...pad, isSet: false }), "set");
    assert.equal(padPress({ ...pad, shift: true }), "clear");
    assert.equal(padPress({ ...pad, arm: "clear" }), "clear");
    // An armed clear on an empty pad sets it (nothing to clear there).
    assert.equal(padPress({ ...pad, isSet: false, arm: "clear" }), "set");
    // Armed save: any pad, set or empty, gets the running loop.
    assert.equal(padPress({ ...pad, arm: "save", loopActive: true }), "saveLoop");
    assert.equal(padPress({ ...pad, isSet: false, arm: "save", loopActive: true }), "saveLoop");
    // Armed remove: only a pad that carries a loop; another set pad just jumps.
    assert.equal(padPress({ ...pad, hasLoop: true, arm: "remove" }), "removeLoop");
    assert.equal(padPress({ ...pad, arm: "remove" }), "jump");
    // Alt = save in one step, only while a loop runs.
    assert.equal(padPress({ ...pad, alt: true, loopActive: true }), "saveLoop");
    assert.equal(padPress({ ...pad, isSet: false, alt: true, loopActive: true }), "saveLoop");
    assert.equal(padPress({ ...pad, alt: true }), "jump");
    // Shift wins over everything.
    assert.equal(padPress({ ...pad, shift: true, alt: true, arm: "save", loopActive: true }), "clear");
    // A stale arm can never flip the action: "save" without a loop and "remove" with one are a jump.
    assert.equal(padPress({ ...pad, hasLoop: true, arm: "save", loopActive: false }), "jump");
    assert.equal(padPress({ ...pad, hasLoop: true, arm: "remove", loopActive: true }), "jump");
});

test("armed cue loop, scenario A: arm save, the loop ends, a new loop later, pad 1 pressed to jump", () => {
    const arm: PadArm = { kind: "save", trackId: "7" };
    const pad1 = { isSet: true, hasLoop: false, shift: false, alt: false };
    // Armed while the loop runs: the next pad would get the loop.
    let deck: PadArmContext = { loaded: true, loopActive: true, anyCueLoop: false, anySet: true };
    assert.equal(padPress({ ...pad1, arm: padArmLive(arm, "7", deck), loopActive: deck.loopActive }), "saveLoop");
    // The loop is exited: the arm is dropped (the component forgets it for good at this point).
    deck = { ...deck, loopActive: false };
    const live = padArmLive(arm, "7", deck);
    assert.equal(live, null);
    const kept: PadArm | null = live === null ? null : arm;
    // A new loop is set later and pad 1 is pressed: a jump, the cue stays where it is.
    deck = { ...deck, loopActive: true };
    assert.equal(padPress({ ...pad1, arm: padArmLive(kept, "7", deck), loopActive: deck.loopActive }), "jump");
    // The old behaviour (a boolean read against the loop state at press time) saved the loop here:
    // the stored arm, had it been kept, would be live again.
    assert.equal(padArmLive(arm, "7", deck), "save");
});

test("armed cue loop, scenario B: arm save, the loop ends, a cue-loop pad pressed: its loop stays", () => {
    const arm: PadArm = { kind: "save", trackId: "7" };
    const loopPad = { isSet: true, hasLoop: true, shift: false, alt: false };
    const deck: PadArmContext = { loaded: true, loopActive: false, anyCueLoop: true, anySet: true };
    // The loop ended while armed: the button now OFFERS "remove", but nothing is armed.
    assert.equal(cueLoopOffer(deck), "remove");
    assert.equal(padArmLive(arm, "7", deck), null);
    assert.equal(padPress({ ...loopPad, arm: padArmLive(arm, "7", deck), loopActive: false }), "jump");
    // Removing a stored loop takes arming "remove" on purpose.
    const remove: PadArm = { kind: "remove", trackId: "7" };
    assert.equal(padPress({ ...loopPad, arm: padArmLive(remove, "7", deck), loopActive: false }), "removeLoop");
    // And an armed action never survives a track change.
    assert.equal(padPress({ ...loopPad, arm: padArmLive(remove, "8", deck), loopActive: false }), "jump");
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

test("stemChanges: a stem that goes silent is a mute, one that returns to unity an unmute, the rest level moves", () => {
    assert.deepEqual(stemChanges([1, 1, 1, 1], [1, 1, 1, 1]), []);
    assert.deepEqual(stemChanges([1, 1, 1, 1], [0, 1, 1, 1]), [{ idx: 0, kind: "mute", gain: 0 }]);
    assert.deepEqual(stemChanges([0, 1, 1, 1], [1, 1, 1, 1]), [{ idx: 0, kind: "unmute", gain: 1 }]);
    // Solo the bass from a mixed state: three mutes and one level move (0.6 -> 1).
    assert.deepEqual(stemChanges([1, 1, 0.6, 1], [0, 0, 1, 0]), [
        { idx: 0, kind: "mute", gain: 0 },
        { idx: 1, kind: "mute", gain: 0 },
        { idx: 2, kind: "gain", gain: 1 },
        { idx: 3, kind: "mute", gain: 0 },
    ]);
    // Release that solo: the muted three come back.
    assert.deepEqual(
        stemChanges([0, 0, 1, 0], [1, 1, 1, 1]).map((c) => c.kind),
        ["unmute", "unmute", "unmute"],
    );
    // A level dragged up from silence to 40 % is a level move (unmute means back to unity).
    assert.deepEqual(stemChanges([0, 1, 1, 1], [0.4, 1, 1, 1]), [{ idx: 0, kind: "gain", gain: 0.4 }]);
    // Below the mute threshold both ways: still a level move, never a second mute.
    assert.deepEqual(stemChanges([0, 1, 1, 1], [0.0005, 1, 1, 1]), [{ idx: 0, kind: "gain", gain: 0.0005 }]);
    // Missing values are unity.
    assert.deepEqual(stemChanges([], [1, 1, 1, 0]), [{ idx: 3, kind: "mute", gain: 0 }]);
});

test("stem crossfader: control value <-> engine position, centre detent for the pointer only", () => {
    assert.deepEqual(stemXfValues(undefined), [0, 0, 0, 0]);
    assert.deepEqual(stemXfValues([-1, 0.5, 2, Number.NaN]), [-1, 0.5, 1, 0]);
    assert.equal(xfToSlider(-0.3), -30);
    assert.equal(xfToSlider(1), 100);
    assert.equal(xfToSlider(7), 100);
    assert.equal(Object.is(xfToSlider(-0.001), 0), true);
    assert.equal(xfFromSlider(-30), -0.3);
    assert.equal(xfFromSlider(100), 1);
    assert.equal(xfFromSlider(250), 1);
    assert.equal(xfFromSlider(Number.NaN), 0);
    // Keyboard (no magnet): one step off the centre stays off the centre.
    assert.equal(xfFromSlider(5), 0.05);
    assert.equal(xfFromSlider(-5), -0.05);
    // Pointer: inside the magnet is the centre, just outside is not.
    assert.equal(xfFromSlider(XF_MAGNET, XF_MAGNET), 0);
    assert.equal(xfFromSlider(-XF_MAGNET, XF_MAGNET), 0);
    assert.equal(xfFromSlider(XF_MAGNET + 5, XF_MAGNET), 0.15);
    for (const v of [-100, -55, 0, 5, 100]) assert.equal(xfToSlider(xfFromSlider(v)), v);
});

test("stem crossfader: readout (side + percent) and thumb position", () => {
    assert.deepEqual(xfReadout(0), { side: null, pct: 0 });
    assert.deepEqual(xfReadout(-0.3), { side: "a", pct: 30 });
    assert.deepEqual(xfReadout(0.6), { side: "b", pct: 60 });
    assert.deepEqual(xfReadout(-1), { side: "a", pct: 100 });
    // Rounds to the centre: no side.
    assert.deepEqual(xfReadout(0.004), { side: null, pct: 0 });
    assert.equal(xfThumb(-1), 0);
    assert.equal(xfThumb(0), 0.5);
    assert.equal(xfThumb(1), 1);
    assert.equal(xfThumb(Number.NaN), 0.5);
});

test("mute FX echo time: the listed value, default 1/2 beat, -1 for anything else", () => {
    assert.deepEqual([...MUTE_FX_BEATS], [0.25, 0.5, 1, 2]);
    for (const b of MUTE_FX_BEATS) assert.equal(muteFxChoice(b), b);
    assert.equal(muteFxChoice(undefined), 0.5);
    assert.equal(muteFxChoice(null), 0.5);
    assert.equal(muteFxChoice(0.5000000001), 0.5);
    assert.equal(muteFxChoice(4), -1);
    assert.equal(muteFxChoice(0.125), -1);
});

test("cueLoopBeats: the loop a hot cue carries; null for a plain cue or an engine without cue loops", () => {
    const loops = [null, 4, 0.5, 0, -2, Number.NaN, undefined, 16];
    assert.equal(cueLoopBeats(loops, 0), null);
    assert.equal(cueLoopBeats(loops, 1), 4);
    assert.equal(cueLoopBeats(loops, 2), 0.5);
    assert.equal(cueLoopBeats(loops, 3), null);
    assert.equal(cueLoopBeats(loops, 4), null);
    assert.equal(cueLoopBeats(loops, 5), null);
    assert.equal(cueLoopBeats(loops, 6), null);
    assert.equal(cueLoopBeats(loops, 7), 16);
    assert.equal(cueLoopBeats(loops, 12), null);
    assert.equal(cueLoopBeats(undefined, 1), null);
    assert.equal(cueLoopBeats(null, 1), null);
    assert.equal(loopLabel(cueLoopBeats(loops, 2) ?? 0), "1/2");
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
