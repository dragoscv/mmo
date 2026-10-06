/**
 * Playlist CRUD for the Subsonic API over the existing `playlists` /
 * `playlist_tracks` tables (same shape `/library/playlists` uses).
 */

import { enqueueSyncChange } from "../sync";
import { db, songToBody, type TrackRow } from "./browse";
import { decodeId, playlistId } from "./ids";
import { ERR, SubsonicError, type Body } from "./response";

interface PlaylistRow {
    id: number;
    user_id: string;
    name: string;
    description: string | null;
    type: string | null;
    created_at: string | null;
    external_id: string | null;
    updated_at: string | null;
    track_count: number;
    duration: number;
}

const PL_SELECT = `
    SELECT p.id, p.user_id, p.name, p.description, p.type, p.created_at, p.external_id, p.updated_at,
           (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count,
           (SELECT COALESCE(SUM(t.duration), 0) FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = p.id) AS duration
    FROM playlists p`;

function iso(s: string | null): string | undefined {
    if (!s) return undefined;
    const v = s.includes("T") ? s : s.replace(" ", "T") + "Z";
    return Number.isNaN(Date.parse(v)) ? undefined : new Date(v).toISOString();
}

function pushPlaylist(row: PlaylistRow, op: "upsert" | "delete"): void {
    try {
        const ext = row.external_id || `${row.user_id}:pl:${row.id}`;
        enqueueSyncChange({
            entity: "playlists",
            entityId: ext,
            op,
            payload: { externalId: ext, id: row.id, userId: row.user_id, name: row.name, description: row.description, type: row.type, createdAt: row.created_at },
            updatedAt: new Date().toISOString(),
        });
    } catch { /* best-effort */ }
}

export function playlistToBody(p: PlaylistRow, username: string, songs?: TrackRow[]): Body {
    const body: Body = {
        id: playlistId(p.id),
        name: p.name,
        comment: p.description ?? undefined,
        owner: username,
        public: false,
        songCount: p.track_count,
        duration: p.duration,
        created: iso(p.created_at) ?? new Date(0).toISOString(),
        changed: iso(p.updated_at) ?? iso(p.created_at) ?? new Date(0).toISOString(),
    };
    if (songs) body.entry = songs.map(songToBody);
    return body;
}

export function listPlaylists(userId: string): PlaylistRow[] {
    return db().prepare(`${PL_SELECT} WHERE p.user_id = ? ORDER BY p.name`).all(userId) as PlaylistRow[];
}

export function getPlaylist(userId: string, rawId: string): { row: PlaylistRow; songs: TrackRow[] } {
    const d = decodeId(rawId);
    if (!d || d.kind !== "playlist") throw new SubsonicError(ERR.NOT_FOUND, "Playlist not found");
    const row = db().prepare(`${PL_SELECT} WHERE p.user_id = ? AND p.id = ?`).get(userId, d.num) as PlaylistRow | undefined;
    if (!row) throw new SubsonicError(ERR.NOT_FOUND, "Playlist not found");
    const songs = db().prepare(
        `SELECT t.id, t.user_id, t.filepath, t.filename, t.artist, t.title, t.album, t.genre, t.year, t.duration, t.bpm,
                t.file_size, t.format, t.bitrate, t.sample_rate, t.added_at, t.rating, t.is_favorite, t.lyrics, t.synced_lyrics,
                t.comment, t.artwork_url, t.musicbrainz_id
         FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id AND t.user_id = ?
         WHERE pt.playlist_id = ? ORDER BY pt.position`,
    ).all(userId, d.num) as TrackRow[];
    return { row, songs };
}

function songIdsToTrackIds(userId: string, ids: string[]): number[] {
    const out: number[] = [];
    for (const raw of ids) {
        const d = decodeId(raw);
        if (!d || d.kind !== "track") throw new SubsonicError(ERR.NOT_FOUND, `Unknown song id: ${raw}`);
        out.push(d.num!);
    }
    if (out.length === 0) return [];
    const marks = out.map(() => "?").join(",");
    const owned = new Set((db().prepare(`SELECT id FROM tracks WHERE user_id = ? AND id IN (${marks})`).all(userId, ...out) as Array<{ id: number }>).map((r) => r.id));
    return out.filter((id) => owned.has(id));
}

function appendTracks(playlistIdNum: number, trackIds: number[]): void {
    if (trackIds.length === 0) return;
    const maxPos = (db().prepare(`SELECT COALESCE(MAX(position), 0) AS m FROM playlist_tracks WHERE playlist_id = ?`).get(playlistIdNum) as { m: number }).m;
    const ins = db().prepare(`INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)`);
    let pos = maxPos + 1;
    for (const tid of trackIds) ins.run(playlistIdNum, tid, pos++);
}

