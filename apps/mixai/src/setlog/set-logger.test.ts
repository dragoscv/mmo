// Run: cd apps/mixai; node --test src/setlog/set-logger.test.ts
// The scenarios of src-tauri/crates/decks-setlog/src/lib.rs `mod tests`, with the same expected numbers
// (deck 0 of the crate = deck "a" on side A, deck 1 = "b" on side B), plus the cases the TS port adds:
// a thru deck, an id-less track, the same track again later, time going backwards, NaN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SetLogger, audibleLevel, crossfaderWeight, dominantOf, removeEntry, trackKey, type DeckObs, type Side, type TrackRef } from "./set-logger.ts";

function tr(id: string): TrackRef {
    return { id, title: `Title ${id}`, artist: `Artist ${id}` };
}

function deck(d: "a" | "b" | "c" | "d", playing: boolean, vol: number, id: string | null, side?: Side): DeckObs {
    return { deck: d, playing, volume: vol, side: side ?? (d === "a" || d === "c" ? "a" : "b"), track: id ? tr(id) : null };
}

/** Simulate a set at 1 Hz: `plan(t) -> [decks, crossfader]`, then stop at `until`. */
function run(until: number, plan: (t: number) => [DeckObs[], number]): SetLogger {
    const l = new SetLogger();
    for (let t = 0; t <= until; t++) {
        const [d, x] = plan(t);
        l.observe(t, d, x);
    }
    l.stop(until);
    return l;
}

test("crossfader weights (crate: crossfader_weights) and the store range −1..1", () => {
    assert.equal(crossfaderWeight("a", -1), 1);
    assert.equal(crossfaderWeight("b", -1), 0);
    assert.equal(crossfaderWeight("a", 0), 1);
    assert.equal(crossfaderWeight("b", 0.5), 1);
    assert.equal(crossfaderWeight("a", 0.5), 0.5);
    assert.equal(crossfaderWeight("thru", 1), 1);
    // Values outside the store's range clamp; junk reads as the centre.
    assert.equal(crossfaderWeight("a", 7), 0);
    assert.equal(crossfaderWeight("b", -7), 0);
    assert.equal(crossfaderWeight("a", Number.NaN), 1);
    assert.equal(crossfaderWeight("b", Number.NaN), 1);
});

test("crossfader transition makes two entries, backdated (crate: crossfader_transition_makes_two_entries_backdated)", () => {
    // A plays alone to 100 s; B joins at 90 with fader up; crossfader moves to B at 120.
    const l = run(300, (t) => [[deck("a", t < 140, 1, "a"), deck("b", t >= 90, t >= 90 ? 1 : 0, "b")], t < 120 ? -1 : 1]);
    const e = l.entries();
    assert.equal(e.length, 2);
    assert.deepEqual([e[0]!.track.id, e[0]!.startSec], ["a", 0]);
    assert.deepEqual([e[1]!.track.id, e[1]!.startSec], ["b", 120]);
    assert.equal(e[0]!.playedSec, 120);
    assert.equal(e[1]!.playedSec, 180);
    assert.deepEqual([e[0]!.deck, e[1]!.deck], ["a", "b"]);
});

test("short previews and silence are ignored (crate: short_previews_and_silence_are_ignored)", () => {
    const l = run(200, (t) => {
        const loud = t >= 50 && t < 60; // 10 s < 20 s minimum
        return [[deck("a", true, 1, "a"), deck("b", true, loud ? 1 : 0, "b")], loud ? 1 : -1];
    });
    const e = l.entries();
    assert.equal(e.length, 1);
    assert.equal(e[0]!.track.id, "a");
    const silent = run(100, () => [[deck("a", false, 1, "a")], 0]);
    assert.deepEqual(silent.entries(), []);
});

