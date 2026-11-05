import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMemoryMediaDb, type MediaDb } from "./db";
import { TmdbClient, type FetchLike } from "./tmdb";
import { ProviderRegistry } from "./providers";
import { AvailabilityResolver } from "./availability";
import { ProgressStore } from "./progress";
import { ProfileStore } from "./profiles";
import { WatchlistStore } from "./watchlist";
import { LibraryIndex } from "./library";
import { createMediaRouter } from "./routes";
import { BookmarkStore, titleKeyOf } from "./bookmarks";
import { SubtitleIndex, decodeSubtitleBytes, findSidecars, parseSubtitles, parseTimestamp, toMatchQuery } from "./subtitles";
import { capStatus, dailyCapOf, lastDays, localDay, watchAdvance, weeklyUsage } from "./usage";
import { importFromPlex, plexGuids, PlexImportError, type PlexFetch } from "./plex-import";
import { PushRelay, type RelayFetch } from "./push-relay";
import { foldText } from "../lib/fold";
import { playbackGate, setPlaybackGate } from "./playback-gate";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function seedTitle(db: MediaDb, kind: "movie" | "tv", tmdbId: number, title: string, age: number | null, genreIds: number[] = []) {
    db.prepare("INSERT INTO titles (kind, tmdb_id, json, fetched_at) VALUES (?, ?, ?, ?)")
        .run(kind, tmdbId, JSON.stringify({ kind, tmdbId, title, age, genreIds, posterPath: null, backdropPath: null }), Date.now());
}

const SRT_RO = [
    "1", "00:00:01,000 --> 00:00:03,500", "<i>Bună dimineața,</i> Ștefan!", "",
    "2", "00:01:02,250 --> 00:01:04,000", "Inima mea ţine la tine.", "",
    "3", "01:00:00,000 --> 01:00:02,000", "{\\an8}Sfârșit", "",
].join("\r\n");

const VTT_EN = ["WEBVTT", "", "00:05.000 --> 00:07.000", "Winter is coming", "", "note", "00:01:10.000 --> 00:01:12.000 align:start", "The <c.yellow>night</c> is dark", ""].join("\n");

describe("subtitle parsing + folding", () => {
    it("parses SRT and short-stamp WebVTT, strips markup", () => {
        expect(parseTimestamp("01:02:03,456")).toBeCloseTo(3723.456);
        expect(parseTimestamp("02:03.5")).toBeCloseTo(123.5);
        expect(Number.isNaN(parseTimestamp("x"))).toBe(true);
        const ro = parseSubtitles(SRT_RO);
        expect(ro).toHaveLength(3);
        expect(ro[0]).toEqual({ startSec: 1, endSec: 3.5, text: "Bună dimineața, Ștefan!" });
        expect(ro[2]!.text).toBe("Sfârșit");
        const en = parseSubtitles(VTT_EN);
        expect(en.map((c) => c.text)).toEqual(["Winter is coming", "The night is dark"]);
        expect(en[1]!.startSec).toBe(70);
    });
    it("folds Romanian diacritics (comma and cedilla forms)", () => {
        expect(foldText("Ştefan ȘTEFAN ţară Țară înăuntru Âmbră")).toBe("stefan stefan tara tara inauntru ambra");
        expect(toMatchQuery("inimă, ține!")).toBe('"inima"* "tine"*');
        expect(toMatchQuery("  !! ")).toBeNull();
    });
    it("decodes Windows-1250 Romanian sidecars", () => {
        const buf = Buffer.from([0x53, 0x66, 0xe2, 0x72, 0xba, 0x69, 0x74]); // "Sfârşit" in cp1250 (º = ş)
        expect(decodeSubtitleBytes(buf)).toBe("Sfârşit");
        expect(decodeSubtitleBytes(Buffer.from("Ștefan", "utf8"))).toBe("Ștefan");
    });
});

