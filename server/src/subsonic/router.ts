/**
 * OpenSubsonic `/rest/*` router (ADR-0005).
 *
 * Mounted WITHOUT the companion's `authMiddleware`: Subsonic clients
 * cannot send `X-Device-Token`, so auth happens here from the query/form
 * params (see ./auth.ts). Every method accepts GET and POST
 * (application/x-www-form-urlencoded — the `formPost` extension), with
 * or without the `.view` suffix.
 */

import express from "express";
import os from "node:os";
import fs from "node:fs";
import { store, getSettings } from "../store";
import { platform } from "../platform";
import { createScanJob, listActiveScanJobs } from "../library/scan-jobs";
import { runScanJob } from "../library/scan-runner";
import { log } from "../lib/logger";
import { authenticate } from "./auth";
import {
    albumList, albumToBody, albumsOfArtist, artistToBody, findAlbumByHash, findArtistByHash, genres,
    getTrack, indexLetter, listArtists, randomSongs, resolveUserId, search, songToBody, songsByGenre,
    songsOfAlbum, starredSongs, suffixOf, tracksForId, type AlbumListType, type TrackRow,
} from "./browse";
import { decodeId } from "./ids";
import { lyricsBody, pickStreamFormat, sendCoverArt, sendFile, streamTranscoded, type StreamFormat } from "./media";
import { createPlaylist, deletePlaylist, getPlaylist, listPlaylists, playlistToBody, updatePlaylist } from "./playlists";
import { scrobble, setRating, setStarred } from "./annotate";
import {
    ERR, SubsonicError, failedEnvelope, okEnvelope, parseFormat, sendEnvelope,
    type Body, type SubsonicFormat,
} from "./response";

// ─── Param helpers ───────────────────────────────────────────────────────────

type Params = Record<string, string | string[]>;

function collectParams(req: express.Request): Params {
    const out: Params = {};
    const merge = (src: unknown) => {
        if (!src || typeof src !== "object") return;
        for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
            if (Array.isArray(v)) out[k] = v.map(String);
            else if (v !== undefined && v !== null) out[k] = String(v);
        }
    };
    merge(req.query);
    merge(req.body);
    return out;
}

function one(p: Params, k: string): string | undefined {
    const v = p[k];
    return Array.isArray(v) ? v[0] : v;
}
function many(p: Params, k: string): string[] {
    const v = p[k];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
}
function need(p: Params, k: string): string {
    const v = one(p, k);
    if (v === undefined || v === "") throw new SubsonicError(ERR.MISSING_PARAM, `Required parameter is missing: ${k}`);
    return v;
}
function int(p: Params, k: string, dflt: number, min = 0, max = 5000): number {
    const v = one(p, k);
    if (v === undefined || v === "") return dflt;
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
}
function bool(p: Params, k: string, dflt: boolean): boolean {
    const v = one(p, k);
    if (v === undefined) return dflt;
    return v !== "false" && v !== "0";
}

interface Ctx {
    req: express.Request;
    res: express.Response;
    params: Params;
    userId: string;
    username: string;
    format: SubsonicFormat;
}

/** A method returns a body (→ envelope) or `null` when it already wrote the response (binary). */
type Method = (ctx: Ctx) => Body | null | Promise<Body | null>;

const EXTENSIONS: Body[] = [
    { name: "apiKeyAuthentication", versions: [1] },
    { name: "formPost", versions: [1] },
    { name: "songLyrics", versions: [1] },
    { name: "transcodeOffset", versions: [1] },
];

function idTracks(ctx: Ctx, raw: string): TrackRow[] {
    const d = decodeId(raw);
    if (!d) throw new SubsonicError(ERR.NOT_FOUND, `Unknown id: ${raw}`);
    return tracksForId(ctx.userId, d);
}

// ─── Methods ─────────────────────────────────────────────────────────────────

