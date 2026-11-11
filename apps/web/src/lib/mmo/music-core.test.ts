import { describe, expect, it } from "vitest";
import type { TrackCard } from "./media-types";
import {
    DEFAULT_PLAYBACK, crossfadeFor, currentLineIndex, cycleRepeat, discGroups, fadeInGain, fadeOutGain, fadeStartSec, fmtClock,
    glideRate, indexAfterMove, indexAfterRemove, isAlbumContinuation, looksLikeLrc, mixPlan, moveItem, nextIndex, normalizePlayback,
    parseLrc, playThresholdSec, prevIndex, rateFor, shuffleKeepFirst, shuffleOrder, trackKeyOf, wholeBarsSec, type MixTrack,
} from "./music-core";

function seq(values: number[]): () => number {
    let i = 0;
    return () => values[i++ % values.length] as number;
}

function track(id: string, disc?: number): TrackCard {
    return {
        id, title: id, albumId: "al", durationSec: 100, format: "flac", hasLyrics: false, hasSyncedLyrics: false,
        coverArt: id, coverUrlPath: "", streamUrlPath: "", disc: disc ?? null,
    };
}

/** Planner input: 200 s track on its own album unless overridden. */
function mt(o: Partial<MixTrack> = {}): MixTrack {
    return { durationSec: 200, albumId: `al_${o.bpm ?? "x"}_${o.track ?? 0}`, ...o };
}

describe("shuffle", () => {
    it("is a permutation and does not mutate the input", () => {
        const input = [1, 2, 3, 4, 5, 6];
        const out = shuffleOrder(input, seq([0.1, 0.9, 0.5, 0.3, 0.7]));
        expect(input).toEqual([1, 2, 3, 4, 5, 6]);
        expect([...out].sort()).toEqual(input);
        expect(out).not.toEqual(input);
    });

    it("keeps the chosen first item at the head", () => {
        const out = shuffleKeepFirst(["a", "b", "c", "d"], 2, seq([0.2, 0.8]));
        expect(out[0]).toBe("c");
        expect([...out].sort()).toEqual(["a", "b", "c", "d"]);
        expect(shuffleKeepFirst([], 0)).toEqual([]);
    });
});

describe("nextIndex", () => {
    it("advances and stops at the end with repeat off", () => {
        expect(nextIndex(0, 3, "off", false)).toBe(1);
        expect(nextIndex(2, 3, "off", true)).toBeNull();
        expect(nextIndex(2, 3, "off", false)).toBeNull();
    });
    it("wraps with repeat all", () => {
        expect(nextIndex(2, 3, "all", true)).toBe(0);
    });
    it("replays the same track only when it ended by itself with repeat one", () => {
        expect(nextIndex(1, 3, "one", true)).toBe(1);
        expect(nextIndex(1, 3, "one", false)).toBe(2);
    });
    it("returns null for an empty queue", () => {
        expect(nextIndex(-1, 0, "all", true)).toBeNull();
    });
});

describe("prevIndex", () => {
    it("restarts after 3 s, else goes back, wrapping only with repeat all", () => {
        expect(prevIndex(2, 5, "off", 10)).toBe("restart");
        expect(prevIndex(2, 5, "off", 1)).toBe(1);
        expect(prevIndex(0, 5, "off", 1)).toBe("restart");
        expect(prevIndex(0, 5, "all", 1)).toBe(4);
    });
});

describe("repeat + queue edits", () => {
    it("cycles off → all → one → off", () => {
        expect(cycleRepeat("off")).toBe("all");
        expect(cycleRepeat("all")).toBe("one");
        expect(cycleRepeat("one")).toBe("off");
    });
    it("moves items and tracks the playing index", () => {
        expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
        expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
        expect(indexAfterMove(1, 1, 3)).toBe(3);
        expect(indexAfterMove(2, 0, 3)).toBe(1);
        expect(indexAfterMove(2, 3, 0)).toBe(3);
        expect(indexAfterMove(2, 3, 4)).toBe(2);
        expect(indexAfterRemove(3, 1)).toBe(2);
        expect(indexAfterRemove(3, 4)).toBe(3);
    });
    it("counts a play after 30 s or half the track", () => {
        expect(playThresholdSec(300)).toBe(30);
        expect(playThresholdSec(40)).toBe(20);
        expect(playThresholdSec(0)).toBe(30);
    });
});

