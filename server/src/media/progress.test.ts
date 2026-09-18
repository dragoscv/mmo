import { describe, it, expect, beforeEach } from "vitest";
import { openMemoryMediaDb, type MediaDb } from "./db";
import { ProgressStore, isCompleted } from "./progress";

let db: MediaDb;
let now = 1_000;
let store: ProgressStore;

beforeEach(() => { db = openMemoryMediaDb(); now = 1_000; store = new ProgressStore(db, () => now); });

describe("progress", () => {
    it("completed threshold at 90 %", () => {
        expect(isCompleted(89, 100)).toBe(false);
        expect(isCompleted(90, 100)).toBe(true);
        expect(isCompleted(0, 0)).toBe(false);
        expect(isCompleted(1, 100, true)).toBe(true);
    });

    it("upserts by (profile, kind, tmdbId, season, episode) and bumps revision", () => {
        expect(store.getRevision()).toBe(0);
        const a = store.putProgress({ profileId: "p1", kind: "movie", tmdbId: 7, positionSec: 100, durationSec: 1000 });
        expect(a.completed).toBe(false);
        expect(store.getRevision()).toBe(1);
        now = 2_000;
        const b = store.putProgress({ profileId: "p1", kind: "movie", tmdbId: 7, positionSec: 950, durationSec: 1000 });
        expect(b.completed).toBe(true);
        expect(b.updatedAt).toBe(2_000);
        expect(store.getProgress("p1")).toHaveLength(1);
        expect(store.getRevision()).toBe(2);
        // episodes are separate rows
        store.putProgress({ profileId: "p1", kind: "tv", tmdbId: 9, season: 1, episode: 1, positionSec: 10, durationSec: 100 });
        store.putProgress({ profileId: "p1", kind: "tv", tmdbId: 9, season: 1, episode: 2, positionSec: 10, durationSec: 100 });
        expect(store.getProgress("p1", { kind: "tv" })).toHaveLength(2);
        expect(store.getProgress("p2")).toHaveLength(0);
    });

    it("ignores stale writes (older updatedAt) and keeps completed sticky", () => {
        store.putProgress({ profileId: "p", kind: "movie", tmdbId: 1, positionSec: 95, durationSec: 100, updatedAt: 5_000 });
        const stale = store.putProgress({ profileId: "p", kind: "movie", tmdbId: 1, positionSec: 10, durationSec: 100, updatedAt: 4_000 });
        expect(stale.positionSec).toBe(95);
        expect(stale.completed).toBe(true);
        const rewatch = store.putProgress({ profileId: "p", kind: "movie", tmdbId: 1, positionSec: 10, durationSec: 100, updatedAt: 6_000 });
        expect(rewatch.positionSec).toBe(10);
        expect(rewatch.completed).toBe(true);
    });

    it("listContinue returns in-progress titles once, newest first, skipping completed/<2 %", () => {
        store.putProgress({ profileId: "p", kind: "movie", tmdbId: 1, positionSec: 50, durationSec: 100, updatedAt: 10 });
        store.putProgress({ profileId: "p", kind: "movie", tmdbId: 2, positionSec: 99, durationSec: 100, updatedAt: 20 });
        store.putProgress({ profileId: "p", kind: "movie", tmdbId: 3, positionSec: 1, durationSec: 100, updatedAt: 30 });
        store.putProgress({ profileId: "p", kind: "tv", tmdbId: 4, season: 1, episode: 1, positionSec: 50, durationSec: 100, updatedAt: 40 });
        store.putProgress({ profileId: "p", kind: "tv", tmdbId: 4, season: 1, episode: 2, positionSec: 20, durationSec: 100, updatedAt: 50 });
        const c = store.listContinue("p");
        expect(c.map((e) => [e.kind, e.tmdbId, e.episode])).toEqual([["tv", 4, 2], ["movie", 1, 0]]);
    });

    it("records and lists plays", () => {
        store.recordPlay("p", "srv1:track:42", 200, true, 100);
        store.recordPlay("p", "srv1:track:43", 180, false, 200);
        store.recordPlay("other", "x", 1, false, 300);
        const plays = store.listRecentPlays("p", 10);
        expect(plays.map((p) => p.trackKey)).toEqual(["srv1:track:43", "srv1:track:42"]);
        expect(plays[1]!.completed).toBe(true);
        expect(store.getRevision()).toBe(3);
    });
});
