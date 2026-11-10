//! Import product layer (WP19-38): preview, conflict policy, relocation, drift hook, protect
//! lock, format detection.

use std::path::{Path, PathBuf};

use decks_library::interop::{json, rekordbox};
use decks_library::migrate::{
    ConflictPolicy, MigrateOptions, detect_source, migrate_with, preview,
};
use decks_library::model::{BeatGrid, Collection, Cue, CueKind, Playlist, TrackRecord};
use decks_library::{Library, Source, migrate_from};

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

fn rec(path: &Path, title: &str) -> TrackRecord {
    TrackRecord {
        path: slash(path),
        title: Some(title.into()),
        ..TrackRecord::default()
    }
}

fn hot(i: u8, sec: f64) -> Cue {
    Cue {
        kind: CueKind::Hot,
        index: Some(i),
        start_sec: sec,
        end_sec: None,
        colour: None,
        label: None,
    }
}

fn grid(bpm: f64) -> BeatGrid {
    BeatGrid {
        bpm,
        first_beat_sec: 0.1,
        downbeat_offset: 0,
        anchors: vec![],
        fixed: false,
    }
}

fn one(t: TrackRecord) -> Source {
    Source::Collection(Collection {
        tracks: vec![t],
        playlists: vec![],
    })
}

/// Library with one track (title "Lib", no BPM, hot cue A at 1 s, 120 BPM grid) and the
/// incoming record for the same file (title "Imp", 128 BPM, hot cues A at 2 s + B at 5 s,
/// 128 BPM grid).
fn conflict_setup(dir: &Path) -> (Library, TrackRecord) {
    let f = dir.join("a.wav");
    write_wav(&f, 3);
    let mut lib = Library::open_in_memory().unwrap();
    let mut old = rec(&f, "Lib");
    old.cues = vec![hot(0, 1.0)];
    old.grid = Some(grid(120.0));
    lib.upsert_track(&old).unwrap();
    let mut new = rec(&f, "Imp");
    new.bpm = Some(128.0);
    new.cues = vec![hot(0, 2.0), hot(1, 5.0)];
    new.grid = Some(grid(128.0));
    (lib, new)
}

fn run(policy: ConflictPolicy) -> (TrackRecord, decks_library::MigrationReport) {
    let tmp = tempfile::tempdir().unwrap();
    let (mut lib, new) = conflict_setup(tmp.path());
    let opts = MigrateOptions {
        conflict: policy,
        ..MigrateOptions::default()
    };
    let r = migrate_with(&mut lib, one(new.clone()), &opts).unwrap();
    assert_eq!(lib.track_count().unwrap(), 1);
    (lib.track_by_path(&new.path).unwrap().unwrap(), r)
}

#[test]
fn conflict_policy_keep_existing_only_fills_gaps() {
    let (t, r) = run(ConflictPolicy::KeepExisting);
    assert_eq!(t.title.as_deref(), Some("Lib"));
    assert_eq!(t.bpm, Some(128.0)); // the library had none
    assert_eq!(t.cues, vec![hot(0, 1.0)]);
    assert_eq!(t.grid.unwrap().bpm, 120.0);
    assert_eq!(
        (r.tracks_merged_by_path, r.cues_imported, r.grids_imported),
        (1, 0, 0)
    );
}

#[test]
fn conflict_policy_prefer_imported_overwrites() {
    let (t, r) = run(ConflictPolicy::PreferImported);
    assert_eq!(t.title.as_deref(), Some("Imp"));
    assert_eq!(t.cues, vec![hot(0, 2.0), hot(1, 5.0)]);
    assert_eq!(t.grid.unwrap().bpm, 128.0);
    assert_eq!((r.cues_imported, r.grids_imported), (2, 1));
}

#[test]
fn conflict_policy_merge_adds_only_free_slots() {
    let (t, r) = run(ConflictPolicy::Merge);
    assert_eq!(t.title.as_deref(), Some("Lib"));
    assert_eq!(t.bpm, Some(128.0));
    // Slot A is taken by the library cue; B is free and gets added.
    assert_eq!(t.cues, vec![hot(0, 1.0), hot(1, 5.0)]);
    assert_eq!(t.grid.unwrap().bpm, 120.0);
    assert_eq!(r.cues_imported, 1);
}

