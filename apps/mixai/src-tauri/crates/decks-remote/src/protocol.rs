//! Wire messages (JSON over the WebSocket) and the published deck state.

use serde::{Deserialize, Serialize};

use crate::party::PublicRequest;

/// Decks the remote can address (`0..MAX_DECKS`).
pub const MAX_DECKS: u8 = 4;

/// What a connected device may do. Each role has its own token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// Phone remote: full deck control + request moderation.
    Controller,
    /// Second screen: read-only deck state.
    Viewer,
    /// Party guest: now playing + song requests and votes.
    Guest,
}

impl Role {
    pub const ALL: [Role; 3] = [Role::Controller, Role::Viewer, Role::Guest];

    pub(crate) fn index(self) -> usize {
        match self {
            Role::Controller => 0,
            Role::Viewer => 1,
            Role::Guest => 2,
        }
    }

    /// Page served for this role.
    pub fn path(self) -> &'static str {
        match self {
            Role::Controller | Role::Viewer => "/",
            Role::Guest => "/party",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EqBand {
    Low,
    Mid,
    High,
}

/// A validated control command for the engine. The app drains these and maps each to the
/// matching `DecksEngine` call; values are already range-checked by [`RemoteCommand::validated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum RemoteCommand {
    Play {
        deck: u8,
    },
    Pause {
        deck: u8,
    },
    /// CDJ-style cue button (press / release).
    Cue {
        deck: u8,
        pressed: bool,
    },
    HotCue {
        deck: u8,
        slot: u8,
    },
    /// Auto loop of `beats` (1/32 .. 64).
    LoopAuto {
        deck: u8,
        beats: f64,
    },
    LoopExit {
        deck: u8,
    },
    /// Beat jump of ± `beats` (|beats| ≤ 128).
    BeatJump {
        deck: u8,
        beats: f64,
    },
    /// Phase sync to the master clock; `lock` keeps following it.
    Sync {
        deck: u8,
        lock: bool,
    },
    /// Channel fader 0..1.
    Volume {
        deck: u8,
        value: f32,
    },
    /// EQ band gain in dB (−26 kill .. +6).
    Eq {
        deck: u8,
        band: EqBand,
        db: f32,
    },
    /// Bipolar filter −1 .. 1.
    Filter {
        deck: u8,
        value: f32,
    },
    /// Crossfader −1 (A) .. 1 (B).
    Crossfader {
        value: f32,
    },
    /// Master volume 0..1.
    MasterVolume {
        value: f32,
    },
}

fn check_deck(deck: u8) -> Result<(), String> {
    if deck < MAX_DECKS {
        Ok(())
    } else {
        Err(format!("deck {deck} out of range 0..{MAX_DECKS}"))
    }
}

fn finite32(name: &str, v: f32) -> Result<f32, String> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err(format!("{name} must be finite"))
    }
}

fn finite64(name: &str, v: f64) -> Result<f64, String> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err(format!("{name} must be finite"))
    }
}

impl RemoteCommand {
    /// Still taken while the DJ has locked the phone controls: only letting go of CUE, so a
    /// deck that plays because CUE is held stops when the finger lifts.
    pub fn allowed_when_locked(&self) -> bool {
        matches!(self, RemoteCommand::Cue { pressed: false, .. })
    }

    /// The deck this command addresses (`None` for mixer-wide commands).
    pub fn deck(&self) -> Option<u8> {
        match *self {
            RemoteCommand::Play { deck }
            | RemoteCommand::Pause { deck }
            | RemoteCommand::Cue { deck, .. }
            | RemoteCommand::HotCue { deck, .. }
            | RemoteCommand::LoopAuto { deck, .. }
            | RemoteCommand::LoopExit { deck }
            | RemoteCommand::BeatJump { deck, .. }
            | RemoteCommand::Sync { deck, .. }
            | RemoteCommand::Volume { deck, .. }
            | RemoteCommand::Eq { deck, .. }
            | RemoteCommand::Filter { deck, .. } => Some(deck),
            RemoteCommand::Crossfader { .. } | RemoteCommand::MasterVolume { .. } => None,
        }
    }

