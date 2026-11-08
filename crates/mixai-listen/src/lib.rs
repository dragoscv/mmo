//! # mixai-listen
//!
//! On-device music listening for MixAI Key & BPM (WP18, D58/D69) and MixAI Decks: push mono PCM from any
//! source (microphone or decoded file) and read live key, tempo + beat phase, chord, tuner pitch, reference
//! tuning, loudness and energy. Pure Rust with permissive dependencies only (realfft, ebur128), no allocation in
//! the per-sample path, so the same engine runs on phones, watches, desktop and the server.
//!
//! ```
//! use mixai_listen::{Listener, ListenerConfig};
//! let mut l = Listener::new(ListenerConfig::new(48_000));
//! l.push(&vec![0.0; 4800]);
//! let a = l.snapshot();
//! assert!(a.key.is_none());
//! ```

// DSP loops index several parallel arrays; `!(x > 0.0)` deliberately rejects NaN as well.
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

mod chords;
mod chroma;
#[cfg(feature = "decode")]
pub mod decode;
mod fft;
pub mod harmonic;
mod key;
mod loudness;
pub mod notation;
mod pitch;
mod ring;
mod tempo;

pub use chords::{Chord, ChordEstimate, ChordQuality};
pub use key::{KeyEstimate, key_correlations};
pub use loudness::LoudnessReading;
pub use notation::{Key, Notation};
pub use pitch::PitchEstimate;
pub use tempo::TempoEstimate;

use chords::ChordTracker;
use chroma::ChromaAnalyzer;
use key::KeyTracker;
use loudness::{Energy, Loudness};
use pitch::PitchDetector;
use ring::Ring;
use tempo::{OnsetDetector, TempoTracker};

/// Listener settings.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ListenerConfig {
    /// Sample rate of the pushed PCM (8 kHz .. 192 kHz).
    pub sample_rate: u32,
    /// Tempo fold band, lower edge (upper = 2×). 88 → 88..176 BPM (DJ default); 70 → 70..140 (hip-hop, dnb as half).
    pub bpm_floor: f64,
    /// Tuner reference A4 in Hz (415..466).
    pub a4_hz: f64,
    /// Seconds of onset history used for tempo (live 8 s; file mode uses 30 s).
    pub tempo_window_secs: f64,
}

impl ListenerConfig {
    pub fn new(sample_rate: u32) -> Self {
        Self { sample_rate, bpm_floor: 88.0, a4_hz: 440.0, tempo_window_secs: 8.0 }
    }
}

/// Everything the UI shows, at one instant.
#[derive(Debug, Clone, PartialEq)]
pub struct Analysis {
    /// Seconds of audio pushed since start/reset.
    pub elapsed_secs: f64,
    /// Input level, dBFS RMS over the last 50 ms.
    pub level_dbfs: f64,
    pub tempo: Option<TempoEstimate>,
    pub key: Option<KeyEstimate>,
    /// True once, right after the key changed mid-track (alert, D69).
    pub key_changed: bool,
    pub chord: Option<ChordEstimate>,
    pub pitch: Option<PitchEstimate>,
    /// Estimated reference tuning of the music, e.g. 446.0 for a fast pitched-up record.
    pub tuning_a4_hz: f64,
    /// Same as cents off 440.
    pub tuning_cents: f64,
    pub loudness: Option<LoudnessReading>,
    /// 1..10.
    pub energy: Option<f64>,
    /// Latest chroma (sum-normalised to max 1), for the chromagram strip.
    pub chroma: [f32; 12],
}

/// Streaming analyser. Not `Sync`; feed it from one thread (the capture thread or an analysis thread).
pub struct Listener {
    cfg: ListenerConfig,
    ring: Ring,
    onset: OnsetDetector,
    chroma: ChromaAnalyzer,
    pitch: PitchDetector,
    tempo: TempoTracker,
    key: KeyTracker,
    chords: ChordTracker,
    loudness: Loudness,
    energy: Energy,
    onset_hop: usize,
    chroma_hop: usize,
    pitch_hop: usize,
    samples: u64,
    level_acc: (f64, usize),
    level_dbfs: f64,
    last_chroma: [f32; 12],
    last_pitch: Option<PitchEstimate>,
    key_changed: bool,
    min_window: usize,
}

