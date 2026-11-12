// Run: node --test apps/mixai/src/copilot/features.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeckId, LibraryTrack } from "../bridge/types.ts";
import {
    BPM_STEP,
    CONTROL_MIN,
    CONTROL_MIN_TOUCH,
    ROW_GAP,
    ROW_H,
    ROW_H_DENSE,
    ROW_WHY_H,
    barsUntil,
    candidates,
    controlMin,
    deckFeat,
    decksKey,
    errorKey,
    fitRows,
    intentDeck,
    isArrowKey,
    keepArrowFromShortcuts,
    listMove,
    orderReasons,
    otherDeck,
    playingDeck,
    quantBpm,
    rankKey,
    referenceDeck,
    rowHeight,
    rowOf,
    trackChangedDeck,
    trackFeat,
    type DeckLike,
} from "./features.ts";

function tr(id: number, p: Partial<LibraryTrack> = {}): LibraryTrack {
    return {
        id,
        filepath: `/m/${id}.mp3`,
        filename: `${id}.mp3`,
        artist: null,
        title: null,
        bpm: null,
        keyCamelot: null,
        duration: null,
        genre: null,
        isFavorite: null,
        rating: null,
        stemsStatus: null,
        ...p,
    };
}

function deck(id: DeckId, p: Partial<DeckLike> = {}): DeckLike {
    return { id, trackId: null, title: null, artist: null, loaded: false, playing: false, position: 0, duration: 0, bpm: 0, tempo: 1, firstBeat: 0, hasStems: false, ...p };
}

test("a library row becomes track features; missing energy is null", () => {
    const f = trackFeat(tr(7, { title: " One ", artist: "Two", bpm: 129.2, keyCamelot: "8A", duration: 201.5, stemsStatus: "ready" }));
    assert.deepEqual(f, { id: "7", title: "One", artist: "Two", bpm: 129.2, key: "8A", energy: null, durationSec: 201.5, firstBeatSec: 0, downbeatOffset: 0, lufs: null, hasStems: true });
    // `energy` undefined (older companion), zero tempo, NaN duration, blank title.
    const bare = trackFeat(tr(8, { bpm: 0, duration: Number.NaN, energy: undefined, title: "  " }));
    assert.equal(bare.energy, null);
    assert.equal(bare.bpm, null);
    assert.equal(bare.durationSec, 0);
    assert.equal(bare.title, "8.mp3");
    assert.equal(trackFeat(tr(9, { energy: 7 })).energy, 7);
    assert.equal(trackFeat(tr(9, { energy: 0 })).energy, null);
    assert.equal(trackFeat(tr(9, { energy: 11 })).energy, null);
    // Everything the shell validates stays JSON-safe (no NaN / undefined).
    assert.equal(JSON.stringify(bare).includes("null"), true);
    assert.equal(/NaN|undefined/.test(JSON.stringify(bare)), false);
});

test("deck features come from the engine, energy and stems from the library row", () => {
    const d = deck("a", { trackId: "7", title: "Loaded", artist: "Artist", loaded: true, duration: 200, bpm: 128, firstBeat: 0.21 });
    const row = tr(7, { energy: 6, keyCamelot: "9A", stemsStatus: "ready", bpm: 127, duration: 199 });
    const f = deckFeat(d, "8A", row);
    assert.deepEqual(f, { id: "7", title: "Loaded", artist: "Artist", bpm: 128, key: "8A", energy: 6, durationSec: 200, firstBeatSec: 0.21, downbeatOffset: 0, lufs: null, hasStems: true });
    // No row (a local file), no deck key, nothing analysed yet.
    const bare = deckFeat(deck("b"), null, null);
    assert.deepEqual(bare, { id: "deck-b", title: "", artist: "", bpm: null, key: null, energy: null, durationSec: 0, firstBeatSec: 0, downbeatOffset: 0, lufs: null, hasStems: false });
    // Engine values missing: the row fills in.
    const fromRow = deckFeat(deck("a", { trackId: "7", loaded: true }), null, row);
    assert.equal(fromRow.bpm, 127);
    assert.equal(fromRow.key, "9A");
    assert.equal(fromRow.durationSec, 199);
    assert.equal(rowOf([row], "7"), row);
    assert.equal(rowOf([row], "8"), null);
    assert.equal(rowOf([row], null), null);
});

