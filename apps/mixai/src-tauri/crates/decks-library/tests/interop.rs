//! Format tests: rekordbox XML, Traktor NML, Serato, Engine DJ, PDB, JSON, keys, colours.

use std::path::{Path, PathBuf};

use decks_library::colour::{self, Platform};
use decks_library::interop::{self, Interchange, engine, json, nml, pdb, rekordbox, serato};
use decks_library::model::{Collection, CueKind, Rgb};
use decks_library::{Cue, MusicalKey};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn read(name: &str) -> String {
    std::fs::read_to_string(fixture(name)).expect("fixture")
}

fn find<'a>(col: &'a Collection, title: &str) -> &'a decks_library::TrackRecord {
    col.tracks
        .iter()
        .find(|t| t.title.as_deref() == Some(title))
        .unwrap_or_else(|| panic!("track {title} missing"))
}

// ------------------------------------------------------------------ keys

#[test]
fn key_notations_agree_for_all_24_keys() {
    for pc in 0..12u8 {
        for minor in [false, true] {
            let k = MusicalKey::new(pc, minor).unwrap();
            assert_eq!(
                MusicalKey::parse(&k.camelot()),
                Some(k),
                "camelot {}",
                k.camelot()
            );
            assert_eq!(
                MusicalKey::parse(&k.open_key()),
                Some(k),
                "open {}",
                k.open_key()
            );
            assert_eq!(
                MusicalKey::parse(k.musical()),
                Some(k),
                "musical {}",
                k.musical()
            );
            assert_eq!(
                MusicalKey::from_traktor_value(i64::from(k.traktor_value())),
                Some(k)
            );
            assert_eq!(
                MusicalKey::from_engine_value(i64::from(k.engine_value())),
                Some(k)
            );
        }
    }
}

#[test]
fn key_reference_points() {
    let am = MusicalKey::parse("Am").unwrap();
    assert_eq!(
        (
            am.camelot().as_str(),
            am.open_key().as_str(),
            am.traktor_value()
        ),
        ("8A", "1m", 21)
    );
    let c = MusicalKey::parse("C").unwrap();
    assert_eq!(
        (
            c.camelot().as_str(),
            c.open_key().as_str(),
            c.traktor_value()
        ),
        ("8B", "1d", 0)
    );
    assert_eq!(MusicalKey::parse("F# minor").unwrap().camelot(), "11A");
    assert_eq!(MusicalKey::parse("Db").unwrap().camelot(), "3B");
    assert_eq!(
        MusicalKey::parse("C#").unwrap(),
        MusicalKey::parse("Db").unwrap()
    );
    assert_eq!(MusicalKey::parse("12m").unwrap().musical(), "Dm");
    assert_eq!(MusicalKey::from_engine_value(1).unwrap().musical(), "Am");
    assert!(MusicalKey::parse("H").is_none());
    assert!(MusicalKey::parse("13A").is_none());
}

// ------------------------------------------------------------------ colours

#[test]
fn nearest_colour_mapping() {
    // rekordbox hot-cue green → Serato green, Traktor green
    let rb_green = Rgb::new(0x28, 0xE2, 0x14);
    assert_eq!(
        colour::map_cue_colour(rb_green, Platform::Serato),
        Rgb::new(0x44, 0xCC, 0x00)
    );
    assert_eq!(
        colour::map_cue_colour(rb_green, Platform::Traktor),
        Rgb::new(0, 0xFF, 0)
    );
    // exact palette colours map to themselves
    for c in colour::REKORDBOX_CUE {
        assert_eq!(colour::map_cue_colour(c, Platform::Rekordbox), c);
    }
    assert_eq!(colour::traktor_track_index(Rgb::new(0x10, 0x10, 0xF0)), 5);
    assert_eq!(
        colour::map_track_colour(Rgb::new(250, 5, 120), Platform::Rekordbox),
        Rgb::new(0xFF, 0, 0x7F)
    );
}

// ------------------------------------------------------------------ rekordbox XML

