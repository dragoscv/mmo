import { describe, expect, it } from "vitest";
import {
    dedupePlays,
    dedupeProgress,
    fraction,
    parseTrackKey,
    resolveProfileId,
    shouldApply,
    syncBodySchema,
    toServerProgress,
} from "./sync-map";

describe("syncBodySchema", () => {
    it("accepts the server push shape and defaults the arrays", () => {
        const r = syncBodySchema.safeParse({ deviceId: "d1", revision: 3 });
        expect(r.success).toBe(true);
        if (r.success) { expect(r.data.progress).toEqual([]); expect(r.data.plays).toEqual([]); }
    });
    it("rejects bad kinds and negative positions", () => {
        expect(syncBodySchema.safeParse({ deviceId: "d", revision: 1, progress: [{ profileId: "default", kind: "book", tmdbId: 1, season: 0, episode: 0, positionSec: 0, durationSec: 1, completed: false, updatedAt: 1 }] }).success).toBe(false);
        expect(syncBodySchema.safeParse({ deviceId: "d", revision: 1, progress: [{ profileId: "default", kind: "movie", tmdbId: 1, season: 0, episode: 0, positionSec: -1, durationSec: 1, completed: false, updatedAt: 1 }] }).success).toBe(false);
    });
});

describe("resolveProfileId", () => {
    it("maps numeric owned ids 1:1 and everything else to the fallback", () => {
        expect(resolveProfileId("7", [7, 9], 7)).toBe(7);
        expect(resolveProfileId("8", [7, 9], 7)).toBe(7);
        expect(resolveProfileId("default", [7, 9], 9)).toBe(9);
        expect(resolveProfileId("default", [], null)).toBeNull();
    });
});

describe("parseTrackKey", () => {
    it("parses companion ids and sha256 keys", () => {
        expect(parseTrackKey("42")).toEqual({ companionTrackId: 42 });
        expect(parseTrackKey(`sha256:${"A".repeat(64)}`)).toEqual({ sha256: "a".repeat(64) });
        expect(parseTrackKey("path:/x.mp3")).toBeNull();
        expect(parseTrackKey("0")).toBeNull();
    });
});

describe("fraction / shouldApply", () => {
    it("clamps and guards zero duration", () => {
        expect(fraction(30, 0)).toBe(0);
        expect(fraction(30, 60)).toBe(0.5);
        expect(fraction(90, 60)).toBe(1);
    });
    it("is last-writer-wins", () => {
        expect(shouldApply(2000, null)).toBe(true);
        expect(shouldApply(2000, new Date(1000))).toBe(true);
        expect(shouldApply(1000, new Date(2000))).toBe(false);
        expect(shouldApply(1000, new Date(1000))).toBe(false);
    });
});

describe("dedupe", () => {
    const base = { profileId: "default", kind: "movie" as const, tmdbId: 550, season: 0, episode: 0, positionSec: 1, durationSec: 100, completed: false };
    it("keeps the newest progress per key", () => {
        const out = dedupeProgress([{ ...base, updatedAt: 1 }, { ...base, updatedAt: 5, positionSec: 50 }, { ...base, tmdbId: 551, updatedAt: 2 }]);
        expect(out).toHaveLength(2);
        expect(out.find((e) => e.tmdbId === 550)?.positionSec).toBe(50);
    });
    it("drops repeated plays", () => {
        const p = { profileId: "default", trackKey: "1", playedAt: 10, durationSec: 0, completed: false };
        expect(dedupePlays([p, { ...p }, { ...p, playedAt: 11 }])).toHaveLength(2);
    });
});

describe("toServerProgress", () => {
    it("skips rows without a TMDB id and maps episode → tv", () => {
        const out = toServerProgress([
            { kind: "movie", tmdbId: null, season: null, episode: null, positionSec: 1, durationSec: 2, completed: false, watchedAt: new Date(5), profileId: 1 },
            { kind: "episode", tmdbId: 1399, season: 1, episode: 2, positionSec: 10, durationSec: 60, completed: true, watchedAt: new Date(7), profileId: 1 },
        ]);
        expect(out).toEqual([{ profileId: "1", kind: "tv", tmdbId: 1399, season: 1, episode: 2, positionSec: 10, durationSec: 60, completed: true, updatedAt: 7 }]);
    });
});
