//! The SQLite-backed library: tracks, cues, grids, crates, smart crates, history, analysis cache.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params, params_from_iter};
use serde::{Deserialize, Serialize};

use crate::keys::MusicalKey;
use crate::model::{BeatGrid, Collection, Cue, CueKind, GridAnchor, Playlist, Rgb, TrackRecord};
use crate::smart::{self, Rule};
use crate::util::{self, now_unix, path_key};
use crate::{Error, Result, schema};

/// Crate row (folder or playlist).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CrateInfo {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub is_folder: bool,
    pub position: i64,
}

/// Smart crate row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SmartCrate {
    pub id: i64,
    pub name: String,
    pub rule: Rule,
}

/// History session row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistorySession {
    pub id: i64,
    pub name: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

/// One played track of a session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub position: i64,
    pub track_id: Option<String>,
    pub played_at: i64,
    pub deck: Option<u8>,
    pub title: Option<String>,
    pub artist: Option<String>,
}

/// Progress of [`Library::scan_folder`].
#[derive(Debug, Clone)]
pub struct ScanProgress {
    pub done: usize,
    pub total: usize,
    pub current: String,
}

/// Scan outcome.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ScanReport {
    pub added: usize,
    pub updated: usize,
    pub failed: Vec<(String, String)>,
}

/// How an upsert matched an existing row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Upserted {
    Inserted,
    MatchedPath,
    MatchedHash,
}

const TRACK_COLUMNS: &str = "t.id, t.path, t.file_hash, t.title, t.artist, t.album, t.genre, \
    t.label, t.year, t.duration_sec, t.bitrate, t.sample_rate, t.bpm, t.key_pc, t.key_minor, \
    t.energy, t.rating, t.colour, t.comment, t.isrc, t.lufs, t.added_at, t.last_played, t.play_count";

fn row_to_track(r: &Row<'_>) -> rusqlite::Result<TrackRecord> {
    let key_pc: Option<u8> = r.get(13)?;
    let key_minor: Option<bool> = r.get(14)?;
    Ok(TrackRecord {
        id: Some(r.get(0)?),
        source_id: None,
        path: r.get(1)?,
        file_hash: r.get(2)?,
        title: r.get(3)?,
        artist: r.get(4)?,
        album: r.get(5)?,
        genre: r.get(6)?,
        label: r.get(7)?,
        year: r.get(8)?,
        duration_sec: r.get(9)?,
        bitrate: r.get(10)?,
        sample_rate: r.get(11)?,
        bpm: r.get(12)?,
        key: key_pc.and_then(|pc| MusicalKey::new(pc, key_minor.unwrap_or(false))),
        energy: r.get(15)?,
        rating: r.get(16)?,
        colour: r.get::<_, Option<u32>>(17)?.map(Rgb::from_u32),
        comment: r.get(18)?,
        isrc: r.get(19)?,
        lufs: r.get(20)?,
        added_at: r.get(21)?,
        last_played: r.get(22)?,
        play_count: r.get(23)?,
        cues: Vec::new(),
        grid: None,
    })
}

fn opt_merge<T: Clone>(new: &Option<T>, old: Option<T>) -> Option<T> {
    new.clone().or(old)
}

/// The library handle (one SQLite connection).
///
/// Every catalogue mutation (tracks, cues, grids, crates, smart crates, scans, imports) first
/// calls [`Library::ensure_writable`] and fails with `Error::Protected` while the
/// protect-library lock is on (WP19-40). Play history and the analysis cache stay writable.
pub struct Library {
    pub(crate) conn: Connection,
}

