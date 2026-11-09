//! Key result for Decks, produced by the shared `crates/mixai-listen` engine (WP18-01).
//!
//! The key detector itself lives in `mixai-listen` (chroma + EDMA profiles, Faraldo et al. 2016,
//! with a GiantSteps-MTG-tuned minor bias, provisional after ~3 s and locked after ~8 s). This
//! module only maps its [`mixai_listen::Analysis`] into the serialisable [`KeyResult`] that the
//! Decks library stores, so every MixAI surface names a key the same way.

use mixai_listen::{Analysis as ListenAnalysis, Key};
use serde::{Deserialize, Serialize};

/// Key profile family behind a [`KeyResult`]. Only one exists: the shared engine's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyProfile {
    /// Faraldo et al. (2016) EDM profiles + minor bias, as implemented in `mixai-listen`.
    #[default]
    Edma,
}

/// Major or minor mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Major,
    Minor,
}

const PITCH_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/// Detected key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyResult {
    /// Tonic pitch class, 0 = C .. 11 = B.
    pub tonic: u8,
    pub mode: Mode,
    /// Sharp spelling, e.g. `"F#m"` / `"C"` (same convention as the server analyser).
    pub name: String,
    /// Camelot wheel code, `"1A"`..`"12B"` (B = major, 8B = C major).
    pub camelot: String,
    /// Open Key code, `"1d"`..`"12m"` (d = major, 1d = C major).
    pub open_key: String,
    /// 0..1, the shared engine's confidence (margin over the runner-up + profile fit).
    pub confidence: f32,
    /// The shared engine's profile correlation of the winning key. For minor keys it includes the
    /// engine's +0.09 minor bias, so it can exceed a plain Pearson correlation slightly.
    pub correlation: f32,
    /// Estimated tuning offset from A4 = 440 Hz, in cents (−50..50).
    pub tuning_cents: f32,
    /// Estimated A4 reference frequency in Hz.
    pub reference_hz: f32,
    pub profile: KeyProfile,
    /// Pitch-class profile (C..B), max = 1. The shared engine exposes its LATEST chroma frame
    /// (not the whole-track accumulation), so this is the chroma at the end of the material.
    pub chroma: [f32; 12],
}

impl KeyResult {
    /// Maps a shared-engine reading; `None` when it has no key yet (silence, < ~3 s of pitch).
    pub(crate) fn from_listen(a: &ListenAnalysis) -> Option<Self> {
        let est = a.key.as_ref()?;
        let k = est.key;
        Some(Self {
            tonic: k.tonic,
            mode: if k.minor { Mode::Minor } else { Mode::Major },
            name: sharp_name(k),
            camelot: k.camelot(),
            open_key: k.open_key(),
            confidence: est.confidence as f32,
            correlation: est.scores[k.index()] as f32,
            tuning_cents: a.tuning_cents as f32,
            reference_hz: a.tuning_a4_hz as f32,
            profile: KeyProfile::Edma,
            chroma: a.chroma,
        })
    }
}

fn sharp_name(k: Key) -> String {
    let pc = PITCH_NAMES[k.tonic as usize % 12];
    if k.minor {
        format!("{pc}m")
    } else {
        pc.to_string()
    }
}

/// Camelot code for a pitch class + mode (`"8B"` = C major, `"8A"` = A minor).
pub fn camelot(tonic: u8, mode: Mode) -> String {
    Key::new(tonic, mode == Mode::Minor).camelot()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_server_mapping() {
        assert_eq!(camelot(0, Mode::Major), "8B");
        assert_eq!(camelot(9, Mode::Minor), "8A");
        assert_eq!(camelot(6, Mode::Major), "2B");
        assert_eq!(camelot(3, Mode::Minor), "2A"); // D#m = Ebm
        assert_eq!(Key::new(0, false).open_key(), "1d");
        assert_eq!(Key::new(9, true).open_key(), "1m");
        assert_eq!(Key::new(7, false).open_key(), "2d"); // G = 9B = 2d
        assert_eq!(sharp_name(Key::new(6, true)), "F#m");
        assert_eq!(sharp_name(Key::new(10, false)), "A#");
        assert_eq!(Key::new(6, true).camelot(), "11A");
    }

    #[test]
    fn silence_maps_to_no_key() {
        let a = mixai_listen::analyze_samples(&[0.0; 44_100], 44_100, 88.0);
        assert!(KeyResult::from_listen(&a).is_none());
    }
}
