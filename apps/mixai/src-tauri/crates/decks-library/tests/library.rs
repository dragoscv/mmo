//! Library tests: schema/migrations, upsert + dedupe, FTS search, smart crates, history,
//! analysis cache, folder scan, one-call migration, CDJ USB export.

use std::path::{Path, PathBuf};

use decks_library::cdj::{UsbExportOptions, export_usb};
use decks_library::interop::rekordbox;
use decks_library::library::Upserted;
use decks_library::model::{BeatGrid, Collection, Cue, CueKind, Playlist, Rgb, TrackRecord};
use decks_library::smart::Rule;
use decks_library::{Library, MusicalKey, Source, migrate_from, schema};

fn track(path: &str, title: &str, artist: &str, bpm: f64, key: &str) -> TrackRecord {
    TrackRecord {
        path: path.into(),
        title: Some(title.into()),
        artist: Some(artist.into()),
        bpm: Some(bpm),
        key: MusicalKey::parse(key),
        ..TrackRecord::default()
    }
}

/// Minimal valid PCM WAV (mono, 16-bit, 44.1 kHz, 0.1 s).
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

#[test]
fn schema_migrates_and_is_idempotent() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("lib.sqlite");
    {
        let lib = Library::open(&db).unwrap();
        assert_eq!(lib.schema_version().unwrap(), schema::SCHEMA_VERSION);
        let mode: String = lib
            .connection()
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let fk: i64 = lib
            .connection()
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1);
    }
    let lib = Library::open(&db).unwrap();
    assert_eq!(lib.schema_version().unwrap(), schema::SCHEMA_VERSION);
}

#[test]
fn upsert_merges_by_path_and_hash_and_cascades() {
    let mut lib = Library::open_in_memory().unwrap();
    let mut a = track("C:\\Music\\A.mp3", "A", "Ari", 124.0, "8A");
    a.file_hash = Some("h1".into());
    a.cues = vec![Cue {
        kind: CueKind::Hot,
        index: Some(0),
        start_sec: 1.5,
        end_sec: None,
        colour: Some(Rgb::new(1, 2, 3)),
        label: Some("x".into()),
    }];
    a.grid = Some(BeatGrid {
        bpm: 124.0,
        first_beat_sec: 0.2,
        downbeat_offset: 1,
        anchors: vec![],
        fixed: false,
    });
    let (id, how) = lib.upsert_track(&a).unwrap();
    assert_eq!(how, Upserted::Inserted);

    // Same file, other slash/case style, new genre: merge, keep cues.
    let b = TrackRecord {
        path: "c:/music/a.MP3".into(),
        genre: Some("Techno".into()),
        ..TrackRecord::default()
    };
    let (id2, how) = lib.upsert_track(&b).unwrap();
    assert_eq!((id2.as_str(), how), (id.as_str(), Upserted::MatchedPath));
    let got = lib.track(&id).unwrap().unwrap();
    assert_eq!(
        (got.title.as_deref(), got.genre.as_deref()),
        (Some("A"), Some("Techno"))
    );
    assert_eq!(got.cues.len(), 1);
    assert_eq!(got.grid.unwrap().downbeat_offset, 1);
    assert_eq!(got.key.unwrap().camelot(), "8A");

    // Moved file (same hash): merge and take the new path.
    let moved = TrackRecord {
        path: "D:/New/A.mp3".into(),
        file_hash: Some("h1".into()),
        ..TrackRecord::default()
    };
    let (id3, how) = lib.upsert_track(&moved).unwrap();
    assert_eq!((id3.as_str(), how), (id.as_str(), Upserted::MatchedHash));
    assert!(lib.track_by_path("d:\\new\\a.mp3").unwrap().is_some());
    assert_eq!(lib.track_count().unwrap(), 1);

    lib.delete_track(&id).unwrap();
    let cues: i64 = lib
        .connection()
        .query_row("SELECT COUNT(*) FROM cues", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cues, 0, "cues cascade on delete");
}

