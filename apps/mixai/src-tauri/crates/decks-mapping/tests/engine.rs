//! End-to-end tests of the mapping engine against the built-in profiles.

use decks_mapping::format::{DeviceInfo, FeedbackKey, InputKind};
use decks_mapping::profiles::{self, Flx4Layout};
use decks_mapping::{
    Action, ClockAction, DeckAction, FeedbackState, FeedbackValue, FxAction, LibraryAction,
    MappingEngine, MappingFile, MixerAction, PadMode, SamplerAction, ScaleMode,
};

fn engine(m: MappingFile) -> MappingEngine {
    MappingEngine::new(m).expect("profile compiles")
}

fn flx4(layout: Flx4Layout) -> MappingEngine {
    engine(profiles::ddj_flx4(layout))
}

#[test]
fn flx4_jog_relative_decode_and_touch() {
    for layout in [Flx4Layout::Rekordbox, Flx4Layout::Serato] {
        let mut e = flx4(layout);
        // Wheel side, deck 1: 0x41 = +1, 0x3F = -1, 0x44 = +4.
        assert_eq!(
            e.on_midi("FLX4", &[0xB0, 0x21, 0x41], 0),
            vec![Action::Deck(DeckAction::JogBend {
                deck: 0,
                delta: 1.0
            })]
        );
        assert_eq!(
            e.on_midi("FLX4", &[0xB1, 0x21, 0x3F], 0),
            vec![Action::Deck(DeckAction::JogBend {
                deck: 1,
                delta: -1.0
            })]
        );
        // Platter (vinyl on) while untouched → bend; touched → scratch.
        assert_eq!(
            e.on_midi("FLX4", &[0xB0, 0x22, 0x44], 0),
            vec![Action::Deck(DeckAction::JogBend {
                deck: 0,
                delta: 4.0
            })]
        );
        assert_eq!(
            e.on_midi("FLX4", &[0x90, 0x36, 0x7F], 0),
            vec![Action::Deck(DeckAction::JogTouch {
                deck: 0,
                pressed: true
            })]
        );
        assert_eq!(
            e.on_midi("FLX4", &[0xB0, 0x22, 0x3C], 0),
            vec![Action::Deck(DeckAction::JogScratch {
                deck: 0,
                delta: -4.0
            })]
        );
        // Running status release (note on velocity 0) → untouched again.
        assert_eq!(
            e.on_midi("FLX4", &[0x90, 0x36, 0x00], 0),
            vec![Action::Deck(DeckAction::JogTouch {
                deck: 0,
                pressed: false
            })]
        );
        assert_eq!(
            e.on_midi("FLX4", &[0xB0, 0x22, 0x42], 0),
            vec![Action::Deck(DeckAction::JogBend {
                deck: 0,
                delta: 2.0
            })]
        );
        // SHIFT + platter → search.
        assert_eq!(
            e.on_midi("FLX4", &[0xB1, 0x29, 0x48], 0),
            vec![Action::Deck(DeckAction::JogSearch {
                deck: 1,
                delta: 8.0
            })]
        );
    }
}

#[test]
fn flx4_hot_cue_pads_both_layouts_both_decks() {
    for layout in [Flx4Layout::Rekordbox, Flx4Layout::Serato] {
        let mut e = flx4(layout);
        // Deck 1 pad 1: ch 8 note 0x00; deck 2 pad 3: ch 10 note 0x02.
        assert_eq!(
            e.on_midi("FLX4", &[0x97, 0x00, 0x7F], 0),
            vec![Action::Deck(DeckAction::HotCue {
                deck: 0,
                slot: 0,
                pressed: true
            })]
        );
        assert_eq!(
            e.on_midi("FLX4", &[0x97, 0x00, 0x00], 0),
            vec![Action::Deck(DeckAction::HotCue {
                deck: 0,
                slot: 0,
                pressed: false
            })]
        );
        assert_eq!(
            e.on_midi("FLX4", &[0x99, 0x02, 0x7F], 0),
            vec![Action::Deck(DeckAction::HotCue {
                deck: 1,
                slot: 2,
                pressed: true
            })]
        );
        // SHIFT + pad 8 (ch 9 / 11) → delete.
        assert_eq!(
            e.on_midi("FLX4", &[0x98, 0x07, 0x7F], 0),
            vec![Action::Deck(DeckAction::HotCueDelete { deck: 0, slot: 7 })]
        );
        assert_eq!(
            e.on_midi("FLX4", &[0x9A, 0x07, 0x7F], 0),
            vec![Action::Deck(DeckAction::HotCueDelete { deck: 1, slot: 7 })]
        );
        // Releasing a delete pad does nothing.
        assert!(e.on_midi("FLX4", &[0x9A, 0x07, 0x00], 0).is_empty());
    }
}

