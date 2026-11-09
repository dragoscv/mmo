//! Built-in controller profiles.
//!
//! Every message number below comes from the manufacturer's published documentation, cited in
//! each profile's `sources` and in `docs/decks/mapping-format.md`. No third-party (GPL) mapping
//! files were used.
//!
//! * Pioneer DDJ-FLX4 — AlphaTheta "DDJ-FLX4 List of MIDI messages" Ver 1.0 (one table for all
//!   software: the unit has no software-mode switch) + DDJ-FLX4 operating instructions
//!   (rekordbox / Serato button functions) + Serato's DDJ-FLX4 quickstart (pad modes).
//! * Novation Circuit Tracks — "Circuit Tracks Programmer's Reference Guide" v3.
//! * Generic MIDI keyboard and generic 2-deck fallback — MixAI conventions (no vendor data).

use crate::action::{
    Action, ClockAction, DeckAction, EqBand, FxAction, LibraryAction, MixerAction, PadMode,
    SamplerAction, SortColumn,
};
use crate::format::{
    Binding, ClockConfig, Condition, DeckLayerDef, DeviceInfo, DeviceMatch, FeedbackKey,
    GrooveConfig, IdentityMatch, InputDef, InputKind, MappingFile, ModifierDef, OutMessage,
    OutputDef, OutputKind, ScaleLockDef, Trigger, UsbId,
};
use crate::scale::ScaleMode;
use crate::value::{Curve, RelativeEncoding};

pub const FLX4_MIDI_LIST_URL: &str = "https://downloads.support.alphatheta.com/software_info/dj-controllers/DDJ-FLX4/DDJ-FLX4_MIDI_message_List_E1.pdf";
pub const FLX4_MANUAL_URL: &str = "https://downloads.support.alphatheta.com/manuals/dj-controllers/DDJ-FLX4/DDJ-FLX4_DRI1804A_manual.pdf";
pub const FLX4_SERATO_QUICKSTART_URL: &str = "https://support.serato.com/hc/en-us/articles/17935362399887-Pioneer-DJ-DDJ-FLX4-Quickstart-Guide";
pub const CIRCUIT_TRACKS_PRG_URL: &str =
    "https://downloads.novationmusic.com/novation/circuit/circuit-tracks";
pub const CIRCUIT_TRACKS_PRG_MIRROR_URL: &str = "https://github.com/Sound-Research/Novation-Circuit-Tracks/blob/main/circuit_tracks_programmer_s_reference_guide_v3.pdf";

/// MMA SysEx manufacturer id of Pioneer Corporation (00 40 05).
pub const PIONEER_SYSEX_ID: [u8; 3] = [0x00, 0x40, 0x05];
/// MMA SysEx manufacturer id of Focusrite / Novation (00 20 29).
pub const NOVATION_SYSEX_ID: [u8; 3] = [0x00, 0x20, 0x29];
/// USB vendor id of Pioneer DJ / AlphaTheta.
pub const PIONEER_DJ_USB_VID: u16 = 0x2B73;
/// USB vendor id of Focusrite-Novation.
pub const NOVATION_USB_VID: u16 = 0x1235;

/// Which software layout the DDJ-FLX4 profile follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Flx4Layout {
    Rekordbox,
    Serato,
}

// ---- builder ----------------------------------------------------------------------------

struct P {
    m: MappingFile,
}

impl P {
    fn new(id: &str, name: &str, vendor: Option<&str>, device: DeviceMatch) -> Self {
        Self {
            m: MappingFile {
                version: crate::FORMAT_VERSION,
                id: id.into(),
                name: name.into(),
                vendor: vendor.map(Into::into),
                description: None,
                sources: Vec::new(),
                device,
                inputs: Vec::new(),
                modifiers: Vec::new(),
                deck_layers: Vec::new(),
                bindings: Vec::new(),
                outputs: Vec::new(),
                clock: None,
                groove: None,
                script: None,
            },
        }
    }

    fn input(&mut self, id: &str, ch: Option<u8>, kind: InputKind) -> String {
        if !self.m.inputs.iter().any(|i| i.id == id) {
            self.m.inputs.push(InputDef {
                id: id.into(),
                channel: ch,
                kind,
            });
        }
        id.to_string()
    }

    fn note(&mut self, id: &str, ch: u8, note: u8) -> String {
        self.input(id, Some(ch), InputKind::Note { note })
    }

    fn cc14(&mut self, id: &str, ch: u8, msb: u8) -> String {
        self.input(id, Some(ch), InputKind::Cc14 { msb, lsb: msb + 32 })
    }

    fn bind(&mut self, input: &str, action: Action) -> &mut Binding {
        self.m.bindings.push(Binding::new(input, action));
        self.m.bindings.last_mut().expect("just pushed")
    }

    /// Note button bound to an action.
    fn btn(&mut self, id: &str, ch: u8, note: u8, action: Action) -> &mut Binding {
        let i = self.note(id, ch, note);
        self.bind(&i, action)
    }

    /// 14-bit absolute control with soft takeover.
    fn knob(&mut self, id: &str, ch: u8, msb: u8, action: Action, range: [f32; 2]) {
        let i = self.cc14(id, ch, msb);
        let b = self.bind(&i, action);
        b.soft_takeover = true;
        b.transform.range = range;
    }

    fn led(&mut self, id: &str, ch: u8, note: u8, source: FeedbackKey) {
        self.m.outputs.push(OutputDef {
            id: id.into(),
            channel: ch,
            message: OutMessage::Note,
            number: note,
            source,
            side: None,
            kind: OutputKind::Led {
                on: 0x7F,
                off: 0x00,
            },
        });
    }

    fn done(self) -> MappingFile {
        debug_assert!(self.m.validate().is_ok(), "{:?}", self.m.validate());
        self.m
    }
}

