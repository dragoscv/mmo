// Run: node --test apps/mixai/src/library/track-view.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LibraryTrack } from "../bridge/types.ts";
import { keyCompatibility, parseCamelot } from "../lib/harmonic.ts";
import {
    DEFAULT_SORT,
    DROP_ORDER,
    bpmDiffPct,
    byScore,
    compactColumns,
    decodeDecks,
    encodeDecks,
    energyCells,
    filterTracks,
    fmtBpm,
    fmtDiff,
    fmtDuration,
    freeDeck,
    fullColumns,
    nextSort,
    parseAdded,
    pluralCategory,
    previewPath,
    rankMatches,
    rowHeightFor,
    sortTracks,
    withinBpmWindow,
} from "./track-view.ts";

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

const ids = (l: readonly { id: number }[]) => l.map((t) => t.id);
/** Same thresholds as `keyMatch` in components/KeyChip.tsx (match or near = compatible). */
const keyOk = (ref: string) => (k: string | null) => {
    const a = parseCamelot(k);
    const b = parseCamelot(ref);
    return a && b ? keyCompatibility(b, a).score >= 0.45 : null;
};

test("nextSort: a new column starts in its natural direction, the same column flips", () => {
    assert.deepEqual(nextSort(DEFAULT_SORT, "title"), { key: "title", dir: "asc" });
    assert.deepEqual(nextSort({ key: "title", dir: "asc" }, "title"), { key: "title", dir: "desc" });
    assert.deepEqual(nextSort(null, "addedAt"), { key: "addedAt", dir: "desc" });
    assert.deepEqual(nextSort(null, "bpm"), { key: "bpm", dir: "asc" });
    assert.deepEqual(nextSort(null, "rating"), { key: "rating", dir: "desc" });
});

test("sortTracks: numbers, text (case-insensitive, filename fallback), unknown values last in both directions", () => {
    const l = [tr(1, { bpm: 140, title: "beta" }), tr(2, { bpm: null, title: "Alpha" }), tr(3, { bpm: 120 }), tr(4, { bpm: 128, title: "  Gamma" })];
    assert.deepEqual(ids(sortTracks(l, { key: "bpm", dir: "asc" })), [3, 4, 1, 2]);
    assert.deepEqual(ids(sortTracks(l, { key: "bpm", dir: "desc" })), [1, 4, 3, 2]);
    // "3.mp3" (no title) sorts by its filename.
    assert.deepEqual(ids(sortTracks(l, { key: "title", dir: "asc" })), [3, 2, 1, 4]);
    assert.deepEqual(ids(sortTracks(l, { key: "title", dir: "desc" })), [4, 1, 2, 3]);
});

test("sortTracks: keys follow the Camelot wheel, not text order; ties keep the id order of the direction", () => {
    const l = [tr(1, { keyCamelot: "10A" }), tr(2, { keyCamelot: "8B" }), tr(3, { keyCamelot: "8A" }), tr(4, { keyCamelot: null }), tr(5, { keyCamelot: "8A" })];
    assert.deepEqual(ids(sortTracks(l, { key: "key", dir: "asc" })), [3, 5, 2, 1, 4]);
    assert.deepEqual(ids(sortTracks(l, { key: "key", dir: "desc" })), [1, 2, 5, 3, 4]);
    const same = [tr(1, { addedAt: "2026-11-07 15:54:28" }), tr(3, { addedAt: "2026-11-07 15:54:28" }), tr(2, { addedAt: "2026-11-08 10:00:00" })];
    assert.deepEqual(ids(sortTracks(same, DEFAULT_SORT)), [2, 3, 1]);
});

test("sortTracks: favourites first when descending", () => {
    const l = [tr(1), tr(2, { isFavorite: true }), tr(3, { isFavorite: false })];
    assert.deepEqual(ids(sortTracks(l, { key: "favorite", dir: "desc" })), [2, 3, 1]);
});