#[test]
fn rekordbox_xml_parses_tracks_cues_grids_playlists() {
    let col = rekordbox::parse(&read("rekordbox.xml")).unwrap();
    assert_eq!(col.tracks.len(), 3);
    let a = find(&col, "Alpha & Omega");
    assert_eq!(a.path, "C:/Music/DJ Ana/Alpha & Omega.mp3");
    assert_eq!(a.bpm, Some(122.0));
    assert_eq!(a.key.unwrap().camelot(), "8A");
    assert_eq!(a.rating, Some(4));
    assert_eq!(a.colour, Some(Rgb::new(0xFF, 0x00, 0x7F)));
    assert_eq!(
        a.added_at
            .map(decks_library::util::format_date_iso)
            .as_deref(),
        Some("2024-03-15")
    );
    assert_eq!(a.cues.len(), 4);
    let mem = a.cues.iter().find(|c| c.kind == CueKind::Memory).unwrap();
    assert_eq!((mem.index, mem.start_sec, mem.colour), (None, 31.592, None));
    let lp = a.cues.iter().find(|c| c.kind == CueKind::Loop).unwrap();
    assert_eq!((lp.index, lp.end_sec), (Some(2), Some(102.88)));
    assert_eq!(lp.colour, Some(Rgb::new(48, 90, 255)));
    let b = find(&col, "Bassline Theory");
    let g = b.grid.as_ref().unwrap();
    assert_eq!(
        (g.bpm, g.first_beat_sec, g.downbeat_offset),
        (126.0, 0.05, 2)
    );
    assert_eq!(g.anchors.len(), 1);
    assert_eq!(col.playlists.len(), 2);
    assert_eq!(col.playlists[0].name, "Friday Warmup");
    assert_eq!(col.playlists[0].folder, vec!["Gigs".to_owned()]);
    assert_eq!(
        col.playlists[0].tracks,
        vec![
            "C:/Music/Mira/Calm Waters.wav",
            "C:/Music/DJ Ana/Alpha & Omega.mp3",
            "C:/Music/Kopr/Bassline Theory.flac"
        ]
    );
}

#[test]
fn rekordbox_xml_round_trips_losslessly() {
    let col = rekordbox::parse(&read("rekordbox.xml")).unwrap();
    let again = rekordbox::parse(&rekordbox::to_xml(&col)).unwrap();
    assert_eq!(again.playlists, col.playlists);
    for t in &col.tracks {
        let u = again.track_by_path(&t.path).unwrap();
        assert_eq!(
            (u.title.clone(), u.bpm, u.key, u.colour, u.rating),
            (t.title.clone(), t.bpm, t.key, t.colour, t.rating)
        );
        assert_eq!(u.cues, t.cues);
        assert_eq!(u.grid, t.grid);
    }
}

#[test]
fn rekordbox_location_encoding() {
    let p = "C:/Music/Șină & co #1.mp3";
    let loc = rekordbox::path_to_location(p);
    assert!(loc.starts_with("file://localhost/C:/Music/"));
    assert!(!loc.contains(' '));
    assert_eq!(rekordbox::location_to_path(&loc), p);
    assert_eq!(
        rekordbox::location_to_path("file://localhost/Users/x/a%20b.mp3"),
        "/Users/x/a b.mp3"
    );
}

// ------------------------------------------------------------------ Traktor NML

#[test]
fn traktor_nml_parses_entries_cue_types_keys() {
    let col = nml::parse(&read("traktor.nml")).unwrap();
    assert_eq!(col.tracks.len(), 2);
    let n = find(&col, "Night Drive");
    assert_eq!(n.path, "D:/Music/Lumen/Night Drive.mp3");
    assert_eq!(n.album.as_deref(), Some("Neon"));
    assert_eq!(n.key.unwrap().musical(), "Dm"); // MUSICAL_KEY 14
    assert_eq!(n.bitrate, Some(320));
    assert_eq!(n.rating, Some(5));
    assert_eq!(n.colour, Some(Rgb::new(0, 0, 0xFF))); // COLOR 5 = blue
    assert_eq!(n.play_count, 4);
    // TYPE 4 grid → beat grid, not a cue; 4 remaining cues
    let g = n.grid.as_ref().unwrap();
    assert!((g.first_beat_sec - 0.51225).abs() < 1e-9);
    assert_eq!(n.cues.len(), 4);
    assert_eq!(
        n.cues.iter().filter(|c| c.kind == CueKind::Memory).count(),
        1
    ); // TYPE 3 load
    let lp = n.cues.iter().find(|c| c.kind == CueKind::Loop).unwrap();
    assert_eq!((lp.start_sec, lp.index), (60.0, Some(2)));
    assert!((lp.end_sec.unwrap() - 64.8).abs() < 1e-9);
    assert_eq!(n.cues[0].label.as_deref(), Some("Start"));
    assert_eq!(col.playlists.len(), 1);
    assert_eq!(col.playlists[0].folder, vec!["Sets".to_owned()]);
    assert_eq!(
        col.playlists[0].tracks,
        vec![
            "D:/Music/Sol/Morning.flac",
            "D:/Music/Lumen/Night Drive.mp3"
        ]
    );
}

