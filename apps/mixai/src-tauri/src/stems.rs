//! Stem performance commands of the desktop shell (WP19-41): per-stem crossfader, stem mute FX
//! with echo tails, and loops stored on hot cues. The engine side lives in `mixai-core`
//! (`Deck::set_stem_mute` / `set_stem_xf` / `set_stem_mute_fx` / `save_cue_loop`).
//!
//! Parent-module items in scope: `super::parse_deck`, `super::with_engine`, `super::EngineState`.
//! The command names below are registered in `lib.rs`.

use mixai_core::deck::{STEM_MUTE_FX_BEATS_MAX, STEM_MUTE_FX_BEATS_MIN};
use mixai_core::{Command, DeckId, Engine};
use tauri::State;

use super::{EngineState, parse_deck, with_engine};

/// Stem layers per deck (vocals, drums, bass, melody).
const STEMS: usize = 4;
/// Hot cue slots per deck.
const HOT_CUES: usize = 8;

fn check_stem(idx: usize) -> Result<(), String> {
    if idx < STEMS {
        Ok(())
    } else {
        Err(format!("stem {idx} out of range 0..{STEMS}"))
    }
}

/// A stem crossfader position: finite and inside −1..1.
fn check_xf(value: f32) -> Result<(), String> {
    if value.is_finite() && (-1.0..=1.0).contains(&value) {
        Ok(())
    } else {
        Err(format!("stem crossfader {value} must be in -1..1"))
    }
}

/// A stem mute FX echo time: finite and inside 1/32..8 beats.
fn check_beats(beats: f64) -> Result<(), String> {
    if beats.is_finite() && (STEM_MUTE_FX_BEATS_MIN..=STEM_MUTE_FX_BEATS_MAX).contains(&beats) {
        Ok(())
    } else {
        Err(format!(
            "mute FX beats {beats} must be in {STEM_MUTE_FX_BEATS_MIN}..{STEM_MUTE_FX_BEATS_MAX}"
        ))
    }
}

fn check_slot(slot: usize) -> Result<(), String> {
    if slot < HOT_CUES {
        Ok(())
    } else {
        Err(format!("hot cue slot {slot} out of range 0..{HOT_CUES}"))
    }
}

/// Mute / unmute one stem: the UI mirror first, then the command for the audio thread. Both
/// follow the same rule (`mixai_core::state::stem_mute_step`): a mute keeps the level the stem
/// had and an unmute brings it back, so the level the UI shows is the level that is heard.
/// The command is sent even when the mirror had nothing to change: the deck decides.
fn stem_mute(engine: &Engine, deck: DeckId, idx: usize, on: bool) {
    engine.mirror().decks[deck.index()].mirror_stem_mute(idx, on);
    engine.send(Command::SetStemMute(deck, idx, on));
}

/// Mute (`on`) or unmute stem `idx` (0=vocals,1=drums,2=bass,3=melody). With the stem mute FX
/// on, a mute leaves an echo tail of the stem (not on a track without a tempo, on a paused deck
/// or in reverse: there it is a plain mute). An unmute returns to the level before the mute.
#[tauri::command]
pub fn deck_set_stem_mute(
    deck: String,
    idx: usize,
    on: bool,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    check_stem(idx)?;
    with_engine(&state, |e| stem_mute(e, deck, idx, on))
}

/// Stem crossfader of stem `idx`: −1 (side A) .. +1 (side B), 0 = the stem follows the deck.
#[tauri::command]
pub fn deck_set_stem_xf(
    deck: String,
    idx: usize,
    value: f32,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    check_stem(idx)?;
    check_xf(value)?;
    with_engine(&state, |e| e.set_stem_xf(deck, idx, value))
}

/// Stem mute FX on/off and its echo time in beats (1/32..8).
#[tauri::command]
pub fn deck_set_stem_mute_fx(
    deck: String,
    on: bool,
    beats: f64,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    check_beats(beats)?;
    with_engine(&state, |e| e.set_stem_mute_fx(deck, on, beats))
}

/// Cue loop: store the running loop on hot cue `slot` (0..7). The cue moves to the loop's
/// in-point and jumping to it starts the loop again.
#[tauri::command]
pub fn deck_save_cue_loop(
    deck: String,
    slot: usize,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    check_slot(slot)?;
    with_engine(&state, |e| e.save_cue_loop(deck, slot))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stem_arguments_are_range_checked() {
        assert!(check_stem(3).is_ok() && check_stem(4).is_err());
        assert!(check_slot(7).is_ok() && check_slot(8).is_err());
        for v in [-1.0f32, -0.5, 0.0, 1.0] {
            assert!(check_xf(v).is_ok(), "{v}");
        }
        for v in [-1.01f32, 2.0, f32::NAN, f32::INFINITY] {
            assert!(check_xf(v).is_err(), "{v}");
        }
        for b in [1.0 / 32.0, 0.25, 0.5, 1.0, 2.0, 8.0] {
            assert!(check_beats(b).is_ok(), "{b}");
        }
        for b in [0.0, 1.0 / 64.0, 9.0, f64::NAN, -1.0] {
            assert!(check_beats(b).is_err(), "{b}");
        }
    }

    #[test]
    fn stems_deck_state_round_trips_and_old_json_still_parses() {
        use mixai_core::{DeckId, DeckState};
        let mut d = DeckState::empty(DeckId::B);
        d.stem_xf = vec![-1.0, 0.0, 0.25, 1.0];
        d.stem_mute_fx = true;
        d.stem_mute_fx_beats = 2.0;
        d.hot_cue_loops[2] = Some(4.0);
        d.hot_cue_loops[7] = Some(0.5);
        // Bookkeeping of the mirror (the level an unmute brings back): never on the wire.
        d.stem_pre_mute = [0.3; 4];
        let json = serde_json::to_value(&d).unwrap();
        assert!(json.get("stemPreMute").is_none(), "{json}");
        // Wire names the UI reads (camelCase).
        assert_eq!(json["stemXf"], serde_json::json!([-1.0, 0.0, 0.25, 1.0]));
        assert_eq!(json["stemMuteFx"], serde_json::json!(true));
        assert_eq!(json["stemMuteFxBeats"], serde_json::json!(2.0));
        assert_eq!(
            json["hotCueLoops"],
            serde_json::json!([null, null, 4.0, null, null, null, null, 0.5])
        );
        let back: DeckState = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(back.stem_xf, d.stem_xf);
        assert!(back.stem_mute_fx);
        assert_eq!(back.stem_mute_fx_beats, 2.0);
        assert_eq!(back.hot_cue_loops, d.hot_cue_loops);
        assert_eq!(back.stem_pre_mute, [1.0; 4]);
        // A snapshot written before WP19-41 has none of the four fields: it parses with the defaults.
        let mut old = json;
        let obj = old.as_object_mut().unwrap();
        for key in ["stemXf", "stemMuteFx", "stemMuteFxBeats", "hotCueLoops"] {
            assert!(
                obj.remove(key).is_some(),
                "{key} missing from the wire form"
            );
        }
        let parsed: DeckState = serde_json::from_value(old).unwrap();
        assert_eq!(parsed.stem_xf, vec![0.0; 4]);
        assert!(!parsed.stem_mute_fx);
        assert_eq!(parsed.stem_mute_fx_beats, 0.5);
        assert_eq!(parsed.hot_cue_loops, vec![None; 8]);
        assert_eq!(parsed.stem_gains, d.stem_gains);
    }
}