fn deck(a: DeckAction) -> Action {
    Action::Deck(a)
}
fn mixer(a: MixerAction) -> Action {
    Action::Mixer(a)
}
fn fx(a: FxAction) -> Action {
    Action::Fx(a)
}
fn lib(a: LibraryAction) -> Action {
    Action::Library(a)
}
fn smp(a: SamplerAction) -> Action {
    Action::Sampler(a)
}

// ---- Pioneer DDJ-FLX4 ---------------------------------------------------------------------

/// Pioneer DDJ-FLX4. Deck 1 = MIDI ch 1, deck 2 = ch 2; pads ch 8/10 (SHIFT: ch 9/11);
/// FX ch 5/6; mixer / browser ch 7; illumination ch 16. SHIFT is a hardware layer (shifted
/// controls send different note numbers), so no binding needs a modifier condition.
pub fn ddj_flx4(layout: Flx4Layout) -> MappingFile {
    let (id, name, priority) = match layout {
        Flx4Layout::Rekordbox => (
            "pioneer-ddj-flx4-rekordbox",
            "Pioneer DDJ-FLX4 (rekordbox layout)",
            1,
        ),
        Flx4Layout::Serato => (
            "pioneer-ddj-flx4-serato",
            "Pioneer DDJ-FLX4 (Serato layout)",
            0,
        ),
    };
    let rb = layout == Flx4Layout::Rekordbox;
    let mut p = P::new(
        id,
        name,
        Some("Pioneer DJ / AlphaTheta"),
        DeviceMatch {
            name_regex: Some(r"(?i)DDJ[- ]?FLX4".into()),
            usb: vec![UsbId {
                vendor_id: PIONEER_DJ_USB_VID,
                product_id: None,
            }],
            sysex_identity: Some(IdentityMatch {
                manufacturer: PIONEER_SYSEX_ID.to_vec(),
                family: None,
                member: None,
            }),
            priority,
            fallback: false,
        },
    );
    p.m.description = Some(if rb {
        "2 decks, mixer, jog with touch, 8 pad modes (Hot Cue, Pad FX 1/2, Beat Jump, Beat Loop, Sampler, Keyboard, Key Shift), Beat FX, browser. Functions follow the rekordbox column of the FLX4 manual.".into()
    } else {
        "2 decks, mixer, jog with touch, 8 pad modes (Hot Cue, Pad FX, Beat Jump, Sampler, Pitch Play, Roll, Auto Loop, Key Shift), FX, browser. Functions follow the Serato DJ Pro column of the FLX4 manual and Serato's quickstart.".into()
    });
    p.m.sources = vec![FLX4_MIDI_LIST_URL.into(), FLX4_MANUAL_URL.into()];
    if !rb {
        p.m.sources.push(FLX4_SERATO_QUICKSTART_URL.into());
    }

    for d in 0u8..2 {
        let ch = d + 1;
        let pad_ch = 8 + 2 * d; // 8 / 10
        let pad_sh = pad_ch + 1; // 9 / 11
        let n = |s: &str| format!("deck{}.{s}", d + 1);

        // Transport.
        p.btn(
            &n("play"),
            ch,
            0x0B,
            deck(DeckAction::PlayPause { deck: d }),
        );
        if !rb {
            p.btn(
                &n("shift_play"),
                ch,
                0x0E,
                deck(DeckAction::Stutter { deck: d }),
            );
        }
        p.btn(
            &n("cue"),
            ch,
            0x0C,
            deck(DeckAction::Cue {
                deck: d,
                pressed: false,
            }),
        );
        p.btn(
            &n("shift_cue"),
            ch,
            0x48,
            deck(DeckAction::CueGotoStart { deck: d }),
        );
        let shift = p.note(&n("shift"), ch, 0x3F);
        p.m.modifiers.push(ModifierDef {
            id: format!("shift{}", d + 1),
            input: Some(shift),
            toggle: false,
        });

        // Jog: offset-64 deltas ("turn clockwise: increases from 0x41").
        let jog = |cc| InputKind::Jog {
            cc,
            encoding: RelativeEncoding::Offset64,
        };
        let i = p.input(&n("jog_top_vinyl"), Some(ch), jog(0x22));
        p.bind(
            &i,
            deck(DeckAction::JogScratch {
                deck: d,
                delta: 0.0,
            }),
        );
        let i = p.input(&n("jog_top"), Some(ch), jog(0x23));
        p.bind(
            &i,
            deck(DeckAction::JogBend {
                deck: d,
                delta: 0.0,
            }),
        );
        let i = p.input(&n("jog_side"), Some(ch), jog(0x21));
        p.bind(
            &i,
            deck(DeckAction::JogBend {
                deck: d,
                delta: 0.0,
            }),
        );
        let i = p.input(&n("shift_jog_top"), Some(ch), jog(0x29));
        p.bind(
            &i,
            deck(DeckAction::JogSearch {
                deck: d,
                delta: 0.0,
            }),
        );
        p.btn(
            &n("jog_touch"),
            ch,
            0x36,
            deck(DeckAction::JogTouch {
                deck: d,
                pressed: false,
            }),
        );
        p.btn(
            &n("shift_jog_touch"),
            ch,
            0x67,
            deck(DeckAction::JogTouch {
                deck: d,
                pressed: false,
            }),
        );

        // Loops and cue / loop call.
        p.btn(
            &n("loop_in"),
            ch,
            0x10,
            deck(DeckAction::LoopIn {
                deck: d,
                pressed: false,
            }),
        );
        p.btn(
            &n("loop_out"),
            ch,
            0x11,
            deck(DeckAction::LoopOut {
                deck: d,
                pressed: false,
            }),
        );
        if !rb {
            p.btn(
                &n("shift_loop_out"),
                ch,
                0x4E,
                deck(DeckAction::VinylMode { deck: d }),
            );
        }
        p.btn(
            &n("beat4_exit"),
            ch,
            0x4D,
            deck(DeckAction::AutoLoop {
                deck: d,
                beats: 4.0,
            }),
        );
        p.btn(
            &n("shift_beat4_exit"),
            ch,
            0x50,
            deck(DeckAction::LoopActiveToggle { deck: d }),
        );
        if rb {
            p.btn(
                &n("call_prev"),
                ch,
                0x51,
                deck(DeckAction::CueCall {
                    deck: d,
                    direction: -1,
                }),
            );
            p.btn(
                &n("call_next"),
                ch,
                0x53,
                deck(DeckAction::CueCall {
                    deck: d,
                    direction: 1,
                }),
            );
            p.btn(
                &n("shift_call_prev"),
                ch,
                0x3E,
                deck(DeckAction::CueMemoryDelete { deck: d }),
            );
            p.btn(
                &n("shift_call_next"),
                ch,
                0x3D,
                deck(DeckAction::CueMemorySave { deck: d }),
            );
        } else {
            p.btn(
                &n("loop_halve"),
                ch,
                0x51,
                deck(DeckAction::LoopHalve { deck: d }),
            );
            p.btn(
                &n("loop_double"),
                ch,
                0x53,
                deck(DeckAction::LoopDouble { deck: d }),
            );
        }

        // Sync / tempo.
        p.btn(&n("sync"), ch, 0x58, deck(DeckAction::Sync { deck: d }));
        if rb {
            p.btn(
                &n("sync_long"),
                ch,
                0x5C,
                deck(DeckAction::SetTempoMaster { deck: d }),
            );
        } else {
            p.btn(
                &n("sync_long"),
                ch,
                0x5C,
                deck(DeckAction::SyncOff { deck: d }),
            );
        }
        p.btn(
            &n("shift_sync"),
            ch,
            0x60,
            deck(DeckAction::TempoRangeCycle { deck: d }),
        );
        p.knob(
            &n("tempo"),
            ch,
            0x00,
            deck(DeckAction::Tempo {
                deck: d,
                value: 0.0,
            }),
            [-1.0, 1.0],
        );

        // Mixer channel.
        p.knob(
            &n("trim"),
            ch,
            0x04,
            mixer(MixerAction::Trim {
                channel: d,
                value: 0.0,
            }),
            [0.0, 1.0],
        );
        for (cc, band, nm) in [
            (0x07, EqBand::High, "eq_hi"),
            (0x0B, EqBand::Mid, "eq_mid"),
            (0x0F, EqBand::Low, "eq_low"),
        ] {
            p.knob(
                &n(nm),
                ch,
                cc,
                mixer(MixerAction::Eq {
                    channel: d,
                    band,
                    value: 0.0,
                }),
                [0.0, 1.0],
            );
        }
        p.knob(
            &n("fader"),
            ch,
            0x13,
            mixer(MixerAction::Volume {
                channel: d,
                value: 0.0,
            }),
            [0.0, 1.0],
        );
        p.knob(
            &format!("mixer.cfx{}", d + 1),
            7,
            0x17 + d,
            mixer(MixerAction::Filter {
                channel: d,
                value: 0.0,
            }),
            [0.0, 1.0],
        );
        p.btn(
            &n("fader_start"),
            ch,
            0x66,
            mixer(MixerAction::FaderStart {
                channel: d,
                start: true,
            }),
        )
        .trigger = Trigger::Press;
        p.btn(
            &n("fader_stop"),
            ch,
            0x52,
            mixer(MixerAction::FaderStart {
                channel: d,
                start: false,
            }),
        )
        .trigger = Trigger::Press;
        p.btn(
            &n("ch_cue"),
            ch,
            0x54,
            mixer(MixerAction::HeadphoneCue { channel: d }),
        );

        // Pad mode buttons (also LED outputs with the same message).
        let modes: [(u8, PadMode, &str); 8] = [
            (0x1B, PadMode::HotCue, "mode_hot_cue"),
            (
                0x69,
                if rb {
                    PadMode::Keyboard
                } else {
                    PadMode::PitchPlay
                },
                "shift_mode_hot_cue",
            ),
            (0x1E, PadMode::PadFx1, "mode_pad_fx1"),
            (
                0x6B,
                if rb { PadMode::PadFx2 } else { PadMode::Roll },
                "shift_mode_pad_fx1",
            ),
            (0x20, PadMode::BeatJump, "mode_beat_jump"),
            (
                0x6D,
                if rb {
                    PadMode::BeatLoop
                } else {
                    PadMode::AutoLoop
                },
                "shift_mode_beat_jump",
            ),
            (0x22, PadMode::Sampler, "mode_sampler"),
            (0x6F, PadMode::KeyShift, "shift_mode_sampler"),
        ];
        for (note, mode, nm) in modes {
            p.btn(
                &n(nm),
                ch,
                note,
                deck(DeckAction::PadMode { deck: d, mode }),
            );
            p.led(
                &format!("led.{}", n(nm)),
                ch,
                note,
                FeedbackKey::PadMode { deck: d, mode },
            );
        }

        // Performance pads: the note number encodes the pad mode (offset) + pad 0..7.
        for i in 0u8..8 {
            let pad = |off: u8| off + i;
            let id = |m: &str| format!("deck{}.pad{}.{m}", d + 1, i + 1);
            // Hot cue (both).
            p.btn(
                &id("hot_cue"),
                pad_ch,
                pad(0x00),
                deck(DeckAction::HotCue {
                    deck: d,
                    slot: i,
                    pressed: false,
                }),
            );
            p.btn(
                &id("shift_hot_cue"),
                pad_sh,
                pad(0x00),
                deck(DeckAction::HotCueDelete { deck: d, slot: i }),
            );
            p.m.outputs.push(OutputDef {
                id: format!("led.{}", id("hot_cue")),
                channel: pad_ch,
                message: OutMessage::Note,
                number: pad(0x00),
                source: FeedbackKey::HotCueSet { deck: d, slot: i },
                side: None,
                kind: OutputKind::Led {
                    on: 0x7F,
                    off: 0x00,
                },
            });
            // Pad FX page 1 (rb: FX A..H, SHIFT I..P; Serato: Pad FX).
            p.btn(
                &id("pad_fx1"),
                pad_ch,
                pad(0x10),
                fx(FxAction::PadFx {
                    deck: d,
                    page: 0,
                    slot: i,
                    pressed: false,
                }),
            );
            if rb {
                p.btn(
                    &id("shift_pad_fx1"),
                    pad_sh,
                    pad(0x10),
                    fx(FxAction::PadFx {
                        deck: d,
                        page: 1,
                        slot: i,
                        pressed: false,
                    }),
                );
            }
            // Sampler.
            let slot = if rb { i + 8 * d } else { i };
            p.btn(
                &id("sampler"),
                pad_ch,
                pad(0x30),
                smp(SamplerAction::Trigger {
                    slot,
                    velocity: 0.0,
                    pressed: false,
                }),
            );
            if rb {
                p.btn(
                    &id("shift_sampler"),
                    pad_sh,
                    pad(0x30),
                    smp(SamplerAction::Load { slot }),
                );
            } else {
                p.btn(
                    &id("shift_sampler"),
                    pad_sh,
                    pad(0x30),
                    smp(SamplerAction::Stop { slot }),
                );
            }
            p.m.outputs.push(OutputDef {
                id: format!("led.{}", id("sampler")),
                channel: pad_ch,
                message: OutMessage::Note,
                number: pad(0x30),
                source: FeedbackKey::SamplerLoaded { slot },
                side: None,
                kind: OutputKind::Led {
                    on: 0x7F,
                    off: 0x00,
                },
            });
            // Key shift (both): rb default +4..+7 / 0..+3, Serato middle range 0..+3 / -4..-1.
            let ks: [i8; 8] = if rb {
                [4, 5, 6, 7, 0, 1, 2, 3]
            } else {
                [0, 1, 2, 3, -4, -3, -2, -1]
            };
            p.btn(
                &id("key_shift"),
                pad_ch,
                pad(0x70),
                deck(DeckAction::KeyShift {
                    deck: d,
                    semitones: ks[usize::from(i)],
                }),
            );

            if rb {
                // Beat jump: odd pads left, even pads right; 1, 2, 4, 8 beats.
                let beats = [1.0f32, 1.0, 2.0, 2.0, 4.0, 4.0, 8.0, 8.0][usize::from(i)];
                let signed = if i % 2 == 0 { -beats } else { beats };
                p.btn(
                    &id("beat_jump"),
                    pad_ch,
                    pad(0x20),
                    deck(DeckAction::BeatJump {
                        deck: d,
                        beats: signed,
                    }),
                );
                if i >= 6 {
                    let dir = if i == 6 { -1 } else { 1 };
                    p.btn(
                        &id("shift_beat_jump"),
                        pad_sh,
                        pad(0x20),
                        deck(DeckAction::BeatJumpSize {
                            deck: d,
                            direction: dir,
                        }),
                    );
                }
                // Keyboard: pitches of the selected hot cue.
                p.btn(
                    &id("keyboard"),
                    pad_ch,
                    pad(0x40),
                    deck(DeckAction::PitchPlay {
                        deck: d,
                        semitones: [4, 5, 6, 7, 0, 1, 2, 3][usize::from(i)],
                        pressed: false,
                    }),
                );
                // Pad FX page 2 (FX Q..X, SHIFT Y..AF).
                p.btn(
                    &id("pad_fx2"),
                    pad_ch,
                    pad(0x50),
                    fx(FxAction::PadFx {
                        deck: d,
                        page: 2,
                        slot: i,
                        pressed: false,
                    }),
                );
                p.btn(
                    &id("shift_pad_fx2"),
                    pad_sh,
                    pad(0x50),
                    fx(FxAction::PadFx {
                        deck: d,
                        page: 3,
                        slot: i,
                        pressed: false,
                    }),
                );
                // Beat loop 1/4 .. 32 beats.
                let bl = [0.25f32, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0][usize::from(i)];
                p.btn(
                    &id("beat_loop"),
                    pad_ch,
                    pad(0x60),
                    deck(DeckAction::AutoLoop { deck: d, beats: bl }),
                );
            } else {
                // Beat jump (Serato): 1 / 4 jump, 2 / 3 halve / double size, 5 load previous,
                // 6 / 7 rewind / fast-forward, 8 censor; SHIFT + 8 reverse.
                let a = match i {
                    0 => DeckAction::BeatJumpBySize {
                        deck: d,
                        direction: -1,
                    },
                    1 => DeckAction::BeatJumpSize {
                        deck: d,
                        direction: -1,
                    },
                    2 => DeckAction::BeatJumpSize {
                        deck: d,
                        direction: 1,
                    },
                    3 => DeckAction::BeatJumpBySize {
                        deck: d,
                        direction: 1,
                    },
                    4 => DeckAction::LoadPrevious { deck: d },
                    5 => DeckAction::Seek {
                        deck: d,
                        direction: -1,
                        pressed: false,
                    },
                    6 => DeckAction::Seek {
                        deck: d,
                        direction: 1,
                        pressed: false,
                    },
                    _ => DeckAction::Censor {
                        deck: d,
                        pressed: false,
                    },
                };
                p.btn(&id("beat_jump"), pad_ch, pad(0x20), deck(a));
                if i == 7 {
                    p.btn(
                        &id("shift_beat_jump"),
                        pad_sh,
                        pad(0x20),
                        deck(DeckAction::Reverse { deck: d }),
                    );
                }
                // Pitch play (middle range).
                p.btn(
                    &id("pitch_play"),
                    pad_ch,
                    pad(0x40),
                    deck(DeckAction::PitchPlay {
                        deck: d,
                        semitones: [0, 1, 2, 3, -4, -3, -2, -1][usize::from(i)],
                        pressed: false,
                    }),
                );
                // Roll and auto loop sizes: MixAI defaults (not specified by the quickstart).
                let roll = [0.0625f32, 0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0][usize::from(i)];
                p.btn(
                    &id("roll"),
                    pad_ch,
                    pad(0x50),
                    deck(DeckAction::LoopRoll {
                        deck: d,
                        beats: roll,
                        pressed: false,
                    }),
                );
                let al = [0.25f32, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0][usize::from(i)];
                p.btn(
                    &id("auto_loop"),
                    pad_ch,
                    pad(0x60),
                    deck(DeckAction::AutoLoop { deck: d, beats: al }),
                );
            }
        }

        // Deck LEDs (MIDI-OUT column of the list).
        p.led(&n("led.play"), ch, 0x0B, FeedbackKey::Playing { deck: d });
        p.led(
            &n("led.cue"),
            ch,
            0x0C,
            FeedbackKey::CueIndicator { deck: d },
        );
        p.led(&n("led.sync"), ch, 0x58, FeedbackKey::Sync { deck: d });
        p.led(
            &n("led.loop_in"),
            ch,
            0x10,
            FeedbackKey::LoopActive { deck: d },
        );
        p.led(
            &n("led.loop_out"),
            ch,
            0x11,
            FeedbackKey::LoopActive { deck: d },
        );
        p.led(
            &n("led.ch_cue"),
            ch,
            0x54,
            FeedbackKey::ChannelCue { channel: d },
        );
        p.led(
            &n("led.vinyl"),
            ch,
            0x17,
            FeedbackKey::VinylMode { deck: d },
        );
        p.led(&n("led.loaded"), 16, d, FeedbackKey::Loaded { deck: d });
        p.m.outputs.push(OutputDef {
            id: n("meter"),
            channel: ch,
            message: OutMessage::Cc,
            number: 0x02,
            source: FeedbackKey::Vu { channel: d },
            side: None,
            kind: OutputKind::Meter { min: 0, max: 0x7F },
        });
    }

    // Beat FX (ch 5 / 6). The CH SELECT slide switch reports both positions as note on/off.
    p.btn(
        "fx.assign_ch1",
        5,
        0x10,
        fx(FxAction::Assign {
            unit: 0,
            channel: 0,
            on: false,
        }),
    )
    .trigger = Trigger::Both;
    p.btn(
        "fx.assign_ch2",
        6,
        0x11,
        fx(FxAction::Assign {
            unit: 0,
            channel: 1,
            on: false,
        }),
    )
    .trigger = Trigger::Both;
    p.btn(
        "fx.select",
        5,
        0x63,
        fx(FxAction::Select {
            unit: 0,
            direction: 1,
        }),
    );
    p.btn(
        "fx.beat_left",
        5,
        0x4A,
        fx(FxAction::Beats {
            unit: 0,
            direction: -1,
        }),
    );
    p.btn(
        "fx.beat_right",
        5,
        0x4B,
        fx(FxAction::Beats {
            unit: 0,
            direction: 1,
        }),
    );
    if !rb {
        p.btn(
            "fx.shift_beat_left",
            5,
            0x66,
            fx(FxAction::TapReset { unit: 0 }),
        );
        p.btn(
            "fx.shift_beat_right",
            5,
            0x6B,
            fx(FxAction::TapTempo { unit: 0 }),
        );
    }
    p.knob(
        "fx.level_depth",
        5,
        0x02,
        fx(FxAction::Level {
            unit: 0,
            value: 0.0,
        }),
        [0.0, 1.0],
    );
    p.btn("fx.on_off_ch1", 5, 0x47, fx(FxAction::Toggle { unit: 0 }));
    p.btn("fx.on_off_ch2", 6, 0x47, fx(FxAction::Toggle { unit: 0 }));

    // Mixer / master (ch 7).
    p.knob(
        "mixer.master_level",
        7,
        0x08,
        mixer(MixerAction::MasterVolume { value: 0.0 }),
        [0.0, 1.0],
    );
    p.btn("mixer.master_cue", 7, 0x63, mixer(MixerAction::MasterCue));
    p.knob(
        "mixer.crossfader",
        7,
        0x1F,
        mixer(MixerAction::Crossfader { value: 0.0 }),
        [0.0, 1.0],
    );
    p.knob(
        "mixer.mic_level",
        7,
        0x05,
        mixer(MixerAction::MicLevel { value: 0.0 }),
        [0.0, 1.0],
    );
    p.knob(
        "mixer.hp_mix",
        7,
        0x0C,
        mixer(MixerAction::HeadphoneMix { value: 0.0 }),
        [0.0, 1.0],
    );
    p.knob(
        "mixer.hp_level",
        7,
        0x0D,
        mixer(MixerAction::HeadphoneLevel { value: 0.0 }),
        [0.0, 1.0],
    );
    p.btn("mixer.smart_cfx", 7, 0x00, mixer(MixerAction::SmartCfx));
    p.btn("mixer.smart_fader", 7, 0x01, mixer(MixerAction::SmartFader));
    p.led(
        "led.smart_cfx",
        7,
        0x00,
        FeedbackKey::Custom {
            name: "smart_cfx".into(),
        },
    );
    p.led(
        "led.smart_fader",
        7,
        0x01,
        FeedbackKey::Custom {
            name: "smart_fader".into(),
        },
    );

    // Browser: two's complement ("clockwise increases from 0x01, counter-clockwise from 0x7F").
    let i = p.input(
        "browse.rotate",
        Some(7),
        InputKind::Cc {
            cc: 0x40,
            relative: Some(RelativeEncoding::TwosComplement),
        },
    );
    p.bind(&i, lib(LibraryAction::Scroll { delta: 0.0 }));
    let i = p.input(
        "browse.shift_rotate",
        Some(7),
        InputKind::Cc {
            cc: 0x64,
            relative: Some(RelativeEncoding::TwosComplement),
        },
    );
    p.bind(&i, lib(LibraryAction::ScrollFast { delta: 0.0 }));
    p.btn("browse.press", 7, 0x41, lib(LibraryAction::FocusNext));
    p.btn(
        "browse.shift_press",
        7,
        0x42,
        lib(LibraryAction::FocusPrevious),
    );
    p.btn(
        "browse.load1",
        7,
        0x46,
        lib(LibraryAction::Load { deck: 0 }),
    );
    p.btn(
        "browse.load2",
        7,
        0x47,
        lib(LibraryAction::Load { deck: 1 }),
    );
    if !rb {
        p.btn(
            "browse.shift_load1",
            7,
            0x68,
            lib(LibraryAction::Sort {
                column: SortColumn::Bpm,
            }),
        );
        p.btn(
            "browse.shift_load2",
            7,
            0x7A,
            lib(LibraryAction::Sort {
                column: SortColumn::Artist,
            }),
        );
    }
    p.done()
}