function touch(playlistIdNum: number): void {
    db().prepare(`UPDATE playlists SET updated_at = ? WHERE id = ?`).run(new Date().toISOString(), playlistIdNum);
}

/**
 * createPlaylist: either `name` (new) or `playlistId` (replace contents).
 * Returns the id of the affected playlist.
 */
export function createPlaylist(userId: string, opts: { name?: string; playlistId?: string; songIds: string[] }): number {
    const trackIds = songIdsToTrackIds(userId, opts.songIds);
    if (opts.playlistId) {
        const d = decodeId(opts.playlistId);
        if (!d || d.kind !== "playlist") throw new SubsonicError(ERR.NOT_FOUND, "Playlist not found");
        const row = db().prepare(`${PL_SELECT} WHERE p.user_id = ? AND p.id = ?`).get(userId, d.num) as PlaylistRow | undefined;
        if (!row) throw new SubsonicError(ERR.NOT_FOUND, "Playlist not found");
        db().transaction(() => {
            db().prepare(`DELETE FROM playlist_tracks WHERE playlist_id = ?`).run(d.num);
            appendTracks(d.num!, trackIds);
            if (opts.name) db().prepare(`UPDATE playlists SET name = ? WHERE id = ?`).run(opts.name, d.num);
            touch(d.num!);
        })();
        pushPlaylist(row, "upsert");
        return d.num!;
    }
    if (!opts.name) throw new SubsonicError(ERR.MISSING_PARAM, "Required parameter is missing: name or playlistId");
    const id = db().transaction(() => {
        const info = db().prepare(
            `INSERT INTO playlists (user_id, name, type, updated_at) VALUES (?, ?, 'manual', ?)`,
        ).run(userId, opts.name, new Date().toISOString());
        const newId = Number(info.lastInsertRowid);
        appendTracks(newId, trackIds);
        return newId;
    })();
    const row = db().prepare(`${PL_SELECT} WHERE p.id = ?`).get(id) as PlaylistRow;
    pushPlaylist(row, "upsert");
    return id;
}

export function updatePlaylist(userId: string, rawId: string, opts: {
    name?: string; comment?: string; songIdToAdd: string[]; songIndexToRemove: number[];
}): void {
    const d = decodeId(rawId);
    if (!d || d.kind !== "playlist") throw new SubsonicError(ERR.NOT_FOUND, "Playlist not found");
    const row = db().prepare(`${PL_SELECT} WHERE p.user_id = ? AND p.id = ?`).get(userId, d.num) as PlaylistRow | undefined;
    if (!row) throw new SubsonicError(ERR.NOT_FOUND, "Playlist not found");
    const toAdd = songIdsToTrackIds(userId, opts.songIdToAdd);
    db().transaction(() => {
        if (opts.name !== undefined) db().prepare(`UPDATE playlists SET name = ? WHERE id = ?`).run(opts.name, d.num);
        if (opts.comment !== undefined) db().prepare(`UPDATE playlists SET description = ? WHERE id = ?`).run(opts.comment, d.num);
        if (opts.songIndexToRemove.length > 0) {
            const current = db().prepare(`SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position`).all(d.num) as Array<{ id: number }>;
            const del = db().prepare(`DELETE FROM playlist_tracks WHERE id = ?`);
            // Indices are 0-based positions in the current order; delete
            // from the highest so earlier indices stay valid.
            for (const idx of [...new Set(opts.songIndexToRemove)].sort((a, b) => b - a)) {
                const hit = current[idx];
                if (hit) del.run(hit.id);
            }
            // Re-pack positions 1..N.
            const rest = db().prepare(`SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position`).all(d.num) as Array<{ id: number }>;
            const upd = db().prepare(`UPDATE playlist_tracks SET position = ? WHERE id = ?`);
            rest.forEach((r, i) => upd.run(i + 1, r.id));
        }
        appendTracks(d.num!, toAdd);
        touch(d.num!);
    })();
    pushPlaylist(row, "upsert");
}

export function deletePlaylist(userId: string, rawId: string): void {
    const d = decodeId(rawId);
    if (!d || d.kind !== "playlist") throw new SubsonicError(ERR.NOT_FOUND, "Playlist not found");
    const row = db().prepare(`${PL_SELECT} WHERE p.user_id = ? AND p.id = ?`).get(userId, d.num) as PlaylistRow | undefined;
    if (!row) throw new SubsonicError(ERR.NOT_FOUND, "Playlist not found");
    db().transaction(() => {
        db().prepare(`DELETE FROM playlist_tracks WHERE playlist_id = ?`).run(d.num);
        db().prepare(`DELETE FROM playlists WHERE id = ?`).run(d.num);
    })();
    pushPlaylist(row, "delete");
}