#[test]
fn traktor_location_helpers() {
    assert_eq!(
        nml::split_location("C:\\Music\\A\\b.mp3"),
        ("C:".into(), "/:Music/:A/:".into(), "b.mp3".into())
    );
    assert_eq!(nml::primary_key("C:/Music/A/b.mp3"), "C:/:Music/:A/:b.mp3");
    assert_eq!(
        nml::join_location("Macintosh HD", "/:Users/:x/:", "y.mp3"),
        "/Users/x/y.mp3"
    );
}

/// rekordbox XML → NML → import: bpm, cues (±1 ms), colours (exact via MIXAI_COLOR, nearest
/// for track colours), playlist order.
#[test]
fn round_trip_rekordbox_to_nml_preserves_performance_data() {
    let rb = rekordbox::parse(&read("rekordbox.xml")).unwrap();
    let back = nml::parse(&nml::to_nml(&rb)).unwrap();
    assert_eq!(back.tracks.len(), rb.tracks.len());
    for t in &rb.tracks {
        let u = back
            .track_by_path(&t.path)
            .unwrap_or_else(|| panic!("lost {}", t.path));
        assert_eq!(
            u.bpm,
            t.bpm.or(t.grid.as_ref().map(|g| g.bpm)),
            "bpm {}",
            t.path
        );
        assert_eq!(u.key, t.key);
        assert_eq!(u.cues.len(), t.cues.len(), "cue count {}", t.path);
        for (a, b) in t.cues.iter().zip(&u.cues) {
            assert_eq!(a.kind, b.kind);
            assert_eq!(a.index, b.index);
            assert!(
                (a.start_sec - b.start_sec).abs() <= 0.001,
                "pos {} vs {}",
                a.start_sec,
                b.start_sec
            );
            if let (Some(x), Some(y)) = (a.end_sec, b.end_sec) {
                assert!((x - y).abs() <= 0.001);
            }
            if let Some(c) = a.colour {
                assert_eq!(b.colour, Some(c), "cue colour");
            }
        }
        if let Some(c) = t.colour {
            assert_eq!(
                u.colour,
                Some(colour::map_track_colour(c, Platform::Traktor))
            );
        }
        if let Some(g) = &t.grid {
            let ug = u.grid.as_ref().unwrap();
            // NML grid markers sit on downbeats: same phase, ±1 ms.
            let beat = 60.0 / g.bpm;
            let phase = ((ug.first_beat_sec - g.first_beat_sec) / beat).rem_euclid(1.0);
            assert!(phase < 1e-6 || (1.0 - phase) < 1e-6, "grid phase");
            assert_eq!(ug.anchors.len(), g.anchors.len());
        }
    }
    let names: Vec<_> = back
        .playlists
        .iter()
        .map(|p| (p.folder.clone(), p.name.clone()))
        .collect();
    assert_eq!(
        names,
        vec![
            (vec!["Gigs".to_owned()], "Friday Warmup".to_owned()),
            (vec![], "Peak".to_owned())
        ]
    );
    for (a, b) in rb.playlists.iter().zip(&back.playlists) {
        assert_eq!(a.tracks, b.tracks, "playlist order {}", a.name);
    }
}

#[test]
fn nml_round_trip_through_itself() {
    let col = nml::parse(&read("traktor.nml")).unwrap();
    let again = nml::parse(&nml::to_nml(&col)).unwrap();
    assert_eq!(again.playlists, col.playlists);
    for t in &col.tracks {
        let u = again.track_by_path(&t.path).unwrap();
        assert_eq!(u.cues, t.cues);
        assert_eq!(
            (u.bpm, u.key, u.colour, u.rating),
            (t.bpm, t.key, t.colour, t.rating)
        );
    }
}

