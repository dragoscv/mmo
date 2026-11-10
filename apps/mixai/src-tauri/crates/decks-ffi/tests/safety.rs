//! Library safety through the FFI (WP19-40): the calls Swift / Kotlin make.

use std::path::Path;

use decks_ffi::*;

fn track(path: &str, title: &str) -> LibraryTrack {
    LibraryTrack {
        path: path.into(),
        title: Some(title.into()),
        artist: Some("MixAI".into()),
        bpm: Some(124.0),
        ..LibraryTrack::default()
    }
}

fn snapshot_files(db: &Path) -> usize {
    std::fs::read_dir(db.parent().unwrap().join("snapshots"))
        .map(|rd| rd.count())
        .unwrap_or(0)
}

#[test]
fn open_takes_the_daily_auto_snapshot_once() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let p = db.to_string_lossy().into_owned();
    {
        let lib = DecksLibrary::open(p.clone()).unwrap();
        // Empty library: nothing to protect yet.
        assert!(lib.list_snapshots().unwrap().is_empty());
        lib.upsert_track(track("C:/m/a.mp3", "A")).unwrap();
    }
    let lib = DecksLibrary::open(p.clone()).unwrap();
    let snaps = lib.list_snapshots().unwrap();
    assert_eq!(snaps.len(), 1);
    assert_eq!(snaps[0].reason, "auto");
    assert_eq!(snaps[0].tracks, 1);
    drop(lib);
    DecksLibrary::open(p.clone()).unwrap();
    assert_eq!(library_snapshots(p).unwrap().len(), 1, "once per day");
}

#[test]
fn snapshot_restore_round_trip_reopens_the_library() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let lib = DecksLibrary::open(db.to_string_lossy().into_owned()).unwrap();
    let a = lib.upsert_track(track("C:/m/a.mp3", "A")).unwrap();
    lib.create_crate("Warmup".into(), None, false).unwrap();
    let snap = lib.snapshot_now("Manual".into()).unwrap();
    assert_eq!(snap.reason, "manual");
    assert_eq!((snap.tracks, snap.crates), (1, 1));

    lib.delete_track(a).unwrap();
    lib.upsert_track(track("C:/m/b.mp3", "B")).unwrap();
    lib.upsert_track(track("C:/m/c.mp3", "C")).unwrap();
    assert_eq!(lib.track_count().unwrap(), 2);

    let out = lib.restore_snapshot(snap.id.clone()).unwrap();
    assert_eq!(out.restored.id, snap.id);
    let pre = out.pre_restore.expect("pre-restore snapshot");
    assert_eq!(pre.tracks, 2);
    // Same handle keeps working on the restored file.
    assert_eq!(lib.track_count().unwrap(), 1);
    assert!(lib.track_by_path("C:/m/a.mp3".into()).unwrap().is_some());
    lib.upsert_track(track("C:/m/d.mp3", "D")).unwrap();
    assert_eq!(lib.track_count().unwrap(), 2);
    // Undo the restore.
    lib.restore_snapshot(pre.id).unwrap();
    assert_eq!(lib.track_count().unwrap(), 2);
    assert!(lib.track_by_path("C:/m/b.mp3".into()).unwrap().is_some());
}

#[test]
fn bad_snapshot_is_refused_and_the_session_continues() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let lib = DecksLibrary::open(db.to_string_lossy().into_owned()).unwrap();
    lib.upsert_track(track("C:/m/a.mp3", "A")).unwrap();
    let snap = lib.snapshot_now("manual".into()).unwrap();
    let file = tmp
        .path()
        .join("snapshots")
        .join(format!("{}.sqlite", snap.id));
    let mut bytes = std::fs::read(&file).unwrap();
    let n = bytes.len();
    bytes[n / 2] ^= 0x55;
    std::fs::write(&file, bytes).unwrap();
    let before = snapshot_files(&db);
    let err = lib.restore_snapshot(snap.id).unwrap_err();
    assert!(matches!(err, DecksError::Library { .. }), "{err:?}");
    assert_eq!(
        snapshot_files(&db),
        before,
        "no pre-restore snapshot for a refused restore"
    );
    assert_eq!(lib.track_count().unwrap(), 1);
    lib.upsert_track(track("C:/m/b.mp3", "B")).unwrap();
    assert!(matches!(
        lib.restore_snapshot("nope".into()),
        Err(DecksError::NotFound { .. })
    ));
}

