// Run: cd apps/mixai; node --test "src/**/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { TONIGHT_MS, makePlayTracker, parseHistory, playedTonight, withPlayed } from "./history-store.ts";

test("a track counts as played only after 30 s of actual playback on a deck", () => {
    const track = makePlayTracker(30);
    let now = 1_000_000;
    // Loaded and cued, not playing: never counts, however long it sits there.
    for (let i = 0; i < 100; i++) assert.equal(track("a", "t1", false, (now += 500)), null);
    // Playing: 29.5 s is not enough…
    for (let i = 0; i < 59; i++) assert.equal(track("a", "t1", true, (now += 500)), null);
    // …the 30th second marks it, exactly once.
    assert.equal(track("a", "t1", true, (now += 500)), "t1");
    for (let i = 0; i < 20; i++) assert.equal(track("a", "t1", true, (now += 500)), null);
});

test("pauses do not count, a new track starts from zero, decks are independent", () => {
    const track = makePlayTracker(2);
    let now = 5_000;
    assert.equal(track("a", "t1", true, now), null);
    assert.equal(track("a", "t1", true, (now += 1000)), null); // 1 s
    assert.equal(track("a", "t1", false, (now += 1000)), null); // paused second
    assert.equal(track("b", "t9", true, now), null); // other deck starts
    // Another track on deck A: its second of playback is not inherited.
    assert.equal(track("a", "t2", true, (now += 1000)), null);
    assert.equal(track("a", "t2", true, (now += 1000)), null); // 1 s of t2
    assert.equal(track("a", "t2", true, (now += 1000)), "t2"); // 2 s of t2
    // Deck B accumulated its own time meanwhile (capped at 1 s per snapshot gap).
    assert.equal(track("b", "t9", true, now), null); // one capped second
    assert.equal(track("b", "t9", true, (now += 1000)), "t9");
    // Unloading resets the deck.
    assert.equal(track("a", null, false, (now += 1000)), null);
});

test("a stalled UI (long gap between snapshots) adds at most one second", () => {
    const track = makePlayTracker(3);
    assert.equal(track("a", "t1", true, 0), null);
    assert.equal(track("a", "t1", true, 60_000), null); // 60 s gap counts as 1 s
    assert.equal(track("a", "t1", true, 61_000), null); // 2 s
    assert.equal(track("a", "t1", true, 62_000), "t1"); // 3 s
});

test("playedTonight is the last 12 hours, never the future, never 'never'", () => {
    const now = 1_700_000_000_000;
    assert.equal(playedTonight(undefined, now), false);
    assert.equal(playedTonight(now, now), true);
    assert.equal(playedTonight(now - TONIGHT_MS, now), true);
    assert.equal(playedTonight(now - TONIGHT_MS - 1, now), false);
    assert.equal(playedTonight(now + 1, now), false);
});

test("withPlayed keeps the newest entries when the cap is reached", () => {
    let m = {};
    for (let i = 1; i <= 5; i++) m = withPlayed(m, `t${i}`, i * 10, 3);
    assert.deepEqual(m, { t3: 30, t4: 40, t5: 50 });
    // Re-playing an old survivor refreshes it instead of adding a row.
    m = withPlayed(m, "t3", 99, 3);
    assert.deepEqual(m, { t3: 99, t4: 40, t5: 50 });
});

test("parseHistory drops malformed entries and non-objects", () => {
    assert.deepEqual(parseHistory(null), {});
    assert.deepEqual(parseHistory([1, 2]), {});
    assert.deepEqual(parseHistory("x"), {});
    assert.deepEqual(parseHistory({ a: 5, b: "6", c: -1, d: Number.NaN, e: 7 }), { a: 5, e: 7 });
});
