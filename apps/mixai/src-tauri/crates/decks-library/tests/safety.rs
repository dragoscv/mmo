//! Library safety (WP19-40): snapshots while writing, restore round-trip, corrupt snapshot
//! rejected, retention, protect lock per mutation class, integrity on open, and the review
//! hardening (sidecar path traversal, swap rollback, lock on restore / prune).

use std::path::Path;
use std::time::Duration;

use decks_library::model::{BeatGrid, Collection, Cue, CueKind, TrackRecord};
use decks_library::safety::{self, Retention, SnapshotInfo};
use decks_library::smart::Rule;
use decks_library::{Error, Library, schema};

fn track(path: &str, title: &str) -> TrackRecord {
    TrackRecord {
        path: path.into(),
        title: Some(title.into()),
        artist: Some("MixAI".into()),
        bpm: Some(124.0),
        cues: vec![Cue {
            kind: CueKind::Hot,
            index: Some(0),
            start_sec: 1.0,
            end_sec: None,
            colour: None,
            label: None,
        }],
        ..TrackRecord::default()
    }
}

fn seeded(db: &Path, n: usize) -> Library {
    let mut lib = Library::open(db).unwrap();
    for i in 0..n {
        lib.upsert_track(&track(&format!("C:/m/{i}.mp3"), &format!("T{i}")))
            .unwrap();
    }
    lib.create_crate("Warmup", None, false).unwrap();
    lib
}

fn is_protected_err<T: std::fmt::Debug>(r: decks_library::Result<T>) -> bool {
    matches!(r, Err(Error::Protected(_)))
}

#[test]
fn snapshot_while_another_connection_writes() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let dir = tmp.path().join("snapshots");
    let lib = seeded(&db, 5);
    let path = db.clone();
    let writer = std::thread::spawn(move || {
        let mut w = Library::open(&path).unwrap();
        for i in 0..200 {
            w.upsert_track(&track(&format!("C:/w/{i}.mp3"), "W"))
                .unwrap();
        }
    });
    let mut snaps = Vec::new();
    for _ in 0..5 {
        snaps.push(lib.snapshot(&dir, "manual").unwrap());
    }
    writer.join().unwrap();
    for s in &snaps {
        // Every snapshot is a consistent, verifiable library with at least the seed rows.
        let v = safety::verify_snapshot(s).unwrap();
        assert!(v.tracks >= 5 && v.tracks <= 205, "tracks {}", v.tracks);
        assert_eq!(
            v.cues, v.tracks,
            "one hot cue per track, never half a transaction"
        );
        assert_eq!(v.crates, 1);
        assert_eq!(v.schema_version, schema::SCHEMA_VERSION);
        assert_eq!(v.sha256.len(), 64);
    }
    let listed = safety::list_snapshots(&dir).unwrap();
    assert_eq!(listed.len(), 5);
    assert!(
        listed
            .windows(2)
            .all(|w| w[0].created_at_ms >= w[1].created_at_ms)
    );
    // No temp files left behind.
    let leftovers = std::fs::read_dir(&dir)
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .path()
                .to_string_lossy()
                .ends_with(".tmp")
        })
        .count();
    assert_eq!(leftovers, 0);
}

#[test]
fn restore_round_trip_with_pre_restore_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let dir = safety::default_snapshot_dir(&db);
    let snap = {
        let lib = seeded(&db, 3);
        lib.snapshot(&dir, "Before big edit").unwrap()
    };
    assert_eq!(snap.reason, "before-big-edit");
    {
        let mut lib = Library::open(&db).unwrap();
        for i in 0..3 {
            lib.delete_track(
                &lib.track_by_path(&format!("C:/m/{i}.mp3"))
                    .unwrap()
                    .unwrap()
                    .id
                    .unwrap(),
            )
            .unwrap();
        }
        lib.upsert_track(&track("C:/m/new.mp3", "New")).unwrap();
        assert_eq!(lib.track_count().unwrap(), 1);
    } // connection closed (WAL may still hold uncheckpointed pages: restore must drop them)
    let report = Library::restore(&snap, &db).unwrap();
    assert_eq!(report.restored.id, snap.id);
    let pre = report.pre_restore.expect("pre-restore snapshot");
    assert_eq!(pre.reason, "pre-restore");
    assert_eq!(pre.tracks, 1);
    let lib = Library::open(&db).unwrap();
    assert_eq!(lib.track_count().unwrap(), 3);
    assert!(lib.track_by_path("C:/m/new.mp3").unwrap().is_none());
    assert_eq!(lib.crates().unwrap().len(), 1);
    // The pre-restore snapshot undoes the restore.
    drop(lib);
    Library::restore(&pre, &db).unwrap();
    assert_eq!(Library::open(&db).unwrap().track_count().unwrap(), 1);
}