describe("automix planner (WP17-44, same numbers as Android AutomixPlanTest)", () => {
    it("matches the tempo within 6 %, folding half and double tempo", () => {
        expect(rateFor(mt({ bpm: 128 }), mt({ bpm: 124 }))).toBeCloseTo(128 / 124, 9);
        expect(rateFor(mt({ bpm: 128 }), mt({ bpm: 64 }))).toBe(1);
        expect(rateFor(mt({ bpm: 87 }), mt({ bpm: 174 }))).toBe(1);
        expect(rateFor(mt({ bpm: 87 }), mt({ bpm: 170 }))).toBeCloseTo(87 / 85, 9);
        // 128 → 118 would need +8.5 %: no beat match.
        expect(rateFor(mt({ bpm: 128 }), mt({ bpm: 118 }))).toBeNull();
        expect(rateFor(mt({ bpm: 128 }), mt())).toBeNull();
        expect(rateFor(null, mt({ bpm: 128 }))).toBeNull();
    });

    it("ignores a low-confidence or absurd tempo", () => {
        expect(rateFor(mt({ bpm: 128, bpmConfidence: 0.2 }), mt({ bpm: 126 }))).toBeNull();
        expect(rateFor(mt({ bpm: 128, bpmConfidence: 0.9 }), mt({ bpm: 126 }))).toBeCloseTo(128 / 126, 9);
        expect(rateFor(mt({ bpm: 500 }), mt({ bpm: 126 }))).toBeNull();
        expect(rateFor(mt({ bpm: 128 }), mt({ bpm: 30 }))).toBeNull();
    });

    it("beat plan: matched rate, incoming on its first downbeat, fade of whole bars from an outgoing downbeat", () => {
        // 120 BPM → 2 s per bar; downbeats of the outgoing track at 0.5 + 2k s; 200 - 8 = 192 → previous downbeat 190.5.
        const p = mixPlan(mt({ bpm: 120, firstBeatSec: 0.5 }), mt({ durationSec: 180, bpm: 122, firstBeatSec: 0.48 }), 8);
        expect(p.mode).toBe("beat");
        expect(p.rate).toBeCloseTo(120 / 122, 9);
        expect(p.rate).toBeGreaterThan(0.94);
        expect(p.inStartSec).toBe(0.48);
        expect(p.fadeSec).toBe(8);
        expect(p.fadeStartSec).toBe(190.5);
        expect(p.glideSec).toBe(8);
        // The fade ends before the outgoing track does (early handoff).
        expect(p.fadeStartSec + p.fadeSec).toBe(198.5);
    });

    it("beat plan: the fade is cut down to whole bars, never made longer than asked", () => {
        const seven = mixPlan(mt({ bpm: 120, firstBeatSec: 0.5 }), mt({ bpm: 120 }), 7);
        expect([seven.mode, seven.fadeSec, seven.fadeStartSec]).toEqual(["beat", 6, 192.5]);
        // 6 s at 128 BPM (1.875 s per bar) → 3 bars = 5.625 s, starting on the downbeat at 0.1 + 124 bars.
        const dflt = mixPlan(mt({ durationSec: 240, bpm: 128, firstBeatSec: 0.1 }), mt({ bpm: 126 }), 6);
        expect([dflt.fadeSec, dflt.fadeStartSec]).toEqual([5.625, 232.6]);
        // Shorter than one bar → the requested length.
        expect(mixPlan(mt({ bpm: 120 }), mt({ bpm: 120 }), 1.5).fadeSec).toBe(1.5);
        expect(wholeBarsSec(7.9, 120)).toBe(6);
        expect(wholeBarsSec(8, 120)).toBe(8);
        expect(wholeBarsSec(1.5, 120)).toBe(1.5);
    });

    it("beat plan: double tempo is folded and an equal tempo needs no glide", () => {
        const dbl = mixPlan(mt({ bpm: 87, firstBeatSec: 0 }), mt({ bpm: 170, firstBeatSec: 1.2 }), 6);
        expect(dbl.mode).toBe("beat");
        expect(dbl.rate).toBeCloseTo(87 / 85, 9);
        expect(dbl.inStartSec).toBe(1.2);
        expect(dbl.glideSec).toBe(8);
        const half = mixPlan(mt({ bpm: 128 }), mt({ bpm: 64 }), 6);
        expect([half.mode, half.rate, half.glideSec]).toEqual(["beat", 1, 0]);
    });

    it("starts the fade on a downbeat only when the outgoing grid is known", () => {
        expect(fadeStartSec(200, mt({ bpm: 120, firstBeatSec: 0.5 }), 8)).toBe(190.5);
        expect(fadeStartSec(200, mt({ bpm: 120 }), 8)).toBe(192);
        expect(fadeStartSec(200, mt({ firstBeatSec: 0.5 }), 8)).toBe(192);
        // The measured duration of the element wins over the card.
        // 210.4 - 8 = 202.4 → previous downbeat 0.5 + 100 bars = 200.5.
        expect(mixPlan(mt({ bpm: 120, firstBeatSec: 0.5 }), mt({ bpm: 120 }), 8, { durationSec: 210.4 }).fadeStartSec).toBe(200.5);
    });

    it("never skips more than 8 s of lead-in", () => {
        expect(mixPlan(mt({ bpm: 120 }), mt({ bpm: 120, firstBeatSec: 12 }), 6).inStartSec).toBe(0);
        expect(mixPlan(mt({ bpm: 120 }), mt({ bpm: 120, firstBeatSec: 7.5 }), 6).inStartSec).toBe(7.5);
    });

    it("falls back to a plain time-based crossfade without usable tempo data or with automix off", () => {
        const plain = { mode: "plain", rate: 1, inStartSec: 0, fadeStartSec: 194, fadeSec: 6, glideSec: 0 };
        expect(mixPlan(mt({ bpm: 120, firstBeatSec: 0.5 }), mt({ firstBeatSec: 1 }), 6)).toEqual(plain);
        expect(mixPlan(mt(), mt({ bpm: 120 }), 6)).toEqual(plain);
        expect(mixPlan(mt({ bpm: 128 }), mt({ bpm: 118 }), 6)).toEqual(plain);
        expect(mixPlan(mt({ bpm: 120, firstBeatSec: 0.5 }), mt({ bpm: 121, firstBeatSec: 1 }), 6, { automix: false })).toEqual(plain);
    });

    it("caps the fade at a third of either track", () => {
        expect(crossfadeFor(12, 15, mt({ durationSec: 15 }), mt())).toBe(5);
        expect(crossfadeFor(12, 200, mt(), mt({ durationSec: 9 }))).toBe(3);
        const short = mixPlan(mt({ durationSec: 15 }), mt(), 12);
        expect([short.mode, short.fadeSec, short.fadeStartSec]).toEqual(["plain", 5, 10]);
    });

    it("plans no crossfade when it is off, inside an album, or the track is too short", () => {
        const none = { mode: "none", rate: 1, inStartSec: 0, fadeStartSec: 200, fadeSec: 0, glideSec: 0 };
        expect(mixPlan(mt({ bpm: 120 }), mt({ bpm: 120 }), 0)).toEqual(none);
        expect(mixPlan(mt({ bpm: 120 }), null, 6)).toEqual(none);
        const a1: MixTrack = { durationSec: 200, albumId: "al_1", track: 3, disc: 1, bpm: 120 };
        const a2: MixTrack = { durationSec: 200, albumId: "al_1", track: 4, disc: 1, bpm: 120 };
        expect(isAlbumContinuation(a1, a2)).toBe(true);
        expect(isAlbumContinuation(a1, { ...a2, disc: 2, track: 1 })).toBe(true);
        expect(isAlbumContinuation(a2, a1)).toBe(false);
        expect(isAlbumContinuation(a1, { ...a2, albumId: "al_2" })).toBe(false);
        expect(mixPlan(a1, a2, 6)).toEqual(none);
        // Same album out of order (shuffle) does crossfade.
        expect(mixPlan(a2, a1, 6).mode).toBe("beat");
        expect(mixPlan(mt({ durationSec: 2 }), mt(), 6)).toEqual({ ...none, fadeStartSec: 2 });
    });

    it("glides the rate back to native speed and fades with equal power", () => {
        expect(glideRate(0.98, 0, 4)).toBeCloseTo(0.98, 9);
        expect(glideRate(0.98, 2, 4)).toBeCloseTo(0.99, 9);
        expect(glideRate(1.04, 6, 8)).toBeCloseTo(1.01, 9);
        expect(glideRate(0.98, 5, 4)).toBe(1);
        expect(glideRate(0.98, 1, 0)).toBe(1);
        expect([fadeOutGain(0), fadeInGain(0)]).toEqual([1, 0]);
        expect(fadeInGain(1)).toBe(1);
        expect(fadeOutGain(1)).toBeCloseTo(0, 9);
        expect(fadeOutGain(0.5)).toBeCloseTo(Math.SQRT1_2, 9);
        expect(fadeInGain(0.25) ** 2 + fadeOutGain(0.25) ** 2).toBeCloseTo(1, 9);
        expect(fadeInGain(7)).toBe(1);
    });

    it("normalises stored playback settings (crossfade 0..12 whole seconds; default off with automix on, as on Android and iOS)", () => {
        expect(DEFAULT_PLAYBACK).toEqual({ crossfadeSec: 0, automix: true });
        expect(normalizePlayback(null)).toEqual({ crossfadeSec: 0, automix: true });
        expect(normalizePlayback({ crossfadeSec: 20, automix: false })).toEqual({ crossfadeSec: 12, automix: false });
        expect(normalizePlayback({ crossfadeSec: -3 })).toEqual({ crossfadeSec: 0, automix: true });
        expect(normalizePlayback({ crossfadeSec: 3.4, automix: "yes" })).toEqual({ crossfadeSec: 3, automix: true });
        expect(normalizePlayback({ crossfadeSec: "x" })).toEqual({ crossfadeSec: 0, automix: true });
    });
});

