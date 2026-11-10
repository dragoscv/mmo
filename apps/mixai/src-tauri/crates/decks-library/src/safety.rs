//! Library safety: automatic snapshots, protect-library lock, one-click rollback (WP19-40).
//!
//! * Snapshots are consistent online copies made with `VACUUM INTO` (works while WAL is
//!   active and other connections write), written to a `.tmp` file, verified (`quick_check`,
//!   counts, schema version, SHA-256) and renamed into place. A JSON sidecar `<id>.json` next
//!   to `<id>.sqlite` carries the metadata; a snapshot without its sidecar is never listed.
//! * [`Library::restore`] works on paths (an open connection holds the file): it re-reads the
//!   sidecar, verifies the snapshot, takes a `pre-restore` snapshot of the live library, then
//!   swaps the file: the live database AND its `-wal`/`-shm`/`-journal` are renamed aside to
//!   `<live>.pre-restore-old*` first, the copy is renamed into place, and only a successful
//!   swap deletes the old set (a failed swap is rolled back, WAL included).
//! * Everything a sidecar says about file names is distrusted: ids match
//!   `decks-<date>-<time>-<ms>-<reason>[-n]`, the database file must be `<id>.sqlite` next to
//!   the sidecar, and every delete / copy re-checks that the canonical path is a child of the
//!   snapshot folder.
//! * The protect lock lives in `library_meta` (`protected = 1`); every catalogue mutation in
//!   `library.rs` calls [`Library::ensure_writable`], and [`Library::restore`] refuses while the
//!   LIVE library is protected (except when it is too damaged to read: the rescue path). A
//!   restore keeps the lock state of the live library, never the snapshot's. Play history stays
//!   writable.
//!
//! CONTRACT (used by `migrate.rs` WP19-38 and the FFI import path): `is_protected` keeps its
//! signature. Policy and guarantees: `docs/decks/library-safety.md`.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::library::Library;
use crate::util::date_from_unix;
use crate::{Error, Result, schema};

/// `library_meta` key of the protect lock.
pub const META_PROTECTED: &str = "protected";
/// Folder name of the snapshots next to the library file.
pub const SNAPSHOT_DIR: &str = "snapshots";
/// Default automatic snapshot interval (once per day).
pub const DEFAULT_AUTO_INTERVAL: Duration = Duration::from_secs(24 * 3600);
/// Default retention: the newest N snapshots are always kept…
pub const DEFAULT_KEEP_LAST: usize = 10;
/// …plus the newest snapshot of each of the last D days.
pub const DEFAULT_KEEP_DAILY_DAYS: u32 = 30;
/// Suffix of the live files renamed aside during a restore (removed once the swap succeeded).
const OLD_SUFFIX: &str = ".pre-restore-old";
/// SQLite side files of a live database, in deletion-safe order.
const SIDE_SUFFIXES: [&str; 4] = ["", "-wal", "-shm", "-journal"];

/// Metadata of one snapshot (the JSON sidecar).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotInfo {
    /// File stem, e.g. `decks-20261110-081500-123-auto`.
    pub id: String,
    /// Database file name inside the snapshot folder.
    pub file: String,
    /// Creation time, unix milliseconds (UTC).
    pub created_at_ms: i64,
    /// Why it was taken: `auto`, `manual`, `before-import`, `before-schema-v3`, `pre-restore` …
    pub reason: String,
    pub schema_version: u32,
    pub tracks: u64,
    pub crates: u64,
    pub cues: u64,
    pub size_bytes: u64,
    /// Lower-case hex SHA-256 of the database file.
    pub sha256: String,
    /// Absolute path of the database file (filled when read; not stored).
    #[serde(skip)]
    pub path: PathBuf,
}

/// Outcome of [`Library::restore`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreReport {
    pub restored: SnapshotInfo,
    /// Snapshot of the library as it was just before the restore (`None` when no live file
    /// existed). A live file too damaged for `VACUUM INTO` is copied raw instead
    /// (`<stamp>-pre-restore-raw.sqlite`, unlisted) and this stays `None`.
    pub pre_restore: Option<SnapshotInfo>,
}

/// Result of an integrity check.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IntegrityReport {
    /// `quick_check` problems; empty = healthy.
    pub problems: Vec<String>,
}

