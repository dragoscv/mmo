import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

// `../store` pins userData + reads config.json at import; `../sync` opens
// the companion DB. Neither is wanted in a unit test.
vi.mock("../store", () => ({
    store: { get: (k: string) => (k === "userId" ? "user-1" : undefined) },
    getSettings: () => ({ scanFolders: [] }),
}));
vi.mock("../sync", () => ({ enqueueSyncChange: vi.fn() }));

import {
    __setSubsonicDbForTests, albumList, findAlbumByHash, genres, listAlbums, listArtists,
    resolveUserId, search, songToBody, songsOfAlbum, starredSongs, indexLetter,
} from "./browse";
import { setRating, setStarred } from "./annotate";
import { createPlaylist, deletePlaylist, getPlaylist, listPlaylists, updatePlaylist } from "./playlists";
import { albumId, decodeId, trackId } from "./ids";

const DDL = `
CREATE TABLE tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, filepath TEXT NOT NULL, filename TEXT NOT NULL,
  artist TEXT, title TEXT, album TEXT, genre TEXT, year INTEGER, duration INTEGER, bpm REAL, file_size INTEGER,
  format TEXT, bitrate INTEGER, sample_rate INTEGER, added_at TEXT DEFAULT (datetime('now')), rating INTEGER,
  is_favorite INTEGER DEFAULT 0, lyrics TEXT, synced_lyrics TEXT, comment TEXT, artwork_url TEXT, musicbrainz_id TEXT,
  is_hidden INTEGER DEFAULT 0, sha256 TEXT
);
CREATE TABLE playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, type TEXT DEFAULT 'manual',
  created_at TEXT DEFAULT (datetime('now')), external_id TEXT, updated_at TEXT
);
CREATE TABLE playlist_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id INTEGER NOT NULL, track_id INTEGER NOT NULL, position INTEGER NOT NULL
);`;

let sqlite: Database.Database;

function insert(t: { artist?: string; title: string; album?: string; genre?: string; year?: number; user?: string; hidden?: boolean }) {
    sqlite.prepare(
        `INSERT INTO tracks (user_id, filepath, filename, artist, title, album, genre, year, duration, format, is_hidden)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 200, 'MP3', ?)`,
    ).run(t.user ?? "user-1", `/m/${t.title}.mp3`, `${t.title}.mp3`, t.artist ?? null, t.title, t.album ?? null, t.genre ?? null, t.year ?? null, t.hidden ? 1 : 0);
}

beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(DDL);
    __setSubsonicDbForTests(sqlite);
    insert({ artist: "Daft Punk", title: "One More Time", album: "Discovery", genre: "House", year: 2001 });
    insert({ artist: "Daft Punk", title: "Aerodynamic", album: "Discovery", genre: "House", year: 2001 });
    insert({ artist: "daft punk", title: "Da Funk", album: "Homework", genre: "House", year: 1997 });
    insert({ artist: "The Chemical Brothers", title: "Galvanize", album: "Push the Button", genre: "Big Beat", year: 2005 });
    insert({ artist: "Other", title: "Secret", album: "Nope", user: "user-2" });
    insert({ artist: "Daft Punk", title: "Hidden One", album: "Discovery", hidden: true });
});

