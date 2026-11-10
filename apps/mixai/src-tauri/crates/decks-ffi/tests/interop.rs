//! Import over FFI (WP19-38): detection, preview, run with options, report — the calls the
//! Kotlin / Swift import screens make.

use std::path::Path;

use decks_ffi::*;

/// Minimal valid PCM WAV (mono, 16-bit, 44.1 kHz, 0.1 s); `seed` changes the content.
fn write_wav(path: &Path, seed: u8) {
    let samples = 4410u32;
    let data_len = samples * 2;
    let mut b = Vec::new();
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data_len).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&44_100u32.to_le_bytes());
    b.extend_from_slice(&88_200u32.to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data_len.to_le_bytes());
    b.extend((0..data_len).map(|i| (i as u8).wrapping_mul(seed)));
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).unwrap();
    }
    std::fs::write(path, b).unwrap();
}

fn slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn location(p: &Path) -> String {
    let s = slash(p);
    let s = s.trim_start_matches('/');
    let enc: String = s
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' | b':' => {
                char::from(b).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect();
    format!("file://localhost/{enc}")
}

/// rekordbox XML with two present tracks (one with a hot cue + grid), one missing track and a
/// playlist; returns the XML path.
fn rekordbox_export(root: &Path) -> String {
    let a = root.join("Music/a b.wav");
    let b = root.join("Music/b.wav");
    write_wav(&a, 3);
    write_wav(&b, 5);
    let gone = root.join("Gone/c.wav");
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <COLLECTION Entries="3">
    <TRACK TrackID="1" Name="A" Artist="Ana" AverageBpm="124.00" Location="{}">
      <TEMPO Inizio="0.100" Bpm="124.00" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="Drop" Type="0" Start="1.000" Num="0" Red="230" Green="40" Blue="40"/>
    </TRACK>
    <TRACK TrackID="2" Name="B" Artist="Bo" Location="{}"/>
    <TRACK TrackID="3" Name="C" Artist="Cy" Location="{}"/>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Name="Warmup" Type="1" KeyType="0" Entries="2"><TRACK Key="2"/><TRACK Key="1"/></NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
"#,
        location(&a),
        location(&b),
        location(&gone)
    );
    let path = root.join("rekordbox.xml");
    std::fs::write(&path, xml).unwrap();
    path.display().to_string()
}

#[test]
fn detect_preview_run_over_ffi() {
    let tmp = tempfile::tempdir().unwrap();
    let xml = rekordbox_export(tmp.path());
    let found = detect_import_format(xml.clone()).expect("detected");
    assert_eq!(found.format, LibraryFormat::RekordboxXml);
    assert_eq!(found.path, xml);
    assert!(detect_import_format(tmp.path().join("nope.txt").display().to_string()).is_none());

    let lib = DecksLibrary::open_in_memory().unwrap();
    let p = import_preview(
        lib.clone(),
        found.format.clone(),
        found.path.clone(),
        ImportOptions::default(),
    )
    .unwrap();
    assert_eq!(p.tracks_seen, 3);
    assert_eq!(
        (p.new_tracks, p.matched_by_path, p.missing_files),
        (3, 0, 1)
    );
    assert_eq!(
        (p.cues, p.grids, p.playlists, p.playlist_entries),
        (1, 1, 1, 2)
    );
    assert!(p.missing_sample[0].ends_with("Gone/c.wav"));
    assert!(!p.protected);
    assert_eq!(lib.track_count().unwrap(), 0, "preview must not write");

    let r = import_run(
        lib.clone(),
        found.format.clone(),
        found.path.clone(),
        ImportOptions {
            conflict: ImportConflict::Merge,
            relocate_roots: vec![],
            correct_drift: true,
        },
    )
    .unwrap();
    assert_eq!(r.summary.tracks_seen, 3);
    assert_eq!(r.summary.tracks_inserted, 3); // missing file kept, flagged
    assert_eq!(r.summary.unmatched_files.len(), 1);
    assert_eq!(
        (r.summary.cues_imported, r.summary.playlists_imported),
        (1, 1)
    );
    assert_eq!(r.drift_fixes as usize, r.drift_notes.len());
    assert_eq!(lib.track_count().unwrap(), 3);
    assert!(lib.crates().unwrap().iter().any(|c| c.name == "Warmup"));

    // Second preview: everything now matches by path (the missing file was imported at its
    // recorded path, so it matches too).
    let p2 = import_preview(
        lib.clone(),
        found.format.clone(),
        found.path.clone(),
        ImportOptions::default(),
    )
    .unwrap();
    assert_eq!((p2.new_tracks, p2.matched_by_path), (0, 3));
}

#[test]
fn keep_existing_over_ffi_keeps_library_cues() {
    let tmp = tempfile::tempdir().unwrap();
    let xml = rekordbox_export(tmp.path());
    let lib = DecksLibrary::open_in_memory().unwrap();
    let path_a = slash(&tmp.path().join("Music/a b.wav"));
    let id = lib
        .upsert_track(LibraryTrack {
            path: path_a.clone(),
            title: Some("Mine".into()),
            cues: vec![LibraryCue {
                kind: CueType::Hot,
                index: Some(0),
                start_sec: 9.0,
                end_sec: None,
                colour: None,
                label: None,
            }],
            ..LibraryTrack::default()
        })
        .unwrap();
    import_run(
        lib.clone(),
        LibraryFormat::RekordboxXml,
        xml,
        ImportOptions {
            conflict: ImportConflict::KeepExisting,
            ..ImportOptions::default()
        },
    )
    .unwrap();
    let t = lib.track(id).unwrap().unwrap();
    assert_eq!(t.title.as_deref(), Some("Mine"));
    assert_eq!(t.cues.len(), 1);
    assert_eq!(t.cues[0].start_sec, 9.0);
    assert_eq!(t.artist.as_deref(), Some("Ana")); // gap filled
}