#[test]
fn protected_maps_to_the_ffi_variant_and_history_still_records() {
    let lib = DecksLibrary::open_in_memory().unwrap();
    let id = lib.upsert_track(track("C:/m/a.mp3", "A")).unwrap();
    let crate_id = lib.create_crate("Warmup".into(), None, false).unwrap();
    let smart = lib
        .create_smart_crate(
            "Fast".into(),
            r#"{"all":[{"field":"bpm","op":"gte","value":120}]}"#.into(),
        )
        .unwrap();
    let session = lib.start_session(Some("Gig".into())).unwrap();
    lib.set_protected(true).unwrap();
    assert!(lib.is_protected().unwrap());
    let prot = |r: Result<(), DecksError>| matches!(r, Err(DecksError::Protected { .. }));
    assert!(prot(lib.upsert_track(track("C:/m/x.mp3", "X")).map(|_| ())));
    assert!(prot(lib.delete_track(id.clone()).map(|_| ())));
    assert!(prot(lib.set_cues(id.clone(), vec![])));
    assert!(prot(lib.rename_crate(crate_id, "R".into())));
    assert!(prot(lib.delete_crate(crate_id).map(|_| ())));
    assert!(prot(lib.add_to_crate(crate_id, id.clone())));
    assert!(prot(lib.delete_smart_crate(smart).map(|_| ())));
    assert!(prot(lib.create_crate("N".into(), None, false).map(|_| ())));
    lib.record_play(session, id.clone(), Some(0)).unwrap();
    assert_eq!(lib.session_entries(session).unwrap().len(), 1);
    lib.set_protected(false).unwrap();
    lib.rename_crate(crate_id, "Peak".into()).unwrap();
}

#[test]
fn in_memory_library_has_no_snapshots() {
    let lib = DecksLibrary::open_in_memory().unwrap();
    assert!(matches!(
        lib.snapshot_now("manual".into()),
        Err(DecksError::Unsupported { .. })
    ));
    assert!(matches!(
        lib.restore_snapshot("x".into()),
        Err(DecksError::Unsupported { .. })
    ));
    assert!(lib.list_snapshots().unwrap().is_empty());
    assert!(lib.prune_snapshots(1, 1).unwrap().is_empty());
    assert!(lib.auto_snapshot_if_due().unwrap().is_none());
    assert!(lib.integrity_problems().unwrap().is_empty());
}

#[test]
fn corrupt_library_is_refused_and_restored_by_path() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let p = db.to_string_lossy().into_owned();
    let snap_id = {
        let lib = DecksLibrary::open(p.clone()).unwrap();
        lib.upsert_track(track("C:/m/a.mp3", "A")).unwrap();
        lib.snapshot_now("manual".into()).unwrap().id
    };
    std::fs::write(&db, vec![0x13u8; 16_384]).unwrap();
    let _ = std::fs::remove_file(tmp.path().join("lib.sqlite-wal"));
    let _ = std::fs::remove_file(tmp.path().join("lib.sqlite-shm"));
    assert!(!library_integrity(p.clone()).unwrap().is_empty());
    assert!(DecksLibrary::open(p.clone()).is_err());
    let out = restore_library_file(p.clone(), snap_id).unwrap();
    assert!(
        out.pre_restore.is_none(),
        "corrupt file is copied raw, not snapshotted"
    );
    let lib = DecksLibrary::open(p.clone()).unwrap();
    assert_eq!(lib.track_count().unwrap(), 1);
    assert!(library_integrity(p).unwrap().is_empty());
}

