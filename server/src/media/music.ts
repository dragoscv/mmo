/**
 * Music browse service for TV / web clients (WP16-11).
 *
 * JSON view over the companion library (`tracks`) that reuses the Subsonic
 * aggregation layer (`../subsonic/browse`) so every id here is the SAME id
 * the OpenSubsonic API serves: `tr_<n>` tracks, `al_<hash>` albums,
 * `ar_<hash>` artists, `pl_<n>` playlists. Clients therefore call
 * `/rest/getCoverArt.view` and `/rest/stream.view` with ids from here.
 *
 * Plays come from `media.sqlite` `track_plays` (per profile). The track key
 * written there is free-form (POST /media/plays); accepted forms are listed
 * in `parseTrackKey`. The per-profile queue lives in `music_queue`, created
 * lazily here (no media db migration).
 *
 * Lyrics: stored tags / analyzer LRCLIB result first, then a `.lrc` sidecar; only when both are missing does
 * `lyricsAsync` ask LRCLIB once (injectable `fetchLyrics`), persisting hits and caching misses for a day.
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { MediaDb } from "./db";
import {
    albumList, albumsOfArtist, db as subsonicDb, findAlbumByHash, findArtistByHash, genres as subsonicGenres,
    getTrack, getTracks, indexLetter, listAlbums, listArtists, resolveUserId, songsOfAlbum, suffixOf, tracksForId,
    type AlbumAgg, type ArtistAgg, type TrackRow,
} from "../subsonic/browse";
import { getPlaylist, listPlaylists } from "../subsonic/playlists";
import { albumId, artistId, decodeId, playlistId, trackId } from "../subsonic/ids";

// ─── Public shapes ───────────────────────────────────────────────────────────

export interface AlbumCard {
    id: string;
    name: string;
    artist: string;
    artistId: string;
    year: number | null;
    genre: string | null;
    songCount: number;
    durationSec: number;
    coverArt: string;
    coverUrlPath: string;
}

export interface TrackCard {
    id: string;
    title: string;
    artist: string | null;
    artistId: string | null;
    album: string | null;
    albumId: string;
    track: number | null;
    disc: number | null;
    year: number | null;
    genre: string | null;
    durationSec: number;
    format: string;
    bitrate: number | null;
    sampleRate: number | null;
    hasLyrics: boolean;
    hasSyncedLyrics: boolean;
    plays?: number;
    /** EBU R128 integrated loudness (LUFS) and true peak (dBFS); present once analysed. Clients derive playback gain. */
    loudnessLufs?: number;
    truePeakDbfs?: number;
    coverArt: string;
    coverUrlPath: string;
    streamUrlPath: string;
}

export interface ArtistCard {
    id: string;
    name: string;
    albumCount: number;
    songCount: number;
    coverArt: string;
    coverUrlPath: string;
}

export interface PlaylistCard {
    id: string;
    name: string;
    songCount: number;
    durationSec: number;
    coverArt: string | null;
    coverUrlPath: string | null;
}

export interface GenreCard { name: string; songCount: number; albumCount: number }

export interface MusicHome {
    profileId: string;
    recent: AlbumCard[];
    newest: AlbumCard[];
    mostPlayed: TrackCard[];
    playlists: PlaylistCard[];
    genres: GenreCard[];
    randomAlbums: AlbumCard[];
}

export interface Page<T> { total: number; offset: number; limit: number; items: T[] }

export interface ArtistDetail {
    artist: ArtistCard;
    albums: AlbumCard[];
    topTracks: TrackCard[];
    similar: ArtistCard[];
}

export interface AlbumDetail { album: AlbumCard; tracks: TrackCard[] }

export interface SearchResult { query: string; artists: ArtistCard[]; albums: AlbumCard[]; tracks: TrackCard[] }

export type RepeatMode = "off" | "all" | "one";

export interface MusicQueue {
    profileId: string;
    trackIds: string[];
    index: number;
    positionSec: number;
    shuffle: boolean;
    repeat: RepeatMode;
    updatedAt: number;
}

export interface LyricLine { timeMs: number; text: string }
export interface LyricsResult {
    trackId: string;
    synced: LyricLine[] | null;
    plain: string | null;
    /** `embedded` = stored on the track row (tags or LRCLIB, filled by the analyzer). */
    source: "embedded" | "sidecar" | "lrclib" | "none";
}

export class MusicError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
}