#[test]
fn corrupt_or_tampered_snapshot_is_rejected_and_live_library_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let dir = tmp.path().join("snapshots");
    let snap = seeded(&db, 4).snapshot(&dir, "manual").unwrap();

    // 1. Flipped bytes: sha256 mismatch.
    let mut bytes = std::fs::read(&snap.path).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xFF;
    std::fs::write(&snap.path, &bytes).unwrap();
    let err = Library::restore(&snap, &db).unwrap_err();
    assert!(err.to_string().contains("sha256"), "{err}");
    assert_eq!(Library::open(&db).unwrap().track_count().unwrap(), 4);

    // 2. Garbage with a matching sidecar hash: quick_check / open fails.
    let snap2 = Library::open(&db)
        .unwrap()
        .snapshot(&dir, "manual")
        .unwrap();
    std::fs::write(&snap2.path, b"not a database at all, just text padding....").unwrap();
    rewrite_sidecar(&snap2, |s| s.sha256 = sha(&snap2.path));
    // A stale in-memory copy (old hash) is refused at the sidecar check…
    let err = Library::restore(&snap2, &db).unwrap_err();
    assert!(err.to_string().contains("sidecar"), "{err}");
    // …and the re-read one fails quick_check / open.
    let snap2 = safety::find_snapshot(&dir, &snap2.id).unwrap();
    let err = Library::restore(&snap2, &db).unwrap_err();
    assert!(err.to_string().contains("unreadable"), "{err}");

    // 3. Newer schema than this app knows.
    let snap3 = Library::open(&db)
        .unwrap()
        .snapshot(&dir, "manual")
        .unwrap();
    {
        let c = rusqlite::Connection::open(&snap3.path).unwrap();
        c.pragma_update(None, "user_version", schema::SCHEMA_VERSION + 1)
            .unwrap();
    }
    rewrite_sidecar(&snap3, |s| {
        s.sha256 = sha(&snap3.path);
        s.schema_version = schema::SCHEMA_VERSION + 1;
    });
    let fresh = safety::find_snapshot(&dir, &snap3.id).unwrap();
    let err = Library::restore(&fresh, &db).unwrap_err();
    assert!(err.to_string().contains("schema"), "{err}");

    // 4. Missing sidecar: not listed, not restorable.
    let snap4 = Library::open(&db)
        .unwrap()
        .snapshot(&dir, "manual")
        .unwrap();
    std::fs::remove_file(snap4.path.with_extension("json")).unwrap();
    assert!(safety::find_snapshot(&dir, &snap4.id).is_err());
    assert!(Library::restore(&snap4, &db).is_err());

    // 5. Openable but damaged pages (sha recomputed): quick_check inside the validation catches it.
    let big = tmp.path().join("big.sqlite");
    {
        let mut l = Library::open(&big).unwrap();
        for i in 0..40 {
            l.upsert_track(&track(&format!("C:/b/{i}.mp3"), "B"))
                .unwrap();
        }
    }
    let snap5 = Library::open(&big)
        .unwrap()
        .snapshot(&dir, "manual")
        .unwrap();
    corrupt_data_pages(&snap5.path);
    assert!(opens_as_sqlite(&snap5.path));
    rewrite_sidecar(&snap5, |s| s.sha256 = sha(&snap5.path));
    let snap5 = safety::find_snapshot(&dir, &snap5.id).unwrap();
    let report = safety::check_integrity(&snap5.path).unwrap();
    assert!(!report.ok(), "read-only quick_check sees the damage");
    let verified = safety::verify_snapshot(&snap5);
    assert!(
        verified.is_err(),
        "verify_snapshot must reject: {verified:?}"
    );
    let err = Library::restore(&snap5, &big).unwrap_err();
    assert!(err.to_string().contains("unreadable"), "{err}");

    assert_eq!(Library::open(&db).unwrap().track_count().unwrap(), 4);
}