#[test]
fn flx4_layout_specific_functions() {
    let mut rb = flx4(Flx4Layout::Rekordbox);
    let mut se = flx4(Flx4Layout::Serato);
    // SHIFT + HOT CUE mode: Keyboard (rekordbox) vs Pitch Play (Serato).
    assert_eq!(
        rb.on_midi("FLX4", &[0x90, 0x69, 0x7F], 0),
        vec![Action::Deck(DeckAction::PadMode {
            deck: 0,
            mode: PadMode::Keyboard
        })]
    );
    assert_eq!(
        se.on_midi("FLX4", &[0x90, 0x69, 0x7F], 0),
        vec![Action::Deck(DeckAction::PadMode {
            deck: 0,
            mode: PadMode::PitchPlay
        })]
    );
    // Beat jump pad 1 deck 2: rekordbox jumps 1 beat back, Serato jumps by size.
    assert_eq!(
        rb.on_midi("FLX4", &[0x99, 0x20, 0x7F], 0),
        vec![Action::Deck(DeckAction::BeatJump {
            deck: 1,
            beats: -1.0
        })]
    );
    assert_eq!(
        se.on_midi("FLX4", &[0x99, 0x20, 0x7F], 0),
        vec![Action::Deck(DeckAction::BeatJumpBySize {
            deck: 1,
            direction: -1
        })]
    );
    // Sampler pad 1 deck 2: rekordbox slot 9 (index 8), Serato slot 1.
    assert_eq!(
        rb.on_midi("FLX4", &[0x99, 0x30, 0x64], 0),
        vec![Action::Sampler(SamplerAction::Trigger {
            slot: 8,
            velocity: 100.0 / 127.0,
            pressed: true
        })]
    );
    assert_eq!(
        se.on_midi("FLX4", &[0x99, 0x30, 0x64], 0),
        vec![Action::Sampler(SamplerAction::Trigger {
            slot: 0,
            velocity: 100.0 / 127.0,
            pressed: true
        })]
    );
    // CUE/LOOP CALL ◁: memory cue call vs loop halve.
    assert_eq!(
        rb.on_midi("FLX4", &[0x90, 0x51, 0x7F], 0),
        vec![Action::Deck(DeckAction::CueCall {
            deck: 0,
            direction: -1
        })]
    );
    assert_eq!(
        se.on_midi("FLX4", &[0x90, 0x51, 0x7F], 0),
        vec![Action::Deck(DeckAction::LoopHalve { deck: 0 })]
    );
    // Browse: two's complement.
    assert_eq!(
        rb.on_midi("FLX4", &[0xB6, 0x40, 0x7E], 0),
        vec![Action::Library(LibraryAction::Scroll { delta: -2.0 })]
    );
    // FX CH SELECT switch: position CH2 → assign on.
    assert_eq!(
        rb.on_midi("FLX4", &[0x95, 0x11, 0x7F], 0),
        vec![Action::Fx(FxAction::Assign {
            unit: 0,
            channel: 1,
            on: true
        })]
    );
}