test("the same track after another counts again; remove merges time (crate: same_track_reloaded_after_another_counts_again_and_remove_merges_time)", () => {
    const l = run(400, (t) => [[deck("a", true, 1, t < 150 ? "a" : t < 300 ? "b" : "a")], -1]);
    assert.deepEqual(
        l.entries().map((e) => e.track.id),
        ["a", "b", "a"],
    );
    assert.deepEqual(
        l.entries().map((e) => e.playedSec),
        [150, 150, 100],
    );
    assert.equal(l.remove(1), true);
    const e = l.entries();
    assert.equal(e.length, 2);
    assert.equal(e[0]!.playedSec, 300);
    assert.equal(e[1]!.startSec, 300);
    assert.equal(l.remove(9), false);
    assert.equal(l.remove(-1), false);
    assert.equal(l.remove(0.5), false);
});

test("time going backwards, NaN, or a sample after stop is ignored (crate: time_going_backwards_or_after_stop_is_ignored)", () => {
    const l = new SetLogger();
    l.observe(30, [deck("a", true, 1, "a")], 0);
    l.observe(10, [deck("a", true, 1, "b")], 0);
    l.observe(Number.NaN, [deck("a", true, 1, "b")], 0);
    l.observe(Number.POSITIVE_INFINITY, [deck("a", true, 1, "b")], 0);
    l.observe(51, [deck("a", true, 1, "a")], 0);
    assert.equal(l.entries().length, 1);
    assert.equal(l.entries()[0]!.startSec, 30);
    assert.equal(l.lastTime, 51);
    l.stop(60);
    assert.equal(l.isStopped, true);
    l.observe(200, [deck("a", true, 1, "b")], 0);
    assert.equal(l.entries().length, 1);
    assert.equal(l.entries()[0]!.playedSec, 30);
    // A second stop changes nothing.
    l.stop(900);
    assert.equal(l.entries()[0]!.playedSec, 30);
});

test("a THRU deck is heard whatever the crossfader does; its side comes from the assignment, not the letter", () => {
    // Deck A assigned THRU, crossfader hard to B all the time: A is the only audible deck.
    const l = run(60, () => [[deck("a", true, 1, "a", "thru"), deck("b", false, 1, "b")], 1]);
    assert.deepEqual(
        l.entries().map((e) => [e.track.id, e.startSec, e.playedSec]),
        [["a", 0, 60]],
    );
    // Deck "b" assigned to side A with the crossfader hard to A: it is heard, deck "a" on side B is not.
    const swapped = run(60, () => [[deck("a", true, 1, "a", "b"), deck("b", true, 1, "b", "a")], -1]);
    assert.deepEqual(
        swapped.entries().map((e) => e.track.id),
        ["b"],
    );
});

test("the audible level is playing × fader × side, and the loudest deck wins (ties go to the first letter)", () => {
    const x = 0.5; // A at 0.5, B at 1.0
    assert.equal(audibleLevel(deck("a", true, 1, "a"), x), 0.5);
    assert.equal(audibleLevel(deck("b", true, 0.8, "b"), x), 0.8);
    assert.equal(audibleLevel(deck("a", false, 1, "a"), x), 0);
    assert.equal(audibleLevel(deck("a", true, 1, null), x), 0);
    assert.equal(audibleLevel(deck("a", true, Number.NaN, "a"), -1), 0);
    assert.equal(audibleLevel(deck("a", true, 3, "a"), -1), 1, "fader above 1 clamps");
    assert.equal(dominantOf([deck("a", true, 1, "a"), deck("b", true, 0.8, "b")], x, 0.05)?.deck, "b");
    assert.equal(dominantOf([deck("b", true, 1, "b", "thru"), deck("a", true, 1, "a", "thru")], 0, 0.05)?.deck, "a");
    assert.equal(dominantOf([deck("a", true, 0.04, "a")], -1, 0.05), null, "below the audible threshold");
    assert.equal(dominantOf([deck("a", true, 0.05, "a")], -1, 0.05)?.deck, "a", "at the threshold counts");
});

