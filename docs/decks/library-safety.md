# Library safety: snapshots, protect lock, rollback (WP19-40)

Serato 4 users report library corruption, freezes and the removal of "Protect library"
([ideas-2026-11.md](ideas-2026-11.md) §2 row 11). The native Decks apps (Android, Desktop KMP, iOS)
protect the library in three ways: automatic snapshots, a protect lock and one-click rollback.
The Tauri app has no local library, so none of this applies there (owner decision).

Code: `apps/mixai/src-tauri/crates/decks-library/src/safety.rs` (core),
`decks-ffi/src/safety.rs` (FFI), `apps/decks-android/ui/.../engine/SafetyPort.kt` +
`screens/SafetyPanel.kt` (Compose), `apps/ios/DecksApp/Library/SafetyView.swift` (SwiftUI).

## Where snapshots live

`<folder of the library file>/snapshots/`, next to `decks-library.sqlite`:

| Platform | Library file | Snapshots |
|---|---|---|
| Android | app files dir | `<files>/snapshots/` (app-private, removed with the app) |
| Desktop | the library path the app opens | `<that folder>/snapshots/` |
| iOS / iPadOS / macOS | `Application Support/MixAIDecks/decks-library.sqlite` | `Application Support/MixAIDecks/snapshots/` |

Each snapshot is two files: `decks-<UTC yyyyMMdd-HHmmss-mmm>-<reason>.sqlite` (a complete,
self-contained SQLite database in rollback-journal mode) and a JSON sidecar with the same stem:
id, creation time (unix ms), reason, schema version, track / crate / cue counts, size and the
SHA-256 of the database file. A database without its sidecar is never listed or restored.
An in-memory library (previews, tests) has no snapshots; the lock still works.

