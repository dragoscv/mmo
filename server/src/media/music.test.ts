import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

vi.mock("../store", () => ({
    store: { get: (k: string) => (k === "userId" ? "user-1" : undefined) },
    getSettings: () => ({ scanFolders: [] }),
}));
vi.mock("../sync", () => ({ enqueueSyncChange: vi.fn() }));

import { __setSubsonicDbForTests } from "../subsonic/browse";
import { albumId, artistId, trackId } from "../subsonic/ids";
import { openMemoryMediaDb, type MediaDb } from "./db";
import { MAX_QUEUE, MAX_TRACK_IDS, MusicError, MusicService, fold, parseLrc, parseTrackKey, trackNumbersFromFilename } from "./music";
import { createMusicRouter } from "./music-routes";

const DDL = `
CREATE TABLE tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, filepath TEXT NOT NULL, filename TEXT NOT NULL,
  artist TEXT, title TEXT, album TEXT, genre TEXT, year INTEGER, duration INTEGER, bpm REAL, file_size INTEGER,
  format TEXT, bitrate INTEGER, sample_rate INTEGER, added_at TEXT DEFAULT (datetime('now')), rating INTEGER,
  is_favorite INTEGER DEFAULT 0, lyrics TEXT, synced_lyrics TEXT, comment TEXT, artwork_url TEXT, musicbrainz_id TEXT,
    is_hidden INTEGER DEFAULT 0, sha256 TEXT, loudness_lufs REAL, loudness_true_peak_dbfs REAL,
    key_camelot TEXT, bpm_confidence REAL, beats TEXT, downbeats TEXT, structure_segments TEXT
);
CREATE TABLE playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, type TEXT DEFAULT 'manual',
  created_at TEXT DEFAULT (datetime('now')), external_id TEXT, updated_at TEXT
);
CREATE TABLE playlist_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id INTEGER NOT NULL, track_id INTEGER NOT NULL, position INTEGER NOT NULL
);`;

const NOW = Date.UTC(2026, 10, 4, 12);
let lib: Database.Database;
let media: MediaDb;
let music: MusicService;
let tmp: string;

