//! Flexible beatgrid + encoder-drift over FFI (WP19-37): the calls Swift / Kotlin make.

use decks_ffi::*;

/// One MPEG-1 Layer III frame (44.1 kHz, 128 kbps, stereo) carrying an `Info` tag whose encoder
/// string is `Lavc…` — the "case B" file every decoder disagrees about.
fn lavc_mp3() -> Vec<u8> {
    let mut f = vec![0u8; 417];
    f[0] = 0xFF;
    f[1] = 0xFB;
    f[2] = 0x90;
    f[3] = 0x00;
    f[36..40].copy_from_slice(b"Info");
    f[40..44].copy_from_slice(&0x0000_000Fu32.to_be_bytes());
    f[156..165].copy_from_slice(b"Lavc58.54");
    f
}

fn library_with_grid(grid: LibraryGrid) -> (std::sync::Arc<DecksLibrary>, String) {
    let lib = DecksLibrary::open_in_memory().expect("library");
    let id = lib
        .upsert_track(LibraryTrack {
            path: "C:/music/track.mp3".into(),
            title: Some("Track".into()),
            grid: Some(grid),
            ..LibraryTrack::default()
        })
        .expect("upsert");
    (lib, id)
}

fn grid(anchors: Vec<LibraryGridAnchor>, fixed: bool) -> LibraryGrid {
    LibraryGrid {
        bpm: 120.0,
        first_beat_sec: 0.5,
        downbeat_offset: 0,
        anchors,
        fixed,
    }
}

#[test]
fn markers_round_trip_through_the_library() {
    let (lib, id) = library_with_grid(grid(
        vec![
            LibraryGridAnchor {
                sec: 16.5,
                bpm: 128.0,
            },
            LibraryGridAnchor {
                sec: 31.5,
                bpm: 124.0,
            },
        ],
        false,
    ));
    let s = track_grid(&lib, id.clone()).expect("grid");
    assert_eq!(s.track_id, id);
    assert!((s.bpm - 120.0).abs() < 1e-9 && (s.first_beat_sec - 0.5).abs() < 1e-9);
    assert!(!s.fixed);
    assert_eq!(s.markers.len(), 2);
    assert!((s.markers[0].sec - 16.5).abs() < 1e-9 && (s.markers[0].bpm - 128.0).abs() < 1e-9);
    assert_eq!(s.markers[0].beat, 32);
    assert_eq!(track_grid_markers(&lib, id).expect("markers"), s.markers);
}

#[test]
fn adding_moving_and_removing_markers_persists() {
    let (lib, id) = library_with_grid(grid(Vec::new(), false));
    assert!(
        track_grid(&lib, id.clone())
            .expect("grid")
            .markers
            .is_empty()
    );

    let s = grid_add_marker(&lib, id.clone(), 16.5, 128.0).expect("add");
    assert_eq!(s.markers.len(), 1);
    // Persisted: a fresh read sees it.
    assert_eq!(
        track_grid(&lib, id.clone()).expect("grid").markers,
        s.markers
    );

    // A second marker with the same tempo is merged away (nothing changes there).
    let s = grid_add_marker(&lib, id.clone(), 24.0, 128.0).expect("add same");
    assert_eq!(s.markers.len(), 1, "{:?}", s.markers);

    let s = grid_move_marker(&lib, id.clone(), 16.5, 17.0, Some(126.0), 0.5).expect("move");
    assert!((s.markers[0].sec - 17.0).abs() < 1e-9 && (s.markers[0].bpm - 126.0).abs() < 1e-9);

    // A marker at (or before) the first beat becomes the starting tempo.
    let s = grid_add_marker(&lib, id.clone(), 0.2, 122.0).expect("add at start");
    assert!((s.bpm - 122.0).abs() < 1e-9);

    let s = grid_remove_marker(&lib, id.clone(), 17.0, 0.5).expect("remove");
    assert!(s.markers.is_empty());
    assert!(
        grid_remove_marker(&lib, id.clone(), 17.0, 0.5).is_err(),
        "nothing left"
    );
    assert!(matches!(
        grid_move_marker(&lib, id, 99.0, 1.0, None, 0.1),
        Err(DecksError::NotFound { .. })
    ));
}

#[test]
fn bad_arguments_are_rejected() {
    let (lib, id) = library_with_grid(grid(Vec::new(), false));
    assert!(matches!(
        grid_add_marker(&lib, id.clone(), 10.0, 0.0),
        Err(DecksError::InvalidArgument { .. })
    ));
    assert!(matches!(
        grid_add_marker(&lib, id.clone(), f64::NAN, 128.0),
        Err(DecksError::InvalidArgument { .. })
    ));
    assert!(matches!(
        grid_set_base(&lib, id, 1000.0, 0.0, 0),
        Err(DecksError::InvalidArgument { .. })
    ));
    let empty = DecksLibrary::open_in_memory().expect("library");
    assert!(matches!(
        track_grid(&empty, "nope".into()),
        Err(DecksError::NotFound { .. })
    ));
}

