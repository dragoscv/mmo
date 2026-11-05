import { describe, expect, it } from "vitest";
import type { LiveTvChannel, LiveTvProgramme } from "@/lib/mmo/media-types";
import {
    DAY, FAV_GROUP, HOUR, MIN, aroundIds, canCatchup, canRecord, cellIndexAt, channelByNumber, chunk, dayOffsets, dayStart,
    filterChannels, floorToSlot, fold, gridWidth, guideWindow, layoutRow, neighbourIndex, nowLineX, parseCatchup, progressOf,
    pushDigit, scrollToRow, scrollToX, slotTicks, visibleRange,
} from "./live-logic";

const T0 = Date.UTC(2026, 10, 5, 0, 0, 0); // 2026-11-05 00:00Z
const UTC = 0; // getTimezoneOffset override → UTC
const prog = (start: number, stop: number, title = "p"): LiveTvProgramme => ({ channelId: "c", start, stop, title });
const ch = (id: string, over: Partial<LiveTvChannel> = {}): LiveTvChannel => ({
    id, sourceId: "s", name: id, archiveDays: 0, catchup: false, hidden: false, favourite: false, ...over,
});

describe("time window", () => {
    it("floors to 30-min slots in local time", () => {
        expect(floorToSlot(T0 + 47 * MIN, 30, UTC)).toBe(T0 + 30 * MIN);
        // UTC+05:30 (offset −330): local 00:47 → 00:30 local = 19:00Z previous day
        const t = T0 + 17 * MIN; // 05:47 local
        expect(floorToSlot(t, 30, -330)).toBe(T0); // 05:30 local = 00:00Z
    });

    it("day start honours the zone and offsets", () => {
        expect(dayStart(T0 + 13 * HOUR, 0, UTC)).toBe(T0);
        expect(dayStart(T0 + 13 * HOUR, -1, UTC)).toBe(T0 - DAY);
        // Bucharest winter (UTC+2, offset −120): 23:30Z on 11-04 is 01:30 on 11-05 local
        expect(dayStart(T0 - 30 * MIN, 0, -120)).toBe(T0 - 2 * HOUR);
    });

    it("today's window starts one slot before now, other days cover the full day", () => {
        const now = T0 + 20 * HOUR + 10 * MIN;
        expect(guideWindow(now, 0, UTC)).toEqual({ from: T0 + 19 * HOUR + 30 * MIN, to: T0 + DAY });
        expect(guideWindow(now, -1, UTC)).toEqual({ from: T0 - DAY, to: T0 });
        expect(guideWindow(now, 1, UTC)).toEqual({ from: T0 + DAY, to: T0 + 2 * DAY });
    });

    it("day offsets follow the longest archive (capped at 7)", () => {
        expect(dayOffsets(0)).toEqual([0, 1]);
        expect(dayOffsets(3)).toEqual([-3, -2, -1, 0, 1]);
        expect(dayOffsets(30, 0)).toHaveLength(8);
    });

    it("slot ticks start at the first boundary ≥ from", () => {
        const ticks = slotTicks({ from: T0 + 10 * MIN, to: T0 + 2 * HOUR }, 30, UTC);
        expect(ticks).toEqual([T0 + 30 * MIN, T0 + HOUR, T0 + 90 * MIN]);
    });

    it("now line is null outside the window and proportional inside", () => {
        const w = { from: T0, to: T0 + 2 * HOUR };
        expect(nowLineX(T0 + 30 * MIN, w, 4)).toBe(120);
        expect(nowLineX(T0 - 1, w, 4)).toBeNull();
        expect(nowLineX(T0 + 3 * HOUR, w, 4)).toBeNull();
        expect(gridWidth(w, 4)).toBe(480);
    });

    it("progress clamps to 0..1", () => {
        expect(progressOf(prog(0, 100), 50)).toBe(0.5);
        expect(progressOf(prog(0, 100), -5)).toBe(0);
        expect(progressOf(prog(0, 100), 500)).toBe(1);
        expect(progressOf(null, 5)).toBe(0);
    });
});

describe("EPG row layout", () => {
    const w = { from: T0, to: T0 + 2 * HOUR };

    it("sizes cells by duration and tiles the window with gap cells", () => {
        const cells = layoutRow([prog(T0 + 30 * MIN, T0 + HOUR, "a"), prog(T0 + HOUR, T0 + 3 * HOUR, "b")], w, 4);
        expect(cells.map((c) => [c.prog?.title ?? null, c.left, c.width])).toEqual([
            [null, 0, 120], ["a", 120, 120], ["b", 240, 240],
        ]);
        expect(cells.reduce((s, c) => s + c.width, 0)).toBe(gridWidth(w, 4));
    });

    it("clips programmes that started before the window and trims overlaps", () => {
        const cells = layoutRow([prog(T0 - HOUR, T0 + 45 * MIN, "x"), prog(T0 + 30 * MIN, T0 + HOUR, "y")], w, 2);
        expect(cells[0]).toMatchObject({ left: 0, width: 90 });
        expect(cells[1]).toMatchObject({ start: T0 + 45 * MIN, width: 30 });
        expect(cells.at(-1)?.prog).toBeNull();
    });

    it("an empty row is a single gap cell, cellIndexAt finds the covering cell", () => {
        expect(layoutRow([], w, 4)).toHaveLength(1);
        const cells = layoutRow([prog(T0, T0 + HOUR, "a"), prog(T0 + HOUR, T0 + 2 * HOUR, "b")], w, 4);
        expect(cellIndexAt(cells, T0 + 61 * MIN)).toBe(1);
        expect(cellIndexAt(cells, T0 - 5)).toBe(0);
        expect(cellIndexAt(cells, T0 + 9 * HOUR)).toBe(1);
        expect(cellIndexAt([], T0)).toBe(-1);
    });

    it("catch-up needs an archive covering the start; record needs a future end", () => {
        const now = T0 + 10 * HOUR;
        const c = ch("a", { catchup: true, archiveDays: 1 });
        expect(canCatchup(c, prog(now - HOUR, now), now)).toBe(true);
        expect(canCatchup(c, prog(now - 2 * DAY, now), now)).toBe(false);
        expect(canCatchup(ch("b"), prog(now - HOUR, now), now)).toBe(false);
        expect(canRecord(prog(now - HOUR, now + 1), now)).toBe(true);
        expect(canRecord(prog(now - HOUR, now), now)).toBe(false);
    });
});