interface Seed {
    artist?: string; title: string; album?: string; genre?: string; year?: number; file?: string; dir?: string;
    lyrics?: string; synced?: string; user?: string; hidden?: boolean; sha?: string; added?: string;
}
function insert(t: Seed): number {
    const file = t.file ?? `${t.title}.mp3`;
    const r = lib.prepare(
        `INSERT INTO tracks (user_id, filepath, filename, artist, title, album, genre, year, duration, format, bitrate,
                             lyrics, synced_lyrics, is_hidden, sha256, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 200, 'MP3', 320, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    ).run(t.user ?? "user-1", path.join(t.dir ?? "/m", file), file, t.artist ?? null, t.title, t.album ?? null, t.genre ?? null,
        t.year ?? null, t.lyrics ?? null, t.synced ?? null, t.hidden ? 1 : 0, t.sha ?? null, t.added ?? null);
    return Number(r.lastInsertRowid);
}
const play = (key: string, at: number, profile = "p1") =>
    media.prepare("INSERT INTO track_plays (profile_id, track_key, played_at, duration_sec, completed) VALUES (?, ?, ?, 200, 1)").run(profile, key, at);

let ids: Record<string, number> = {};

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-music-"));
    lib = new Database(":memory:");
    lib.exec(DDL);
    __setSubsonicDbForTests(lib);
    media = openMemoryMediaDb();
    music = new MusicService({ mediaDb: media, getLibraryDb: () => lib, now: () => NOW });
    ids = {
        omt: insert({ artist: "Daft Punk", title: "One More Time", album: "Discovery", genre: "House", year: 2001, file: "01 One More Time.mp3", added: "2026-01-01 10:00:00" }),
        aero: insert({ artist: "Daft Punk", title: "Aerodynamic", album: "Discovery", genre: "House", year: 2001, file: "02 Aerodynamic.mp3", added: "2026-01-01 10:00:00" }),
        funk: insert({ artist: "Daft Punk", title: "Da Funk", album: "Homework", genre: "House", year: 1997, file: "1-03 Da Funk.mp3", added: "2025-01-01 10:00:00",
            synced: "[ar:Daft Punk]\n[00:01.50]Da funk\n[00:10.00][00:20.00]Back"
        }),
        galv: insert({ artist: "The Chemical Brothers", title: "Galvanize", album: "Push the Button", genre: "Big Beat", year: 2005, added: "2026-06-01 10:00:00" }),
        dor: insert({ artist: "Ștefan Bănică", title: "Dor de țară", album: "Mărțișor", genre: "House", year: 2010, sha: "a".repeat(64), dir: tmp, file: "dor.mp3", added: "2026-03-01 10:00:00" }),
        plain: insert({ artist: "Ștefan Bănică", title: "Plain One", album: "Mărțișor", genre: "House", year: 2010, lyrics: "line a\nline b", added: "2026-03-01 10:00:00" }),
        other: insert({ artist: "Other", title: "Secret", album: "Nope", user: "user-2" }),
        hidden: insert({ artist: "Daft Punk", title: "Hidden", album: "Discovery", hidden: true }),
    };
    lib.prepare("INSERT INTO playlists (user_id, name) VALUES ('user-1', 'Party')").run();
    lib.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (1, ?, 0), (1, ?, 1)").run(ids.galv, ids.omt);
});

afterEach(() => {
    __setSubsonicDbForTests(null);
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe("helpers", () => {
    it("fold strips Romanian diacritics (both comma and cedilla forms)", () => {
        expect(fold("ȘȚĂÂÎ șțăâî ŞŢşţ")).toBe("staai staai stst");
    });

    it("parseTrackKey accepts subsonic, server-scoped, bare and sha256 keys", () => {
        expect(parseTrackKey("tr_5")).toEqual({ id: 5 });
        expect(parseTrackKey("subsonic:tr_6")).toEqual({ id: 6 });
        expect(parseTrackKey("srv1:track:43")).toEqual({ id: 43 });
        expect(parseTrackKey("42")).toEqual({ id: 42 });
        expect(parseTrackKey(`sha256:${"A".repeat(64)}`)).toEqual({ sha256: "a".repeat(64) });
        expect(parseTrackKey("t:1")).toBeNull();
        expect(parseTrackKey("0")).toBeNull();
    });

    it("track numbers from filenames", () => {
        expect(trackNumbersFromFilename("01 One.mp3")).toEqual({ track: 1, disc: null });
        expect(trackNumbersFromFilename("1-03 Da Funk.mp3")).toEqual({ track: 3, disc: 1 });
        expect(trackNumbersFromFilename("Galvanize.mp3")).toEqual({ track: null, disc: null });
    });

    it("parseLrc handles multiple stamps, metadata and offset", () => {
        const lines = parseLrc("[ti:x]\n[offset:+500]\n[00:01.50]a\n[00:03.00][00:05]b\n[01:00.123]c");
        expect(lines).toEqual([
            { timeMs: 1000, text: "a" }, { timeMs: 2500, text: "b" }, { timeMs: 4500, text: "b" }, { timeMs: 59623, text: "c" },
        ]);
        expect(parseLrc("[offset:-250]\n[00:01.00]x")).toEqual([{ timeMs: 1250, text: "x" }]);
        expect(parseLrc("no timestamps here")).toBeNull();
    });
});

describe("MusicService browse", () => {
    it("artists group case-insensitively, exclude other users/hidden, filter by letter", () => {
        const page = music.artists({});
        // SQLite LOWER() orders by bytes: non-ASCII initials sort last (same order as /rest getArtists).
        expect(page.items.map((a) => a.name)).toEqual(["Daft Punk", "The Chemical Brothers", "Ștefan Bănică"]);
        expect(page.items[0]).toMatchObject({ id: artistId("Daft Punk"), albumCount: 2, songCount: 3 });
        expect(page.items[0]!.coverUrlPath).toMatch(/^\/rest\/getCoverArt\.view\?id=tr_\d+&size=400$/);
        expect(music.artists({ letter: "c" }).items.map((a) => a.name)).toEqual(["The Chemical Brothers"]);
        expect(music.artists({ letter: "S" }).items.map((a) => a.name)).toEqual(["Ștefan Bănică"]);
        expect(music.artists({ offset: 1, limit: 1 })).toMatchObject({ total: 3, offset: 1, limit: 1 });
    });

    it("artist detail: albums by year, top tracks by plays, similar by shared genre", () => {
        play(`tr_${ids.funk}`, NOW - 1000);
        play(`tr_${ids.funk}`, NOW - 2000, "p2");
        play(String(ids.aero), NOW - 3000);
        const d = music.artist(artistId("Daft Punk"));
        expect(d.albums.map((a) => [a.name, a.year])).toEqual([["Homework", 1997], ["Discovery", 2001]]);
        expect(d.topTracks.map((t) => [t.title, t.plays])).toEqual([["Da Funk", 2], ["Aerodynamic", 1], ["One More Time", 0]]);
        expect(d.similar.map((a) => a.name)).toEqual(["Ștefan Bănică"]);
        expect(() => music.artist("ar_0000000000000000")).toThrow(MusicError);
        expect(() => music.artist("bogus")).toThrow(/artist not found/);
    });

    it("album detail sorts by track number and exposes stream/cover paths + lyric flags", () => {
        const d = music.album(albumId("Discovery", "Daft Punk"));
        expect(d.album).toMatchObject({ name: "Discovery", artist: "Daft Punk", songCount: 2, durationSec: 400, year: 2001 });
        expect(d.tracks.map((t) => [t.track, t.title])).toEqual([[1, "One More Time"], [2, "Aerodynamic"]]);
        expect(d.tracks[0]).toMatchObject({
            id: trackId(ids.omt), format: "mp3", bitrate: 320, hasLyrics: false, hasSyncedLyrics: false,
            streamUrlPath: `/rest/stream.view?id=tr_${ids.omt}`,
        });
        expect(music.album(albumId("Homework", "Daft Punk")).tracks[0]).toMatchObject({ disc: 1, track: 3, hasSyncedLyrics: true });
    });

    it("track cards carry analyser loudness only once measured", () => {
        expect(music.album(albumId("Discovery", "Daft Punk")).tracks[0]).not.toHaveProperty("loudnessLufs");
        lib.prepare("UPDATE tracks SET loudness_lufs = -8.5, loudness_true_peak_dbfs = 0.4 WHERE id = ?").run(ids.omt);
        expect(music.album(albumId("Discovery", "Daft Punk")).tracks[0]).toMatchObject({ loudnessLufs: -8.5, truePeakDbfs: 0.4 });
        // Playlist cards used a hand-written column list without loudness (WP17-44 fix).
        expect(music.playlist("pl_1").tracks.find((t) => t.id === trackId(ids.omt))).toMatchObject({ loudnessLufs: -8.5 });
    });

    it("track cards carry automix fields: bpm (any source), key, confidence and first beat only once analysed", () => {
        const card = () => music.album(albumId("Discovery", "Daft Punk")).tracks[0]!;
        for (const k of ["bpm", "bpmConfidence", "keyCamelot", "firstBeatSec"]) expect(card()).not.toHaveProperty(k);
        lib.prepare("UPDATE tracks SET bpm = 123.456, key_camelot = '8A' WHERE id = ?").run(ids.omt);
        expect(card()).toMatchObject({ bpm: 123.46, keyCamelot: "8A" });
        expect(card()).not.toHaveProperty("firstBeatSec");
        lib.prepare("UPDATE tracks SET bpm_confidence = 1.7, beats = '[0.31,0.8]', downbeats = '[0.5123]' WHERE id = ?").run(ids.omt);
        expect(card()).toMatchObject({ bpmConfidence: 1, firstBeatSec: 0.512 });
        lib.prepare("UPDATE tracks SET downbeats = NULL WHERE id = ?").run(ids.omt);
        expect(card().firstBeatSec).toBe(0.31);
        // Malformed JSON / bad key never breaks the query.
        lib.prepare("UPDATE tracks SET beats = '{oops', key_camelot = '13Z' WHERE id = ?").run(ids.omt);
        expect(card()).not.toHaveProperty("firstBeatSec");
        expect(card()).not.toHaveProperty("keyCamelot");
    });

    it("beat grid only for analysed tracks of this owner", () => {
        expect(() => music.beatgrid(`tr_${ids.omt}`)).toThrow(/not analysed/);
        lib.prepare(`UPDATE tracks SET bpm = 120, bpm_confidence = 0.9, key_camelot = '9A', beats = '[0.5,1,1.5,"x",-1]',
            downbeats = '[0.5]', structure_segments = '[{"start":0,"end":30,"label":"intro"},{"bad":1}]' WHERE id = ?`).run(ids.omt);
        expect(music.beatgrid(`tr_${ids.omt}`)).toEqual({
            trackId: `tr_${ids.omt}`, bpm: 120, bpmConfidence: 0.9, keyCamelot: "9A", beats: [0.5, 1, 1.5], downbeats: [0.5],
            segments: [{ start: 0, end: 30, label: "intro" }],
        });
        lib.prepare("UPDATE tracks SET beats = '[1]' WHERE id = ?").run(ids.other);
        expect(() => music.beatgrid(`tr_${ids.other}`)).toThrow(/track not found/);
        expect(() => music.beatgrid("al_0000000000000000")).toThrow(/track not found/);
    });

    it("reorder keeps the start track and walks the Camelot wheel; radio can be ordered harmonically", () => {
        const set = lib.prepare("UPDATE tracks SET key_camelot = ?, bpm = ? WHERE id = ?");
        set.run("8A", 124, ids.omt); set.run("3B", 90, ids.aero); set.run("9A", 125, ids.funk); set.run("8B", 124, ids.galv);
        const r = music.reorder([`tr_${ids.omt}`, `tr_${ids.aero}`, `tr_${ids.funk}`, `tr_${ids.plain}`, `tr_${ids.galv}`, "tr_999"]);
        expect(r.tracks.map((t) => t.id)).toEqual([`tr_${ids.omt}`, `tr_${ids.galv}`, `tr_${ids.funk}`, `tr_${ids.aero}`, `tr_${ids.plain}`]);
        expect(music.reorder([`tr_${ids.omt}`, `tr_${ids.galv}`, `tr_${ids.funk}`], 2).tracks[0]!.id).toBe(`tr_${ids.funk}`);
        expect(() => music.reorder(Array.from({ length: 501 }, (_, i) => `tr_${i + 1}`))).toThrow(/at most 500/);
        const radio = music.radio(`tr_${ids.omt}`, 10, () => 0, "harmonic").tracks;
        expect(radio[0]!.id).toBe(`tr_${ids.omt}`);
        expect(radio.findIndex((t) => t.id === `tr_${ids.funk}`)).toBeLessThan(radio.findIndex((t) => t.id === `tr_${ids.aero}`));
    });

    it("genres and genre albums", () => {
        const g = music.genres();
        expect(g.map((x) => x.name)).toEqual(["Big Beat", "House"]);
        expect(g.find((x) => x.name === "House")).toMatchObject({ songCount: 5, albumCount: 3 });
        const house = music.genre("house", 0, 2);
        expect(house.total).toBe(3);
        expect(house.items).toHaveLength(2);
    });

    it("search is case- and diacritic-insensitive", () => {
        const r = music.search("STEFAN banica");
        expect(r.artists.map((a) => a.name)).toEqual(["Ștefan Bănică"]);
        expect(music.search("tara").tracks.map((t) => t.title)).toEqual(["Dor de țară"]);
        expect(music.search("martisor").albums.map((a) => a.name)).toEqual(["Mărțișor"]);
        expect(music.search("dor de ţară").tracks).toHaveLength(1); // cedilla ţ
        expect(music.search("secret").tracks).toHaveLength(0); // other user
        expect(music.search("hidden").tracks).toHaveLength(0);
        expect(music.search("  ")).toMatchObject({ artists: [], albums: [], tracks: [] });
    });
});

describe("MusicService home", () => {
    it("recent albums from track_plays (all key forms), most played 30 d, playlists, genres", () => {
        play(`sha256:${"a".repeat(64)}`, NOW - 1000); // Mărțișor (via sha lookup)
        play(`srv1:track:${ids.funk}`, NOW - 2000); // Homework
        play(`tr_${ids.omt}`, NOW - 3000); // Discovery
        play(String(ids.aero), NOW - 4000); // Discovery again (deduped)
        play(`tr_${ids.galv}`, NOW - 40 * 86_400_000); // old: recent yes, most played no
        play(`tr_${ids.omt}`, NOW - 5000, "p2"); // other profile
        play("garbage", NOW);
        const h = music.home("p1");
        expect(h.recent.map((a) => a.name)).toEqual(["Mărțișor", "Homework", "Discovery", "Push the Button"]);
        expect(h.recent[0]).toMatchObject({ id: albumId("Mărțișor", "Ștefan Bănică"), coverArt: albumId("Mărțișor", "Ștefan Bănică") });
        expect(h.mostPlayed.map((t) => t.title).sort()).toEqual(["Aerodynamic", "Da Funk", "Dor de țară", "One More Time"]);
        expect(h.mostPlayed.every((t) => t.plays === 1)).toBe(true);
        expect(h.newest[0]!.name).toBe("Push the Button");
        expect(h.playlists).toEqual([expect.objectContaining({ id: "pl_1", name: "Party", songCount: 2, coverArt: `tr_${ids.galv}` })]);
        expect(h.genres.map((g) => g.name)).toEqual(["Big Beat", "House"]);
        expect(h.randomAlbums).toHaveLength(4);
        expect(music.home("nobody").recent).toEqual([]);
    });

    it("empty library user → empty rows", () => {
        const none = new MusicService({ mediaDb: media, getLibraryDb: () => lib, getUserId: () => null });
        expect(none.home("p1")).toMatchObject({ recent: [], newest: [], mostPlayed: [], playlists: [], genres: [], randomAlbums: [] });
    });

    it("playlist tracks in order, random tracks, albums A–Z", () => {
        const pl = music.playlist("pl_1");
        expect(pl.playlist).toMatchObject({ id: "pl_1", name: "Party", songCount: 2 });
        expect(pl.tracks.map((t) => t.id)).toEqual([`tr_${ids.galv}`, `tr_${ids.omt}`]);
        expect(() => music.playlist("pl_99")).toThrow(/not found/);
        expect(() => music.playlist("al_x")).toThrow(/not found/);
        const rnd = music.randomTracks(3);
        expect(rnd).toHaveLength(3);
        expect(new Set(rnd.map((t) => t.id)).size).toBe(3);
        expect(rnd.every((t) => t.title !== "Hidden")).toBe(true);
        const all = music.albums({ limit: 2 });
        expect(all.total).toBe(4);
        expect(all.items).toHaveLength(2);
        expect(music.albums({ letter: "d" }).items.map((a) => a.name)).toEqual(["Discovery"]);
    });
});

describe("MusicService queue", () => {
    it("round-trips and defaults", () => {
        expect(music.getQueue("p1")).toMatchObject({ trackIds: [], index: 0, repeat: "off", updatedAt: 0 });
        const q = music.setQueue("p1", { trackIds: ["tr_1", "tr_2"], index: 1, positionSec: 12.5, shuffle: true, repeat: "all" });
        expect(q).toMatchObject({ profileId: "p1", index: 1, positionSec: 12.5, shuffle: true, repeat: "all", updatedAt: NOW });
        expect(music.getQueue("p1")).toEqual(q);
        expect(music.getQueue("p2").trackIds).toEqual([]);
    });

    it("validates body", () => {
        const bad = (b: unknown) => () => music.setQueue("p1", b);
        expect(bad(null)).toThrow(/object/);
        expect(bad({ trackIds: "x" })).toThrow(/array/);
        expect(bad({ trackIds: ["al_0000000000000000"] })).toThrow(/invalid track id/);
        expect(bad({ trackIds: ["tr_1"], index: 1 })).toThrow(/index/);
        expect(bad({ trackIds: [], index: 1 })).toThrow(/index/);
        expect(bad({ trackIds: ["tr_1"], positionSec: -1 })).toThrow(/positionSec/);
        expect(bad({ trackIds: ["tr_1"], repeat: "loop" })).toThrow(/repeat/);
        expect(bad({ trackIds: ["tr_1"], shuffle: "yes" })).toThrow(/shuffle/);
        expect(bad({ trackIds: Array.from({ length: MAX_QUEUE + 1 }, (_, i) => `tr_${i + 1}`) })).toThrow(/max 2000/);
        expect(music.setQueue("p1", { trackIds: Array.from({ length: MAX_QUEUE }, (_, i) => `tr_${i + 1}`) }).trackIds).toHaveLength(MAX_QUEUE);
    });
});

describe("MusicService lyrics", () => {
    it("synced column", () => {
        const l = music.lyrics(`tr_${ids.funk}`);
        expect(l).toMatchObject({ source: "embedded", plain: null });
        expect(l.synced).toEqual([{ timeMs: 1500, text: "Da funk" }, { timeMs: 10000, text: "Back" }, { timeMs: 20000, text: "Back" }]);
    });

    it("plain column", () => {
        expect(music.lyrics(`tr_${ids.plain}`)).toMatchObject({ source: "embedded", synced: null, plain: "line a\nline b" });
    });

    it("sidecar .lrc next to the audio file, with offset", () => {
        expect(music.lyrics(`tr_${ids.dor}`)).toMatchObject({ source: "none", synced: null, plain: null });
        fs.writeFileSync(path.join(tmp, "dor.lrc"), "\uFEFF[offset:200]\n[00:02.00]Dor\n[00:04.00]de țară\n", "utf8");
        expect(music.lyrics(`tr_${ids.dor}`)).toEqual({
            trackId: `tr_${ids.dor}`, source: "sidecar", plain: "Dor\nde țară",
            synced: [{ timeMs: 1800, text: "Dor" }, { timeMs: 3800, text: "de țară" }],
        });
    });

    it("unknown / foreign track → 404", () => {
        expect(() => music.lyrics(`tr_${ids.other}`)).toThrow(MusicError);
        expect(() => music.lyrics("al_0000000000000000")).toThrow(/track not found/);
    });

    it("lyricsAsync asks LRCLIB only when nothing is stored, persists hits, caches misses for a day", async () => {
        let clock = NOW;
        const calls: string[] = [];
        const fetchLyrics = vi.fn(async (artist: string, title: string) => {
            calls.push(`${artist}|${title}`);
            return title === "Galvanize" ? { plainLyrics: "Don't hold back", syncedLyrics: "[00:05.00]Don't hold back" } : null;
        });
        const m = new MusicService({ mediaDb: media, getLibraryDb: () => lib, now: () => clock, fetchLyrics });
        expect(await m.lyricsAsync(`tr_${ids.funk}`)).toMatchObject({ source: "embedded" });
        expect(fetchLyrics).not.toHaveBeenCalled();

        const hit = await m.lyricsAsync(`tr_${ids.galv}`);
        expect(hit).toMatchObject({ source: "lrclib", plain: "Don't hold back", synced: [{ timeMs: 5000, text: "Don't hold back" }] });
        expect(await m.lyricsAsync(`tr_${ids.galv}`)).toMatchObject({ source: "embedded" });
        expect(calls.filter((c) => c.endsWith("Galvanize"))).toHaveLength(1);

        expect(await m.lyricsAsync(`tr_${ids.omt}`)).toMatchObject({ source: "none" });
        expect(await m.lyricsAsync(`tr_${ids.omt}`)).toMatchObject({ source: "none" });
        expect(calls.filter((c) => c.endsWith("One More Time"))).toHaveLength(1);
        clock += 25 * 3_600_000;
        await m.lyricsAsync(`tr_${ids.omt}`);
        expect(calls.filter((c) => c.endsWith("One More Time"))).toHaveLength(2);

        const boom = new MusicService({ mediaDb: media, getLibraryDb: () => lib, now: () => NOW, fetchLyrics: async () => { throw new Error("net"); } });
        expect(await boom.lyricsAsync(`tr_${ids.aero}`)).toMatchObject({ source: "none" });
    });
});

describe("MusicService radio, songs, playlists", () => {
    it("track seed first, then the seed artist and genre-similar artists interleaved, no duplicates, no hidden/foreign", () => {
        const r = music.radio(`tr_${ids.omt}`, 50, () => 0);
        expect(r.tracks[0]!.id).toBe(`tr_${ids.omt}`);
        const titles = r.tracks.map((t) => t.title);
        expect(new Set(titles).size).toBe(titles.length);
        expect(titles).not.toContain("Hidden");
        expect(titles).not.toContain("Secret");
        expect(titles).not.toContain("Galvanize"); // Big Beat shares no genre with House
        expect(r.tracks.some((t) => t.artist === "Ștefan Bănică")).toBe(true);
        const artists = r.tracks.map((t) => t.artist);
        expect(artists[1]).not.toBe(artists[2]); // interleaved, not one artist's whole catalogue first
    });

    it("artist and album seeds, size cap, unknown seed → 404", () => {
        expect(music.radio(artistId("Daft Punk"), 2).tracks).toHaveLength(2);
        expect(music.radio(albumId("Push the Button", "The Chemical Brothers")).tracks.map((t) => t.title)).toEqual(["Galvanize"]);
        expect(() => music.radio("ar_0000000000000000")).toThrow(/seed not found/);
        expect(() => music.radio("pl_1")).toThrow(/seed not found/);
        expect(() => music.radio(`tr_${ids.other}`)).toThrow(MusicError);
    });

    it("songs A–Z paged and the playlists list", () => {
        const p = music.tracks({ limit: 3 });
        expect(p.total).toBe(6);
        expect(p.items.map((t) => t.title)).toEqual(["Aerodynamic", "Da Funk", "Dor de țară"]);
        expect(music.tracks({ offset: 5, limit: 3 }).items.map((t) => t.title)).toEqual(["Plain One"]);
        expect(music.playlistsList()).toEqual([expect.objectContaining({ id: "pl_1", name: "Party", songCount: 2 })]);
    });

    it("tracks by ids: requested order, unknown/foreign/non-track ids skipped, max 500", () => {
        const req = [`tr_${ids.galv}`, "tr_999999", `tr_${ids.omt}`, `tr_${ids.other}`, "al_0000000000000000", "junk", ` tr_${ids.funk} `, `tr_${ids.galv}`];
        const p = music.tracks({ ids: req, offset: 3, limit: 1 });
        expect(p.items.map((t) => t.id)).toEqual([`tr_${ids.galv}`, `tr_${ids.omt}`, `tr_${ids.funk}`, `tr_${ids.galv}`]);
        expect(p).toMatchObject({ total: 4, offset: 0, limit: req.length });
        expect(p.items[0]).toMatchObject({ title: "Galvanize", streamUrlPath: `/rest/stream.view?id=tr_${ids.galv}` });
        expect(music.tracks({ ids: [] })).toMatchObject({ total: 0, items: [] });
        // Explicit ids resolve every track of this library owner (hidden ones too: a queue may hold them), never another user's.
        expect(music.tracks({ ids: Array.from({ length: MAX_TRACK_IDS }, (_, i) => `tr_${i + 1}`) }).total).toBe(7);
        expect(() => music.tracks({ ids: Array.from({ length: MAX_TRACK_IDS + 1 }, (_, i) => `tr_${i + 1}`) })).toThrow(/at most 500/);
    });
});

describe("music router (http)", () => {
    let server: http.Server;
    let base = "";
    beforeAll(async () => {
        const app = express();
        // `music` is reassigned per test; the router reads through this proxy.
        const proxy = new Proxy({} as MusicService, { get: (_t, k) => { const v = (music as unknown as Record<string | symbol, unknown>)[k]; return typeof v === "function" ? v.bind(music) : v; } });
        app.use("/media/music", createMusicRouter({ music: proxy }));
        server = http.createServer(app);
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}/media/music`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    const j = async (p: string, init?: RequestInit) => {
        const res = await fetch(base + p, { ...init, headers: { "content-type": "application/json" } });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    it("GET /home, /artists, /albums/:id, /genres, /search, /lyrics", async () => {
        expect((await j("/home?profile=p1")).body).toMatchObject({ profileId: "p1" });
        expect(((await j("/artists?letter=D")).body.items as unknown[]).length).toBe(1);
        const al = await j(`/albums/${albumId("Discovery", "Daft Punk")}`);
        expect(al.status).toBe(200);
        expect((al.body.tracks as unknown[]).length).toBe(2);
        expect((await j("/albums/al_0000000000000000")).status).toBe(404);
        expect(((await j("/genres")).body.genres as unknown[]).length).toBe(2);
        expect((await j("/genres/House?limit=1")).body).toMatchObject({ genre: "House", total: 3, limit: 1 });
        expect((await j("/search")).status).toBe(400);
        expect(((await j(`/search?q=${encodeURIComponent("bănică")}`)).body.artists as unknown[]).length).toBe(1);
        expect((await j(`/artists/${artistId("Daft Punk")}`)).body).toMatchObject({ artist: { name: "Daft Punk" } });
        expect((await j(`/lyrics/tr_${ids.funk}`)).body).toMatchObject({ source: "embedded" });
        expect((await j("/radio")).status).toBe(400);
        expect((await j("/radio?seed=ar_0000000000000000")).status).toBe(404);
        expect(((await j(`/radio?seed=tr_${ids.omt}&size=3`)).body.tracks as unknown[]).length).toBe(3);
        expect((await j("/playlists")).body).toMatchObject({ playlists: [{ id: "pl_1" }] });
        expect((await j("/tracks?limit=2")).body).toMatchObject({ total: 6, limit: 2 });
        const byIds = await j(`/tracks?ids=${encodeURIComponent(`tr_${ids.aero},tr_404404,tr_${ids.omt}`)}`);
        expect(byIds.status).toBe(200);
        expect(byIds.body).toMatchObject({ total: 2, offset: 0, limit: 3 });
        expect((byIds.body.items as { id: string }[]).map((t) => t.id)).toEqual([`tr_${ids.aero}`, `tr_${ids.omt}`]);
        const tooMany = Array.from({ length: 501 }, (_, i) => `tr_${i + 1}`).join(",");
        expect((await j(`/tracks?ids=${tooMany}`)).status).toBe(400);
    });

    it("GET /beatgrid, POST /reorder, radio order=harmonic", async () => {
        expect((await j(`/beatgrid/tr_${ids.omt}`)).status).toBe(404);
        lib.prepare("UPDATE tracks SET beats = '[0.5,1]', bpm = 120 WHERE id = ?").run(ids.omt);
        expect((await j(`/beatgrid/tr_${ids.omt}`)).body).toMatchObject({ beats: [0.5, 1], bpm: 120 });
        expect((await j("/reorder", { method: "POST", body: JSON.stringify({ trackIds: "x" }) })).status).toBe(400);
        const ro = await j("/reorder", { method: "POST", body: JSON.stringify({ trackIds: [`tr_${ids.omt}`, `tr_${ids.aero}`], start: 1 }) });
        expect((ro.body.tracks as { id: string }[]).map((t) => t.id)).toEqual([`tr_${ids.aero}`, `tr_${ids.omt}`]);
        expect(((await j(`/radio?seed=tr_${ids.omt}&size=3&order=harmonic`)).body.tracks as unknown[]).length).toBe(3);
    });

    it("PUT/GET /queue with validation", async () => {
        const bad = await j("/queue?profile=p9", { method: "PUT", body: JSON.stringify({ trackIds: ["nope"] }) });
        expect(bad.status).toBe(400);
        const ok = await j("/queue?profile=p9", { method: "PUT", body: JSON.stringify({ trackIds: ["tr_1"], repeat: "one" }) });
        expect(ok.status).toBe(200);
        expect((await j("/queue?profile=p9")).body).toMatchObject({ trackIds: ["tr_1"], repeat: "one", profileId: "p9" });
    });
});