test("tempo window: ±6 % of the deck BPM, half and double time allowed", () => {
    assert.equal(withinBpmWindow(136, 129.2), true); // +5.3 %
    assert.equal(withinBpmWindow(143.55, 129.2), false); // +11.1 %
    assert.equal(withinBpmWindow(70, 140), true);
    assert.equal(withinBpmWindow(null, 128), false);
    assert.equal(withinBpmWindow(128, 0), false);
    assert.ok(Math.abs(bpmDiffPct(136, 129.2)! - -5) < 0.01);
    assert.ok(Math.abs(bpmDiffPct(64, 128)!) < 1e-9);
    assert.equal(bpmDiffPct(null, 128), null);
});

test("rankMatches: compatible key AND tempo window, never the deck's own track, best score first", () => {
    const l = [
        tr(1, { bpm: 128, keyCamelot: "8A" }),
        tr(2, { bpm: 129, keyCamelot: "9A" }),
        tr(3, { bpm: 128, keyCamelot: "2B" }), // key clash
        tr(4, { bpm: 150, keyCamelot: "8A" }), // tempo out
        tr(5, { bpm: 128, keyCamelot: null }), // key unknown
        tr(6, { bpm: 127, keyCamelot: "10A" }), // whole step = near
        tr(7, { bpm: 128, keyCamelot: "8A" }),
    ];
    const r = rankMatches(l, { key: "8A", bpm: 128, trackId: "7" }, keyOk("8A"));
    assert.deepEqual(ids(r.map((x) => x.t)), [1, 2, 6]);
    assert.deepEqual(ids([...r].sort(byScore).map((x) => x.t)), [1, 2, 6]);
    assert.ok(r.every((x) => x.match !== null));
});

test("rankMatches: a criterion the deck cannot provide is skipped; with neither nothing matches", () => {
    const l = [tr(1, { bpm: 128, keyCamelot: "2B" }), tr(2, { bpm: 150, keyCamelot: "8A" })];
    assert.deepEqual(ids(rankMatches(l, { key: null, bpm: 128, trackId: null }, () => null).map((x) => x.t)), [1]);
    assert.deepEqual(ids(rankMatches(l, { key: "8A", bpm: 0, trackId: null }, keyOk("8A")).map((x) => x.t)), [2]);
    assert.deepEqual(rankMatches(l, { key: null, bpm: 0, trackId: null }, () => null), []);
});

test("filterTracks: favourites and not-played combine; no filter returns the same list", () => {
    const l = [tr(1, { isFavorite: true }), tr(2), tr(3, { isFavorite: true })];
    const played = (id: string) => id === "3";
    assert.equal(filterTracks(l, { favorites: false, notPlayed: false }, played), l);
    assert.deepEqual(ids(filterTracks(l, { favorites: true, notPlayed: false }, played)), [1, 3]);
    assert.deepEqual(ids(filterTracks(l, { favorites: false, notPlayed: true }, played)), [1, 2]);
    assert.deepEqual(ids(filterTracks(l, { favorites: true, notPlayed: true }, played)), [1]);
});

test("deck snapshot string: round-trips, current BPM = BPM × tempo, odd track ids survive", () => {
    const decks = [
        { id: "a" as const, loaded: true, playing: true, bpm: 128, tempo: 1.05, trackId: "C:\\music\\a,b|c.mp3" },
        { id: "b" as const, loaded: false, playing: false, bpm: 0, tempo: 1, trackId: "stale" },
    ];
    assert.deepEqual(decodeDecks(encodeDecks(decks)), [
        { id: "a", loaded: true, playing: true, bpm: 134.4, trackId: "C:\\music\\a,b|c.mp3" },
        { id: "b", loaded: false, playing: false, bpm: 0, trackId: null },
    ]);
    // Position / VU changes do not change the string.
    assert.equal(encodeDecks(decks), encodeDecks(decks.map((d) => ({ ...d, position: 12 }))));
    assert.deepEqual(decodeDecks(""), []);
});

test("freeDeck: A unless only A is playing", () => {
    const d = (a: boolean, b: boolean) => [
        { id: "a" as const, playing: a },
        { id: "b" as const, playing: b },
    ];
    assert.equal(freeDeck(d(false, false)), "a");
    assert.equal(freeDeck(d(true, false)), "b");
    assert.equal(freeDeck(d(false, true)), "a");
    assert.equal(freeDeck(d(true, true)), "a");
});