/// Both FLX4 layouts send byte-identical MIDI (one official message list, no mode switch on
/// the unit), so the layout cannot be inferred from traffic. Resolution order: an explicit
/// preference (`"serato"` / `"rekordbox"`, case-insensitive, e.g. the user's last choice or
/// the DJ software they imported a library from), then a port-name hint, else rekordbox.
pub fn flx4_layout(device: &DeviceInfo, preference: Option<&str>) -> Flx4Layout {
    let pick = |s: &str| {
        let s = s.to_ascii_lowercase();
        if s.contains("serato") {
            Some(Flx4Layout::Serato)
        } else if s.contains("rekordbox") {
            Some(Flx4Layout::Rekordbox)
        } else {
            None
        }
    };
    preference
        .and_then(pick)
        .or_else(|| pick(&device.port_name))
        .unwrap_or(Flx4Layout::Rekordbox)
}

// ---- Novation Circuit Tracks -----------------------------------------------------------------

/// Circuit Tracks: synth 1 / 2 on ch 1 / 2 (scale-locked instruments, macros CC 80–87 → FX
/// params of FX units 0 / 1), drums on ch 10 (notes 60, 62, 64, 65 → sampler slots 0–3, or
/// hot cues 1–4 of deck 1 while the virtual modifier `drums_to_cues` is set), project ch 16
/// (programme change 0–63 instant / 64–127 queued pattern select, CC 74 / 71 master filter).
/// `clock_master = false` → the Circuit drives tempo (engine follows); `true` → the engine
/// sends clock to the Circuit.
pub fn circuit_tracks(clock_master: bool) -> MappingFile {
    let (id, name, priority) = if clock_master {
        (
            "novation-circuit-tracks-clock-out",
            "Novation Circuit Tracks (MixAI sends clock)",
            0,
        )
    } else {
        (
            "novation-circuit-tracks",
            "Novation Circuit Tracks (Circuit sends clock)",
            1,
        )
    };
    let mut p = P::new(
        id,
        name,
        Some("Novation"),
        DeviceMatch {
            name_regex: Some(r"(?i)circuit\s*tracks".into()),
            usb: vec![UsbId {
                vendor_id: NOVATION_USB_VID,
                product_id: None,
            }],
            sysex_identity: Some(IdentityMatch {
                manufacturer: NOVATION_SYSEX_ID.to_vec(),
                family: None,
                member: None,
            }),
            priority,
            fallback: false,
        },
    );
    p.m.description = Some("Groovebox companion: drums → sampler / hot cues, synths → scale-locked instruments in the track key, macros → FX parameters, project channel → pattern select + master filter, MIDI clock in or out, groove-lane recording.".into());
    p.m.sources = vec![
        CIRCUIT_TRACKS_PRG_URL.into(),
        CIRCUIT_TRACKS_PRG_MIRROR_URL.into(),
    ];
    p.m.clock = Some(ClockConfig {
        receive: !clock_master,
        send: clock_master,
    });
    p.m.groove = Some(GrooveConfig {
        channels: vec![1, 2, 10],
        quantize_ticks: 24,
        bars: 4,
    });
    p.m.modifiers.push(ModifierDef {
        id: "drums_to_cues".into(),
        input: None,
        toggle: false,
    });

    let lock = ScaleLockDef {
        follow_track_key: true,
        key: 0,
        mode: ScaleMode::Minor,
    };
    for synth in 0u8..2 {
        let ch = synth + 1;
        let i = p.input(
            &format!("synth{ch}.keys"),
            Some(ch),
            InputKind::NoteRange {
                first: 0,
                last: 127,
            },
        );
        p.bind(
            &i,
            smp(SamplerAction::Note {
                instrument: synth,
                note: 0,
                velocity: 0.0,
                pressed: false,
            }),
        )
        .scale_lock = Some(lock);
        for k in 0u8..8 {
            let i = p.input(
                &format!("synth{ch}.macro{}", k + 1),
                Some(ch),
                InputKind::Cc {
                    cc: 80 + k,
                    relative: None,
                },
            );
            p.bind(
                &i,
                fx(FxAction::Param {
                    unit: synth,
                    index: k,
                    value: 0.0,
                }),
            )
            .soft_takeover = true;
        }
    }
    for (k, note) in [60u8, 62, 64, 65].into_iter().enumerate() {
        let k = k as u8;
        let i = p.note(&format!("drum{}", k + 1), 10, note);
        p.bind(
            &i,
            smp(SamplerAction::Trigger {
                slot: k,
                velocity: 0.0,
                pressed: false,
            }),
        );
        let b = p.bind(
            &i,
            deck(DeckAction::HotCue {
                deck: 0,
                slot: k,
                pressed: false,
            }),
        );
        b.when = Condition {
            modifiers: vec!["drums_to_cues".into()],
            exact: false,
            pad_mode: None,
        };
    }
    let i = p.input(
        "project.select",
        Some(16),
        InputKind::ProgramChange { first: 0, last: 63 },
    );
    p.bind(
        &i,
        smp(SamplerAction::SelectPattern {
            index: 0,
            queued: false,
        }),
    );
    let i = p.input(
        "project.select_queued",
        Some(16),
        InputKind::ProgramChange {
            first: 64,
            last: 127,
        },
    );
    p.bind(
        &i,
        smp(SamplerAction::SelectPattern {
            index: 0,
            queued: true,
        }),
    );
    let i = p.input(
        "project.master_filter",
        Some(16),
        InputKind::Cc {
            cc: 74,
            relative: None,
        },
    );
    p.bind(&i, mixer(MixerAction::MasterFilter { value: 0.0 }))
        .soft_takeover = true;
    let i = p.input(
        "project.filter_resonance",
        Some(16),
        InputKind::Cc {
            cc: 71,
            relative: None,
        },
    );
    p.bind(&i, mixer(MixerAction::MasterFilterResonance { value: 0.0 }))
        .soft_takeover = true;
    p.done()
}