#[test]
fn default_migrate_from_keeps_prefer_imported_behaviour() {
    let tmp = tempfile::tempdir().unwrap();
    let (mut lib, new) = conflict_setup(tmp.path());
    migrate_from(&mut lib, one(new.clone())).unwrap();
    let t = lib.track_by_path(&new.path).unwrap().unwrap();
    assert_eq!(t.title.as_deref(), Some("Imp"));
}

/// Library holds `a.wav`; the source lists a (path match), `dup.wav` (same bytes: hash match),
/// `b.wav` (new), `Missing/z.wav` (re-found under `elsewhere/`) and `Missing/q.wav` (gone),
/// plus a playlist [a, z, unknown].
fn preview_setup(root: &Path) -> (Library, Collection, MigrateOptions) {
    let a = root.join("lib/a.wav");
    write_wav(&a, 3);
    std::fs::create_dir_all(root.join("lib")).unwrap();
    std::fs::copy(&a, root.join("lib/dup.wav")).unwrap();
    write_wav(&root.join("lib/b.wav"), 5);
    write_wav(&root.join("elsewhere/deep/z.wav"), 7);
    let mut lib = Library::open_in_memory().unwrap();
    migrate_from(&mut lib, one(rec(&a, "A"))).unwrap();
    let z_old = root.join("Missing/z.wav");
    let mut a_in = rec(&a, "A");
    a_in.cues = vec![hot(0, 1.0)];
    a_in.grid = Some(grid(124.0));
    let col = Collection {
        tracks: vec![
            a_in,
            rec(&root.join("lib/dup.wav"), "Dup"),
            rec(&root.join("lib/b.wav"), "B"),
            rec(&z_old, "Z"),
            rec(&root.join("Missing/q.wav"), "Q"),
        ],
        playlists: vec![Playlist {
            name: "Set".into(),
            folder: vec!["Gigs".into()],
            tracks: vec![slash(&a), slash(&z_old), slash(&root.join("nope.wav"))],
        }],
    };
    let opts = MigrateOptions {
        relocate_roots: vec![root.join("elsewhere")],
        ..MigrateOptions::default()
    };
    (lib, col, opts)
}

#[test]
fn preview_counts_without_writing() {
    let tmp = tempfile::tempdir().unwrap();
    let (lib, col, opts) = preview_setup(tmp.path());
    let p = preview(&lib, &Source::Collection(col), &opts).unwrap();
    assert_eq!(p.tracks_seen, 5);
    assert_eq!(
        (p.matched_by_path, p.matched_by_hash, p.new_tracks),
        (1, 1, 3),
        "{p:?}"
    );
    assert_eq!((p.missing_files, p.relocatable), (1, 1));
    assert!(p.missing_sample[0].ends_with("Missing/q.wav"));
    assert_eq!(
        (p.cues, p.grids, p.playlists, p.playlist_entries),
        (1, 1, 1, 2)
    );
    assert!(!p.protected);
    // Nothing written.
    assert_eq!(lib.track_count().unwrap(), 1);
    assert!(lib.crates().unwrap().is_empty());
}

#[test]
fn migrate_with_relocates_and_keeps_playlist_links() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let (mut lib, col, opts) = preview_setup(root);
    let r = migrate_with(&mut lib, Source::Collection(col), &opts).unwrap();
    assert_eq!(r.relocated, 1);
    assert_eq!(r.unmatched_files.len(), 1);
    assert_eq!(
        (
            r.tracks_inserted,
            r.tracks_merged_by_path,
            r.tracks_merged_by_hash
        ),
        (3, 1, 1),
        "{r:?}"
    );
    assert_eq!((r.playlists_imported, r.playlist_entries), (1, 2));
    assert!(r.warnings.iter().any(|w| w.contains("nope.wav")));
    assert_eq!(r.drift_fixes, r.drift_notes.len());
    let z_new = slash(&root.join("elsewhere/deep/z.wav"));
    let z = lib
        .track_by_path(&z_new)
        .unwrap()
        .expect("relocated path imported");
    let crate_id = lib
        .crates()
        .unwrap()
        .iter()
        .find(|c| c.name == "Set")
        .unwrap()
        .id;
    let members = lib.crate_tracks(crate_id).unwrap();
    assert_eq!(members.len(), 2);
    assert_eq!(members[1].id, z.id);
}

