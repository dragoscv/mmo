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
    SHIFT_COL,
    SHIFT_REASON,
    barsUntil,
    candidates,
    controlMin,
    deckFeat,
    decksKey,
    errorKey,
    fitRows,
    intentDeck,
    isArrowKey,
    isPopoutPage,
    keepArrowFromShortcuts,
    listMove,
    listMoveIn,
    orderReasons,
    otherDeck,
    pickNext,
    playingDeck,
    quantBpm,
    rankInGroups,
    rankKey,
    referenceDeck,
    rowHeight,
    rowOf,
    rowOrder,
    rowReasons,
    shiftButtonSoft,
    shiftButtonState,
    shiftsKey,
    soundingFeat,
    trackChangedDeck,
    trackFeat,
    type DeckLike,
    type ShiftButtonState,
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

test("the key-shift button stands before Load A and Load B; arrows walk the row in screen order", () => {
    const A = 0;
    const B = 1;
    assert.equal(SHIFT_COL, 2, "slot numbers of Load A / Load B stay 0 and 1");
    assert.deepEqual(rowOrder(true), [SHIFT_COL, A, B]);
    assert.deepEqual(rowOrder(false), [A, B]);
    // Row 0 and 2 carry a proposal, row 1 does not.
    const shifts = [true, false, true];
    // Left / Right inside a row with the button: shift, A, B, and no further.
    assert.deepEqual(listMoveIn("ArrowRight", 0, SHIFT_COL, shifts), { row: 0, col: A });
    assert.deepEqual(listMoveIn("ArrowRight", 0, A, shifts), { row: 0, col: B });
    assert.deepEqual(listMoveIn("ArrowRight", 0, B, shifts), { row: 0, col: B });
    assert.deepEqual(listMoveIn("ArrowLeft", 0, B, shifts), { row: 0, col: A });
    assert.deepEqual(listMoveIn("ArrowLeft", 0, A, shifts), { row: 0, col: SHIFT_COL });
    assert.deepEqual(listMoveIn("ArrowLeft", 0, SHIFT_COL, shifts), { row: 0, col: SHIFT_COL });
    // A row without the button: Left from Load A stays, the shift slot is never reached.
    assert.deepEqual(listMoveIn("ArrowLeft", 1, A, shifts), { row: 1, col: A });
    assert.deepEqual(listMoveIn("ArrowRight", 1, A, shifts), { row: 1, col: B });
    // Up / Down keep the button; from a shift button to a row without one: that row's Load A.
    assert.deepEqual(listMoveIn("ArrowDown", 0, SHIFT_COL, shifts), { row: 1, col: A });
    assert.deepEqual(listMoveIn("ArrowDown", 1, A, shifts), { row: 2, col: A });
    assert.deepEqual(listMoveIn("ArrowDown", 0, B, shifts), { row: 1, col: B });
    assert.deepEqual(listMoveIn("End", 0, SHIFT_COL, shifts), { row: 2, col: SHIFT_COL });
    assert.deepEqual(listMoveIn("Home", 2, SHIFT_COL, shifts), { row: 0, col: SHIFT_COL });
    assert.deepEqual(listMoveIn("ArrowUp", 2, SHIFT_COL, shifts), { row: 1, col: A });
    assert.deepEqual(listMoveIn("ArrowUp", 0, B, shifts), { row: 0, col: B }, "no wrap");
    assert.deepEqual(listMoveIn("ArrowDown", 2, B, shifts), { row: 2, col: B }, "no wrap");
    // No row has a proposal: exactly the old list (two buttons per row).
    const plain = [false, false, false];
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
        for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) assert.deepEqual(listMoveIn(key, r, c, plain), listMove(key, r, c, 3, 2), `${key} ${r},${c}`);
    }
    // A stale position (the row lost its button, the list got shorter) is put right, never thrown out.
    assert.deepEqual(listMoveIn("ArrowRight", 1, SHIFT_COL, shifts), { row: 1, col: B }, "counts as Load A, then one to the right");
    assert.deepEqual(listMoveIn("ArrowDown", 9, 7, shifts), { row: 2, col: A });
    assert.deepEqual(listMoveIn("ArrowUp", -2, A, shifts), { row: 0, col: A });
    assert.equal(listMoveIn("ArrowDown", 0, 0, []), null);
    for (const key of ["Enter", " ", "Tab", "a", "Escape"]) assert.equal(listMoveIn(key, 0, 0, shifts), null, key);
    // Every arrow is answered on every button (none falls through to a global shortcut).
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
        shifts.forEach((has, r) => {
            for (const c of rowOrder(has)) assert.notEqual(listMoveIn(key, r, c, shifts), null, `${key} ${r},${c}`);
        });
    }
});

