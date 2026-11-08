//! UniFFI surface of mixai-listen for the MixAI Key & BPM apps (WP18-02).
//!
//! The capture thread calls `push_pcm` with 10–20 ms float blocks; the UI polls `snapshot()` at ~15–30 Hz.
//! Polling (not a callback) keeps all foreign calls on threads the app owns.

use std::path::Path;
use std::sync::Mutex;

use mixai_listen::{self as core, Key, Notation};

uniffi::setup_scaffolding!();

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum KeyNotation {
    Camelot,
    OpenKey,
    Musical,
}

impl From<KeyNotation> for Notation {
    fn from(n: KeyNotation) -> Self {
        match n {
            KeyNotation::Camelot => Notation::Camelot,
            KeyNotation::OpenKey => Notation::OpenKey,
            KeyNotation::Musical => Notation::Musical,
        }
    }
}

/// A key with every label precomputed so UIs never re-implement the tables.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct MusicKey {
    /// 0..24: majors 0..11 by tonic (C = 0), then minors.
    pub index: u8,
    pub tonic: u8,
    pub minor: bool,
    /// 1..12.
    pub camelot_number: u8,
    pub camelot: String,
    pub open_key: String,
    /// `A minor`.
    pub name: String,
    /// `Am`.
    pub short_name: String,
}