impl IntegrityReport {
    pub fn ok(&self) -> bool {
        self.problems.is_empty()
    }
}

/// `<db dir>/snapshots`.
pub fn default_snapshot_dir(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default()
        .join(SNAPSHOT_DIR)
}

/// Runs `PRAGMA quick_check` on an open connection.
pub fn quick_check(conn: &Connection) -> Result<IntegrityReport> {
    let mut stmt = conn.prepare("PRAGMA quick_check")?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(IntegrityReport {
        problems: rows.into_iter().filter(|r| r != "ok").collect(),
    })
}

/// Checks a library file without opening it as a [`Library`] (no migrations, read-only).
/// A file SQLite cannot read at all is reported as one problem, not as an error.
pub fn check_integrity(db_path: &Path) -> Result<IntegrityReport> {
    let conn = match open_read_only(db_path) {
        Ok(c) => c,
        Err(e) => {
            return Ok(IntegrityReport {
                problems: vec![e.to_string()],
            });
        }
    };
    match quick_check(&conn) {
        Ok(r) => Ok(r),
        Err(e) => Ok(IntegrityReport {
            problems: vec![e.to_string()],
        }),
    }
}

/// Integrity gate used by [`Library::open`]: a corrupt file is refused with
/// `Error::Format("corrupt library: …")` so the caller can offer a restore.
pub(crate) fn ensure_healthy(conn: &Connection) -> Result<()> {
    let report = quick_check(conn).map_err(|e| Error::Format(format!("corrupt library: {e}")))?;
    match report.problems.first() {
        None => Ok(()),
        Some(p) => Err(Error::Format(format!("corrupt library: {p}"))),
    }
}

fn open_read_only(path: &Path) -> Result<Connection> {
    if !path.is_file() {
        return Err(Error::NotFound(path.display().to_string()));
    }
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?)
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// `20261110-081500-123` (UTC).
fn stamp(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = date_from_unix(secs);
    let tod = secs.rem_euclid(86_400);
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}-{:03}",
        tod / 3600,
        (tod / 60) % 60,
        tod % 60,
        ms.rem_euclid(1000)
    )
}

/// Reason → `[a-z0-9-]{1,40}` (file-name safe).
fn clean_reason(reason: &str) -> String {
    let mut out = String::new();
    for c in reason.trim().chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(40).collect();
    if out.is_empty() {
        "manual".to_owned()
    } else {
        out.trim_end_matches('-').to_owned()
    }
}

// ---------------------------------------------------------------- sidecar hardening

/// True for an id exactly as [`snapshot_conn`] generates it:
/// `decks-<yyyymmdd>-<hhmmss>-<mmm>-<reason>` plus an optional `-<n>` collision suffix, where
/// `reason` is [`clean_reason`] output (`[a-z0-9-]`, no leading/trailing dash).
///
/// Ids and file names come out of a JSON sidecar on disk, and both are turned into paths. An
/// id such as `../../.ssh/id_rsa` or `C:\Windows\x` would make `Path::join` leave the snapshot
/// folder (an absolute path *replaces* the base), so anything not generated by us is dropped.
fn id_is_valid(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("decks-") else {
        return false;
    };
    let mut parts = rest.splitn(4, '-');
    let (Some(date), Some(time), Some(ms), Some(tail)) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let digits = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(date, 8) || !digits(time, 6) || !digits(ms, 3) {
        return false;
    }
    // reason (≤40) plus an optional `-<n>` suffix; never empty, never dash-bounded.
    (1..=48).contains(&tail.len())
        && !tail.starts_with('-')
        && !tail.ends_with('-')
        && tail
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Database path of a snapshot whose sidecar lives in `dir`: the id must be ours and the
/// `file` field must be exactly `<id>.sqlite` (never a path the sidecar chose).
fn snapshot_db_path(dir: &Path, info: &SnapshotInfo) -> Result<PathBuf> {
    if !id_is_valid(&info.id) {
        return Err(Error::Format(format!(
            "snapshot id {:?} is not a MixAI snapshot id",
            info.id
        )));
    }
    let expected = format!("{}.sqlite", info.id);
    if info.file != expected {
        return Err(Error::Format(format!(
            "snapshot {} points at {:?} instead of {expected}",
            info.id, info.file
        )));
    }
    Ok(dir.join(expected))
}

/// Canonicalised `path` must stay inside `dir`. Asserted before every delete or copy driven by
/// sidecar data, so a symlink planted in the snapshot folder cannot redirect it either.
fn assert_inside(dir: &Path, path: &Path) -> Result<()> {
    let base = std::fs::canonicalize(dir)?;
    let target = match std::fs::canonicalize(path) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
            let name = path.file_name().ok_or_else(|| {
                Error::Format(format!("snapshot path {} has no file name", path.display()))
            })?;
            std::fs::canonicalize(parent.unwrap_or(Path::new(".")))?.join(name)
        }
        Err(e) => return Err(Error::Io(e)),
    };
    if target.starts_with(&base) {
        Ok(())
    } else {
        Err(Error::Format(format!(
            "snapshot path {} is outside {}",
            target.display(),
            base.display()
        )))
    }
}

