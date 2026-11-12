// Run: cd apps/mixai; node --test src/setlog/export.test.ts
// The `text_tracklist` test of src-tauri/crates/decks-setlog/src/export.rs, READ FROM THAT FILE: the
// fixture (`fn set()`) and the expected string are taken from the Rust source, so a change of the
// crate's format makes this test red instead of leaving two copies that drift apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { label, stamp, tracklistText } from "./export.ts";
import type { Entry } from "./set-logger.ts";

function e(title: string, artist: string, start: number, played: number): Entry {
    return { track: { id: title, title, artist }, deck: "a", startSec: start, playedSec: played };
}

const RUST = readFileSync(new URL("../../src-tauri/crates/decks-setlog/src/export.rs", import.meta.url), "utf8");
/** A Rust string literal body (`\n`, `\"`, `\\` only) as a JS string. */
const unquote = (body: string): string => JSON.parse(`"${body}"`) as string;
const STR = String.raw`"((?:[^"\\]|\\.)*)"`;

/** The entries of the crate's test fixture `fn set()`: title, artist, start, seconds played. */
function rustSet(): Entry[] {
    const body = /fn set\(\) -> Vec<Entry> \{([\s\S]*?)\n {4}\}/.exec(RUST)?.[1] ?? "";
    const row = new RegExp(String.raw`e\(\s*${STR},\s*${STR},\s*(?:None|Some\("[^"]*"\)),\s*([\d.]+),\s*([\d.]+)\s*,?\s*\)`, "g");
    return [...body.matchAll(row)].map((m) => e(unquote(m[1]!), unquote(m[2]!), Number(m[3]), Number(m[4])));
}

/** The string the crate's `text_tracklist` test expects from `text(&set())`. */
function rustExpected(): string {
    const m = new RegExp(String.raw`fn text_tracklist\(\) \{\s*assert_eq!\(\s*text\(&set\(\)\),\s*${STR}`).exec(RUST);
    assert.ok(m, "the crate's text_tracklist test was not found: update this parser");
    return unquote(m[1]!);
}

test("text tracklist is byte-identical to the crate's export::text (fixture and expectation read from export.rs)", () => {
    const set = rustSet();
    assert.equal(set.length, 3, "the crate's fixture has three entries");
    assert.deepEqual(
        set.map((x) => [x.track.title, x.track.artist, x.startSec]),
        [
            ["Strobe", "deadmau5", 0],
            ['Levels, "Radio"', "Avicii", 312.4],
            ["", "", 3712.4],
        ],
    );
    const expected = rustExpected();
    assert.equal(expected.split("\n").length, 4, "three lines and a trailing newline");
    assert.equal(tracklistText(set), expected);
    assert.equal(tracklistText([]), "");
});

test("stamps floor to whole seconds and switch to h:mm:ss at one hour", () => {
    assert.equal(stamp(0), "0:00");
    assert.equal(stamp(59.9), "0:59");
    assert.equal(stamp(60), "1:00");
    assert.equal(stamp(3599), "59:59");
    assert.equal(stamp(3600), "1:00:00");
    assert.equal(stamp(3712.4), "1:01:52");
    assert.equal(stamp(36000), "10:00:00");
    assert.equal(stamp(-5), "0:00");
    assert.equal(stamp(Number.NaN), "0:00");
});

test("labels follow the ID rules of the crate", () => {
    const l = (artist: string, title: string) => label({ track: { id: "x", title, artist } });
    assert.equal(l("", ""), "ID – ID");
    assert.equal(l("  ", " \t"), "ID – ID");
    assert.equal(l("", "Strobe"), "Strobe");
    assert.equal(l("deadmau5", ""), "deadmau5 – ID");
    assert.equal(l(" deadmau5 ", " Strobe "), "deadmau5 – Strobe");
});

test("the entry number has two digits and keeps growing past 99", () => {
    const many = Array.from({ length: 101 }, (_, i) => e(`T${i}`, "A", i * 10, 10));
    const lines = tracklistText(many).split("\n");
    assert.equal(lines[0], "01. [0:00] A – T0");
    assert.equal(lines[9], "10. [1:30] A – T9");
    assert.equal(lines[100], "101. [16:40] A – T100");
    assert.equal(lines.length, 102, "trailing newline after the last entry");
});
