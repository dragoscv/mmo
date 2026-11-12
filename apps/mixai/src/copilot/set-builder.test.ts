// Run: node --test apps/mixai/src/copilot/set-builder.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LibraryTrack } from "../bridge/types.ts";
import { EMPTY_FILTERS, STOP_GRACE_MS, applySetFilters, bareStopMeans, clipText, fold, hasAnyFilter, isBareStop, isCommandText, parseSetRequest, tagTokens, type SetFilters } from "./set-builder.ts";

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

const parsed = (text: string, expect: Partial<SetFilters>) => {
    const f = parseSetRequest(text);
    assert.deepEqual(f, { ...EMPTY_FILTERS, ...expect }, text);
};

test("fold strips Romanian diacritics and case", () => {
    assert.equal(fold("Mai MULTĂ energie, și țesut"), "mai multa energie, si tesut");
    assert.equal(fold("Întreg"), "intreg");
    assert.equal(fold("Şuie ţară"), "suie tara", "cedilla forms");
    assert.equal(fold("１２８ ＢＰＭ"), "128 bpm", "full-width forms");
});

test("English request: decade, genre words, tempo range, key relation", () => {
    parsed("90s hip-hop 95-105 BPM harmonic", {
        yearMin: 1990,
        yearMax: 1999,
        words: ["hip-hop"],
        bpmMin: 95,
        bpmMax: 105,
        keyRelation: "harmonic",
    });
    parsed("same key as deck A", { keyRelation: "same" });
    parsed("relative key, around 128", { keyRelation: "relative", bpmMin: 123, bpmMax: 133 });
    parsed("deep house under 122 bpm with stems", { words: ["deep", "house"], bpmMax: 122, stems: true });
    parsed("techno over 135 bpm not played", { words: ["techno"], bpmMin: 135, fresh: true });
    parsed("favourites from the 2010s", { favorites: true, yearMin: 2010, yearMax: 2019 });
    parsed("track 10 from the 80s", { yearMin: 1980, yearMax: 1989 });
    parsed("128 ± 3 bpm", { bpmMin: 125, bpmMax: 131 });
});

test("Romanian request with and without diacritics", () => {
    parsed("mai multă energie", { energyDirection: "up" });
    parsed("mai multa energie", { energyDirection: "up" });
    parsed("ceva mai lent, aceeași cheie", { energyDirection: "down", keyRelation: "same" });
    parsed("anii 2000 pop românesc între 100 și 110 bpm", { yearMin: 2000, yearMax: 2009, words: ["pop", "romanesc"], bpmMin: 100, bpmMax: 110 });
    parsed("techno peste 130 bpm cu stems", { words: ["techno"], bpmMin: 130, stems: true });
    parsed("piese compatibile cu deck-ul B, neredate", { keyRelation: "harmonic", fresh: true });
    parsed("preferatele mele sub 100 bpm", { favorites: true, bpmMax: 100 });
});

test("plain words stay a text search; empty text is empty", () => {
    parsed("daft punk", { words: ["daft", "punk"] });
    parsed("  ", {});
    parsed("90", { words: [] });
    assert.equal(hasAnyFilter(parseSetRequest("   ")), false);
    assert.equal(hasAnyFilter(parseSetRequest("daft")), true);
    assert.equal(hasAnyFilter(parseSetRequest("mai lent")), true);
    // A tempo alone, 125 bpm: a ±4 % window.
    parsed("125 bpm", { bpmMin: 120, bpmMax: 130 });
    // Numbers outside a tempo range are not tempos.
    parsed("track 7", { words: [] });
    // Phrases match whole words only.
    parsed("speak", { words: ["speak"] });
});