Sidecars are files on disk, so their contents are not trusted. A sidecar is listed only when:
its id has exactly the generated shape `decks-<8 digits>-<6 digits>-<3 digits>-<reason>[-n]`
(`reason` = `[a-z0-9-]`, at most 48 characters with the collision suffix, no leading/trailing
dash), its own file name is `<id>.json`, and its `file` field is exactly `<id>.sqlite`. Anything
else (an absolute path, `..\`, a UNC path, a different stem) is skipped, never "cleaned up".
Before any delete (prune) or copy (restore) the canonicalised path must still be inside the
snapshot folder, which also defeats a symlink planted there. `Library::restore` additionally
refuses a snapshot that is not in the library's own `<db dir>/snapshots` folder.

## When snapshots are taken

| Reason | When |
|---|---|
| `auto` | When the library is opened and the newest snapshot is older than 24 h. An empty library is skipped. Best effort: a full disk never blocks opening. |
| `before-import`, `before-migrate` | Mandatory, before `import_file` / `migrate_from` writes anything. If the snapshot fails, the import does not run. Skipped while the library is protected, because the import is refused anyway. |
| `before-schema-vN` | Mandatory, inside `Library::open`, before migrating an existing library to a newer schema. |
| `manual` | "Snapshot now" in the panel. |
| `pre-restore` | The current state, taken automatically just before every restore. Restoring it undoes the restore. |

Library code callers can take a snapshot before their own risky operation with
`Library::snapshot_before(dir, op)` (reason `before-<op>`).

A snapshot is a `VACUUM INTO` a `.tmp` file. It is a consistent copy of one transaction even while
WAL is active and another connection (a background scan) is writing. It is then switched to
rollback-journal mode, checked (`quick_check`, counts, schema version), hashed and atomically
renamed into place. The sidecar is written last, also via a temp file and a rename. A crash at any
point leaves either no snapshot or a complete one.

## Retention

`prune(keep_last, keep_daily_days)`: the newest `keep_last` snapshots always stay, plus the
newest snapshot of each UTC day within the last `keep_daily_days` days. Defaults are 10 and 30.
`keep_last` is clamped to at least 1, so a prune never empties the folder.
Pruning runs only when the shell calls it (`prune_snapshots`); it is never automatic, so nothing
is deleted behind the DJ's back. `prune_snapshots` (FFI) and `Library::prune_snapshots` are
refused while the library is protected; the free function `safety::prune(dir, …)` works on a
folder and does not know about any lock (library code only, not exported over FFI).

## Restore guarantees

`restore_snapshot(id)` (FFI) or `Library::restore(snapshot, live_path)` (core):

1. **Validate first.** The sidecar on disk must match the requested snapshot. The file's SHA-256
   must match the sidecar. `PRAGMA quick_check` must pass. The schema version must be between 1
   and the version this app knows. A newer snapshot is refused rather than half-read. A failed
   validation changes nothing and does not interrupt the session. The snapshot must be in this
   library's snapshot folder (see the sidecar rules above).
2. **Respect the lock.** A restore is refused with `Protected` while the live library is
   protected. Exception, the **rescue path**: when the live file cannot be opened or fails
   `quick_check`, its lock flag cannot be read, so the restore goes ahead regardless (this is
   what `restore_library_file` is for). The restored library keeps the **live** lock state (it
   is written into the copy before the swap), so restoring a snapshot taken while locked never
   re-locks, and restoring one taken unlocked never unlocks. After the rescue path, or when no
   live file existed, the snapshot's own state is kept.
3. **Save the current state** as a `pre-restore` snapshot. If the live file is too damaged to
   vacuum, a raw copy (`…-pre-restore-raw.sqlite`, plus its `-wal`) is kept instead; the raw
   copy is not listed in the panel (restore it by hand). A pre-restore snapshot is an ordinary
   snapshot: `prune` can remove it later like any other.
4. **Swap with rollback.** The snapshot is copied next to the live file
   (`<db>.restore-tmp`) and synced. The live database and its `-wal` / `-shm` / `-journal` are
   renamed aside to `<db>.pre-restore-old-<stamp>*`, then the copy is renamed into place. Only
   after that succeeds are the old files deleted, so a stale WAL is never replayed onto the
   restored file. If any rename fails (antivirus, an open handle on Windows), the moved files
   are renamed back, WAL included, the temp copy is deleted and the error is returned: the
   live library is exactly as it was. If even the roll-back rename fails, the error names the
   `pre-restore-old` files that hold the live data; nothing is deleted. The swap is a series of
   renames, not one atomic operation: a power cut in the middle can leave the live data under
   the `pre-restore-old` name (still on disk, recover it by renaming it back).
5. **Reopen.** The FFI closes its connection under the library mutex, restores, then reopens on
   the same `DecksLibrary` handle, so UI references stay valid. If the reopen fails, the call
   returns `DecksError::Library` and the handle marks itself unusable: every later call on it
   fails with the same reason instead of answering from an empty placeholder. Open a new
   `DecksLibrary` (or use `restore_library_file`) to continue.

A restore and a folder scan exclude each other: `restore_snapshot` raises a `restoring` flag
under the same mutex that registers scans, so it is refused while a scan runs, and
`scan_folder` is refused while a restore runs. (Scans use their own connection; this gate is
what stops one from holding the file during the swap.) Two restores on one handle are also
refused. The gate covers one `DecksLibrary` handle: a second handle or another process on the
same file is not coordinated, and `Library::restore` documents that every connection must be
closed first.

A corrupt library is detected on open: `Library::open` runs `PRAGMA quick_check` and fails with
"corrupt library: …". The shell can then list snapshots and restore by path without opening the
library: `library_snapshots(db_path)`, `library_integrity(db_path)`,
`restore_library_file(db_path, id)`.

## What the protect lock blocks

The lock is `library_meta.protected = 1` inside the library, so it survives restarts and travels
with snapshots. It is turned on and off with `set_protected` (always allowed).

While it is on, these fail with `Error::Protected` / `DecksError::Protected`:

- tracks: `upsert_track(s)`, `delete_track`, folder scan;
- cues (`set_cues`) and beat grids (`set_grid`, including the fixed-grid toggle);
- crates: create / ensure, rename, delete, `set_crate_tracks`, `add_to_crate`;
- smart crates: create, delete;
- imports and migrations (`import_collection`, `import_file`, `migrate_from`);
- restoring a snapshot (`restore_snapshot`, `Library::restore`), except the rescue path for
   a live file that cannot be read;
- pruning snapshots (`prune_snapshots`, `Library::prune_snapshots`).

These stay allowed because they are live performance data or read-only: play history (sessions,
`record_play`, including the play count it bumps), the analysis cache, reading and searching,
exports, and taking snapshots (manual, automatic and `before-*`).

Not covered by the lock: the library-level free functions that work on a folder or file path
without opening the library (`safety::prune(dir, …)`, `safety::prune_at`), the rescue path
above, and anything outside the app that edits the SQLite file directly. The lock protects
against mistakes inside the app, not against a hostile process.

The guard is centralised in `decks-library/src/library.rs` (`ensure_writable` at the top of each
mutation). FFI writes go through those methods; there are no raw SQL writes in the FFI.

## Verification

- `cargo test -p decks-library --test safety`: snapshot while another connection writes,
  restore round trip, tampered / garbage / newer-schema / sidecar-less snapshots rejected,
  retention, auto interval, lock per mutation class with history allowed, corrupt library
   refused on open, snapshot before a schema upgrade; crafted sidecars (absolute path, `..\`,
   escaping id) never listed, restored or pruned; snapshot from another folder refused; restore
   and prune refused while protected and the live lock state kept; rescue path on a corrupt
   locked library; `keep_last` clamped to 1; stale WAL dropped, no swap leftovers.
- `cargo test -p decks-library --lib safety`: id validator; swap rollback when the final rename
   or the WAL rename fails (simulated with an injected rename), restore failure leaves the live
   library readable and no `.restore-tmp`.
- `cargo test -p decks-ffi --test safety`: daily auto snapshot on open, restore on the same
  handle, bad snapshot refused without interrupting the session, `Protected` mapping, in-memory
   `Unsupported`, restore of a corrupt library by path, `before-import` snapshot and prune;
   restore / prune refused while protected; prune keeps one; crafted sidecars; scan refused
   while a restore holds the gate and vice versa.
- `SafetyTest` (Compose commonTest): panel state, confirm step, failure notice, retention parity.