impl Listener {
    pub fn new(cfg: ListenerConfig) -> Self {
        let sr = cfg.sample_rate.clamp(8_000, 192_000);
        let cfg = ListenerConfig {
            sample_rate: sr,
            bpm_floor: cfg.bpm_floor.clamp(50.0, 120.0),
            a4_hz: cfg.a4_hz.clamp(415.0, 466.0),
            tempo_window_secs: cfg.tempo_window_secs.clamp(4.0, 60.0),
        };
        let onset = OnsetDetector::new(sr);
        let chroma = ChromaAnalyzer::new(sr);
        let pitch = PitchDetector::new(sr);
        let ring_len = onset.window().max(chroma.window()).max(pitch.window());
        let onset_hop = (sr as usize / 100).max(1);
        let rate = sr as f64 / onset_hop as f64;
        let latency = onset.window() as f64 / 2.0 / sr as f64;
        Self {
            ring: Ring::new(ring_len),
            tempo: TempoTracker::new(rate, cfg.bpm_floor, cfg.bpm_floor * 2.0, cfg.tempo_window_secs, latency),
            key: KeyTracker::new(10.0),
            chords: ChordTracker::new(),
            loudness: Loudness::new(sr),
            energy: Energy::new(rate),
            onset_hop,
            chroma_hop: (sr as usize / 10).max(1),
            pitch_hop: (sr as usize / 20).max(1),
            samples: 0,
            level_acc: (0.0, 0),
            level_dbfs: f64::NEG_INFINITY,
            last_chroma: [0.0; 12],
            last_pitch: None,
            key_changed: false,
            min_window: onset.window(),
            onset,
            chroma,
            pitch,
            cfg,
        }
    }

    pub fn config(&self) -> ListenerConfig {
        self.cfg
    }

    /// Tuner reference change takes effect on the next pitch frame.
    pub fn set_a4(&mut self, hz: f64) {
        self.cfg.a4_hz = hz.clamp(415.0, 466.0);
    }

    /// Push mono samples in −1..1 (any block size).
    pub fn push(&mut self, samples: &[f32]) {
        self.loudness.push(samples);
        let level_n = self.cfg.sample_rate as usize / 20;
        for &x in samples {
            let x = if x.is_finite() { x.clamp(-1.0, 1.0) } else { 0.0 };
            self.ring.push(x);
            self.samples += 1;
            self.level_acc.0 += (x * x) as f64;
            self.level_acc.1 += 1;
            if self.level_acc.1 >= level_n {
                let rms = (self.level_acc.0 / self.level_acc.1 as f64).sqrt();
                self.level_dbfs = if rms > 0.0 { 20.0 * rms.log10() } else { f64::NEG_INFINITY };
                self.level_acc = (0.0, 0);
            }
            let s = self.samples as usize;
            if s < self.min_window {
                continue;
            }
            if s % self.onset_hop == 0 {
                let flux = self.onset.step(&self.ring);
                self.tempo.push(flux);
                self.energy.push(10f64.powf(self.level_dbfs.max(-120.0) / 20.0) as f32, flux);
            }
            if s % self.chroma_hop == 0 && s >= self.chroma.window() {
                let f = self.chroma.step(&self.ring);
                self.key.push(&f.chroma, f.energy);
                self.chords.push(&f.chroma, f.energy);
                if self.key.take_changed() {
                    self.key_changed = true;
                }
                self.last_chroma = f.chroma;
            }
            if s % self.pitch_hop == 0 {
                self.last_pitch = self.pitch.step(&self.ring, self.cfg.a4_hz).filter(|p| p.clarity >= 0.8);
            }
        }
    }

    pub fn elapsed_secs(&self) -> f64 {
        self.samples as f64 / self.cfg.sample_rate as f64
    }

    /// Current reading. Clears the one-shot `key_changed` flag.
    pub fn snapshot(&mut self) -> Analysis {
        let now = self.elapsed_secs();
        let tuning = self.chroma.tuning_semitones() as f64;
        Analysis {
            elapsed_secs: now,
            level_dbfs: self.level_dbfs,
            tempo: self.tempo.snapshot(now),
            key: self.key.snapshot(),
            key_changed: std::mem::take(&mut self.key_changed),
            chord: (self.samples as usize >= self.chroma.window()).then(|| self.chords.snapshot()),
            pitch: self.last_pitch,
            tuning_a4_hz: 440.0 * 2f64.powf(tuning / 12.0),
            tuning_cents: tuning * 100.0,
            loudness: self.loudness.reading(),
            energy: self.energy.score(),
            chroma: self.last_chroma,
        }
    }

    /// Start over (new song, "listen again").
    pub fn reset(&mut self) {
        self.ring.clear();
        self.onset.reset();
        self.chroma.reset();
        self.tempo.reset();
        self.key.reset();
        self.chords.reset();
        self.loudness.reset();
        self.energy.reset();
        self.samples = 0;
        self.level_acc = (0.0, 0);
        self.level_dbfs = f64::NEG_INFINITY;
        self.last_chroma = [0.0; 12];
        self.last_pitch = None;
        self.key_changed = false;
    }
}

/// Whole-file analysis (file mode): mono PCM in, final reading out, with a 30 s tempo window.
pub fn analyze_samples(samples: &[f32], sample_rate: u32, bpm_floor: f64) -> Analysis {
    let mut cfg = ListenerConfig::new(sample_rate);
    cfg.bpm_floor = bpm_floor;
    cfg.tempo_window_secs = 30.0;
    let mut l = Listener::new(cfg);
    for block in samples.chunks(4096) {
        l.push(block);
    }
    l.snapshot()
}