export interface MusicServiceDeps {
    /** Library sqlite (`getLibrarySqlite()` in production). Must be the same DB the Subsonic layer reads. */
    getLibraryDb?: () => Database.Database;
    /** media.sqlite (track_plays + music_queue). */
    mediaDb: MediaDb;
    /** Library owner whose tracks are served; defaults to the Subsonic `resolveUserId()`. */
    getUserId?: () => string | null;
    now?: () => number;
    /** LRCLIB lookup for on-demand lyrics (production: `getLyrics` from library/metadata-services). */
    fetchLyrics?: (artist: string, title: string, album: string | null, durationSec: number | null) =>
        Promise<{ plainLyrics: string | null; syncedLyrics: string | null } | null>;
}

export const MAX_QUEUE = 2000;
const DAY_MS = 86_400_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

export const coverUrlPath = (coverArt: string): string => `/rest/getCoverArt.view?id=${encodeURIComponent(coverArt)}&size=400`;
export const streamUrlPath = (id: string): string => `/rest/stream.view?id=${encodeURIComponent(id)}`;

/** Lowercase + strip diacritics (Romanian ă â î ș ț ş ţ and any other combining mark). */
export function fold(s: string | null | undefined): string {
    return (s ?? "")
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .replace(/[ßẞ]/g, "ss")
        .toLowerCase()
        .trim();
}

/**
 * Track keys accepted in `track_plays.track_key`:
 *   `tr_42` / `subsonic:tr_42`   Subsonic id
 *   `<server>:track:42`          server-scoped companion id
 *   `42`                         bare companion track id (web player)
 *   `sha256:<64 hex>`            content hash (cloud sync key)
 */
export function parseTrackKey(key: string): { id: number } | { sha256: string } | null {
    const k = key.trim();
    let m = /^(?:subsonic:)?tr_(\d+)$/i.exec(k) ?? /^(?:[^:]*:)?track:(\d+)$/i.exec(k) ?? /^(\d+)$/.exec(k);
    if (m) {
        const n = Number(m[1]);
        return Number.isSafeInteger(n) && n > 0 ? { id: n } : null;
    }
    m = /^sha256:([0-9a-f]{64})$/i.exec(k);
    return m ? { sha256: m[1]!.toLowerCase() } : null;
}

/** "1-03 Title.mp3" → disc 1 track 3; "07 - Title.flac" → track 7. Library has no track-number column. */
export function trackNumbersFromFilename(filename: string): { track: number | null; disc: number | null } {
    const dm = /^(\d{1,2})[-.](\d{1,3})(?=[\s_.-])/.exec(filename);
    if (dm) return { disc: Number(dm[1]), track: Number(dm[2]) };
    const tm = /^(\d{1,3})(?=\s*[-_.\s])/.exec(filename);
    if (tm && !/^\d{1,3}\.[a-z0-9]{2,4}$/i.test(filename)) return { disc: null, track: Number(tm[1]) };
    return { disc: null, track: null };
}

/**
 * LRC parser: `[mm:ss]`, `[mm:ss.xx]`, `[mm:ss:xx]`, several stamps per line,
 * `[offset:+/-ms]` (positive = lyrics earlier). Metadata tags are skipped.
 * Returns null when no timed line was found.
 */
export function parseLrc(text: string): LyricLine[] | null {
    let offset = 0;
    const om = /^\s*\[offset:\s*([+-]?\d+)\s*\]/im.exec(text);
    if (om) offset = Number(om[1]) || 0;
    const out: LyricLine[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const m = /^((?:\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+)(.*)$/.exec(raw.trim());
        if (!m) continue;
        const value = m[2]!.trim();
        for (const ts of m[1]!.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)) {
            const fracRaw = ts[3] ?? "0";
            const ms = (Number(ts[1]) * 60 + Number(ts[2])) * 1000 + Math.round((Number(fracRaw) / Math.pow(10, fracRaw.length)) * 1000);
            out.push({ timeMs: Math.max(0, ms - offset), text: value });
        }
    }
    if (out.length === 0) return null;
    out.sort((a, b) => a.timeMs - b.timeMs);
    return out;
}

function albumCard(a: AlbumAgg): AlbumCard {
    const id = albumId(a.album, a.artist);
    return {
        id,
        name: a.album ?? "Unknown Album",
        artist: a.artist ?? "Unknown Artist",
        artistId: artistId(a.artist),
        year: a.year ?? null,
        genre: a.genre ?? null,
        songCount: a.song_count,
        durationSec: a.duration ?? 0,
        coverArt: id,
        coverUrlPath: coverUrlPath(id),
    };
}