fn count(conn: &Connection, table: &str) -> Result<u64> {
    let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
    Ok(u64::try_from(n).unwrap_or(0))
}

fn user_version(conn: &Connection) -> Result<u32> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// Opens a finished database copy and measures it (also proves it is a readable library).
fn inspect(path: &Path) -> Result<(u32, u64, u64, u64)> {
    let conn = open_read_only(path)?;
    let report = quick_check(&conn)?;
    if let Some(p) = report.problems.first() {
        return Err(Error::Format(format!("snapshot failed quick_check: {p}")));
    }
    Ok((
        user_version(&conn)?,
        count(&conn, "tracks")?,
        count(&conn, "crates")?,
        count(&conn, "cues")?,
    ))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// A copy made by `VACUUM INTO` from a WAL database keeps the WAL flag in its header; switch it
/// to a plain rollback journal so the snapshot is one self-contained file (read-only opens of
/// it never need `-wal`/`-shm` side files).
fn to_rollback_journal(path: &Path) -> Result<()> {
    let conn = Connection::open(path)?;
    let _mode: String = conn.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))?;
    Ok(())
}

/// Consistent online copy of `conn` into `dir` (see the module docs).
pub(crate) fn snapshot_conn(conn: &Connection, dir: &Path, reason: &str) -> Result<SnapshotInfo> {
    std::fs::create_dir_all(dir)?;
    let reason = clean_reason(reason);
    let created_at_ms = now_ms();
    let base = format!("decks-{}-{reason}", stamp(created_at_ms));
    let mut id = base.clone();
    let mut n = 2;
    while dir.join(format!("{id}.sqlite")).exists() || dir.join(format!("{id}.json")).exists() {
        id = format!("{base}-{n}");
        n += 1;
    }
    let file = format!("{id}.sqlite");
    let final_path = dir.join(&file);
    let tmp = dir.join(format!("{id}.sqlite.tmp"));
    let _ = std::fs::remove_file(&tmp);
    let tmp_str = tmp
        .to_str()
        .ok_or_else(|| Error::Unsupported(format!("non UTF-8 snapshot path {}", tmp.display())))?;
    if let Err(e) = conn.execute("VACUUM INTO ?1", [tmp_str]) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    let measured = to_rollback_journal(&tmp)
        .and_then(|()| inspect(&tmp))
        .and_then(|m| Ok((m, sha256_file(&tmp)?)));
    let ((schema_version, tracks, crates, cues), sha256) = match measured {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    };
    let size_bytes = std::fs::metadata(&tmp)?.len();
    std::fs::rename(&tmp, &final_path)?;
    let info = SnapshotInfo {
        id: id.clone(),
        file,
        created_at_ms,
        reason,
        schema_version,
        tracks,
        crates,
        cues,
        size_bytes,
        sha256,
        path: final_path,
    };
    write_atomic(
        &dir.join(format!("{id}.json")),
        &serde_json::to_vec_pretty(&info)?,
    )?;
    Ok(info)
}