fn sha(p: &Path) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(std::fs::read(p).unwrap())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn rewrite_sidecar(s: &SnapshotInfo, f: impl FnOnce(&mut SnapshotInfo)) {
    let side = s.path.with_extension("json");
    let mut info: SnapshotInfo = serde_json::from_slice(&std::fs::read(&side).unwrap()).unwrap();
    f(&mut info);
    std::fs::write(&side, serde_json::to_vec(&info).unwrap()).unwrap();
}

/// Makes `tracks.comment` NOT NULL in the stored schema while the rows hold NULL comments. The
/// file opens, migrates and counts normally, but `PRAGMA quick_check` RETURNS a problem row
/// ("NULL value in tracks.comment") instead of failing. Garbage bytes or broken pages make SQLite
/// error out instead, which would leave the "problems reported" branch of the gates untested.
fn corrupt_data_pages(db: &Path) {
    let c = rusqlite::Connection::open(db).unwrap();
    let nulls: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM tracks WHERE comment IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(nulls > 0, "needs rows with a NULL comment");
    c.pragma_update(None, "writable_schema", true).unwrap();
    let changed = c
        .execute(
            "UPDATE sqlite_schema SET sql = replace(sql, 'comment       TEXT,', \
             'comment       TEXT NOT NULL,') WHERE name = 'tracks'",
            [],
        )
        .unwrap();
    assert_eq!(changed, 1);
    c.pragma_update(None, "writable_schema", false).unwrap();
    let _: String = c
        .query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))
        .unwrap();
    drop(c);
    let c = rusqlite::Connection::open(db).unwrap();
    let problems: Vec<String> = c
        .prepare("PRAGMA quick_check")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(
        problems.iter().any(|p| p.contains("NULL value")),
        "quick_check must report a row, got {problems:?}"
    );
}

fn opens_as_sqlite(db: &Path) -> bool {
    rusqlite::Connection::open(db)
        .and_then(|c| c.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0)))
        .is_ok()
}

#[test]
fn prune_keeps_last_n_and_one_per_day() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("snapshots");
    let lib = seeded(&tmp.path().join("lib.sqlite"), 1);
    const DAY: i64 = 86_400_000;
    let now = 1_800_000_000_000_i64;
    // Two snapshots per day for 6 days (day 0 = today), plus one 40 days ago.
    let mut ages = Vec::new();
    for d in 0..6 {
        ages.push(d * DAY + 1_000);
        ages.push(d * DAY + 2_000);
    }
    ages.push(40 * DAY);
    for age in &ages {
        let s = lib.snapshot(&dir, "auto").unwrap();
        rewrite_sidecar(&s, |i| i.created_at_ms = now - age);
    }
    assert_eq!(safety::list_snapshots(&dir).unwrap().len(), 13);
    let removed = safety::prune_at(
        &dir,
        Retention {
            keep_last: 3,
            keep_daily_days: 4,
        },
        now,
    )
    .unwrap();
    let left = safety::list_snapshots(&dir).unwrap();
    let left_ages: Vec<i64> = left.iter().map(|s| now - s.created_at_ms).collect();
    // keep_last 3 = today x2 + yesterday's newest; daily for days 0..3 adds days 2 and 3.
    assert_eq!(
        left_ages,
        vec![1_000, 2_000, DAY + 1_000, 2 * DAY + 1_000, 3 * DAY + 1_000]
    );
    assert_eq!(removed.len(), 8);
    // Files of removed snapshots are gone too.
    let files = std::fs::read_dir(&dir).unwrap().count();
    assert_eq!(files, left.len() * 2);
}