function artistCard(a: ArtistAgg): ArtistCard {
    const cover = trackId(a.first_track);
    return {
        id: artistId(a.artist),
        name: a.artist ?? "Unknown Artist",
        albumCount: a.album_count,
        songCount: a.song_count,
        coverArt: cover,
        coverUrlPath: coverUrlPath(cover),
    };
}

function trackCard(r: TrackRow, plays?: number): TrackCard {
    const id = trackId(r.id);
    const { track, disc } = trackNumbersFromFilename(r.filename);
    const card: TrackCard = {
        id,
        title: r.title ?? r.filename.replace(/\.[^.]+$/, ""),
        artist: r.artist ?? null,
        artistId: r.artist ? artistId(r.artist) : null,
        album: r.album ?? null,
        albumId: albumId(r.album, r.artist),
        track,
        disc,
        year: r.year ?? null,
        genre: r.genre ?? null,
        durationSec: r.duration ?? 0,
        format: suffixOf(r),
        bitrate: r.bitrate ?? null,
        sampleRate: r.sample_rate ?? null,
        hasLyrics: !!(r.lyrics && r.lyrics.trim()),
        hasSyncedLyrics: !!(r.synced_lyrics && r.synced_lyrics.trim()),
        coverArt: id,
        coverUrlPath: coverUrlPath(id),
        streamUrlPath: streamUrlPath(id),
    };
    if (plays !== undefined) card.plays = plays;
    if (typeof r.loudness_lufs === "number" && Number.isFinite(r.loudness_lufs)) card.loudnessLufs = r.loudness_lufs;
    if (typeof r.loudness_true_peak_dbfs === "number" && Number.isFinite(r.loudness_true_peak_dbfs)) card.truePeakDbfs = r.loudness_true_peak_dbfs;
    return card;
}

const clampInt = (v: number | undefined, lo: number, hi: number, dflt: number): number =>
    v === undefined || !Number.isFinite(v) ? dflt : Math.max(lo, Math.min(hi, Math.trunc(v)));

// ─── Service ─────────────────────────────────────────────────────────────────

export class MusicService {
    private readonly lib: () => Database.Database;
    private readonly media: MediaDb;
    private readonly userId: () => string | null;
    private readonly now: () => number;
    private readonly fetchLyrics: MusicServiceDeps["fetchLyrics"];
    /** track id → time of the last LRCLIB miss (no lookup again for a day). */
    private readonly lyricsMiss = new Map<number, number>();
    private queueReady = false;

    constructor(deps: MusicServiceDeps) {
        this.lib = deps.getLibraryDb ?? subsonicDb;
        this.media = deps.mediaDb;
        this.userId = deps.getUserId ?? resolveUserId;
        this.now = deps.now ?? Date.now;
        this.fetchLyrics = deps.fetchLyrics;
    }

    // ── plays ────────────────────────────────────────────────────────────────

    /** Resolve raw track keys → companion track ids (sha256 keys need a lookup). */
    private resolveKeys(keys: string[]): Map<string, number> {
        const out = new Map<string, number>();
        const shas = new Map<string, string[]>();
        for (const k of keys) {
            const p = parseTrackKey(k);
            if (!p) continue;
            if ("id" in p) out.set(k, p.id);
            else shas.set(p.sha256, [...(shas.get(p.sha256) ?? []), k]);
        }
        const uid = this.userId();
        if (shas.size > 0 && uid) {
            try {
                const hashes = [...shas.keys()];
                for (let i = 0; i < hashes.length; i += 500) {
                    const chunk = hashes.slice(i, i + 500);
                    const rows = this.lib()
                        .prepare(`SELECT id, LOWER(sha256) AS sha FROM tracks WHERE user_id = ? AND LOWER(sha256) IN (${chunk.map(() => "?").join(",")})`)
                        .all(uid, ...chunk) as { id: number; sha: string }[];
                    for (const r of rows) for (const k of shas.get(r.sha) ?? []) out.set(k, r.id);
                }
            } catch { /* legacy DB without sha256 column */ }
        }
        return out;
    }

