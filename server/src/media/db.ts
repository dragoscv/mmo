/**
 * media.sqlite — cache + state for the Media Home brain.
 *
 * Raw better-sqlite3 with prepared statements (no drizzle-kit migrations in
 * the companion). Schema is versioned through `PRAGMA user_version`; each
 * migration runs once, inside a transaction, so re-opening is idempotent.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type MediaDb = Database.Database;

const MIGRATIONS: string[] = [
    // v1 — initial schema
    `
    CREATE TABLE IF NOT EXISTS titles (
        kind TEXT NOT NULL,
        tmdb_id INTEGER NOT NULL,
        json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (kind, tmdb_id)
    );
    CREATE TABLE IF NOT EXISTS availability (
        kind TEXT NOT NULL,
        tmdb_id INTEGER NOT NULL,
        region TEXT NOT NULL,
        source TEXT NOT NULL,
        json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (kind, tmdb_id, region)
    );
    CREATE TABLE IF NOT EXISTS recs_cache (
        key TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progress (
        profile_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        tmdb_id INTEGER NOT NULL,
        season INTEGER NOT NULL DEFAULT 0,
        episode INTEGER NOT NULL DEFAULT 0,
        position_sec REAL NOT NULL DEFAULT 0,
        duration_sec REAL NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, kind, tmdb_id, season, episode)
    );
    CREATE INDEX IF NOT EXISTS idx_progress_profile_updated ON progress(profile_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS track_plays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        track_key TEXT NOT NULL,
        played_at INTEGER NOT NULL,
        duration_sec REAL NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_track_plays_profile ON track_plays(profile_id, played_at DESC);
    CREATE TABLE IF NOT EXISTS library_index (
        server_file_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        tmdb_id INTEGER,
        season INTEGER,
        episode INTEGER,
        path TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_library_tmdb ON library_index(kind, tmdb_id);
    CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO meta (key, value) VALUES ('revision', '0');
    INSERT OR IGNORE INTO meta (key, value) VALUES ('library_etag', '0');
    `,
    // v2 — per-row revision stamps (delta sync) + library tombstones + push state
    `
    ALTER TABLE progress ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE track_plays ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE library_index ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_progress_rev ON progress(rev);
    CREATE INDEX IF NOT EXISTS idx_track_plays_rev ON track_plays(rev);
    CREATE INDEX IF NOT EXISTS idx_library_rev ON library_index(rev);
    CREATE INDEX IF NOT EXISTS idx_library_path ON library_index(path);
    CREATE TABLE IF NOT EXISTS library_tombstones (
        server_file_id TEXT PRIMARY KEY,
        rev INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO meta (key, value) VALUES ('last_pushed_revision', '0');
    `,
    // v3 — profiles (PIN, kids max age) + per-profile watchlist (WP16-01/04)
    `
    CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar TEXT,
        color TEXT,
        kind TEXT NOT NULL DEFAULT 'adult',
        max_age INTEGER,
        pin_hash TEXT,
        prefs TEXT NOT NULL DEFAULT '{}',
        sort INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watchlist (
        profile_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        tmdb_id INTEGER NOT NULL,
        added_at INTEGER NOT NULL,
        rev INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (profile_id, kind, tmdb_id)
    );
    CREATE INDEX IF NOT EXISTS idx_watchlist_profile ON watchlist(profile_id, added_at DESC);
    `,
    // v4 — phone apps (WP16-50): chat moderation, subtitle text search, scene bookmarks,
    // daily usage (kids caps), imported user ratings
    `
    CREATE TABLE IF NOT EXISTS chat_reports (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        reporter_device_id TEXT NOT NULL,
        reporter_name TEXT NOT NULL,
        offender_device_id TEXT,
        offender_name TEXT,
        text TEXT,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolution TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_reports_open ON chat_reports(resolved_at, created_at DESC);
    CREATE TABLE IF NOT EXISTS hub_blocks (
        profile_id TEXT NOT NULL,
        blocked_device_id TEXT NOT NULL,
        blocked_name TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, blocked_device_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS subtitle_fts USING fts5(
        folded,
        text UNINDEXED,
        file_id UNINDEXED,
        track_key UNINDEXED,
        start_sec UNINDEXED,
        end_sec UNINDEXED,
        tokenize = 'unicode61'
    );
    CREATE TABLE IF NOT EXISTS subtitle_sources (
        file_id TEXT NOT NULL,
        track_key TEXT NOT NULL,
        track_index INTEGER,
        source TEXT NOT NULL,
        lang TEXT,
        label TEXT,
        sig TEXT NOT NULL,
        cues INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        PRIMARY KEY (file_id, track_key)
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        title_key TEXT NOT NULL,
        kind TEXT,
        tmdb_id INTEGER,
        season INTEGER,
        episode INTEGER,
        file_id TEXT,
        sec REAL NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        shared INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bookmarks_title ON bookmarks(title_key, sec);
    CREATE TABLE IF NOT EXISTS usage_daily (
        profile_id TEXT NOT NULL,
        day TEXT NOT NULL,
        watch_sec REAL NOT NULL DEFAULT 0,
        listen_sec REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (profile_id, day)
    );
    CREATE TABLE IF NOT EXISTS user_ratings (
        profile_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        tmdb_id INTEGER NOT NULL,
        rating REAL NOT NULL,
        rated_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'local',
        PRIMARY KEY (profile_id, kind, tmdb_id)
    );
    `,
];

export const MEDIA_SCHEMA_VERSION = MIGRATIONS.length;

export function migrateMediaDb(db: MediaDb): number {
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

export function openMediaDb(userDataDir: string): MediaDb {
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
    const db = new Database(path.join(userDataDir, "media.sqlite"));
    migrateMediaDb(db);
    return db;
}

/** In-memory DB with the full schema — for tests. */
export function openMemoryMediaDb(): MediaDb {
    const db = new Database(":memory:");
    migrateMediaDb(db);
    return db;
}

// ── meta helpers ──────────────────────────────────────────────────────────

export function getMeta(db: MediaDb, key: string): string | null {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
}

export function setMeta(db: MediaDb, key: string, value: string): void {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// ── generic JSON cache helpers (recs_cache) ───────────────────────────────

export function cacheGet<T>(db: MediaDb, key: string, ttlMs: number, now = Date.now()): T | null {
    const row = db.prepare("SELECT json, fetched_at FROM recs_cache WHERE key = ?").get(key) as
        | { json: string; fetched_at: number } | undefined;
    if (!row) return null;
    if (now - row.fetched_at > ttlMs) return null;
    try { return JSON.parse(row.json) as T; } catch { return null; }
}

export function cacheSet(db: MediaDb, key: string, value: unknown, now = Date.now()): void {
    db.prepare(
        "INSERT INTO recs_cache (key, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at",
    ).run(key, JSON.stringify(value), now);
}

export function cachePrune(db: MediaDb, olderThanMs: number, now = Date.now()): number {
    const r = db.prepare("DELETE FROM recs_cache WHERE fetched_at < ?").run(now - olderThanMs);
    return r.changes;
}