/// Reads the sidecar of a snapshot database (`<id>.sqlite` → `<id>.json`).
///
/// The id and the file name in the JSON are validated (see [`snapshot_db_path`]) and the stem
/// of the sidecar must equal the id, so a hand-written sidecar cannot point anywhere else.
pub fn load_snapshot_info(db_file: &Path) -> Result<SnapshotInfo> {
    let sidecar = db_file.with_extension("json");
    let bytes = std::fs::read(&sidecar)
        .map_err(|e| Error::NotFound(format!("snapshot sidecar {}: {e}", sidecar.display())))?;
    let mut info: SnapshotInfo = serde_json::from_slice(&bytes)?;
    let dir = db_file.parent().map(Path::to_path_buf).unwrap_or_default();
    if sidecar.file_stem().and_then(|s| s.to_str()) != Some(info.id.as_str()) {
        return Err(Error::Format(format!(
            "snapshot sidecar {} does not match its id {}",
            sidecar.display(),
            info.id
        )));
    }
    info.path = snapshot_db_path(&dir, &info)?;
    Ok(info)
}

/// Every listed snapshot in `dir`, newest first. A missing folder = no snapshots.
/// Entries whose id or file name is not one we generate are skipped (never "sanitised").
pub fn list_snapshots(dir: &Path) -> Result<Vec<SnapshotInfo>> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut out = Vec::new();
    for entry in rd {
        let p = entry?.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&p) else {
            continue;
        };
        let Ok(mut info) = serde_json::from_slice::<SnapshotInfo>(&bytes) else {
            continue;
        };
        if p.file_stem().and_then(|s| s.to_str()) != Some(info.id.as_str()) {
            continue;
        }
        let Ok(db) = snapshot_db_path(dir, &info) else {
            continue;
        };
        info.path = db;
        if info.path.is_file() {
            out.push(info);
        }
    }
    out.sort_by(|a, b| {
        b.created_at_ms
            .cmp(&a.created_at_ms)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(out)
}

/// Finds a snapshot by id.
pub fn find_snapshot(dir: &Path, id: &str) -> Result<SnapshotInfo> {
    list_snapshots(dir)?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| Error::NotFound(format!("snapshot {id}")))
}

/// Verifies a snapshot before it may replace a library: the sidecar on disk matches, the
/// SHA-256 matches, `quick_check` passes and the schema version is `1..=SCHEMA_VERSION`.
pub fn verify_snapshot(snapshot: &SnapshotInfo) -> Result<SnapshotInfo> {
    let info = load_snapshot_info(&snapshot.path)?;
    if info.id != snapshot.id || info.sha256 != snapshot.sha256 {
        return Err(Error::Format(format!(
            "snapshot {} does not match its sidecar",
            snapshot.id
        )));
    }
    let actual = sha256_file(&info.path)?;
    if actual != info.sha256 {
        return Err(Error::Format(format!(
            "snapshot {} is damaged (sha256 mismatch)",
            info.id
        )));
    }
    let (version, ..) = inspect(&info.path)
        .map_err(|e| Error::Format(format!("snapshot {} is unreadable: {e}", info.id)))?;
    if version != info.schema_version || version == 0 || version > schema::SCHEMA_VERSION {
        return Err(Error::Format(format!(
            "snapshot {} has schema v{version}; this app reads up to v{}",
            info.id,
            schema::SCHEMA_VERSION
        )));
    }
    Ok(info)
}

/// Retention rule for [`prune_at`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Retention {
    pub keep_last: usize,
    pub keep_daily_days: u32,
}

impl Default for Retention {
    fn default() -> Self {
        Self {
            keep_last: DEFAULT_KEEP_LAST,
            keep_daily_days: DEFAULT_KEEP_DAILY_DAYS,
        }
    }
}

/// Removes snapshots outside the retention: the newest `keep_last` always stay, plus the
/// newest snapshot of each UTC day within `keep_daily_days` of `now_ms`. Returns removed ids.
///
/// `keep_last` is clamped to at least 1: a prune never empties the folder. Every file is
/// deleted only after its canonical path is proven to be inside `dir`.
pub fn prune_at(dir: &Path, keep: Retention, now_ms: i64) -> Result<Vec<String>> {
    let all = list_snapshots(dir)?;
    let keep_last = keep.keep_last.max(1);
    let today = now_ms.div_euclid(86_400_000);
    let mut days_kept = std::collections::HashSet::new();
    let mut removed = Vec::new();
    for (i, s) in all.iter().enumerate() {
        let day = s.created_at_ms.div_euclid(86_400_000);
        let in_window = today - day < i64::from(keep.keep_daily_days);
        let daily = in_window && days_kept.insert(day);
        if i < keep_last || daily {
            continue;
        }
        let sidecar = dir.join(format!("{}.json", s.id));
        assert_inside(dir, &s.path)?;
        assert_inside(dir, &sidecar)?;
        std::fs::remove_file(&s.path)?;
        let _ = std::fs::remove_file(&sidecar);
        removed.push(s.id.clone());
    }
    Ok(removed)
}