    /** track id → play count (optionally one profile, optionally since a timestamp). */
    playCounts(opts: { profileId?: string; sinceMs?: number } = {}): Map<number, number> {
        const where: string[] = [];
        const args: (string | number)[] = [];
        if (opts.profileId) { where.push("profile_id = ?"); args.push(opts.profileId); }
        if (opts.sinceMs !== undefined) { where.push("played_at >= ?"); args.push(opts.sinceMs); }
        const rows = this.media
            .prepare(`SELECT track_key AS k, COUNT(*) AS c FROM track_plays ${where.length ? "WHERE " + where.join(" AND ") : ""} GROUP BY track_key`)
            .all(...args) as { k: string; c: number }[];
        const ids = this.resolveKeys(rows.map((r) => r.k));
        const out = new Map<number, number>();
        for (const r of rows) {
            const id = ids.get(r.k);
            if (id !== undefined) out.set(id, (out.get(id) ?? 0) + r.c);
        }
        return out;
    }

    private albumIndex(uid: string): Map<string, AlbumAgg> {
        const m = new Map<string, AlbumAgg>();
        for (const a of listAlbums(uid)) m.set(albumId(a.album, a.artist), a);
        return m;
    }

    // ── home ─────────────────────────────────────────────────────────────────

    home(profileId: string): MusicHome {
        const empty: MusicHome = { profileId, recent: [], newest: [], mostPlayed: [], playlists: [], genres: [], randomAlbums: [] };
        const uid = this.userId();
        if (!uid) return empty;
        const albums = this.albumIndex(uid);

        // recent: albums of the latest plays, newest first, deduped
        const recentPlays = this.media
            .prepare("SELECT track_key AS k FROM track_plays WHERE profile_id = ? ORDER BY played_at DESC LIMIT 300")
            .all(profileId) as { k: string }[];
        const keyIds = this.resolveKeys([...new Set(recentPlays.map((p) => p.k))]);
        const rowsById = new Map(getTracks(uid, [...new Set(keyIds.values())]).map((t) => [t.id, t]));
        const recent: AlbumCard[] = [];
        const seen = new Set<string>();
        for (const p of recentPlays) {
            const id = keyIds.get(p.k);
            const t = id !== undefined ? rowsById.get(id) : undefined;
            if (!t) continue;
            const aid = albumId(t.album, t.artist);
            const agg = albums.get(aid);
            if (!agg || seen.has(aid)) continue;
            seen.add(aid);
            recent.push(albumCard(agg));
            if (recent.length >= 20) break;
        }

        // most played tracks in the last 30 days (this profile)
        const counts = this.playCounts({ profileId, sinceMs: this.now() - 30 * DAY_MS });
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
        const topRows = new Map(getTracks(uid, top.map(([id]) => id)).map((t) => [t.id, t]));
        const mostPlayed: TrackCard[] = [];
        for (const [id, c] of top) {
            const t = topRows.get(id);
            if (t) mostPlayed.push(trackCard(t, c));
            if (mostPlayed.length >= 20) break;
        }

        return {
            profileId,
            recent,
            newest: albumList(uid, "newest", { size: 20, offset: 0 }).map(albumCard),
            mostPlayed,
            playlists: this.playlists(uid),
            genres: this.genres(),
            randomAlbums: albumList(uid, "random", { size: 20, offset: 0 }).map(albumCard),
        };
    }

    /** Every playlist of the library owner (Library → Playlists). */
    playlistsList(): PlaylistCard[] {
        const uid = this.userId();
        return uid ? this.playlists(uid) : [];
    }

    private playlists(uid: string): PlaylistCard[] {
        const first = this.lib().prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position LIMIT 1");
        return listPlaylists(uid).map((p) => {
            const f = first.get(p.id) as { track_id: number } | undefined;
            const cover = f ? trackId(f.track_id) : null;
            return {
                id: playlistId(p.id), name: p.name, songCount: p.track_count, durationSec: p.duration ?? 0,
                coverArt: cover, coverUrlPath: cover ? coverUrlPath(cover) : null,
            };
        });
    }

    // ── browse ───────────────────────────────────────────────────────────────

    artists(opts: { letter?: string; offset?: number; limit?: number } = {}): Page<ArtistCard> {
        const offset = clampInt(opts.offset, 0, 1_000_000, 0);
        const limit = clampInt(opts.limit, 1, 500, 100);
        const uid = this.userId();
        if (!uid) return { total: 0, offset, limit, items: [] };
        let all = listArtists(uid);
        const letter = opts.letter?.trim().toUpperCase();
        if (letter) all = all.filter((a) => fold(indexLetter(a.artist)).toUpperCase() === fold(letter).toUpperCase());
        return { total: all.length, offset, limit, items: all.slice(offset, offset + limit).map(artistCard) };
    }