test("the reference deck is the master clock's playing deck, then the first playing, then the first loaded", () => {
    const decks = [deck("a", { loaded: true }), deck("b", { loaded: true, playing: true }), deck("c", { loaded: true, playing: true }), deck("d")];
    assert.equal(playingDeck(decks, "c"), "c");
    assert.equal(playingDeck(decks, "internal"), "b");
    assert.equal(playingDeck(decks, "a"), "b", "the clock's deck must be playing");
    assert.equal(playingDeck([deck("a", { loaded: true })], null), null);
    assert.equal(referenceDeck([deck("a"), deck("b", { loaded: true })], null), "b");
    assert.equal(referenceDeck([deck("a"), deck("b")], null), null);
    assert.equal(playingDeck([deck("a", { playing: true })], "a"), null, "an empty deck is not playing a track");
});

test("the next track goes to the other main deck", () => {
    assert.equal(otherDeck("a", []), "b");
    assert.equal(otherDeck("b", []), "a");
    assert.equal(otherDeck("c", [deck("a", { playing: true })]), "b");
    assert.equal(otherDeck("d", [deck("a")]), "a");
});

test("candidates carry the minutes since they were played", () => {
    const now = 10 * 60_000;
    const list = candidates([tr(1), tr(2), tr(3)], { "1": now - 5 * 60_000, "3": now + 1000 }, now);
    assert.deepEqual(
        list.map((c) => [c.track.id, c.playedMinutesAgo]),
        [
            ["1", 5],
            ["2", null],
            ["3", null],
        ],
    );
});

test("bars until the planned start follow the playhead", () => {
    // 120 BPM: 2 s per bar.
    assert.equal(barsUntil({ startSec: 100 }, 80, 120), 10);
    assert.equal(barsUntil({ startSec: 100 }, 89, 120), 5.5);
    assert.equal(barsUntil({ startSec: 100 }, 101, 120), 0);
    assert.equal(barsUntil({ startSec: 100 }, 80, 0), 0);
    assert.equal(barsUntil({ startSec: 100 }, Number.NaN, 120), 0);
});

test("the suggestion list fits the popover: two-line rows, then one-line rows, then fewer", () => {
    const tall = 8 * ROW_H + 7 * ROW_GAP;
    const dense = 8 * ROW_H_DENSE + 7 * ROW_GAP;
    assert.deepEqual(fitRows(200 + tall, 200, 8), { rows: 8, dense: false });
    assert.deepEqual(fitRows(200 + tall - 1, 200, 8), { rows: 8, dense: true });
    assert.deepEqual(fitRows(200 + dense, 200, 8), { rows: 8, dense: true });
    assert.deepEqual(fitRows(200 + dense - 1, 200, 8), { rows: 7, dense: true });
    assert.deepEqual(fitRows(200 + 3 * ROW_H_DENSE + 2 * ROW_GAP, 200, 8), { rows: 3, dense: true });
    assert.deepEqual(fitRows(100, 200, 8), { rows: 1, dense: true }, "never fewer than one row");
    assert.deepEqual(fitRows(1000, 200, 0), { rows: 0, dense: false });
    assert.deepEqual(fitRows(200 + ROW_H, 200, 1), { rows: 1, dense: false });
});