#[test]
fn auto_snapshot_respects_interval_and_skips_empty_library() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("snapshots");
    let empty = Library::open(tmp.path().join("empty.sqlite")).unwrap();
    assert!(
        empty
            .auto_snapshot_if_due(&dir, Duration::ZERO)
            .unwrap()
            .is_none()
    );
    let lib = seeded(&tmp.path().join("lib.sqlite"), 2);
    let first = lib
        .auto_snapshot_if_due(&dir, safety::DEFAULT_AUTO_INTERVAL)
        .unwrap()
        .expect("first auto snapshot");
    assert_eq!(first.reason, "auto");
    assert!(
        lib.auto_snapshot_if_due(&dir, safety::DEFAULT_AUTO_INTERVAL)
            .unwrap()
            .is_none()
    );
    assert!(
        lib.auto_snapshot_if_due(&dir, Duration::ZERO)
            .unwrap()
            .is_some()
    );
    let before = lib.snapshot_before(&dir, "import").unwrap();
    assert_eq!(before.reason, "before-import");
}

#[test]
fn protect_lock_refuses_every_catalogue_mutation_but_allows_history() {
    let tmp = tempfile::tempdir().unwrap();
    let music = tmp.path().join("music");
    std::fs::create_dir_all(&music).unwrap();
    let db = tmp.path().join("lib.sqlite");
    let mut lib = seeded(&db, 2);
    let id = lib
        .track_by_path("C:/m/0.mp3")
        .unwrap()
        .unwrap()
        .id
        .unwrap();
    let crate_id = lib.crates().unwrap()[0].id;
    let rule: Rule =
        serde_json::from_str(r#"{"all":[{"field":"bpm","op":"gte","value":120}]}"#).unwrap();
    let smart_id = lib.create_smart_crate("Fast", &rule).unwrap();
    let session = lib.start_session(Some("Gig")).unwrap();

    assert!(!lib.is_protected().unwrap());
    lib.set_protected(true).unwrap();
    assert!(lib.is_protected().unwrap());
    let grid = BeatGrid {
        bpm: 124.0,
        first_beat_sec: 0.1,
        downbeat_offset: 0,
        anchors: vec![],
        fixed: false,
    };
    assert!(is_protected_err(
        lib.upsert_track(&track("C:/m/x.mp3", "X"))
    ));
    assert!(is_protected_err(
        lib.upsert_tracks(&[track("C:/m/y.mp3", "Y")])
    ));
    assert!(is_protected_err(lib.delete_track(&id)));
    assert!(is_protected_err(lib.set_cues(&id, &[])));
    assert!(is_protected_err(lib.set_grid(&id, &grid)));
    assert!(is_protected_err(lib.create_crate("New", None, false)));
    assert!(is_protected_err(lib.ensure_crate("Other", None, false)));
    assert!(is_protected_err(lib.rename_crate(crate_id, "Renamed")));
    assert!(is_protected_err(lib.delete_crate(crate_id)));
    assert!(is_protected_err(
        lib.set_crate_tracks(crate_id, std::slice::from_ref(&id))
    ));
    assert!(is_protected_err(lib.add_to_crate(crate_id, &id)));
    assert!(is_protected_err(lib.create_smart_crate("S", &rule)));
    assert!(is_protected_err(lib.delete_smart_crate(smart_id)));
    assert!(is_protected_err(lib.scan_folder(&music, |_| {})));
    assert!(is_protected_err(lib.import_collection(&Collection {
        tracks: vec![track("C:/m/z.mp3", "Z")],
        playlists: vec![],
    })));
    assert!(is_protected_err(decks_library::migrate_from(
        &mut lib,
        decks_library::Source::Collection(Collection::default()),
    )));

    // Nothing changed.
    assert_eq!(lib.track_count().unwrap(), 2);
    assert_eq!(lib.crates().unwrap()[0].name, "Warmup");
    assert_eq!(lib.cues(&id).unwrap().len(), 1);
    assert!(lib.grid(&id).unwrap().is_none());
    assert_eq!(lib.smart_crates().unwrap().len(), 1);

    // Live performance data stays writable.
    lib.record_play(session, &id, Some(0)).unwrap();
    lib.end_session(session).unwrap();
    lib.start_session(None).unwrap();
    lib.put_analysis(&id, "peaks", 1, b"x").unwrap();
    assert_eq!(lib.session_entries(session).unwrap().len(), 1);
    // Snapshots are allowed (read-only on the live file).
    lib.snapshot(tmp.path().join("snapshots"), "manual")
        .unwrap();

    // The lock survives reopening and can be turned off.
    drop(lib);
    let mut lib = Library::open(&db).unwrap();
    assert!(lib.is_protected().unwrap());
    lib.set_protected(false).unwrap();
    lib.create_crate("New", None, false).unwrap();
}

#[test]
fn open_refuses_a_corrupt_library_and_integrity_reports_it() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let healthy = seeded(&db, 40);
    assert!(healthy.integrity().unwrap().ok());
    drop(healthy);
    assert!(safety::check_integrity(&db).unwrap().ok());

    // Damaged pages behind a valid header: SQLite still opens it, only quick_check sees it.
    let damaged = tmp.path().join("damaged.sqlite");
    std::fs::copy(&db, &damaged).unwrap();
    corrupt_data_pages(&damaged);
    assert!(
        opens_as_sqlite(&damaged),
        "must still open, else the gate is untested"
    );
    assert!(!safety::check_integrity(&damaged).unwrap().ok());
    let err = Library::open(&damaged)
        .err()
        .expect("damaged library refused");
    assert!(err.to_string().contains("corrupt library"), "{err}");

    let bad = tmp.path().join("bad.sqlite");
    std::fs::write(&bad, vec![0x42u8; 8192]).unwrap();
    let err = Library::open(&bad).err().expect("corrupt library refused");
    assert!(err.to_string().contains("corrupt library"), "{err}");
    assert!(!safety::check_integrity(&bad).unwrap().ok());
}

