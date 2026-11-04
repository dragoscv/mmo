import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import { openMemoryMediaDb, type MediaDb } from "./db";
import { buildStats, createStatsHandler, longestStreak, type LookupTitle } from "./stats";

const D = (y: number, m: number, d: number, h = 20) => Date.UTC(y, m - 1, d, h);

function prog(db: MediaDb, p: {
    profile?: string; kind: "movie" | "tv"; id: number; season?: number; episode?: number;
    pos: number; dur: number; done?: boolean; at: number;
}) {
    db.prepare(
        `INSERT INTO progress (profile_id, kind, tmdb_id, season, episode, position_sec, duration_sec, completed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.profile ?? "p1", p.kind, p.id, p.season ?? 0, p.episode ?? 0, p.pos, p.dur, p.done ? 1 : 0, p.at);
}
function playAt(db: MediaDb, key: string, at: number, dur = 180, profile = "p1") {
    db.prepare("INSERT INTO track_plays (profile_id, track_key, played_at, duration_sec, completed) VALUES (?, ?, ?, ?, 1)").run(profile, key, at, dur);
}

const titles: Record<string, ReturnType<LookupTitle>> = {
    "movie:1": { title: "Dune", runtime: 150, genres: [{ id: 878, name: "SF" }, { id: 12, name: "Adventure" }] },
    "movie:2": { title: "Short", runtime: 60, genres: [{ id: 35, name: "Comedy" }] },
    "tv:10": { title: "Show", genres: [{ id: 878, name: "SF" }] },
};
const lookup: LookupTitle = (k, id) => titles[`${k}:${id}`] ?? null;

function seeded(): MediaDb {
    const db = openMemoryMediaDb();
    // movie 1 completed, duration known (2 h), Jan 10
    prog(db, { kind: "movie", id: 1, pos: 7000, dur: 7200, done: true, at: D(2026, 1, 10) });
    // movie 2 completed, no duration → runtime 60 min, Jan 11
    prog(db, { kind: "movie", id: 2, pos: 0, dur: 0, done: true, at: D(2026, 1, 11) });
    // tv 10: two episodes, Jan 12 (30 min each, completed) and Mar 1 (half watched)
    prog(db, { kind: "tv", id: 10, season: 1, episode: 1, pos: 1800, dur: 1800, done: true, at: D(2026, 1, 12) });
    prog(db, { kind: "tv", id: 10, season: 1, episode: 2, pos: 900, dur: 1800, at: D(2026, 3, 1) });
    // unknown title in 2025 → excluded by year filter
    prog(db, { kind: "movie", id: 99, pos: 3600, dur: 3600, done: true, at: D(2025, 12, 31) });
    // other profile
    prog(db, { profile: "p2", kind: "movie", id: 1, pos: 7200, dur: 7200, done: true, at: D(2026, 1, 10) });

    playAt(db, "tr_1", D(2026, 2, 1), 3600);
    playAt(db, "tr_1", D(2026, 2, 2), 1800);
    playAt(db, "tr_2", D(2026, 5, 2), 1800);
    playAt(db, "tr_3", D(2025, 5, 2), 1800); // other year
    playAt(db, "tr_9", D(2026, 5, 2), 1800, "p2"); // other profile
    return db;
}

describe("longestStreak", () => {
    it("counts consecutive unique days", () => {
        expect(longestStreak([])).toBe(0);
        expect(longestStreak([5])).toBe(1);
        expect(longestStreak([1, 2, 2, 3, 7, 8, 10])).toBe(3);
        expect(longestStreak([10, 9, 8, 1])).toBe(3);
    });
});

describe("buildStats", () => {
    it("watch totals, byMonth, genres, streak, top titles", () => {
        const s = buildStats(seeded(), "p1", 2026, lookup);
        const w = s.watch;
        // 2 h + 1 h + 0.5 h + 0.25 h
        expect(w.hours).toBe(3.75);
        expect(w).toMatchObject({ titles: 3, movies: 2, episodes: 2, completed: 3, longestStreakDays: 3 });
        expect(w.byMonth).toEqual([3.5, 0, 0.25, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        expect(w.topGenres).toEqual([
            { id: 878, name: "SF", hours: 2.75 },
            { id: 12, name: "Adventure", hours: 2 },
            { id: 35, name: "Comedy", hours: 1 },
        ]);
        expect(w.topTitles.map((t) => [t.title, t.hours])).toEqual([["Dune", 2], ["Short", 1], ["Show", 0.75]]);
    });

    it("listen totals and top tracks for the profile/year only", () => {
        const l = buildStats(seeded(), "p1", 2026, lookup).listen;
        expect(l).toMatchObject({ hours: 2, plays: 3 });
        expect(l.topTracks).toEqual([{ trackKey: "tr_1", plays: 2 }, { trackKey: "tr_2", plays: 1 }]);
        expect(l.byMonth).toEqual([0, 1.5, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0]);
    });

    it("year filter: 2025 sees only the untitled movie and its fallback title", () => {
        const s = buildStats(seeded(), "p1", 2025, lookup);
        expect(s.watch).toMatchObject({ hours: 1, titles: 1, topGenres: [] });
        expect(s.watch.topTitles).toEqual([{ kind: "movie", tmdbId: 99, title: "movie 99", hours: 1 }]);
        expect(s.listen.plays).toBe(1);
    });

    it("empty profile → zeros", () => {
        const s = buildStats(seeded(), "nobody", 2026, lookup);
        expect(s).toEqual({
            year: 2026, profileId: "nobody",
            watch: { hours: 0, titles: 0, movies: 0, episodes: 0, completed: 0, topGenres: [], longestStreakDays: 0, byMonth: new Array(12).fill(0), topTitles: [] },
            listen: { hours: 0, plays: 0, topTracks: [], byMonth: new Array(12).fill(0) },
        });
    });

    it("a throwing lookup does not break stats", () => {
        const s = buildStats(seeded(), "p1", 2026, () => { throw new Error("boom"); });
        expect(s.watch.topGenres).toEqual([]);
        expect(s.watch.hours).toBe(3.75 - 1 + 0); // movie 2 has no duration and no runtime → 0 h
    });
});

describe("GET /media/stats (http)", () => {
    let server: http.Server;
    let base = "";
    beforeAll(async () => {
        const app = express();
        app.get("/media/stats", createStatsHandler({ db: seeded(), lookupTitle: lookup, now: () => D(2026, 11, 4) }));
        server = http.createServer(app);
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}/media/stats`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it("defaults year to now, validates year", async () => {
        const r = await fetch(`${base}?profile=p1`);
        expect(r.status).toBe(200);
        expect(await r.json()).toMatchObject({ year: 2026, profileId: "p1", watch: { hours: 3.75 } });
        expect((await fetch(`${base}?profile=p1&year=abc`)).status).toBe(400);
        expect((await fetch(`${base}?profile=p1&year=2099`)).status).toBe(400);
        expect(await (await fetch(`${base}?profile=p1&year=2025`)).json()).toMatchObject({ year: 2025, watch: { titles: 1 } });
    });
});