#[test]
fn flx4_14bit_cc_combine() {
    let mut e = flx4(Flx4Layout::Rekordbox);
    // Channel fader deck 1: MSB CC 0x13, LSB CC 0x33. Nothing until the LSB arrives.
    assert!(e.on_midi("FLX4", &[0xB0, 0x13, 0x7F], 0).is_empty());
    let a = e.on_midi("FLX4", &[0xB0, 0x33, 0x7F], 0);
    assert_eq!(
        a,
        vec![Action::Mixer(MixerAction::Volume {
            channel: 0,
            value: 1.0
        })]
    );
    // Mid-scale 0x40/0x00 = 8192 / 16383.
    e.on_midi("FLX4", &[0xB0, 0x13, 0x40], 0);
    let a = e.on_midi("FLX4", &[0xB0, 0x33, 0x00], 0);
    let Action::Mixer(MixerAction::Volume { value, .. }) = a[0] else {
        panic!("{a:?}")
    };
    assert!((value - 8192.0 / 16383.0).abs() < 1e-6);
    // Tempo (range -1..1), running status for the LSB.
    let a = e.on_midi("FLX4", &[0xB1, 0x00, 0x00, 0x20, 0x00], 0);
    assert_eq!(
        a,
        vec![Action::Deck(DeckAction::Tempo {
            deck: 1,
            value: -1.0
        })]
    );
}

#[test]
fn soft_takeover_waits_for_pickup() {
    let mut e = flx4(Flx4Layout::Rekordbox);
    // Engine says the crossfader is at 0.8 (e.g. moved in the UI).
    e.sync_value(&Action::Mixer(MixerAction::Crossfader { value: 0.8 }));
    let move_to =
        |e: &mut MappingEngine, msb: u8| e.on_midi("FLX4", &[0xB6, 0x1F, msb, 0x3F, 0x00], 0);
    // Hardware at 0.0 … 0.6: ignored.
    assert!(move_to(&mut e, 0x00).is_empty());
    assert!(move_to(&mut e, 0x40).is_empty());
    assert!(move_to(&mut e, 0x4D).is_empty()); // ~0.606
    // Crossing 0.8 picks up.
    let a = move_to(&mut e, 0x70); // ~0.88
    assert_eq!(a.len(), 1);
    // From now on every move passes.
    assert_eq!(move_to(&mut e, 0x10).len(), 1);
    // A new engine value far away re-arms takeover.
    e.sync_value(&Action::Mixer(MixerAction::Crossfader { value: 0.9 }));
    assert!(move_to(&mut e, 0x10).is_empty());
    // Within the 3 % window picks up immediately.
    assert_eq!(move_to(&mut e, 0x73).len(), 1); // ~0.906
}

#[test]
fn learn_detects_14bit_and_relative_and_proposes_binding() {
    let mut e = engine(profiles::generic_two_deck());
    e.start_learn(Some(Action::Mixer(MixerAction::Volume {
        channel: 0,
        value: 0.0,
    })));
    for v in [10u8, 20, 30, 40] {
        assert!(
            e.on_midi("ctl", &[0xB3, 0x05, v, 0x25, 0x10], u64::from(v))
                .is_empty()
        );
    }
    assert!(e.poll_learn(100).is_none());
    let p = e.poll_learn(1_000_000).expect("gesture finished");
    assert_eq!(
        p.kind,
        InputKind::Cc14 {
            msb: 0x05,
            lsb: 0x25
        }
    );
    let (input, binding) = e.learned_binding().unwrap();
    assert_eq!(input.channel, Some(4));
    assert!(binding.soft_takeover);
    e.add_binding(input, binding).unwrap();
    let a = e.on_midi("ctl", &[0xB3, 0x05, 0x7F, 0x25, 0x7F], 0);
    assert_eq!(
        a,
        vec![Action::Mixer(MixerAction::Volume {
            channel: 0,
            value: 1.0
        })]
    );

    // Relative encoder learn → scroll.
    e.start_learn(Some(Action::Library(LibraryAction::Scroll { delta: 0.0 })));
    for (t, v) in [0x41u8, 0x41, 0x42, 0x41].into_iter().enumerate() {
        e.on_midi("ctl", &[0xB4, 0x30, v], t as u64);
    }
    let p = e.poll_learn(10_000_000).unwrap();
    assert!(matches!(
        p.kind,
        InputKind::Cc {
            cc: 0x30,
            relative: Some(decks_mapping::value::RelativeEncoding::Offset64)
        }
    ));
    let (input, binding) = e.learned_binding().unwrap();
    assert!(!binding.soft_takeover);
    e.add_binding(input, binding).unwrap();
    assert_eq!(
        e.on_midi("ctl", &[0xB4, 0x30, 0x3D], 0),
        vec![Action::Library(LibraryAction::Scroll { delta: -3.0 })]
    );
}