#[test]
fn relocation_is_refused_when_ambiguous_and_uses_folder_names_to_break_ties() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_wav(&root.join("r/x/amb.wav"), 2);
    write_wav(&root.join("r/y/amb.wav"), 4);
    let opts = MigrateOptions {
        relocate_roots: vec![root.join("r")],
        ..MigrateOptions::default()
    };
    let lib = Library::open_in_memory().unwrap();
    let p = preview(&lib, &one(rec(&root.join("gone/amb.wav"), "A")), &opts).unwrap();
    assert_eq!((p.relocatable, p.missing_files), (0, 1));
    assert!(
        p.warnings
            .iter()
            .any(|w| w.contains("2 files named amb.wav")),
        "{p:?}"
    );
    let p = preview(&lib, &one(rec(&root.join("gone/y/amb.wav"), "A")), &opts).unwrap();
    assert_eq!((p.relocatable, p.missing_files), (1, 0));
}

#[test]
fn relocation_matches_rekordbox_size() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join("r1")).unwrap();
    std::fs::create_dir_all(root.join("r2")).unwrap();
    std::fs::write(root.join("r1/s.wav"), vec![1u8; 100]).unwrap();
    std::fs::write(root.join("r2/s.wav"), vec![2u8; 250]).unwrap();
    let loc = rekordbox::path_to_location(&slash(&root.join("old/s.wav")));
    let xml = format!(
        "<?xml version=\"1.0\"?><DJ_PLAYLISTS Version=\"1.0.0\"><COLLECTION Entries=\"1\">\
         <TRACK TrackID=\"1\" Name=\"S\" Size=\"250\" Location=\"{loc}\"/></COLLECTION></DJ_PLAYLISTS>"
    );
    let file = root.join("rb.xml");
    std::fs::write(&file, xml).unwrap();
    let mut lib = Library::open_in_memory().unwrap();
    let opts = MigrateOptions {
        relocate_roots: vec![root.to_path_buf()],
        ..MigrateOptions::default()
    };
    let r = migrate_with(&mut lib, Source::RekordboxXml(file), &opts).unwrap();
    assert_eq!(r.relocated, 1);
    assert!(
        lib.track_by_path(&slash(&root.join("r2/s.wav")))
            .unwrap()
            .is_some()
    );
}

#[test]
fn drift_option_runs_and_reports_consistently() {
    let tmp = tempfile::tempdir().unwrap();
    let f = tmp.path().join("d.wav");
    write_wav(&f, 9);
    let mut t = rec(&f, "D");
    t.cues = vec![hot(0, 1.0)];
    let mut lib = Library::open_in_memory().unwrap();
    let opts = MigrateOptions {
        correct_drift: true,
        ..MigrateOptions::default()
    };
    let r = migrate_with(&mut lib, one(t), &opts).unwrap();
    assert_eq!(r.drift_fixes, r.drift_notes.len());
    assert_eq!(r.tracks_inserted, 1);
}

#[test]
fn unprotected_library_previews_and_imports() {
    let lib = Library::open_in_memory().unwrap();
    assert!(!lib.is_protected().unwrap());
    let tmp = tempfile::tempdir().unwrap();
    let f = tmp.path().join("p.wav");
    write_wav(&f, 1);
    assert!(
        !preview(&lib, &one(rec(&f, "P")), &MigrateOptions::default())
            .unwrap()
            .protected
    );
}

#[test]
fn onelibrary_import_stays_blocked() {
    let mut lib = Library::open_in_memory().unwrap();
    let e = migrate_with(
        &mut lib,
        Source::OneLibrary("x".into()),
        &MigrateOptions::default(),
    )
    .unwrap_err()
    .to_string();
    assert!(e.contains("partner access"), "{e}");
}

fn touch(p: &Path, body: &str) -> PathBuf {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::write(p, body).unwrap();
    p.to_path_buf()
}