/// [`prune_at`] with the current time.
pub fn prune(dir: &Path, keep_last: usize, keep_daily_days: u32) -> Result<Vec<String>> {
    prune_at(
        dir,
        Retention {
            keep_last,
            keep_daily_days,
        },
        now_ms(),
    )
}

impl Library {
    /// True when the protect-library lock is on (writes other than play history must be refused
    /// by callers that import or bulk-edit).
    pub fn is_protected(&self) -> Result<bool> {
        let v: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM library_meta WHERE key = ?1",
                [META_PROTECTED],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v.as_deref() == Some("1"))
    }

    /// Turns the protect-library lock on or off (always allowed: it is the switch itself).
    pub fn set_protected(&mut self, on: bool) -> Result<()> {
        self.conn.execute(
            "INSERT INTO library_meta(key, value) VALUES (?1, ?2) \
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [META_PROTECTED, if on { "1" } else { "0" }],
        )?;
        Ok(())
    }

    /// `Err(Error::Protected)` when the lock is on. Called by every catalogue mutation.
    pub fn ensure_writable(&self) -> Result<()> {
        if self.is_protected()? {
            return Err(Error::Protected(
                "the library is protected; turn off Protect library to edit it".into(),
            ));
        }
        Ok(())
    }

    /// Consistent snapshot of the library into `dir`.
    pub fn snapshot(&self, dir: impl AsRef<Path>, reason: &str) -> Result<SnapshotInfo> {
        snapshot_conn(&self.conn, dir.as_ref(), reason)
    }

    /// Mandatory snapshot before a risky operation (`op` = `import`, `migrate`, …).
    pub fn snapshot_before(&self, dir: impl AsRef<Path>, op: &str) -> Result<SnapshotInfo> {
        self.snapshot(dir, &format!("before-{op}"))
    }

    /// Takes an `auto` snapshot when the newest snapshot in `dir` is older than `min_interval`
    /// (or there is none). An empty library is never snapshotted automatically.
    pub fn auto_snapshot_if_due(
        &self,
        dir: impl AsRef<Path>,
        min_interval: Duration,
    ) -> Result<Option<SnapshotInfo>> {
        let dir = dir.as_ref();
        if count(&self.conn, "tracks")? == 0 && count(&self.conn, "crates")? == 0 {
            return Ok(None);
        }
        let interval = i64::try_from(min_interval.as_millis()).unwrap_or(i64::MAX);
        let due = match list_snapshots(dir)?.first() {
            None => true,
            Some(s) => now_ms().saturating_sub(s.created_at_ms) >= interval,
        };
        if due {
            self.snapshot(dir, "auto").map(Some)
        } else {
            Ok(None)
        }
    }

    /// `quick_check` of the open library.
    pub fn integrity(&self) -> Result<IntegrityReport> {
        quick_check(&self.conn)
    }

    /// Deletes snapshots outside the retention ([`prune`]); refused while the library is
    /// protected, because pruning destroys rollback points.
    pub fn prune_snapshots(&self, dir: impl AsRef<Path>, keep: Retention) -> Result<Vec<String>> {
        self.ensure_writable()?;
        prune_at(dir.as_ref(), keep, now_ms())
    }

    /// Replaces the library file at `live_path` with a verified snapshot. Every connection to
    /// `live_path` must be closed first (the FFI layer closes, restores, then reopens).
    ///
    /// * The snapshot must live in the library's own folder (`<live dir>/snapshots`).
    /// * Refused with `Error::Protected` while the live library is protected. Exception (the
    ///   rescue path): a live file SQLite cannot read or that fails `quick_check` can always be
    ///   replaced, since its lock flag cannot be read either.
    /// * The restored file keeps the live library's lock state (not the snapshot's); after the
    ///   rescue path or when no live file existed, the snapshot's state is kept.
    /// * A `pre-restore` snapshot (or a raw copy of a damaged file) is taken first; the swap
    ///   moves the live database and its `-wal`/`-shm`/`-journal` aside, moves the copy in,
    ///   and rolls everything back if any rename fails.
    pub fn restore(snapshot: &SnapshotInfo, live_path: impl AsRef<Path>) -> Result<RestoreReport> {
        restore_with(snapshot, live_path.as_ref(), &mut |a, b| {
            std::fs::rename(a, b)
        })
    }
}