#[test]
fn keyboard_scale_lock_follows_track_key() {
    let mut e = engine(profiles::generic_keyboard());
    e.set_track_key(0, ScaleMode::Minor); // C minor
    // E4 (64) → Eb4 (63).
    assert_eq!(
        e.on_midi("Keys", &[0x90, 64, 100], 0),
        vec![Action::Sampler(SamplerAction::Note {
            instrument: 0,
            note: 63,
            velocity: 100.0 / 127.0,
            pressed: true
        })]
    );
    // A minor: G# → G.
    e.set_track_key(9, ScaleMode::Minor);
    let a = e.on_midi("Keys", &[0x80, 68, 0], 0);
    assert_eq!(
        a,
        vec![Action::Sampler(SamplerAction::Note {
            instrument: 0,
            note: 67,
            velocity: 0.0,
            pressed: false
        })]
    );
    // Sustain held: keys 36..51 trigger sampler slots, others still play notes.
    e.on_midi("Keys", &[0xB0, 64, 127], 0);
    assert_eq!(
        e.on_midi("Keys", &[0x90, 38, 90], 0),
        vec![Action::Sampler(SamplerAction::Trigger {
            slot: 2,
            velocity: 90.0 / 127.0,
            pressed: true
        })]
    );
    assert!(matches!(
        e.on_midi("Keys", &[0x90, 72, 90], 0)[..],
        [Action::Sampler(SamplerAction::Note { note: 72, .. })]
    ));
    e.on_midi("Keys", &[0xB0, 64, 0], 0);
    assert!(matches!(
        e.on_midi("Keys", &[0x90, 38, 90], 0)[..],
        [Action::Sampler(SamplerAction::Note { .. })]
    ));
}

#[test]
fn circuit_tracks_drums_macros_project_clock_and_groove() {
    let mut e = engine(profiles::circuit_tracks(false));
    // Drum 2 (ch 10 note 62) → sampler slot 1.
    assert!(matches!(
        e.on_midi("Circuit Tracks", &[0x99, 62, 100], 0)[..],
        [Action::Sampler(SamplerAction::Trigger {
            slot: 1,
            pressed: true,
            ..
        })]
    ));
    // With the virtual modifier: hot cue 2 of deck 1 instead.
    e.set_modifier("drums_to_cues", true);
    assert_eq!(
        e.on_midi("Circuit Tracks", &[0x99, 62, 100], 0),
        vec![Action::Deck(DeckAction::HotCue {
            deck: 0,
            slot: 1,
            pressed: true
        })]
    );
    e.set_modifier("drums_to_cues", false);
    // Macro 3 on synth 2 → FX unit 1 param 2.
    assert_eq!(
        e.on_midi("Circuit Tracks", &[0xB1, 82, 127], 0),
        vec![Action::Fx(FxAction::Param {
            unit: 1,
            index: 2,
            value: 1.0
        })]
    );
    // Project ch 16: programme change 66 → queued pattern 2; CC 74 → master filter.
    assert_eq!(
        e.on_midi("Circuit Tracks", &[0xCF, 66], 0),
        vec![Action::Sampler(SamplerAction::SelectPattern {
            index: 2,
            queued: true
        })]
    );
    // Synth 1 note scale-locked in the track key (D major: F → E).
    e.set_track_key(2, ScaleMode::Major);
    assert!(matches!(
        e.on_midi("Circuit Tracks", &[0x90, 65, 80], 0)[..],
        [Action::Sampler(SamplerAction::Note {
            instrument: 0,
            note: 64,
            ..
        })]
    ));

    // Clock follow + groove recording of one bar of kicks on every beat.
    e.set_groove_recording(true);
    let iv = 60_000_000.0 / (128.0 * 24.0);
    let mut tempo = None;
    let mut t = 1_000.0f64;
    let a = e.on_midi("Circuit Tracks", &[0xFA], t as u64);
    assert_eq!(a, vec![Action::Clock(ClockAction::Start)]);
    for tick in 0..96 {
        if tick % 24 == 0 {
            e.on_midi("Circuit Tracks", &[0x99, 60, 110], t as u64);
            e.on_midi("Circuit Tracks", &[0x89, 60, 0], t as u64);
        }
        for a in e.on_midi("Circuit Tracks", &[0xF8], t as u64) {
            if let Action::Clock(ClockAction::Tempo { bpm }) = a {
                tempo = Some(bpm);
            }
        }
        t += iv;
    }
    let bpm = tempo.expect("tempo reported");
    assert!((127.9..=128.1).contains(&bpm), "{bpm}");
    let pat = e.take_groove_pattern().unwrap();
    let kicks: Vec<_> = pat.notes.iter().filter(|n| n.note == 60).collect();
    assert_eq!(kicks.len(), 4, "{pat:?}");
    for (i, k) in kicks.iter().enumerate() {
        assert_eq!(k.pos.beat, i as u32);
        assert_eq!(k.pos.tick, 0);
        assert_eq!(k.channel, 10);
    }
}