impl From<Key> for MusicKey {
    fn from(k: Key) -> Self {
        Self {
            index: k.index() as u8,
            tonic: k.tonic,
            minor: k.minor,
            camelot_number: k.camelot_number(),
            camelot: k.camelot(),
            open_key: k.open_key(),
            name: k.name(),
            short_name: k.short_name(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TempoReading {
    pub bpm: f64,
    pub confidence: f64,
    pub locked: bool,
    pub beat_phase: f64,
    pub next_beat_in_secs: f64,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct KeyReading {
    pub key: MusicKey,
    pub confidence: f64,
    pub alternative: MusicKey,
    pub locked: bool,
    /// Correlation per key index (24 values) for the Camelot wheel heat map.
    pub scores: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ChordReading {
    /// `None` = no chord.
    pub label: Option<String>,
    pub root: Option<u8>,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PitchReading {
    pub hz: f64,
    pub midi: i32,
    pub note_name: String,
    pub cents: f64,
    pub clarity: f64,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LoudnessReading {
    pub momentary_lufs: f64,
    pub short_term_lufs: f64,
    pub integrated_lufs: f64,
    pub true_peak_dbtp: f64,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ListenSnapshot {
    pub elapsed_secs: f64,
    pub level_dbfs: f64,
    pub tempo: Option<TempoReading>,
    pub key: Option<KeyReading>,
    pub key_changed: bool,
    pub chord: Option<ChordReading>,
    pub pitch: Option<PitchReading>,
    pub tuning_a4_hz: f64,
    pub tuning_cents: f64,
    pub loudness: Option<LoudnessReading>,
    pub energy: Option<f64>,
    /// 12 values, C first.
    pub chroma: Vec<f32>,
}

impl From<core::Analysis> for ListenSnapshot {
    fn from(a: core::Analysis) -> Self {
        Self {
            elapsed_secs: a.elapsed_secs,
            level_dbfs: a.level_dbfs,
            tempo: a.tempo.map(|t| TempoReading {
                bpm: t.bpm,
                confidence: t.confidence,
                locked: t.locked,
                beat_phase: t.beat_phase,
                next_beat_in_secs: t.next_beat_in_secs,
            }),
            key: a.key.map(|k| KeyReading {
                key: k.key.into(),
                confidence: k.confidence,
                alternative: k.alternative.into(),
                locked: k.locked,
                scores: k.scores.to_vec(),
            }),
            key_changed: a.key_changed,
            chord: a.chord.map(|c| ChordReading {
                label: c.chord.map(|ch| ch.label()),
                root: c.chord.map(|ch| ch.root),
                confidence: c.confidence,
            }),
            pitch: a.pitch.map(|p| PitchReading {
                hz: p.hz,
                midi: p.midi,
                note_name: p.note_name(),
                cents: p.cents,
                clarity: p.clarity,
            }),
            tuning_a4_hz: a.tuning_a4_hz,
            tuning_cents: a.tuning_cents,
            loudness: a.loudness.map(|l| LoudnessReading {
                momentary_lufs: l.momentary_lufs,
                short_term_lufs: l.short_term_lufs,
                integrated_lufs: l.integrated_lufs,
                true_peak_dbtp: l.true_peak_dbtp,
            }),
            energy: a.energy,
            chroma: a.chroma.to_vec(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct EngineConfig {
    pub sample_rate: u32,
    /// Lower edge of the BPM fold band (88 → 88..176).
    pub bpm_floor: f64,
    pub a4_hz: f64,
}

#[derive(Debug, uniffi::Error)]
pub enum ListenError {
    Decode { message: String },
}

impl std::error::Error for ListenError {}

impl std::fmt::Display for ListenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ListenError::Decode { message } => write!(f, "{message}"),
        }
    }
}

/// Live engine. Thread-safe: capture and UI threads may call it concurrently (one internal lock).
#[derive(uniffi::Object)]
pub struct KeyBpmEngine {
    inner: Mutex<core::Listener>,
}

#[uniffi::export]
impl KeyBpmEngine {
    #[uniffi::constructor]
    pub fn new(config: EngineConfig) -> Self {
        let mut cfg = core::ListenerConfig::new(config.sample_rate);
        cfg.bpm_floor = config.bpm_floor;
        cfg.a4_hz = config.a4_hz;
        Self { inner: Mutex::new(core::Listener::new(cfg)) }
    }

    /// Mono float samples in −1..1.
    pub fn push_pcm(&self, samples: Vec<f32>) {
        self.lock().push(&samples);
    }

    /// Mono 16-bit samples (Android AudioRecord PCM_16BIT, ShazamKit shares the same buffer).
    pub fn push_pcm16(&self, samples: Vec<i16>) {
        let f: Vec<f32> = samples.iter().map(|&s| s as f32 / 32768.0).collect();
        self.lock().push(&f);
    }

    pub fn snapshot(&self) -> ListenSnapshot {
        self.lock().snapshot().into()
    }

    pub fn set_a4(&self, hz: f64) {
        self.lock().set_a4(hz);
    }

    pub fn reset(&self) {
        self.lock().reset();
    }
}

impl KeyBpmEngine {
    fn lock(&self) -> std::sync::MutexGuard<'_, core::Listener> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// File mode: analyse an audio file on disk (mp3, m4a/aac, flac, wav, ogg).
#[uniffi::export]
pub fn analyze_file(path: String, bpm_floor: f64) -> Result<ListenSnapshot, ListenError> {
    core::decode::analyze_file(Path::new(&path), bpm_floor)
        .map(Into::into)
        .map_err(|message| ListenError::Decode { message })
}

/// All 24 keys (index order), for drawing the Camelot wheel.
#[uniffi::export]
pub fn all_keys() -> Vec<MusicKey> {
    (0..24).map(|i| Key::from_index(i).into()).collect()
}

/// Parses Camelot / Open Key / musical text (`8A`, `1m`, `A minor`, `F#m`).
#[uniffi::export]
pub fn parse_key(text: String) -> Option<MusicKey> {
    Key::parse(&text).map(Into::into)
}

#[uniffi::export]
pub fn key_label(index: u8, notation: KeyNotation) -> String {
    Key::from_index(index as usize).label(notation.into())
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct CompatibleKey {
    pub key: MusicKey,
    /// `same`, `relative`, `adjacent`, `energy_boost`, `diagonal`, `whole_step`.
    pub relation: String,
    pub score: f64,
}

/// Keys that mix from `index`, best first.
#[uniffi::export]
pub fn compatible_keys(index: u8) -> Vec<CompatibleKey> {
    use core::harmonic::Relation::*;
    core::harmonic::compatible_keys(Key::from_index(index as usize))
        .into_iter()
        .map(|(k, r, score)| CompatibleKey {
            key: k.into(),
            relation: match r {
                Same => "same",
                Relative => "relative",
                Adjacent => "adjacent",
                EnergyBoost => "energy_boost",
                Diagonal => "diagonal",
                WholeStep => "whole_step",
                Clash => "clash",
            }
            .to_string(),
            score,
        })
        .collect()
}

/// Same scorer as the MMO Server (`harmonic.ts`): key 70 % + BPM 30 %, 0..1.
#[uniffi::export]
pub fn transition_score(from_key: Option<String>, from_bpm: Option<f64>, to_key: Option<String>, to_bpm: Option<f64>) -> f64 {
    let parse = |k: Option<String>| k.and_then(|s| Key::parse(&s));
    core::harmonic::transition_score(parse(from_key), from_bpm, parse(to_key), to_bpm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_round_trip_through_the_ffi_types() {
        let e = KeyBpmEngine::new(EngineConfig { sample_rate: 48_000, bpm_floor: 88.0, a4_hz: 440.0 });
        e.push_pcm16(vec![0; 48_000]);
        let s = e.snapshot();
        assert!((s.elapsed_secs - 1.0).abs() < 1e-9);
        assert_eq!(s.chroma.len(), 12);
        assert!(s.key.is_none());
        e.reset();
        assert_eq!(e.snapshot().elapsed_secs, 0.0);
    }

    #[test]
    fn key_helpers() {
        assert_eq!(all_keys().len(), 24);
        assert_eq!(parse_key("Am".into()).unwrap().camelot, "8A");
        assert_eq!(key_label(21, KeyNotation::OpenKey), "1m");
        assert_eq!(compatible_keys(21)[1].relation, "relative");
        assert!((transition_score(Some("8A".into()), Some(124.0), Some("9A".into()), Some(124.0)) - 0.895).abs() < 1e-9);
        assert!(analyze_file("missing.mp3".into(), 88.0).is_err());
    }
}
