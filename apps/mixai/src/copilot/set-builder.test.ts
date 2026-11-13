// Run: node --test apps/mixai/src/copilot/set-builder.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LibraryTrack } from "../bridge/types.ts";
import { keyCompatibility, parseCamelot } from "../lib/harmonic.ts";
import { keyVerdict } from "./key-shift.ts";
import { EMPTY_FILTERS, STOP_GRACE_MS, applySetFilters, bareStopMeans, clipText, filterSet, fold, hasAnyFilter, isBareStop, isCommandText, parseSetRequest, tagTokens, type SetFilters } from "./set-builder.ts";

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

test("a harmonic request keeps a track that a key shift makes compatible, after the ones that fit", () => {
    // Against 8A, by the co-pilot's one key verdict (the ranking's score): 9A adjacent, 8A same
    // and 9B diagonal pass as they are. 1A (five steps round the wheel, same letter: one
    // semitone away), 5A (three steps) and 3B (five steps, other letter) clash, and a key shift
    // fixes them: 1A +1 = 8A (same), 5A +2 = 7A (adjacent), 3B -1 = 8B (relative). 2B and 12B
    // clash and nothing within two semitones fixes them.
    const pool = [
        tr(1, { title: "Five steps, same letter", keyCamelot: "1A" }),
        tr(2, { title: "Adjacent", keyCamelot: "9A" }),
        tr(3, { title: "Hopeless", keyCamelot: "2B" }),
        tr(4, { title: "Two semitones", keyCamelot: "5A" }),
        tr(5, { title: "Same", keyCamelot: "8A" }),
        tr(6, { title: "Hopeless too", keyCamelot: "12B" }),
        tr(7, { title: "Relative after a shift", keyCamelot: "3B" }),
        tr(8, { title: "No key", keyCamelot: null }),
        tr(9, { title: "Not Camelot", keyCamelot: "Am" }),
        tr(10, { title: "Diagonal", keyCamelot: "9B" }),
    ];
    const never = (_id: string) => false;
    const ids = (f: Partial<SetFilters>, ref: { key: string | null; shiftable?: boolean }) => applySetFilters(pool, { ...EMPTY_FILTERS, ...f }, { energy: null, trackId: null, ...ref }, never).map((t) => t.id);
    const harmonic = { keyRelation: "harmonic" as const };

    // A shell without proposals (the flag left out or false): every clash is out, also the
    // one-semitone pair the Library's own rule calls workable (the ranking tags it key_clash).
    assert.deepEqual(ids(harmonic, { key: "8A" }), [2, 5, 10]);
    assert.deepEqual(ids(harmonic, { key: "8A", shiftable: false }), [2, 5, 10]);
    // With proposals: the shiftable tracks stay, AFTER the ones that fit, each group in pool
    // order; the hopeless clashes and the tracks without a usable key stay out.
    assert.deepEqual(ids(harmonic, { key: "8A", shiftable: true }), [2, 5, 10, 1, 4, 7]);
    // The two groups, as the store ranks them apart.
    const groups = filterSet(pool, { ...EMPTY_FILTERS, ...harmonic }, { key: "8A", energy: null, trackId: null, shiftable: true }, never);
    assert.deepEqual([groups.natural.map((t) => t.id), groups.shift.map((t) => t.id)], [[2, 5, 10], [1, 4, 7]]);
    assert.deepEqual(filterSet(pool, { ...EMPTY_FILTERS, ...harmonic }, { key: "8A", energy: null, trackId: null }, never).shift, [], "no shell proposals: no second group");
    // "Same key" and "relative key" name one key: strict, with or without proposals.
    assert.deepEqual(ids({ keyRelation: "same" }, { key: "8A", shiftable: true }), [5]);
    assert.deepEqual(ids({ keyRelation: "same" }, { key: "8A" }), [5]);
    assert.deepEqual(ids({ keyRelation: "relative" }, { key: "8A", shiftable: true }), []);
    assert.deepEqual(ids({ keyRelation: "relative" }, { key: "8B", shiftable: true }), [5]);
    // No key relation asked: the flag changes nothing, and nothing is reordered.
    assert.deepEqual(ids({}, { key: "8A", shiftable: true }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // The reference is the key the deck SOUNDS in: the same deck shifted +1 (8A sounds 3A)
    // gives another answer. Against 3A: 1A and 5A are two steps away, 2B is the diagonal, 3B the
    // relative key: all pass as they are. 9A is six steps away and one semitone fixes it (+1 =
    // 4A, adjacent); 8A is five steps on the same letter, one semitone below 3A (+1 = 3A, the
    // same key). 12B and 9B have no fix.
    assert.deepEqual(ids(harmonic, { key: "3A" }), [1, 3, 4, 7]);
    assert.deepEqual(ids(harmonic, { key: "3A", shiftable: true }), [1, 3, 4, 7, 2, 5]);

    // The other filters still apply to a shiftable track.
    const fast = [tr(1, { keyCamelot: "5A", bpm: 100 }), tr(2, { keyCamelot: "5A", bpm: 140 }), tr(3, { keyCamelot: "9A", bpm: 100 })];
    const got = applySetFilters(fast, { ...EMPTY_FILTERS, keyRelation: "harmonic", bpmMin: 95, bpmMax: 105 }, { key: "8A", energy: null, trackId: null, shiftable: true }, never);
    assert.deepEqual(
        got.map((t) => t.id),
        [3, 1],
    );
    // The playing track is never listed, shiftable or not.
    const self = applySetFilters([tr(1, { keyCamelot: "5A" })], { ...EMPTY_FILTERS, keyRelation: "harmonic" }, { key: "8A", energy: null, trackId: "1", shiftable: true }, never);
    assert.deepEqual(self, []);
});

test("the 'in key' filter, the row's key chip and the ranking give one verdict (8A against 1A and 3A)", () => {
    const never = (_id: string) => false;
    const harmonic = { ...EMPTY_FILTERS, keyRelation: "harmonic" as const };
    for (const key of ["1A", "3A"]) {
        const pool = [tr(1, { keyCamelot: key }), tr(2, { keyCamelot: "9A" })];
        // The Library's rule would keep it as "workable" (0.6): that is the old behaviour ...
        assert.ok(keyCompatibility(parseCamelot("8A"), parseCamelot(key)).score >= 0.45, `${key}: lib/harmonic keeps it`);
        // ... the co-pilot calls it a clash on the chip ...
        assert.equal(keyVerdict(key, "8A"), "clash", key);
        // ... and the filter agrees: out without a proposal, kept AFTER the natural track with one.
        const without = filterSet(pool, harmonic, { key: "8A", energy: null, trackId: null, shiftable: false }, never);
        assert.deepEqual([without.natural.map((t) => t.id), without.shift.map((t) => t.id)], [[2], []], key);
        const withProposals = filterSet(pool, harmonic, { key: "8A", energy: null, trackId: null, shiftable: true }, never);
        assert.deepEqual([withProposals.natural.map((t) => t.id), withProposals.shift.map((t) => t.id)], [[2], [1]], key);
        assert.deepEqual(
            applySetFilters(pool, harmonic, { key: "8A", energy: null, trackId: null, shiftable: true }, never).map((t) => t.id),
            [2, 1],
            `${key}: listed after the track that fits`,
        );
    }
    // For every pair of keys: "natural" in the filter is exactly "the chip does not say clash".
    const keys: string[] = [];
    for (let n = 1; n <= 12; n++) keys.push(`${n}A`, `${n}B`);
    let clashes = 0;
    for (const ref of keys) {
        for (const key of keys) {
            const g = filterSet([tr(1, { keyCamelot: key })], harmonic, { key: ref, energy: null, trackId: null, shiftable: true }, never);
            const verdict = keyVerdict(key, ref);
            assert.equal(g.natural.length === 1, verdict !== "clash", `${key} against ${ref}: filter ${g.natural.length} / chip ${verdict}`);
            if (verdict === "clash") clashes++;
        }
    }
    // 24 references x (7 same-letter + 9 other-letter clashing keys): of the 12 keys of the
    // same letter 5 do not clash (same, two adjacent, two boost), of the other letter 3
    // (relative, two diagonal).
    assert.equal(clashes, 24 * 16);
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