const methods: Record<string, Method> = {
    // System
    ping: () => ({}),
    getLicense: () => ({ license: { valid: true, email: "mmo@localhost", licenseExpires: "2099-12-31T23:59:59Z" } }),
    getOpenSubsonicExtensions: () => ({ openSubsonicExtensions: EXTENSIONS }),

    // Browsing
    getMusicFolders: () => {
        const folders = getSettings().scanFolders
            .map((f, i) => ({ f, i }))
            .filter(({ f }) => (f.kind ?? "music") === "music");
        const musicFolder = folders.length > 0
            ? folders.map(({ f, i }) => ({ id: i + 1, name: f.path.split(/[\\/]/).filter(Boolean).pop() ?? f.path }))
            : [{ id: 1, name: "Music" }];
        return { musicFolders: { musicFolder } };
    },
    getIndexes: (ctx) => {
        const userId = ctx.userId;
        const groups = new Map<string, Body[]>();
        for (const a of listArtists(userId)) {
            const letter = indexLetter(a.artist);
            const list = groups.get(letter) ?? [];
            list.push(artistToBody(a));
            groups.set(letter, list);
        }
        const index = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, artist]) => ({ name, artist }));
        return { indexes: { lastModified: Date.now(), ignoredArticles: "The A An", index } };
    },
    getArtists: (ctx) => {
        const userId = ctx.userId;
        const groups = new Map<string, Body[]>();
        for (const a of listArtists(userId)) {
            const letter = indexLetter(a.artist);
            const list = groups.get(letter) ?? [];
            list.push(artistToBody(a));
            groups.set(letter, list);
        }
        const index = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, artist]) => ({ name, artist }));
        return { artists: { ignoredArticles: "The A An", index } };
    },
    getArtist: (ctx) => {
        const d = decodeId(need(ctx.params, "id"));
        if (!d || d.kind !== "artist") throw new SubsonicError(ERR.NOT_FOUND, "Artist not found");
        const a = findArtistByHash(ctx.userId, d.hash!);
        if (!a) throw new SubsonicError(ERR.NOT_FOUND, "Artist not found");
        return { artist: artistToBody(a, { withAlbums: albumsOfArtist(ctx.userId, a.artist) }) };
    },
    getAlbum: (ctx) => {
        const d = decodeId(need(ctx.params, "id"));
        if (!d || d.kind !== "album") throw new SubsonicError(ERR.NOT_FOUND, "Album not found");
        const a = findAlbumByHash(ctx.userId, d.hash!);
        if (!a) throw new SubsonicError(ERR.NOT_FOUND, "Album not found");
        return { album: albumToBody(a, { withSongs: songsOfAlbum(ctx.userId, a.album, a.artist) }) };
    },
    getSong: (ctx) => {
        const d = decodeId(need(ctx.params, "id"));
        if (!d || d.kind !== "track") throw new SubsonicError(ERR.NOT_FOUND, "Song not found");
        const t = getTrack(ctx.userId, d.num!);
        if (!t) throw new SubsonicError(ERR.NOT_FOUND, "Song not found");
        return { song: songToBody(t) };
    },
    getGenres: (ctx) => ({ genres: { genre: genres(ctx.userId) } }),

    // Lists
    getAlbumList2: (ctx) => {
        const type = need(ctx.params, "type") as AlbumListType;
        const valid: AlbumListType[] = ["random", "newest", "alphabeticalByName", "alphabeticalByArtist", "frequent", "recent", "starred", "byGenre", "byYear", "highest"];
        if (!valid.includes(type)) throw new SubsonicError(ERR.GENERIC, `Unsupported album list type: ${type}`);
        if (type === "byGenre") need(ctx.params, "genre");
        if (type === "byYear") { need(ctx.params, "fromYear"); need(ctx.params, "toYear"); }
        const albums = albumList(ctx.userId, type, {
            size: int(ctx.params, "size", 10, 1, 500),
            offset: int(ctx.params, "offset", 0),
            genre: one(ctx.params, "genre"),
            fromYear: one(ctx.params, "fromYear") !== undefined ? int(ctx.params, "fromYear", 0, 0, 9999) : undefined,
            toYear: one(ctx.params, "toYear") !== undefined ? int(ctx.params, "toYear", 9999, 0, 9999) : undefined,
        });
        return { albumList2: { album: albums.map((a) => albumToBody(a)) } };
    },
    getRandomSongs: (ctx) => ({
        randomSongs: {
            song: randomSongs(ctx.userId, {
                size: int(ctx.params, "size", 10, 1, 500),
                genre: one(ctx.params, "genre"),
                fromYear: one(ctx.params, "fromYear") !== undefined ? int(ctx.params, "fromYear", 0, 0, 9999) : undefined,
                toYear: one(ctx.params, "toYear") !== undefined ? int(ctx.params, "toYear", 9999, 0, 9999) : undefined,
            }).map(songToBody),
        },
    }),
    getSongsByGenre: (ctx) => ({
        songsByGenre: {
            song: songsByGenre(ctx.userId, need(ctx.params, "genre"), int(ctx.params, "count", 10, 1, 500), int(ctx.params, "offset", 0)).map(songToBody),
        },
    }),
    getStarred2: (ctx) => {
        const songs = starredSongs(ctx.userId);
        return { starred2: { artist: [], album: [], song: songs.map(songToBody) } };
    },

    // Search
    search3: (ctx) => {
        const query = one(ctx.params, "query") ?? "";
        const r = search(ctx.userId, query, {
            artistCount: int(ctx.params, "artistCount", 20, 0, 500), artistOffset: int(ctx.params, "artistOffset", 0),
            albumCount: int(ctx.params, "albumCount", 20, 0, 500), albumOffset: int(ctx.params, "albumOffset", 0),
            songCount: int(ctx.params, "songCount", 20, 0, 500), songOffset: int(ctx.params, "songOffset", 0),
        });
        return {
            searchResult3: {
                artist: r.artists.map((a) => artistToBody(a)),
                album: r.albums.map((a) => albumToBody(a)),
                song: r.songs.map(songToBody),
            },
        };
    },

    // Annotation
    star: (ctx) => {
        const ids = [...many(ctx.params, "id"), ...many(ctx.params, "albumId"), ...many(ctx.params, "artistId")];
        if (ids.length === 0) throw new SubsonicError(ERR.MISSING_PARAM, "Required parameter is missing: id");
        setStarred(ctx.userId, ids, true);
        return {};
    },
    unstar: (ctx) => {
        const ids = [...many(ctx.params, "id"), ...many(ctx.params, "albumId"), ...many(ctx.params, "artistId")];
        if (ids.length === 0) throw new SubsonicError(ERR.MISSING_PARAM, "Required parameter is missing: id");
        setStarred(ctx.userId, ids, false);
        return {};
    },
    setRating: (ctx) => {
        const rating = Number.parseInt(need(ctx.params, "rating"), 10);
        if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new SubsonicError(ERR.GENERIC, "rating must be 0-5");
        setRating(ctx.userId, need(ctx.params, "id"), rating);
        return {};
    },
    scrobble: (ctx) => {
        const ids = many(ctx.params, "id");
        if (ids.length === 0) throw new SubsonicError(ERR.MISSING_PARAM, "Required parameter is missing: id");
        scrobble(ctx.userId, ids, bool(ctx.params, "submission", true));
        return {};
    },

    // Playlists
    getPlaylists: (ctx) => ({ playlists: { playlist: listPlaylists(ctx.userId).map((p) => playlistToBody(p, ctx.username)) } }),
    getPlaylist: (ctx) => {
        const { row, songs } = getPlaylist(ctx.userId, need(ctx.params, "id"));
        return { playlist: playlistToBody(row, ctx.username, songs) };
    },
    createPlaylist: (ctx) => {
        const id = createPlaylist(ctx.userId, {
            name: one(ctx.params, "name"),
            playlistId: one(ctx.params, "playlistId"),
            songIds: many(ctx.params, "songId"),
        });
        const { row, songs } = getPlaylist(ctx.userId, `pl_${id}`);
        return { playlist: playlistToBody(row, ctx.username, songs) };
    },
    updatePlaylist: (ctx) => {
        updatePlaylist(ctx.userId, need(ctx.params, "playlistId"), {
            name: one(ctx.params, "name"),
            comment: one(ctx.params, "comment"),
            songIdToAdd: many(ctx.params, "songIdToAdd"),
            songIndexToRemove: many(ctx.params, "songIndexToRemove").map((s) => Number.parseInt(s, 10)).filter((n) => Number.isInteger(n) && n >= 0),
        });
        return {};
    },
    deletePlaylist: (ctx) => { deletePlaylist(ctx.userId, need(ctx.params, "id")); return {}; },

    // Media retrieval (binary)
    stream: (ctx) => {
        const d = decodeId(need(ctx.params, "id"));
        if (!d || d.kind !== "track") throw new SubsonicError(ERR.NOT_FOUND, "Song not found");
        const t = getTrack(ctx.userId, d.num!);
        if (!t) throw new SubsonicError(ERR.NOT_FOUND, "Song not found");
        const offset = int(ctx.params, "timeOffset", 0, 0, 24 * 3600);
        const formatParam = one(ctx.params, "format");
        const picked = pickStreamFormat(formatParam, suffixOf(t));
        // A seek always needs ffmpeg: keep the requested codec when it is one we
        // can encode (even if it equals the file's suffix), else mp3 as before.
        let target: StreamFormat | null = picked === "raw" ? null : picked;
        if (!target && offset > 0) {
            const requested = pickStreamFormat(formatParam, "");
            target = requested === "raw" ? "mp3" : requested;
        }
        if (target && streamTranscoded(ctx.res, t, offset, target)) return null;
        sendFile(ctx.req, ctx.res, t, false);
        return null;
    },
    download: (ctx) => {
        const d = decodeId(need(ctx.params, "id"));
        if (!d || d.kind !== "track") throw new SubsonicError(ERR.NOT_FOUND, "Song not found");
        const t = getTrack(ctx.userId, d.num!);
        if (!t) throw new SubsonicError(ERR.NOT_FOUND, "Song not found");
        sendFile(ctx.req, ctx.res, t, true);
        return null;
    },
    getCoverArt: async (ctx) => {
        const candidates = idTracks(ctx, need(ctx.params, "id"));
        if (candidates.length === 0) throw new SubsonicError(ERR.NOT_FOUND, "Cover art not found");
        if (await sendCoverArt(ctx.res, candidates)) return null;
        throw new SubsonicError(ERR.NOT_FOUND, "Cover art not found");
    },
    getLyricsBySongId: (ctx) => {
        const d = decodeId(need(ctx.params, "id"));
        if (!d || d.kind !== "track") throw new SubsonicError(ERR.NOT_FOUND, "Song not found");
        const t = getTrack(ctx.userId, d.num!);
        if (!t) throw new SubsonicError(ERR.NOT_FOUND, "Song not found");
        return lyricsBody(t);
    },

    // User / scanning
    getUser: (ctx) => ({
        user: {
            username: one(ctx.params, "username") ?? ctx.username,
            email: (store.get("userEmail") as string | undefined) || undefined,
            scrobblingEnabled: false,
            adminRole: true, settingsRole: true, downloadRole: true, uploadRole: false, playlistRole: true,
            coverArtRole: true, commentRole: false, podcastRole: false, streamRole: true, jukeboxRole: false,
            shareRole: false, videoConversionRole: false,
            folder: [1],
        },
    }),
    getScanStatus: () => {
        const active = listActiveScanJobs();
        const scanning = active.length > 0;
        const count = active.reduce((n, j) => n + j.scanned, 0);
        return { scanStatus: { scanning, count: scanning ? count : undefined } };
    },
    startScan: () => {
        const folders = getSettings().scanFolders.filter((f) => (f.kind ?? "music") === "music");
        const active = listActiveScanJobs();
        let started = 0;
        for (const f of folders) {
            if (active.some((j) => j.folder === f.path)) continue;
            if (!fs.existsSync(f.path)) continue;
            const job = createScanJob(f.path, "manual", "audio");
            void runScanJob(job);
            started++;
        }
        log.info("[subsonic] startScan", { folders: folders.length, started });
        return { scanStatus: { scanning: started > 0 || active.length > 0, count: 0 } };
    },
};