    artist(id: string): ArtistDetail {
        const d = decodeId(id);
        const uid = this.userId();
        if (!d || d.kind !== "artist" || !uid) throw new MusicError(404, "artist not found");
        const a = findArtistByHash(uid, d.hash!);
        if (!a) throw new MusicError(404, "artist not found");

        const albums = albumsOfArtist(uid, a.artist)
            .sort((x, y) => (x.year ?? 99999) - (y.year ?? 99999) || (x.album ?? "").localeCompare(y.album ?? ""))
            .map(albumCard);

        const counts = this.playCounts();
        const topTracks = tracksForId(uid, d)
            .map((t) => ({ t, c: counts.get(t.id) ?? 0 }))
            .sort((x, y) => y.c - x.c || (x.t.title ?? x.t.filename).localeCompare(y.t.title ?? y.t.filename))
            .slice(0, 10)
            .map(({ t, c }) => trackCard(t, c));

        const similar = this.similarArtists(uid, a.artist).slice(0, 10).map(artistCard);

        return { artist: artistCard(a), albums, topTracks, similar };
    }

    /** Other artists ranked by shared genres, then song count (keys folded in JS: SQLite LOWER() is ASCII-only). */
    private similarArtists(uid: string, artist: string | null): ArtistAgg[] {
        const raw = this.lib().prepare(
            `SELECT DISTINCT COALESCE(artist,'') AS a, genre AS g FROM tracks
             WHERE user_id = ? AND COALESCE(is_hidden, 0) = 0 AND genre IS NOT NULL AND genre != ''`,
        ).all(uid) as { a: string; g: string }[];
        const pairs = [...new Set(raw.map((p) => `${p.a.toLowerCase()}\u0000${p.g.toLowerCase()}`))].map((s) => {
            const [pa, pg] = s.split("\u0000");
            return { a: pa!, g: pg! };
        });
        const me = (artist ?? "").toLowerCase();
        const myGenres = new Set(pairs.filter((p) => p.a === me).map((p) => p.g));
        const score = new Map<string, number>();
        for (const p of pairs) if (p.a !== me && myGenres.has(p.g)) score.set(p.a, (score.get(p.a) ?? 0) + 1);
        return listArtists(uid)
            .filter((x) => score.has((x.artist ?? "").toLowerCase()))
            .sort((x, y) => score.get((y.artist ?? "").toLowerCase())! - score.get((x.artist ?? "").toLowerCase())! || y.song_count - x.song_count);
    }

    /**
     * Radio from a seed (`tr_`, `al_`, `ar_`): the seed first (when a track), then the seed artist's songs mixed
     * with up to 12 similar artists (most-played first per artist), interleaved so no artist plays twice in a row
     * when avoidable. Deterministic order apart from the per-artist shuffle (`rand` injectable for tests).
     */
    radio(seed: string, size?: number, rand: () => number = Math.random): { seed: string; tracks: TrackCard[] } {
        const uid = this.userId();
        const d = decodeId(seed);
        if (!uid || !d || !["track", "album", "artist"].includes(d.kind)) throw new MusicError(404, "seed not found");
        const seedTracks = tracksForId(uid, d);
        if (seedTracks.length === 0) throw new MusicError(404, "seed not found");
        const n = clampInt(size, 1, 200, 50);
        const seedArtist = seedTracks[0]!.artist;
        const artists = [seedArtist, ...this.similarArtists(uid, seedArtist).slice(0, 12).map((a) => a.artist)];
        const counts = this.playCounts();
        const shuffle = <T>(xs: T[]): T[] => {
            const a = [...xs];
            for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
            return a;
        };
        const pools = artists.map((name) => {
            const rows = this.lib().prepare(
                `SELECT id FROM tracks WHERE user_id = ? AND COALESCE(is_hidden, 0) = 0 AND LOWER(COALESCE(artist,'')) = LOWER(COALESCE(?, ''))`,
            ).all(uid, name) as { id: number }[];
            const shuffled = shuffle(rows.map((r) => r.id));
            return shuffled.sort((x, y) => (counts.get(y) ?? 0) - (counts.get(x) ?? 0));
        });
        const out: number[] = [];
        const seen = new Set<number>();
        if (d.kind === "track") { out.push(seedTracks[0]!.id); seen.add(seedTracks[0]!.id); }
        for (let round = 0; out.length < n && pools.some((p) => p.length > 0); round++) {
            for (const p of pools) {
                while (p.length > 0) {
                    const id = p.shift()!;
                    if (seen.has(id)) continue;
                    seen.add(id); out.push(id);
                    break;
                }
                if (out.length >= n) break;
            }
        }
        const byId = new Map(getTracks(uid, out).map((t) => [t.id, t]));
        return { seed, tracks: out.map((i) => byId.get(i)).filter((t): t is TrackRow => !!t).map((t) => trackCard(t, counts.get(t.id) ?? 0)) };
    }