test("in touch mode the rows are as high as their 44 px buttons, and the fit counts with that", () => {
    assert.equal(CONTROL_MIN, 24);
    assert.equal(CONTROL_MIN_TOUCH, 44);
    // A row holds its Load buttons: never lower than the control, plus the 12 px reasons line.
    assert.equal(rowHeight(true), 24);
    assert.equal(rowHeight(false), 36);
    assert.equal(rowHeight(true, CONTROL_MIN_TOUCH), 44);
    assert.equal(rowHeight(false, CONTROL_MIN_TOUCH), 44 + ROW_WHY_H);
    assert.equal(rowHeight(true, Number.NaN), 24, "a broken size falls back to the default");
    assert.equal(rowHeight(true, 0), 24);
    // The default argument is the 24 px layout: unchanged results.
    assert.deepEqual(fitRows(200 + 8 * 36 + 7 * 2, 200, 8, CONTROL_MIN), fitRows(200 + 8 * 36 + 7 * 2, 200, 8));

    const T = CONTROL_MIN_TOUCH;
    const tall = 8 * (T + ROW_WHY_H) + 7 * ROW_GAP; // 462
    const dense = 8 * T + 7 * ROW_GAP; // 366
    assert.deepEqual(fitRows(200 + tall, 200, 8, T), { rows: 8, dense: false });
    assert.deepEqual(fitRows(200 + tall - 1, 200, 8, T), { rows: 8, dense: true });
    assert.deepEqual(fitRows(200 + dense, 200, 8, T), { rows: 8, dense: true });
    assert.deepEqual(fitRows(200 + dense - 1, 200, 8, T), { rows: 7, dense: true });
    assert.deepEqual(fitRows(200 + 3 * T + 2 * ROW_GAP, 200, 8, T), { rows: 3, dense: true });
    assert.deepEqual(fitRows(100, 200, 8, T), { rows: 1, dense: true });

    // The bug: room that holds eight 24 px rows holds only four 44 px rows. Counting with 24 px
    // in touch mode put eight rows of 44 px buttons into a box for four (buttons over each other).
    const room = 8 * 24 + 7 * ROW_GAP; // 206
    assert.deepEqual(fitRows(200 + room, 200, 8), { rows: 8, dense: true });
    const touch = fitRows(200 + room, 200, 8, T);
    assert.deepEqual(touch, { rows: 4, dense: true });
    assert.ok(touch.rows * T + (touch.rows - 1) * ROW_GAP <= room, "the rows that are shown fit the room");

    // What the stylesheet variable holds, as getComputedStyle returns it.
    assert.equal(controlMin("44px"), 44);
    assert.equal(controlMin(" 24px "), 24);
    assert.equal(controlMin("44"), 44);
    assert.equal(controlMin(""), 24);
    assert.equal(controlMin(null), 24);
    assert.equal(controlMin("var(--dt-min, 24px)"), 24, "an unresolved value is the default");
    assert.equal(controlMin("12px"), 24, "never below the 24 px minimum target");
});

test("arrow keys walk the suggestion list and stop at its edges", () => {
    // 3 rows, 2 columns (Load A, Load B).
    assert.deepEqual(listMove("ArrowDown", 0, 0, 3), { row: 1, col: 0 });
    assert.deepEqual(listMove("ArrowDown", 2, 1, 3), { row: 2, col: 1 }, "no wrap at the end");
    assert.deepEqual(listMove("ArrowUp", 1, 1, 3), { row: 0, col: 1 });
    assert.deepEqual(listMove("ArrowUp", 0, 0, 3), { row: 0, col: 0 }, "no wrap at the start");
    assert.deepEqual(listMove("ArrowRight", 1, 0, 3), { row: 1, col: 1 });
    assert.deepEqual(listMove("ArrowRight", 1, 1, 3), { row: 1, col: 1 });
    assert.deepEqual(listMove("ArrowLeft", 1, 1, 3), { row: 1, col: 0 });
    assert.deepEqual(listMove("ArrowLeft", 1, 0, 3), { row: 1, col: 0 });
    assert.deepEqual(listMove("Home", 2, 1, 3), { row: 0, col: 1 });
    assert.deepEqual(listMove("End", 0, 0, 3), { row: 2, col: 0 });
    // Every arrow is answered (so every arrow is handled: none falls through to a shortcut).
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
        assert.ok(isArrowKey(key));
        for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) assert.notEqual(listMove(key, r, c, 3), null, `${key} ${r},${c}`);
    }
    // Other keys are not the list's; an empty list answers nothing; a stale position is clamped.
    for (const key of ["Enter", " ", "Tab", "a", "Escape", "PageDown"]) assert.equal(listMove(key, 0, 0, 3), null, key);
    assert.equal(isArrowKey("Home"), false);
    assert.equal(listMove("ArrowDown", 0, 0, 0), null);
    assert.deepEqual(listMove("ArrowDown", 9, 5, 3), { row: 2, col: 1 });
    assert.deepEqual(listMove("ArrowUp", -4, -1, 3), { row: 0, col: 0 });
});

