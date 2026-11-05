/**
 * Browse/search over the library for the Subsonic API.
 *
 * Albums and artists are GROUP BY aggregates over `tracks` (the companion
 * has no album/artist tables). Every query is scoped to one `user_id`
 * (see `resolveUserId`) so the per-user isolation guarantee of `/library`
 * holds here too.
 */

import path from "node:path";
import type Database from "better-sqlite3";
import { getLibrarySqlite } from "../library/db";
import { store } from "../store";
import { albumHash, albumId, artistHash, artistId, trackId, type DecodedId } from "./ids";
import type { Body } from "./response";

export interface TrackRow {
    id: number;
    user_id: string;
    filepath: string;
    filename: string;
    artist: string | null;
    title: string | null;
    album: string | null;
    genre: string | null;
    year: number | null;
    duration: number | null;
    bpm: number | null;
    file_size: number | null;
    format: string | null;
    bitrate: number | null;
    sample_rate: number | null;
    added_at: string | null;
    rating: number | null;
    is_favorite: number | null;
    lyrics: string | null;
    synced_lyrics: string | null;
    comment: string | null;
    artwork_url: string | null;
    musicbrainz_id: string | null;
    play_count?: number | null;
    last_played?: string | null;
}

const TRACK_COLS = `id, user_id, filepath, filename, artist, title, album, genre, year, duration, bpm,
    file_size, format, bitrate, sample_rate, added_at, rating, is_favorite, lyrics, synced_lyrics,
    comment, artwork_url, musicbrainz_id`;

/** Hidden tracks never surface in Subsonic clients. */
const VISIBLE = `COALESCE(is_hidden, 0) = 0`;

let _override: Database.Database | null = null;
/** Tests: point the Subsonic layer at an in-memory sqlite instead of the companion DB. */
export function __setSubsonicDbForTests(sqlite: Database.Database | null): void { _override = sqlite; }
export function db(): Database.Database { return _override ?? getLibrarySqlite(); }

/**
 * Which `user_id` the Subsonic surface serves. The device token is a
 * device-wide secret, so we pick the paired account (`store.userId`) when
 * present; otherwise the single account that owns rows in `tracks`
 * (headless installs are single-user). Returns null when the library is
 * empty and nothing is paired — callers then see an empty library.
 */
export function resolveUserId(): string | null {
    const stored = store.get("userId");
    if (typeof stored === "string" && stored.trim()) return stored.trim();
    const row = db().prepare(
        `SELECT user_id AS uid, COUNT(*) AS c FROM tracks GROUP BY user_id ORDER BY c DESC LIMIT 1`,
    ).get() as { uid: string } | undefined;
    return row?.uid ?? null;
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
    mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", aac: "audio/aac", m4a: "audio/mp4",
    ogg: "audio/ogg", opus: "audio/opus", wma: "audio/x-ms-wma", aiff: "audio/aiff", aif: "audio/aiff",
};

export function suffixOf(row: Pick<TrackRow, "format" | "filepath">): string {
    const s = (row.format ?? path.extname(row.filepath).slice(1)).toLowerCase();
    return s || "mp3";
}

export function mimeOf(row: Pick<TrackRow, "format" | "filepath">): string {
    return MIME[suffixOf(row)] ?? "application/octet-stream";
}

function isoOrUndef(s: string | null | undefined): string | undefined {
    if (!s) return undefined;
    // SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" (UTC). Normalise to ISO.
    const iso = s.includes("T") ? s : s.replace(" ", "T") + (s.endsWith("Z") ? "" : "Z");
    return Number.isNaN(Date.parse(iso)) ? undefined : new Date(iso).toISOString();
}

export function songToBody(row: TrackRow): Body {
    const artist = row.artist ?? undefined;
    const album = row.album ?? undefined;
    const title = row.title ?? row.filename.replace(/\.[^.]+$/, "");
    const body: Body = {
        id: trackId(row.id),
        parent: albumId(row.album, row.artist),
        isDir: false,
        title,
        album,
        artist,
        albumId: albumId(row.album, row.artist),
        artistId: artist ? artistId(row.artist) : undefined,
        coverArt: trackId(row.id),
        duration: row.duration ?? undefined,
        bitRate: row.bitrate ?? undefined,
        samplingRate: row.sample_rate ?? undefined,
        year: row.year ?? undefined,
        genre: row.genre ?? undefined,
        size: row.file_size ?? undefined,
        suffix: suffixOf(row),
        contentType: mimeOf(row),
        path: `${row.artist ?? "Unknown Artist"}/${row.album ?? "Unknown Album"}/${row.filename}`,
        created: isoOrUndef(row.added_at),
        type: "music",
        mediaType: "song",
        userRating: row.rating ?? undefined,
        starred: row.is_favorite ? isoOrUndef(row.added_at) ?? new Date(0).toISOString() : undefined,
        bpm: row.bpm != null ? Math.round(row.bpm) : undefined,
        comment: row.comment ?? undefined,
        musicBrainzId: row.musicbrainz_id ?? undefined,
        playCount: row.play_count ?? undefined,
        played: isoOrUndef(row.last_played ?? null),
    };
    if (row.genre) body.genres = [{ name: row.genre }];
    return body;
}