    /** All songs A–Z by title, paged (Library → Songs). */
    tracks(opts: { offset?: number; limit?: number } = {}): Page<TrackCard> {
        const offset = clampInt(opts.offset, 0, 1_000_000, 0);
        const limit = clampInt(opts.limit, 1, 500, 100);
        const uid = this.userId();
        if (!uid) return { total: 0, offset, limit, items: [] };
        const all = this.lib().prepare(
            `SELECT id, COALESCE(title, filename) AS t FROM tracks WHERE user_id = ? AND COALESCE(is_hidden, 0) = 0`,
        ).all(uid) as { id: number; t: string }[];
        all.sort((x, y) => x.t.localeCompare(y.t, undefined, { sensitivity: "base" }) || x.id - y.id);
        const page = all.slice(offset, offset + limit).map((r) => r.id);
        const byId = new Map(getTracks(uid, page).map((t) => [t.id, t]));
        return { total: all.length, offset, limit, items: page.map((i) => byId.get(i)).filter((t): t is TrackRow => !!t).map((t) => trackCard(t)) };
    }

    album(id: string): AlbumDetail {
        const d = decodeId(id);
        const uid = this.userId();
        if (!d || d.kind !== "album" || !uid) throw new MusicError(404, "album not found");
        const a = findAlbumByHash(uid, d.hash!);
        if (!a) throw new MusicError(404, "album not found");
        const tracks = songsOfAlbum(uid, a.album, a.artist)
            .map((t) => trackCard(t))
            .sort((x, y) => (x.disc ?? 1) - (y.disc ?? 1) || (x.track ?? 9999) - (y.track ?? 9999));
        return { album: albumCard(a), tracks };
    }

    genres(): GenreCard[] {
        const uid = this.userId();
        if (!uid) return [];
        return subsonicGenres(uid).map((g) => ({ name: g.value, songCount: g.songCount, albumCount: g.albumCount }));
    }

    /** Tracks of one playlist, in playlist order (404 when it is not this library owner's). */
    playlist(id: string): { playlist: PlaylistCard; tracks: TrackCard[] } {
        const uid = this.userId();
        if (!uid) throw new MusicError(404, "playlist not found");
        let res: ReturnType<typeof getPlaylist>;
        try { res = getPlaylist(uid, id); } catch { throw new MusicError(404, "playlist not found"); }
        const card = this.playlists(uid).find((p) => p.id === playlistId(res.row.id));
        if (!card) throw new MusicError(404, "playlist not found");
        return { playlist: card, tracks: res.songs.map((t) => trackCard(t)) };
    }

    /** Random tracks for "Mix" / shuffle-all (1..500). */
    randomTracks(size?: number): TrackCard[] {
        const uid = this.userId();
        if (!uid) return [];
        const n = clampInt(size, 1, 500, 50);
        const ids = (this.lib()
            .prepare("SELECT id FROM tracks WHERE user_id = ? AND COALESCE(is_hidden, 0) = 0 ORDER BY RANDOM() LIMIT ?")
            .all(uid, n) as { id: number }[]).map((r) => r.id);
        const byId = new Map(getTracks(uid, ids).map((t) => [t.id, t]));
        return ids.map((i) => byId.get(i)).filter((t): t is TrackRow => !!t).map((t) => trackCard(t));
    }

    /** Albums A–Z (optionally by first letter), paged. */
    albums(opts: { letter?: string; offset?: number; limit?: number } = {}): Page<AlbumCard> {
        const offset = clampInt(opts.offset, 0, 1_000_000, 0);
        const limit = clampInt(opts.limit, 1, 500, 100);
        const uid = this.userId();
        if (!uid) return { total: 0, offset, limit, items: [] };
        let all = listAlbums(uid).sort((x, y) => (x.album ?? "").localeCompare(y.album ?? "", undefined, { sensitivity: "base" }));
        const letter = opts.letter?.trim().toUpperCase();
        if (letter) all = all.filter((a) => fold(indexLetter(a.album)).toUpperCase() === fold(letter).toUpperCase());
        return { total: all.length, offset, limit, items: all.slice(offset, offset + limit).map(albumCard) };
    }

