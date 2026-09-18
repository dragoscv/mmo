/**
 * Watch progress (per profile, seconds) + music play history.
 * Every write bumps `meta.revision` so clients can cheap-poll `/media/etag`.
 */

import type { MediaDb } from "./db";
import { getMeta, setMeta } from "./db";
import type { MediaKind, ProgressEntry, TrackPlay } from "./types";

export const COMPLETED_THRESHOLD = 0.9;

export interface ProgressInput {
    profileId: string;
    kind: MediaKind;
    tmdbId: number;
    season?: number;
    episode?: number;
    positionSec: number;
    durationSec: number;
    completed?: boolean;
    updatedAt?: number;
}

export interface ProgressFilter {
    kind?: MediaKind;
    tmdbId?: number;
    since?: number;
    limit?: number;
}

type Row = {
    profile_id: string; kind: MediaKind; tmdb_id: number; season: number; episode: number;
    position_sec: number; duration_sec: number; completed: number; updated_at: number;
};

const rowToEntry = (r: Row): ProgressEntry => ({
    profileId: r.profile_id, kind: r.kind, tmdbId: r.tmdb_id, season: r.season, episode: r.episode,
    positionSec: r.position_sec, durationSec: r.duration_sec, completed: r.completed === 1, updatedAt: r.updated_at,
});

export function isCompleted(positionSec: number, durationSec: number, explicit?: boolean): boolean {
    if (explicit === true) return true;
    if (durationSec <= 0) return false;
    return positionSec / durationSec >= COMPLETED_THRESHOLD;
}

export class ProgressStore {
    constructor(private readonly db: MediaDb, private readonly now: () => number = Date.now) {}

    getRevision(): number {
        return Number(getMeta(this.db, "revision") ?? "0");
    }

    bumpRevision(): number {
        const next = this.getRevision() + 1;
        setMeta(this.db, "revision", String(next));
        return next;
    }

    getProgress(profileId: string, filter: ProgressFilter = {}): ProgressEntry[] {
        const where: string[] = ["profile_id = ?"];
        const args: (string | number)[] = [profileId];
        if (filter.kind) { where.push("kind = ?"); args.push(filter.kind); }
        if (filter.tmdbId !== undefined) { where.push("tmdb_id = ?"); args.push(filter.tmdbId); }
        if (filter.since !== undefined) { where.push("updated_at > ?"); args.push(filter.since); }
        const limit = Math.max(1, Math.min(1000, filter.limit ?? 500));
        const rows = this.db
            .prepare(`SELECT * FROM progress WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ${limit}`)
            .all(...args) as Row[];
        return rows.map(rowToEntry);
    }

    putProgress(input: ProgressInput): ProgressEntry {
        const season = input.season ?? 0;
        const episode = input.episode ?? 0;
        const positionSec = Math.max(0, Number(input.positionSec) || 0);
        const durationSec = Math.max(0, Number(input.durationSec) || 0);
        const completed = isCompleted(positionSec, durationSec, input.completed);
        const updatedAt = input.updatedAt ?? this.now();
        this.db.prepare(
            `INSERT INTO progress (profile_id, kind, tmdb_id, season, episode, position_sec, duration_sec, completed, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(profile_id, kind, tmdb_id, season, episode) DO UPDATE SET
               position_sec = excluded.position_sec,
               duration_sec = CASE WHEN excluded.duration_sec > 0 THEN excluded.duration_sec ELSE progress.duration_sec END,
               completed = MAX(progress.completed, excluded.completed),
               updated_at = excluded.updated_at
             WHERE excluded.updated_at >= progress.updated_at`,
        ).run(input.profileId, input.kind, input.tmdbId, season, episode, positionSec, durationSec, completed ? 1 : 0, updatedAt);
        this.bumpRevision();
        const row = this.db
            .prepare("SELECT * FROM progress WHERE profile_id = ? AND kind = ? AND tmdb_id = ? AND season = ? AND episode = ?")
            .get(input.profileId, input.kind, input.tmdbId, season, episode) as Row;
        return rowToEntry(row);
    }

    /** In-progress titles (not completed, ≥ 2 % watched), newest first, one row per title. */
    listContinue(profileId: string, limit = 24): ProgressEntry[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM progress WHERE profile_id = ? AND completed = 0 AND duration_sec > 0
                   AND position_sec / duration_sec >= 0.02
                 ORDER BY updated_at DESC LIMIT ?`,
            )
            .all(profileId, Math.max(1, Math.min(200, limit * 4))) as Row[];
        const seen = new Set<string>();
        const out: ProgressEntry[] = [];
        for (const r of rows) {
            const k = `${r.kind}:${r.tmdb_id}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(rowToEntry(r));
            if (out.length >= limit) break;
        }
        return out;
    }

    recordPlay(profileId: string, trackKey: string, durationSec: number, completed: boolean, playedAt?: number): TrackPlay {
        const at = playedAt ?? this.now();
        const r = this.db
            .prepare("INSERT INTO track_plays (profile_id, track_key, played_at, duration_sec, completed) VALUES (?, ?, ?, ?, ?)")
            .run(profileId, trackKey, at, Math.max(0, Number(durationSec) || 0), completed ? 1 : 0);
        this.bumpRevision();
        return { id: Number(r.lastInsertRowid), profileId, trackKey, playedAt: at, durationSec, completed };
    }

    listRecentPlays(profileId: string, limit = 50): TrackPlay[] {
        const rows = this.db
            .prepare("SELECT id, profile_id, track_key, played_at, duration_sec, completed FROM track_plays WHERE profile_id = ? ORDER BY played_at DESC LIMIT ?")
            .all(profileId, Math.max(1, Math.min(500, limit))) as
            { id: number; profile_id: string; track_key: string; played_at: number; duration_sec: number; completed: number }[];
        return rows.map((r) => ({
            id: r.id, profileId: r.profile_id, trackKey: r.track_key, playedAt: r.played_at, durationSec: r.duration_sec, completed: r.completed === 1,
        }));
    }
}
