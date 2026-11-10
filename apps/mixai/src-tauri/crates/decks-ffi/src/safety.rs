//! Library snapshots, protect lock and rollback over FFI (WP19-40).
//!
//! Snapshots live in `<db dir>/snapshots` (`decks_library::safety`). `DecksLibrary.open` takes
//! the automatic snapshot once per day; imports and migrations take a `before-*` snapshot.
//! `restore_snapshot` raises the `restoring` flag under the scan mutex (so no scan can start
//! and hold the file mid-swap), closes the inner connection under the library mutex, replaces
//! the file (after verifying the snapshot and snapshotting the current state) and reopens it.
//! A restore and a prune are refused while the protect lock is on; when the live file is too
//! damaged to read, the rescue path (`restore_library_file`) bypasses the lock. If the reopen
//! fails the handle reports itself unusable instead of answering from a placeholder.
//! Policy: `docs/decks/library-safety.md`.

use std::path::{Path, PathBuf};

use decks_library::Library;
use decks_library::safety::{self, SnapshotInfo};

use crate::{DecksError, DecksLibrary, lock};

/// One library snapshot (newest first in lists).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LibrarySnapshot {
    pub id: String,
    /// Unix milliseconds (UTC).
    pub created_at_ms: i64,
    /// `auto`, `manual`, `before-import`, `before-migrate`, `before-schema-vN`, `pre-restore` …
    pub reason: String,
    pub schema_version: u32,
    pub tracks: u64,
    pub crates: u64,
    pub cues: u64,
    pub size_bytes: u64,
    pub sha256: String,
}

impl From<SnapshotInfo> for LibrarySnapshot {
    fn from(s: SnapshotInfo) -> Self {
        Self {
            id: s.id,
            created_at_ms: s.created_at_ms,
            reason: s.reason,
            schema_version: s.schema_version,
            tracks: s.tracks,
            crates: s.crates,
            cues: s.cues,
            size_bytes: s.size_bytes,
            sha256: s.sha256,
        }
    }
}

/// Outcome of a restore.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RestoreOutcome {
    pub restored: LibrarySnapshot,
    /// Snapshot of the state just replaced (restore it to undo); `None` when the old file
    /// was too damaged to snapshot (a raw copy is kept in the snapshot folder instead).
    pub pre_restore: Option<LibrarySnapshot>,
}

fn file_backed(path: &Option<PathBuf>) -> Result<&Path, DecksError> {
    path.as_deref().ok_or_else(|| DecksError::Unsupported {
        reason: "an in-memory library has no snapshots".into(),
    })
}

fn restore_at(db: &Path, snapshot_id: &str) -> Result<RestoreOutcome, DecksError> {
    let dir = safety::default_snapshot_dir(db);
    let snap = safety::find_snapshot(&dir, snapshot_id)?;
    let report = Library::restore(&snap, db)?;
    Ok(RestoreOutcome {
        restored: report.restored.into(),
        pre_restore: report.pre_restore.map(Into::into),
    })
}