#[test]
fn import_takes_a_before_import_snapshot_and_prune_trims() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let lib = DecksLibrary::open(db.to_string_lossy().into_owned()).unwrap();
    lib.upsert_track(track("C:/m/a.mp3", "A")).unwrap();
    let json = tmp.path().join("col.json");
    lib.export_file(
        LibraryFormat::NeutralJson,
        json.to_string_lossy().into_owned(),
    )
    .unwrap();
    lib.import_file(
        LibraryFormat::NeutralJson,
        json.to_string_lossy().into_owned(),
    )
    .unwrap();
    let reasons: Vec<String> = lib
        .list_snapshots()
        .unwrap()
        .into_iter()
        .map(|s| s.reason)
        .collect();
    assert!(
        reasons.contains(&"before-import".to_string()),
        "{reasons:?}"
    );
    for _ in 0..4 {
        lib.snapshot_now("manual".into()).unwrap();
    }
    let total = lib.list_snapshots().unwrap().len();
    let removed = lib.prune_snapshots(2, 0).unwrap();
    assert_eq!(removed.len(), total - 2);
    assert_eq!(lib.list_snapshots().unwrap().len(), 2);
    // Protected: import refused with the FFI variant, no snapshot taken.
    lib.set_protected(true).unwrap();
    let before = lib.list_snapshots().unwrap().len();
    assert!(matches!(
        lib.import_file(
            LibraryFormat::NeutralJson,
            json.to_string_lossy().into_owned()
        ),
        Err(DecksError::Protected { .. })
    ));
    assert_eq!(lib.list_snapshots().unwrap().len(), before);
}

// ---------------------------------------------------------------- review hardening

#[test]
fn restore_and_prune_are_refused_while_protected() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let lib = DecksLibrary::open(db.to_string_lossy().into_owned()).unwrap();
    lib.upsert_track(track("C:/m/a.mp3", "A")).unwrap();
    let snap = lib.snapshot_now("manual".into()).unwrap();
    lib.upsert_track(track("C:/m/b.mp3", "B")).unwrap();
    lib.snapshot_now("manual".into()).unwrap();
    lib.set_protected(true).unwrap();

    assert!(matches!(
        lib.restore_snapshot(snap.id.clone()),
        Err(DecksError::Protected { .. })
    ));
    assert!(matches!(
        lib.prune_snapshots(1, 0),
        Err(DecksError::Protected { .. })
    ));
    // Nothing happened: both snapshots still there, both tracks still there, still locked.
    assert_eq!(lib.list_snapshots().unwrap().len(), 2);
    assert_eq!(lib.track_count().unwrap(), 2);
    assert!(lib.is_protected().unwrap());

    // Unlocked: the restore runs and the library stays unlocked afterwards.
    lib.set_protected(false).unwrap();
    lib.restore_snapshot(snap.id).unwrap();
    assert_eq!(lib.track_count().unwrap(), 1);
    assert!(!lib.is_protected().unwrap());
}

#[test]
fn prune_keeps_at_least_one_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let lib = DecksLibrary::open(db.to_string_lossy().into_owned()).unwrap();
    lib.upsert_track(track("C:/m/a.mp3", "A")).unwrap();
    for _ in 0..3 {
        lib.snapshot_now("manual".into()).unwrap();
    }
    assert_eq!(lib.prune_snapshots(0, 0).unwrap().len(), 2);
    assert_eq!(lib.list_snapshots().unwrap().len(), 1);
}

#[test]
fn a_crafted_sidecar_is_never_listed_or_restored() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let p = db.to_string_lossy().into_owned();
    let lib = DecksLibrary::open(p.clone()).unwrap();
    lib.upsert_track(track("C:/m/a.mp3", "A")).unwrap();
    lib.snapshot_now("manual".into()).unwrap();

    // A file outside the snapshot folder an attacker would like restored / deleted.
    let victim = tmp.path().join("victim.sqlite");
    std::fs::write(&victim, b"private data").unwrap();
    let snaps = tmp.path().join("snapshots");
    for (id, file) in [
        (
            "decks-20991231-235959-999-manual",
            victim.to_string_lossy().into_owned(),
        ),
        (
            "decks-20991231-235959-998-manual",
            "../victim.sqlite".to_owned(),
        ),
        ("..\\..\\victim", "victim.sqlite".to_owned()),
    ] {
        let json = format!(
            "{{\"id\":\"{}\",\"file\":{},\"created_at_ms\":9000000000000,\"reason\":\"manual\",\
             \"schema_version\":3,\"tracks\":1,\"crates\":0,\"cues\":0,\"size_bytes\":1,\
             \"sha256\":\"{}\"}}",
            id.replace('\\', "\\\\"),
            serde_json::to_string(&file).unwrap(),
            "0".repeat(64)
        );
        std::fs::write(snaps.join(format!("{}.json", id.replace('\\', "_"))), json).unwrap();
    }
    assert_eq!(lib.list_snapshots().unwrap().len(), 1, "only the real one");
    assert_eq!(library_snapshots(p.clone()).unwrap().len(), 1);
    for id in [
        "decks-20991231-235959-999-manual",
        "decks-20991231-235959-998-manual",
        "..\\..\\victim",
    ] {
        assert!(matches!(
            lib.restore_snapshot(id.into()),
            Err(DecksError::NotFound { .. })
        ));
        assert!(restore_library_file(p.clone(), id.into()).is_err());
    }
    assert_eq!(
        std::fs::read(&victim).unwrap(),
        b"private data",
        "the file outside the folder is untouched"
    );
    assert_eq!(lib.track_count().unwrap(), 1);
}