    /// Range-check and clamp. Out-of-range decks/slots and non-finite numbers are rejected;
    /// continuous controls are clamped to their engine range.
    pub fn validated(self) -> Result<Self, String> {
        if let Some(d) = self.deck() {
            check_deck(d)?;
        }
        Ok(match self {
            RemoteCommand::HotCue { deck, slot } => {
                if slot >= 8 {
                    return Err(format!("hot cue slot {slot} out of range 0..8"));
                }
                RemoteCommand::HotCue { deck, slot }
            }
            RemoteCommand::LoopAuto { deck, beats } => {
                let b = finite64("beats", beats)?;
                if !(1.0 / 32.0..=64.0).contains(&b) {
                    return Err(format!("loop of {b} beats out of range 1/32..64"));
                }
                RemoteCommand::LoopAuto { deck, beats: b }
            }
            RemoteCommand::BeatJump { deck, beats } => {
                let b = finite64("beats", beats)?;
                if b == 0.0 || b.abs() > 128.0 {
                    return Err(format!("beat jump of {b} out of range ±128 (non-zero)"));
                }
                RemoteCommand::BeatJump { deck, beats: b }
            }
            RemoteCommand::Volume { deck, value } => RemoteCommand::Volume {
                deck,
                value: finite32("value", value)?.clamp(0.0, 1.0),
            },
            RemoteCommand::Eq { deck, band, db } => RemoteCommand::Eq {
                deck,
                band,
                db: finite32("db", db)?.clamp(-26.0, 6.0),
            },
            RemoteCommand::Filter { deck, value } => RemoteCommand::Filter {
                deck,
                value: finite32("value", value)?.clamp(-1.0, 1.0),
            },
            RemoteCommand::Crossfader { value } => RemoteCommand::Crossfader {
                value: finite32("value", value)?.clamp(-1.0, 1.0),
            },
            RemoteCommand::MasterVolume { value } => RemoteCommand::MasterVolume {
                value: finite32("value", value)?.clamp(0.0, 1.0),
            },
            other => other,
        })
    }
}

/// One deck as shown on the remote / second screen.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RemoteDeck {
    pub deck: u8,
    pub loaded: bool,
    pub title: Option<String>,
    pub artist: Option<String>,
    /// Effective BPM (after tempo).
    pub bpm: Option<f64>,
    /// Effective key (Camelot, after shift).
    pub key: Option<String>,
    pub position_sec: f64,
    pub duration_sec: f64,
    pub playing: bool,
    pub volume: f32,
    pub eq_low: f32,
    pub eq_mid: f32,
    pub eq_high: f32,
    pub filter: f32,
    pub loop_active: bool,
    pub sync_lock: bool,
    /// Bar phase 0..1 when downbeats are known.
    pub bar_phase: Option<f64>,
    pub vu: f32,
}

/// Everything the remote shows. The app publishes it at ~10–20 Hz with
/// [`crate::RemoteServer::publish`]; unchanged states are not re-sent.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RemoteState {
    pub decks: Vec<RemoteDeck>,
    pub crossfader: f32,
    pub master_volume: f32,
    pub master_bpm: f64,
    pub recording: bool,
}

impl RemoteState {
    /// Titles of the decks that are playing (what guests see).
    pub fn now_playing(&self) -> Vec<String> {
        self.decks
            .iter()
            .filter(|d| d.playing && d.volume > 0.0)
            .filter_map(|d| match (&d.title, &d.artist) {
                (Some(t), Some(a)) if !a.is_empty() => Some(format!("{a} — {t}")),
                (Some(t), _) => Some(t.clone()),
                _ => None,
            })
            .collect()
    }
}

/// Browser → app.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    /// Controller only.
    Command {
        command: RemoteCommand,
    },
    /// Guest (and controller): request a song.
    Request {
        title: String,
        #[serde(default)]
        artist: String,
        #[serde(default)]
        note: String,
    },
    /// Guest (and controller): vote for a pending request.
    Vote {
        id: u64,
    },
    /// Controller only: accept / reject / mark played.
    Moderate {
        id: u64,
        action: ModerateAction,
    },
    Ping,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModerateAction {
    Accept,
    Reject,
    Played,
}