test("an arrow pressed in the popover is kept from the global crossfader shortcuts", () => {
    const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
    const button = { tagName: "BUTTON" };
    // Bare arrows on any control that is not a text field: blocked (they are crossfader keys).
    for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
        assert.equal(keepArrowFromShortcuts(key(k), button), true, k);
        assert.equal(keepArrowFromShortcuts(key(k), { tagName: "DIV" }), true, k);
        assert.equal(keepArrowFromShortcuts(key(k), null), true, k);
    }
    // The text field keeps its caret keys (the global listener skips editable fields itself).
    assert.equal(keepArrowFromShortcuts(key("ArrowLeft"), { tagName: "INPUT" }), false);
    assert.equal(keepArrowFromShortcuts(key("ArrowRight"), { tagName: "TEXTAREA" }), false);
    assert.equal(keepArrowFromShortcuts(key("ArrowDown"), { tagName: "SELECT" }), false);
    assert.equal(keepArrowFromShortcuts(key("ArrowUp"), { tagName: "DIV", isContentEditable: true }), false);
    // Modifier combinations are not shortcuts of the app; other keys are not this guard's.
    assert.equal(keepArrowFromShortcuts(key("ArrowLeft", { altKey: true }), button), false);
    assert.equal(keepArrowFromShortcuts(key("ArrowLeft", { ctrlKey: true }), button), false);
    assert.equal(keepArrowFromShortcuts(key("ArrowLeft", { metaKey: true }), button), false);
    for (const k of ["Enter", " ", "Tab", "Escape", "q", "Home"]) assert.equal(keepArrowFromShortcuts(key(k), button), false, k);
});

test("reasons that say something come before the unknown ones, each group in its own order", () => {
    // The row shows one truncated line: tempo must not be cut behind two "unknown" reasons.
    assert.deepEqual(orderReasons(["key_unknown", "energy_unknown", "tempo_far", "same_artist"]), ["tempo_far", "same_artist", "key_unknown", "energy_unknown"]);
    assert.deepEqual(orderReasons(["key_same", "tempo_close", "energy_up"]), ["key_same", "tempo_close", "energy_up"]);
    assert.deepEqual(orderReasons(["energy_unknown", "key_unknown"]), ["energy_unknown", "key_unknown"]);
    assert.deepEqual(orderReasons([]), []);
    const input = ["key_unknown", "tempo_close"];
    orderReasons(input);
    assert.deepEqual(input, ["key_unknown", "tempo_close"], "the input is not reordered in place");
});

test("shell messages map to catalogue keys", () => {
    assert.equal(errorKey("deck A is not playing"), "copilot.err.notPlaying");
    assert.equal(errorKey("deck B has no track"), "copilot.err.noTrack");
    assert.equal(errorKey("the playing track has no tempo or beatgrid"), "copilot.err.noGrid");
    assert.equal(errorKey("deck A has no tempo"), "copilot.err.noGrid");
    assert.equal(errorKey("the planned start has passed: plan again"), "copilot.err.stale");
    assert.equal(errorKey("the crossfader cuts deck B: centre it first"), "copilot.err.crossfader");
    assert.equal(errorKey("a transition is already running"), "copilot.err.running");
    assert.equal(errorKey("engine not running"), "copilot.err.noEngine");
    assert.equal(errorKey("automation: nothing to play"), "copilot.err.failed");
    assert.equal(errorKey("the transition thread is not running: restart the app"), "copilot.err.noRunner");
    // A run the shell stopped because a deck got another track names that deck.
    assert.equal(trackChangedDeck(["deck A got another track: the transition was stopped"]), "A");
    assert.equal(trackChangedDeck(["an automation value is not finite", "deck b got another track: the transition was stopped"]), "B");
    assert.equal(trackChangedDeck(["the audio engine stopped"]), null);
    assert.equal(trackChangedDeck([]), null);
});

test("a typed transport command picks its deck", () => {
    const decks = [deck("a", { loaded: true, playing: true }), deck("b", { loaded: true })];
    assert.equal(intentDeck("play", null, decks, "a"), "b", "play starts the waiting deck");
    assert.equal(intentDeck("pause", null, decks, "a"), "a");
    assert.equal(intentDeck("loop", "b", decks, "a"), "b", "a named deck wins");
    assert.equal(intentDeck("play", null, [deck("a", { loaded: true, playing: true })], "a"), "a");
    assert.equal(intentDeck("sync", null, [deck("a"), deck("b")], null), null);
});

test("the decks key changes with load, transport, tempo, key and clock source only", () => {
    const keys = { a: "8A", b: null, c: null, d: null };
    const a = deck("a", { loaded: true, trackId: "7", bpm: 128, position: 10 });
    const base = decksKey([a], "a", keys);
    assert.equal(decksKey([{ ...a, position: 55 } as DeckLike], "a", keys), base, "the playhead does not change it");
    assert.notEqual(decksKey([{ ...a, playing: true }], "a", keys), base);
    assert.notEqual(decksKey([{ ...a, tempo: 1.04 }], "a", keys), base);
    assert.notEqual(decksKey([{ ...a, trackId: "8" }], "a", keys), base);
    assert.notEqual(decksKey([a], "internal", keys), base);
    assert.notEqual(decksKey([a], "a", { ...keys, a: "9A" }), base);
});