#[test]
fn circuit_tracks_clock_master_sends_24ppqn() {
    let mut e = engine(profiles::circuit_tracks(true));
    let g = e.clock_generator_mut().unwrap();
    g.set_bpm(128.0);
    g.start(0.0, 0.0);
    let out = e.clock_out(60_000_000.0 / 128.0 - 1.0);
    assert_eq!(out[0].bytes, vec![0xFA]);
    assert_eq!(out.iter().filter(|o| o.bytes == [0xF8]).count(), 24);
}

#[test]
fn deck_layers_and_feedback() {
    let mut e = engine(profiles::generic_two_deck());
    assert_eq!(
        e.on_midi("x", &[0x90, 0, 127], 0),
        vec![Action::Deck(DeckAction::PlayPause { deck: 0 })]
    );
    // Deck switch on side A → deck 3 (index 2).
    e.on_midi("x", &[0x90, 13, 127, 0x90, 13, 0], 0);
    assert_eq!(e.side_deck(0), Some(2));
    assert_eq!(
        e.on_midi("x", &[0x90, 0, 127], 0),
        vec![Action::Deck(DeckAction::PlayPause { deck: 2 })]
    );
    // Shift layer: pad 1 deletes the hot cue while shift is held (more specific binding wins).
    e.on_midi("x", &[0x90, 12, 127], 0);
    assert_eq!(
        e.on_midi("x", &[0x90, 4, 127], 0),
        vec![Action::Deck(DeckAction::HotCueDelete { deck: 2, slot: 0 })]
    );
    e.on_midi("x", &[0x90, 12, 0], 0);

    // Feedback follows the side's deck and only resends changes.
    let mut st = FeedbackState::default();
    st.set(FeedbackKey::Playing { deck: 2 }, FeedbackValue::On(true));
    let out = e.feedback(&st);
    assert!(out.iter().any(|o| o.bytes == [0x90, 0, 0x7F]));
    assert!(out.iter().any(|o| o.bytes == [0x91, 0, 0x00]));
    assert!(e.feedback(&st).is_empty());
    assert_eq!(e.feedback_all(&st).len(), 2);
}

#[test]
fn flx4_feedback_leds_and_meter() {
    let mut e = flx4(Flx4Layout::Rekordbox);
    let mut st = FeedbackState::default();
    st.set(FeedbackKey::Playing { deck: 1 }, FeedbackValue::On(true));
    st.set(
        FeedbackKey::HotCueSet { deck: 0, slot: 3 },
        FeedbackValue::On(true),
    );
    st.set(FeedbackKey::Vu { channel: 0 }, FeedbackValue::Level(0.5));
    st.set(FeedbackKey::Loaded { deck: 0 }, FeedbackValue::On(true));
    let out = e.feedback(&st);
    let has = |b: &[u8]| out.iter().any(|o| o.bytes == b);
    assert!(has(&[0x91, 0x0B, 0x7F]), "play LED deck 2");
    assert!(has(&[0x97, 0x03, 0x7F]), "hot cue 4 LED deck 1");
    assert!(has(&[0xB0, 0x02, 64]), "VU meter deck 1");
    assert!(has(&[0x9F, 0x00, 0x7F]), "loaded illumination deck 1");
}