// ---- generic profiles -----------------------------------------------------------------------

/// Generic USB / BLE MIDI keyboard (omni): keys → scale-locked instrument 0 in the track key,
/// pitch bend → deck 1 jog bend, mod wheel (CC 1) → FX unit 0 param 0, sustain (CC 64) →
/// virtual `sampler` modifier: while held, keys 36–51 trigger sampler slots 0–15 instead.
pub fn generic_keyboard() -> MappingFile {
    let mut p = P::new(
        "generic-midi-keyboard",
        "Generic MIDI keyboard",
        None,
        DeviceMatch {
            name_regex: Some(
                r"(?i)(keyboard|keys|keystation|keystep|launchkey|mpk|oxygen|minilab|piano|synth)"
                    .into(),
            ),
            priority: -1,
            ..Default::default()
        },
    );
    p.m.description = Some("Keys play a scale-locked instrument in the playing track's key; hold sustain to play the sampler.".into());
    let lock = ScaleLockDef {
        follow_track_key: true,
        key: 0,
        mode: ScaleMode::Major,
    };
    let note = smp(SamplerAction::Note {
        instrument: 0,
        note: 0,
        velocity: 0.0,
        pressed: false,
    });
    // Three ranges so 36..51 can switch to the sampler while sustain is held: the binding
    // with more satisfied modifiers wins within one input (see `Condition`).
    for (id, first, last) in [
        ("keys.low", 0u8, 35u8),
        ("keys.mid", 36, 51),
        ("keys.high", 52, 127),
    ] {
        let i = p.input(id, None, InputKind::NoteRange { first, last });
        p.bind(&i, note.clone()).scale_lock = Some(lock);
    }
    let b = p.bind(
        "keys.mid",
        smp(SamplerAction::Trigger {
            slot: 0,
            velocity: 0.0,
            pressed: false,
        }),
    );
    b.when = Condition {
        modifiers: vec!["sampler".into()],
        exact: false,
        pad_mode: None,
    };
    let sustain = p.input(
        "sustain",
        None,
        InputKind::Cc {
            cc: 64,
            relative: None,
        },
    );
    p.m.modifiers.push(ModifierDef {
        id: "sampler".into(),
        input: Some(sustain),
        toggle: false,
    });
    let pb = p.input("pitch_bend", None, InputKind::PitchBend);
    p.bind(
        &pb,
        deck(DeckAction::Tempo {
            deck: 0,
            value: 0.0,
        }),
    )
    .transform
    .range = [-0.08, 0.08];
    let mw = p.input(
        "mod_wheel",
        None,
        InputKind::Cc {
            cc: 1,
            relative: None,
        },
    );
    p.bind(
        &mw,
        fx(FxAction::Param {
            unit: 0,
            index: 0,
            value: 0.0,
        }),
    )
    .soft_takeover = true;
    p.done()
}

