//! End-to-end tests through the FFI types (the same calls Swift / Kotlin make).

use std::f64::consts::TAU;
use std::path::Path;
use std::time::{Duration, Instant};

use decks_ffi::*;

const SR: u32 = 44_100;

/// Stereo 16-bit WAV: a 440 Hz sine bed plus 120 BPM clicks (so tempo analysis has a pulse).
fn write_test_wav(path: &Path, secs: f64) {
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: SR,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).expect("wav");
    let frames = (secs * f64::from(SR)) as usize;
    let beat = 0.5; // 120 BPM
    let mut rng = 0x2545_F491_4F6C_DD1Du64;
    for i in 0..frames {
        let t = i as f64 / f64::from(SR);
        let mut v = 0.15 * (TAU * 440.0 * t).sin();
        let since = (t - 0.1).rem_euclid(beat);
        if t >= 0.1 && since < 0.02 {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            let noise = (rng >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0;
            v += 0.6 * noise * (-since / 0.004).exp();
        }
        if t >= 0.1 && since < 0.12 {
            v += 0.5 * (TAU * 60.0 * since).sin() * (-since / 0.04).exp();
        }
        let s = (v.clamp(-1.0, 1.0) * 32_000.0) as i16;
        w.write_sample(s).unwrap();
        w.write_sample(s).unwrap();
    }
    w.finalize().unwrap();
}