test("row height follows density, booth and touch", () => {
    assert.equal(rowHeightFor({ density: "compact" }), 22);
    assert.equal(rowHeightFor({ density: "comfortable" }), 26);
    assert.equal(rowHeightFor({}), 26);
    assert.equal(rowHeightFor({ density: "compact", booth: "on" }), 28);
    assert.equal(rowHeightFor({ density: "compact", booth: "on", touch: "on" }), 44);
});

test("fullColumns: every column in the default box; narrower boxes drop added, genre, energy, preview, rating in that order", () => {
    const o = { diff: false, btn: 24 };
    assert.deepEqual(fullColumns(1468, o).cols, ["status", "preview", "title", "artist", "bpm", "key", "energy", "time", "genre", "added", "rating", "load"]);
    let prev = fullColumns(1468, o).cols;
    const dropped: string[] = [];
    for (let w = 1468; w >= 496; w -= 4) {
        const cur = fullColumns(w, o).cols;
        for (const c of prev) if (!cur.includes(c)) dropped.push(c);
        prev = cur;
    }
    assert.deepEqual(dropped, [...DROP_ORDER]);
    // Full-tier minimum (520 px panel = 496 px of row content): the essential columns stay.
    assert.deepEqual(fullColumns(496, o).cols, ["status", "title", "artist", "bpm", "key", "time", "load"]);
});

test("fullColumns: fixed columns never exceed the width; the ±% text is given up last", () => {
    for (const diff of [false, true])
        for (let w = 496; w <= 1500; w += 7) {
            const c = fullColumns(w, { diff, btn: 24 });
            const fixed = c.template.split(" ").reduce((s, part) => s + (part.endsWith("px") ? Number.parseFloat(part) : 0), 0);
            assert.ok(fixed + 8 * (c.cols.length - 1) + 150 <= w, `w=${w} diff=${diff}: ${c.template}`);
        }
    assert.equal(fullColumns(1468, { diff: true, btn: 24 }).diff, true);
    assert.equal(fullColumns(496, { diff: true, btn: 24 }).diff, false);
});

test("compactColumns: time only when there is room", () => {
    assert.deepEqual(compactColumns(296, { btn: 24 }).cols, ["status", "title", "bpm", "key", "load"]);
    assert.deepEqual(compactColumns(480, { btn: 24 }).cols, ["status", "title", "bpm", "key", "time", "load"]);
});

test("energyCells: five cells, half steps", () => {
    assert.deepEqual(energyCells(10), [1, 1, 1, 1, 1]);
    assert.deepEqual(energyCells(7), [1, 1, 1, 0.5, 0]);
    assert.deepEqual(energyCells(8), [1, 1, 1, 1, 0]);
    assert.deepEqual(energyCells(1), [0.5, 0, 0, 0, 0]);
    assert.deepEqual(energyCells(0), [0, 0, 0, 0, 0]);
});

test("previewPath: closed mirrored shape, one point pair per bin, silent bins keep a hairline", () => {
    assert.equal(previewPath([]), "");
    const d = previewPath(Uint8Array.from([0, 255, 128]), 32);
    assert.ok(d.startsWith("M0 15.5") && d.endsWith("Z"), d);
    assert.equal(d.split("L").length - 1, 3 * 2 + 3);
    assert.ok(d.includes("L1.5 0") && d.includes("L1.5 32"), d);
});

test("formatters", () => {
    assert.equal(fmtDuration(370), "6:10");
    assert.equal(fmtDuration(null), "");
    assert.equal(fmtBpm(143.5546875), "143.6");
    assert.equal(fmtBpm(null), "–");
    assert.equal(fmtDiff(5.26), "+5.3%");
    assert.equal(fmtDiff(-5), "−5.0%");
    assert.equal(fmtDiff(0.01), "±0.0%");
    assert.equal(parseAdded("2026-11-07 15:54:28")?.toISOString(), "2026-11-07T15:54:28.000Z");
    assert.equal(parseAdded("nope"), null);
    assert.equal(parseAdded(null), null);
});

test("pluralCategory: Romanian uses three forms", () => {
    assert.equal(pluralCategory(1, "ro"), "one");
    assert.equal(pluralCategory(11, "ro"), "few");
    assert.equal(pluralCategory(20, "ro"), "other");
    assert.equal(pluralCategory(1, "en"), "one");
    assert.equal(pluralCategory(11, "en"), "other");
});