/// App → browser.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Hello {
        protocol: u32,
        role: Role,
        client: String,
        party_open: bool,
    },
    /// Controller / viewer.
    State {
        state: RemoteState,
    },
    /// Guest.
    NowPlaying {
        titles: Vec<String>,
    },
    /// Request queue as this client may see it.
    Requests {
        party_open: bool,
        items: Vec<PublicRequest>,
    },
    /// A request was taken (guest feedback).
    Requested {
        id: u64,
        merged: bool,
    },
    /// Controller: the DJ locked (or unlocked) the phone controls. While locked, commands are
    /// refused (except releasing CUE); requests and moderation keep working.
    Controls {
        locked: bool,
    },
    Error {
        reason: String,
    },
    Pong,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_round_trip_as_tagged_json() {
        let c = RemoteCommand::Eq {
            deck: 1,
            band: EqBand::Low,
            db: -26.0,
        };
        let j = serde_json::to_string(&c).unwrap();
        assert_eq!(j, r#"{"cmd":"eq","deck":1,"band":"low","db":-26.0}"#);
        assert_eq!(serde_json::from_str::<RemoteCommand>(&j).unwrap(), c);
        let m: ClientMsg =
            serde_json::from_str(r#"{"type":"command","command":{"cmd":"play","deck":0}}"#)
                .unwrap();
        assert_eq!(
            m,
            ClientMsg::Command {
                command: RemoteCommand::Play { deck: 0 }
            }
        );
    }

    #[test]
    fn validation_rejects_bad_decks_slots_and_numbers() {
        assert!(RemoteCommand::Play { deck: 4 }.validated().is_err());
        assert!(
            RemoteCommand::HotCue { deck: 0, slot: 8 }
                .validated()
                .is_err()
        );
        assert!(
            RemoteCommand::LoopAuto {
                deck: 0,
                beats: 0.0
            }
            .validated()
            .is_err()
        );
        assert!(
            RemoteCommand::BeatJump {
                deck: 0,
                beats: f64::NAN
            }
            .validated()
            .is_err()
        );
        assert!(
            RemoteCommand::Volume {
                deck: 0,
                value: f32::INFINITY
            }
            .validated()
            .is_err()
        );
    }

    #[test]
    fn validation_clamps_continuous_controls() {
        assert_eq!(
            RemoteCommand::Volume {
                deck: 2,
                value: 1.7
            }
            .validated()
            .unwrap(),
            RemoteCommand::Volume {
                deck: 2,
                value: 1.0
            }
        );
        assert_eq!(
            RemoteCommand::Eq {
                deck: 0,
                band: EqBand::High,
                db: -90.0
            }
            .validated()
            .unwrap(),
            RemoteCommand::Eq {
                deck: 0,
                band: EqBand::High,
                db: -26.0
            }
        );
        assert_eq!(
            RemoteCommand::Crossfader { value: -3.0 }
                .validated()
                .unwrap(),
            RemoteCommand::Crossfader { value: -1.0 }
        );
    }

    /// Every command that carries a number, built from one value.
    fn numeric_commands(v: f64) -> Vec<RemoteCommand> {
        let f = v as f32;
        let mut out = vec![
            RemoteCommand::LoopAuto { deck: 0, beats: v },
            RemoteCommand::BeatJump { deck: 0, beats: v },
            RemoteCommand::Volume { deck: 0, value: f },
            RemoteCommand::Filter { deck: 0, value: f },
            RemoteCommand::Crossfader { value: f },
            RemoteCommand::MasterVolume { value: f },
        ];
        for band in [EqBand::Low, EqBand::Mid, EqBand::High] {
            out.push(RemoteCommand::Eq {
                deck: 0,
                band,
                db: f,
            });
        }
        out
    }

    /// The number a validated command carries and the range the engine takes.
    fn value_and_range(c: &RemoteCommand) -> (f64, f64, f64) {
        match *c {
            RemoteCommand::LoopAuto { beats, .. } => (beats, 1.0 / 32.0, 64.0),
            RemoteCommand::BeatJump { beats, .. } => (beats, -128.0, 128.0),
            RemoteCommand::Volume { value, .. } => (f64::from(value), 0.0, 1.0),
            RemoteCommand::Eq { db, .. } => (f64::from(db), -26.0, 6.0),
            RemoteCommand::Filter { value, .. } => (f64::from(value), -1.0, 1.0),
            RemoteCommand::Crossfader { value } => (f64::from(value), -1.0, 1.0),
            RemoteCommand::MasterVolume { value } => (f64::from(value), 0.0, 1.0),
            _ => unreachable!("not a numeric command"),
        }
    }

    #[test]
    fn every_numeric_command_refuses_non_finite_and_never_passes_a_value_out_of_range() {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            for c in numeric_commands(bad) {
                assert!(c.clone().validated().is_err(), "{c:?}");
            }
        }
        for wild in [
            -1e30, -1000.0, -129.0, -1.5, 0.0, 1.5, 65.0, 129.0, 1000.0, 1e30,
        ] {
            for c in numeric_commands(wild) {
                // Refused, or clamped into the range: never handed on as it came.
                if let Ok(ok) = c.clone().validated() {
                    let (v, lo, hi) = value_and_range(&ok);
                    assert!(v.is_finite() && (lo..=hi).contains(&v), "{c:?} -> {ok:?}");
                }
            }
        }
        // The refusals that are not clamps.
        for beats in [0.0, 1.0 / 64.0, 64.5, -4.0] {
            let c = RemoteCommand::LoopAuto { deck: 0, beats };
            assert!(c.validated().is_err(), "loop of {beats}");
        }
        for beats in [0.0, 128.5, -128.5] {
            let c = RemoteCommand::BeatJump { deck: 0, beats };
            assert!(c.validated().is_err(), "jump of {beats}");
        }
        // A number that is not one never parses into a command either.
        for json in [
            r#"{"cmd":"volume","deck":0,"value":null}"#,
            r#"{"cmd":"volume","deck":0,"value":"1"}"#,
            r#"{"cmd":"volume","deck":0,"value":NaN}"#,
            r#"{"cmd":"crossfader","value":1e999}"#,
            r#"{"cmd":"hot_cue","deck":0,"slot":-1}"#,
            r#"{"cmd":"hot_cue","deck":0,"slot":256}"#,
            r#"{"cmd":"play","deck":1.5}"#,
        ] {
            let parsed = serde_json::from_str::<RemoteCommand>(json)
                .ok()
                .and_then(|c| c.validated().ok());
            assert_eq!(parsed, None, "{json}");
        }
    }

    #[test]
    fn only_a_cue_release_passes_the_controls_lock() {
        assert!(
            RemoteCommand::Cue {
                deck: 0,
                pressed: false
            }
            .allowed_when_locked()
        );
        for c in [
            RemoteCommand::Cue {
                deck: 0,
                pressed: true,
            },
            RemoteCommand::Play { deck: 0 },
            RemoteCommand::Pause { deck: 0 },
            RemoteCommand::HotCue { deck: 0, slot: 0 },
            RemoteCommand::LoopExit { deck: 0 },
            RemoteCommand::Sync {
                deck: 0,
                lock: false,
            },
        ]
        .into_iter()
        .chain(numeric_commands(0.5))
        {
            assert!(!c.allowed_when_locked(), "{c:?}");
        }
        assert_eq!(
            serde_json::to_string(&ServerMsg::Controls { locked: true }).unwrap(),
            r#"{"type":"controls","locked":true}"#
        );
    }

    #[test]
    fn now_playing_lists_audible_playing_decks() {
        let s = RemoteState {
            decks: vec![
                RemoteDeck {
                    deck: 0,
                    title: Some("Strobe".into()),
                    artist: Some("deadmau5".into()),
                    playing: true,
                    volume: 1.0,
                    ..Default::default()
                },
                RemoteDeck {
                    deck: 1,
                    title: Some("Cued".into()),
                    playing: true,
                    volume: 0.0,
                    ..Default::default()
                },
                RemoteDeck {
                    deck: 2,
                    title: Some("Stopped".into()),
                    volume: 1.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert_eq!(s.now_playing(), vec!["deadmau5 — Strobe".to_string()]);
    }
}