#[test]
fn detection_picks_the_right_profile() {
    let dev = |name: &str, usb: Option<(u16, u16)>| DeviceInfo {
        port_name: name.into(),
        usb,
        identity_reply: None,
    };
    assert_eq!(
        profiles::detect(&dev("DDJ-FLX4", None)).id,
        "pioneer-ddj-flx4-rekordbox"
    );
    assert_eq!(
        profiles::detect(&dev("Circuit Tracks MIDI", Some((0x1235, 0x0001)))).id,
        "novation-circuit-tracks"
    );
    // Same vendor, different product name → not the Circuit profile.
    assert_eq!(
        profiles::detect(&dev("Launchpad X", Some((0x1235, 0x0103)))).id,
        "generic-2-deck"
    );
    assert_eq!(
        profiles::detect(&dev("Keystation 49 MK3", None)).id,
        "generic-midi-keyboard"
    );
    assert_eq!(
        profiles::detect(&dev("Some Controller", None)).id,
        "generic-2-deck"
    );
    assert_eq!(
        profiles::flx4_layout(&dev("DDJ-FLX4", None), Some("Serato DJ Pro")),
        Flx4Layout::Serato
    );
    assert_eq!(
        profiles::flx4_layout(&dev("DDJ-FLX4", None), None),
        Flx4Layout::Rekordbox
    );
}

#[test]
fn builtin_profiles_roundtrip_through_json() {
    for m in profiles::builtin() {
        let json = m.to_json_pretty();
        let back = MappingFile::from_json(&json).unwrap_or_else(|e| panic!("{}: {e}", m.id));
        assert_eq!(back, m, "{}", m.id);
    }
}

#[test]
fn script_hook_runs_before_bindings() {
    let mut m = profiles::generic_two_deck();
    m.script = Some(decks_mapping::format::ScriptDef {
        source: r#"
            fn on_midi(ev) {
                if ev.kind == "note_on" && ev.data1 == 0 && ev.channel == 1 {
                    emit(#{ deck: #{ type: "sync", deck: 0 } });
                    note(1, 0, 1);
                    return true;
                }
                false
            }
        "#
        .into(),
        max_operations: None,
        max_millis: None,
    });
    let mut e = engine(m);
    assert_eq!(
        e.on_midi("x", &[0x90, 0, 127], 0),
        vec![Action::Deck(DeckAction::Sync { deck: 0 })]
    );
    // Not consumed → regular binding.
    assert_eq!(
        e.on_midi("x", &[0x91, 0, 127], 0),
        vec![Action::Deck(DeckAction::PlayPause { deck: 1 })]
    );
    let out = e.feedback(&FeedbackState::default());
    assert_eq!(out[0].bytes, vec![0x90, 0, 1]);
}

#[test]
fn script_infinite_loop_is_contained() {
    let mut m = profiles::generic_two_deck();
    m.script = Some(decks_mapping::format::ScriptDef {
        source: "fn on_midi(ev) { while true {} }".into(),
        max_operations: Some(20_000),
        max_millis: None,
    });
    let mut e = engine(m);
    // The binding still works; the error is reported.
    assert_eq!(
        e.on_midi("x", &[0x90, 0, 127], 0),
        vec![Action::Deck(DeckAction::PlayPause { deck: 0 })]
    );
    let errs = e.take_script_errors();
    assert_eq!(errs.len(), 1);
    assert!(matches!(
        errs[0],
        decks_mapping::script::ScriptError::TooManyOperations(20_000)
    ));
}

#[test]
fn ble_packet_into_engine() {
    let mut e = flx4(Flx4Layout::Rekordbox);
    let mut d = decks_mapping::ble::BleMidiDecoder::new();
    // Two messages in one BLE packet: deck 1 play press + hot cue pad 2.
    let ev = d
        .decode(&[0x80, 0x81, 0x90, 0x0B, 0x7F, 0x82, 0x97, 0x01, 0x7F])
        .unwrap();
    let mut actions = Vec::new();
    for x in ev {
        actions.extend(e.on_message("BLE", &x.message, u64::from(x.timestamp_ms) * 1000));
    }
    assert_eq!(
        actions,
        vec![
            Action::Deck(DeckAction::PlayPause { deck: 0 }),
            Action::Deck(DeckAction::HotCue {
                deck: 0,
                slot: 1,
                pressed: true
            }),
        ]
    );
}