/// What the live file says about the protect lock before a restore.
enum LiveState {
    Absent,
    /// SQLite cannot read it or `quick_check` fails: the rescue path.
    Unreadable,
    Readable {
        protected: bool,
    },
}

fn has_meta_table(conn: &Connection) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'library_meta'",
        [],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

fn live_state(live: &Path) -> Result<LiveState> {
    if !live.is_file() {
        return Ok(LiveState::Absent);
    }
    let Ok(conn) = Connection::open(live) else {
        return Ok(LiveState::Unreadable);
    };
    match quick_check(&conn) {
        Ok(r) if r.ok() => {}
        _ => return Ok(LiveState::Unreadable),
    }
    // A healthy file whose flag cannot be read is NOT the rescue path: refuse (error).
    let protected = if has_meta_table(&conn)? {
        conn.query_row(
            "SELECT value FROM library_meta WHERE key = ?1",
            [META_PROTECTED],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .as_deref()
            == Some("1")
    } else {
        false
    };
    Ok(LiveState::Readable { protected })
}

/// Writes the live lock state into the restore copy (before it replaces anything). A snapshot
/// older than schema v3 has no `library_meta`; it can only ever be unlocked, which is what the
/// (unprotected) live library is when this runs.
fn apply_lock_state(copy: &Path, protected: bool) -> Result<()> {
    let conn = Connection::open(copy)?;
    if has_meta_table(&conn)? {
        conn.execute(
            "INSERT INTO library_meta(key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [META_PROTECTED, if protected { "1" } else { "0" }],
        )?;
    }
    Ok(())
}

/// [`Library::restore`] with an injectable `rename` (tests simulate a failing swap).
fn restore_with(
    snapshot: &SnapshotInfo,
    live: &Path,
    rename: &mut dyn FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<RestoreReport> {
    let info = verify_snapshot(snapshot)?;
    let dir = info
        .path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let own_dir = default_snapshot_dir(live);
    assert_inside(&own_dir, &info.path).map_err(|_| {
        Error::Format(format!(
            "snapshot {} is not in this library's snapshot folder {}",
            info.id,
            own_dir.display()
        ))
    })?;
    let keep_lock = match live_state(live)? {
        LiveState::Readable { protected: true } => {
            return Err(Error::Protected(
                "the library is protected; turn off Protect library to restore a snapshot".into(),
            ));
        }
        LiveState::Readable { protected: false } => Some(false),
        LiveState::Absent | LiveState::Unreadable => None,
    };
    let pre_restore = if live.is_file() {
        pre_restore_copy(live, &dir)?
    } else {
        None
    };
    let tmp = sibling(live, ".restore-tmp");
    let _ = std::fs::remove_file(&tmp);
    if let Err(e) = prepare_copy(&dir, &info.path, &tmp, keep_lock) {
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(sibling(&tmp, "-journal"));
        return Err(e);
    }
    swap_into_place(&tmp, live, rename)?;
    Ok(RestoreReport {
        restored: info,
        pre_restore,
    })
}

/// Copies the verified snapshot to `tmp`, carries the live lock state over and syncs it.
fn prepare_copy(dir: &Path, src: &Path, tmp: &Path, keep_lock: Option<bool>) -> Result<()> {
    assert_inside(dir, src)?;
    std::fs::copy(src, tmp)?;
    if let Some(protected) = keep_lock {
        apply_lock_state(tmp, protected)?;
    }
    // Windows FlushFileBuffers needs a writable handle.
    std::fs::OpenOptions::new()
        .write(true)
        .open(tmp)?
        .sync_all()?;
    Ok(())
}

/// Moves the live database set (`""`, `-wal`, `-shm`, `-journal`) aside to
/// `<live>.pre-restore-old-<stamp>*`, renames `tmp` into place, then deletes the old set.
/// Any failed rename rolls the moved files back (WAL included) and removes `tmp`, so the live
/// library is never left without its committed WAL pages.
fn swap_into_place(
    tmp: &Path,
    live: &Path,
    rename: &mut dyn FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<()> {
    let stamp = stamp(now_ms());
    let mut old = sibling(live, &format!("{OLD_SUFFIX}-{stamp}"));
    let mut n = 2;
    while SIDE_SUFFIXES.iter().any(|s| sibling(&old, s).exists()) {
        old = sibling(live, &format!("{OLD_SUFFIX}-{stamp}-{n}"));
        n += 1;
    }
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut failure = None;
    for suffix in SIDE_SUFFIXES {
        let (from, to) = (sibling(live, suffix), sibling(&old, suffix));
        if !from.exists() {
            continue;
        }
        match rename(&from, &to) {
            Ok(()) => moved.push((from, to)),
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }
    if failure.is_none()
        && let Err(e) = rename(tmp, live)
    {
        failure = Some(e);
    }
    let Some(e) = failure else {
        for (_, to) in &moved {
            let _ = std::fs::remove_file(to);
        }
        return Ok(());
    };
    let _ = std::fs::remove_file(tmp);
    let mut stuck = Vec::new();
    for (from, to) in moved.iter().rev() {
        if rename(to, from).is_err() {
            stuck.push(to.display().to_string());
        }
    }
    if stuck.is_empty() {
        Err(Error::Io(e))
    } else {
        Err(Error::Format(format!(
            "restore failed ({e}) and the live files could not be moved back; they are kept as {}",
            stuck.join(", ")
        )))
    }
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// Snapshot of the live file before it is replaced; raw copy when SQLite cannot vacuum it.
fn pre_restore_copy(live: &Path, dir: &Path) -> Result<Option<SnapshotInfo>> {
    let attempt = Connection::open(live)
        .map_err(Error::from)
        .and_then(|c| snapshot_conn(&c, dir, "pre-restore"));
    match attempt {
        Ok(info) => Ok(Some(info)),
        Err(_) => {
            std::fs::create_dir_all(dir)?;
            let raw = dir.join(format!("decks-{}-pre-restore-raw.sqlite", stamp(now_ms())));
            std::fs::copy(live, &raw)?;
            let wal = sibling(live, "-wal");
            if wal.is_file() {
                std::fs::copy(&wal, sibling(&raw, "-wal"))?;
            }
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons_are_file_name_safe() {
        assert_eq!(clean_reason("Before Import!"), "before-import");
        assert_eq!(clean_reason("  "), "manual");
        assert_eq!(clean_reason("a/b\\c"), "a-b-c");
        assert!(clean_reason(&"x".repeat(80)).len() <= 40);
    }

    #[test]
    fn stamp_is_utc_and_sortable() {
        assert_eq!(stamp(0), "19700101-000000-000");
        assert_eq!(stamp(1_762_762_500_123), "20251110-081500-123");
    }

    #[test]
    fn only_generated_ids_are_valid() {
        for ok in [
            "decks-20261110-081500-123-auto",
            "decks-20261110-081500-123-before-schema-v3",
            "decks-20261110-081500-123-manual-2",
            &format!("decks-20261110-081500-123-{}-12", "x".repeat(40)),
        ] {
            assert!(id_is_valid(ok), "{ok}");
        }
        for bad in [
            "",
            "decks-",
            "auto",
            "../decks-20261110-081500-123-auto",
            "decks-20261110-081500-123-../../x",
            "decks-20261110-081500-123-a\\b",
            "decks-20261110-081500-123-C:",
            "decks-20261110-081500-123-",
            "decks-20261110-081500-123--auto",
            "decks-20261110-081500-123-auto-",
            "decks-20261110-081500-123-Auto",
            "decks-2026111-081500-123-auto",
            "decks-20261110-081500-12-auto",
            "decks-20261110-081500-123-a.sqlite",
            &format!("decks-20261110-081500-123-{}", "x".repeat(49)),
        ] {
            assert!(!id_is_valid(bad), "{bad}");
        }
    }

    fn write(p: &Path, s: &str) {
        std::fs::write(p, s).unwrap();
    }

    fn read(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap()
    }

    fn leftovers(dir: &Path, needle: &str) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(needle))
            .collect()
    }

    #[test]
    fn swap_failure_on_the_final_rename_rolls_back_db_and_wal() {
        let tmp = tempfile::tempdir().unwrap();
        let live = tmp.path().join("lib.sqlite");
        let new = tmp.path().join("lib.sqlite.restore-tmp");
        write(&live, "LIVE");
        write(&sibling(&live, "-wal"), "COMMITTED-WAL");
        write(&sibling(&live, "-shm"), "SHM");
        write(&new, "SNAPSHOT");
        let live_c = live.clone();
        let err = swap_into_place(&new, &live, &mut |a, b| {
            if b == live_c && a.to_string_lossy().ends_with(".restore-tmp") {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "locked by antivirus",
                ))
            } else {
                std::fs::rename(a, b)
            }
        })
        .unwrap_err();
        assert!(err.to_string().contains("antivirus"), "{err}");
        assert_eq!(read(&live), "LIVE");
        assert_eq!(read(&sibling(&live, "-wal")), "COMMITTED-WAL", "WAL kept");
        assert_eq!(read(&sibling(&live, "-shm")), "SHM");
        assert!(!new.exists(), "restore temp file cleaned up");
        assert!(leftovers(tmp.path(), OLD_SUFFIX).is_empty());
    }

    #[test]
    fn swap_failure_while_moving_the_wal_puts_the_db_back() {
        let tmp = tempfile::tempdir().unwrap();
        let live = tmp.path().join("lib.sqlite");
        let new = tmp.path().join("lib.sqlite.restore-tmp");
        write(&live, "LIVE");
        write(&sibling(&live, "-wal"), "COMMITTED-WAL");
        write(&new, "SNAPSHOT");
        let wal = sibling(&live, "-wal");
        let err = swap_into_place(&new, &live, &mut |a, b| {
            if a == wal {
                Err(std::io::Error::other("wal in use"))
            } else {
                std::fs::rename(a, b)
            }
        })
        .unwrap_err();
        assert!(err.to_string().contains("wal in use"), "{err}");
        assert_eq!(read(&live), "LIVE");
        assert_eq!(read(&wal), "COMMITTED-WAL");
        assert!(!new.exists());
        assert!(leftovers(tmp.path(), OLD_SUFFIX).is_empty());
    }

    #[test]
    fn swap_success_replaces_db_and_drops_the_old_set() {
        let tmp = tempfile::tempdir().unwrap();
        let live = tmp.path().join("lib.sqlite");
        let new = tmp.path().join("lib.sqlite.restore-tmp");
        write(&live, "LIVE");
        write(&sibling(&live, "-wal"), "OLD-WAL");
        write(&sibling(&live, "-journal"), "OLD-JOURNAL");
        write(&new, "SNAPSHOT");
        swap_into_place(&new, &live, &mut |a, b| std::fs::rename(a, b)).unwrap();
        assert_eq!(read(&live), "SNAPSHOT");
        assert!(!sibling(&live, "-wal").exists(), "stale WAL must not apply");
        assert!(!sibling(&live, "-journal").exists());
        assert!(!new.exists());
        assert!(leftovers(tmp.path(), OLD_SUFFIX).is_empty());
    }

    #[test]
    fn failed_restore_leaves_the_live_library_readable_and_no_temp_file() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("lib.sqlite");
        let dir = default_snapshot_dir(&db);
        let snap = {
            let mut lib = Library::open(&db).unwrap();
            lib.create_crate("Snap", None, false).unwrap();
            lib.snapshot(&dir, "manual").unwrap()
        };
        {
            let mut lib = Library::open(&db).unwrap();
            lib.create_crate("Live", None, false).unwrap();
        }
        let live = db.clone();
        let err = restore_with(&snap, &db, &mut |a, b| {
            // Only the final swap-in fails; the roll-back renames must still work.
            if b == live && a.to_string_lossy().ends_with(".restore-tmp") {
                Err(std::io::Error::other("rename refused"))
            } else {
                std::fs::rename(a, b)
            }
        })
        .unwrap_err();
        assert!(err.to_string().contains("rename refused"), "{err}");
        let lib = Library::open(&db).unwrap();
        assert_eq!(lib.crates().unwrap().len(), 2, "live data intact");
        assert!(!sibling(&db, ".restore-tmp").exists());
        assert!(leftovers(tmp.path(), OLD_SUFFIX).is_empty());
    }
}