/// Generic 2-deck fallback for unknown controllers (MixAI convention, documented in
/// `docs/decks/mapping-format.md`). Side A = channel 1, side B = channel 2; each side can switch
/// between decks (A: 1 ↔ 3, B: 2 ↔ 4) with note 13. Note 12 is a software SHIFT.
pub fn generic_two_deck() -> MappingFile {
    let mut p = P::new(
        "generic-2-deck",
        "Generic 2-deck controller",
        None,
        DeviceMatch {
            fallback: true,
            priority: -10,
            ..Default::default()
        },
    );
    p.m.description = Some("Fallback layout: per side ch 1 / 2 — notes 0 play, 1 cue, 2 sync, 3 headphone cue, 4–11 hot cues (SHIFT = delete), 12 shift, 13 deck switch, 14 jog touch; CC 7 volume, 8/9/10 EQ hi/mid/low, 11 filter, 12 tempo, 16 jog (offset-64, SHIFT = search). Ch 1 CC 20 crossfader, CC 21 master, CC 22 browse (two's complement), notes 20/21 load A/B, note 22 tap tempo.".into());
    for side in 0u8..2 {
        let ch = side + 1;
        let n = |s: &str| format!("side{}.{s}", side + 1);
        p.m.deck_layers.push(DeckLayerDef {
            side,
            decks: vec![side, side + 2],
            input: Some(n("deck_switch")),
        });
        p.note(&n("deck_switch"), ch, 13);
        let shift = p.note(&n("shift"), ch, 12);
        p.m.modifiers.push(ModifierDef {
            id: format!("shift{}", side + 1),
            input: Some(shift),
            toggle: false,
        });
        let sh = format!("shift{}", side + 1);
        p.btn(
            &n("play"),
            ch,
            0,
            deck(DeckAction::PlayPause { deck: side }),
        )
        .side = Some(side);
        p.btn(
            &n("cue"),
            ch,
            1,
            deck(DeckAction::Cue {
                deck: side,
                pressed: false,
            }),
        )
        .side = Some(side);
        p.btn(&n("sync"), ch, 2, deck(DeckAction::Sync { deck: side }))
            .side = Some(side);
        p.btn(
            &n("hp_cue"),
            ch,
            3,
            mixer(MixerAction::HeadphoneCue { channel: side }),
        )
        .side = Some(side);
        for k in 0u8..8 {
            let i = p.note(&n(&format!("pad{}", k + 1)), ch, 4 + k);
            p.bind(
                &i,
                deck(DeckAction::HotCue {
                    deck: side,
                    slot: k,
                    pressed: false,
                }),
            )
            .side = Some(side);
            let b = p.bind(
                &i,
                deck(DeckAction::HotCueDelete {
                    deck: side,
                    slot: k,
                }),
            );
            b.side = Some(side);
            b.when = Condition {
                modifiers: vec![sh.clone()],
                exact: false,
                pad_mode: None,
            };
        }
        p.btn(
            &n("jog_touch"),
            ch,
            14,
            deck(DeckAction::JogTouch {
                deck: side,
                pressed: false,
            }),
        )
        .side = Some(side);
        let jog = p.input(
            &n("jog"),
            Some(ch),
            InputKind::Jog {
                cc: 16,
                encoding: RelativeEncoding::Offset64,
            },
        );
        p.bind(
            &jog,
            deck(DeckAction::JogScratch {
                deck: side,
                delta: 0.0,
            }),
        )
        .side = Some(side);
        let b = p.bind(
            &jog,
            deck(DeckAction::JogSearch {
                deck: side,
                delta: 0.0,
            }),
        );
        b.side = Some(side);
        b.when = Condition {
            modifiers: vec![sh.clone()],
            exact: false,
            pad_mode: None,
        };
        for (cc, nm, action) in [
            (
                7u8,
                "volume",
                mixer(MixerAction::Volume {
                    channel: side,
                    value: 0.0,
                }),
            ),
            (
                8,
                "eq_hi",
                mixer(MixerAction::Eq {
                    channel: side,
                    band: EqBand::High,
                    value: 0.0,
                }),
            ),
            (
                9,
                "eq_mid",
                mixer(MixerAction::Eq {
                    channel: side,
                    band: EqBand::Mid,
                    value: 0.0,
                }),
            ),
            (
                10,
                "eq_low",
                mixer(MixerAction::Eq {
                    channel: side,
                    band: EqBand::Low,
                    value: 0.0,
                }),
            ),
            (
                11,
                "filter",
                mixer(MixerAction::Filter {
                    channel: side,
                    value: 0.0,
                }),
            ),
            (
                12,
                "tempo",
                deck(DeckAction::Tempo {
                    deck: side,
                    value: 0.0,
                }),
            ),
        ] {
            let i = p.input(&n(nm), Some(ch), InputKind::Cc { cc, relative: None });
            let b = p.bind(&i, action);
            b.side = Some(side);
            b.soft_takeover = true;
            if nm == "volume" {
                b.transform.curve = Curve::Log;
            }
            if nm == "tempo" {
                b.transform.range = [-1.0, 1.0];
            }
        }
        p.m.outputs.push(OutputDef {
            id: n("led.play"),
            channel: ch,
            message: OutMessage::Note,
            number: 0,
            source: FeedbackKey::Playing { deck: side },
            side: Some(side),
            kind: OutputKind::Led { on: 0x7F, off: 0 },
        });
    }
    let i = p.input(
        "crossfader",
        Some(1),
        InputKind::Cc {
            cc: 20,
            relative: None,
        },
    );
    p.bind(&i, mixer(MixerAction::Crossfader { value: 0.0 }))
        .soft_takeover = true;
    let i = p.input(
        "master",
        Some(1),
        InputKind::Cc {
            cc: 21,
            relative: None,
        },
    );
    p.bind(&i, mixer(MixerAction::MasterVolume { value: 0.0 }))
        .soft_takeover = true;
    let i = p.input(
        "browse",
        Some(1),
        InputKind::Cc {
            cc: 22,
            relative: Some(RelativeEncoding::TwosComplement),
        },
    );
    p.bind(&i, lib(LibraryAction::Scroll { delta: 0.0 }));
    p.btn("load_a", 1, 20, lib(LibraryAction::Load { deck: 0 }))
        .side = Some(0);
    p.btn("load_b", 1, 21, lib(LibraryAction::Load { deck: 1 }))
        .side = Some(1);
    p.btn("tap", 1, 22, Action::Clock(ClockAction::Tap));
    p.done()
}

/// Every built-in profile.
pub fn builtin() -> Vec<MappingFile> {
    vec![
        ddj_flx4(Flx4Layout::Rekordbox),
        ddj_flx4(Flx4Layout::Serato),
        circuit_tracks(false),
        circuit_tracks(true),
        generic_keyboard(),
        generic_two_deck(),
    ]
}

/// Best built-in profile for a device (highest [`DeviceMatch::score`]). For the FLX4 use
/// [`flx4_layout`] to choose between the two layouts when the user has a preference.
pub fn detect(device: &DeviceInfo) -> MappingFile {
    builtin()
        .into_iter()
        .filter_map(|m| m.device.score(device).map(|s| (s, m)))
        .max_by_key(|(s, _)| *s)
        .map(|(_, m)| m)
        .unwrap_or_else(generic_two_deck)
}