describe("LRC", () => {
    const lrc = "[ar:Someone]\n[offset:+500]\n[00:01.00]one\n[00:05.50][00:20.00]chorus\n[00:03.123]  two \nplain line\n[00:10]";

    it("detects LRC text", () => {
        expect(looksLikeLrc(lrc)).toBe(true);
        expect(looksLikeLrc("just words")).toBe(false);
        expect(looksLikeLrc(null)).toBe(false);
    });

    it("parses multi-tag lines, fractions, offset and sorts by time", () => {
        const lines = parseLrc(lrc);
        expect(lines.map((l) => l.text)).toEqual(["one", "two", "chorus", "", "chorus"]);
        expect(lines.map((l) => l.timeMs)).toEqual([500, 2623, 5000, 9500, 19500]);
    });

    it("finds the current line by binary search", () => {
        const lines = parseLrc("[00:01.00]a\n[00:02.00]b\n[00:03.00]c");
        expect(currentLineIndex(lines, 0)).toBe(-1);
        expect(currentLineIndex(lines, 1000)).toBe(0);
        expect(currentLineIndex(lines, 2500)).toBe(1);
        expect(currentLineIndex(lines, 99_000)).toBe(2);
        expect(currentLineIndex([], 5)).toBe(-1);
    });
});

describe("formatting + grouping", () => {
    it("formats clocks", () => {
        expect(fmtClock(0)).toBe("0:00");
        expect(fmtClock(65.9)).toBe("1:05");
        expect(fmtClock(3725)).toBe("1:02:05");
        expect(fmtClock(Number.NaN)).toBe("0:00");
    });
    it("normalises track keys", () => {
        expect(trackKeyOf("tr_12")).toBe("tr_12");
        expect(trackKeyOf("12")).toBe("tr_12");
    });
    it("groups by disc only when several discs exist", () => {
        expect(discGroups([track("a"), track("b")])).toHaveLength(1);
        const g = discGroups([track("a", 1), track("b", 1), track("c", 2)]);
        expect(g.map((x) => [x.disc, x.items.map((i) => i.index)])).toEqual([[1, [0, 1]], [2, [2]]]);
    });
});
