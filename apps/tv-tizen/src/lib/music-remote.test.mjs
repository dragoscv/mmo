import { test } from "node:test";
import assert from "node:assert/strict";
import { hubStatePayload, isMusicPlay, orderTracks, parseMusicPlayArgs, resolvedIndex, trackHubMedia } from "./music-remote.ts";

const card = (id, extra = {}) => ({
    id, title: `T ${id}`, artist: "Artist", album: "Album", albumId: "al1", durationSec: 200, format: "flac",
    hasLyrics: false, hasSyncedLyrics: false, coverArt: id, coverUrlPath: `/rest/getCoverArt.view?id=${id}&size=400`,
    streamUrlPath: `/rest/stream.view?id=${id}`, ...extra,
});

test("play with fileId stays a video play", () => {
    assert.equal(isMusicPlay({ fileId: "f1", trackIds: ["a"] }), false);
    assert.equal(parseMusicPlayArgs({ fileId: "f1", trackIds: ["a"] }), null);
    assert.equal(isMusicPlay({}), false);
});

test("music play args are normalised", () => {
    assert.deepEqual(parseMusicPlayArgs({ trackIds: ["a", "b", "c"], index: 1, positionSec: 12.5, shuffle: true, repeat: "all" }),
        { trackIds: ["a", "b", "c"], index: 1, positionSec: 12.5, shuffle: true, repeat: "all" });
    assert.deepEqual(parseMusicPlayArgs({ trackIds: ["a"], fileId: "" }), { trackIds: ["a"], index: 0, positionSec: 0, shuffle: false });
});

test("bad values are clamped or dropped", () => {
    const p = parseMusicPlayArgs({ trackIds: ["a", 3, "", " b ", null], index: 99, positionSec: -4, shuffle: "yes", repeat: "forever" });
    assert.deepEqual(p, { trackIds: ["a", "b"], index: 1, positionSec: 0, shuffle: false });
    assert.equal(parseMusicPlayArgs({ trackIds: ["a"], index: -3 }).index, 0);
    assert.equal(parseMusicPlayArgs({ trackIds: ["a", "b"], index: "1" }).index, 1);
    assert.equal(parseMusicPlayArgs({ trackIds: [] }), null);
    assert.equal(parseMusicPlayArgs({ trackIds: "a,b" }), null);
});

test("lookup answer is ordered by request and foreign tracks dropped", () => {
    const { tracks, missing } = orderTracks(["b", "a", "x"], [card("a"), card("zzz"), card("b")]);
    assert.deepEqual(tracks.map((t) => t?.id ?? null), ["b", "a", null]);
    assert.deepEqual(missing, ["x"]);
    assert.deepEqual(orderTracks(["a"], null).missing, ["a"]);
});

test("start index follows the requested track through gaps", () => {
    const A = card("a"), C = card("c");
    assert.equal(resolvedIndex([A, null, C], 2), 1);
    assert.equal(resolvedIndex([A, null, C], 1), 1); // requested failed → next playable
    assert.equal(resolvedIndex([A, C, null], 2), 1); // last failed → last playable
    assert.equal(resolvedIndex([null, A], 0), 0);
});

test("track hub media carries trackId + metadata, no fileId", () => {
    assert.deepEqual(trackHubMedia(card("tr_7")), {
        kind: "track", trackId: "tr_7", title: "T tr_7", artist: "Artist", album: "Album",
        coverUrlPath: "/rest/getCoverArt.view?id=tr_7&size=400", durationSec: 200,
    });
    assert.deepEqual(trackHubMedia(card("x", { artist: null, album: null, coverUrlPath: "", durationSec: 0 })), { kind: "track", trackId: "x", title: "T x" });
});

test("state payload: idle, music and video", () => {
    assert.deepEqual(hubStatePayload(null), { type: "state", idle: true });
    const media = trackHubMedia(card("a", { durationSec: 0 }));
    assert.deepEqual(hubStatePayload({ playing: true, positionSec: 3, durationSec: 181, media }), {
        type: "state", playing: true, positionSec: 3, durationSec: 181, media: { ...media, durationSec: 181 },
    });
    assert.deepEqual(hubStatePayload({ playing: false, positionSec: -1, media: { fileId: "f", title: "Movie" } }), {
        type: "state", playing: false, positionSec: 0, media: { fileId: "f", title: "Movie" },
    });
});