test("the key-shift reason is taken out of the list and shown first", () => {
    assert.equal(SHIFT_REASON, "key_shiftable");
    assert.deepEqual(rowReasons(["key_shiftable", "energy_hold", "tempo_close"]), { shift: true, rest: ["energy_hold", "tempo_close"] });
    // Wherever the tag stands, and with the "unknown" reasons still last.
    assert.deepEqual(rowReasons(["energy_unknown", "tempo_close", "key_shiftable"]), { shift: true, rest: ["tempo_close", "energy_unknown"] });
    assert.deepEqual(rowReasons(["key_clash", "energy_hold"]), { shift: false, rest: ["key_clash", "energy_hold"] });
    assert.deepEqual(rowReasons([]), { shift: false, rest: [] });
});

test("F3 'Mix next' picks, by itself, the first row that needs no key shift", () => {
    type Row = { id: string; shift: boolean };
    const row = (id: string, shift = false): Row => ({ id, shift });
    const pick = (rows: Row[], playing = "now") =>
        pickNext(
            rows,
            (r) => r.id === playing,
            (r) => r.shift,
        );
    // The top row carries a proposal (it would be loaded unshifted, as a clash): passed over.
    assert.deepEqual(pick([row("s1", true), row("s2", true), row("fit"), row("boost")]), { row: row("fit"), clash: false });
    // No proposal on top: the top row, as before.
    assert.deepEqual(pick([row("fit"), row("s1", true)]), { row: row("fit"), clash: false });
    // The playing track is never picked, with or without a proposal.
    assert.deepEqual(pick([row("now"), row("s1", true), row("next")]), { row: row("next"), clash: false });
    // Every row carries a proposal: the first one, and the caller is told it clashes as loaded.
    assert.deepEqual(pick([row("s1", true), row("s2", true)]), { row: row("s1", true), clash: true });
    assert.deepEqual(pick([row("now", true), row("s2", true)]), { row: row("s2", true), clash: true }, "still not the playing track");
    // Nothing to pick.
    assert.equal(pick([]), null);
    assert.equal(pick([row("now")]), null);
});

