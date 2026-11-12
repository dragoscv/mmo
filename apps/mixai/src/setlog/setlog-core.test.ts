// Run: cd apps/mixai; node --test src/setlog/setlog-core.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    MAX_ENTRIES,
    PERSIST_GAP_MS,
    STORAGE_VERSION,
    SetSession,
    decksToObs,
    fileName,
    focusAfterRemove,
    keptAtEnd,
    mayPersist,
    parseSavedSet,
    sameRows,
    sampleDue,
    serializeSavedSet,
    sessionClock,
    tracksKey,
    withoutEntry,
    type SavedSet,
} from "./setlog-core.ts";
import { tracklistText } from "./export.ts";
import type { Entry } from "./set-logger.ts";

type Deck = Parameters<typeof decksToObs>[0][number];

function deck(id: "a" | "b" | "c" | "d", over: Partial<Deck> = {}): Deck {
    return { id, loaded: true, playing: true, volume: 1, crossfaderAssign: id === "a" || id === "c" ? "a" : "b", trackId: `t-${id}`, title: `Title ${id}`, artist: `Artist ${id}`, duration: 200, ...over };
}

function entry(id: string, start: number, played: number, d = "a"): Entry {
    return { track: { id, title: `Title ${id}`, artist: `Artist ${id}` }, deck: d, startSec: start, playedSec: played };
}

test("a deck snapshot becomes a logger observation: side from the assignment, no track while empty", () => {
    const obs = decksToObs([deck("a"), deck("b", { crossfaderAssign: "thru", playing: false, volume: 0.4 }), deck("c", { loaded: false }), deck("d", { trackId: null, title: " Tune ", artist: null, duration: 312.4 })]);
    assert.deepEqual(obs[0], { deck: "a", playing: true, volume: 1, side: "a", track: { id: "t-a", title: "Title a", artist: "Artist a" } });
    assert.deepEqual([obs[1]!.side, obs[1]!.playing, obs[1]!.volume], ["thru", false, 0.4]);
    assert.equal(obs[2]!.track, null, "a deck that is not loaded has no track, whatever id it still carries");
    assert.deepEqual(obs[3]!.track, { id: "k:Tune\u001f\u001f312", title: "Tune", artist: "" });
    // A junk assignment (older engine) is heard like THRU, never dropped.
    assert.equal(decksToObs([deck("a", { crossfaderAssign: "x" as never })])[0]!.side, "thru");
});

test("file name of a Windows or POSIX path", () => {
    assert.equal(fileName("C:\\Users\\dj\\Music\\MIXAI-set-2026-11-12-21-30-00.wav"), "MIXAI-set-2026-11-12-21-30-00.wav");
    assert.equal(fileName("/home/dj/sets/a b.wav"), "a b.wav");
    assert.equal(fileName("plain.wav"), "plain.wav");
    assert.equal(fileName("C:\\sets\\"), null);
    assert.equal(fileName(""), null);
    assert.equal(fileName(null), null);
    assert.equal(fileName(42), null);
});

test("the logger is sampled at most every 250 ms, and a clock that jumped back samples at once", () => {
    assert.equal(sampleDue(0, 1000), true, "first sample");
    assert.equal(sampleDue(1000, 1100), false);
    assert.equal(sampleDue(1000, 1249), false);
    assert.equal(sampleDue(1000, 1250), true);
    assert.equal(sampleDue(5000, 4000), true);
});

test("a saved set survives a round trip", () => {
    const set: SavedSet = { startedAt: 1_700_000_000_000, lengthSec: 3712.4, file: "set.wav", entries: [entry("a", 0, 312.4), entry("b", 312.4, 3400, "b")] };
    assert.deepEqual(parseSavedSet(JSON.parse(serializeSavedSet(set))), set);
    assert.equal(JSON.parse(serializeSavedSet(set)).v, STORAGE_VERSION);
});

test("stored junk is refused whole, malformed entries one by one, and the list is capped", () => {
    for (const junk of [null, undefined, 7, "x", [], {}, { v: 2, startedAt: 5, entries: [] }, { v: 1 }, { v: 1, startedAt: "5" }, { v: 1, startedAt: Number.NaN }, { v: 1, startedAt: -1 }]) assert.equal(parseSavedSet(junk), null, JSON.stringify(junk));
    const good = entry("a", 10, 20);
    const raw = {
        v: 1,
        startedAt: 1000,
        lengthSec: "long",
        file: "C:\\x\\y.wav",
        entries: [
            good,
            null,
            "x",
            { ...good, startSec: -1 },
            { ...good, startSec: Number.NaN },
            { ...good, playedSec: "3" },
            { ...good, deck: "z" },
            { ...good, deck: 1 },
            { ...good, track: null },
            { ...good, track: { id: "", title: "t", artist: "a" } },
            { ...good, track: { id: "i", title: 5, artist: "a" } },
            { ...good, track: { id: "i", title: "t" } },
            entry("b", 30, 5, "d"),
        ],
    };
    const parsed = parseSavedSet(raw)!;
    assert.deepEqual(
        parsed.entries.map((e) => e.track.id),
        ["a", "b"],
    );
    assert.equal(parsed.lengthSec, 0, "an unusable length reads as 0");
    assert.equal(parsed.file, "y.wav", "only the file name is kept");
    assert.deepEqual(parseSavedSet({ v: 1, startedAt: 1000, entries: "nope" })!.entries, []);
    const many = { v: 1, startedAt: 1000, entries: Array.from({ length: MAX_ENTRIES + 50 }, (_, i) => entry(`t${i}`, i, 1)) };
    assert.equal(parseSavedSet(many)!.entries.length, MAX_ENTRIES);
    const long = parseSavedSet({ v: 1, startedAt: 1000, entries: [{ ...good, track: { id: "i", title: "x".repeat(900), artist: "a" } }] })!;
    assert.equal(long.entries[0]!.track.title.length, 300, "over-long text is cut, not trusted");
});

