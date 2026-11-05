// node --experimental-strip-types --test src/screens/player/model.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { endsAt, pickAudio, pickSubtitle, seekStep, spriteGrid, spriteTile, subtitleOrder, tilePosition } from "./model.ts";
import { activeCues, parseVtt } from "./vtt.ts";
import { normLang, readPlayerPrefs } from "./prefs.ts";

test("sprite grid matches the server mapping (ensureSprite)", () => {
    // 2 h film: interval = max(2, ceil(7200/144)) = 50 s, cells = min(144, ceil(7200/50)) = 144.
    assert.deepEqual(spriteGrid(7200), { intervalSec: 50, cells: 144 });
    // 100 s clip: interval 2 s, cells 50.
    assert.deepEqual(spriteGrid(100), { intervalSec: 2, cells: 50 });
    assert.equal(spriteGrid(10), null); // server refuses < 30 s
});

test("sprite tile clamps and maps to percent background positions", () => {
    const g = spriteGrid(7200);
    assert.equal(spriteTile(g, 0), 0);
    assert.equal(spriteTile(g, 125), 2);
    assert.equal(spriteTile(g, 99999), 143);
    assert.equal(tilePosition(0), "0% 0%");
    assert.equal(tilePosition(143), "100% 100%");
    assert.equal(tilePosition(13), `${(1 / 11) * 100}% ${(1 / 11) * 100}%`);
});

test("hold acceleration 10 → 30 → 60 s", () => {
    assert.equal(seekStep(0), 10);
    assert.equal(seekStep(3), 10);
    assert.equal(seekStep(4), 30);
    assert.equal(seekStep(11), 30);
    assert.equal(seekStep(12), 60);
});

const video = {
    audioTracks: [{ index: 1, codec: "truehd", channels: 8, lang: "eng", title: null }, { index: 2, codec: "eac3", channels: 6, lang: "rum", title: null }],
    subtitleTracks: [
        { index: 3, codec: "subrip", lang: "eng", title: null, forced: false },
        { index: 4, codec: "subrip", lang: "ron", title: null, forced: false },
        { index: 5, codec: "subrip", lang: "eng", title: "Forced", forced: true },
    ],
};

test("preferred audio language picks the HLS audio ordinal", () => {
    assert.equal(pickAudio(video, readPlayerPrefs({ prefs: { audioLang: "ro" } })), 1);
    assert.equal(pickAudio(video, readPlayerPrefs({ prefs: { audioLang: "fr" } })), 0);
    assert.equal(pickAudio(video, readPlayerPrefs(null)), 0);
});

test("subtitle pick: language, forced-only, forced default", () => {
    assert.equal(pickSubtitle(video, readPlayerPrefs({ prefs: { subLang: "ro" } }), 0), 1);
    assert.equal(pickSubtitle(video, readPlayerPrefs({ prefs: { subForcedOnly: true } }), 0), 2);
    assert.equal(pickSubtitle(video, readPlayerPrefs(null), 0), 2);
    assert.deepEqual(subtitleOrder(video), [2, 0, 1]);
});

test("prefs: legacy autoplay, invalid enum values fall back", () => {
    assert.equal(readPlayerPrefs({ prefs: { autoplay: false } }).autoplayNext, false);
    assert.equal(readPlayerPrefs({ prefs: { autoplay: false, autoplayNext: true } }).autoplayNext, true);
    assert.equal(readPlayerPrefs({ prefs: { subSize: "huge", subBg: "box" } }).subSize, "medium");
    assert.equal(readPlayerPrefs({ prefs: { subBg: "box" } }).subBg, "box");
    assert.equal(normLang("ron"), "ro");
    assert.equal(normLang("en-US"), "en");
});

test("ends-at clock honours the playback rate", () => {
    const now = new Date(2026, 0, 1, 20, 0, 0).getTime();
    assert.equal(endsAt(3600, 1, now), "21:00");
    assert.equal(endsAt(3600, 2, now), "20:30");
});

test("vtt parse + active cue lookup (absolute times, overlaps, tags)", () => {
    const cues = parseVtt("WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\n<i>Hello</i> &amp; bye\n\n00:00:03.500 --> 00:00:06.000 line:90%\nSecond\n\n01:00:00.000 --> 01:00:02.000\nLate\n");
    assert.equal(cues.length, 3);
    assert.deepEqual(activeCues(cues, 2), ["Hello & bye"]);
    assert.deepEqual(activeCues(cues, 3.7), ["Hello & bye", "Second"]);
    assert.deepEqual(activeCues(cues, 5), ["Second"]);
    assert.deepEqual(activeCues(cues, 3601), ["Late"]);
    assert.deepEqual(activeCues(cues, 10), []);
    assert.deepEqual(activeCues(cues, 0), []);
});

test("vtt: short MM:SS.mmm timestamps (server ffmpeg output)", () => {
    const cues = parseVtt("WEBVTT\n\n04:22.728 --> 04:23.894\nCome on.\n\n59:59.000 --> 60:01.500\nEdge\n");
    assert.equal(cues.length, 2);
    assert.deepEqual(activeCues(cues, 263), ["Come on."]);
    assert.deepEqual(activeCues(cues, 3600.5), ["Edge"]);
});
