//! # decks-analysis
//!
//! Offline track analysis for MixAI Decks (ADR-0014, tracker WP19-08):
//!
//! * **Key** — delegated to the shared on-device engine in `crates/mixai-listen` (WP18-01,
//!   [`mixai_listen::analyze_samples`] / [`mixai_listen::Listener`]) and mapped to [`KeyResult`]
//!   (pitch class, mode, Camelot, Open Key, confidence, tuning).
//! * **Tempo / beatgrid / downbeats** — multi-band log spectral flux, autocorrelation comb with
//!   a DJ-range prior, Ellis (2007) dynamic-programming beat tracking, 4/4 bar-accent downbeats,
//!   drift detection with tempo anchors ([`tempo`]).
//! * **Loudness** — EBU R128 integrated LUFS, 4× oversampled true peak, gains to −14 / −9 LUFS.
//! * **Waveform peaks** — low/mid/high min/max/RMS as `u8` lanes for GPU rendering.
//!
//! All DSP is hand-written from the published methods (MIT OR Apache-2.0); no GPL/AGPL analyser
//! code (Essentia, aubio, Mixxx, libKeyFinder) is used or ported.
//!
//! ```
//! use decks_analysis::{analyze, AnalyzeOptions};
//! let sr = 44_100;
//! let silence = vec![0.0f32; sr as usize * 2];
//! let a = analyze(&silence, 1, sr, &AnalyzeOptions::default());
//! assert!(a.key.is_none() && a.beatgrid.is_none());
//! assert_eq!(a.peaks.unwrap().len, 300);
//! ```

#![forbid(unsafe_code)]

mod key_map;
pub mod loudness;
pub mod peaks;
mod streaming;
pub mod tempo;
mod util;

#[cfg(feature = "decode")]
mod decode;

use serde::{Deserialize, Serialize};

pub use key_map::{KeyProfile, KeyResult, Mode, camelot};
pub use loudness::{LiveLoudness, Loudness};
pub use peaks::{BandPeaks, WaveformPeaks, peaks_len};
pub use streaming::{LiveSnapshot, StreamingAnalyzer, StreamingOptions};
pub use tempo::{BeatGrid, TempoAnchor, TempoRange};

#[cfg(feature = "decode")]
pub use decode::{DecodedAudio, ListenError, analyze_file, decode_file};

use tempo::{ONSET_HOP, ONSET_N, OnsetDetector, TrackInput};
use util::{Decimator, downmix};

/// Output schema version (bump when a field changes meaning).
/// 2: key comes from the shared `mixai-listen` engine (`profile` = `edma`).
pub const ANALYSIS_VERSION: u32 = 2;

/// Tempo fold floor handed to the shared engine. Only its key reading is used offline, which does
/// not depend on this value; 88 is the engine's DJ default.
const LISTEN_BPM_FLOOR: f64 = 88.0;

/// What to compute and how.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AnalyzeOptions {
    pub key: bool,
    pub tempo: bool,
    pub tempo_range: TempoRange,
    /// Include every tracked beat time in [`BeatGrid::beats`].
    pub include_beats: bool,
    pub loudness: bool,
    /// Waveform points per second; 0 disables peaks.
    pub peaks_per_second: u32,
}

impl Default for AnalyzeOptions {
    fn default() -> Self {
        Self {
            key: true,
            tempo: true,
            tempo_range: TempoRange::default(),
            include_beats: true,
            loudness: true,
            peaks_per_second: 150,
        }
    }
}

/// Full analysis of one track.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Analysis {
    pub version: u32,
    pub duration_sec: f64,
    pub sample_rate: u32,
    pub channels: u16,
    /// `None` when disabled or when no tonal content was found.
    pub key: Option<KeyResult>,
    /// `None` when disabled or when no periodic pulse was found.
    pub beatgrid: Option<BeatGrid>,
    pub loudness: Option<Loudness>,
    pub peaks: Option<WaveformPeaks>,
}

/// Analyse an interleaved buffer (`samples.len()` = frames × channels; a trailing partial frame
/// is ignored).
pub fn analyze(
    samples: &[f32],
    channels: u16,
    sample_rate: u32,
    opts: &AnalyzeOptions,
) -> Analysis {
    let ch = channels.max(1) as usize;
    let usable = samples.len() / ch * ch;
    let samples = &samples[..usable];
    let frames = usable / ch;
    let mut out = Analysis {
        version: ANALYSIS_VERSION,
        duration_sec: if sample_rate > 0 {
            frames as f64 / sample_rate as f64
        } else {
            0.0
        },
        sample_rate,
        channels: ch as u16,
        key: None,
        beatgrid: None,
        loudness: None,
        peaks: None,
    };
    if sample_rate == 0 || frames == 0 {
        return out;
    }

    if opts.loudness {
        let mut meter = loudness::LoudnessMeter::new(ch, sample_rate);
        meter.push(samples);
        out.loudness = Some(meter.result());
    }

    let mono = downmix(samples, ch);
    if opts.peaks_per_second > 0 {
        out.peaks = Some(peaks::compute(&mono, sample_rate, opts.peaks_per_second));
    }
    if opts.key {
        let listen = mixai_listen::analyze_samples(&mono, sample_rate, LISTEN_BPM_FLOOR);
        out.key = KeyResult::from_listen(&listen);
    }
    if !opts.tempo {
        return out;
    }

    let factor = Decimator::factor_for(sample_rate);
    let mut dec = Decimator::new(factor);
    let dsr = sample_rate as f64 / factor as f64;
    let signal_t0 = (factor as f64 - 1.0 - dec.delay()) / sample_rate as f64;
    let mut signal = Vec::with_capacity(mono.len() / factor + 1);
    for &x in &mono {
        if let Some(y) = dec.push(x) {
            signal.push(y);
        }
    }
    drop(mono);

    let mut od = OnsetDetector::new(dsr);
    let mut odf = Vec::with_capacity(signal.len() / ONSET_HOP + 1);
    let mut low = Vec::with_capacity(signal.len() / ONSET_HOP + 1);
    for &y in &signal {
        if let Some((f, l)) = od.push(y) {
            odf.push(f);
            low.push(l);
        }
    }
    let fps = dsr / ONSET_HOP as f64;
    let t0 = signal_t0 + (ONSET_HOP as f64 - 1.0 - (ONSET_N as f64 - 1.0) / 2.0) / dsr;
    out.beatgrid = tempo::track(
        &TrackInput {
            odf: &odf,
            low: &low,
            fps,
            t0,
            signal: &signal,
            signal_sr: dsr,
            signal_t0,
        },
        &opts.tempo_range,
        opts.include_beats,
    );
    out
}

#[cfg(test)]
mod tests;