interface AlbumAgg {
    album: string | null;
    artist: string | null;
    song_count: number;
    duration: number;
    year: number | null;
    genre: string | null;
    created: string | null;
    starred: number;
    first_track: number;
    play_count: number | null;
}

interface ArtistAgg {
    artist: string | null;
    album_count: number;
    song_count: number;
    starred: number;
    first_track: number;
}

export function albumToBody(a: AlbumAgg, opts: { withSongs?: TrackRow[] } = {}): Body {
    const name = a.album ?? "Unknown Album";
    const artist = a.artist ?? "Unknown Artist";
    const body: Body = {
        id: albumId(a.album, a.artist),
        parent: artistId(a.artist),
        isDir: true,
        name,
        title: name,
        album: name,
        artist,
        artistId: artistId(a.artist),
        coverArt: albumId(a.album, a.artist),
        songCount: a.song_count,
        duration: a.duration,
        year: a.year ?? undefined,
        genre: a.genre ?? undefined,
        created: isoOrUndef(a.created),
        starred: a.starred ? isoOrUndef(a.created) : undefined,
        playCount: a.play_count ?? undefined,
        mediaType: "album",
    };
    if (a.genre) body.genres = [{ name: a.genre }];
    if (opts.withSongs) body.song = opts.withSongs.map(songToBody);
    return body;
}