    genre(name: string, offset?: number, limit?: number): Page<AlbumCard> & { genre: string } {
        const off = clampInt(offset, 0, 1_000_000, 0);
        const lim = clampInt(limit, 1, 500, 50);
        const uid = this.userId();
        if (!uid) return { genre: name, total: 0, offset: off, limit: lim, items: [] };
        const g = name.toLowerCase();
        const total = listAlbums(uid).filter((a) => (a.genre ?? "").toLowerCase() === g).length;
        const items = albumList(uid, "byGenre", { size: lim, offset: off, genre: name }).map(albumCard);
        return { genre: name, total, offset: off, limit: lim, items };
    }

    search(q: string): SearchResult {
        const query = q.trim().slice(0, 200);
        const fq = fold(query);
        const uid = this.userId();
        if (!fq || !uid) return { query, artists: [], albums: [], tracks: [] };
        const artists = listArtists(uid).filter((a) => fold(a.artist).includes(fq)).slice(0, 20).map(artistCard);
        const albums = listAlbums(uid)
            .filter((a) => fold(a.album).includes(fq) || fold(a.artist).includes(fq))
            .sort((x, y) => (x.album ?? "").localeCompare(y.album ?? "", undefined, { sensitivity: "base" }))
            .slice(0, 20)
            .map(albumCard);
        const candidates = this.lib().prepare(
            `SELECT id, title, artist, album, filename FROM tracks WHERE user_id = ? AND COALESCE(is_hidden, 0) = 0 ORDER BY id`,
        ).all(uid) as { id: number; title: string | null; artist: string | null; album: string | null; filename: string }[];
        const titleHit: number[] = [];
        const otherHit: number[] = [];
        for (const c of candidates) {
            if (fold(c.title ?? c.filename).includes(fq)) titleHit.push(c.id);
            else if (fold(c.artist).includes(fq) || fold(c.album).includes(fq) || fold(c.filename).includes(fq)) otherHit.push(c.id);
            if (titleHit.length >= 20) break;
        }
        const ids = [...titleHit, ...otherHit].slice(0, 20);
        const byId = new Map(getTracks(uid, ids).map((t) => [t.id, t]));
        const tracks = ids.map((i) => byId.get(i)).filter((t): t is TrackRow => !!t).map((t) => trackCard(t));
        return { query, artists, albums, tracks };
    }

    // ── queue ────────────────────────────────────────────────────────────────