// ------------------------------------------------------------------ Serato

#[test]
fn serato_crate_reads_synthetic_fixture() {
    let buf = std::fs::read(fixture("sample.crate")).unwrap();
    let c = serato::parse_crate(&buf).unwrap();
    assert_eq!(c.version, serato::CRATE_VERSION);
    assert_eq!(
        c.tracks,
        vec!["Music/Kopr/Bassline Theory.flac", "Music/Ăsta e/Șină.mp3"]
    );
}

#[test]
fn serato_crate_write_read_round_trip() {
    let paths = vec!["\\Music\\a b.mp3".to_owned(), "Music//c.flac".into()];
    let c = serato::parse_crate(&serato::build_crate(&paths)).unwrap();
    assert_eq!(c.tracks, vec!["Music/a b.mp3", "Music/c.flac"]);
    assert!(serato::parse_crate(b"vrsn\x00\x00\x00\x10").is_err());
}

#[test]
fn serato_crates_dir_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let col = Collection {
        tracks: vec![],
        playlists: vec![decks_library::Playlist {
            name: "Peak".into(),
            folder: vec!["Gigs".into()],
            tracks: vec![format!("{}/Music/x.mp3", root.display())],
        }],
    };
    let fmt = interop::SeratoCrates {
        volume_root: root.to_path_buf(),
    };
    fmt.write(&col, &root.join("_Serato_")).unwrap();
    assert!(root.join("_Serato_/Subcrates/Gigs%%Peak.crate").is_file());
    let back = fmt.read(&root.join("_Serato_")).unwrap();
    assert_eq!(back.playlists[0].name, "Peak");
    assert_eq!(back.playlists[0].folder, vec!["Gigs".to_owned()]);
    assert_eq!(
        decks_library::util::path_key(&back.playlists[0].tracks[0]),
        decks_library::util::path_key(&format!("{}/Music/x.mp3", root.display()))
    );
}

#[test]
fn serato_markers2_round_trip_and_geob_scan() {
    let m = serato::Markers2 {
        track_colour: Some(Rgb::new(0xFF, 0x99, 0xFF)),
        bpm_lock: Some(true),
        cues: vec![
            Cue {
                kind: CueKind::Hot,
                index: Some(0),
                start_sec: 1.234,
                end_sec: None,
                colour: Some(Rgb::new(0xCC, 0, 0)),
                label: Some("Intro".into()),
            },
            Cue {
                kind: CueKind::Hot,
                index: Some(3),
                start_sec: 90.0,
                end_sec: None,
                colour: Some(Rgb::new(0, 0xCC, 0)),
                label: None,
            },
            Cue {
                kind: CueKind::Loop,
                index: Some(0),
                start_sec: 30.5,
                end_sec: Some(38.5),
                colour: Some(Rgb::new(0x27, 0xAA, 0xE1)),
                label: Some("L".into()),
            },
        ],
        unknown: vec![("FLIP".into(), vec![0, 1, 2])],
    };
    let payload = serato::encode_markers2(&m);
    assert_eq!(&payload[..2], &[1, 1]);
    assert!(payload.len() >= 470);
    let back = serato::parse_markers2(&payload).unwrap();
    assert_eq!(back, m);

    // Wrap it in a minimal ID3v2.4 tag with a GEOB frame and find it again.
    let mut body = vec![0u8]; // ISO-8859-1
    body.extend_from_slice(b"application/octet-stream\0\0Serato Markers2\0");
    body.extend_from_slice(&payload);
    let syncsafe = |n: usize| {
        [
            ((n >> 21) & 0x7F) as u8,
            ((n >> 14) & 0x7F) as u8,
            ((n >> 7) & 0x7F) as u8,
            (n & 0x7F) as u8,
        ]
    };
    let mut frame = b"GEOB".to_vec();
    frame.extend_from_slice(&syncsafe(body.len()));
    frame.extend_from_slice(&[0, 0]);
    frame.extend_from_slice(&body);
    let mut tag = b"ID3\x04\x00\x00".to_vec();
    tag.extend_from_slice(&syncsafe(frame.len()));
    tag.extend_from_slice(&frame);
    let found = serato::find_geob(&tag, "Serato Markers2").unwrap();
    assert_eq!(serato::parse_markers2(&found).unwrap(), m);

    let tmp = tempfile::tempdir().unwrap();
    let mp3 = tmp.path().join("t.mp3");
    std::fs::write(&mp3, [tag.as_slice(), &[0xFF, 0xFB, 0x90, 0x00]].concat()).unwrap();
    assert_eq!(serato::read_markers2_from_file(&mp3).unwrap(), Some(m));
}