test("F4 groups are ranked one after the other: the second group only gets the rows the first leaves", async () => {
    // A ranking that sorts by score (highest first) and cuts to the limit, as the shell does.
    const calls: { ids: string[]; limit: number }[] = [];
    type Row = { id: string; score: number };
    const rank = (rows: readonly Row[], limit: number): Promise<Row[] | null> => {
        calls.push({ ids: rows.map((r) => r.id), limit });
        return Promise.resolve([...rows].sort((a, b) => b.score - a.score).slice(0, limit));
    };
    const natural: Row[] = [
        { id: "boost", score: 0.59 },
        { id: "fit", score: 0.87 },
        { id: "diagonal", score: 0.55 },
    ];
    const shift: Row[] = [
        { id: "two", score: 0.82 },
        { id: "one", score: 0.88 },
    ];
    // By score alone "one" (0.88) and "two" (0.82) stand above the boost and the diagonal, and
    // "one" above the fit: the fixture can tell the two orders apart.
    const flat = await rank([...natural, ...shift], 8);
    assert.deepEqual(flat!.map((r) => r.id), ["one", "fit", "two", "boost", "diagonal"]);
    calls.length = 0;
    const grouped = await rankInGroups([natural, shift], 8, rank);
    assert.deepEqual(grouped!.map((r) => r.id), ["fit", "boost", "diagonal", "one", "two"], "every row without a proposal first, each group in ranked order");
    assert.deepEqual(calls, [
        { ids: ["boost", "fit", "diagonal"], limit: 8 },
        { ids: ["two", "one"], limit: 5 },
    ]);
    // The list is full of natural rows: the tracks that need a shift are not even ranked.
    calls.length = 0;
    const full = await rankInGroups([natural, shift], 2, rank);
    assert.deepEqual(full!.map((r) => r.id), ["fit", "boost"]);
    assert.equal(calls.length, 1);
    // One row left: the best of the second group.
    assert.deepEqual((await rankInGroups([natural, shift], 4, rank))!.map((r) => r.id), ["fit", "boost", "diagonal", "one"]);
    // An empty first group is not asked; one group is one plain ranking.
    calls.length = 0;
    assert.deepEqual((await rankInGroups([[], shift], 8, rank))!.map((r) => r.id), ["one", "two"]);
    assert.deepEqual(calls, [{ ids: ["two", "one"], limit: 8 }]);
    assert.deepEqual((await rankInGroups([[...natural, ...shift]], 8, rank))!.map((r) => r.id), flat!.map((r) => r.id));
    assert.deepEqual(await rankInGroups([[], []], 8, rank), []);
    // No shell (a ranking answers null): no list, whichever group it was.
    assert.equal(await rankInGroups([natural, shift], 8, () => Promise.resolve(null)), null);
    let n = 0;
    assert.equal(await rankInGroups([natural, shift], 8, (rows, limit) => (++n === 2 ? Promise.resolve(null) : rank(rows, limit))), null);
    // A ranking that returns more than it was asked for cannot overfill the list.
    assert.equal((await rankInGroups([natural, shift], 4, (rows) => Promise.resolve([...rows])))!.length, 4);
});

test("F6 / F7 the key-shift button: what it is in every situation, and none in a pop-out window", () => {
    const base = { popout: false, proposal: true, target: true, onTarget: false, applied: false, busy: false, targetPlaying: false };
    const state = (p: Partial<typeof base>): ShiftButtonState => shiftButtonState({ ...base, ...p });
    assert.equal(state({}), "load");
    assert.equal(state({ onTarget: true }), "shift", "the track is there already: shift only");
    assert.equal(state({ onTarget: true, applied: true }), "done");
    assert.equal(state({ busy: true }), "busy", "its load is in flight");
    // The incoming deck is playing: no load over a deck on air by a button that changes pitch.
    assert.equal(state({ targetPlaying: true }), "playing");
    assert.equal(state({ targetPlaying: true, onTarget: true }), "playing", "nor a pitch change under the audience");
    // Applied and still loading its stems: "done" (the shift is on), not "busy".
    assert.equal(state({ onTarget: true, applied: true, busy: true }), "done");
    // Done stays done while that deck plays (the status line says the shift is on).
    assert.equal(state({ onTarget: true, applied: true, targetPlaying: true }), "done");
    // `applied` without the track on the deck is not "done" (another track holds the record).
    assert.equal(state({ applied: true }), "load");
    // No button at all: no proposal, no incoming deck, or a pop-out window (whatever else holds).
    assert.equal(state({ proposal: false }), "none");
    assert.equal(state({ target: false }), "none");
    for (const p of [{}, { onTarget: true }, { onTarget: true, applied: true }, { busy: true }, { targetPlaying: true }]) {
        assert.equal(state({ ...p, popout: true }), "none", `pop-out: ${JSON.stringify(p)}`);
    }
    // Which states are shown soft-disabled (never natively disabled: the button keeps focus).
    const soft = (["none", "load", "shift", "busy", "done", "playing"] as const).filter(shiftButtonSoft);
    assert.deepEqual(soft, ["busy", "done", "playing"]);
});