impl Library {
    /// Opens (or creates) a library file and applies pending migrations.
    ///
    /// A corrupt file is refused (`PRAGMA quick_check`, `Error::Format("corrupt library: …")`)
    /// so the shell can offer a snapshot restore. Before a schema upgrade of an existing
    /// library a `before-schema-vN` snapshot goes to `<db dir>/snapshots`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let mut conn = Connection::open(path)?;
        crate::safety::ensure_healthy(&conn)?;
        let version: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > 0 && version < schema::SCHEMA_VERSION {
            crate::safety::snapshot_conn(
                &conn,
                &crate::safety::default_snapshot_dir(path),
                &format!("before-schema-v{}", schema::SCHEMA_VERSION),
            )?;
        }
        schema::prepare(&mut conn)?;
        Ok(Self { conn })
    }

    /// In-memory library (tests, previews).
    pub fn open_in_memory() -> Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        schema::prepare(&mut conn)?;
        Ok(Self { conn })
    }

    pub fn schema_version(&self) -> Result<u32> {
        Ok(self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    /// Raw connection for advanced callers.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    // ---------------------------------------------------------------- tracks

    /// Inserts or merges a track (match by path, then by file hash) including cues and grid.
    /// Non-empty incoming fields win; cues/grid are replaced only when the record carries any.
    pub fn upsert_track(&mut self, rec: &TrackRecord) -> Result<(String, Upserted)> {
        self.ensure_writable()?;
        let tx = self.conn.transaction()?;
        let out = upsert_in(&tx, rec)?;
        tx.commit()?;
        Ok(out)
    }

    /// Batch upsert in one transaction.
    pub fn upsert_tracks(&mut self, recs: &[TrackRecord]) -> Result<Vec<(String, Upserted)>> {
        self.ensure_writable()?;
        let tx = self.conn.transaction()?;
        let out = recs
            .iter()
            .map(|r| upsert_in(&tx, r))
            .collect::<Result<Vec<_>>>()?;
        tx.commit()?;
        Ok(out)
    }

    pub fn track(&self, id: &str) -> Result<Option<TrackRecord>> {
        let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks t WHERE t.id = ?1");
        let rec = self.conn.query_row(&sql, [id], row_to_track).optional()?;
        rec.map(|r| self.hydrate(r)).transpose()
    }

    pub fn track_by_path(&self, path: &str) -> Result<Option<TrackRecord>> {
        let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks t WHERE t.path_key = ?1");
        let rec = self
            .conn
            .query_row(&sql, [path_key(path)], row_to_track)
            .optional()?;
        rec.map(|r| self.hydrate(r)).transpose()
    }

    pub fn track_count(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))?)
    }

    pub fn all_tracks(&self) -> Result<Vec<TrackRecord>> {
        let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks t ORDER BY t.rid");
        self.query_tracks(&sql, Vec::new())
    }

    pub fn delete_track(&mut self, id: &str) -> Result<bool> {
        self.ensure_writable()?;
        Ok(self
            .conn
            .execute("DELETE FROM tracks WHERE id = ?1", [id])?
            > 0)
    }

    fn query_tracks(&self, sql: &str, params: Vec<SqlValue>) -> Result<Vec<TrackRecord>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt
            .query_map(params_from_iter(params), row_to_track)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(|r| self.hydrate(r)).collect()
    }

    fn hydrate(&self, mut rec: TrackRecord) -> Result<TrackRecord> {
        let id = rec.id.clone().unwrap_or_default();
        rec.cues = self.cues(&id)?;
        rec.grid = self.grid(&id)?;
        Ok(rec)
    }

    pub fn cues(&self, track_id: &str) -> Result<Vec<Cue>> {
        let mut stmt = self.conn.prepare(
            "SELECT kind, idx, start_sec, end_sec, colour, label FROM cues \
             WHERE track_id = ?1 ORDER BY start_sec, id",
        )?;
        let cues = stmt
            .query_map([track_id], |r| {
                let kind: String = r.get(0)?;
                Ok(Cue {
                    kind: CueKind::parse(&kind).unwrap_or(CueKind::Memory),
                    index: r.get(1)?,
                    start_sec: r.get(2)?,
                    end_sec: r.get(3)?,
                    colour: r.get::<_, Option<u32>>(4)?.map(Rgb::from_u32),
                    label: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(cues)
    }

    pub fn grid(&self, track_id: &str) -> Result<Option<BeatGrid>> {
        let row = self
            .conn
            .query_row(
                "SELECT bpm, first_beat_sec, downbeat_offset, anchors, fixed FROM beatgrids WHERE track_id = ?1",
                [track_id],
                |r| {
                    Ok((
                        r.get::<_, f64>(0)?,
                        r.get::<_, f64>(1)?,
                        r.get::<_, u8>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, bool>(4)?,
                    ))
                },
            )
            .optional()?;
        row.map(|(bpm, first, off, anchors, fixed)| {
            Ok(BeatGrid {
                bpm,
                first_beat_sec: first,
                downbeat_offset: off,
                anchors: serde_json::from_str::<Vec<GridAnchor>>(&anchors)?,
                fixed,
            })
        })
        .transpose()
    }

    pub fn set_cues(&mut self, track_id: &str, cues: &[Cue]) -> Result<()> {
        self.ensure_writable()?;
        let tx = self.conn.transaction()?;
        write_cues(&tx, track_id, cues)?;
        tx.commit()?;
        Ok(())
    }

    pub fn set_grid(&mut self, track_id: &str, grid: &BeatGrid) -> Result<()> {
        self.ensure_writable()?;
        write_grid(&self.conn, track_id, grid)
    }

    // ---------------------------------------------------------------- search

    /// Full-text search (FTS5) over title/artist/album/genre/comment. Each whitespace token
    /// is a prefix match; all tokens must match. Empty query = every track.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<TrackRecord>> {
        let tokens: Vec<String> = query
            .split_whitespace()
            .map(|t| {
                t.chars()
                    .filter(|c| c.is_alphanumeric())
                    .collect::<String>()
            })
            .filter(|t| !t.is_empty())
            .map(|t| format!("\"{t}\"*"))
            .collect();
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        if tokens.is_empty() {
            let sql =
                format!("SELECT {TRACK_COLUMNS} FROM tracks t ORDER BY t.added_at DESC LIMIT ?1");
            return self.query_tracks(&sql, vec![SqlValue::Integer(limit)]);
        }
        let sql = format!(
            "SELECT {TRACK_COLUMNS} FROM tracks_fts JOIN tracks t ON t.rid = tracks_fts.rowid \
             WHERE tracks_fts MATCH ?1 ORDER BY bm25(tracks_fts) LIMIT ?2"
        );
        self.query_tracks(
            &sql,
            vec![SqlValue::Text(tokens.join(" ")), SqlValue::Integer(limit)],
        )
    }

    // ---------------------------------------------------------------- scan

    /// Recursively scans `dir` for audio files, reads tags with lofty and upserts them.
    /// `progress` is called once per file.
    pub fn scan_folder(
        &mut self,
        dir: impl AsRef<Path>,
        mut progress: impl FnMut(&ScanProgress),
    ) -> Result<ScanReport> {
        self.ensure_writable()?;
        let files: Vec<_> = walkdir::WalkDir::new(dir.as_ref())
            .follow_links(true)
            .into_iter()
            .filter_map(std::result::Result::ok)
            .filter(|e| e.file_type().is_file() && util::is_audio_file(e.path()))
            .map(|e| e.into_path())
            .collect();
        let total = files.len();
        let mut report = ScanReport::default();
        let tx = self.conn.transaction()?;
        for (i, path) in files.iter().enumerate() {
            let shown = util::path_to_string(path);
            progress(&ScanProgress {
                done: i,
                total,
                current: shown.clone(),
            });
            match crate::tags::read_file(path) {
                Ok(mut rec) => {
                    rec.file_hash = util::quick_hash(path).ok();
                    match upsert_in(&tx, &rec)?.1 {
                        Upserted::Inserted => report.added += 1,
                        _ => report.updated += 1,
                    }
                }
                Err(e) => report.failed.push((shown, e.to_string())),
            }
        }
        tx.commit()?;
        progress(&ScanProgress {
            done: total,
            total,
            current: String::new(),
        });
        Ok(report)
    }

    // ---------------------------------------------------------------- crates

    pub fn create_crate(
        &mut self,
        name: &str,
        parent_id: Option<i64>,
        is_folder: bool,
    ) -> Result<i64> {
        self.ensure_writable()?;
        let pos: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM crates WHERE parent_id IS ?1",
            [parent_id],
            |r| r.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO crates(name, parent_id, is_folder, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![name, parent_id, is_folder, pos, now_unix()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Finds a crate by name under `parent_id`, creating it when missing.
    pub fn ensure_crate(
        &mut self,
        name: &str,
        parent_id: Option<i64>,
        is_folder: bool,
    ) -> Result<i64> {
        let found: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM crates WHERE name = ?1 AND parent_id IS ?2 AND is_folder = ?3",
                params![name, parent_id, is_folder],
                |r| r.get(0),
            )
            .optional()?;
        match found {
            Some(id) => Ok(id),
            None => self.create_crate(name, parent_id, is_folder),
        }
    }

    /// Renames a crate; `false` when it does not exist.
    pub fn rename_crate(&mut self, crate_id: i64, name: &str) -> Result<bool> {
        self.ensure_writable()?;
        Ok(self.conn.execute(
            "UPDATE crates SET name = ?1 WHERE id = ?2",
            params![name, crate_id],
        )? > 0)
    }

    /// Deletes a crate (children and memberships cascade; tracks stay).
    pub fn delete_crate(&mut self, crate_id: i64) -> Result<bool> {
        self.ensure_writable()?;
        Ok(self
            .conn
            .execute("DELETE FROM crates WHERE id = ?1", [crate_id])?
            > 0)
    }

    pub fn crates(&self) -> Result<Vec<CrateInfo>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, parent_id, is_folder, position FROM crates ORDER BY parent_id, position, id",
        )?;
        let out = stmt
            .query_map([], |r| {
                Ok(CrateInfo {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    parent_id: r.get(2)?,
                    is_folder: r.get(3)?,
                    position: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(out)
    }

    /// Replaces a crate's ordered track list.
    pub fn set_crate_tracks(&mut self, crate_id: i64, track_ids: &[String]) -> Result<()> {
        self.ensure_writable()?;
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM crate_tracks WHERE crate_id = ?1", [crate_id])?;
        {
            let mut ins = tx.prepare(
                "INSERT INTO crate_tracks(crate_id, position, track_id) VALUES (?1, ?2, ?3)",
            )?;
            for (i, id) in track_ids.iter().enumerate() {
                ins.execute(params![crate_id, i as i64, id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn add_to_crate(&mut self, crate_id: i64, track_id: &str) -> Result<()> {
        self.ensure_writable()?;
        self.conn.execute(
            "INSERT INTO crate_tracks(crate_id, position, track_id) \
             VALUES (?1, (SELECT COALESCE(MAX(position) + 1, 0) FROM crate_tracks WHERE crate_id = ?1), ?2)",
            params![crate_id, track_id],
        )?;
        Ok(())
    }

    pub fn crate_tracks(&self, crate_id: i64) -> Result<Vec<TrackRecord>> {
        let sql = format!(
            "SELECT {TRACK_COLUMNS} FROM crate_tracks c JOIN tracks t ON t.id = c.track_id \
             WHERE c.crate_id = ?1 ORDER BY c.position"
        );
        self.query_tracks(&sql, vec![SqlValue::Integer(crate_id)])
    }

    /// Folder path (names from the root) of a crate.
    pub fn crate_folder_path(&self, crate_id: i64) -> Result<Vec<String>> {
        let mut out = Vec::new();
        let mut cur: Option<i64> = self.conn.query_row(
            "SELECT parent_id FROM crates WHERE id = ?1",
            [crate_id],
            |r| r.get(0),
        )?;
        let mut guard = 0;
        while let Some(id) = cur {
            let (name, parent): (String, Option<i64>) = self.conn.query_row(
                "SELECT name, parent_id FROM crates WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            out.push(name);
            cur = parent;
            guard += 1;
            if guard > 64 {
                return Err(Error::Format("crate tree cycle".into()));
            }
        }
        out.reverse();
        Ok(out)
    }

    // ---------------------------------------------------------------- smart crates

    pub fn create_smart_crate(&mut self, name: &str, rule: &Rule) -> Result<i64> {
        self.ensure_writable()?;
        smart::compile(rule, now_unix())?; // validate before storing
        self.conn.execute(
            "INSERT INTO smart_crates(name, rule, created_at) VALUES (?1, ?2, ?3)",
            params![name, serde_json::to_string(rule)?, now_unix()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn delete_smart_crate(&mut self, id: i64) -> Result<bool> {
        self.ensure_writable()?;
        Ok(self
            .conn
            .execute("DELETE FROM smart_crates WHERE id = ?1", [id])?
            > 0)
    }

    pub fn smart_crates(&self) -> Result<Vec<SmartCrate>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, rule FROM smart_crates ORDER BY id")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(id, name, rule)| {
                Ok(SmartCrate {
                    id,
                    name,
                    rule: serde_json::from_str(&rule)?,
                })
            })
            .collect()
    }

    /// Evaluates a rule against the library.
    pub fn evaluate_rule(&self, rule: &Rule) -> Result<Vec<TrackRecord>> {
        let compiled = smart::compile(rule, now_unix())?;
        let sql = format!(
            "SELECT {TRACK_COLUMNS} FROM tracks t WHERE {} ORDER BY t.artist COLLATE NOCASE, t.title COLLATE NOCASE",
            compiled.sql
        );
        self.query_tracks(&sql, compiled.params)
    }

    pub fn evaluate_smart_crate(&self, id: i64) -> Result<Vec<TrackRecord>> {
        let rule: String = self
            .conn
            .query_row("SELECT rule FROM smart_crates WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("smart crate {id}")))?;
        self.evaluate_rule(&serde_json::from_str(&rule)?)
    }

    // ---------------------------------------------------------------- history

    pub fn start_session(&mut self, name: Option<&str>) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO history_sessions(name, started_at) VALUES (?1, ?2)",
            params![name, now_unix()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn end_session(&mut self, session_id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE history_sessions SET ended_at = ?2 WHERE id = ?1",
            params![session_id, now_unix()],
        )?;
        Ok(())
    }

    /// Records a play: appends to the session and bumps the track's play counters.
    pub fn record_play(&mut self, session_id: i64, track_id: &str, deck: Option<u8>) -> Result<()> {
        let tx = self.conn.transaction()?;
        let now = now_unix();
        let (title, artist): (Option<String>, Option<String>) = tx
            .query_row(
                "SELECT title, artist FROM tracks WHERE id = ?1",
                [track_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("track {track_id}")))?;
        tx.execute(
            "INSERT INTO history_entries(session_id, position, track_id, played_at, deck, title, artist) \
             VALUES (?1, (SELECT COALESCE(MAX(position) + 1, 0) FROM history_entries WHERE session_id = ?1), ?2, ?3, ?4, ?5, ?6)",
            params![session_id, track_id, now, deck, title, artist],
        )?;
        tx.execute(
            "UPDATE tracks SET play_count = play_count + 1, last_played = ?2 WHERE id = ?1",
            params![track_id, now],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn sessions(&self) -> Result<Vec<HistorySession>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, started_at, ended_at FROM history_sessions ORDER BY started_at DESC, id DESC")?;
        let out = stmt
            .query_map([], |r| {
                Ok(HistorySession {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    started_at: r.get(2)?,
                    ended_at: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(out)
    }

    pub fn session_entries(&self, session_id: i64) -> Result<Vec<HistoryEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT position, track_id, played_at, deck, title, artist FROM history_entries \
             WHERE session_id = ?1 ORDER BY position",
        )?;
        let out = stmt
            .query_map([session_id], |r| {
                Ok(HistoryEntry {
                    position: r.get(0)?,
                    track_id: r.get(1)?,
                    played_at: r.get(2)?,
                    deck: r.get(3)?,
                    title: r.get(4)?,
                    artist: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(out)
    }

    /// Plain-text tracklist (`01. Artist - Title`) for sharing a set.
    pub fn tracklist(&self, session_id: i64) -> Result<String> {
        let mut out = String::new();
        for e in self.session_entries(session_id)? {
            let artist = e.artist.unwrap_or_default();
            let title = e.title.unwrap_or_default();
            out.push_str(&format!("{:02}. {artist} - {title}\n", e.position + 1));
        }
        Ok(out)
    }

    // ---------------------------------------------------------------- analysis cache

    pub fn put_analysis(
        &mut self,
        track_id: &str,
        kind: &str,
        version: u32,
        bytes: &[u8],
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO analysis_cache(track_id, kind, version, bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(track_id, kind) DO UPDATE SET version = excluded.version, bytes = excluded.bytes, created_at = excluded.created_at",
            params![track_id, kind, version, bytes, now_unix()],
        )?;
        Ok(())
    }

    /// Returns cached bytes only when stored with exactly `version` (stale = recompute).
    pub fn get_analysis(
        &self,
        track_id: &str,
        kind: &str,
        version: u32,
    ) -> Result<Option<Vec<u8>>> {
        Ok(self
            .conn
            .query_row(
                "SELECT bytes FROM analysis_cache WHERE track_id = ?1 AND kind = ?2 AND version = ?3",
                params![track_id, kind, version],
                |r| r.get(0),
            )
            .optional()?)
    }

    // ---------------------------------------------------------------- collections

    /// Exports the whole library (tracks + crates as playlists) in neutral form.
    pub fn to_collection(&self) -> Result<Collection> {
        let tracks = self.all_tracks()?;
        let all = self.crates()?;
        let mut children: HashMap<Option<i64>, Vec<&CrateInfo>> = HashMap::new();
        for c in &all {
            children.entry(c.parent_id).or_default().push(c);
        }
        for v in children.values_mut() {
            v.sort_by_key(|c| (c.position, c.id));
        }
        let mut playlists = Vec::new();
        let mut stack: Vec<(&CrateInfo, Vec<String>)> = children
            .get(&None)
            .map(|v| v.iter().rev().map(|c| (*c, Vec::new())).collect())
            .unwrap_or_default();
        while let Some((c, folder)) = stack.pop() {
            if c.is_folder {
                let mut sub = folder.clone();
                sub.push(c.name.clone());
                if let Some(kids) = children.get(&Some(c.id)) {
                    stack.extend(kids.iter().rev().map(|k| (*k, sub.clone())));
                }
            } else {
                playlists.push(Playlist {
                    name: c.name.clone(),
                    folder,
                    tracks: self
                        .crate_tracks(c.id)?
                        .into_iter()
                        .map(|t| t.path)
                        .collect(),
                });
            }
        }
        Ok(Collection { tracks, playlists })
    }

    /// Imports a neutral collection; returns path → library id for every track.
    pub fn import_collection(&mut self, col: &Collection) -> Result<HashMap<String, String>> {
        self.ensure_writable()?;
        let mut ids = HashMap::new();
        for (rec, (id, _)) in col.tracks.iter().zip(self.upsert_tracks(&col.tracks)?) {
            ids.insert(path_key(&rec.path), id);
        }
        for pl in &col.playlists {
            let mut parent = None;
            for f in &pl.folder {
                parent = Some(self.ensure_crate(f, parent, true)?);
            }
            let crate_id = self.ensure_crate(&pl.name, parent, false)?;
            let track_ids: Vec<String> = pl
                .tracks
                .iter()
                .filter_map(|p| ids.get(&path_key(p)).cloned())
                .collect();
            self.set_crate_tracks(crate_id, &track_ids)?;
        }
        Ok(ids)
    }
}

fn find_existing(tx: &Transaction<'_>, rec: &TrackRecord) -> Result<Option<(String, Upserted)>> {
    if let Some(id) = tx
        .query_row(
            "SELECT id FROM tracks WHERE path_key = ?1",
            [path_key(&rec.path)],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(Some((id, Upserted::MatchedPath)));
    }
    if let Some(h) = rec.file_hash.as_deref().filter(|h| !h.is_empty())
        && let Some(id) = tx
            .query_row(
                "SELECT id FROM tracks WHERE file_hash = ?1 LIMIT 1",
                [h],
                |r| r.get::<_, String>(0),
            )
            .optional()?
    {
        return Ok(Some((id, Upserted::MatchedHash)));
    }
    Ok(None)
}

/// Upsert inside the caller's transaction (also used by `migrate.rs` for one-transaction imports).
pub(crate) fn upsert_in(tx: &Transaction<'_>, rec: &TrackRecord) -> Result<(String, Upserted)> {
    let existing = find_existing(tx, rec)?;
    let (id, how) = match existing {
        Some((id, how)) => {
            let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks t WHERE t.id = ?1");
            let old = tx.query_row(&sql, [&id], row_to_track)?;
            // Hash match while the old file still exists = a duplicate copy, not a move:
            // keep the existing row's path and metadata, only fill its gaps.
            let duplicate = how == Upserted::MatchedHash && Path::new(&old.path).is_file();
            let merged = if duplicate {
                let mut keep = old.clone();
                keep.id = None;
                merge(
                    &keep,
                    TrackRecord {
                        id: old.id,
                        ..rec.clone()
                    },
                )
            } else {
                merge(rec, old)
            };
            write_track(tx, &id, &merged, false)?;
            (id, how)
        }
        None => {
            let id = rec
                .id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            write_track(tx, &id, rec, true)?;
            (id, Upserted::Inserted)
        }
    };
    if !rec.cues.is_empty() {
        write_cues(tx, &id, &rec.cues)?;
    }
    if let Some(g) = &rec.grid {
        write_grid(tx, &id, g)?;
    }
    Ok((id, how))
}

fn merge(new: &TrackRecord, old: TrackRecord) -> TrackRecord {
    TrackRecord {
        id: old.id,
        source_id: None,
        // A hash match means the file moved: keep the new location.
        path: if new.path.is_empty() {
            old.path
        } else {
            new.path.clone()
        },
        file_hash: opt_merge(&new.file_hash, old.file_hash),
        title: opt_merge(&new.title, old.title),
        artist: opt_merge(&new.artist, old.artist),
        album: opt_merge(&new.album, old.album),
        genre: opt_merge(&new.genre, old.genre),
        label: opt_merge(&new.label, old.label),
        year: opt_merge(&new.year, old.year),
        duration_sec: opt_merge(&new.duration_sec, old.duration_sec),
        bitrate: opt_merge(&new.bitrate, old.bitrate),
        sample_rate: opt_merge(&new.sample_rate, old.sample_rate),
        bpm: opt_merge(&new.bpm, old.bpm),
        key: opt_merge(&new.key, old.key),
        energy: opt_merge(&new.energy, old.energy),
        rating: opt_merge(&new.rating, old.rating),
        colour: opt_merge(&new.colour, old.colour),
        comment: opt_merge(&new.comment, old.comment),
        isrc: opt_merge(&new.isrc, old.isrc),
        lufs: opt_merge(&new.lufs, old.lufs),
        added_at: old.added_at.or(new.added_at),
        last_played: match (new.last_played, old.last_played) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        },
        play_count: new.play_count.max(old.play_count),
        cues: Vec::new(),
        grid: None,
    }
}

fn write_track(conn: &Connection, id: &str, r: &TrackRecord, insert: bool) -> Result<()> {
    let key_pc = r.key.map(|k| k.pitch_class);
    let key_minor = r.key.map(|k| k.minor);
    let camelot = r.key.map(|k| k.camelot());
    let colour = r.colour.map(Rgb::to_u32);
    let energy = r.energy.filter(|e| (1..=10).contains(e));
    let rating = r.rating.map(|x| x.min(5));
    let added = r.added_at.unwrap_or_else(now_unix);
    let pk = path_key(&r.path);
    let p = params![
        id,
        r.path,
        pk,
        r.file_hash,
        r.title,
        r.artist,
        r.album,
        r.genre,
        r.label,
        r.year,
        r.duration_sec,
        r.bitrate,
        r.sample_rate,
        r.bpm,
        key_pc,
        key_minor,
        camelot,
        energy,
        rating,
        colour,
        r.comment,
        r.isrc,
        r.lufs,
        added,
        r.last_played,
        r.play_count,
    ];
    if insert {
        conn.execute(
            "INSERT INTO tracks(id, path, path_key, file_hash, title, artist, album, genre, label, year, \
             duration_sec, bitrate, sample_rate, bpm, key_pc, key_minor, camelot, energy, rating, colour, \
             comment, isrc, lufs, added_at, last_played, play_count) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, \
             ?21, ?22, ?23, ?24, ?25, ?26)",
            p,
        )?;
    } else {
        conn.execute(
            "UPDATE tracks SET path = ?2, path_key = ?3, file_hash = ?4, title = ?5, artist = ?6, album = ?7, \
             genre = ?8, label = ?9, year = ?10, duration_sec = ?11, bitrate = ?12, sample_rate = ?13, bpm = ?14, \
             key_pc = ?15, key_minor = ?16, camelot = ?17, energy = ?18, rating = ?19, colour = ?20, \
             comment = ?21, isrc = ?22, lufs = ?23, added_at = ?24, last_played = ?25, play_count = ?26 \
             WHERE id = ?1",
            p,
        )?;
    }
    Ok(())
}

fn write_cues(conn: &Connection, track_id: &str, cues: &[Cue]) -> Result<()> {
    conn.execute("DELETE FROM cues WHERE track_id = ?1", [track_id])?;
    let mut ins = conn.prepare(
        "INSERT INTO cues(track_id, kind, idx, start_sec, end_sec, colour, label) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    for c in cues {
        ins.execute(params![
            track_id,
            c.kind.as_str(),
            c.index,
            c.start_sec,
            c.end_sec,
            c.colour.map(Rgb::to_u32),
            c.label,
        ])?;
    }
    Ok(())
}

fn write_grid(conn: &Connection, track_id: &str, g: &BeatGrid) -> Result<()> {
    conn.execute(
        "INSERT INTO beatgrids(track_id, bpm, first_beat_sec, downbeat_offset, anchors, fixed) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(track_id) DO UPDATE SET bpm = excluded.bpm, first_beat_sec = excluded.first_beat_sec, \
         downbeat_offset = excluded.downbeat_offset, anchors = excluded.anchors, fixed = excluded.fixed",
        params![
            track_id,
            g.bpm,
            g.first_beat_sec,
            g.downbeat_offset,
            serde_json::to_string(&g.anchors)?,
            g.fixed
        ],
    )?;
    Ok(())
}