#[test]
fn detect_source_recognises_each_format() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let rb = touch(
        &root.join("rb.xml"),
        "<?xml version=\"1.0\"?>\n<DJ_PLAYLISTS Version=\"1.0.0\"/>",
    );
    assert!(matches!(detect_source(&rb), Some(Source::RekordboxXml(p)) if p == rb));
    let other = touch(&root.join("other.xml"), "<plist/>");
    assert!(detect_source(&other).is_none());
    let nml = touch(&root.join("collection.NML"), "<NML/>");
    assert!(matches!(detect_source(&nml), Some(Source::TraktorNml(_))));
    let js = touch(
        &root.join("lib.json"),
        &json::to_json(&Collection::default()).unwrap(),
    );
    assert!(matches!(detect_source(&js), Some(Source::NeutralJson(_))));
    let mdb = touch(&root.join("Engine Library/Database2/m.db"), "");
    assert!(matches!(detect_source(&mdb), Some(Source::EngineDj(_))));
    assert!(detect_source(&touch(&root.join("notes.txt"), "x")).is_none());
    assert!(detect_source(&root.join("does-not-exist.xml")).is_none());

    // Serato: the drive root, the _Serato_ folder itself and its database file.
    let drive = root.join("drive");
    let db = touch(&drive.join("_Serato_/database V2"), "");
    for pick in [drive.clone(), drive.join("_Serato_"), db] {
        match detect_source(&pick) {
            Some(Source::Serato {
                serato_dir,
                volume_root,
            }) => {
                assert_eq!(serato_dir, drive.join("_Serato_"), "{pick:?}");
                assert!(serato_dir.starts_with(&volume_root));
            }
            other => panic!("{pick:?} -> {other:?}"),
        }
    }

    // rekordbox USB: the stick root and the export.pdb itself.
    let usb = root.join("usb");
    let pdb = touch(&usb.join("PIONEER/rekordbox/export.pdb"), "");
    for pick in [usb.clone(), pdb.clone()] {
        match detect_source(&pick) {
            Some(Source::RekordboxPdb {
                pdb: p,
                volume_root,
            }) => {
                assert_eq!((p, volume_root), (pdb.clone(), usb.clone()));
            }
            other => panic!("{pick:?} -> {other:?}"),
        }
    }
    let empty = root.join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    assert!(detect_source(&empty).is_none());
}

// ---------------------------------------------------------------- review P1-6: crates

fn crate_named(lib: &Library, name: &str) -> i64 {
    lib.crates()
        .unwrap()
        .into_iter()
        .find(|c| c.name == name)
        .unwrap_or_else(|| panic!("crate {name}"))
        .id
}

fn titles_in(lib: &Library, name: &str) -> Vec<String> {
    lib.crate_tracks(crate_named(lib, name))
        .unwrap()
        .into_iter()
        .map(|t| t.title.unwrap_or_default())
        .collect()
}

/// Library already owns a crate "Set" holding "Mine"; the source brings a playlist with the
/// same name holding "Theirs" (plus "Mine" again, to prove no duplicate row is added).
fn same_name_crate_setup(root: &Path) -> (Library, Collection) {
    let mine = root.join("mine.wav");
    let theirs = root.join("theirs.wav");
    write_wav(&mine, 3);
    write_wav(&theirs, 5);
    let mut lib = Library::open_in_memory().unwrap();
    let (mine_id, _) = lib.upsert_track(&rec(&mine, "Mine")).unwrap();
    let set = lib.create_crate("Set", None, false).unwrap();
    lib.set_crate_tracks(set, &[mine_id]).unwrap();
    let col = Collection {
        tracks: vec![rec(&theirs, "Theirs"), rec(&mine, "Mine")],
        playlists: vec![Playlist {
            name: "Set".into(),
            folder: vec![],
            tracks: vec![slash(&theirs), slash(&mine)],
        }],
    };
    (lib, col)
}

#[test]
fn merge_appends_to_an_existing_user_crate_instead_of_replacing_it() {
    let tmp = tempfile::tempdir().unwrap();
    let (mut lib, col) = same_name_crate_setup(tmp.path());
    let opts = MigrateOptions {
        conflict: ConflictPolicy::Merge,
        ..MigrateOptions::default()
    };
    let r = migrate_with(&mut lib, Source::Collection(col), &opts).unwrap();
    assert_eq!(lib.crates().unwrap().len(), 1, "no second Set crate");
    assert_eq!(titles_in(&lib, "Set"), vec!["Mine", "Theirs"]);
    // Only the track the crate did not hold counts as an imported entry.
    assert_eq!(r.playlist_entries, 1);
}