test("removing an entry of a saved set gives its time to the previous one", () => {
    const set: SavedSet = { startedAt: 1000, lengthSec: 170, file: null, entries: [entry("a", 0, 100), entry("b", 100, 50), entry("c", 150, 20)] };
    const next = withoutEntry(set, 1);
    assert.deepEqual(
        next.entries.map((e) => [e.track.id, e.playedSec]),
        [
            ["a", 150],
            ["c", 20],
        ],
    );
    assert.equal(next.lengthSec, 170);
    assert.equal(withoutEntry(set, 5), set, "out of range: the same object");
    assert.equal(set.entries.length, 3, "input untouched");
});

test("rows are the same when track, deck and start agree (time on air may move)", () => {
    const a = [entry("a", 0, 10), entry("b", 10, 5, "b")];
    assert.equal(sameRows(a, [entry("a", 0, 99), entry("b", 10, 7, "b")]), true);
    assert.equal(sameRows(a, [entry("a", 0, 10)]), false);
    assert.equal(sameRows(a, [entry("a", 0, 10), entry("b", 11, 5, "b")]), false);
    assert.equal(sameRows(a, [entry("a", 0, 10), entry("b", 10, 5, "a")]), false);
    assert.equal(sameRows(a, [entry("a", 0, 10), entry("x", 10, 5, "b")]), false);
    assert.equal(sameRows([], []), true);
});

test("a recording session: wall clock in, two backdated entries out, length fixed at the end", () => {
    const t0 = 1_700_000_000_000;
    const s = new SetSession(t0, "set.wav");
    let changes = 0;
    // Deck A alone for 60 s, then the crossfader goes hard to B (B was playing under it) for 40 s. 4 samples a second.
    for (let ms = 0; ms <= 100_000; ms += 250) {
        const x = ms < 60_000 ? -1 : 1;
        if (s.sample(t0 + ms, [deck("a"), deck("b")], x)) changes++;
    }
    assert.equal(changes, 2, "the store is told only when a row appears");
    const live = s.snapshot(t0 + 100_000);
    assert.deepEqual(
        live.entries.map((e) => [e.track.id, e.deck, e.startSec]),
        [
            ["t-a", "a", 0],
            ["t-b", "b", 60],
        ],
    );
    assert.equal(live.lengthSec, 100);
    const done = s.finish(t0 + 104_500);
    assert.equal(done.lengthSec, 104.5);
    assert.deepEqual(
        done.entries.map((e) => e.playedSec),
        [60, 44.5],
    );
    assert.equal(done.file, "set.wav");
    assert.equal(done.startedAt, t0);
    // After the end nothing moves any more.
    assert.equal(s.sample(t0 + 200_000, [deck("a")], -1), null);
    assert.equal(s.snapshot(t0 + 900_000).lengthSec, 104.5);
    assert.equal(tracklistText(done.entries), "01. [0:00] Artist a – Title a\n02. [1:00] Artist b – Title b\n");
});

test("removing the track that is on air keeps it out until another track takes over", () => {
    const t0 = 5_000_000;
    const s = new SetSession(t0, null);
    for (let ms = 0; ms <= 30_000; ms += 250) s.sample(t0 + ms, [deck("a")], -1);
    assert.equal(s.snapshot(t0 + 30_000).entries.length, 1);
    assert.equal(s.remove(0, t0 + 30_000)!.entries.length, 0);
    assert.equal(s.remove(0, t0 + 30_000), null, "nothing left to remove");
    // The same track keeps playing: it does not come back.
    for (let ms = 30_250; ms <= 90_000; ms += 250) assert.equal(s.sample(t0 + ms, [deck("a")], -1), null);
    // Another track for 25 s, then the first one again: both are listed, the first from its new start.
    for (let ms = 90_250; ms <= 115_000; ms += 250) s.sample(t0 + ms, [deck("a", { trackId: "t-x", title: "X" })], -1);
    for (let ms = 115_250; ms <= 140_000; ms += 250) s.sample(t0 + ms, [deck("a")], -1);
    assert.deepEqual(
        s.finish(t0 + 140_000).entries.map((e) => [e.track.id, e.startSec]),
        [
            ["t-x", 90.25],
            ["t-a", 115.25],
        ],
    );
});