test("tempo keywords need word boundaries: a word that only contains one stays a word", () => {
    // "cover" contains "over", "submarine" contains "sub", "maximal" contains "max" / "maxim".
    parsed("cover 100 bpm", { words: ["cover"], bpmMin: 96, bpmMax: 104 });
    parsed("discover 128 bpm", { words: ["discover"], bpmMin: 123, bpmMax: 133 });
    parsed("submarine 120 bpm", { words: ["submarine"], bpmMin: 115, bpmMax: 125 });
    parsed("maximal 130 bpm", { words: ["maximal"], bpmMin: 125, bpmMax: 135 });
    parsed("minimal 126 bpm", { words: ["minimal"], bpmMin: 121, bpmMax: 131 });
    parsed("roundabout 110 bpm", { words: ["roundabout"], bpmMin: 106, bpmMax: 114 });
    parsed("camp 120 bpm", { words: ["camp"], bpmMin: 115, bpmMax: 125 });
    // The keywords themselves still work, with and without the unit.
    parsed("over 100 bpm", { bpmMin: 100 });
    parsed("covers over 100", { words: ["covers"], bpmMin: 100 });
    parsed("sub 100", { bpmMax: 100 });
    parsed("max 128 bpm", { bpmMax: 128 });
    parsed("min 120", { bpmMin: 120 });
    parsed("up to 128", { bpmMax: 128 });
    parsed("at least 124 bpm", { bpmMin: 124 });
    parsed("from 120 bpm", { bpmMin: 120 });
    // Digits inside a longer number or a word are not a tempo.
    parsed("track1205 bpm", { words: ["track1205"] });
    parsed("1200 bpm", {});
    parsed("mp3 128kbps", { words: ["mp3", "128kbps"] });
    // A range needs both ends in the tempo range; otherwise it is left as text (it may be a title).
    parsed("95-105", { bpmMin: 95, bpmMax: 105 });
    parsed("10-20", { words: ["10-20"] });
    parsed("120-999", { words: ["120-999"] });
    parsed("105-95", { words: ["105-95"] });
    // Full-width digits and letters (an IME left on) read the same.
    parsed("１２８ ｂｐｍ", { bpmMin: 123, bpmMax: 133 });
});

test('"in key" means harmonically compatible; "same key" means the same key', () => {
    parsed("in key", { keyRelation: "harmonic" });
    parsed("techno in key 128 bpm", { words: ["techno"], keyRelation: "harmonic", bpmMin: 123, bpmMax: 133 });
    parsed("same key", { keyRelation: "same" });
    parsed("în aceeași tonalitate", { keyRelation: "same" });
    parsed("aceeași cheie", { keyRelation: "same" });
    parsed("relative key", { keyRelation: "relative" });
    parsed("harmonic", { keyRelation: "harmonic" });
    parsed("piese armonice", { keyRelation: "harmonic" });
    // Both said: the narrower one wins.
    parsed("same key in key", { keyRelation: "same" });
});

test("decades: two decades are years, not a tempo; apostrophes and suffixes", () => {
    parsed("anii 80 si 90", { yearMin: 1980, yearMax: 1999 });
    parsed("anii 80 și 90", { yearMin: 1980, yearMax: 1999 });
    parsed("anii '80 și '90 disco", { yearMin: 1980, yearMax: 1999, words: ["disco"] });
    parsed("80s and 90s", { yearMin: 1980, yearMax: 1999 });
    parsed("the 80s to the 2000s", { yearMin: 1980, yearMax: 2009 });
    parsed("90s - 80s", { yearMin: 1980, yearMax: 1999 });
    parsed("anii '90", { yearMin: 1990, yearMax: 1999 });
    parsed("anii ’90", { yearMin: 1990, yearMax: 1999 });
    parsed("’90s house", { yearMin: 1990, yearMax: 1999, words: ["house"] });
    parsed("90's", { yearMin: 1990, yearMax: 1999 });
    parsed("anii 90-uri", { yearMin: 1990, yearMax: 1999 });
    parsed("anii 2010", { yearMin: 2010, yearMax: 2019 });
    parsed("anii 20", { yearMin: 2020, yearMax: 2029 });
    // Decades and a tempo in one request: each number goes where it belongs.
    parsed("anii 80 si 90 intre 100 si 120 bpm", { yearMin: 1980, yearMax: 1999, bpmMin: 100, bpmMax: 120 });
    parsed("anii 90 si 80 bpm", { yearMin: 1990, yearMax: 1999, bpmMin: 77, bpmMax: 83 });
    parsed("90s 80-90 bpm", { yearMin: 1990, yearMax: 1999, bpmMin: 80, bpmMax: 90 });
    // Bare numbers are a tempo range, never decades; a number with the unit is a tempo.
    parsed("80-90", { bpmMin: 80, bpmMax: 90 });
    parsed("80 si 90", { bpmMin: 80, bpmMax: 90 });
    parsed("the 90 bpm tracks", { bpmMin: 86, bpmMax: 94 });
});