test("F6 a pop-out window is a page opened with the popout parameter", () => {
    assert.equal(isPopoutPage("?popout=library"), true);
    assert.equal(isPopoutPage("?x=1&popout=deckA"), true);
    assert.equal(isPopoutPage("popout=library"), true);
    // Any popout parameter counts, also one without a panel: not the main window.
    assert.equal(isPopoutPage("?popout"), true);
    assert.equal(isPopoutPage("?popout="), true);
    // The main window.
    assert.equal(isPopoutPage(""), false);
    assert.equal(isPopoutPage("?"), false);
    assert.equal(isPopoutPage("?panel=library"), false);
    assert.equal(isPopoutPage("?notpopout=1"), false);
    assert.equal(isPopoutPage("?q=popout"), false, "a value, not the parameter");
    assert.equal(isPopoutPage(null), false);
    assert.equal(isPopoutPage(undefined), false);
});

test("the features of a deck carry the key it sounds in", () => {
    const d = deck("a", { trackId: "7", loaded: true, bpm: 128, duration: 200 });
    const row = tr(7, { keyCamelot: "5A", bpm: 128 });
    // No shift: the same object as the plain features would be, key untouched.
    assert.deepEqual(soundingFeat(d, "8A", null, 0), deckFeat(d, "8A", null));
    assert.equal(soundingFeat(d, "8A", null, 0).key, "8A");
    // The deck's whole key shift moves the key: +1 semitone is seven steps round the wheel.
    assert.equal(soundingFeat(d, "8A", null, 1).key, "3A");
    assert.equal(soundingFeat(d, "8A", null, -2).key, "6A");
    assert.equal(soundingFeat(d, "8A", null, 0.6).key, "3A", "a fractional shift counts as the nearest semitone");
    // The key of the library row is the fallback, and it is shifted the same way.
    assert.equal(soundingFeat(d, null, row, 1).key, "12A");
    // Nothing else of the features changes.
    const { key: _k, ...rest } = soundingFeat(d, "8A", row, 1);
    const { key: _p, ...plain } = deckFeat(d, "8A", row);
    assert.deepEqual(rest, plain);
    // Unknown key, unknown shift.
    assert.equal(soundingFeat(d, null, null, 3).key, null);
    assert.equal(soundingFeat(d, "8A", null, null).key, "8A");
    assert.equal(soundingFeat(d, "8A", null, undefined).key, "8A");
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

test("the key-shifts key changes per whole semitone of any deck, like the sounding key", () => {
    const at = (a: number, b = 0) => shiftsKey({ a: { keyShift: a }, b: { keyShift: b }, c: { keyShift: 0 }, d: { keyShift: 0 } });
    const base = at(0);
    assert.equal(base, "0,0,0,0");
    assert.notEqual(at(1), base, "deck A shifted by a semitone");
    assert.notEqual(at(0, -2), base, "deck B shifted");
    assert.notEqual(at(1), at(0, 1), "which deck matters");
    // Inside the same whole semitone nothing changes (soundingKey rounds the same way).
    assert.equal(at(0.4), base);
    assert.equal(at(-0.4), base, "no '-0'");
    assert.equal(at(0.6), at(1));
    for (const shift of [-2, -1.4, -0.6, -0.4, 0, 0.4, 0.6, 1, 1.5, 2]) {
        const moved = soundingFeat(deck("a", { loaded: true, trackId: "7" }), "8A", null, shift).key !== "8A";
        assert.equal(at(shift) !== base, moved, `shift ${shift}: the key changes exactly when the sounding key does`);
    }
    // A missing deck or a broken value counts as no shift.
    assert.equal(shiftsKey({}), base);
    assert.equal(shiftsKey({ a: { keyShift: Number.NaN } }), base);
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
