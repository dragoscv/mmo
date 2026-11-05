import { describe, expect, it } from "vitest";
import type { TrackCard } from "./media-types";
import {
    currentLineIndex, cycleRepeat, discGroups, fmtClock, indexAfterMove, indexAfterRemove, looksLikeLrc, moveItem, nextIndex,
    parseLrc, playThresholdSec, prevIndex, shuffleKeepFirst, shuffleOrder, trackKeyOf,
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