describe("SubtitleIndex (FTS5)", () => {
    it("indexes sidecars, searches accent-insensitively, skips unchanged files, scopes by fileId", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mixai-subs-"));
        try {
            const video = path.join(dir, "Film.2020.mkv");
            fs.writeFileSync(video, "x");
            fs.writeFileSync(path.join(dir, "Film.2020.ro.srt"), SRT_RO);
            fs.writeFileSync(path.join(dir, "Film.2020.en.vtt"), VTT_EN);
            fs.writeFileSync(path.join(dir, "Other.srt"), SRT_RO);
            expect(findSidecars(video).map((s) => [path.basename(s.path), s.lang])).toEqual([["Film.2020.en.vtt", "en"], ["Film.2020.ro.srt", "ro"]]);

            const db = openMemoryMediaDb();
            const idx = new SubtitleIndex(db);
            expect(idx.indexSidecars("f1", video)).toBe(5);
            expect(idx.indexSidecars("f1", video)).toBe(0); // unchanged
            idx.indexTrack("f2", { key: "emb:0", index: 0, source: "embedded", lang: "en", label: null, sig: "s" }, [{ startSec: 9, endSec: 10, text: "Inima e bună" }]);
            const titleOf = (id: string) => ({ kind: "movie", tmdbId: id === "f1" ? 11 : 12, season: null, episode: null, title: id });

            const hits = idx.search("inimă", { titleOf });
            expect(hits.map((h) => h.fileId).sort()).toEqual(["f1", "f2"]);
            const one = idx.search("INIMA tine", { fileId: "f1", titleOf });
            expect(one).toHaveLength(1);
            expect(one[0]).toMatchObject({ fileId: "f1", tmdbId: 11, source: "external", lang: "ro", startSec: 62.25, endSec: 64, text: "Inima mea ţine la tine.", trackIndex: null });
            expect(idx.search("stef", { titleOf })[0]!.text).toBe("Bună dimineața, Ștefan!"); // prefix match
            expect(idx.search("night", { fileId: "f2", titleOf })).toEqual([]);
            const emb = idx.search("buna", { fileId: "f2", titleOf })[0]!;
            expect(emb).toMatchObject({ source: "embedded", trackIndex: 0 });
            expect(idx.sources("f1").map((s) => s.trackKey)).toEqual(["ext:Film.2020.en.vtt", "ext:Film.2020.ro.srt"]);

            for (let i = 0; i < 80; i++) idx.indexTrack(`bulk${i}`, { key: "ext:x", index: null, source: "external", lang: null, label: null, sig: "1" }, [{ startSec: i, endSec: i + 1, text: "repeat word" }]);
            expect(idx.search("repeat", { titleOf })).toHaveLength(50);
            idx.removeFile("f1");
            expect(idx.search("winter", { titleOf })).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("usage + caps", () => {
    it("counts only real watching between writes (no seeks/resumes)", () => {
        expect(watchAdvance(null, { positionSec: 30, updatedAt: 0 })).toBe(30);
        expect(watchAdvance(null, { positionSec: 3000, updatedAt: 0 })).toBe(300);
        expect(watchAdvance({ positionSec: 100, updatedAt: 0 }, { positionSec: 160, updatedAt: 60_000 })).toBe(60);
        expect(watchAdvance({ positionSec: 100, updatedAt: 0 }, { positionSec: 2000, updatedAt: 10_000 })).toBe(0); // seek
        expect(watchAdvance({ positionSec: 100, updatedAt: 0 }, { positionSec: 50, updatedAt: 60_000 })).toBe(0);
        expect(dailyCapOf({ dailyCapMin: 90 })).toBe(90);
        expect(dailyCapOf({ dailyCapMin: "45" })).toBe(45);
        expect(dailyCapOf({ dailyCapMin: 0 })).toBeNull();
        expect(lastDays(new Date(2026, 10, 5, 10).getTime(), 3)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05"]);
    });

    it("ProgressStore records daily usage; kid over cap → overCap; adults never enforced; sync replays ignored", () => {
        let t = new Date(2026, 10, 5, 18, 0, 0).getTime();
        const db = openMemoryMediaDb();
        const progress = new ProgressStore(db, () => t);
        const profiles = new ProfileStore(db, () => t);
        const kid = profiles.create({ name: "Ana", kind: "kid", prefs: { dailyCapMin: 2 } });
        progress.putProgress({ profileId: kid.id, kind: "movie", tmdbId: 1, positionSec: 30, durationSec: 5000 });
        t += 60_000;
        progress.putProgress({ profileId: kid.id, kind: "movie", tmdbId: 1, positionSec: 90, durationSec: 5000 });
        expect(capStatus(db, profiles.get(kid.id), kid.id, t)).toMatchObject({ watchMin: 1, dailyCapMin: 2, overCap: false, enforced: true, remainingMin: 1 });
        t += 60_000;
        progress.putProgress({ profileId: kid.id, kind: "movie", tmdbId: 1, positionSec: 150, durationSec: 5000 });
        expect(capStatus(db, profiles.get(kid.id), kid.id, t)).toMatchObject({ watchMin: 2, overCap: true, remainingMin: 0 });
        // replayed batch with explicit updatedAt does not count
        progress.putProgress({ profileId: kid.id, kind: "movie", tmdbId: 2, positionSec: 4000, durationSec: 5000, updatedAt: t });
        expect(capStatus(db, profiles.get(kid.id), kid.id, t).watchMin).toBe(2);
        progress.recordPlay(kid.id, "42", 180, true);
        expect(capStatus(db, profiles.get(kid.id), kid.id, t).listenMin).toBe(3);
        const adult = capStatus(db, profiles.get("default"), "default", t);
        expect(adult).toMatchObject({ enforced: false, overCap: false, dailyCapMin: null });
        const w = weeklyUsage(db, kid.id, t);
        expect(w.days.at(-1)).toBe(localDay(t));
        expect(w.watchMin.at(-1)).toBe(3);
        expect(w.totalListenMin).toBe(3);
    });

    it("playback gate answers 403 daily_cap for a kid over cap only", async () => {
        const db = openMemoryMediaDb();
        const profiles = new ProfileStore(db);
        const kid = profiles.create({ name: "K", kind: "kid", prefs: { dailyCapMin: 1 } });
        db.prepare("INSERT INTO usage_daily (profile_id, day, watch_sec, listen_sec) VALUES (?, ?, 120, 0)").run(kid.id, localDay(Date.now()));
        setPlaybackGate((id) => capStatus(db, profiles.get(id), id, Date.now()), (tok) => profiles.verifyToken(tok));
        const app = express();
        app.get("/x/:id", playbackGate, (_req, res) => { res.json({ ok: true }); });
        const server = http.createServer(app);
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        try {
            const r = await fetch(`${base}/x/1?profile=${kid.id}`);
            expect(r.status).toBe(403);
            expect(await r.json()).toMatchObject({ error: "daily_cap", profileId: kid.id, dailyCapMin: 1, watchMin: 2 });
            const tok = profiles.unlock(kid.id, undefined);
            expect(tok.ok).toBe(true);
            expect((await fetch(`${base}/x/1`, { headers: { "x-profile-token": tok.ok ? tok.token : "" } })).status).toBe(403);
            expect((await fetch(`${base}/x/1?profile=default`)).status).toBe(200);
            expect((await fetch(`${base}/x/1`)).status).toBe(200);
        } finally {
            setPlaybackGate(null);
            await new Promise<void>((r) => server.close(() => r()));
        }
    });
});

describe("bookmarks store", () => {
    it("title keys", () => {
        expect(titleKeyOf({ kind: "movie", tmdbId: 5 })).toBe("movie:5");
        expect(titleKeyOf({ kind: "tv", tmdbId: 5, season: 1, episode: 2 })).toBe("tv:5:s1e2");
        expect(titleKeyOf({ fileId: "fabc" })).toBe("file:fabc");
        expect(() => titleKeyOf({})).toThrow();
    });
});

describe("Plex importer", () => {
    const fixtures: Record<string, unknown> = {
        "/library/sections": { MediaContainer: { Directory: [{ key: "1", type: "movie" }, { key: "2", type: "show" }, { key: "3", type: "artist" }] } },
        "/status/sessions/history/all": { MediaContainer: { Metadata: [{ ratingKey: "100", viewedAt: 1_700_000_000 }] } },
        "/library/sections/1/all?type=1": { MediaContainer: { Metadata: [
            { ratingKey: "100", title: "Matrix", viewCount: 2, duration: 8_160_000, userRating: 9, lastRatedAt: 1_690_000_000, Guid: [{ id: "imdb://tt0133093" }, { id: "tmdb://603" }] },
            { ratingKey: "101", title: "Old agent", viewCount: 1, duration: 6_000_000, guid: "com.plexapp.agents.imdb://tt0068646?lang=en" },
            { ratingKey: "102", title: "Unknown", viewCount: 1, duration: 1000, Guid: [{ id: "plex://movie/x" }] },
        ] } },
        "/library/sections/2/all?type=2": { MediaContainer: { Metadata: [{ ratingKey: "200", title: "Dark", userRating: 10, Guid: [{ id: "tmdb://70523" }] }] } },
        "/library/sections/2/all?type=4": { MediaContainer: { Metadata: [
            { ratingKey: "201", grandparentRatingKey: "200", parentIndex: 1, index: 1, viewCount: 1, duration: 3_000_000, lastViewedAt: 1_700_100_000 },
            { ratingKey: "202", grandparentRatingKey: "999", parentIndex: 1, index: 2, viewCount: 1, duration: 3_000_000 },
        ] } },
        "discover:/library/sections/watchlist/all": { MediaContainer: { Metadata: [
            { type: "movie", title: "Dune", Guid: [{ id: "tmdb://438631" }] }, { type: "show", title: "Severance", Guid: [{ id: "tmdb://95396" }] }, { type: "episode" },
        ] } },
    };
    const seen: { url: string; token: string | undefined }[] = [];
    const fakeFetch: PlexFetch = async (url, init) => {
        seen.push({ url, token: init.headers["x-plex-token"] });
        const u = new URL(url);
        const key = u.host === "discover.provider.plex.tv" ? `discover:${u.pathname}` : u.pathname + (u.searchParams.get("type") ? `?type=${u.searchParams.get("type")}` : "");
        const body = fixtures[key];
        if (init.headers["x-plex-token"] === "bad") return { ok: false, status: 401, json: async () => ({}) };
        return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
    };

    it("parses guids", () => {
        expect(plexGuids({ Guid: [{ id: "tmdb://603" }, { id: "imdb://tt0133093" }] })).toEqual({ tmdb: 603, imdb: "tt0133093" });
        expect(plexGuids({ guid: "com.plexapp.agents.themoviedb://11?lang=en" })).toEqual({ tmdb: 11, imdb: null });
    });

    it("imports watched movies/episodes, ratings and watchlist; never stores the token", async () => {
        const db = openMemoryMediaDb();
        const progress = new ProgressStore(db);
        const watchlist = new WatchlistStore(db, progress);
        const r = await importFromPlex({ db, progress, watchlist, fetch: fakeFetch, findByImdb: async (id) => (id === "tt0068646" ? 238 : null) },
            { serverUrl: "http://plex.local:32400/?x=1", token: "SECRET-TOKEN", profileId: "p1" });
        expect(r).toMatchObject({ sections: 2, watchedMovies: 2, watchedEpisodes: 1, ratings: 2, watchlist: 2, unmatched: 2 });
        const matrix = progress.getProgress("p1", { kind: "movie", tmdbId: 603 })[0]!;
        expect(matrix).toMatchObject({ completed: true, positionSec: 8160, durationSec: 8160, updatedAt: 1_700_000_000_000 });
        expect(progress.getProgress("p1", { kind: "movie", tmdbId: 238 })).toHaveLength(1);
        expect(progress.getProgress("p1", { kind: "tv", tmdbId: 70523 })[0]).toMatchObject({ season: 1, episode: 1, completed: true, updatedAt: 1_700_100_000_000 });
        expect(watchlist.list("p1").map((w) => `${w.kind}:${w.tmdbId}`).sort()).toEqual(["movie:438631", "tv:95396"]);
        expect(db.prepare("SELECT rating FROM user_ratings WHERE profile_id = 'p1' AND tmdb_id = 603").get()).toEqual({ rating: 9 });
        expect(seen.every((s) => s.token === "SECRET-TOKEN" && !s.url.includes("SECRET"))).toBe(true);
        const dump = JSON.stringify(db.prepare("SELECT * FROM meta").all()) + JSON.stringify(db.prepare("SELECT * FROM recs_cache").all());
        expect(dump.includes("SECRET")).toBe(false);
    });

    it("rejects bad tokens / URLs", async () => {
        const db = openMemoryMediaDb();
        const progress = new ProgressStore(db);
        const deps = { db, progress, watchlist: new WatchlistStore(db, progress), fetch: fakeFetch };
        await expect(importFromPlex(deps, { serverUrl: "http://plex.local", token: "bad", profileId: "p" })).rejects.toMatchObject({ status: 401 });
        await expect(importFromPlex(deps, { serverUrl: "ftp://x", token: "t", profileId: "p" })).rejects.toBeInstanceOf(PlexImportError);
    });
});

describe("push relay", () => {
    it("posts with the device token, debounces repeats, retries 5xx 3x, pauses on 401, no-op without webAppUrl", async () => {
        const calls: { url: string; auth: string; body: Record<string, unknown> }[] = [];
        let statuses: number[] = [];
        const fetchFn: RelayFetch = async (url, init) => {
            calls.push({ url, auth: init.headers.authorization!, body: JSON.parse(init.body) as Record<string, unknown> });
            const s = statuses.shift() ?? 200;
            return { ok: s < 300, status: s };
        };
        let t = 1000;
        let webUrl: string | undefined = "https://mixai.ro/";
        let token = "tok-1";
        const relay = new PushRelay({ getWebAppUrl: () => webUrl, getDeviceToken: () => token, getServerId: () => "srv", fetch: fetchFn, now: () => t, sleep: async () => undefined });
        const msg = { event: "recording.done" as const, title: "Recording ready", body: "Știri", deepLink: "mixai://livetv/recordings/r1" };
        expect(await relay.notify(msg)).toEqual({ sent: true, status: 200, attempts: 1 });
        expect(calls[0]).toMatchObject({ url: "https://mixai.ro/api/push/relay", auth: "Bearer tok-1", body: { event: "recording.done", title: "Recording ready", serverId: "srv", at: 1000 } });
        expect(typeof calls[0]!.body.eventId).toBe("string");
        expect(await relay.notify(msg)).toMatchObject({ status: "debounced" });
        t += 61_000;
        statuses = [502, 503, 200];
        expect(await relay.notify(msg)).toEqual({ sent: true, status: 200, attempts: 3 });
        t += 61_000;
        statuses = [500, 500, 500];
        expect(await relay.notify(msg)).toEqual({ sent: false, status: 500, attempts: 3 });
        statuses = [400];
        expect(await relay.notify({ ...msg, deepLink: "x" })).toEqual({ sent: false, status: 400, attempts: 1 });
        statuses = [401];
        expect(await relay.notify({ ...msg, deepLink: "y" })).toMatchObject({ status: 401 });
        const n = calls.length;
        expect(await relay.notify({ ...msg, deepLink: "z" })).toMatchObject({ status: "skipped" });
        token = "tok-2";
        expect(await relay.notify({ ...msg, deepLink: "z2" })).toMatchObject({ sent: true });
        webUrl = undefined;
        expect(await relay.notify({ ...msg, deepLink: "z3" })).toEqual({ sent: false, status: "skipped", attempts: 0 });
        expect(calls.length).toBe(n + 1);
    });
});

describe("phone routes over HTTP", () => {
    let server: http.Server;
    let base = "";
    let db: MediaDb;
    let profiles: ProfileStore;
    let kidId = "";
    let plexToken: string | undefined;

    beforeAll(async () => {
        db = openMemoryMediaDb();
        const fetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}) });
        const tmdb = new TmdbClient(db, { fetch });
        const registry = new ProviderRegistry(db, tmdb);
        const availability = new AvailabilityResolver({ db, tmdb, registry, fetch });
        const progress = new ProgressStore(db);
        profiles = new ProfileStore(db);
        kidId = profiles.create({ name: "Kid", kind: "kid", maxAge: 12, prefs: { dailyCapMin: 60 } }).id;
        seedTitle(db, "movie", 1, "Family Film", 6);
        seedTitle(db, "movie", 2, "Horror", 18);
        new LibraryIndex(db, tmdb).upsert({ path: "D:/Movies/Family Film.mkv", size: 1, mtime: 1, title: "Family Film", year: null, season: null, episode: null, kind: "movie", tmdbId: 1 });
        const subtitles = new SubtitleIndex(db);
        const app = express();
        app.use("/media", createMediaRouter({
            db, tmdb, registry, availability, progress, profiles, region: "RO", log: silent, subtitles,
            bookmarks: new BookmarkStore(db),
            subtitleIndexing: () => ({
                request: (id) => (id === "known" ? { state: "queued", externalCues: 2, embeddedCues: 0, error: null } : null),
                job: (id) => (id === "known" ? { state: "running", externalCues: 2, embeddedCues: 0, error: null } : null),
            }),
            plexFetch: async (_url, init) => {
                plexToken = init.headers["x-plex-token"];
                return { ok: true, status: 200, json: async () => ({ MediaContainer: { Directory: [] } }) };
            },
        }));
        server = http.createServer(app);
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}/media`;
        const { makeServerFileId } = await import("./library");
        subtitles.indexTrack(makeServerFileId("D:/Movies/Family Film.mkv"), { key: "ext:a.srt", index: null, source: "external", lang: "ro", label: "a.srt", sig: "1" },
            [{ startSec: 12, endSec: 14, text: "Țara noastră e frumoasă" }]);
        subtitles.indexTrack("horrorfile", { key: "ext:b.srt", index: null, source: "external", lang: "ro", label: "b.srt", sig: "1" },
            [{ startSec: 1, endSec: 2, text: "Țara morților" }]);
        db.prepare("INSERT INTO library_index (server_file_id, kind, tmdb_id, season, episode, path, size, mtime, updated_at) VALUES ('horrorfile', 'movie', 2, NULL, NULL, 'D:/Movies/Horror.mkv', 1, 1, 1)").run();
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    const j = async (p: string, init?: RequestInit) => {
        const res = await fetch(base + p, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
        const text = await res.text();
        return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
    };

    it("bookmarks: create, shared visibility, kid age filter, owner-only delete", async () => {
        const mine = await j("/bookmarks?profile=default", { method: "POST", body: JSON.stringify({ kind: "movie", tmdbId: 2, sec: 600.04, label: "Jump scare", shared: true }) });
        expect(mine.status).toBe(201);
        expect(mine.body.bookmark).toMatchObject({ titleKey: "movie:2", sec: 600, shared: true, profileId: "default" });
        await j("/bookmarks?profile=default", { method: "POST", body: JSON.stringify({ kind: "movie", tmdbId: 1, sec: 30, label: "Song", shared: true }) });
        await j("/bookmarks?profile=default", { method: "POST", body: JSON.stringify({ kind: "movie", tmdbId: 1, sec: 40, label: "private" }) });
        expect((await j("/bookmarks?profile=default", { method: "POST", body: JSON.stringify({ sec: 1 }) })).status).toBe(400);
        expect((await j("/bookmarks?profile=default", { method: "POST", body: JSON.stringify({ kind: "movie", tmdbId: 1, sec: -1 }) })).status).toBe(400);

        const kidList = (await j(`/bookmarks?profile=${kidId}`)).body.bookmarks as { label: string; mine: boolean; profileName: string }[];
        expect(kidList.map((b) => b.label)).toEqual(["Song"]);
        expect(kidList[0]).toMatchObject({ mine: false, profileName: "Principal" });
        const adult = (await j("/bookmarks?profile=default&titleKey=movie:1")).body.bookmarks as { label: string }[];
        expect(adult.map((b) => b.label)).toEqual(["Song", "private"]);

        const id = String((mine.body.bookmark as { id: string }).id);
        expect((await j(`/bookmarks/${id}?profile=${kidId}`, { method: "DELETE" })).status).toBe(403);
        expect((await j(`/bookmarks/${id}?profile=default`, { method: "DELETE" })).status).toBe(204);
        expect((await j(`/bookmarks/${id}?profile=default`, { method: "DELETE" })).status).toBe(404);
    });

    it("usage + family stats + weekly in /stats", async () => {
        const u = await j(`/profiles/${kidId}/usage`);
        expect(u.status).toBe(200);
        expect(u.body).toMatchObject({ profileId: kidId, dailyCapMin: 60, enforced: true, overCap: false, watchMin: 0 });
        expect((u.body.week as { days: string[] }).days).toHaveLength(7);
        expect((await j("/profiles/nope/usage")).status).toBe(404);
        const fam = (await j("/stats/family")).body.profiles as { profileId: string; dailyCapMin: number | null }[];
        expect(fam.map((p) => p.profileId)).toContain(kidId);
        expect(fam.find((p) => p.profileId === kidId)!.dailyCapMin).toBe(60);
        const st = (await j("/stats?profile=default")).body;
        expect((st.weekly as { watchMin: number[] }).watchMin).toHaveLength(7);
    });

    it("subtitle search: across library, per file, kid age filter, validation", async () => {
        const all = await j("/subtitles/search?q=tara&profile=default");
        expect(all.status).toBe(200);
        expect((all.body.hits as { title: string }[]).map((h) => h.title).sort()).toEqual(["Family Film", "Horror"]);
        const kid = await j(`/subtitles/search?q=TARA&profile=${kidId}`);
        expect((kid.body.hits as { title: string; tmdbId: number; startSec: number }[])).toEqual([expect.objectContaining({ title: "Family Film", tmdbId: 1, startSec: 12 })]);
        const one = await j("/subtitles/search?q=morti&fileId=horrorfile");
        expect((one.body.hits as unknown[]).length).toBe(1);
        expect(one.body.indexedFiles).toBe(true);
        expect((await j("/subtitles/search?q=a")).status).toBe(400);
    });

    it("subtitle index endpoints delegate to the indexer", async () => {
        expect((await j("/subtitles/index", { method: "POST", body: "{}" })).status).toBe(400);
        expect((await j("/subtitles/index", { method: "POST", body: JSON.stringify({ fileId: "nope" }) })).status).toBe(404);
        const r = await j("/subtitles/index", { method: "POST", body: JSON.stringify({ fileId: "known" }) });
        expect(r.status).toBe(202);
        expect(r.body).toMatchObject({ fileId: "known", state: "queued", externalCues: 2 });
        expect((await j("/subtitles/index/known")).body).toMatchObject({ job: { state: "running" } });
        expect((await j("/subtitles/index/none")).status).toBe(404);
    });

    it("plex import route validates input and uses the token for the request only", async () => {
        expect((await j("/import/plex", { method: "POST", body: JSON.stringify({ serverUrl: "http://plex" }) })).status).toBe(400);
        expect((await j("/import/plex", { method: "POST", body: JSON.stringify({ serverUrl: "http://plex", token: "t", profileId: "ghost" }) })).status).toBe(404);
        const r = await j("/import/plex", { method: "POST", body: JSON.stringify({ serverUrl: "http://plex:32400", token: "PLEXTOK", profileId: "default" }) });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ profileId: "default", sections: 0, watchedMovies: 0 });
        expect(plexToken).toBe("PLEXTOK");
    });
});