test("Romanian with diacritics, typed as people type it", () => {
    parsed("până la 128", { bpmMax: 128 });
    parsed("până la 128 BPM", { bpmMax: 128 });
    parsed("pana la 128 bpm", { bpmMax: 128 });
    parsed("între 120 și 126 bpm", { bpmMin: 120, bpmMax: 126 });
    parsed("intre 120 si 126 bpm", { bpmMin: 120, bpmMax: 126 });
    parsed("de la 120 la 126 bpm", { bpmMin: 120, bpmMax: 126 });
    parsed("de la 120 bpm", { bpmMin: 120 });
    parsed("cel puțin 124 bpm", { bpmMin: 124 });
    parsed("cel mult 110", { bpmMax: 110 });
    parsed("în jur de 128", { bpmMin: 123, bpmMax: 133 });
    parsed("mai puțină energie, piese neredate", { energyDirection: "down", fresh: true });
    parsed("muzică românească anii '90 până la 128", { words: ["romaneasca"], yearMin: 1990, yearMax: 1999, bpmMax: 128 });
    parsed("ÎNTRE 120 ȘI 126 BPM", { bpmMin: 120, bpmMax: 126 });
    // Cedilla forms (old keyboards) fold like the comma-below ones.
    parsed("între 120 şi 126 bpm", { bpmMin: 120, bpmMax: 126 });
});

test("mixed Romanian and English in one request", () => {
    parsed("techno peste 130 bpm in key", { words: ["techno"], bpmMin: 130, keyRelation: "harmonic" });
    parsed("90s house mai multă energie", { yearMin: 1990, yearMax: 1999, words: ["house"], energyDirection: "up" });
    parsed("hip-hop anii 90 under 100 bpm cu stem-uri", { words: ["hip-hop"], yearMin: 1990, yearMax: 1999, bpmMax: 100, stems: true });
    parsed("piese favorite same key around 124", { favorites: true, keyRelation: "same", bpmMin: 119, bpmMax: 129 });
    parsed("deep house până la 122 bpm not played", { words: ["deep", "house"], bpmMax: 122, fresh: true });
});

test("empty, stop-words only and hostile input give no filter and never throw", () => {
    for (const text of ["", " ", "\t\n", "the", "the and of", "si cu de la", "vreau niște piese", "give me some tracks please", "bpm", "?!;,", "'", "''''", "-", "– –"]) {
        const f = parseSetRequest(text);
        assert.deepEqual(f, { ...EMPTY_FILTERS, words: [] }, JSON.stringify(text));
        assert.equal(hasAnyFilter(f), false, JSON.stringify(text));
    }
    // Long, odd and regex-looking text: an answer, quickly, no exception.
    const odd = ["a".repeat(5000), "9".repeat(400), "[a-z]+ \\d{2,3} $^ .* (((( )", "🎧🎧🎧 128 bpm 🎧", "anii ".repeat(300), "80 si ".repeat(300), "\u0000\u0001 128 bpm", "anii 80 si ".repeat(200)];
    for (const text of odd) {
        const t0 = Date.now();
        const f = parseSetRequest(text);
        assert.ok(Array.isArray(f.words), text.slice(0, 20));
        assert.ok(Date.now() - t0 < 1000, `slow on ${text.slice(0, 20)}`);
    }
    assert.deepEqual(parseSetRequest("🎧🎧🎧 128 bpm 🎧").bpmMin, 123);
});