describe("browse — aggregation", () => {
    it("resolves the paired user id", () => {
        expect(resolveUserId()).toBe("user-1");
    });

    it("groups artists case-insensitively and excludes other users + hidden rows", () => {
        const artists = listArtists("user-1");
        expect(artists.map((a) => a.artist)).toEqual(["Daft Punk", "The Chemical Brothers"]);
        expect(artists[0]!.album_count).toBe(2);
        expect(artists[0]!.song_count).toBe(3);
    });

    it("albums aggregate duration/song count and are addressable by hash", () => {
        const albums = listAlbums("user-1");
        expect(albums).toHaveLength(3);
        const disc = findAlbumByHash("user-1", albumId("Discovery", "Daft Punk").slice(3))!;
        expect(disc.song_count).toBe(2);
        expect(disc.duration).toBe(400);
        expect(songsOfAlbum("user-1", disc.album, disc.artist).map((s) => s.title)).toEqual(["Aerodynamic", "One More Time"]);
    });

    it("albumList2 types", () => {
        const byName = albumList("user-1", "alphabeticalByName", { size: 10, offset: 0 }).map((a) => a.album);
        expect(byName).toEqual(["Discovery", "Homework", "Push the Button"]);
        expect(albumList("user-1", "byGenre", { size: 10, offset: 0, genre: "house" })).toHaveLength(2);
        expect(albumList("user-1", "byYear", { size: 10, offset: 0, fromYear: 2000, toYear: 2010 }).map((a) => a.year)).toEqual([2001, 2005]);
        expect(albumList("user-1", "byYear", { size: 10, offset: 0, fromYear: 2010, toYear: 1990 }).map((a) => a.year)).toEqual([2005, 2001, 1997]);
        expect(albumList("user-1", "alphabeticalByName", { size: 1, offset: 1 }).map((a) => a.album)).toEqual(["Homework"]);
        expect(albumList("user-1", "starred", { size: 10, offset: 0 })).toHaveLength(0);
    });

    it("genres", () => {
        expect(genres("user-1")).toEqual([
            { value: "Big Beat", songCount: 1, albumCount: 1 },
            { value: "House", songCount: 3, albumCount: 2 },
        ]);
    });

    it("indexLetter ignores articles", () => {
        expect(indexLetter("The Chemical Brothers")).toBe("C");
        expect(indexLetter("daft punk")).toBe("D");
        expect(indexLetter("123")).toBe("#");
        expect(indexLetter(null)).toBe("#");
    });
});

describe("search3", () => {
    it("matches title/artist/album substrings, scoped to user", () => {
        const r = search("user-1", "daft", { artistCount: 20, artistOffset: 0, albumCount: 20, albumOffset: 0, songCount: 20, songOffset: 0 });
        expect(r.artists.map((a) => a.artist)).toEqual(["Daft Punk"]);
        expect(r.albums.map((a) => a.album)).toEqual(["Discovery", "Homework"]);
        expect(r.songs).toHaveLength(3);
        expect(r.songs.every((s) => s.user_id === "user-1")).toBe(true);
    });

    it('empty / "" / * query returns everything (offline-sync clients)', () => {
        for (const q of ["", '""', "*"]) {
            const r = search("user-1", q, { artistCount: 20, artistOffset: 0, albumCount: 20, albumOffset: 0, songCount: 2, songOffset: 0 });
            expect(r.artists).toHaveLength(2);
            expect(r.albums).toHaveLength(3);
            expect(r.songs).toHaveLength(2);
        }
        const page2 = search("user-1", "", { artistCount: 0, artistOffset: 0, albumCount: 0, albumOffset: 0, songCount: 2, songOffset: 2 });
        expect(page2.songs).toHaveLength(2);
    });

    it("songToBody has the Subsonic child shape", () => {
        const s = search("user-1", "galvanize", { artistCount: 0, artistOffset: 0, albumCount: 0, albumOffset: 0, songCount: 1, songOffset: 0 }).songs[0]!;
        const body = songToBody(s);
        expect(body).toMatchObject({
            id: trackId(s.id), isDir: false, title: "Galvanize", artist: "The Chemical Brothers", album: "Push the Button",
            albumId: albumId("Push the Button", "The Chemical Brothers"), suffix: "mp3", contentType: "audio/mpeg",
            duration: 200, year: 2005, genre: "Big Beat", type: "music", mediaType: "song",
        });
        expect(body.starred).toBeUndefined();
    });
});