#[test]
fn fts_search_prefix_diacritics_and_updates() {
    let mut lib = Library::open_in_memory().unwrap();
    lib.upsert_tracks(&[
        track("/m/1.mp3", "Ș Night Drive", "Lumen", 100.0, "Dm"),
        track("/m/2.mp3", "Morning", "Sol", 124.0, "G"),
        TrackRecord {
            comment: Some("warm opener".into()),
            ..track("/m/3.mp3", "Alpha", "Ana", 122.0, "Am")
        },
    ])
    .unwrap();
    fn titles(lib: &Library, q: &str) -> Vec<String> {
        lib.search(q, 10)
            .unwrap()
            .into_iter()
            .filter_map(|t| t.title)
            .collect()
    }
    assert_eq!(titles(&lib, "nig"), vec!["Ș Night Drive"]);
    assert_eq!(titles(&lib, "lumen drive"), vec!["Ș Night Drive"]);
    assert_eq!(
        titles(&lib, "s night"),
        vec!["Ș Night Drive"],
        "diacritics folded"
    );
    assert_eq!(titles(&lib, "opener"), vec!["Alpha"]);
    assert!(titles(&lib, "\"; DROP TABLE tracks; --").is_empty());
    assert_eq!(lib.search("", 10).unwrap().len(), 3);
    lib.upsert_track(&TrackRecord {
        path: "/m/2.mp3".into(),
        title: Some("Evening".into()),
        ..TrackRecord::default()
    })
    .unwrap();
    assert!(titles(&lib, "morning").is_empty());
    assert_eq!(titles(&lib, "even"), vec!["Evening"]);
}