// ------------------------------------------------------------------ Engine DJ

fn be_label(out: &mut Vec<u8>, s: &str) {
    out.push(s.len() as u8);
    out.extend_from_slice(s.as_bytes());
}

/// Builds a tiny Engine DJ 2.x database the way Engine writes it.
pub fn make_engine_db(dir: &Path) -> PathBuf {
    let db_dir = dir.join("Engine Library/Database2");
    std::fs::create_dir_all(&db_dir).unwrap();
    let path = db_dir.join("m.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE Information (id INTEGER PRIMARY KEY, uuid TEXT, schemaVersionMajor INTEGER, schemaVersionMinor INTEGER, schemaVersionPatch INTEGER);
         INSERT INTO Information VALUES (1, 'u', 2, 21, 0);
         CREATE TABLE Track (id INTEGER PRIMARY KEY, playOrder INTEGER, length INTEGER, bpm INTEGER, year INTEGER, path TEXT,
            filename TEXT, bitrate INTEGER, bpmAnalyzed REAL, albumArtId INTEGER, fileBytes INTEGER, title TEXT, artist TEXT,
            album TEXT, genre TEXT, comment TEXT, label TEXT, composer TEXT, remixer TEXT, key INTEGER, rating INTEGER,
            albumArt TEXT, timeLastPlayed INTEGER, isPlayed BOOLEAN, fileType TEXT, isAnalyzed BOOLEAN, dateCreated INTEGER,
            dateAdded INTEGER, isAvailable BOOLEAN);
         CREATE TABLE PerformanceData (trackId INTEGER PRIMARY KEY, trackData BLOB, overviewWaveFormData BLOB, beatData BLOB,
            quickCues BLOB, loops BLOB, thirdPartySourceId INTEGER, activeOnLoadLoops INTEGER);
         CREATE TABLE Playlist (id INTEGER PRIMARY KEY, title TEXT, parentListId INTEGER, isPersisted BOOLEAN, nextListId INTEGER,
            lastEditTime DATETIME, isExplicitlyExported BOOLEAN);
         CREATE TABLE PlaylistEntity (id INTEGER PRIMARY KEY, listId INTEGER, trackId INTEGER, databaseUuid TEXT,
            nextEntityId INTEGER, membershipReference INTEGER);",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO Track (id, length, bpm, year, path, filename, bitrate, bpmAnalyzed, title, artist, album, genre, key, rating, dateAdded)
         VALUES (1, 300, 128, 2022, '../Music/One.mp3', 'One.mp3', 320, 128.0, 'One', 'Ari', 'Alb', 'Techno', 1, 80, 1700000000),
                (2, 200, 100, 0, '../Music/Two.mp3', 'Two.mp3', 256, 100.0, 'Two', 'Bo', NULL, NULL, 0, 0, 1700000100)",
        [],
    )
    .unwrap();
    let sr = 44_100.0f64;
    let mut td = Vec::new();
    td.extend_from_slice(&sr.to_be_bytes());
    td.extend_from_slice(&((300.0 * sr) as i64).to_be_bytes());
    td.extend_from_slice(&0.0f64.to_be_bytes());
    td.extend_from_slice(&1i32.to_be_bytes());
    // grid: beat 0 (a downbeat) at 0.1 s, beat 640 later — a constant 128 BPM grid.
    let beat = 60.0 / 128.0;
    let mut bd = Vec::new();
    bd.extend_from_slice(&sr.to_be_bytes());
    bd.extend_from_slice(&(300.0 * sr).to_be_bytes());
    bd.push(1);
    for _ in 0..2 {
        bd.extend_from_slice(&2i64.to_be_bytes());
        for (sec, n) in [(0.1, 0i64), (0.1 + 640.0 * beat, 640)] {
            bd.extend_from_slice(&(sec * sr).to_be_bytes());
            bd.extend_from_slice(&n.to_be_bytes());
            bd.extend_from_slice(&640i32.to_be_bytes());
            bd.extend_from_slice(&0i32.to_be_bytes());
        }
    }
    let mut qc = 8i64.to_be_bytes().to_vec();
    for i in 0..8 {
        if i == 0 {
            be_label(&mut qc, "Drop");
            qc.extend_from_slice(&(32.0 * sr).to_be_bytes());
            qc.extend_from_slice(&[0xFF, 0xEA, 0x00, 0x25]);
        } else {
            be_label(&mut qc, "");
            qc.extend_from_slice(&(-1.0f64).to_be_bytes());
            qc.extend_from_slice(&[0, 0, 0, 0]);
        }
    }
    qc.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0]); // adjusted main cue + flags (ignored)
    let mut lp = 1i64.to_be_bytes().to_vec();
    be_label(&mut lp, "Roll");
    lp.extend_from_slice(&(60.0 * sr).to_be_bytes());
    lp.extend_from_slice(&(64.0 * sr).to_be_bytes());
    lp.extend_from_slice(&[1, 1, 0xFF, 0x00, 0x80, 0xFF]);
    conn.execute(
        "INSERT INTO PerformanceData (trackId, trackData, beatData, quickCues, loops) VALUES (1, ?1, ?2, ?3, ?4)",
        rusqlite::params![engine::q_compress(&td), engine::q_compress(&bd), engine::q_compress(&qc), engine::q_compress(&lp)],
    )
    .unwrap();
    conn.execute_batch(
        "INSERT INTO Playlist VALUES (1, 'Folder', 0, 1, 3, NULL, 0);
         INSERT INTO Playlist VALUES (2, 'Inner', 1, 1, 0, NULL, 0);
         INSERT INTO Playlist VALUES (3, 'Top', 0, 1, 0, NULL, 0);
         INSERT INTO PlaylistEntity VALUES (10, 2, 2, 'u', 11, 0);
         INSERT INTO PlaylistEntity VALUES (11, 2, 1, 'u', 0, 0);
         INSERT INTO PlaylistEntity VALUES (12, 3, 1, 'u', 0, 0);",
    )
    .unwrap();
    path
}