test("a track without an id gets a stable key from title, artist and duration", () => {
    assert.equal(trackKey({ trackId: "42", title: "x", artist: "y", duration: 100 }), "42");
    const k1 = trackKey({ trackId: null, title: " Strobe ", artist: "deadmau5", duration: 312.4 });
    assert.equal(k1, trackKey({ title: "Strobe", artist: "deadmau5 ", duration: 312 }), "same file, same key");
    assert.notEqual(k1, trackKey({ title: "Strobe", artist: "Someone", duration: 312 }), "another artist");
    assert.notEqual(k1, trackKey({ title: "Strobe", artist: "deadmau5", duration: 400 }), "another length");
    assert.equal(trackKey({}), trackKey({ title: null, artist: null, duration: Number.NaN }), "nothing known is one key");
    assert.ok(trackKey({ title: "a" }).startsWith("k:"), "never collides with an engine id");
});

test("an id-less track and the same track played again later make their own entries", () => {
    const idless = (title: string): TrackRef => ({ id: trackKey({ title, artist: "A", duration: 200 }), title, artist: "A" });
    const l = new SetLogger();
    const plan = (t: number): [DeckObs[], number] => {
        const title = t < 100 ? "One" : t < 200 ? "Two" : "One";
        return [[{ deck: "a", playing: true, volume: 1, side: "a", track: idless(title) }], 0];
    };
    for (let t = 0; t <= 260; t++) {
        const [d, x] = plan(t);
        l.observe(t, d, x);
    }
    l.stop(260);
    const e = l.entries();
    assert.deepEqual(
        e.map((x) => [x.track.title, x.startSec, x.playedSec]),
        [
            ["One", 0, 100],
            ["Two", 100, 100],
            ["One", 200, 60],
        ],
    );
    assert.equal(e[0]!.track.id, e[2]!.track.id, "the same id-less track keeps its key across loads");
});

test("the provisional last entry grows with time until stop, and entries() returns copies", () => {
    const l = new SetLogger();
    for (let t = 0; t <= 30; t++) l.observe(t, [deck("a", true, 1, "a")], -1);
    const snap = l.entries();
    assert.equal(snap[0]!.playedSec, 30);
    snap[0]!.playedSec = 999;
    snap[0]!.track.title = "changed";
    l.observe(40, [deck("a", true, 1, "a")], -1);
    assert.equal(l.entries()[0]!.playedSec, 40);
    assert.equal(l.entries()[0]!.track.title, "Title a");
    l.stop(45);
    assert.equal(l.entries()[0]!.playedSec, 45);
});

test("removeEntry is pure: the previous entry absorbs the time, out-of-range indexes change nothing", () => {
    const list = [
        { track: tr("a"), deck: "a", startSec: 0, playedSec: 100 },
        { track: tr("b"), deck: "b", startSec: 100, playedSec: 50 },
        { track: tr("c"), deck: "a", startSec: 150, playedSec: 20 },
    ];
    const before = JSON.stringify(list);
    const r1 = removeEntry(list, 1);
    assert.deepEqual(
        r1.map((e) => [e.track.id, e.playedSec]),
        [
            ["a", 150],
            ["c", 20],
        ],
    );
    const r0 = removeEntry(list, 0);
    assert.deepEqual(
        r0.map((e) => [e.track.id, e.playedSec]),
        [
            ["b", 50],
            ["c", 20],
        ],
        "removing the first entry gives its time to nobody",
    );
    assert.equal(removeEntry(list, 3), list);
    assert.equal(removeEntry(list, -1), list);
    assert.equal(JSON.stringify(list), before, "input untouched");
});

test("a track is listed at exactly 20 s on air, not a sample before, and a gap restarts the count", () => {
    const l = new SetLogger();
    for (let t = 0; t <= 19.75; t += 0.25) l.observe(t, [deck("a", true, 1, "a")], -1);
    assert.equal(l.entries().length, 0, "19.75 s is not enough");
    l.observe(20, [deck("a", true, 1, "a")], -1);
    assert.deepEqual(
        l.entries().map((e) => [e.track.id, e.startSec]),
        [["a", 0]],
    );
    // Another track for 19 s, one silent sample, then 19 s more: never 20 s in a row, so it is not listed.
    const m = new SetLogger();
    for (let t = 0; t <= 19; t++) m.observe(t, [deck("a", true, 1, "x")], -1);
    m.observe(20, [deck("a", false, 1, "x")], -1);
    for (let t = 21; t <= 40; t++) m.observe(t, [deck("a", true, 1, "x")], -1);
    assert.equal(m.entries().length, 0);
    m.observe(41, [deck("a", true, 1, "x")], -1);
    assert.deepEqual(
        m.entries().map((e) => [e.track.id, e.startSec]),
        [["x", 21]],
        "backdated to the start of the unbroken run",
    );
});