#[cfg(test)]
mod tests {
    use super::chroma::synth::*;
    use super::*;

    /// Kick on every beat + hat on the off-beat + a sustained chord progression in `key`.
    fn song(sr: u32, bpm: f64, tonic: i32, minor: bool, secs: f32) -> Vec<f32> {
        let chord_secs = (60.0 / bpm * 4.0) as f32;
        let repeats = (secs / (chord_secs * 4.0)).ceil() as usize;
        let mut s = cadence(sr, tonic, minor, chord_secs, repeats, 440.0);
        s.truncate((secs * sr as f32) as usize);
        let period = 60.0 / bpm * sr as f64;
        let mut rng = Lcg(3);
        let mut t = 0.0;
        while (t as usize) < s.len() {
            let start = t as usize;
            for i in 0..(sr as usize / 8).min(s.len() - start) {
                let tt = i as f32 / sr as f32;
                let f = 50.0 + 90.0 * (-tt * 30.0).exp();
                s[start + i] += 0.5 * (-tt * 18.0).exp() * (std::f32::consts::TAU * f * tt).sin();
            }
            let hat = (t + period / 2.0) as usize;
            for i in 0..(sr as usize / 40) {
                if hat + i < s.len() {
                    s[hat + i] += 0.08 * (-(i as f32) / (sr as f32 * 0.008)).exp() * rng.next();
                }
            }
            t += period;
        }
        s
    }

    #[test]
    fn live_listener_finds_key_and_tempo_of_a_synthetic_track() {
        let sr = 44_100;
        for (bpm, tonic, minor, cam) in [(124.0, 57, true, "8A"), (128.0, 60, false, "8B"), (140.0, 54, true, "11A"), (100.0, 55, false, "9B")] {
            let s = song(sr, bpm, tonic, minor, 14.0);
            let mut l = Listener::new(ListenerConfig::new(sr));
            for block in s.chunks(480) {
                l.push(block);
            }
            let a = l.snapshot();
            let t = a.tempo.expect("tempo");
            assert!((t.bpm - bpm).abs() < 1.0, "{cam}: bpm {} vs {bpm}", t.bpm);
            let k = a.key.expect("key");
            assert_eq!(k.key.camelot(), cam, "key {} alt {} conf {}", k.key.name(), k.alternative.name(), k.confidence);
            assert!(a.energy.unwrap() > 3.0);
            assert!(a.loudness.unwrap().short_term_lufs > -40.0);
            assert!(a.tuning_cents.abs() < 5.0, "tuning {}", a.tuning_cents);
        }
    }

    #[test]
    fn key_is_provisional_within_five_seconds_and_locks_by_twelve() {
        let sr = 44_100;
        let s = song(sr, 124.0, 57, true, 13.0);
        let mut l = Listener::new(ListenerConfig::new(sr));
        l.push(&s[..sr as usize * 5]);
        let early = l.snapshot().key.expect("provisional key at 5 s");
        assert!(!early.locked);
        l.push(&s[sr as usize * 5..]);
        let late = l.snapshot();
        let k = late.key.unwrap();
        assert!(k.locked, "locked at {} s (conf {})", late.elapsed_secs, k.confidence);
        assert_eq!(k.key.camelot(), "8A");
    }

    #[test]
    fn silence_reports_nothing_and_reset_starts_over() {
        let sr = 48_000;
        let mut l = Listener::new(ListenerConfig::new(sr));
        l.push(&vec![0.0; sr as usize * 6]);
        let a = l.snapshot();
        assert!(a.tempo.is_none() && a.key.is_none() && a.pitch.is_none());
        assert_eq!(a.chord.and_then(|c| c.chord), None);
        l.push(&song(sr, 128.0, 60, false, 8.0));
        l.reset();
        assert_eq!(l.elapsed_secs(), 0.0);
        assert!(l.snapshot().key.is_none());
    }

    #[test]
    fn file_mode_matches_live_mode() {
        let sr = 22_050;
        let s = song(sr, 128.0, 62, true, 20.0);
        let a = analyze_samples(&s, sr, 88.0);
        assert!((a.tempo.unwrap().bpm - 128.0).abs() < 0.5);
        assert_eq!(a.key.unwrap().key.camelot(), "7A");
    }

    #[test]
    fn garbage_input_never_panics() {
        let mut l = Listener::new(ListenerConfig { sample_rate: 1, bpm_floor: 0.0, a4_hz: 0.0, tempo_window_secs: 0.0 });
        l.push(&[f32::NAN, f32::INFINITY, -7.0, 3.0]);
        l.push(&[]);
        let _ = l.snapshot();
    }
}