#[test]
fn engine_dj_reads_tracks_performance_and_playlists() {
    let tmp = tempfile::tempdir().unwrap();
    let db = make_engine_db(tmp.path());
    let col = interop::EngineDj.read(&db).unwrap();
    assert!(!interop::EngineDj.can_write());
    assert_eq!(col.tracks.len(), 2);
    let one = find(&col, "One");
    assert!(
        decks_library::util::path_key(&one.path).ends_with("/music/one.mp3"),
        "{}",
        one.path
    );
    assert!(!one.path.contains(".."));
    assert_eq!(one.bpm, Some(128.0));
    assert_eq!(one.key.unwrap().musical(), "Am");
    assert_eq!(one.rating, Some(4));
    assert_eq!(one.sample_rate, Some(44_100));
    let g = one.grid.as_ref().unwrap();
    assert!((g.bpm - 128.0).abs() < 1e-6);
    assert!((g.first_beat_sec - 0.1).abs() < 1e-6);
    assert_eq!(g.downbeat_offset, 0);
    assert_eq!(one.cues.len(), 2);
    let hot = &one.cues[0];
    assert_eq!(
        (hot.kind, hot.index, hot.label.as_deref()),
        (CueKind::Hot, Some(0), Some("Drop"))
    );
    assert!((hot.start_sec - 32.0).abs() < 1e-9);
    assert_eq!(hot.colour, Some(Rgb::new(0xEA, 0x00, 0x25)));
    let lp = &one.cues[1];
    assert_eq!((lp.kind, lp.end_sec), (CueKind::Loop, Some(64.0)));
    assert_eq!(
        col.playlists.len(),
        2,
        "folder container must not be a playlist"
    );
    assert_eq!(col.playlists[0].name, "Inner");
    assert_eq!(col.playlists[0].folder, vec!["Folder".to_owned()]);
    let inner: Vec<_> = col.playlists[0]
        .tracks
        .iter()
        .map(|p| p.rsplit('/').next().unwrap().to_owned())
        .collect();
    assert_eq!(inner, vec!["Two.mp3", "One.mp3"]);
    assert_eq!(col.playlists[1].name, "Top");
}