test("where the focus goes after a row was removed", () => {
    assert.equal(focusAfterRemove(1, 2), 1, "the row that took its place");
    assert.equal(focusAfterRemove(2, 2), 1, "the last row was removed: the new last one");
    assert.equal(focusAfterRemove(0, 0), null, "the list is empty: a fixed control takes the focus");
    assert.equal(focusAfterRemove(-3, 4), 0);
});

test("the recording clock follows the monotonic timer, not the system clock", () => {
    // The log begins the moment the recording does: wall 1 000 000 ms, monotonic 5 000 ms.
    const clock = sessionClock(1_000_000, 1_000_000, 5_000);
    assert.equal(clock(5_000), 1_000_000);
    assert.equal(clock(65_000), 1_060_000, "60 s of monotonic time is 60 s of the set");
    // The log begins 2.5 s after the recording (page reload, late subscriber): that time is kept.
    const late = sessionClock(1_000_000, 1_002_500, 9_000);
    assert.equal(late(9_000), 1_002_500);
    assert.equal(late(19_000), 1_012_500);
    // A system clock that is BEHIND the start (changed in between) never gives a negative set time.
    const back = sessionClock(1_000_000, 400_000, 100);
    assert.equal(back(100), 1_000_000);
    assert.equal(back(1_100), 1_001_000);
    assert.equal(sessionClock(1_000_000, Number.NaN, 0)(250), 1_000_250, "an unreadable clock counts from the start");

    // A session fed through that clock keeps logging while the system clock jumps back one hour.
    const t0 = 1_700_000_000_000;
    const c = sessionClock(t0, t0, 0);
    const s = new SetSession(t0, null);
    for (let ms = 0; ms <= 30_000; ms += 250) s.sample(c(ms), [deck("a")], -1);
    // (Date.now() would now read t0 - 3 570 000; the monotonic timer simply goes on.)
    for (let ms = 30_250; ms <= 90_000; ms += 250) s.sample(c(ms), [deck("a", { trackId: "t-x", title: "X" })], -1);
    assert.deepEqual(
        s.finish(c(90_000)).entries.map((e) => [e.track.id, e.startSec]),
        [
            ["t-a", 0],
            ["t-x", 30.25],
        ],
    );
    // Fed with a wall clock that jumped back, the same session is deaf: this is what the clock prevents.
    const deaf = new SetSession(t0, null);
    for (let ms = 0; ms <= 30_000; ms += 250) deaf.sample(t0 + ms, [deck("a")], -1);
    for (let ms = 30_250; ms <= 90_000; ms += 250) deaf.sample(t0 + ms - 3_600_000, [deck("a", { trackId: "t-x", title: "X" })], -1);
    assert.equal(deaf.snapshot(t0 + 90_000).entries.length, 1, "the second track was never heard");
});

test("a recording without a track never replaces an earlier tracklist", () => {
    const friday: SavedSet = { startedAt: 1000, lengthSec: 3600, file: "friday.wav", entries: [entry("a", 0, 1800), entry("b", 1800, 1800, "b")] };
    const check: SavedSet = { startedAt: 9000, lengthSec: 12, file: "check.wav", entries: [] };
    const real: SavedSet = { startedAt: 9000, lengthSec: 600, file: "sat.wav", entries: [entry("c", 0, 600)] };
    const emptyOld: SavedSet = { startedAt: 500, lengthSec: 5, file: null, entries: [] };
    // At the end of the recording.
    assert.equal(keptAtEnd(check, friday), friday, "a sound check keeps Friday's set");
    assert.equal(keptAtEnd(real, friday), real, "a set with tracks replaces it");
    assert.equal(keptAtEnd(check, null), check, "nothing earlier: the empty recording is what there is");
    assert.equal(keptAtEnd(check, emptyOld), check, "an earlier set without tracks is not worth keeping");
    // While it runs (what may be written to storage).
    assert.equal(mayPersist(check, friday), false);
    assert.equal(mayPersist(real, friday), true);
    assert.equal(mayPersist(check, null), true);
    assert.equal(mayPersist(check, emptyOld), true);
    assert.ok(PERSIST_GAP_MS >= 10_000 && PERSIST_GAP_MS <= 120_000, "written often enough to matter, rarely enough to cost nothing");
});

test("counted tracks: three Romanian forms, two English ones", () => {
    assert.equal(tracksKey(1, "en"), "setlog.tracksN.one");
    assert.equal(tracksKey(0, "en"), "setlog.tracksN.other");
    assert.equal(tracksKey(2, "en"), "setlog.tracksN.other");
    assert.equal(tracksKey(1, "ro"), "setlog.tracksN.one");
    assert.equal(tracksKey(0, "ro"), "setlog.tracksN.few");
    assert.equal(tracksKey(2, "ro"), "setlog.tracksN.few");
    assert.equal(tracksKey(19, "ro"), "setlog.tracksN.few");
    assert.equal(tracksKey(20, "ro"), "setlog.tracksN.other");
    assert.equal(tracksKey(101, "ro"), "setlog.tracksN.few");
    assert.equal(tracksKey(Number.NaN, "ro"), "setlog.tracksN.few");
});