#[test]
fn the_fixed_toggle_keeps_the_markers_and_flattens_the_grid() {
    let (lib, id) = library_with_grid(grid(
        vec![LibraryGridAnchor {
            sec: 16.5,
            bpm: 128.0,
        }],
        false,
    ));
    let on = grid_set_fixed(&lib, id.clone(), true).expect("fix");
    assert!(on.fixed);
    assert_eq!(on.markers.len(), 1, "markers are kept");
    // The deck grid still carries the anchors (so the toggle is reversible there), but `fixed`
    // tells the engine to play the constant grid.
    let info = on.to_beatgrid_info();
    assert!(info.fixed && info.is_variable && info.anchors.len() == 2);

    let off = grid_set_fixed(&lib, id, false).expect("unfix");
    assert!(!off.fixed);
    let info = off.to_beatgrid_info();
    assert!(!info.fixed && info.is_variable && info.anchors.len() == 2);
}

#[test]
fn a_grid_applies_to_a_deck_and_comes_back() {
    let (lib, id) = library_with_grid(grid(
        vec![LibraryGridAnchor {
            sec: 16.5,
            bpm: 128.0,
        }],
        false,
    ));
    let s = track_grid(&lib, id).expect("grid");
    let e = std::sync::Arc::new(DecksEngine::new(DecksEngineConfig::default()));
    grid_apply_to_deck(e.clone(), 0, s.clone()).expect("apply");
    assert!(
        grid_apply_to_deck(e.clone(), 9, s.clone()).is_err(),
        "deck 9 rejected"
    );

    let back = deck_grid(e.clone(), 0).expect("deck grid");
    assert!((back.bpm - s.bpm).abs() < 1e-9);
    assert!((back.first_beat_sec - s.first_beat_sec).abs() < 1e-9);
    assert_eq!(back.markers.len(), 1);
    assert!((back.markers[0].sec - 16.5).abs() < 1e-6);
    assert!((back.markers[0].bpm - 128.0).abs() < 1e-6);

    // A fixed grid reaches the deck as a constant one.
    let mut fixed = s;
    fixed.fixed = true;
    grid_apply_to_deck(e.clone(), 0, fixed).expect("apply fixed");
    let back = deck_grid(e.clone(), 0).expect("deck grid");
    assert!(back.fixed, "the toggle survives the round trip");
    assert_eq!(back.markers.len(), 1, "markers are kept while fixed");

    assert!(matches!(deck_grid(e, 1), Err(DecksError::NotFound { .. })));
}

/// P1-7: an analysed variable grid carries its AVERAGE tempo in `bpm` (here 125.3), which
/// differs from the first section (120). Reading it back from the deck (what
/// `grid_apply_to_deck` then persists) must start at the first section's tempo, or every later
/// marker lands on a wrong beat.
#[test]
fn a_variable_deck_grid_comes_back_with_its_first_section_tempo() {
    let e = std::sync::Arc::new(DecksEngine::new(DecksEngineConfig::default()));
    let info = BeatGridInfo {
        bpm: 125.3, // average, NOT the first section
        confidence: 0.9,
        first_beat_sec: 0.5,
        downbeat_offset_beats: 0,
        downbeat_confidence: 0.9,
        is_variable: true,
        anchors: vec![
            TempoAnchorInfo {
                beat_index: 0,
                time_sec: 0.5,
                bpm: 120.0,
            },
            TempoAnchorInfo {
                beat_index: 32,
                time_sec: 16.5,
                bpm: 128.0,
            },
            TempoAnchorInfo {
                beat_index: 96,
                time_sec: 46.5,
                bpm: 124.0,
            },
        ],
        beats: Vec::new(),
        fixed: false,
    };
    assert!((info.bpm - info.anchors[0].bpm).abs() > 1.0, "test premise");
    e.set_beatgrid(0, info).expect("set");
    let back = deck_grid(e.clone(), 0).expect("deck grid");
    assert!(
        (back.bpm - 120.0).abs() < 1e-9,
        "starts at 120, got {}",
        back.bpm
    );
    assert_eq!(back.markers.len(), 2, "{:?}", back.markers);
    assert_eq!(back.markers[0].beat, 32, "{:?}", back.markers);
    assert_eq!(back.markers[1].beat, 96, "{:?}", back.markers);

    // And it survives the persist path: apply the read-back grid and read it again.
    grid_apply_to_deck(e.clone(), 0, back.clone()).expect("apply");
    let again = deck_grid(e, 0).expect("deck grid");
    assert_eq!(again.markers, back.markers);
    assert!((again.bpm - 120.0).abs() < 1e-9);
}