#[test]
fn schema_upgrade_takes_a_snapshot_first() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    {
        // A v1 library (first migration only).
        let c = rusqlite::Connection::open(&db).unwrap();
        c.execute_batch(schema::MIGRATIONS[0]).unwrap();
        c.pragma_update(None, "user_version", 1).unwrap();
    }
    let lib = Library::open(&db).unwrap();
    assert_eq!(lib.schema_version().unwrap(), schema::SCHEMA_VERSION);
    let snaps = safety::list_snapshots(&safety::default_snapshot_dir(&db)).unwrap();
    assert_eq!(snaps.len(), 1);
    assert_eq!(
        snaps[0].reason,
        format!("before-schema-v{}", schema::SCHEMA_VERSION)
    );
    assert_eq!(snaps[0].schema_version, 1);
    // Reopening at the current version takes no further snapshot.
    drop(lib);
    Library::open(&db).unwrap();
    assert_eq!(
        safety::list_snapshots(&safety::default_snapshot_dir(&db))
            .unwrap()
            .len(),
        1
    );
}

// ---------------------------------------------------------------- review hardening

/// Writes a hand-crafted sidecar `<id>.json` into `dir` whose `file` field is `file`.
fn plant_sidecar(dir: &Path, id: &str, file: &str, sha256: &str) {
    std::fs::create_dir_all(dir).unwrap();
    let json = serde_json::json!({
        "id": id,
        "file": file,
        "created_at_ms": 9_000_000_000_000_i64,
        "reason": "manual",
        "schema_version": schema::SCHEMA_VERSION,
        "tracks": 1,
        "crates": 0,
        "cues": 0,
        "size_bytes": 1,
        "sha256": sha256,
    });
    std::fs::write(
        dir.join(format!("{id}.json")),
        serde_json::to_vec_pretty(&json).unwrap(),
    )
    .unwrap();
}