    private ensureQueue(): void {
        if (this.queueReady) return;
        this.media.exec("CREATE TABLE IF NOT EXISTS music_queue (profile_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
        this.queueReady = true;
    }

    getQueue(profileId: string): MusicQueue {
        this.ensureQueue();
        const row = this.media.prepare("SELECT json, updated_at FROM music_queue WHERE profile_id = ?").get(profileId) as
            { json: string; updated_at: number } | undefined;
        if (row) {
            try {
                const q = validateQueue(JSON.parse(row.json));
                return { profileId, ...q, updatedAt: row.updated_at };
            } catch { /* corrupt row → empty queue */ }
        }
        return { profileId, trackIds: [], index: 0, positionSec: 0, shuffle: false, repeat: "off", updatedAt: 0 };
    }

    setQueue(profileId: string, body: unknown): MusicQueue {
        const q = validateQueue(body);
        this.ensureQueue();
        const at = this.now();
        this.media.prepare(
            `INSERT INTO music_queue (profile_id, json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(profile_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
        ).run(profileId, JSON.stringify(q), at);
        return { profileId, ...q, updatedAt: at };
    }

    // ── lyrics ───────────────────────────────────────────────────────────────

    lyrics(rawTrackId: string): LyricsResult {
        const d = decodeId(rawTrackId) ?? (/^\d+$/.test(rawTrackId) ? decodeId(`tr_${rawTrackId}`) : null);
        const uid = this.userId();
        if (!d || d.kind !== "track" || !uid) throw new MusicError(404, "track not found");
        const t = getTrack(uid, d.num!);
        if (!t) throw new MusicError(404, "track not found");
        const id = trackId(t.id);

        const synced = t.synced_lyrics?.trim() ? parseLrc(t.synced_lyrics) : null;
        const plain = t.lyrics?.trim() ? t.lyrics : null;
        if (synced || plain) return { trackId: id, synced, plain, source: "embedded" };

        const sidecar = readSidecar(t.filepath);
        if (sidecar) {
            const lines = parseLrc(sidecar);
            return lines
                ? { trackId: id, synced: lines, plain: lines.map((l) => l.text).join("\n"), source: "sidecar" }
                : { trackId: id, synced: null, plain: sidecar, source: "sidecar" };
        }
        return { trackId: id, synced: null, plain: null, source: "none" };
    }

    /**
     * `lyrics()` + on-demand LRCLIB when nothing is stored: a hit is written to `tracks.lyrics`/`synced_lyrics`
     * (next call is `embedded`), a miss or error is remembered for 24 h. Needs artist + title on the track.
     */
    async lyricsAsync(rawTrackId: string): Promise<LyricsResult> {
        const base = this.lyrics(rawTrackId);
        if (base.source !== "none" || !this.fetchLyrics) return base;
        const uid = this.userId();
        const d = decodeId(base.trackId);
        const t = uid && d?.num ? getTrack(uid, d.num) : null;
        if (!t || !t.artist?.trim() || !t.title?.trim()) return base;
        const missAt = this.lyricsMiss.get(t.id);
        if (missAt !== undefined && this.now() - missAt < DAY_MS) return base;
        let hit: { plainLyrics: string | null; syncedLyrics: string | null } | null = null;
        try {
            hit = await this.fetchLyrics(t.artist, t.title, t.album ?? null, t.duration ?? null);
        } catch { hit = null; }
        const synced = hit?.syncedLyrics?.trim() ? hit.syncedLyrics : null;
        const plain = hit?.plainLyrics?.trim() ? hit.plainLyrics : null;
        if (!synced && !plain) { this.lyricsMiss.set(t.id, this.now()); return base; }
        try {
            this.lib().prepare("UPDATE tracks SET lyrics = COALESCE(?, lyrics), synced_lyrics = COALESCE(?, synced_lyrics) WHERE id = ? AND user_id = ?")
                .run(plain, synced, t.id, uid);
        } catch { /* read-only DB: still answer */ }
        const lines = synced ? parseLrc(synced) : null;
        return { trackId: base.trackId, synced: lines, plain: plain ?? (lines ? lines.map((l) => l.text).join("\n") : null), source: "lrclib" };
    }
}

/** Same basename, `.lrc` extension (case-insensitive on the extension). */
function readSidecar(filepath: string | null | undefined): string | null {
    if (!filepath) return null;
    const dir = path.dirname(filepath);
    const base = path.basename(filepath, path.extname(filepath));
    for (const ext of [".lrc", ".LRC"]) {
        const p = path.join(dir, base + ext);
        try {
            const st = fs.statSync(p);
            if (!st.isFile() || st.size > 1_000_000) continue;
            const text = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
            if (text.trim()) return text;
        } catch { /* not there */ }
    }
    return null;
}

export function validateQueue(body: unknown): Omit<MusicQueue, "profileId" | "updatedAt"> {
    if (!body || typeof body !== "object") throw new MusicError(400, "body must be an object");
    const b = body as Record<string, unknown>;
    if (!Array.isArray(b.trackIds)) throw new MusicError(400, "trackIds must be an array");
    if (b.trackIds.length > MAX_QUEUE) throw new MusicError(400, `trackIds max ${MAX_QUEUE}`);
    const trackIds: string[] = [];
    for (const raw of b.trackIds) {
        const d = typeof raw === "string" ? decodeId(raw) : null;
        if (!d || d.kind !== "track") throw new MusicError(400, `invalid track id: ${String(raw).slice(0, 40)}`);
        trackIds.push(raw as string);
    }
    const index = b.index === undefined ? 0 : Number(b.index);
    if (!Number.isInteger(index) || index < 0 || (trackIds.length > 0 ? index >= trackIds.length : index !== 0)) {
        throw new MusicError(400, "index out of range");
    }
    const positionSec = b.positionSec === undefined ? 0 : Number(b.positionSec);
    if (!Number.isFinite(positionSec) || positionSec < 0) throw new MusicError(400, "positionSec must be >= 0");
    if (b.shuffle !== undefined && typeof b.shuffle !== "boolean") throw new MusicError(400, "shuffle must be boolean");
    const repeat = b.repeat === undefined ? "off" : b.repeat;
    if (repeat !== "off" && repeat !== "all" && repeat !== "one") throw new MusicError(400, "repeat must be off|all|one");
    return { trackIds, index, positionSec, shuffle: b.shuffle === true, repeat };
}