test("a shorter minimum makes the same scenario log the preview", () => {
    const l = new SetLogger({ minDominantSec: 5 });
    for (let t = 0; t <= 200; t++) {
        const loud = t >= 50 && t < 60;
        l.observe(t, [deck("a", true, 1, "a"), deck("b", true, loud ? 1 : 0, "b")], loud ? 1 : -1);
    }
    l.stop(200);
    assert.deepEqual(
        l.entries().map((e) => e.track.id),
        ["a", "b", "a"],
    );
});

test("a track doubled on a second deck stays one entry; another track in between makes it count again", () => {
    // The same track "x" on both decks: deck A is heard to 100 s, then the crossfader goes to deck B.
    const doubled = run(200, (t) => [[deck("a", true, 1, "x"), deck("b", true, 1, "x")], t < 100 ? -1 : 1]);
    assert.deepEqual(
        doubled.entries().map((e) => [e.track.id, e.deck, e.startSec, e.playedSec]),
        [["x", "a", 0, 200]],
        "one line, from its first start to the end of the set",
    );
    // "x" on deck A, 60 s of "y" on deck B, then "x" again on deck B: three lines.
    const between = run(300, (t) => [[deck("a", t < 100, 1, "x"), deck("b", t >= 100, 1, t < 160 ? "y" : "x")], t < 100 ? -1 : 1]);
    assert.deepEqual(
        between.entries().map((e) => [e.track.id, e.deck, e.startSec]),
        [
            ["x", "a", 0],
            ["y", "b", 100],
            ["x", "b", 160],
        ],
    );
});

test("a listed track that pauses and resumes is not listed twice", () => {
    const l = run(200, (t) => [[deck("a", t < 60 || t >= 70, 1, "x")], -1]);
    assert.deepEqual(
        l.entries().map((e) => [e.track.id, e.startSec, e.playedSec]),
        [["x", 0, 200]],
    );
});

test("a removed track stays out when it moves to another deck, and returns after silence or another track", () => {
    const l = new SetLogger();
    for (let t = 0; t <= 30; t++) l.observe(t, [deck("a", true, 1, "x"), deck("b", true, 1, "x")], -1);
    assert.equal(l.entries().length, 1);
    assert.equal(l.remove(0), true);
    // Still "x", now heard from deck B: removed by hand, so it does not come back.
    for (let t = 31; t <= 90; t++) l.observe(t, [deck("a", true, 1, "x"), deck("b", true, 1, "x")], 1);
    assert.equal(l.entries().length, 0);
    // One silent sample ends the removal: after 20 s on air it is listed again, from that new start.
    l.observe(91, [deck("a", false, 1, "x"), deck("b", false, 1, "x")], 1);
    for (let t = 92; t <= 112; t++) l.observe(t, [deck("b", true, 1, "x")], 1);
    assert.deepEqual(
        l.entries().map((e) => [e.track.id, e.deck, e.startSec]),
        [["x", "b", 92]],
    );
    // Removing an EARLIER entry while another track is on air does not hide the track on air.
    const m = run(100, (t) => [[deck("a", true, 1, t < 40 ? "p" : "q")], -1]);
    const n = new SetLogger();
    for (let t = 0; t <= 70; t++) n.observe(t, [deck("a", true, 1, t < 40 ? "p" : "q")], -1);
    assert.equal(n.remove(0), true);
    n.observe(71, [deck("a", true, 1, "q")], -1);
    assert.deepEqual(
        n.entries().map((e) => e.track.id),
        ["q"],
    );
    assert.equal(m.entries().length, 2);
});