test("a pitch ride changes the decks key and the ranking question per half BPM, not per 0.1 BPM", () => {
    assert.equal(BPM_STEP, 0.5);
    assert.equal(quantBpm(128.24), 128);
    assert.equal(quantBpm(128.26), 128.5);
    assert.equal(quantBpm(0), 0);
    assert.equal(quantBpm(Number.NaN), 0);
    assert.equal(quantBpm(-3), 0);

    const keys = { a: "8A", b: null, c: null, d: null };
    const a = deck("a", { loaded: true, playing: true, trackId: "7", bpm: 128 });
    const row = tr(7, { bpm: 128, keyCamelot: "8A", energy: 6 });
    // A ride of the pitch fader from 0 % to +1.6 % (128.0 to 130.05 BPM), sampled every 0.01 BPM
    // like the 30 Hz engine snapshots of a slow hand: 206 different tempos.
    const tempos: number[] = [];
    for (let bpm = 128; bpm <= 130.05 + 1e-9; bpm += 0.01) tempos.push(bpm / 128);
    assert.equal(tempos.length, 206);

    const deckKeys = new Set<string>();
    const perTenth = new Set<string>();
    const questions = new Set<string>();
    for (const tempo of tempos) {
        const d = { ...a, tempo };
        deckKeys.add(decksKey([d], "a", keys));
        perTenth.add((d.bpm * tempo).toFixed(1));
        // The question the store sends: the deck's features with its audible tempo on the grid.
        const feat = deckFeat(d, "8A", row);
        questions.add(rankKey({ ...feat, bpm: quantBpm(feat.bpm! * tempo) }, "hold", 1, 1, 8));
    }
    // Before: one key (one ranking of the whole pool) per 0.1 BPM = 21 or 22 over this ride.
    assert.ok(perTenth.size >= 21, `${perTenth.size} tenths in the ride`);
    // Now: 128.0, 128.5, 129.0, 129.5, 130.0 = five.
    assert.equal(deckKeys.size, 5, "decks key: one per half BPM");
    assert.equal(questions.size, 5, "ranking question: one per half BPM");
    assert.ok(perTenth.size / questions.size >= 4, "at least four times fewer rankings");

    // The question does change with everything that changes the answer...
    const feat = deckFeat(a, "8A", row);
    const q = rankKey(feat, "hold", 1, 1, 8);
    assert.notEqual(rankKey(feat, "up", 1, 1, 8), q, "energy direction");
    assert.notEqual(rankKey(feat, "hold", 2, 1, 8), q, "another pool or request");
    assert.notEqual(rankKey(feat, "hold", 1, 2, 8), q, "play history");
    assert.notEqual(rankKey({ ...feat, key: "9A" }, "hold", 1, 1, 8), q, "key of the playing track");
    assert.notEqual(rankKey({ ...feat, id: "8" }, "hold", 1, 1, 8), q, "another track");
    assert.notEqual(rankKey({ ...feat, energy: 7 }, "hold", 1, 1, 8), q, "energy of the playing track");
    assert.notEqual(rankKey({ ...feat, artist: "x" }, "hold", 1, 1, 8), q, "artist (same-artist penalty)");
    assert.notEqual(rankKey({ ...feat, bpm: 128.5 }, "hold", 1, 1, 8), q, "half a BPM");
    // ...and not with what does not.
    assert.equal(rankKey({ ...feat, bpm: 128.2 }, "hold", 1, 1, 8), q, "0.2 BPM is the same question");
    assert.equal(rankKey({ ...feat, title: "renamed", durationSec: 1 }, "hold", 1, 1, 8), q);
});

test("track features are built once per row object", () => {
    const row = tr(21, { title: "Once", bpm: 124, keyCamelot: "4A" });
    const first = trackFeat(row);
    assert.equal(trackFeat(row), first, "same object: nothing is rebuilt on the next ranking");
    assert.deepEqual(trackFeat({ ...row }), first, "another row object with the same data: equal, not shared");
    assert.notEqual(trackFeat({ ...row }), first);
    const list = candidates([row, row], {}, 0);
    assert.equal(list[0]!.track, first);
});