test("filters apply to the pool with half / double time, relations and words", () => {
    const pool = [
        tr(1, { title: "Hip Hop Hooray", artist: "Naughty", bpm: 99, keyCamelot: "9A", year: 1993, genre: "Hip-Hop", energy: 6 }),
        tr(2, { title: "Fast One", bpm: 200, keyCamelot: "8A", year: 1995, genre: "hip hop", energy: 8 }),
        tr(3, { title: "Half Time", bpm: 50, keyCamelot: "8B", year: 1990, genre: "Hip-Hop", energy: 4 }),
        tr(4, { title: "Clash", bpm: 100, keyCamelot: "2B", year: 1991, genre: "Hip-Hop", energy: 6 }),
        tr(5, { title: "Now Playing", bpm: 100, keyCamelot: "8A", year: 1992, genre: "Hip-Hop", energy: 6 }),
        tr(6, { title: "No Year", bpm: 100, keyCamelot: "8A", year: null, genre: "Hip-Hop", energy: 7 }),
        tr(7, { title: "Stems", bpm: 100, keyCamelot: "8A", year: 1994, genre: "Hip-Hop", energy: 9, stemsStatus: "ready", isFavorite: true }),
    ];
    const ref = { key: "8A", energy: 6, trackId: "5" };
    const never = (_id: string) => false;
    const ids = (f: SetFilters, played: (id: string) => boolean = never) => applySetFilters(pool, f, ref, played).map((t) => t.id);

    const f = parseSetRequest("90s hip-hop 95-105 BPM harmonic");
    assert.deepEqual(ids(f), [1, 2, 3, 7], "double / half time count; the clash and the playing track do not");
    assert.deepEqual(ids({ ...EMPTY_FILTERS, keyRelation: "same" }), [2, 6, 7]);
    assert.deepEqual(ids({ ...EMPTY_FILTERS, keyRelation: "relative" }), [3]);
    assert.deepEqual(ids({ ...EMPTY_FILTERS, energyDirection: "up" }), [2, 6, 7], "1..3 steps up from 6");
    assert.deepEqual(ids({ ...EMPTY_FILTERS, energyDirection: "down" }), [3]);
    assert.deepEqual(ids({ ...EMPTY_FILTERS, stems: true }), [7]);
    assert.deepEqual(ids({ ...EMPTY_FILTERS, favorites: true }), [7]);
    assert.deepEqual(ids({ ...EMPTY_FILTERS, fresh: true }, (id) => id === "1" || id === "2"), [3, 4, 6, 7]);
    assert.deepEqual(ids({ ...EMPTY_FILTERS, words: ["naughty", "hooray"] }), [1], "words match title and artist");
    assert.deepEqual(ids({ ...EMPTY_FILTERS, yearMin: 1990, yearMax: 1991 }), [3, 4]);
    // An open tempo range compares the tempo as written: no half / double time (with one bound
    // every track would pass: 99 doubles to 198, 200 halves to 100).
    assert.deepEqual(ids(parseSetRequest("over 140 bpm")), [2], "only the 200 BPM track");
    assert.deepEqual(ids(parseSetRequest("over 200 bpm")), [2], "the bound itself counts");
    assert.deepEqual(ids(parseSetRequest("over 201 bpm")), []);
    assert.deepEqual(ids(parseSetRequest("sub 60 bpm")), [3], "only the 50 BPM track");
    assert.deepEqual(ids(parseSetRequest("under 100 bpm")), [1, 3, 4, 6, 7]);
    // No reference key: a key relation keeps everything with a key.
    const noRef = applySetFilters(pool, { ...EMPTY_FILTERS, keyRelation: "harmonic" }, { key: null, energy: null, trackId: null }, never);
    assert.equal(noRef.length, 7);
    // No reference energy: "more energy" keeps every analysed track.
    const noEnergy = applySetFilters(pool, { ...EMPTY_FILTERS, energyDirection: "up" }, { key: null, energy: null, trackId: null }, never);
    assert.equal(noEnergy.length, 7);
});

test("text search folds diacritics on both sides (library tags and the request)", () => {
    const pool = [
        tr(1, { title: "Țărăncuța", artist: "Ștefan Hrușcă", genre: "Muzică populară", album: "Colinde și cântece" }),
        tr(2, { title: "Taraneasca", artist: "Stefan Banica", genre: "Pop românesc", album: "Best Of" }),
        tr(3, { title: "Îngerii", artist: "Şuie Paparude", genre: "Electronică", album: "A fost odată" }),
        tr(4, { title: "Señorita", artist: "Björk", genre: "Électro", album: "Über" }),
        tr(5, { filename: "Fără_titlu-ȘȚ.mp3" }),
    ];
    const ids = (text: string) => applySetFilters(pool, parseSetRequest(text), { key: null, energy: null, trackId: null }, () => false).map((t) => t.id);
    // Typed without diacritics: finds the rows tagged with them.
    assert.deepEqual(ids("tarancuta"), [1]);
    assert.deepEqual(ids("stefan"), [1, 2]);
    assert.deepEqual(ids("hrusca colinde"), [1]);
    assert.deepEqual(ids("populara"), [1]);
    assert.deepEqual(ids("ingerii"), [3]);
    assert.deepEqual(ids("suie paparude"), [3], "cedilla Ş folds like Ș");
    assert.deepEqual(ids("electronica"), [3]);
    assert.deepEqual(ids("fara titlu"), [5], "file name, underscore and dash split words");
    // Typed with diacritics: finds the rows tagged without them, and with them.
    assert.deepEqual(ids("Ștefan"), [1, 2]);
    assert.deepEqual(ids("românesc"), [2]);
    assert.deepEqual(ids("Țărăncuța"), [1]);
    assert.deepEqual(ids("ȚĂRĂNEASCĂ"), [2]);
    // Other accents fold too.
    assert.deepEqual(ids("senorita bjork"), [4]);
    assert.deepEqual(ids("electro uber"), [4]);
    // The tag words of a row are read once and folded the same way.
    assert.deepEqual(tagTokens(pool[0]!), ["muzica", "populara", "colinde", "si", "cantece"]);
    assert.equal(tagTokens(pool[0]!), tagTokens(pool[0]!), "cached per row object");
});