/** Methods that we know exist in the spec but deliberately do not implement. */
const UNSUPPORTED = new Set([
    "getMusicDirectory", "getVideos", "getVideoInfo", "getArtistInfo", "getArtistInfo2", "getAlbumInfo", "getAlbumInfo2",
    "getSimilarSongs", "getSimilarSongs2", "getTopSongs", "getAlbumList", "getNowPlaying", "getStarred", "search", "search2",
    "getLyrics", "getAvatar", "hls", "getCaptions", "getPodcasts", "getNewestPodcasts", "refreshPodcasts", "createPodcastChannel",
    "deletePodcastChannel", "deletePodcastEpisode", "downloadPodcastEpisode", "jukeboxControl", "getInternetRadioStations",
    "createInternetRadioStation", "updateInternetRadioStation", "deleteInternetRadioStation", "getChatMessages", "addChatMessage",
    "getUsers", "createUser", "updateUser", "deleteUser", "changePassword", "getBookmarks", "createBookmark", "deleteBookmark",
    "getPlayQueue", "savePlayQueue", "getShares", "createShare", "updateShare", "deleteShare", "getPlaylistsByUser", "createShare",
]);

// ─── Router ──────────────────────────────────────────────────────────────────

export function createSubsonicRouter(): express.Router {
    const router = express.Router();
    router.use(express.urlencoded({ extended: false, limit: "256kb" }));

    router.all("/:method", async (req, res) => {
        const params = collectParams(req);
        const format = parseFormat(one(params, "f"));
        const callback = one(params, "callback");
        const meta = { serverVersion: platform.getVersion() };
        const fail = (code: number, message: string) => sendEnvelope(res, failedEnvelope(code, message, meta), format, callback);

        const methodName = String(req.params.method).replace(/\.view$/, "");
        try {
            const secret = (store.get("deviceToken") as string | undefined) ?? "";
            const username = authenticate({
                u: one(params, "u"), p: one(params, "p"), t: one(params, "t"), s: one(params, "s"), apiKey: one(params, "apiKey"),
            }, secret);

            const method = methods[methodName];
            if (!method) {
                fail(ERR.NOT_FOUND, UNSUPPORTED.has(methodName) ? `Method not supported by this server: ${methodName}` : `Unknown method: ${methodName}`);
                return;
            }
            const userId = resolveUserId() ?? "";
            const body = await method({ req, res, params, userId, username, format });
            if (body === null) return; // binary response already written
            sendEnvelope(res, okEnvelope(body, meta), format, callback);
        } catch (e) {
            if (res.headersSent) { res.end(); return; }
            if (e instanceof SubsonicError) { fail(e.code, e.message); return; }
            log.error("[subsonic] unhandled", e, { method: methodName, host: os.hostname() });
            fail(ERR.GENERIC, "Internal error");
        }
    });

    return router;
}

export { methods as subsonicMethods };