#[test]
fn relocation_over_ffi_and_serato_detection() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let xml = rekordbox_export(root);
    write_wav(&root.join("Moved/c.wav"), 7);
    let lib = DecksLibrary::open_in_memory().unwrap();
    let opts = ImportOptions {
        relocate_roots: vec![root.join("Moved").display().to_string(), "  ".into()],
        ..ImportOptions::default()
    };
    let p = import_preview(
        lib.clone(),
        LibraryFormat::RekordboxXml,
        xml.clone(),
        opts.clone(),
    )
    .unwrap();
    assert_eq!((p.missing_files, p.relocatable), (0, 1));
    let r = import_run(lib.clone(), LibraryFormat::RekordboxXml, xml, opts).unwrap();
    assert_eq!(r.relocated, 1);
    assert!(
        lib.track_by_path(slash(&root.join("Moved/c.wav")))
            .unwrap()
            .is_some()
    );

    let serato = root.join("drive/_Serato_");
    std::fs::create_dir_all(serato.join("Subcrates")).unwrap();
    let d = detect_import_format(root.join("drive").display().to_string()).unwrap();
    // Compare as paths so the separator style of the platform does not matter.
    assert_eq!(Path::new(&d.path), serato.as_path());
    assert!(matches!(d.format, LibraryFormat::SeratoCrates { .. }));
}

#[test]
fn onelibrary_and_bad_files_fail_cleanly() {
    let lib = DecksLibrary::open_in_memory().unwrap();
    assert!(matches!(
        import_preview(
            lib.clone(),
            LibraryFormat::OneLibrary,
            "x".into(),
            ImportOptions::default()
        ),
        Err(DecksError::Unsupported { .. })
    ));
    assert!(matches!(
        import_run(
            lib.clone(),
            LibraryFormat::RekordboxXml,
            "Z:/missing.xml".into(),
            ImportOptions::default()
        ),
        Err(DecksError::Library { .. })
    ));
}

/// Review P0-1: the path the Kotlin / Swift shells actually call (`import_run`) must leave a
/// rollback point behind on a file-backed library, and must refuse a protected library before
/// snapshotting or writing anything.
#[test]
fn import_run_snapshots_before_writing_and_refuses_a_protected_library() {
    let tmp = tempfile::tempdir().unwrap();
    let xml = rekordbox_export(tmp.path());
    let db = tmp.path().join("lib.sqlite");
    let lib = DecksLibrary::open(db.to_string_lossy().into_owned()).unwrap();
    lib.upsert_track(LibraryTrack {
        path: slash(&tmp.path().join("Music/a b.wav")),
        title: Some("Mine".into()),
        ..LibraryTrack::default()
    })
    .unwrap();
    assert!(lib.list_snapshots().unwrap().is_empty(), "clean start");

    // Default policy (PreferImported) overwrites cues / grids: a snapshot must exist after it.
    import_run(
        lib.clone(),
        LibraryFormat::RekordboxXml,
        xml.clone(),
        ImportOptions::default(),
    )
    .unwrap();
    let snaps = lib.list_snapshots().unwrap();
    assert!(
        snaps.iter().any(|s| s.reason == "before-import"),
        "{:?}",
        snaps.iter().map(|s| &s.reason).collect::<Vec<_>>()
    );
    // The snapshot is of the state BEFORE the import (one track, not three).
    let before = snaps
        .iter()
        .find(|s| s.reason == "before-import")
        .expect("before-import snapshot");
    assert_eq!(before.tracks, 1);
    assert_eq!(lib.track_count().unwrap(), 3);

    // Protected: refused before any snapshot and before any write.
    lib.set_protected(true).unwrap();
    let snaps_before = lib.list_snapshots().unwrap().len();
    let tracks_before = lib.track_count().unwrap();
    assert!(matches!(
        import_run(
            lib.clone(),
            LibraryFormat::RekordboxXml,
            xml,
            ImportOptions::default()
        ),
        Err(DecksError::Protected { .. })
    ));
    assert_eq!(lib.list_snapshots().unwrap().len(), snaps_before);
    assert_eq!(lib.track_count().unwrap(), tracks_before);
}

/// An in-memory library has no snapshot folder: `import_run` must still work there (that is
/// what the preview screens and the tests above use).
#[test]
fn import_run_on_an_in_memory_library_skips_the_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let xml = rekordbox_export(tmp.path());
    let lib = DecksLibrary::open_in_memory().unwrap();
    assert!(!lib.can_snapshot());
    let r = import_run(
        lib.clone(),
        LibraryFormat::RekordboxXml,
        xml,
        ImportOptions::default(),
    )
    .unwrap();
    assert_eq!(r.summary.tracks_inserted, 3);
    assert!(lib.list_snapshots().unwrap().is_empty());
}