describe("annotate", () => {
    it("star/unstar by song and by album id, setRating", () => {
        const one = sqlite.prepare(`SELECT id FROM tracks WHERE title = 'One More Time'`).get() as { id: number };
        setStarred("user-1", [trackId(one.id)], true);
        expect(starredSongs("user-1").map((s) => s.title)).toEqual(["One More Time"]);
        setStarred("user-1", [albumId("Discovery", "Daft Punk")], true);
        expect(starredSongs("user-1")).toHaveLength(2);
        expect(albumList("user-1", "starred", { size: 10, offset: 0 }).map((a) => a.album)).toEqual(["Discovery"]);
        setStarred("user-1", [albumId("Discovery", "Daft Punk")], false);
        expect(starredSongs("user-1")).toHaveLength(0);

        setRating("user-1", trackId(one.id), 4);
        expect((sqlite.prepare(`SELECT rating FROM tracks WHERE id = ?`).get(one.id) as { rating: number }).rating).toBe(4);
        setRating("user-1", trackId(one.id), 0);
        expect((sqlite.prepare(`SELECT rating FROM tracks WHERE id = ?`).get(one.id) as { rating: number | null }).rating).toBeNull();
    });

    it("refuses to touch another user's track", () => {
        const other = sqlite.prepare(`SELECT id FROM tracks WHERE user_id = 'user-2'`).get() as { id: number };
        expect(() => setRating("user-1", trackId(other.id), 5)).toThrowError(/not found/i);
        setStarred("user-1", [trackId(other.id)], true); // resolves to zero tracks → no-op
        expect((sqlite.prepare(`SELECT is_favorite FROM tracks WHERE id = ?`).get(other.id) as { is_favorite: number }).is_favorite).toBe(0);
    });
});

describe("playlists", () => {
    it("create → get → update (add/remove/rename) → delete", () => {
        const ids = (sqlite.prepare(`SELECT id FROM tracks WHERE user_id = 'user-1' AND is_hidden = 0 ORDER BY id`).all() as Array<{ id: number }>).map((r) => trackId(r.id));
        const otherId = trackId((sqlite.prepare(`SELECT id FROM tracks WHERE user_id = 'user-2'`).get() as { id: number }).id);

        const plId = createPlaylist("user-1", { name: "Mix", songIds: [ids[0]!, ids[1]!, otherId] });
        const pl = getPlaylist("user-1", `pl_${plId}`);
        expect(pl.row.name).toBe("Mix");
        expect(pl.songs.map((s) => trackId(s.id))).toEqual([ids[0], ids[1]]); // foreign track dropped
        expect(listPlaylists("user-1")).toHaveLength(1);
        expect(listPlaylists("user-1")[0]!.track_count).toBe(2);

        updatePlaylist("user-1", `pl_${plId}`, { name: "Mix 2", comment: "c", songIdToAdd: [ids[2]!], songIndexToRemove: [0] });
        const after = getPlaylist("user-1", `pl_${plId}`);
        expect(after.row.name).toBe("Mix 2");
        expect(after.row.description).toBe("c");
        expect(after.songs.map((s) => trackId(s.id))).toEqual([ids[1], ids[2]]);
        expect((sqlite.prepare(`SELECT position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position`).all(plId) as Array<{ position: number }>).map((r) => r.position)).toEqual([1, 2]);

        // createPlaylist with playlistId replaces the contents
        createPlaylist("user-1", { playlistId: `pl_${plId}`, songIds: [ids[3]!] });
        expect(getPlaylist("user-1", `pl_${plId}`).songs.map((s) => trackId(s.id))).toEqual([ids[3]]);

        expect(() => getPlaylist("user-2", `pl_${plId}`)).toThrowError(/not found/i);
        deletePlaylist("user-1", `pl_${plId}`);
        expect(listPlaylists("user-1")).toHaveLength(0);
        expect(sqlite.prepare(`SELECT COUNT(*) AS c FROM playlist_tracks`).get()).toEqual({ c: 0 });
    });

    it("requires name or playlistId", () => {
        expect(() => createPlaylist("user-1", { songIds: [] })).toThrowError(/missing/i);
        expect(decodeId("pl_1")).toEqual({ kind: "playlist", num: 1 });
    });
});