#[test]
fn crafted_sidecars_cannot_escape_the_snapshot_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let dir = safety::default_snapshot_dir(&db);
    let good = seeded(&db, 2).snapshot(&dir, "manual").unwrap();

    // A file the attacker wants deleted / copied over the library, outside the folder.
    let victim = tmp.path().join("precious.sqlite");
    std::fs::copy(&good.path, &victim).unwrap();
    let victim_sha = sha(&victim);

    // 1. Absolute path in `file`: `Path::join` would REPLACE the snapshot folder.
    plant_sidecar(
        &dir,
        "decks-20991231-235959-999-manual",
        victim.to_str().unwrap(),
        &victim_sha,
    );
    // 2. `..\` escape in `file`.
    plant_sidecar(
        &dir,
        "decks-20991231-235959-998-manual",
        "../precious.sqlite",
        &victim_sha,
    );
    // 3. Escaping id (sidecar name is sane, id is not).
    plant_sidecar(
        &dir,
        "decks-20991231-235959-997-manual",
        "decks-20991231-235959-997-manual.sqlite",
        &victim_sha,
    );
    let crafted = dir.join("decks-20991231-235959-997-manual.json");
    let text = std::fs::read_to_string(&crafted).unwrap();
    std::fs::write(
        &crafted,
        text.replace(
            "\"decks-20991231-235959-997-manual\"",
            "\"../../../../precious\"",
        ),
    )
    .unwrap();

    // 4. A real sidecar copied under another (valid-looking) name: its stem is not its id.
    std::fs::copy(
        good.path.with_extension("json"),
        dir.join("decks-20991231-235959-996-manual.json"),
    )
    .unwrap();
    let renamed = dir.join("decks-20991231-235959-996-manual.sqlite");
    std::fs::copy(&good.path, &renamed).unwrap();
    assert!(safety::load_snapshot_info(&renamed).is_err());

    // None of them is listed, so the UI can never offer them.
    let listed = safety::list_snapshots(&dir).unwrap();
    assert_eq!(listed.len(), 1, "{listed:#?}");
    assert_eq!(listed[0].id, good.id);

    // Nor restorable through the public API, even when the caller builds the struct itself.
    for file in [victim.to_str().unwrap(), "../precious.sqlite"] {
        let evil = SnapshotInfo {
            id: "decks-20991231-235959-999-manual".into(),
            file: file.into(),
            created_at_ms: 9_000_000_000_000,
            reason: "manual".into(),
            schema_version: schema::SCHEMA_VERSION,
            tracks: 1,
            crates: 0,
            cues: 0,
            size_bytes: 1,
            sha256: victim_sha.clone(),
            path: if Path::new(file).is_absolute() {
                victim.clone()
            } else {
                dir.join(file)
            },
        };
        assert!(Library::restore(&evil, &db).is_err(), "{file}");
        assert!(safety::verify_snapshot(&evil).is_err(), "{file}");
    }

    // Prune never touches anything outside the folder either.
    let removed = safety::prune_at(
        &dir,
        Retention {
            keep_last: 1,
            keep_daily_days: 0,
        },
        9_000_000_000_000,
    )
    .unwrap();
    assert!(removed.is_empty(), "{removed:?}");
    assert!(victim.is_file(), "the file outside the folder survives");
    assert!(good.path.is_file());
    assert_eq!(Library::open(&db).unwrap().track_count().unwrap(), 2);
}

#[test]
fn a_snapshot_from_another_folder_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let mine = tmp.path().join("mine").join("lib.sqlite");
    let other = tmp.path().join("other").join("lib.sqlite");
    std::fs::create_dir_all(mine.parent().unwrap()).unwrap();
    std::fs::create_dir_all(other.parent().unwrap()).unwrap();
    seeded(&mine, 2);
    let foreign = seeded(&other, 5)
        .snapshot(safety::default_snapshot_dir(&other), "manual")
        .unwrap();
    let err = Library::restore(&foreign, &mine).unwrap_err();
    assert!(err.to_string().contains("snapshot folder"), "{err}");
    assert_eq!(Library::open(&mine).unwrap().track_count().unwrap(), 2);
}