/// P1-9: every entry path rejects an out-of-range marker / anchor tempo or a bad time with
/// `InvalidArgument` instead of dropping it (a 1e-300 / 1e308 tempo made `beat_at` NaN on the
/// audio thread).
#[test]
fn every_grid_entry_path_range_checks_markers_and_anchors() {
    let bad_bpms = [1e-300, 1e308, 0.0, -120.0, 19.99, 400.01, f64::NAN];
    let bad_secs = [-0.001, f64::NAN, f64::INFINITY];
    let invalid =
        |r: Result<GridState, DecksError>| matches!(r, Err(DecksError::InvalidArgument { .. }));

    // Library editing.
    let (lib, id) = library_with_grid(grid(
        vec![LibraryGridAnchor {
            sec: 16.5,
            bpm: 128.0,
        }],
        false,
    ));
    for b in bad_bpms {
        assert!(
            invalid(grid_add_marker(&lib, id.clone(), 10.0, b)),
            "add bpm {b}"
        );
        assert!(
            invalid(grid_move_marker(&lib, id.clone(), 16.5, 17.0, Some(b), 0.5)),
            "move bpm {b}"
        );
        assert!(
            invalid(grid_set_base(&lib, id.clone(), b, 0.5, 0)),
            "base bpm {b}"
        );
    }
    for s in bad_secs {
        assert!(
            invalid(grid_add_marker(&lib, id.clone(), s, 128.0)),
            "add sec {s}"
        );
        assert!(
            invalid(grid_move_marker(&lib, id.clone(), 16.5, s, None, 0.5)),
            "move sec {s}"
        );
        assert!(
            invalid(grid_set_base(&lib, id.clone(), 120.0, s, 0)),
            "base sec {s}"
        );
    }
    // Nothing was persisted by the rejected calls.
    let s = track_grid(&lib, id).expect("grid");
    assert_eq!(s.markers.len(), 1);
    assert!((s.markers[0].bpm - 128.0).abs() < 1e-9 && (s.bpm - 120.0).abs() < 1e-9);

    // grid_apply_to_deck: the foreign side builds GridState, so every marker is checked.
    // The error names the GridState field (`markers[i]`), proving this path checks it itself
    // and does not merely rely on `set_beatgrid`'s anchor check behind it.
    let e = std::sync::Arc::new(DecksEngine::new(DecksEngineConfig::default()));
    let names_marker = |r: Result<(), DecksError>| matches!(r, Err(DecksError::InvalidArgument { reason }) if reason.contains("markers[0]"));
    for b in bad_bpms {
        let mut g = s.clone();
        g.markers[0].bpm = b;
        assert!(
            names_marker(grid_apply_to_deck(e.clone(), 0, g)),
            "apply marker bpm {b}"
        );
    }
    for t in bad_secs {
        let mut g = s.clone();
        g.markers[0].sec = t;
        assert!(
            names_marker(grid_apply_to_deck(e.clone(), 0, g)),
            "apply marker sec {t}"
        );
    }

    // DecksEngine.set_beatgrid: base bpm (incl. <= 0) and every anchor.
    let good = s.to_beatgrid_info();
    e.set_beatgrid(0, good.clone()).expect("valid grid");
    for b in bad_bpms {
        let mut g = good.clone();
        g.bpm = b;
        assert!(
            matches!(
                e.set_beatgrid(0, g),
                Err(DecksError::InvalidArgument { .. })
            ),
            "set bpm {b}"
        );
        let mut g = good.clone();
        g.anchors[1].bpm = b;
        assert!(
            matches!(
                e.set_beatgrid(0, g),
                Err(DecksError::InvalidArgument { .. })
            ),
            "set anchor bpm {b}"
        );
    }
    for t in bad_secs {
        let mut g = good.clone();
        g.anchors[1].time_sec = t;
        assert!(
            matches!(
                e.set_beatgrid(0, g),
                Err(DecksError::InvalidArgument { .. })
            ),
            "set anchor sec {t}"
        );
        let mut g = good.clone();
        g.first_beat_sec = t;
        assert!(
            matches!(
                e.set_beatgrid(0, g),
                Err(DecksError::InvalidArgument { .. })
            ),
            "set first beat {t}"
        );
    }
    // The rejected calls left the deck's valid grid in place.
    assert_eq!(e.beatgrid(0).expect("deck").expect("grid"), good);
}

#[test]
fn drift_check_reports_the_mp3_case_and_shift() {
    let dir = tempfile::tempdir().expect("tmp");
    let mp3 = dir.path().join("lavc.mp3");
    std::fs::write(&mp3, lavc_mp3()).expect("write");
    let path = mp3.display().to_string();

    let r = drift_check(path.clone(), DriftSource::Traktor);
    assert!(r.analysed && r.mp3_case == "B", "{r:?}");
    assert!((r.shift_sec + 0.026_122).abs() < 1e-5, "{r:?}");
    assert_eq!(r.encoder, "Lavc58.54");
    assert!(r.reason.contains("traktor"), "{}", r.reason);

    // Apps without a confirmed measurement never move anything.
    for src in [
        DriftSource::Rekordbox,
        DriftSource::Serato,
        DriftSource::EngineDj,
        DriftSource::MixAi,
        DriftSource::Unknown,
    ] {
        let r = drift_check(path.clone(), src);
        assert_eq!(r.shift_sec, 0.0, "{src:?}: {r:?}");
    }

    // Non-MP3 / missing files are reported, not an error.
    let r = drift_check(
        dir.path().join("x.flac").display().to_string(),
        DriftSource::Traktor,
    );
    assert!(!r.analysed && r.shift_sec == 0.0 && r.mp3_case.is_empty());
}