#[test]
fn smart_crates_compile_and_evaluate() {
    let mut lib = Library::open_in_memory().unwrap();
    lib.upsert_tracks(&[
        TrackRecord {
            genre: Some("Deep House".into()),
            ..track("/m/1.mp3", "One", "A", 122.0, "8A")
        },
        TrackRecord {
            genre: Some("Techno".into()),
            ..track("/m/2.mp3", "Two", "B", 130.0, "9A")
        },
        TrackRecord {
            genre: Some("Tech House".into()),
            ..track("/m/3.mp3", "Three", "C", 126.0, "3B")
        },
        TrackRecord {
            genre: Some("50%_house".into()),
            ..track("/m/4.mp3", "Four", "D", 90.0, "8B")
        },
    ])
    .unwrap();
    let names = |rule: &str| -> Vec<String> {
        let r: Rule = serde_json::from_str(rule).unwrap();
        lib.evaluate_rule(&r)
            .unwrap()
            .into_iter()
            .filter_map(|t| t.title)
            .collect()
    };
    assert_eq!(
        names(r#"{"field":"bpm","op":"between","value":[120,128]}"#),
        vec!["One", "Three"]
    );
    assert_eq!(
        names(
            r#"{"all":[{"field":"bpm","op":"gte","value":120},{"any":[{"field":"genre","op":"contains","value":"house"},{"field":"camelot","op":"in","value":["9A"]}]}]}"#
        ),
        vec!["One", "Two", "Three"]
    );
    assert_eq!(
        names(r#"{"field":"camelot","op":"harmonic","value":"Am"}"#),
        vec!["One", "Two", "Four"]
    );
    assert_eq!(
        names(r#"{"not":{"field":"genre","op":"starts_with","value":"tech"}}"#),
        vec!["One", "Four"]
    );
    assert_eq!(
        names(r#"{"field":"genre","op":"contains","value":"%_"}"#),
        vec!["Four"],
        "LIKE wildcards escaped"
    );
    assert_eq!(
        names(r#"{"field":"added_at","op":"within_days","value":1}"#).len(),
        4
    );
    let bad: Rule =
        serde_json::from_str(r#"{"field":"id; DROP TABLE tracks","op":"eq","value":1}"#).unwrap();
    assert!(lib.evaluate_rule(&bad).is_err());
    let id = lib
        .create_smart_crate(
            "Peak",
            &serde_json::from_str(r#"{"field":"bpm","op":"gt","value":125}"#).unwrap(),
        )
        .unwrap();
    assert_eq!(lib.smart_crates().unwrap().len(), 1);
    assert_eq!(lib.evaluate_smart_crate(id).unwrap().len(), 2);
    assert!(lib.create_smart_crate("Bad", &bad).is_err());
}

#[test]
fn crates_history_and_analysis_cache() {
    let mut lib = Library::open_in_memory().unwrap();
    let ids: Vec<String> = lib
        .upsert_tracks(&[
            track("/m/1.mp3", "One", "A", 120.0, "1A"),
            track("/m/2.mp3", "Two", "B", 121.0, "2A"),
        ])
        .unwrap()
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    let folder = lib.create_crate("Gigs", None, true).unwrap();
    let c = lib.create_crate("Friday", Some(folder), false).unwrap();
    lib.set_crate_tracks(c, &[ids[1].clone(), ids[0].clone()])
        .unwrap();
    lib.add_to_crate(c, &ids[1]).unwrap();
    let order: Vec<_> = lib
        .crate_tracks(c)
        .unwrap()
        .into_iter()
        .filter_map(|t| t.title)
        .collect();
    assert_eq!(order, vec!["Two", "One", "Two"]);
    assert_eq!(lib.crate_folder_path(c).unwrap(), vec!["Gigs".to_owned()]);
    let col = lib.to_collection().unwrap();
    assert_eq!(
        col.playlists,
        vec![Playlist {
            name: "Friday".into(),
            folder: vec!["Gigs".into()],
            tracks: vec!["/m/2.mp3".into(), "/m/1.mp3".into(), "/m/2.mp3".into()]
        }]
    );

    let s = lib.start_session(Some("Club")).unwrap();
    lib.record_play(s, &ids[0], Some(1)).unwrap();
    lib.record_play(s, &ids[1], Some(2)).unwrap();
    lib.end_session(s).unwrap();
    assert_eq!(lib.tracklist(s).unwrap(), "01. A - One\n02. B - Two\n");
    assert_eq!(lib.track(&ids[0]).unwrap().unwrap().play_count, 1);
    assert!(lib.sessions().unwrap()[0].ended_at.is_some());
    assert!(lib.record_play(s, "nope", None).is_err());

    lib.put_analysis(&ids[0], "waveform", 3, &[1, 2, 3])
        .unwrap();
    assert_eq!(
        lib.get_analysis(&ids[0], "waveform", 3).unwrap(),
        Some(vec![1, 2, 3])
    );
    assert_eq!(
        lib.get_analysis(&ids[0], "waveform", 4).unwrap(),
        None,
        "stale version"
    );
    lib.put_analysis(&ids[0], "waveform", 4, &[9]).unwrap();
    assert_eq!(
        lib.get_analysis(&ids[0], "waveform", 4).unwrap(),
        Some(vec![9])
    );
}

#[test]
fn scan_folder_reads_audio_files_with_progress() {
    let tmp = tempfile::tempdir().unwrap();
    write_wav(&tmp.path().join("a/One Track.wav"), 3);
    write_wav(&tmp.path().join("b/c/Two.wav"), 5);
    std::fs::write(tmp.path().join("notes.txt"), "x").unwrap();
    std::fs::write(tmp.path().join("broken.mp3"), "not audio").unwrap();
    let mut lib = Library::open_in_memory().unwrap();
    let mut calls = 0;
    let report = lib.scan_folder(tmp.path(), |_| calls += 1).unwrap();
    assert_eq!(report.added, 2, "{report:?}");
    assert_eq!(report.failed.len(), 1);
    assert_eq!(calls, 4, "one per audio file + final");
    let t = lib.search("one", 5).unwrap();
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].sample_rate, Some(44_100));
    assert!(t[0].file_hash.is_some());
    let again = lib.scan_folder(tmp.path(), |_| {}).unwrap();
    assert_eq!((again.added, again.updated), (0, 2));
}

fn temp_rekordbox_xml(root: &Path) -> (PathBuf, Vec<PathBuf>) {
    let files = vec![
        root.join("Music/A.wav"),
        root.join("Music/B.wav"),
        root.join("Music/Dup.wav"),
    ];
    write_wav(&files[0], 3);
    write_wav(&files[1], 5);
    write_wav(&files[2], 3); // same bytes as A → hash dedupe
    let mut a = track(&slash(&files[0]), "A", "Ari", 124.0, "8A");
    a.cues = vec![Cue {
        kind: CueKind::Hot,
        index: Some(0),
        start_sec: 1.0,
        end_sec: None,
        colour: Some(Rgb::new(0xE6, 0x28, 0x28)),
        label: None,
    }];
    a.grid = Some(BeatGrid {
        bpm: 124.0,
        first_beat_sec: 0.1,
        downbeat_offset: 0,
        anchors: vec![],
        fixed: false,
    });
    let col = Collection {
        tracks: vec![
            a,
            track(&slash(&files[1]), "B", "Bo", 126.0, "9A"),
            track(&slash(&files[2]), "Dup", "Ari", 124.0, "8A"),
            track(
                &slash(&root.join("Missing/Gone.mp3")),
                "Gone",
                "X",
                120.0,
                "1A",
            ),
        ],
        playlists: vec![Playlist {
            name: "Set".into(),
            folder: vec!["Gigs".into()],
            tracks: vec![slash(&files[1]), slash(&files[0])],
        }],
    };
    let xml = root.join("rekordbox.xml");
    std::fs::write(&xml, rekordbox::to_xml(&col)).unwrap();
    (xml, files)
}

#[test]
fn migrate_from_rekordbox_xml_dedupes_and_reports_unmatched() {
    let tmp = tempfile::tempdir().unwrap();
    let (xml, files) = temp_rekordbox_xml(tmp.path());
    let mut lib = Library::open_in_memory().unwrap();
    let r = migrate_from(&mut lib, Source::RekordboxXml(xml.clone())).unwrap();
    assert_eq!(r.tracks_seen, 4);
    assert_eq!(r.tracks_merged_by_hash, 1, "{r:?}");
    assert_eq!(r.tracks_inserted, 3); // A, B, Gone (unmatched but kept)
    assert_eq!(r.unmatched_files.len(), 1);
    assert!(r.unmatched_files[0].ends_with("Missing/Gone.mp3"));
    assert_eq!(
        (
            r.cues_imported,
            r.grids_imported,
            r.playlists_imported,
            r.playlist_entries
        ),
        (1, 1, 1, 2)
    );
    assert_eq!(lib.track_count().unwrap(), 3);
    let col = lib.to_collection().unwrap();
    assert_eq!(col.playlists[0].folder, vec!["Gigs".to_owned()]);
    assert_eq!(col.playlists[0].tracks[0], slash(&files[1]));

    // Second run is idempotent.
    let r2 = migrate_from(&mut lib, Source::RekordboxXml(xml)).unwrap();
    assert_eq!(r2.tracks_inserted, 0);
    assert_eq!(lib.track_count().unwrap(), 3);
    assert_eq!(lib.to_collection().unwrap().playlists.len(), 1);
}

#[test]
fn migrate_from_onelibrary_is_pending() {
    let mut lib = Library::open_in_memory().unwrap();
    let e = migrate_from(&mut lib, Source::OneLibrary("x".into())).unwrap_err();
    assert!(e.to_string().contains("pending"));
}

#[test]
fn cdj_usb_export_copies_audio_and_writes_xml() {
    let tmp = tempfile::tempdir().unwrap();
    let (xml, _) = temp_rekordbox_xml(&tmp.path().join("src"));
    let mut lib = Library::open_in_memory().unwrap();
    migrate_from(&mut lib, Source::RekordboxXml(xml)).unwrap();
    let usb = tmp.path().join("usb");
    let col = lib.to_collection().unwrap();
    let rep = export_usb(&col, &usb, &UsbExportOptions::default()).unwrap();
    assert_eq!(rep.files_copied, 2);
    assert_eq!(rep.missing_files.len(), 1);
    assert!(!rep.pdb_written);
    assert!(usb.join("PIONEER").is_dir());
    assert!(usb.join("Contents/Ari/Unknown Album/A.wav").is_file());
    let back =
        rekordbox::parse(&std::fs::read_to_string(usb.join("rekordbox.xml")).unwrap()).unwrap();
    let a = back
        .tracks
        .iter()
        .find(|t| t.title.as_deref() == Some("A"))
        .unwrap();
    assert!(a.path.contains("/usb/Contents/"), "{}", a.path);
    assert_eq!(a.cues.len(), 1);
    assert!(
        back.playlists[0]
            .tracks
            .iter()
            .all(|p| p.contains("/usb/") || p.contains("Missing"))
    );
    assert!(usb.join("_Serato_/Subcrates/Gigs%%Set.crate").is_file());
    let rep2 = export_usb(&col, &usb, &UsbExportOptions::default()).unwrap();
    assert_eq!((rep2.files_copied, rep2.files_skipped), (0, 2));
}