fn wait_load(e: &DecksEngine, ticket: u64) -> LoadStatus {
    let t0 = Instant::now();
    loop {
        let st = e.load_status(ticket).expect("ticket known");
        if !matches!(
            st.state,
            LoadState::Queued | LoadState::Decoding | LoadState::Analysing
        ) {
            return st;
        }
        assert!(t0.elapsed() < Duration::from_secs(60), "load timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn engine_snapshot_after_load_shows_bpm_and_duration() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("click-120.wav");
    write_test_wav(&wav, 12.0);

    let e = DecksEngine::new(DecksEngineConfig::default());
    assert!(
        e.load(7, wav.display().to_string()).is_err(),
        "deck 7 rejected"
    );
    // Loading works while stopped; audio goes to the engine on start().
    let ticket = e.load(0, wav.display().to_string()).unwrap();
    let st = wait_load(&e, ticket);
    assert_eq!(st.state, LoadState::Ready, "{:?}", st.error);

    let snap = e.snapshot();
    let d = &snap.decks[0];
    assert!(d.loaded && !d.loading);
    assert!(
        (d.duration_sec - 12.0).abs() < 0.01,
        "duration {}",
        d.duration_sec
    );
    let bpm = d.bpm.expect("bpm analysed");
    assert!((bpm - 120.0).abs() < 1.0, "bpm {bpm}");
    assert_eq!(snap.decks.len(), 4);
    assert!(!snap.decks[1].loaded);

    let peaks = e.peaks(0).unwrap().expect("peaks");
    assert_eq!(peaks.points_per_second, PEAKS_PER_SECOND);
    assert_eq!(peaks.low_max.len(), peaks.len as usize);
    assert!(peaks.len >= 12 * PEAKS_PER_SECOND - 1);
    let grid = e.beatgrid(0).unwrap().expect("grid");
    assert!((grid.bpm - bpm).abs() < 1e-9);
    assert!(
        (grid.first_beat_sec - 0.1).abs() < 0.03,
        "first beat {}",
        grid.first_beat_sec
    );

    // Snapshot is cheap enough for 120 Hz polling.
    let t0 = Instant::now();
    for _ in 0..1000 {
        std::hint::black_box(e.snapshot());
    }
    let per = t0.elapsed() / 1000;
    assert!(per < Duration::from_millis(1), "snapshot took {per:?}");

    // Live engine (skipped when the machine has no audio output, e.g. CI).
    match e.start() {
        Ok(info) => {
            assert!(info.sample_rate > 0);
            let s = e.snapshot();
            assert!(s.running && s.decks[0].loaded);
            e.set_tempo(0, 1.05).unwrap();
            e.set_key_shift(0, 2.0).unwrap();
            e.hot_cue_set(0, 0).unwrap();
            e.set_eq(0, EqBand::Low, -6.0).unwrap();
            e.set_crossfader(-1.0).unwrap();
            e.routing_set(Routing {
                mode: OutputModeKind::Stereo,
                cue_mix: 0.5,
                headphone_level: 0.8,
                split_mono: false,
                booth_level: 0.0,
                master_latency_ms: 0.0,
                headphone_latency_ms: 0.0,
                booth_latency_ms: 0.0,
            })
            .unwrap();
            assert_eq!(e.routing_get().unwrap().mode, OutputModeKind::Stereo);
            e.set_master_clock(MasterClockSource::InternalClock, Some(124.0))
                .unwrap();
            e.set_color_fx(0, ColorFx::Filter, 0.3).unwrap();
            e.set_beat_fx(0, BeatFx::Echo, 0.4, 0.5, 0.5).unwrap();
            assert!(e.hot_cue_set(0, 9).is_err());
            e.stop();
            assert!(!e.snapshot().running);
            assert!(matches!(e.play(0), Err(DecksError::NotRunning { .. })));
        }
        Err(err) => eprintln!("no audio output, live part skipped: {err}"),
    }
}

#[test]
fn slip_shadow_reported_while_slip_and_loop_active() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("click-120-slip.wav");
    write_test_wav(&wav, 12.0);
    let e = DecksEngine::new(DecksEngineConfig {
        sample_rate: Some(48_000),
        buffer_frames: Some(512),
        output_device_id: None,
    });
    // Trim works while stopped (stored, applied on start) and is reported in dB.
    e.set_gain(0, 6.0).unwrap();
    e.set_gain(1, f32::NEG_INFINITY).unwrap();
    assert!(e.set_gain(0, f32::NAN).is_err());
    let s = e.snapshot();
    assert_eq!(s.decks[0].gain_db, 6.0);
    assert_eq!(s.decks[1].gain_db, -96.0);
    assert!(s.decks[0].slip_shadow_sec.is_none());
    assert!(matches!(
        e.set_output_device(Some("nohost:missing".into())),
        Err(DecksError::NotFound { .. })
    ));

    let st = wait_load(&e, e.load(0, wav.display().to_string()).unwrap());
    assert_eq!(st.state, LoadState::Ready, "{:?}", st.error);
    let info = match e.start() {
        Ok(info) => info,
        Err(err) => {
            eprintln!("no audio output, live slip part skipped: {err}");
            return;
        }
    };
    assert!(info.sample_rate > 0 && info.channels > 0);
    // Notes appear only for genuine fallbacks.
    if info.sample_rate == 48_000 {
        assert!(
            info.notes.iter().all(|n| !n.contains("sample_rate")),
            "{:?}",
            info.notes
        );
    } else {
        assert!(!info.notes.is_empty(), "fallback must be noted");
    }
    e.seek(0, 2.0).unwrap();
    e.set_slip(0, true).unwrap();
    e.play(0).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    e.loop_auto(0, 1.0).unwrap();
    let t0 = Instant::now();
    let shadow = loop {
        let d = &e.snapshot().decks[0];
        if d.loop_active
            && let Some(sh) = d.slip_shadow_sec
            && sh > d.loop_end_sec
        {
            break sh;
        }
        assert!(t0.elapsed() < Duration::from_secs(5), "{d:?}");
        std::thread::sleep(Duration::from_millis(20));
    };
    let d = &e.snapshot().decks[0];
    assert!(d.slip && d.loop_active);
    assert!(d.playhead_sec <= d.loop_end_sec + 0.05, "{d:?}");
    assert!(shadow > 2.0);
    e.loop_exit(0).unwrap();
    // The snapshot is published from the audio callback; slow CI devices (macOS runners) need > 100 ms.
    let t1 = Instant::now();
    while e.snapshot().decks[0].slip_shadow_sec.is_some() {
        assert!(
            t1.elapsed() < Duration::from_secs(5),
            "{:?}",
            e.snapshot().decks[0]
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // Device switch to the current/default device keeps the decks.
    assert!(e.set_output_device(None).unwrap());
    let s = e.snapshot();
    assert!(s.running && s.decks[0].loaded && s.channels > 0);
    e.stop();
}

#[test]
fn library_roundtrip_via_ffi_types() {
    let dir = tempfile::tempdir().unwrap();
    let lib = DecksLibrary::open(dir.path().join("lib.db").display().to_string()).unwrap();
    assert!(lib.schema_version().unwrap() >= 1);

    let track = LibraryTrack {
        path: "C:/Music/Artist - Groove.mp3".into(),
        title: Some("Groove".into()),
        artist: Some("Artist".into()),
        genre: Some("House".into()),
        bpm: Some(124.0),
        key: Some("8A".into()),
        colour: Some(0x22D3EE),
        cues: vec![LibraryCue {
            kind: CueType::Hot,
            index: Some(0),
            start_sec: 1.5,
            end_sec: None,
            colour: Some(0xFF4FA3),
            label: Some("Drop".into()),
        }],
        grid: Some(LibraryGrid {
            bpm: 124.0,
            first_beat_sec: 0.12,
            downbeat_offset: 0,
            anchors: vec![],
        }),
        ..Default::default()
    };
    let id = lib.upsert_track(track.clone()).unwrap();
    let back = lib.track(id.clone()).unwrap().expect("stored");
    assert_eq!(back.title.as_deref(), Some("Groove"));
    assert_eq!(back.key.as_deref(), Some("8A"));
    assert_eq!(back.colour, Some(0x22D3EE));
    assert_eq!(back.cues.len(), 1);
    assert_eq!(back.cues[0].label.as_deref(), Some("Drop"));
    assert!((back.grid.as_ref().unwrap().first_beat_sec - 0.12).abs() < 1e-9);
    assert!(
        lib.upsert_track(LibraryTrack {
            key: Some("not a key".into()),
            ..track.clone()
        })
        .is_err()
    );

    assert_eq!(lib.search("groo".into(), 10).unwrap().len(), 1);
    assert_eq!(lib.search("nothing".into(), 10).unwrap().len(), 0);

    let folder = lib.create_crate("Sets".into(), None, true).unwrap();
    let c = lib
        .create_crate("Friday".into(), Some(folder), false)
        .unwrap();
    lib.add_to_crate(c, id.clone()).unwrap();
    lib.rename_crate(c, "Friday night".into()).unwrap();
    assert_eq!(lib.crate_tracks(c).unwrap().len(), 1);
    assert!(
        lib.crates()
            .unwrap()
            .iter()
            .any(|r| r.name == "Friday night")
    );
    assert!(lib.rename_crate(9999, "x".into()).is_err());

    let sc = lib
        .create_smart_crate(
            "Warm-up".into(),
            r#"{"all":[{"field":"bpm","op":"between","value":[120,126]}]}"#.into(),
        )
        .unwrap();
    assert_eq!(lib.evaluate_smart_crate(sc).unwrap().len(), 1);
    assert_eq!(lib.smart_crates().unwrap().len(), 1);
    assert!(lib.create_smart_crate("bad".into(), "{".into()).is_err());

    let session = lib.start_session(Some("Gig".into())).unwrap();
    lib.record_play(session, id.clone(), Some(0)).unwrap();
    lib.end_session(session).unwrap();
    assert_eq!(lib.session_entries(session).unwrap().len(), 1);
    assert!(lib.tracklist(session).unwrap().contains("Artist - Groove"));

    // Export → import into a fresh library (neutral JSON + rekordbox XML).
    let json = dir.path().join("export.json").display().to_string();
    lib.export_file(LibraryFormat::NeutralJson, json.clone())
        .unwrap();
    let xml = dir.path().join("export.xml").display().to_string();
    lib.export_file(LibraryFormat::RekordboxXml, xml.clone())
        .unwrap();
    assert!(
        lib.export_file(LibraryFormat::EngineDj, xml.clone())
            .is_err()
    );

    let other = DecksLibrary::open_in_memory().unwrap();
    assert_eq!(
        other.import_file(LibraryFormat::NeutralJson, json).unwrap(),
        1
    );
    let t = other.all_tracks().unwrap();
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].bpm, Some(124.0));
    assert_eq!(t[0].cues.len(), 1);
    assert!(
        other
            .crates()
            .unwrap()
            .iter()
            .any(|r| r.name == "Friday night")
    );

    let preview = other
        .read_collection(LibraryFormat::RekordboxXml, xml.clone())
        .unwrap();
    assert_eq!(preview.len(), 1);
    let report = DecksLibrary::open_in_memory()
        .unwrap()
        .migrate_from(LibraryFormat::RekordboxXml, xml)
        .unwrap();
    assert_eq!(report.tracks_seen, 1);
    assert!(matches!(
        other.migrate_from(LibraryFormat::OneLibrary, "x".into()),
        Err(DecksError::Unsupported { .. })
    ));

    // Background scan with progress polling.
    let music = dir.path().join("music");
    std::fs::create_dir(&music).unwrap();
    write_test_wav(&music.join("a.wav"), 1.0);
    let scan = lib.scan_folder(music.display().to_string()).unwrap();
    let t0 = Instant::now();
    let status = loop {
        let s = lib.scan_status(scan).unwrap();
        if s.state != ScanState::Running {
            break s;
        }
        assert!(t0.elapsed() < Duration::from_secs(30));
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(status.state, ScanState::Done, "{:?}", status.error);
    assert_eq!(status.added + status.updated, 1, "{:?}", status.failed);
    assert_eq!(lib.track_count().unwrap(), 2);
    assert!(lib.delete_crate(folder).unwrap());
}

#[test]
fn mapping_flx4_play_press_produces_play_pause_action() {
    assert!(
        mapping_builtin_profiles()
            .iter()
            .any(|p| p.id == "pioneer-ddj-flx4-rekordbox")
    );
    let m = DecksMapping::from_builtin("pioneer-ddj-flx4-rekordbox".into()).unwrap();
    // Deck 1 PLAY/PAUSE: note-on ch1 note 0x0B.
    let actions = m.on_midi("DDJ-FLX4".into(), vec![0x90, 0x0B, 0x7F], 42);
    assert_eq!(actions.len(), 1, "{actions:?}");
    let a = &actions[0];
    assert_eq!(a.group, "deck");
    assert_eq!(a.kind, "play_pause");
    assert_eq!(a.deck, Some(0));
    assert_eq!(a.timestamp_us, 42);
    assert_eq!(a.action_json, r#"{"deck":{"type":"play_pause","deck":0}}"#);
    // Deck 2 hot cue pad (ch 10, note 0x00) carries slot + pressed.
    let pad = m.on_midi("DDJ-FLX4".into(), vec![0x99, 0x00, 0x7F], 43);
    assert_eq!(pad[0].kind, "hot_cue");
    assert_eq!(
        (pad[0].deck, pad[0].slot, pad[0].pressed),
        (Some(1), Some(0), Some(true))
    );

    // Detection, JSON round-trip, feedback, learn, BLE.
    let d = DecksMapping::detect("DDJ-FLX4 MIDI 1".into(), None, None, None).unwrap();
    assert!(d.profile().id.starts_with("pioneer-ddj-flx4"));
    let again = DecksMapping::from_json(m.to_json()).unwrap();
    assert_eq!(again.profile().id, m.profile().id);
    assert!(DecksMapping::from_json("{}".into()).is_err());
    let out = m
        .feedback_all(vec![FeedbackItem {
            key_json: r#"{"type":"playing","deck":0}"#.into(),
            value: FeedbackLevel::On { on: true },
        }])
        .unwrap();
    assert!(!out.is_empty(), "play LED message");
    let idle = DecksEngine::new(DecksEngineConfig::default()).snapshot();
    let _ = m.feedback_from_snapshot(idle);
    m.start_learn(Some(r#"{"mixer":{"type":"crossfader"}}"#.into()))
        .unwrap();
    assert!(m.is_learning());
    assert!(
        m.on_midi("X".into(), vec![0xB5, 0x50, 0x40], 1_000)
            .is_empty()
    );
    let learned = m.poll_learn(2_000_000).expect("learned");
    assert_eq!(learned.channel, Some(6));
    assert!(m.accept_learned().unwrap());
    let ble = m.ble_decode(vec![0x80, 0x80, 0x90, 0x0B, 0x7F]).unwrap();
    assert_eq!(ble[0].bytes, vec![0x90, 0x0B, 0x7F]);
    assert!(m.ble_decode(vec![0x00]).is_err());
    assert!(!mapping_json_schema().is_empty());

    let clock = MidiClock::new(120.0);
    clock.start(0.0, 0.0);
    // 24 PPQN at 120 BPM = one tick per 20.833 ms; ticks at 0..=479.2 ms.
    let msgs = clock.tick(490_000.0);
    assert_eq!(msgs[0].bytes, vec![0xFA]);
    assert_eq!(msgs.iter().filter(|m| m.bytes == [0xF8]).count(), 24);
}

#[test]
fn dvs_decodes_generated_mixai_timecode() {
    let sr = 48_000;
    let dvs = DvsInput::new(DvsSettings {
        format: DvsFormat::MixAi,
        sample_rate: sr,
        mode: None,
        swap_channels: false,
        speed_window_ms: None,
        stop_speed: None,
    })
    .unwrap();
    let signal = dvs_generate_mixai(sr, 30.0, 1.0, sr); // 1 s from 0:30
    let mut last = dvs.reading();
    for block in signal.chunks(512) {
        last = dvs.process(block.to_vec());
    }
    assert!(last.valid, "{last:?}");
    assert_eq!(last.direction, DvsDirection::Forward);
    assert!((last.speed - 1.0).abs() < 0.01, "speed {}", last.speed);
    assert!(last.locked, "{last:?}");
    let pos = last.position_sec.unwrap();
    assert!((pos - 31.0).abs() < 0.02, "position {pos}");
    let rep = dvs.report();
    assert!(rep.present && rep.snr_db > 20.0, "{rep:?}");
    assert!(!dvs.scope_points().is_empty());
    assert!(
        DvsInput::new(DvsSettings {
            format: DvsFormat::Phase,
            sample_rate: sr,
            mode: None,
            swap_channels: false,
            speed_window_ms: None,
            stop_speed: None,
        })
        .is_err()
    );
}

#[test]
fn renderer_headless_read_pixels() {
    let r = match DecksRenderer::new_headless(320, 160) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("no GPU adapter, renderer test skipped: {e}");
            return;
        }
    };
    let info = r.info();
    assert_eq!((info.width, info.height), (320, 160));
    r.set_views(vec![
        RenderView {
            kind: RenderViewKind::Waveform { deck: 0 },
            x: 0.0,
            y: 0.0,
            w: 320.0,
            h: 120.0,
        },
        RenderView {
            kind: RenderViewKind::Overview { deck: 0 },
            x: 0.0,
            y: 120.0,
            w: 320.0,
            h: 40.0,
        },
    ]);
    let n = 1500usize;
    let lane = |f: fn(usize) -> u8| (0..n).map(f).collect::<Vec<u8>>();
    r.set_peaks(
        0,
        WaveformPeaks {
            points_per_second: 150,
            len: n as u32,
            low_min: lane(|i| 128 - (i % 100) as u8),
            low_max: lane(|i| 128 + (i % 100) as u8),
            low_rms: lane(|i| (i % 100) as u8),
            mid_min: lane(|_| 100),
            mid_max: lane(|_| 156),
            mid_rms: lane(|_| 40),
            high_min: lane(|_| 120),
            high_max: lane(|_| 136),
            high_rms: lane(|_| 10),
        },
    )
    .unwrap();
    assert!(r.set_peaks(9, WaveformPeaks::default()).is_err());
    r.update(RenderFrameState {
        decks: vec![DeckFrameState {
            loaded: true,
            playhead_sec: 4.0,
            slip_playhead_sec: None,
            duration_sec: 10.0,
            grid: Some(RenderGrid {
                bpm: 120.0,
                first_downbeat_sec: 0.1,
                beats_per_bar: 4,
            }),
            markers: vec![RenderMarker {
                kind: RenderMarkerKind::HotCue { slot: 0 },
                start_sec: 3.0,
                end_sec: 3.0,
                colour: 0xFF4FA3,
            }],
            platter_rpm: 33.333,
            dvs_scope: vec![],
        }],
        zoom_seconds: 8.0,
        style: RenderWaveStyle::Rgb3Band,
        theme: RenderTheme::Dark,
        reduced_motion: false,
    });
    r.render().unwrap();
    let px = r.read_pixels().expect("headless pixels");
    assert_eq!(px.len(), 320 * 160 * 4);
    let (pixels, _) = px.as_chunks::<4>();
    assert!(
        pixels.iter().any(|p| p != &pixels[0]),
        "frame has more than one colour"
    );
    assert!(
        DecksRenderer::from_android_surface(0, 10, 10, 1.0).is_err(),
        "null window rejected"
    );
}