/// Snapshots of the library file at `db_path` without opening it (works for a corrupt library).
#[uniffi::export]
pub fn library_snapshots(db_path: String) -> Result<Vec<LibrarySnapshot>, DecksError> {
    let dir = safety::default_snapshot_dir(Path::new(&db_path));
    Ok(safety::list_snapshots(&dir)?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// `PRAGMA quick_check` problems of the file at `db_path` (empty = healthy), read-only.
#[uniffi::export]
pub fn library_integrity(db_path: String) -> Result<Vec<String>, DecksError> {
    Ok(safety::check_integrity(Path::new(&db_path))?.problems)
}

/// Restore a snapshot over the library file at `db_path` when `DecksLibrary.open` refused it.
/// No `DecksLibrary` may be open on that file; open it again afterwards.
#[uniffi::export]
pub fn restore_library_file(
    db_path: String,
    snapshot_id: String,
) -> Result<RestoreOutcome, DecksError> {
    restore_at(Path::new(&db_path), &snapshot_id)
}

impl DecksLibrary {
    /// `<db dir>/snapshots`, `None` for in-memory libraries.
    pub(crate) fn snapshot_dir(&self) -> Option<PathBuf> {
        self.path.as_deref().map(safety::default_snapshot_dir)
    }

    /// Daily automatic snapshot (no-op when not due, empty or in-memory).
    pub(crate) fn auto_snapshot(&self) -> Result<Option<LibrarySnapshot>, DecksError> {
        let Some(dir) = self.snapshot_dir() else {
            return Ok(None);
        };
        self.with(|l| l.auto_snapshot_if_due(&dir, safety::DEFAULT_AUTO_INTERVAL))
            .map(|s| s.map(Into::into))
    }

    /// Body of [`DecksLibrary::restore_snapshot`], run with the `restoring` flag raised.
    fn restore_gated(&self, db: &Path, snapshot_id: &str) -> Result<RestoreOutcome, DecksError> {
        let dir = safety::default_snapshot_dir(db);
        // Verify before closing anything: a bad snapshot never interrupts the session.
        let snap = safety::find_snapshot(&dir, snapshot_id)?;
        safety::verify_snapshot(&snap)?;
        let mut guard = lock(&self.lib);
        if let Some(reason) = lock(&self.unusable).clone() {
            return Err(DecksError::Library { reason });
        }
        // The protect lock is checked by `Library::restore`; do it here too so the live
        // connection is never closed for a restore that is going to be refused anyway.
        if guard.is_protected()? {
            return Err(DecksError::Protected {
                reason: "the library is protected; turn off Protect library to restore a snapshot"
                    .into(),
            });
        }
        // Close the file connection (WAL checkpoint happens on close) by swapping in a placeholder.
        let placeholder = Library::open_in_memory()?;
        drop(std::mem::replace(&mut *guard, placeholder));
        let outcome = restore_at(db, snapshot_id);
        self.finish_restore(&mut guard, outcome, Library::open(db))
    }

    /// Installs the reopened connection, or (reopen failed) marks the handle unusable so no
    /// later call answers from the in-memory placeholder (P1-16).
    fn finish_restore(
        &self,
        slot: &mut Library,
        outcome: Result<RestoreOutcome, DecksError>,
        reopened: Result<Library, decks_library::Error>,
    ) -> Result<RestoreOutcome, DecksError> {
        match reopened {
            Ok(lib) => {
                *slot = lib;
                outcome
            }
            Err(e) => {
                let reason = format!(
                    "the library could not be reopened after the restore ({e}); \
                     open it again (restore_library_file works on the file)"
                );
                *lock(&self.unusable) = Some(reason.clone());
                Err(match outcome {
                    Err(restore_err) => restore_err,
                    Ok(_) => DecksError::Library { reason },
                })
            }
        }
    }
}

#[uniffi::export]
impl DecksLibrary {
    /// False for an in-memory library (no snapshots / restore; the protect lock still works).
    pub fn can_snapshot(&self) -> bool {
        self.path.is_some()
    }

    /// Take a snapshot now (`reason` e.g. "manual"; sanitised to `[a-z0-9-]`).
    pub fn snapshot_now(&self, reason: String) -> Result<LibrarySnapshot, DecksError> {
        let dir = file_backed(&self.path).map(safety::default_snapshot_dir)?;
        self.with(|l| l.snapshot(&dir, &reason)).map(Into::into)
    }

    /// Take the automatic snapshot if the newest one is older than a day; `None` = not due.
    pub fn auto_snapshot_if_due(&self) -> Result<Option<LibrarySnapshot>, DecksError> {
        self.auto_snapshot()
    }

    /// Snapshots of this library, newest first (empty for in-memory libraries).
    pub fn list_snapshots(&self) -> Result<Vec<LibrarySnapshot>, DecksError> {
        match self.snapshot_dir() {
            None => Ok(Vec::new()),
            Some(dir) => Ok(safety::list_snapshots(&dir)?
                .into_iter()
                .map(Into::into)
                .collect()),
        }
    }

    /// Replace the library with a snapshot (verified first; the current state is snapshotted
    /// as `pre-restore`). Refused while a folder scan is running and while the library is
    /// protected (`DecksError::Protected`); the restored library keeps the current lock state.
    /// On a failed restore the library is reopened unchanged. If the file cannot be reopened
    /// afterwards, this returns `DecksError::Library` and every later call on this handle
    /// fails with the same reason (open a new `DecksLibrary`, or use `restore_library_file`).
    pub fn restore_snapshot(&self, snapshot_id: String) -> Result<RestoreOutcome, DecksError> {
        let db = file_backed(&self.path)?.to_path_buf();
        self.begin_restore()?;
        let result = self.restore_gated(&db, &snapshot_id);
        self.end_restore();
        result
    }

    /// Delete old snapshots: keep the newest `keep_last` (at least 1), plus one per day for
    /// `keep_daily_days`. Refused while the library is protected. Returns the removed ids.
    pub fn prune_snapshots(
        &self,
        keep_last: u32,
        keep_daily_days: u32,
    ) -> Result<Vec<String>, DecksError> {
        match self.snapshot_dir() {
            None => Ok(Vec::new()),
            Some(dir) => self.with(|l| {
                l.prune_snapshots(
                    &dir,
                    safety::Retention {
                        keep_last: keep_last as usize,
                        keep_daily_days,
                    },
                )
            }),
        }
    }

    /// Protect-library lock: while on, every catalogue edit fails with `DecksError::Protected`;
    /// play history keeps recording.
    pub fn set_protected(&self, on: bool) -> Result<(), DecksError> {
        self.with(|l| l.set_protected(on))
    }

    pub fn is_protected(&self) -> Result<bool, DecksError> {
        self.with(|l| l.is_protected())
    }

    /// `PRAGMA quick_check` problems of the open library (empty = healthy).
    pub fn integrity_problems(&self) -> Result<Vec<String>, DecksError> {
        self.with(|l| l.integrity()).map(|r| r.problems)
    }
}

/// Test hooks for the restore gate (not exported over UniFFI). They let the integration tests
/// hold the gate deterministically instead of racing a real scan.
#[doc(hidden)]
impl DecksLibrary {
    pub fn begin_restore_for_test(&self) -> Result<(), DecksError> {
        self.begin_restore()
    }

    pub fn end_restore_for_test(&self) {
        self.end_restore();
    }

    /// Drives the real post-restore branch with a failed reopen (P1-16): a `Library::open`
    /// failure right after a verified restore cannot be forced from a test otherwise. Runs
    /// under the library mutex with the connection swapped out, like `restore_snapshot`.
    pub fn fail_reopen_for_test(&self, reason: String) -> Result<(), DecksError> {
        let mut guard = lock(&self.lib);
        let placeholder = Library::open_in_memory()?;
        drop(std::mem::replace(&mut *guard, placeholder));
        self.finish_restore(
            &mut guard,
            Err(DecksError::invalid("simulated")),
            Err(decks_library::Error::Format(reason)),
        )
        .map(|_| ())
    }
}
