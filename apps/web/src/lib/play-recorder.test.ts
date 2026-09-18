import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The recorder's default dependency is a Server Action that pulls in next-auth;
// tests inject their own recorder, so stub the module.
vi.mock("@/actions/track-plays", () => ({ recordTrackPlay: vi.fn() }));

import { createPlayRecorder, isCompleted } from "./play-recorder";

describe("isCompleted", () => {
    it("is true on natural end regardless of duration", () => {
        expect(isCompleted({ trackId: 1, listenedSec: 3, ended: true })).toBe(true);
    });
    it("is true at ≥90 % and false below", () => {
        expect(isCompleted({ trackId: 1, listenedSec: 180, durationSec: 200 })).toBe(true);
        expect(isCompleted({ trackId: 1, listenedSec: 179, durationSec: 200 })).toBe(false);
    });
    it("is false without a duration", () => {
        expect(isCompleted({ trackId: 1, listenedSec: 500, durationSec: null })).toBe(false);
    });
});

describe("createPlayRecorder", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("flushes an ended event immediately as completed", () => {
        const record = vi.fn().mockResolvedValue({ ok: true });
        const rec = createPlayRecorder(record, 1000);
        rec.push({ trackId: 7, listenedSec: 200, durationSec: 200, ended: true });
        expect(record).toHaveBeenCalledWith({ trackId: 7, durationSec: 200, completed: true, source: "web" });
    });

    it("debounces switches per track and records the last listened time", () => {
        const record = vi.fn().mockResolvedValue({ ok: true });
        const rec = createPlayRecorder(record, 1000);
        rec.push({ trackId: 7, listenedSec: 30, durationSec: 200 });
        rec.push({ trackId: 7, listenedSec: 45, durationSec: 200 });
        rec.push({ trackId: 8, listenedSec: 12, durationSec: 100 });
        expect(record).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1000);
        expect(record).toHaveBeenCalledTimes(2);
        expect(record).toHaveBeenCalledWith({ trackId: 7, durationSec: 45, completed: false, source: "web" });
        expect(record).toHaveBeenCalledWith({ trackId: 8, durationSec: 12, completed: false, source: "web" });
    });

    it("ignores accidental taps under 5 s and swallows rejections", async () => {
        const record = vi.fn().mockRejectedValue(new Error("offline"));
        const rec = createPlayRecorder(record, 10);
        rec.push({ trackId: 1, listenedSec: 2, durationSec: 100 });
        rec.push({ trackId: 2, listenedSec: 20, durationSec: 100 });
        vi.advanceTimersByTime(10);
        expect(record).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ trackId: 2 }));
        await vi.runAllTimersAsync();
    });

    it("dispose cancels pending flushes", () => {
        const record = vi.fn().mockResolvedValue({ ok: true });
        const rec = createPlayRecorder(record, 100);
        rec.push({ trackId: 1, listenedSec: 50, durationSec: 100 });
        rec.dispose();
        vi.advanceTimersByTime(200);
        expect(record).not.toHaveBeenCalled();
    });
});
