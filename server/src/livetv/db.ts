/**
 * livetv.sqlite — sources, channels, guide, favourites and DVR state.
 *
 * Raw better-sqlite3 (same pattern as media/db.ts): schema versioned by
 * `PRAGMA user_version`, each migration runs once inside a transaction.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type LiveTvDb = Database.Database;

const MIGRATIONS: string[] = [
    // v1 — initial schema
    `
    CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('m3u','xtream','hdhomerun')),
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        xmltv_url TEXT,
        username TEXT,
        password TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        refresh_hours INTEGER NOT NULL DEFAULT 24,
        last_refresh INTEGER,
        last_error TEXT,
        channel_count INTEGER NOT NULL DEFAULT 0,
        header_xmltv TEXT,
        tuner_limit INTEGER,
        tuner_override INTEGER,
        meta TEXT NOT NULL DEFAULT '{}',
        guide_refreshed_at INTEGER,
        guide_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        number TEXT,
        custom_number TEXT,
        name TEXT NOT NULL,
        logo TEXT,
        group_title TEXT,
        tvg_id TEXT,
        stream_url TEXT NOT NULL,
        archive_days INTEGER NOT NULL DEFAULT 0,
        catchup TEXT,
        catchup_source TEXT,
        ext_id TEXT,
        hidden INTEGER NOT NULL DEFAULT 0,
        sort INTEGER,
        position INTEGER NOT NULL DEFAULT 0,
        seen_gen INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_channels_source ON channels(source_id);
    CREATE INDEX IF NOT EXISTS idx_channels_group ON channels(group_title);
    CREATE TABLE IF NOT EXISTS favourites (
        profile_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, channel_id)
    );
    CREATE TABLE IF NOT EXISTS programmes (
        channel_id TEXT NOT NULL,
        start INTEGER NOT NULL,
        stop INTEGER NOT NULL,
        title TEXT NOT NULL,
        subtitle TEXT,
        description TEXT,
        category TEXT,
        episode_num TEXT,
        icon TEXT,
        gen INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel_id, start)
    );
    CREATE INDEX IF NOT EXISTS idx_programmes_stop ON programmes(stop);
    CREATE TABLE IF NOT EXISTS rules (
        id TEXT PRIMARY KEY,
        title_match TEXT NOT NULL,
        channel_id TEXT,
        padding_before_sec INTEGER NOT NULL DEFAULT 60,
        padding_after_sec INTEGER NOT NULL DEFAULT 300,
        keep_last INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        start INTEGER NOT NULL,
        stop INTEGER NOT NULL,
        padding_before_sec INTEGER NOT NULL DEFAULT 0,
        padding_after_sec INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('scheduled','recording','done','failed','cancelled')),
        path TEXT,
        error TEXT,
        rule_id TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status, start);
    CREATE INDEX IF NOT EXISTS idx_recordings_rule ON recordings(rule_id, start);
    `,
];

export const LIVETV_SCHEMA_VERSION = MIGRATIONS.length;

export function migrateLiveTvDb(db: LiveTvDb): number {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    let version = Number(db.pragma("user_version", { simple: true }) ?? 0);
    for (let v = version; v < MIGRATIONS.length; v++) {
        const sql = MIGRATIONS[v]!;
        db.transaction(() => {
            db.exec(sql);
            db.pragma(`user_version = ${v + 1}`);
        })();
        version = v + 1;
    }
    return version;
}

export function openLiveTvDb(dir: string): LiveTvDb {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, "livetv.sqlite"));
    migrateLiveTvDb(db);
    return db;
}

/** In-memory DB with the full schema — for tests. */
export function openMemoryLiveTvDb(): LiveTvDb {
    const db = new Database(":memory:");
    migrateLiveTvDb(db);
    return db;
}