#[test]
fn restore_and_prune_are_refused_while_protected_and_the_lock_survives() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let dir = safety::default_snapshot_dir(&db);
    let unlocked_snapshot = {
        let mut lib = seeded(&db, 3);
        let s = lib.snapshot(&dir, "manual").unwrap();
        lib.set_protected(true).unwrap();
        s
    };
    // The snapshot was taken while unlocked; restoring it must not unlock the live library.
    assert!(is_protected_err(Library::restore(&unlocked_snapshot, &db)));
    let mut lib = Library::open(&db).unwrap();
    assert!(lib.is_protected().unwrap(), "still locked");
    // Prune too: it destroys rollback points.
    assert!(is_protected_err(lib.prune_snapshots(
        &dir,
        Retention {
            keep_last: 1,
            keep_daily_days: 0
        }
    )));
    assert_eq!(safety::list_snapshots(&dir).unwrap().len(), 1);

    // Unlocked: the restore runs and the live (unlocked) state is what the file keeps…
    lib.set_protected(false).unwrap();
    drop(lib);
    Library::restore(&unlocked_snapshot, &db).unwrap();
    assert!(!Library::open(&db).unwrap().is_protected().unwrap());

    // …and a snapshot taken WHILE LOCKED does not re-lock an unlocked library.
    let locked_snapshot = {
        let mut lib = Library::open(&db).unwrap();
        lib.set_protected(true).unwrap();
        let s = lib.snapshot(&dir, "manual").unwrap();
        lib.set_protected(false).unwrap();
        s
    };
    Library::restore(&locked_snapshot, &db).unwrap();
    assert!(
        !Library::open(&db).unwrap().is_protected().unwrap(),
        "restore keeps the LIVE lock state, not the snapshot's"
    );
}

#[test]
fn the_rescue_path_restores_a_corrupt_locked_library() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let dir = safety::default_snapshot_dir(&db);
    let snap = {
        let mut lib = seeded(&db, 2);
        let s = lib.snapshot(&dir, "manual").unwrap();
        lib.set_protected(true).unwrap();
        s
    };
    // Garbage over the live file: the lock flag cannot be read any more.
    std::fs::write(&db, vec![0x7Au8; 16_384]).unwrap();
    let _ = std::fs::remove_file(db.with_extension("sqlite-wal"));
    let _ = std::fs::remove_file(db.with_extension("sqlite-shm"));
    assert!(Library::open(&db).is_err());
    let report = Library::restore(&snap, &db).unwrap();
    assert!(
        report.pre_restore.is_none(),
        "unreadable file is copied raw"
    );
    let lib = Library::open(&db).unwrap();
    assert_eq!(lib.track_count().unwrap(), 2);
    assert!(
        !lib.is_protected().unwrap(),
        "the rescue path keeps the snapshot's own state (it was taken unlocked)"
    );
}

#[test]
fn prune_always_keeps_at_least_one_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let dir = safety::default_snapshot_dir(&db);
    let lib = seeded(&db, 1);
    for _ in 0..3 {
        lib.snapshot(&dir, "manual").unwrap();
    }
    let removed = safety::prune(&dir, 0, 0).unwrap();
    assert_eq!(removed.len(), 2);
    let left = safety::list_snapshots(&dir).unwrap();
    assert_eq!(left.len(), 1, "keep_last 0 is clamped to 1");
    // And the newest one survived.
    assert!(left[0].path.is_file());
}

#[test]
fn restore_drops_the_stale_wal_of_the_replaced_library() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let dir = safety::default_snapshot_dir(&db);
    let snap = seeded(&db, 2).snapshot(&dir, "manual").unwrap();
    {
        let mut lib = Library::open(&db).unwrap();
        lib.create_crate("Later", None, false).unwrap();
    }
    // A WAL left behind by an unclean shutdown must not be replayed onto the restored file.
    std::fs::write(db.with_extension("sqlite-wal"), vec![0u8; 4096]).unwrap();
    Library::restore(&snap, &db).unwrap();
    assert!(!db.with_extension("sqlite-wal").is_file());
    let lib = Library::open(&db).unwrap();
    assert_eq!(lib.crates().unwrap().len(), 1);
    // Nothing of the swap is left lying around next to the library.
    let strays: Vec<String> = std::fs::read_dir(tmp.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("pre-restore-old") || n.contains("restore-tmp"))
        .collect();
    assert!(strays.is_empty(), "{strays:?}");
}