#[test]
fn a_scan_cannot_start_during_a_restore_and_a_restore_waits_for_a_scan() {
    let tmp = tempfile::tempdir().unwrap();
    let music = tmp.path().join("music");
    std::fs::create_dir_all(&music).unwrap();
    let db = tmp.path().join("lib.sqlite");
    let lib = DecksLibrary::open(db.to_string_lossy().into_owned()).unwrap();
    lib.upsert_track(track("C:/m/a.mp3", "A")).unwrap();
    let snap = lib.snapshot_now("manual".into()).unwrap();

    // A scan of an empty folder finishes fast; poll until it is done, then restore works.
    let scan = lib
        .scan_folder(music.to_string_lossy().into_owned())
        .unwrap();
    for _ in 0..200 {
        if lib.scan_status(scan).map(|s| s.state) != Some(ScanState::Running) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_ne!(
        lib.scan_status(scan).map(|s| s.state),
        Some(ScanState::Running)
    );
    lib.restore_snapshot(snap.id).unwrap();

    // While a restore holds the gate, scan_folder is refused (the gate is the same mutex, so
    // this is what closes the check-then-lock window).
    assert!(lib.begin_restore_for_test().is_ok());
    let err = lib
        .scan_folder(music.to_string_lossy().into_owned())
        .unwrap_err();
    assert!(matches!(err, DecksError::InvalidArgument { .. }), "{err:?}");
    assert!(matches!(
        lib.restore_snapshot("decks-20991231-235959-999-manual".into()),
        Err(DecksError::InvalidArgument { .. })
    ));
    lib.end_restore_for_test();
    lib.scan_folder(music.to_string_lossy().into_owned())
        .unwrap();
}

#[test]
fn a_handle_that_could_not_be_reopened_reports_itself_unusable() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    let p = db.to_string_lossy().into_owned();
    let lib = DecksLibrary::open(p.clone()).unwrap();
    lib.upsert_track(track("C:/m/a.mp3", "A")).unwrap();
    let snap = lib.snapshot_now("manual".into()).unwrap();
    assert_eq!(lib.track_count().unwrap(), 1);

    assert!(lib.fail_reopen_for_test("reopen failed".into()).is_err());
    // No call answers from the in-memory placeholder any more; each says why.
    for err in [
        lib.track_count().map(|_| ()).unwrap_err(),
        lib.upsert_track(track("C:/m/b.mp3", "B"))
            .map(|_| ())
            .unwrap_err(),
        lib.is_protected().map(|_| ()).unwrap_err(),
        lib.integrity_problems().map(|_| ()).unwrap_err(),
        lib.prune_snapshots(1, 0).map(|_| ()).unwrap_err(),
        lib.restore_snapshot(snap.id.clone())
            .map(|_| ())
            .unwrap_err(),
    ] {
        assert!(
            matches!(&err, DecksError::Library { reason } if reason.contains("reopen failed")),
            "{err:?}"
        );
    }
    // The file itself is fine: a fresh handle works, and so does the path API.
    assert_eq!(library_snapshots(p.clone()).unwrap().len(), 1);
    let fresh = DecksLibrary::open(p).unwrap();
    assert_eq!(fresh.track_count().unwrap(), 1);
}