#[test]
fn keep_existing_appends_to_an_existing_user_crate() {
    let tmp = tempfile::tempdir().unwrap();
    let (mut lib, col) = same_name_crate_setup(tmp.path());
    let opts = MigrateOptions {
        conflict: ConflictPolicy::KeepExisting,
        ..MigrateOptions::default()
    };
    migrate_with(&mut lib, Source::Collection(col), &opts).unwrap();
    assert_eq!(titles_in(&lib, "Set"), vec!["Mine", "Theirs"]);
}

#[test]
fn prefer_imported_replaces_the_crate_contents() {
    let tmp = tempfile::tempdir().unwrap();
    let (mut lib, col) = same_name_crate_setup(tmp.path());
    let r = migrate_with(
        &mut lib,
        Source::Collection(col),
        &MigrateOptions::default(),
    )
    .unwrap();
    // Documented rule: the import wins, so the crate becomes exactly the source playlist.
    assert_eq!(titles_in(&lib, "Set"), vec!["Theirs", "Mine"]);
    assert_eq!(r.playlist_entries, 2);
}

#[test]
fn two_playlists_with_the_same_name_do_not_collapse_into_one_crate() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a.wav");
    let b = tmp.path().join("b.wav");
    write_wav(&a, 3);
    write_wav(&b, 5);
    let col = Collection {
        tracks: vec![rec(&a, "A"), rec(&b, "B")],
        playlists: vec![
            Playlist {
                name: "Set".into(),
                folder: vec![],
                tracks: vec![slash(&a)],
            },
            Playlist {
                name: "Set".into(),
                folder: vec![],
                tracks: vec![slash(&b)],
            },
        ],
    };
    let mut lib = Library::open_in_memory().unwrap();
    let r = migrate_with(
        &mut lib,
        Source::Collection(col),
        &MigrateOptions::default(),
    )
    .unwrap();
    assert_eq!(r.playlists_imported, 2);
    assert_eq!(titles_in(&lib, "Set"), vec!["A"]);
    assert_eq!(titles_in(&lib, "Set (2)"), vec!["B"]);
    // A playlist of the same name in another folder keeps that name (different parent).
    assert_eq!(lib.crates().unwrap().len(), 2);
}

#[test]
fn a_failure_mid_import_leaves_the_library_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let mine = tmp.path().join("mine.wav");
    write_wav(&mine, 3);
    let mut lib = Library::open_in_memory().unwrap();
    let (mine_id, _) = lib.upsert_track(&rec(&mine, "Mine")).unwrap();
    let set = lib.create_crate("Set", None, false).unwrap();
    lib.set_crate_tracks(set, std::slice::from_ref(&mine_id))
        .unwrap();

    // The tracks and the first crates write fine; the import then fails in the crate phase
    // (more same-named playlists in one folder than the disambiguator allows). With one
    // transaction around the whole apply, none of the earlier writes may survive.
    let other = tmp.path().join("other.wav");
    write_wav(&other, 5);
    let mut overwrite = rec(&mine, "Overwritten");
    overwrite.cues = vec![hot(0, 4.0)];
    let col = Collection {
        tracks: vec![overwrite, rec(&other, "Other")],
        playlists: (0..=decks_library::migrate::MAX_SAME_NAME_PLAYLISTS)
            .map(|_| Playlist {
                name: "Set".into(),
                folder: vec![],
                tracks: vec![slash(&mine), slash(&other)],
            })
            .collect(),
    };
    let err = migrate_with(
        &mut lib,
        Source::Collection(col),
        &MigrateOptions::default(),
    )
    .unwrap_err();
    assert!(err.to_string().contains("playlists named Set"), "{err}");

    // Nothing from the import survived: no new tracks, no edits, crate untouched.
    assert_eq!(lib.track_count().unwrap(), 1);
    assert_eq!(
        lib.track_by_path(&slash(&mine))
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("Mine")
    );
    assert!(lib.cues(&mine_id).unwrap().is_empty());
    assert_eq!(titles_in(&lib, "Set"), vec!["Mine"]);
    assert_eq!(lib.crates().unwrap().len(), 1);
}