// ------------------------------------------------------------------ rekordbox PDB

fn short_str(s: &str) -> Vec<u8> {
    let mut v = vec![(((s.len() + 1) << 1) | 1) as u8];
    v.extend_from_slice(s.as_bytes());
    v
}

#[test]
fn pdb_reads_synthetic_track_page() {
    const PS: usize = 4096;
    let mut file = vec![0u8; PS * 2];
    file[4..8].copy_from_slice(&(PS as u32).to_le_bytes());
    file[8..12].copy_from_slice(&1u32.to_le_bytes()); // one table
    file[12..16].copy_from_slice(&2u32.to_le_bytes());
    // table 0: tracks, first = last = page 1
    file[0x1C..0x20].copy_from_slice(&0u32.to_le_bytes());
    file[0x24..0x28].copy_from_slice(&1u32.to_le_bytes());
    file[0x28..0x2C].copy_from_slice(&1u32.to_le_bytes());
    let page = &mut file[PS..];
    page[4..8].copy_from_slice(&1u32.to_le_bytes());
    page[0x0C..0x10].copy_from_slice(&99u32.to_le_bytes());
    page[0x18] = 1; // one row
    page[0x1B] = 0x24;
    // row at heap offset 0
    let mut row = vec![0u8; 0x5E + 42];
    row[0x08..0x0C].copy_from_slice(&44_100u32.to_le_bytes());
    row[0x30..0x34].copy_from_slice(&320u32.to_le_bytes());
    row[0x38..0x3C].copy_from_slice(&12_850u32.to_le_bytes());
    row[0x48..0x4C].copy_from_slice(&7u32.to_le_bytes());
    row[0x54..0x56].copy_from_slice(&215u16.to_le_bytes());
    row[0x58] = 2; // red
    let mut strings = Vec::new();
    for i in 0..21 {
        let off = (row.len() + strings.len()) as u16;
        row[0x5E + 2 * i..0x60 + 2 * i].copy_from_slice(&off.to_le_bytes());
        strings.extend(short_str(match i {
            17 => "Synthetic",
            20 => "/Contents/A/b.mp3",
            10 => "2024-01-02",
            _ => "",
        }));
    }
    row.extend(strings);
    page[0x28..0x28 + row.len()].copy_from_slice(&row);
    page[PS - 4..PS - 2].copy_from_slice(&1u16.to_le_bytes()); // presence bit 0
    page[PS - 6..PS - 4].copy_from_slice(&0u16.to_le_bytes()); // row 0 offset
    let col = pdb::parse(&file, Path::new("E:/")).unwrap();
    assert_eq!(col.tracks.len(), 1);
    let t = &col.tracks[0];
    assert_eq!(t.title.as_deref(), Some("Synthetic"));
    assert_eq!(t.bpm, Some(128.5));
    assert_eq!(t.duration_sec, Some(215.0));
    assert_eq!(t.colour, Some(Rgb::new(0xFF, 0, 0)));
    assert_eq!(
        decks_library::util::path_key(&t.path),
        "e:/contents/a/b.mp3"
    );
    assert!(t.added_at.is_some());
    assert!(pdb::parse(&[1, 0, 0, 0], Path::new("/")).is_err());
}

// ------------------------------------------------------------------ JSON + OneLibrary

#[test]
fn neutral_json_is_lossless() {
    let col = rekordbox::parse(&read("rekordbox.xml")).unwrap();
    assert_eq!(json::parse(&json::to_json(&col).unwrap()).unwrap(), col);
    assert!(
        json::parse(
            "{\"format\":\"x\",\"version\":1,\"collection\":{\"tracks\":[],\"playlists\":[]}}"
        )
        .is_err()
    );
}

#[test]
fn onelibrary_slot_reports_pending_spec() {
    let err = interop::OneLibrary
        .read(Path::new("x"))
        .unwrap_err()
        .to_string();
    assert!(err.contains("pending"), "{err}");
    assert!(!interop::OneLibrary.can_write());
}