export function artistToBody(a: ArtistAgg, opts: { withAlbums?: AlbumAgg[] } = {}): Body {
    const name = a.artist ?? "Unknown Artist";
    const body: Body = {
        id: artistId(a.artist),
        name,
        coverArt: trackId(a.first_track),
        albumCount: a.album_count,
        starred: a.starred ? new Date(0).toISOString() : undefined,
        mediaType: "artist",
    };
    if (opts.withAlbums) body.album = opts.withAlbums.map((al) => albumToBody(al));
    return body;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

const ALBUM_SELECT = `
    SELECT album, artist,
           COUNT(*) AS song_count,
           COALESCE(SUM(duration), 0) AS duration,
           MAX(year) AS year,
           MIN(genre) AS genre,
           MIN(added_at) AS created,
           MAX(COALESCE(is_favorite, 0)) AS starred,
           MIN(id) AS first_track,
           NULL AS play_count
    FROM tracks
    WHERE user_id = ? AND ${VISIBLE}`;

const ARTIST_SELECT = `
    SELECT artist,
           COUNT(DISTINCT LOWER(COALESCE(album, ''))) AS album_count,
           COUNT(*) AS song_count,
           MAX(COALESCE(is_favorite, 0)) AS starred,
           MIN(id) AS first_track
    FROM tracks
    WHERE user_id = ? AND ${VISIBLE}`;

// Album/artist hashes are computed in JS (SQLite has no sha1), so lookups
// by hash filter the aggregated list in JS — album counts are small
// compared to track counts.
export function listAlbums(userId: string): AlbumAgg[] {
    return db().prepare(`${ALBUM_SELECT} GROUP BY LOWER(COALESCE(album,'')), LOWER(COALESCE(artist,''))`).all(userId) as AlbumAgg[];
}

export function listArtists(userId: string): ArtistAgg[] {
    return db().prepare(`${ARTIST_SELECT} GROUP BY LOWER(COALESCE(artist,'')) ORDER BY LOWER(COALESCE(artist,''))`).all(userId) as ArtistAgg[];
}

export function findAlbumByHash(userId: string, hash: string): AlbumAgg | null {
    for (const a of listAlbums(userId)) if (albumHash(a.album, a.artist) === hash) return a;
    return null;
}

export function findArtistByHash(userId: string, hash: string): ArtistAgg | null {
    for (const a of listArtists(userId)) if (artistHash(a.artist) === hash) return a;
    return null;
}

export function albumsOfArtist(userId: string, artist: string | null): AlbumAgg[] {
    return db().prepare(
        `${ALBUM_SELECT} AND LOWER(COALESCE(artist,'')) = LOWER(COALESCE(?, ''))
         GROUP BY LOWER(COALESCE(album,'')), LOWER(COALESCE(artist,'')) ORDER BY year, LOWER(COALESCE(album,''))`,
    ).all(userId, artist) as AlbumAgg[];
}

export function songsOfAlbum(userId: string, album: string | null, artist: string | null): TrackRow[] {
    return db().prepare(
        `SELECT ${TRACK_COLS} FROM tracks
         WHERE user_id = ? AND ${VISIBLE}
           AND LOWER(COALESCE(album,'')) = LOWER(COALESCE(?, ''))
           AND LOWER(COALESCE(artist,'')) = LOWER(COALESCE(?, ''))
         ORDER BY filename`,
    ).all(userId, album, artist) as TrackRow[];
}

export function getTrack(userId: string, id: number): TrackRow | null {
    return (db().prepare(`SELECT ${TRACK_COLS} FROM tracks WHERE user_id = ? AND id = ?`).get(userId, id) as TrackRow | undefined) ?? null;
}

export function getTracks(userId: string, ids: number[]): TrackRow[] {
    if (ids.length === 0) return [];
    const marks = ids.map(() => "?").join(",");
    return db().prepare(`SELECT ${TRACK_COLS} FROM tracks WHERE user_id = ? AND id IN (${marks})`).all(userId, ...ids) as TrackRow[];
}

export type AlbumListType =
    | "random" | "newest" | "alphabeticalByName" | "alphabeticalByArtist"
    | "frequent" | "recent" | "starred" | "byGenre" | "byYear" | "highest";

export function albumList(userId: string, type: AlbumListType, opts: {
    size: number; offset: number; genre?: string; fromYear?: number; toYear?: number;
}): AlbumAgg[] {
    let all = listAlbums(userId);
    const byName = (a: AlbumAgg, b: AlbumAgg) => (a.album ?? "").localeCompare(b.album ?? "", undefined, { sensitivity: "base" });
    const byArtist = (a: AlbumAgg, b: AlbumAgg) => (a.artist ?? "").localeCompare(b.artist ?? "", undefined, { sensitivity: "base" }) || byName(a, b);
    switch (type) {
        case "random":
            for (let i = all.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [all[i], all[j]] = [all[j]!, all[i]!];
            }
            break;
        case "newest":
        case "recent":
        case "frequent":
        case "highest":
            // No play statistics column exists → fall back to newest-first.
            all.sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
            break;
        case "alphabeticalByName": all.sort(byName); break;
        case "alphabeticalByArtist": all.sort(byArtist); break;
        case "starred": all = all.filter((a) => a.starred).sort(byName); break;
        case "byGenre": {
            const g = (opts.genre ?? "").toLowerCase();
            all = all.filter((a) => (a.genre ?? "").toLowerCase() === g).sort(byName);
            break;
        }
        case "byYear": {
            const from = opts.fromYear ?? -Infinity;
            const to = opts.toYear ?? Infinity;
            const [lo, hi] = from <= to ? [from, to] : [to, from];
            all = all.filter((a) => a.year != null && a.year >= lo && a.year <= hi);
            all.sort((a, b) => from <= to ? (a.year! - b.year!) : (b.year! - a.year!));
            break;
        }
    }
    return all.slice(opts.offset, opts.offset + opts.size);
}

export function randomSongs(userId: string, opts: { size: number; genre?: string; fromYear?: number; toYear?: number }): TrackRow[] {
    const conds = [`user_id = ?`, VISIBLE];
    const params: unknown[] = [userId];
    if (opts.genre) { conds.push(`LOWER(genre) = LOWER(?)`); params.push(opts.genre); }
    if (opts.fromYear != null) { conds.push(`year >= ?`); params.push(opts.fromYear); }
    if (opts.toYear != null) { conds.push(`year <= ?`); params.push(opts.toYear); }
    params.push(opts.size);
    return db().prepare(`SELECT ${TRACK_COLS} FROM tracks WHERE ${conds.join(" AND ")} ORDER BY RANDOM() LIMIT ?`).all(...params) as TrackRow[];
}

export function songsByGenre(userId: string, genre: string, size: number, offset: number): TrackRow[] {
    return db().prepare(
        `SELECT ${TRACK_COLS} FROM tracks WHERE user_id = ? AND ${VISIBLE} AND LOWER(genre) = LOWER(?)
         ORDER BY LOWER(COALESCE(artist,'')), LOWER(COALESCE(album,'')), filename LIMIT ? OFFSET ?`,
    ).all(userId, genre, size, offset) as TrackRow[];
}

export function genres(userId: string): Array<{ value: string; songCount: number; albumCount: number }> {
    const rows = db().prepare(
        `SELECT genre, COUNT(*) AS song_count, COUNT(DISTINCT LOWER(COALESCE(album,'')) || '|' || LOWER(COALESCE(artist,''))) AS album_count
         FROM tracks WHERE user_id = ? AND ${VISIBLE} AND genre IS NOT NULL AND genre != ''
         GROUP BY LOWER(genre) ORDER BY LOWER(genre)`,
    ).all(userId) as Array<{ genre: string; song_count: number; album_count: number }>;
    return rows.map((r) => ({ value: r.genre, songCount: r.song_count, albumCount: r.album_count }));
}

export function starredSongs(userId: string): TrackRow[] {
    return db().prepare(
        `SELECT ${TRACK_COLS} FROM tracks WHERE user_id = ? AND ${VISIBLE} AND is_favorite = 1 ORDER BY added_at DESC`,
    ).all(userId) as TrackRow[];
}

export interface SearchResult { artists: ArtistAgg[]; albums: AlbumAgg[]; songs: TrackRow[] }

export function search(userId: string, query: string, opts: {
    artistCount: number; artistOffset: number; albumCount: number; albumOffset: number; songCount: number; songOffset: number;
}): SearchResult {
    // Clients (Symfonium, DSub) send `""` or `*` to mean "everything" when
    // syncing offline libraries.
    const q = query.trim().replace(/^"+|"+$/g, "");
    const all = q === "" || q === "*";
    const like = `%${q.toLowerCase()}%`;
    const artists = listArtists(userId)
        .filter((a) => all || (a.artist ?? "").toLowerCase().includes(q.toLowerCase()))
        .slice(opts.artistOffset, opts.artistOffset + opts.artistCount);
    const albums = listAlbums(userId)
        .filter((a) => all || (a.album ?? "").toLowerCase().includes(q.toLowerCase()) || (a.artist ?? "").toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => (a.album ?? "").localeCompare(b.album ?? "", undefined, { sensitivity: "base" }))
        .slice(opts.albumOffset, opts.albumOffset + opts.albumCount);
    const songs = all
        ? db().prepare(`SELECT ${TRACK_COLS} FROM tracks WHERE user_id = ? AND ${VISIBLE} ORDER BY id LIMIT ? OFFSET ?`)
            .all(userId, opts.songCount, opts.songOffset) as TrackRow[]
        : db().prepare(
            `SELECT ${TRACK_COLS} FROM tracks WHERE user_id = ? AND ${VISIBLE}
               AND (LOWER(COALESCE(title,'')) LIKE ? OR LOWER(COALESCE(artist,'')) LIKE ? OR LOWER(COALESCE(album,'')) LIKE ? OR LOWER(filename) LIKE ?)
             ORDER BY LOWER(COALESCE(title,'')) LIMIT ? OFFSET ?`,
        ).all(userId, like, like, like, like, opts.songCount, opts.songOffset) as TrackRow[];
    return { artists, albums, songs };
}

/** Resolve a decoded id to the track rows it covers (album/artist → all songs). */
export function tracksForId(userId: string, d: DecodedId): TrackRow[] {
    switch (d.kind) {
        case "track": { const t = getTrack(userId, d.num!); return t ? [t] : []; }
        case "album": {
            const a = findAlbumByHash(userId, d.hash!);
            return a ? songsOfAlbum(userId, a.album, a.artist) : [];
        }
        case "artist": {
            const a = findArtistByHash(userId, d.hash!);
            if (!a) return [];
            return db().prepare(
                `SELECT ${TRACK_COLS} FROM tracks WHERE user_id = ? AND ${VISIBLE} AND LOWER(COALESCE(artist,'')) = LOWER(COALESCE(?, ''))`,
            ).all(userId, a.artist) as TrackRow[];
        }
        default: return [];
    }
}

/** Index letter for getIndexes/getArtists grouping ("The X" → "X"). */
export function indexLetter(name: string | null): string {
    const n = (name ?? "").replace(/^(the|a|an)\s+/i, "").trim();
    const ch = n.charAt(0).toUpperCase();
    if (!ch) return "#";
    return /[A-Z]/.test(ch) ? ch : /\p{L}/u.test(ch) ? ch : "#";
}

export type { AlbumAgg, ArtistAgg };