test("command text is told apart from a search", () => {
    for (const cmd of ["mix next", "Mix the next track in 16 bars with a bass swap", "fă tranziția în 32 de măsuri cu ecou", "anulează tranziția", "ce urmează", "sync deck a", "loop 8 beats on deck b", "play"]) {
        assert.equal(isCommandText(cmd), true, cmd);
    }
    for (const search of ["daft punk remix", "mix master mike", "90s hip-hop 95-105 BPM harmonic", "mai multă energie techno", "same key as deck A", ""]) {
        assert.equal(isCommandText(search), false, search);
    }
});

test("a request is cut by characters, never through one", () => {
    assert.equal(clipText("abc", 200), "abc");
    assert.equal(clipText("abcdef", 3), "abc");
    // 199 letters + an emoji (two UTF-16 units): a cut at 200 UNITS would leave half of it.
    const text = `${"a".repeat(199)}🎧 and more`;
    // Last UTF-16 unit is the first half of a pair with nothing after it.
    const endsInHalf = (s: string) => s.length > 0 && s.charCodeAt(s.length - 1) >= 0xd800 && s.charCodeAt(s.length - 1) <= 0xdbff;
    assert.equal(endsInHalf(text.slice(0, 200)), true, "String.slice cuts the emoji in half (what the store used to do)");
    assert.throws(() => encodeURIComponent(text.slice(0, 200)), "half an emoji is not valid text");
    const cut = clipText(text, 200);
    assert.equal(cut, `${"a".repeat(199)}🎧`);
    assert.equal([...cut].length, 200);
    assert.equal(endsInHalf(cut), false, "no lone surrogate at the end");
    assert.doesNotThrow(() => encodeURIComponent(cut));
    assert.equal([...clipText("🎧".repeat(500), 200)].length, 200);
    assert.equal(clipText("", 5), "");
    assert.equal(clipText("ab", 0), "");
});

test("a bare stop means the transition, also for a few seconds after it ended", () => {
    for (const text of ["stop", "STOP", " Stop! ", "oprește", "Oprește.", "opreste", "anulează", "cancel", "abort"]) assert.equal(isBareStop(text), true, text);
    for (const text of ["", "stop deck a", "oprește deck b", "pause", "stop the music", "nonstop", "stopwatch", "cancel transition"]) assert.equal(isBareStop(text), false, text);
    const now = 1_000_000;
    assert.equal(bareStopMeans(true, null, now), "cancel");
    assert.equal(bareStopMeans(true, now - 500, now), "cancel", "a new run is already on");
    // Just ended: nothing to cancel, and the deck on air is NOT paused.
    assert.equal(bareStopMeans(false, now, now), "nothing");
    assert.equal(bareStopMeans(false, now - 3000, now), "nothing");
    assert.equal(bareStopMeans(false, now - (STOP_GRACE_MS - 1), now), "nothing");
    // Later (or no transition at all): an ordinary command, "stop" pauses the deck as before.
    assert.equal(bareStopMeans(false, now - STOP_GRACE_MS, now), "command");
    assert.equal(bareStopMeans(false, now - 60_000, now), "command");
    assert.equal(bareStopMeans(false, null, now), "command");
    // A clock that went backwards does not make "stop" silent for ever.
    assert.equal(bareStopMeans(false, now + 5000, now), "command");
    assert.equal(STOP_GRACE_MS, 8000);
});
