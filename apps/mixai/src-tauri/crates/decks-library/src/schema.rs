//! SQLite schema and migrations, versioned with `PRAGMA user_version`.
//!
//! Each entry of [`MIGRATIONS`] runs once, in order, inside one transaction; never edit a
//! shipped migration, append a new one instead.

use rusqlite::Connection;

use crate::Result;

/// Ordered migrations; index + 1 = resulting `user_version`.
pub const MIGRATIONS: &[&str] = &[
    // v1: core catalogue.
    r#"
CREATE TABLE tracks (
    -- Explicit INTEGER PRIMARY KEY: FTS5 external content needs a rowid that VACUUM keeps.
    rid           INTEGER PRIMARY KEY,
    id            TEXT NOT NULL UNIQUE,
    path          TEXT NOT NULL,
    path_key      TEXT NOT NULL UNIQUE,
    file_hash     TEXT,
    title         TEXT,
    artist        TEXT,
    album         TEXT,
    genre         TEXT,
    label         TEXT,
    year          INTEGER,
    duration_sec  REAL,
    bitrate       INTEGER,
    sample_rate   INTEGER,
    bpm           REAL,
    key_pc        INTEGER CHECK (key_pc BETWEEN 0 AND 11),
    key_minor     INTEGER CHECK (key_minor IN (0, 1)),
    camelot       TEXT,
    energy        INTEGER CHECK (energy BETWEEN 1 AND 10),
    rating        INTEGER CHECK (rating BETWEEN 0 AND 5),
    colour        INTEGER,
    comment       TEXT,
    isrc          TEXT,
    lufs          REAL,
    added_at      INTEGER NOT NULL,
    last_played   INTEGER,
    play_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX tracks_hash ON tracks(file_hash);
CREATE INDEX tracks_bpm ON tracks(bpm);
CREATE INDEX tracks_camelot ON tracks(camelot);
CREATE INDEX tracks_added ON tracks(added_at);
CREATE INDEX tracks_artist ON tracks(artist COLLATE NOCASE);

CREATE TABLE cues (
    id         INTEGER PRIMARY KEY,
    track_id   TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('hot', 'memory', 'loop')),
    idx        INTEGER CHECK (idx BETWEEN 0 AND 255),
    start_sec  REAL NOT NULL,
    end_sec    REAL,
    colour     INTEGER,
    label      TEXT
);
CREATE INDEX cues_track ON cues(track_id, start_sec);

CREATE TABLE beatgrids (
    track_id         TEXT PRIMARY KEY NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    bpm              REAL NOT NULL,
    first_beat_sec   REAL NOT NULL,
    downbeat_offset  INTEGER NOT NULL DEFAULT 0,
    anchors          TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE crates (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    parent_id  INTEGER REFERENCES crates(id) ON DELETE CASCADE,
    is_folder  INTEGER NOT NULL DEFAULT 0,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX crates_parent ON crates(parent_id, position);

CREATE TABLE crate_tracks (
    crate_id  INTEGER NOT NULL REFERENCES crates(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    track_id  TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    PRIMARY KEY (crate_id, position)
);
CREATE INDEX crate_tracks_track ON crate_tracks(track_id);

CREATE TABLE smart_crates (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    rule       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE history_sessions (
    id          INTEGER PRIMARY KEY,
    name        TEXT,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER
);

CREATE TABLE history_entries (
    id          INTEGER PRIMARY KEY,
    session_id  INTEGER NOT NULL REFERENCES history_sessions(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    track_id    TEXT REFERENCES tracks(id) ON DELETE SET NULL,
    played_at   INTEGER NOT NULL,
    deck        INTEGER,
    title       TEXT,
    artist      TEXT
);
CREATE INDEX history_entries_session ON history_entries(session_id, position);

CREATE TABLE analysis_cache (
    track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    version     INTEGER NOT NULL,
    bytes       BLOB NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (track_id, kind)
);
"#,
    // v2: full-text search over the descriptive fields (external-content FTS5).
    r#"
CREATE VIRTUAL TABLE tracks_fts USING fts5(
    title, artist, album, genre, comment,
    content='tracks', content_rowid='rid',
    tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER tracks_fts_ai AFTER INSERT ON tracks BEGIN
    INSERT INTO tracks_fts(rowid, title, artist, album, genre, comment)
    VALUES (new.rid, new.title, new.artist, new.album, new.genre, new.comment);
END;
CREATE TRIGGER tracks_fts_ad AFTER DELETE ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre, comment)
    VALUES ('delete', old.rid, old.title, old.artist, old.album, old.genre, old.comment);
END;
CREATE TRIGGER tracks_fts_au AFTER UPDATE ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre, comment)
    VALUES ('delete', old.rid, old.title, old.artist, old.album, old.genre, old.comment);
    INSERT INTO tracks_fts(rowid, title, artist, album, genre, comment)
    VALUES (new.rid, new.title, new.artist, new.album, new.genre, new.comment);
END;
INSERT INTO tracks_fts(tracks_fts) VALUES ('rebuild');
"#,
    // v3: fixed-grid toggle (WP19-37) + key/value library metadata (WP19-40 protect lock, snapshots).
    r#"
ALTER TABLE beatgrids ADD COLUMN fixed INTEGER NOT NULL DEFAULT 0;
CREATE TABLE library_meta (
    key    TEXT PRIMARY KEY NOT NULL,
    value  TEXT NOT NULL
);
"#,
];

/// Current schema version.
pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

/// Connection pragmas + pending migrations.
pub fn prepare(conn: &mut Connection) -> Result<()> {
    conn.pragma_update(None, "foreign_keys", true)?;
    // `journal_mode` returns a row; in-memory databases answer "memory", which is fine.
    let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    migrate(conn)
}

/// Applies every migration newer than `user_version`.
pub fn migrate(conn: &mut Connection) -> Result<()> {
    let current: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as u32)?;
        tx.commit()?;
    }
    Ok(())
}