describe("virtual rows", () => {
    it("renders only the visible rows plus overscan", () => {
        expect(visibleRange(0, 600, 60, 1000, 2)).toEqual({ start: 0, end: 12 });
        expect(visibleRange(6000, 600, 60, 1000, 2)).toEqual({ start: 98, end: 112 });
        expect(visibleRange(1e9, 600, 60, 400, 2).end).toBe(400);
        expect(visibleRange(0, 600, 60, 0)).toEqual({ start: 0, end: 0 });
    });

    it("scrolls a row into view only when needed", () => {
        expect(scrollToRow(5, 0, 600, 60)).toBe(0);
        expect(scrollToRow(20, 0, 600, 60)).toBe(21 * 60 - 600);
        expect(scrollToRow(2, 600, 600, 60)).toBe(120);
        expect(scrollToX(1000, 200, 0, 800, 200)).toBe(600);
        expect(scrollToX(100, 50, 500, 800, 200)).toBe(100);
    });
});

describe("channel list filter", () => {
    const list = [
        ch("1", { name: "Știri RO", number: "1", group: "News" }),
        ch("2", { name: "Sport 1", number: "12", group: "Sport", favourite: true }),
        ch("3", { name: "Film Now", number: "3", group: "Movies" }),
        ch("4", { name: "Sport 2", number: "4", group: "Sport", favourite: true }),
    ];

    it("folds diacritics and matches name, number prefix and group", () => {
        expect(fold("Știri")).toBe("stiri");
        expect(filterChannels(list, { query: "stiri", group: "", favouritesFirst: false }).map((c) => c.id)).toEqual(["1"]);
        expect(filterChannels(list, { query: "1", group: "", favouritesFirst: false }).map((c) => c.id)).toEqual(["1", "2"]);
    });

    it("filters by group / favourites and puts favourites first stably", () => {
        expect(filterChannels(list, { query: "", group: "Sport", favouritesFirst: false })).toHaveLength(2);
        expect(filterChannels(list, { query: "", group: FAV_GROUP, favouritesFirst: false }).map((c) => c.id)).toEqual(["2", "4"]);
        expect(filterChannels(list, { query: "", group: "", favouritesFirst: true }).map((c) => c.id)).toEqual(["2", "4", "1", "3"]);
    });
});

describe("zapping", () => {
    it("wraps neighbour indexes", () => {
        expect(neighbourIndex(5, 4, 1)).toBe(0);
        expect(neighbourIndex(5, 0, -1)).toBe(4);
        expect(neighbourIndex(1, 0, 1)).toBe(-1);
        expect(neighbourIndex(5, -1, 1)).toBe(-1);
    });

    it("digit buffer keeps the last N digits and commits when full", () => {
        expect(pushDigit("", "1")).toEqual({ buf: "1", commit: false });
        expect(pushDigit("12", "3", 3)).toEqual({ buf: "123", commit: true });
        expect(pushDigit("1234", "5")).toEqual({ buf: "2345", commit: true });
        expect(pushDigit("1", "x")).toEqual({ buf: "1", commit: false });
    });

    it("resolves typed numbers: exact, numeric, then position", () => {
        const list = [ch("a", { number: "07" }), ch("b", { number: "101" }), ch("c")];
        expect(channelByNumber(list, "07")?.id).toBe("a");
        expect(channelByNumber(list, "7")?.id).toBe("a");
        expect(channelByNumber(list, "3")?.id).toBe("c");
        expect(channelByNumber(list, "999")).toBeNull();
        expect(channelByNumber(list, "")).toBeNull();
    });

    it("collects unique ids around an index and chunks", () => {
        const list = ["a", "b", "c"].map((id) => ({ id }));
        expect(aroundIds(list, 0, 2)).toEqual(["b", "c", "a"]);
        expect(aroundIds(list, -1)).toEqual([]);
        expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    it("parses catch-up params", () => {
        expect(parseCatchup("1700000000000", "45")).toEqual({ start: 1700000000000, dur: 45 });
        expect(parseCatchup(null, "45")).toBeNull();
        expect(parseCatchup("abc", "45")).toBeNull();
        expect(parseCatchup("1700000000000", "5000")).toBeNull();
    });
});
