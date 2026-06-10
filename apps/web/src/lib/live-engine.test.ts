import { describe, it, expect } from "vitest";
import {
    DEFAULT_PAD_COLORS,
    noteIndexToName,
    formatLiveTime,
    formatRecordTime,
} from "./live-engine";

describe("live-engine helpers", () => {
    describe("DEFAULT_PAD_COLORS", () => {
        it("is exactly 8 distinct hex colors", () => {
            expect(DEFAULT_PAD_COLORS).toHaveLength(8);
            const set = new Set(DEFAULT_PAD_COLORS);
            expect(set.size).toBe(8);
            for (const c of DEFAULT_PAD_COLORS) {
                expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
            }
        });
    });

    describe("noteIndexToName", () => {
        it("maps 0 to C and wraps every 12 semitones", () => {
            expect(noteIndexToName(0)).toBe("C");
            expect(noteIndexToName(12)).toBe("C");
            expect(noteIndexToName(60)).toBe("C"); // MIDI middle C
            expect(noteIndexToName(69)).toBe("A");
        });

        it("handles negative indices via modulo wrap", () => {
            expect(noteIndexToName(-1)).toBe("B");
            expect(noteIndexToName(-12)).toBe("C");
            expect(noteIndexToName(-13)).toBe("B");
        });
    });

    describe("formatLiveTime", () => {
        it("formats seconds as M:SS", () => {
            expect(formatLiveTime(0)).toBe("0:00");
            expect(formatLiveTime(5)).toBe("0:05");
            expect(formatLiveTime(59)).toBe("0:59");
            expect(formatLiveTime(60)).toBe("1:00");
            expect(formatLiveTime(125)).toBe("2:05");
        });

        it("guards against NaN/negative/Infinity", () => {
            expect(formatLiveTime(NaN)).toBe("0:00");
            expect(formatLiveTime(-5)).toBe("0:00");
            expect(formatLiveTime(Infinity)).toBe("0:00");
        });

        it("floors fractional seconds", () => {
            expect(formatLiveTime(59.9)).toBe("0:59");
            expect(formatLiveTime(60.999)).toBe("1:00");
        });
    });

    describe("formatRecordTime", () => {
        it("formats milliseconds < 1h as M:SS", () => {
            expect(formatRecordTime(0)).toBe("0:00");
            expect(formatRecordTime(5000)).toBe("0:05");
            expect(formatRecordTime(125_000)).toBe("2:05");
        });

        it("formats >= 1h as H:MM:SS", () => {
            expect(formatRecordTime(3_600_000)).toBe("1:00:00");
            expect(formatRecordTime(3_725_000)).toBe("1:02:05");
            expect(formatRecordTime(36_000_000)).toBe("10:00:00");
        });
    });
});
