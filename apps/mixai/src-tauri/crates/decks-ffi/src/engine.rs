//! [`DecksEngine`]: commands into `mixai-core` and polled [`EngineSnapshot`]s out.
//!
//! The cpal audio callback runs on the engine's own thread; every method here only sends a
//! lock-free command or reads atomics through `mixai_core::Engine`. Track loading (decode +
//! `decks-analysis`) runs on a background thread per load and is tracked by a ticket.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use mixai_core::deck::TrackBuffer;
use mixai_core::{
    BeatFxKind, ClockSource, ColorFxKind, Command, DeckId, Engine, OutputMode, RoutingConfig,
    TempoMarker, TempoSection, valid_bpm, valid_sec,
};

use crate::{DecksError, lock};

const DECKS: usize = 4;
const HOT_CUES: u8 = 8;
/// Waveform points per second computed on load (matches decks-render's default zoom range).
pub const PEAKS_PER_SECOND: u32 = 150;
/// Load tickets kept for `load_status` polling.
const KEEP_TICKETS: u64 = 64;

fn deck_id(deck: u8) -> Result<DeckId, DecksError> {
    DeckId::ALL
        .get(deck as usize)
        .copied()
        .ok_or_else(|| DecksError::invalid(format!("deck {deck} out of range 0..=3")))
}

fn not_running() -> DecksError {
    DecksError::NotRunning {
        reason: "call DecksEngine.start() first".into(),
    }
}

fn finite(name: &str, v: f64) -> Result<f64, DecksError> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err(DecksError::invalid(format!("{name} must be finite")))
    }
}

/// A tempo the grid maths can use (20..400). Every anchor and marker passes this before it can
/// reach a deck: `beat_at` / `time_at` divide by the segment length, so a 1e-300 or 1e308 tempo
/// would return `NaN` **on the audio thread** (WP19-37 P1-9).
pub(crate) fn checked_bpm(name: &str, v: f64) -> Result<f64, DecksError> {
    if valid_bpm(v) {
        Ok(v)
    } else {
        Err(DecksError::invalid(format!(
            "{name} {v} out of range 20..400"
        )))
    }
}

/// A usable source time: finite and not negative.
pub(crate) fn checked_sec(name: &str, v: f64) -> Result<f64, DecksError> {
    if valid_sec(v) {
        Ok(v)
    } else {
        Err(DecksError::invalid(format!(
            "{name} {v} must be finite and >= 0"
        )))
    }
}

// ---- records ----------------------------------------------------------------------------

/// Requested engine configuration (all optional: `None` = device / system default). Values the
/// device cannot honour fall back to its default and are reported in [`EngineStartInfo::notes`].
#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct DecksEngineConfig {
    pub sample_rate: Option<u32>,
    pub buffer_frames: Option<u32>,
    pub output_device_id: Option<String>,
}

/// An audio output device.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct AudioOutputDevice {
    /// Stable per-host id (`host:id`).
    pub id: String,
    pub name: String,
    pub channels: u16,
    pub is_default: bool,
}

/// What `start()` actually opened.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct EngineStartInfo {
    pub sample_rate: u32,
    pub channels: u16,
    pub latency_ms: f32,
    /// Id of the device in use (`host:id`).
    pub device_id: Option<String>,
    /// Requested settings that fell back to a default, one line each (empty = all honoured).
    pub notes: Vec<String>,
    /// Frames per audio callback (`None` = backend default, not yet observed).
    #[uniffi(default = None)]
    pub buffer_frames: Option<u32>,
    /// Human-readable name of the device in use.
    #[uniffi(default = None)]
    pub device_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LoadState {
    Queued,
    Decoding,
    Analysing,
    Ready,
    Failed,
    /// A newer load on the same deck superseded this one.
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LoadStatus {
    pub ticket: u64,
    pub deck: u8,
    pub path: String,
    pub state: LoadState,
    pub error: Option<String>,
}

/// Metadata of the track on a deck (from decoding + `decks-analysis`).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TrackInfo {
    pub path: String,
    /// File stem (tags are read by `DecksLibrary`).
    pub title: String,
    pub duration_sec: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub bpm: Option<f64>,
    pub first_beat_sec: Option<f64>,
    pub key_camelot: Option<String>,
    pub key_open_key: Option<String>,
    pub key_name: Option<String>,
    pub key_confidence: Option<f32>,
    pub integrated_lufs: Option<f64>,
    pub true_peak_dbtp: Option<f64>,
    pub gain_to_minus14_db: Option<f64>,
}

/// Three-band waveform lanes from `decks-analysis` (u8: min/max 128 ≈ 0, rms linear).
#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct WaveformPeaks {
    pub points_per_second: u32,
    pub len: u32,
    pub low_min: Vec<u8>,
    pub low_max: Vec<u8>,
    pub low_rms: Vec<u8>,
    pub mid_min: Vec<u8>,
    pub mid_max: Vec<u8>,
    pub mid_rms: Vec<u8>,
    pub high_min: Vec<u8>,
    pub high_max: Vec<u8>,
    pub high_rms: Vec<u8>,
}

impl From<&decks_analysis::WaveformPeaks> for WaveformPeaks {
    fn from(p: &decks_analysis::WaveformPeaks) -> Self {
        Self {
            points_per_second: p.points_per_second,
            len: p.len as u32,
            low_min: p.low.min.clone(),
            low_max: p.low.max.clone(),
            low_rms: p.low.rms.clone(),
            mid_min: p.mid.min.clone(),
            mid_max: p.mid.max.clone(),
            mid_rms: p.mid.rms.clone(),
            high_min: p.high.min.clone(),
            high_max: p.high.max.clone(),
            high_rms: p.high.rms.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct TempoAnchorInfo {
    /// Beat number at `time_sec`, counted from the first beat. For an analysed grid (non-empty
    /// `BeatGridInfo::beats`) it is the beat the tracker **counted** and the engine pins the
    /// anchor to it; for an edited grid it is only the rounded beat for display and the engine
    /// integrates the running tempo instead, so a marker between two beats stays where it is
    /// (WP19-37 P1-8).
    pub beat_index: u32,
    pub time_sec: f64,
    pub bpm: f64,
}

/// Beatgrid of a deck.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct BeatGridInfo {
    pub bpm: f64,
    pub confidence: f32,
    pub first_beat_sec: f64,
    /// 0..3: beat index of the first downbeat counted from `first_beat_sec` (4/4).
    pub downbeat_offset_beats: u8,
    pub downbeat_confidence: f32,
    pub is_variable: bool,
    pub anchors: Vec<TempoAnchorInfo>,
    /// Tracked beat times (empty for user-set grids).
    pub beats: Vec<f64>,
    /// Fixed-grid toggle (WP19-37): the deck plays the constant `bpm` + `first_beat_sec`
    /// grid and the anchors are kept but ignored.
    #[uniffi(default = false)]
    pub fixed: bool,
}

impl From<&decks_analysis::BeatGrid> for BeatGridInfo {
    fn from(g: &decks_analysis::BeatGrid) -> Self {
        Self {
            bpm: g.bpm,
            confidence: g.confidence,
            first_beat_sec: g.first_beat_sec,
            downbeat_offset_beats: g.downbeat_offset_beats,
            downbeat_confidence: g.downbeat_confidence,
            is_variable: g.is_variable,
            anchors: g
                .anchors
                .iter()
                .map(|a| TempoAnchorInfo {
                    beat_index: a.beat_index,
                    time_sec: a.time_sec,
                    bpm: a.bpm,
                })
                .collect(),
            beats: g.beats.clone().unwrap_or_default(),
            fixed: false,
        }
    }
}

impl BeatGridInfo {
    /// Engine grid: the anchors become tempo markers (sections), so a change in the middle of
    /// the track bends the grid instead of re-anchoring every beat. `fixed` is carried over, so
    /// the engine ignores the markers while the toggle is on.
    ///
    /// Anchors that carry a beat number (`beat_index`, what the beat tracker counted) are
    /// pinned to it instead of being re-integrated from the running tempo: the per-section line
    /// fits disagree by up to ~15 ms at a boundary and integrating those fractional beats makes
    /// the error accumulate at every marker (WP19-37 P1-8).
    pub(crate) fn to_core(&self) -> mixai_core::BeatGrid {
        let start_bpm = match self.anchors.first() {
            Some(a) if self.is_variable && valid_bpm(a.bpm) => a.bpm,
            _ => self.bpm,
        };
        let mut g = if self.is_variable && self.anchors_are_measured() {
            let sections: Vec<TempoSection> = self
                .anchors
                .iter()
                .map(|a| TempoSection {
                    sec: a.time_sec,
                    beat: f64::from(a.beat_index),
                    bpm: a.bpm,
                })
                .collect();
            mixai_core::BeatGrid::from_sections(
                start_bpm,
                self.first_beat_sec,
                &sections,
                self.fixed,
            )
        } else {
            let markers: Vec<TempoMarker> = if self.is_variable {
                self.anchors
                    .iter()
                    .skip(1)
                    .map(|a| TempoMarker {
                        sec: a.time_sec,
                        bpm: a.bpm,
                    })
                    .collect()
            } else {
                Vec::new()
            };
            mixai_core::BeatGrid::from_markers(start_bpm, self.first_beat_sec, &markers, self.fixed)
        };
        // Keep the nominal (average) tempo for constant queries and the UI.
        if self.bpm > 0.0 && g.anchors.is_empty() {
            g.bpm = self.bpm;
        }
        g.downbeat = Some(i64::from(self.downbeat_offset_beats % 4));
        g
    }

    /// True when the anchors carry the beat numbers the tracker counted: an analysed grid
    /// (`beats` non-empty — user-set grids leave it empty) with two or more anchors, usable
    /// tempos and strictly increasing beats and times. Edited grids keep the integrating path,
    /// because their `beat_index` is only a rounded display value.
    fn anchors_are_measured(&self) -> bool {
        !self.beats.is_empty()
            && self.anchors.len() >= 2
            && self.anchors.iter().all(|a| valid_bpm(a.bpm))
            && self
                .anchors
                .windows(2)
                .all(|w| w[1].beat_index > w[0].beat_index && w[1].time_sec > w[0].time_sec)
    }

    /// Library grid (seconds + tempo markers) for the same beatgrid. A variable grid's first
    /// anchor is the **starting tempo**, not a tempo change, so it becomes the grid's `bpm`
    /// (same rule as [`BeatGridInfo::to_core`]); writing the average there would shift every
    /// later marker's beat number (WP19-37 P1-7).
    pub(crate) fn to_library(&self) -> decks_library::BeatGrid {
        let bpm = match self.anchors.first() {
            Some(a) if self.is_variable && valid_bpm(a.bpm) => a.bpm,
            _ => self.bpm,
        };
        decks_library::BeatGrid {
            bpm,
            first_beat_sec: self.first_beat_sec,
            downbeat_offset: self.downbeat_offset_beats % 4,
            anchors: self
                .anchors
                .iter()
                .skip(usize::from(self.is_variable))
                .map(|a| decks_library::GridAnchor {
                    sec: a.time_sec,
                    bpm: a.bpm,
                })
                .collect(),
            fixed: self.fixed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EqBand {
    Low,
    Mid,
    High,
}

impl EqBand {
    fn name(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Mid => "mid",
            Self::High => "high",
        }
    }
}

/// Master clock source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MasterClockSource {
    /// First playing deck with a valid grid, else the internal clock.
    Auto,
    /// Always the internal clock.
    InternalClock,
    /// This deck while it plays with a valid grid.
    Deck { deck: u8 },
}

impl MasterClockSource {
    fn to_core(self) -> Result<ClockSource, DecksError> {
        Ok(match self {
            Self::Auto => ClockSource::Auto,
            Self::InternalClock => ClockSource::Internal,
            Self::Deck { deck } => ClockSource::Deck(deck_id(deck)?),
        })
    }

    fn from_core(c: ClockSource) -> Self {
        match c {
            ClockSource::Auto => Self::Auto,
            ClockSource::Internal => Self::InternalClock,
            ClockSource::Deck(d) => Self::Deck {
                deck: d.index() as u8,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum OutputModeKind {
    /// 4-channel mapping when the device has ≥ 4 channels, else stereo.
    Auto,
    Stereo,
    FourChannel,
}

/// Output routing matrix (mirror of `mixai_core::RoutingConfig`).
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct Routing {
    pub mode: OutputModeKind,
    /// Headphone blend: 0 = cue only, 1 = master only.
    pub cue_mix: f32,
    /// 0..1.5.
    pub headphone_level: f32,
    /// Split-mono on 2-channel outputs (L = cue, R = master).
    pub split_mono: bool,
    /// 0..1.5 (0 = booth off).
    pub booth_level: f32,
    pub master_latency_ms: f32,
    pub headphone_latency_ms: f32,
    pub booth_latency_ms: f32,
}

impl From<RoutingConfig> for Routing {
    fn from(r: RoutingConfig) -> Self {
        Self {
            mode: match r.mode {
                OutputMode::Auto => OutputModeKind::Auto,
                OutputMode::Stereo => OutputModeKind::Stereo,
                OutputMode::FourChannel => OutputModeKind::FourChannel,
            },
            cue_mix: r.cue_mix,
            headphone_level: r.headphone_level,
            split_mono: r.split_mono,
            booth_level: r.booth_level,
            master_latency_ms: r.master_latency_ms,
            headphone_latency_ms: r.headphone_latency_ms,
            booth_latency_ms: r.booth_latency_ms,
        }
    }
}

impl From<Routing> for RoutingConfig {
    fn from(r: Routing) -> Self {
        Self {
            mode: match r.mode {
                OutputModeKind::Auto => OutputMode::Auto,
                OutputModeKind::Stereo => OutputMode::Stereo,
                OutputModeKind::FourChannel => OutputMode::FourChannel,
            },
            cue_mix: r.cue_mix,
            headphone_level: r.headphone_level,
            split_mono: r.split_mono,
            booth_level: r.booth_level,
            master_latency_ms: r.master_latency_ms,
            headphone_latency_ms: r.headphone_latency_ms,
            booth_latency_ms: r.booth_latency_ms,
        }
    }
}

/// Colour FX (per channel, one knob).
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ColorFx {
    Off,
    Filter,
    Phaser,
    Flanger,
    Noise,
    DubEcho,
}

impl From<ColorFx> for ColorFxKind {
    fn from(c: ColorFx) -> Self {
        match c {
            ColorFx::Off => Self::None,
            ColorFx::Filter => Self::Filter,
            ColorFx::Phaser => Self::Phaser,
            ColorFx::Flanger => Self::Flanger,
            ColorFx::Noise => Self::Noise,
            ColorFx::DubEcho => Self::DubEcho,
        }
    }
}

/// Beat FX (beat-synced to the master clock).
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum BeatFx {
    Off,
    Echo,
    Reverb,
    Roll,
    Gate,
}

impl From<BeatFx> for BeatFxKind {
    fn from(b: BeatFx) -> Self {
        match b {
            BeatFx::Off => Self::None,
            BeatFx::Echo => Self::Echo,
            BeatFx::Reverb => Self::Reverb,
            BeatFx::Roll => Self::Roll,
            BeatFx::Gate => Self::Gate,
        }
    }
}

/// Per-deck part of [`EngineSnapshot`].
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct DeckSnapshot {
    pub deck: u8,
    pub loaded: bool,
    /// A load is decoding / analysing for this deck.
    pub loading: bool,
    pub title: Option<String>,
    pub playhead_sec: f64,
    pub duration_sec: f64,
    pub playing: bool,
    /// Track tempo from the beatgrid.
    pub bpm: Option<f64>,
    /// Audible tempo (grid × tempo fader × sync nudge).
    pub effective_bpm: Option<f64>,
    /// Live tempo ratio (1.0 = ±0 %).
    pub tempo: f64,
    pub key_lock: bool,
    pub key_shift_semitones: f64,
    /// Analysed key (Camelot).
    pub key_camelot: Option<String>,
    /// Key as heard after key shift and (without key lock) varispeed.
    pub effective_key_camelot: Option<String>,
    /// Fractional beat number at the playhead.
    pub beat: f64,
    /// Position in the bar (0..4) when the downbeat is known.
    pub bar_phase: Option<f64>,
    pub loop_active: bool,
    pub loop_start_sec: f64,
    pub loop_end_sec: f64,
    pub slip: bool,
    /// Slip shadow playhead while slip holds one (slip on + loop or reverse running).
    pub slip_shadow_sec: Option<f64>,
    pub quantize: bool,
    pub sync_lock: bool,
    /// Headphone cue (PFL).
    pub pfl: bool,
    /// Transport cue point.
    pub cue_point_sec: f64,
    /// 8 hot cues, `None` = empty.
    pub hot_cues: Vec<Option<f64>>,
    /// Channel fader 0..1.
    pub volume: f32,
    /// Channel trim in dB (pre-EQ, separate from the fader; −96 = −∞).
    pub gain_db: f32,
    /// Post-fader peak level 0..1.
    pub vu: f32,
}

/// Master clock part of [`EngineSnapshot`].
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ClockSnapshot {
    pub configured: MasterClockSource,
    /// Deck driving the clock right now (`None` = internal clock).
    pub source_deck: Option<u8>,
    pub bpm: f64,
    pub beat: f64,
    /// `beat` modulo 1.
    pub beat_phase: f64,
    pub bar_phase: Option<f64>,
    pub beats_per_bar: u32,
    /// Output frame at which `beat` was sampled; extrapolate with `bpm` and the sample rate.
    pub frame: u64,
}

/// Everything a deck UI needs per frame. Cheap: atomics + one small mirror clone.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct EngineSnapshot {
    pub running: bool,
    pub sample_rate: u32,
    pub latency_ms: f32,
    pub master_vu: f32,
    pub master_volume: f32,
    pub crossfader: f32,
    pub recording: bool,
    pub clock: ClockSnapshot,
    pub decks: Vec<DeckSnapshot>,
    /// Output channels of the open stream (0 when stopped).
    #[uniffi(default = 0)]
    pub channels: u16,
    /// Frames per audio callback (fixed or observed; `None` until known / stopped).
    #[uniffi(default = None)]
    pub buffer_frames: Option<u32>,
    /// Output device in use (`host:id`).
    #[uniffi(default = None)]
    pub output_device_id: Option<String>,
}

// ---- state ------------------------------------------------------------------------------

struct PendingLoad {
    buffer: TrackBuffer,
    title: String,
    path: String,
    bpm: f64,
    grid: Option<mixai_core::BeatGrid>,
    key: Option<u8>,
}

struct DeckData {
    info: Option<TrackInfo>,
    peaks: Option<WaveformPeaks>,
    grid: Option<BeatGridInfo>,
    key_index: Option<u8>,
    pending: Option<PendingLoad>,
    latest_ticket: u64,
    cue_point: f64,
    cue_preview: bool,
    fader: f32,
    gain_db: f32,
}

impl Default for DeckData {
    fn default() -> Self {
        Self {
            info: None,
            peaks: None,
            grid: None,
            key_index: None,
            pending: None,
            latest_ticket: 0,
            cue_point: 0.0,
            cue_preview: false,
            fader: 0.85,
            gain_db: 0.0,
        }
    }
}

#[derive(Default)]
struct Shared {
    engine: Option<Engine>,
    decks: [DeckData; DECKS],
    loads: HashMap<u64, LoadStatus>,
    config: DecksEngineConfig,
}

impl Shared {
    fn engine(&self) -> Result<&Engine, DecksError> {
        self.engine.as_ref().ok_or_else(not_running)
    }

    fn set_load(&mut self, ticket: u64, state: LoadState, error: Option<String>) {
        if let Some(s) = self.loads.get_mut(&ticket) {
            s.state = state;
            s.error = error;
        }
    }
}

/// Push the stored fader + trim of a deck into a (new) engine.
fn send_levels(e: &Engine, id: DeckId, d: &DeckData) {
    e.mirror().decks[id.index()].volume = d.fader;
    e.send(Command::Volume(id, d.fader));
    e.set_trim(id, d.gain_db);
}

fn send_load(e: &Engine, deck: DeckId, p: PendingLoad) {
    let dur = p.buffer.duration_secs();
    {
        let mut m = e.mirror();
        let d = &mut m.decks[deck.index()];
        d.track_id = Some(p.path.clone());
        d.title = Some(p.title.clone());
        d.bpm = p.bpm;
        d.loaded = true;
        d.duration = dur;
        d.position = 0.0;
        d.playing = false;
        d.first_beat = p.grid.as_ref().map_or(0.0, |g| g.first_beat);
    }
    e.send(Command::Load {
        deck,
        buffer: p.buffer,
        track_id: Some(p.path),
        title: Some(p.title),
        artist: None,
        bpm: p.bpm,
    });
    if let Some(g) = p.grid {
        e.set_grid(deck, g);
    }
    e.set_deck_key(deck, p.key);
}

fn key_index(k: &decks_analysis::KeyResult) -> u8 {
    k.tonic % 12
        + if k.mode == decks_analysis::Mode::Minor {
            12
        } else {
            0
        }
}

fn shifted_camelot(key: u8, semitones: f64) -> Option<String> {
    let shift = semitones.round() as i32;
    let minor = key >= 12;
    let pc = (i32::from(key % 12) + shift).rem_euclid(12) as u8;
    mixai_core::keys::key_to_camelot(pc + if minor { 12 } else { 0 })
}

struct Loaded {
    info: TrackInfo,
    peaks: Option<WaveformPeaks>,
    grid: Option<BeatGridInfo>,
    key: Option<u8>,
    buffer: TrackBuffer,
}

fn decode_and_analyse(shared: &Mutex<Shared>, ticket: u64, path: &str) -> Result<Loaded, String> {
    lock(shared).set_load(ticket, LoadState::Decoding, None);
    let audio = decks_analysis::decode_file(path).map_err(|e| e.to_string())?;
    lock(shared).set_load(ticket, LoadState::Analysing, None);
    let opts = decks_analysis::AnalyzeOptions {
        peaks_per_second: PEAKS_PER_SECOND,
        ..Default::default()
    };
    let a = decks_analysis::analyze(&audio.samples, audio.channels, audio.sample_rate, &opts);
    let ch = audio.channels.max(1) as usize;
    let frames = audio.samples.len() / ch;
    let mut left = Vec::with_capacity(frames);
    let mut right = Vec::with_capacity(frames);
    for f in audio.samples.chunks_exact(ch) {
        left.push(f[0]);
        right.push(if ch > 1 { f[1] } else { f[0] });
    }
    let title = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string();
    let info = TrackInfo {
        path: path.to_string(),
        title,
        duration_sec: a.duration_sec,
        sample_rate: audio.sample_rate,
        channels: audio.channels,
        bpm: a.beatgrid.as_ref().map(|g| g.bpm),
        first_beat_sec: a.beatgrid.as_ref().map(|g| g.first_beat_sec),
        key_camelot: a.key.as_ref().map(|k| k.camelot.clone()),
        key_open_key: a.key.as_ref().map(|k| k.open_key.clone()),
        key_name: a.key.as_ref().map(|k| k.name.clone()),
        key_confidence: a.key.as_ref().map(|k| k.confidence),
        integrated_lufs: a.loudness.as_ref().map(|l| l.integrated_lufs),
        true_peak_dbtp: a.loudness.as_ref().map(|l| l.true_peak_dbtp),
        gain_to_minus14_db: a.loudness.as_ref().map(|l| l.gain_to_minus14_db),
    };
    Ok(Loaded {
        info,
        peaks: a.peaks.as_ref().map(WaveformPeaks::from),
        grid: a.beatgrid.as_ref().map(BeatGridInfo::from),
        key: a.key.as_ref().map(key_index),
        buffer: TrackBuffer {
            left,
            right,
            sample_rate: audio.sample_rate,
        },
    })
}

fn finish_load(shared: &Mutex<Shared>, ticket: u64, deck: DeckId, result: Result<Loaded, String>) {
    let mut s = lock(shared);
    let i = deck.index();
    let current = s.decks[i].latest_ticket == ticket;
    let (state, error) = match result {
        Err(e) => (LoadState::Failed, Some(e)),
        Ok(_) if !current => (LoadState::Cancelled, None),
        Ok(l) => {
            let Shared { engine, decks, .. } = &mut *s;
            let d = &mut decks[i];
            let pending = PendingLoad {
                buffer: l.buffer,
                title: l.info.title.clone(),
                path: l.info.path.clone(),
                bpm: l.info.bpm.unwrap_or(0.0),
                grid: l.grid.as_ref().map(BeatGridInfo::to_core),
                key: l.key,
            };
            d.cue_point = l.info.first_beat_sec.unwrap_or(0.0);
            d.cue_preview = false;
            d.info = Some(l.info);
            d.peaks = l.peaks;
            d.grid = l.grid;
            d.key_index = l.key;
            match engine {
                Some(e) => {
                    d.pending = None;
                    send_load(e, deck, pending);
                }
                None => d.pending = Some(pending),
            }
            (LoadState::Ready, None)
        }
    };
    s.set_load(ticket, state, error);
}

// ---- object -----------------------------------------------------------------------------

/// The 4-deck MixAI audio engine. Thread-safe; the audio callback runs on its own thread.
#[derive(uniffi::Object)]
pub struct DecksEngine {
    shared: Arc<Mutex<Shared>>,
    next_ticket: AtomicU64,
}

/// Output devices of the default audio host.
#[uniffi::export]
pub fn list_output_devices() -> Vec<AudioOutputDevice> {
    mixai_core::list_output_devices()
        .into_iter()
        .map(|d| AudioOutputDevice {
            id: d.id,
            name: d.name,
            channels: d.channels,
            is_default: d.is_default,
        })
        .collect()
}

fn start_info(e: &Engine) -> EngineStartInfo {
    let o = e.output_info();
    EngineStartInfo {
        sample_rate: o.sample_rate,
        channels: o.channels,
        latency_ms: o.latency_ms,
        device_id: o.device_id,
        notes: o.notes,
        buffer_frames: o.buffer_frames,
        device_name: o.device_name,
    }
}

impl DecksEngine {
    fn with<R>(&self, f: impl FnOnce(&Engine) -> R) -> Result<R, DecksError> {
        let s = lock(&self.shared);
        Ok(f(s.engine()?))
    }

    /// `[eq_low, eq_mid, eq_high, filter]` per deck from the UI mirror (zeros while stopped).
    pub(crate) fn mixer_eq(&self) -> Vec<[f32; 4]> {
        let s = lock(&self.shared);
        match &s.engine {
            Some(e) => e
                .mirror()
                .decks
                .iter()
                .map(|d| [d.eq_low, d.eq_mid, d.eq_high, d.filter])
                .collect(),
            None => vec![[0.0; 4]; DECKS],
        }
    }

    fn deck_cmd(&self, deck: u8, f: impl FnOnce(DeckId) -> Command) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        self.with(|e| e.send(f(id)))
    }
}

#[uniffi::export]
impl DecksEngine {
    /// Create a stopped engine; call `start()` to open the audio device.
    #[uniffi::constructor]
    pub fn new(config: DecksEngineConfig) -> Self {
        let shared = Shared {
            config,
            ..Default::default()
        };
        Self {
            shared: Arc::new(Mutex::new(shared)),
            next_ticket: AtomicU64::new(1),
        }
    }

    pub fn list_output_devices(&self) -> Vec<AudioOutputDevice> {
        list_output_devices()
    }

    /// Choose the output device (`None` = system default). While running the stream moves to
    /// it at once (decks, routing and FX are kept); while stopped it is used by the next
    /// `start()`. Returns `true` when the device is in use (or will be). Unknown ids fail with
    /// `NotFound`; a device that cannot be opened fails with `Audio` and the previous device
    /// keeps playing.
    pub fn set_output_device(&self, device_id: Option<String>) -> Result<bool, DecksError> {
        if let Some(id) = &device_id
            && !list_output_devices().iter().any(|d| &d.id == id)
            && mixai_core::find_output_device(id).is_none()
        {
            return Err(DecksError::NotFound {
                reason: format!("output device {id}"),
            });
        }
        let mut s = lock(&self.shared);
        if let Some(e) = s.engine.as_mut() {
            e.switch_output_device(device_id.as_deref())
                .map_err(|e| DecksError::Audio {
                    reason: e.to_string(),
                })?;
        }
        s.config.output_device_id = device_id;
        Ok(true)
    }

    /// Open the audio device and start the audio thread. Tracks loaded while stopped are sent
    /// to the engine now. Honours `DecksEngineConfig` (device, sample rate, buffer frames);
    /// fallbacks are listed in `notes`. Idempotent.
    pub fn start(&self) -> Result<EngineStartInfo, DecksError> {
        let mut s = lock(&self.shared);
        if s.engine.is_none() {
            let c = s.config.clone();
            let engine = Engine::start_with(
                c.output_device_id.as_deref(),
                c.sample_rate,
                c.buffer_frames,
            )
            .map_err(|e| DecksError::Audio {
                reason: e.to_string(),
            })?;
            let Shared {
                engine: slot,
                decks,
                ..
            } = &mut *s;
            for (i, d) in decks.iter_mut().enumerate() {
                send_levels(&engine, DeckId::ALL[i], d);
                if let Some(p) = d.pending.take() {
                    send_load(&engine, DeckId::ALL[i], p);
                }
            }
            *slot = Some(engine);
        }
        Ok(start_info(s.engine()?))
    }

    /// Close the audio device. Decks are unloaded (reload after the next `start()`).
    pub fn stop(&self) {
        let mut s = lock(&self.shared);
        if let Some(e) = &s.engine
            && e.is_recording()
        {
            e.stop_recording();
        }
        s.engine = None;
        for d in s.decks.iter_mut() {
            *d = DeckData {
                latest_ticket: d.latest_ticket,
                fader: d.fader,
                gain_db: d.gain_db,
                ..Default::default()
            };
        }
    }

    pub fn is_running(&self) -> bool {
        lock(&self.shared).engine.is_some()
    }

    // ---- loading ----------------------------------------------------------------------

    /// Decode + analyse `path` on a background thread and load it on `deck`. Returns a ticket
    /// for `load_status`. A newer load on the same deck cancels this one. Works while stopped
    /// (the audio is handed to the engine on `start()`).
    pub fn load(&self, deck: u8, path: String) -> Result<u64, DecksError> {
        let id = deck_id(deck)?;
        if !Path::new(&path).is_file() {
            return Err(DecksError::NotFound {
                reason: format!("file {path}"),
            });
        }
        let ticket = self.next_ticket.fetch_add(1, Ordering::Relaxed);
        {
            let mut s = lock(&self.shared);
            s.decks[id.index()].latest_ticket = ticket;
            s.loads.retain(|t, _| *t + KEEP_TICKETS > ticket);
            s.loads.insert(
                ticket,
                LoadStatus {
                    ticket,
                    deck,
                    path: path.clone(),
                    state: LoadState::Queued,
                    error: None,
                },
            );
        }
        let shared = Arc::clone(&self.shared);
        std::thread::Builder::new()
            .name(format!("decks-load-{deck}"))
            .spawn(move || {
                let result = decode_and_analyse(&shared, ticket, &path);
                finish_load(&shared, ticket, id, result);
            })
            .map_err(|e| DecksError::Audio {
                reason: format!("spawn loader: {e}"),
            })?;
        Ok(ticket)
    }

    pub fn load_status(&self, ticket: u64) -> Option<LoadStatus> {
        lock(&self.shared).loads.get(&ticket).cloned()
    }

    /// Metadata of the loaded track.
    pub fn track_info(&self, deck: u8) -> Result<Option<TrackInfo>, DecksError> {
        let i = deck_id(deck)?.index();
        Ok(lock(&self.shared).decks[i].info.clone())
    }

    /// Waveform peaks of the loaded track (upload once to `DecksRenderer.set_peaks`).
    pub fn peaks(&self, deck: u8) -> Result<Option<WaveformPeaks>, DecksError> {
        let i = deck_id(deck)?.index();
        Ok(lock(&self.shared).decks[i].peaks.clone())
    }

    pub fn beatgrid(&self, deck: u8) -> Result<Option<BeatGridInfo>, DecksError> {
        let i = deck_id(deck)?.index();
        Ok(lock(&self.shared).decks[i].grid.clone())
    }

    /// Replace the beatgrid (user grid edit) and hand it to the engine.
    ///
    /// Every tempo (the base one **and** every anchor) must be inside 20..400 and every time
    /// finite and non-negative, or the call fails with `InvalidArgument`: the grid is read by
    /// the audio thread, where a `NaN` beat would poison the transport (WP19-37 P1-9).
    pub fn set_beatgrid(&self, deck: u8, grid: BeatGridInfo) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        checked_bpm("bpm", grid.bpm)?;
        checked_sec("first_beat_sec", grid.first_beat_sec)?;
        for (i, a) in grid.anchors.iter().enumerate() {
            checked_bpm(&format!("anchors[{i}].bpm"), a.bpm)?;
            checked_sec(&format!("anchors[{i}].time_sec"), a.time_sec)?;
        }
        let mut s = lock(&self.shared);
        if let Some(e) = &s.engine {
            e.set_grid(id, grid.to_core());
        }
        let d = &mut s.decks[id.index()];
        if let Some(info) = &mut d.info {
            info.bpm = Some(grid.bpm);
            info.first_beat_sec = Some(grid.first_beat_sec);
        }
        d.grid = Some(grid);
        Ok(())
    }

    // ---- transport ----------------------------------------------------------------------

    pub fn play(&self, deck: u8) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        self.with(|e| {
            e.mirror().decks[id.index()].playing = true;
            e.send(Command::Play(id));
        })
    }

    pub fn pause(&self, deck: u8) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        self.with(|e| {
            e.mirror().decks[id.index()].playing = false;
            e.send(Command::Pause(id));
        })
    }

    pub fn seek(&self, deck: u8, position_sec: f64) -> Result<(), DecksError> {
        let p = finite("position_sec", position_sec)?.max(0.0);
        self.deck_cmd(deck, |id| Command::Seek(id, p))
    }

    /// CDJ-style CUE button. Playing: back to the cue point and pause. Paused on the cue
    /// point: preview while held (release returns to the cue point). Paused elsewhere: set the
    /// cue point here.
    pub fn cue(&self, deck: u8, pressed: bool) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        let mut s = lock(&self.shared);
        let Shared { engine, decks, .. } = &mut *s;
        let e = engine.as_ref().ok_or_else(not_running)?;
        let d = &mut decks[id.index()];
        let live = e.snapshot_state();
        let st = &live.decks[id.index()];
        if pressed {
            if st.playing {
                e.send(Command::Pause(id));
                e.send(Command::Seek(id, d.cue_point));
                d.cue_preview = false;
            } else if (st.position - d.cue_point).abs() < 0.02 {
                e.send(Command::Play(id));
                d.cue_preview = true;
            } else {
                d.cue_point = st.position;
            }
        } else if d.cue_preview {
            e.send(Command::Pause(id));
            e.send(Command::Seek(id, d.cue_point));
            d.cue_preview = false;
        }
        Ok(())
    }

    /// Set the transport cue point explicitly.
    pub fn set_cue_point(&self, deck: u8, position_sec: f64) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        let p = finite("position_sec", position_sec)?.max(0.0);
        lock(&self.shared).decks[id.index()].cue_point = p;
        Ok(())
    }

    /// Store a hot cue (slot 0..7) at the playhead (quantised when quantize is on).
    pub fn hot_cue_set(&self, deck: u8, slot: u8) -> Result<(), DecksError> {
        let slot = hot_cue_slot(slot)?;
        self.deck_cmd(deck, |id| Command::SetHotCue(id, slot))
    }

    pub fn hot_cue_jump(&self, deck: u8, slot: u8) -> Result<(), DecksError> {
        let slot = hot_cue_slot(slot)?;
        self.deck_cmd(deck, |id| Command::JumpHotCue(id, slot))
    }

    pub fn hot_cue_delete(&self, deck: u8, slot: u8) -> Result<(), DecksError> {
        let slot = hot_cue_slot(slot)?;
        self.deck_cmd(deck, |id| Command::ClearHotCue(id, slot))
    }

    // ---- loops ------------------------------------------------------------------------

    pub fn loop_in(&self, deck: u8) -> Result<(), DecksError> {
        self.deck_cmd(deck, Command::LoopIn)
    }

    pub fn loop_out(&self, deck: u8) -> Result<(), DecksError> {
        self.deck_cmd(deck, Command::LoopOut)
    }

    /// Beat loop of `beats` from the (quantised) playhead.
    pub fn loop_auto(&self, deck: u8, beats: f64) -> Result<(), DecksError> {
        let b = finite("beats", beats)?;
        if b <= 0.0 {
            return Err(DecksError::invalid("beats must be > 0"));
        }
        self.deck_cmd(deck, |id| Command::Beatloop(id, b))
    }

    pub fn loop_halve(&self, deck: u8) -> Result<(), DecksError> {
        self.deck_cmd(deck, |id| Command::LoopScale(id, 0.5))
    }

    pub fn loop_double(&self, deck: u8) -> Result<(), DecksError> {
        self.deck_cmd(deck, |id| Command::LoopScale(id, 2.0))
    }

    /// Re-enter the last loop / leave the active one.
    pub fn loop_toggle(&self, deck: u8) -> Result<(), DecksError> {
        self.deck_cmd(deck, Command::LoopToggle)
    }

    pub fn loop_exit(&self, deck: u8) -> Result<(), DecksError> {
        self.deck_cmd(deck, Command::LoopExit)
    }

    /// Jump by `beats` (negative = back), quantised when quantize is on.
    pub fn beat_jump(&self, deck: u8, beats: f64) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        let b = finite("beats", beats)?;
        self.with(|e| e.beat_jump(id, b))
    }

    // ---- tempo / key / sync -----------------------------------------------------------

    /// Tempo ratio (1.0 = ±0 %, clamped to the engine range 0.5..2.0).
    pub fn set_tempo(&self, deck: u8, ratio: f64) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        let r = finite("ratio", ratio)?;
        self.with(|e| {
            e.mirror().decks[id.index()].tempo = r;
            e.send(Command::Tempo(id, r));
        })
    }

    pub fn set_key_lock(&self, deck: u8, on: bool) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        self.with(|e| {
            e.mirror().decks[id.index()].key_lock = on;
            e.send(Command::KeyLock(id, on));
        })
    }

    /// Key shift in semitones (−12..12), independent of tempo.
    pub fn set_key_shift(&self, deck: u8, semitones: f64) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        let st = finite("semitones", semitones)?;
        self.with(|e| e.set_key_shift(id, st))
    }

    /// Shift `deck` into the master deck's key (or its relative); returns the applied shift.
    pub fn key_match(&self, deck: u8) -> Result<f64, DecksError> {
        let id = deck_id(deck)?;
        self.with(|e| e.key_match(id, None, None))?
            .map_err(|e| DecksError::Unsupported {
                reason: e.to_string(),
            })
    }

    pub fn set_slip(&self, deck: u8, on: bool) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        self.with(|e| e.set_slip(id, on))
    }

    pub fn set_quantize(&self, deck: u8, on: bool) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        self.with(|e| e.set_quantize(id, on))
    }

    /// Match tempo and beat (bar when downbeats are known) phase to the master clock; `lock`
    /// keeps following it.
    pub fn phase_sync(&self, deck: u8, lock_on: bool) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        self.with(|e| e.phase_sync(id, lock_on))
    }

    pub fn set_sync_lock(&self, deck: u8, on: bool) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        self.with(|e| e.set_sync_lock(id, on))
    }

    pub fn set_reverse(&self, deck: u8, on: bool) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        self.with(|e| e.set_reverse(id, on))
    }

    // ---- mixer ------------------------------------------------------------------------

    /// EQ band gain in dB (−26 = kill .. +6).
    pub fn set_eq(&self, deck: u8, band: EqBand, db: f32) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        if !db.is_finite() {
            return Err(DecksError::invalid("db must be finite"));
        }
        self.with(|e| {
            {
                let mut m = e.mirror();
                let d = &mut m.decks[id.index()];
                match band {
                    EqBand::Low => d.eq_low = db,
                    EqBand::Mid => d.eq_mid = db,
                    EqBand::High => d.eq_high = db,
                }
            }
            e.send(Command::Eq(id, band.name().to_string(), db));
        })
    }

    /// Bipolar filter −1 (low-pass) .. 0 (off) .. 1 (high-pass).
    pub fn set_filter(&self, deck: u8, value: f32) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        self.with(|e| {
            e.mirror().decks[id.index()].filter = value;
            e.send(Command::Filter(id, value));
        })
    }

    /// Channel trim in dB (−∞..+12; ≤ −96 = silence), applied pre-EQ by the engine's trim stage,
    /// independent of the channel fader. Stored while stopped and applied on `start()`.
    pub fn set_gain(&self, deck: u8, db: f32) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        if db.is_nan() || db == f32::INFINITY {
            return Err(DecksError::invalid("db must be a number below +inf"));
        }
        let mut s = lock(&self.shared);
        let d = &mut s.decks[id.index()];
        d.gain_db = db.clamp(mixai_core::deck::TRIM_MIN_DB, mixai_core::deck::TRIM_MAX_DB);
        let g = d.gain_db;
        if let Some(e) = &s.engine {
            e.set_trim(id, g);
        }
        Ok(())
    }

    /// Channel fader 0..1. Stored while stopped and applied on `start()`.
    pub fn set_volume(&self, deck: u8, value: f32) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        if !value.is_finite() {
            return Err(DecksError::invalid("value must be finite"));
        }
        let mut s = lock(&self.shared);
        let d = &mut s.decks[id.index()];
        d.fader = value.clamp(0.0, 1.0);
        let f = d.fader;
        if let Some(e) = &s.engine {
            e.mirror().decks[id.index()].volume = f;
            e.send(Command::Volume(id, f));
        }
        Ok(())
    }

    /// −1 (full A side) .. 1 (full B side).
    pub fn set_crossfader(&self, value: f32) -> Result<(), DecksError> {
        self.with(|e| {
            e.mirror().crossfader = value;
            e.send(Command::Crossfader(value));
        })
    }

    pub fn set_master_volume(&self, value: f32) -> Result<(), DecksError> {
        self.with(|e| {
            e.mirror().master_volume = value;
            e.send(Command::MasterVolume(value));
        })
    }

    /// Headphone cue (PFL) for a channel.
    pub fn set_pfl(&self, deck: u8, on: bool) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        self.with(|e| {
            e.mirror().decks[id.index()].cue = on;
            e.send(Command::Cue(id, on));
        })
    }

    pub fn routing_set(&self, routing: Routing) -> Result<(), DecksError> {
        self.with(|e| e.set_routing(routing.into()))
    }

    pub fn routing_get(&self) -> Result<Routing, DecksError> {
        self.with(|e| e.routing().into())
    }

    /// Master clock source and/or internal clock tempo (`None` keeps it).
    pub fn set_master_clock(
        &self,
        source: MasterClockSource,
        bpm: Option<f64>,
    ) -> Result<(), DecksError> {
        let src = source.to_core()?;
        self.with(|e| e.set_clock(src, bpm))
    }

    pub fn set_color_fx(&self, deck: u8, fx: ColorFx, param: f32) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        self.with(|e| e.set_color_fx(id, fx.into(), param))
    }

    pub fn set_beat_fx(
        &self,
        deck: u8,
        fx: BeatFx,
        wet: f32,
        beats: f64,
        feedback: f32,
    ) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        let b = finite("beats", beats)?;
        self.with(|e| e.set_beat_fx(id, fx.into(), wet, b, feedback))
    }

    /// Record the master mix to a WAV file.
    pub fn record_start(&self, path: String) -> Result<(), DecksError> {
        self.with(|e| e.start_recording(path.into()))
    }

    /// Stem playback on/off for a deck (the deck must have stems loaded; buffers are kept).
    pub fn set_stems_active(&self, deck: u8, on: bool) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        self.with(|e| e.set_stems_active(id, on))
    }

    /// Live gain 0..1.5 of stem `stem` (0 vocals, 1 drums, 2 bass, 3 melody).
    pub fn set_stem_gain(&self, deck: u8, stem: u8, gain: f32) -> Result<(), DecksError> {
        let id = deck_id(deck)?;
        if stem > 3 {
            return Err(DecksError::invalid(format!(
                "stem {stem} out of range 0..=3"
            )));
        }
        if !gain.is_finite() {
            return Err(DecksError::invalid("gain must be finite"));
        }
        self.with(|e| e.set_stem_gain(id, stem as usize, gain))
    }

    pub fn record_stop(&self) -> Result<(), DecksError> {
        self.with(|e| e.stop_recording())
    }

    // ---- snapshot ---------------------------------------------------------------------

    /// Poll at display rate (60–120 Hz): atomics from the audio thread + the UI mirror.
    pub fn snapshot(&self) -> EngineSnapshot {
        let s = lock(&self.shared);
        let live = s
            .engine
            .as_ref()
            .map(|e| (e, e.snapshot_state(), e.clock_state(), e.perf().clone()));
        let mut decks = Vec::with_capacity(DECKS);
        for (i, d) in s.decks.iter().enumerate() {
            let ms = live.as_ref().map(|l| &l.1.decks[i]);
            let dc = live.as_ref().and_then(|l| l.2.decks.get(i));
            let tempo = ms.map_or(1.0, |m| m.tempo);
            let key_lock = ms.is_none_or(|m| m.key_lock);
            let key_shift = dc.map_or(0.0, |c| c.key_shift);
            let bpm = d.info.as_ref().and_then(|t| t.bpm);
            let pitch = key_shift + mixai_core::keys::tempo_semitones(tempo, key_lock);
            decks.push(DeckSnapshot {
                deck: i as u8,
                loaded: d.info.is_some(),
                loading: s.loads.get(&d.latest_ticket).is_some_and(|l| {
                    matches!(
                        l.state,
                        LoadState::Queued | LoadState::Decoding | LoadState::Analysing
                    )
                }),
                title: d.info.as_ref().map(|t| t.title.clone()),
                playhead_sec: ms.map_or(0.0, |m| m.position),
                duration_sec: d
                    .info
                    .as_ref()
                    .map_or_else(|| ms.map_or(0.0, |m| m.duration), |t| t.duration_sec),
                playing: ms.is_some_and(|m| m.playing),
                bpm,
                effective_bpm: dc
                    .map(|c| c.bpm)
                    .filter(|b| *b > 0.0)
                    .or(bpm.map(|b| b * tempo)),
                tempo,
                key_lock,
                key_shift_semitones: key_shift,
                key_camelot: d.info.as_ref().and_then(|t| t.key_camelot.clone()),
                effective_key_camelot: d.key_index.and_then(|k| shifted_camelot(k, pitch)),
                beat: dc.map_or(0.0, |c| c.beat),
                bar_phase: dc.and_then(|c| c.bar_phase),
                loop_active: ms.is_some_and(|m| m.loop_active),
                loop_start_sec: ms.map_or(0.0, |m| m.loop_start),
                loop_end_sec: ms.map_or(0.0, |m| m.loop_end),
                slip: dc.is_some_and(|c| c.slip),
                slip_shadow_sec: ms.and_then(|m| m.slip_shadow),
                quantize: dc.is_some_and(|c| c.quantize),
                sync_lock: dc.is_some_and(|c| c.sync_lock),
                pfl: ms.is_some_and(|m| m.cue),
                cue_point_sec: d.cue_point,
                hot_cues: ms.map_or_else(|| vec![None; HOT_CUES as usize], |m| m.hot_cues.clone()),
                volume: d.fader,
                gain_db: d.gain_db,
                vu: ms.map_or(0.0, |m| m.vu),
            });
        }
        let clock = match &live {
            Some((_, _, c, p)) => ClockSnapshot {
                configured: MasterClockSource::from_core(p.clock),
                source_deck: DeckId::from_str(&c.source).map(|d| d.index() as u8),
                bpm: c.bpm,
                beat: c.beat,
                beat_phase: c.beat_phase,
                bar_phase: c.bar_phase,
                beats_per_bar: c.beats_per_bar,
                frame: c.frame,
            },
            None => ClockSnapshot {
                configured: MasterClockSource::Auto,
                source_deck: None,
                bpm: 0.0,
                beat: 0.0,
                beat_phase: 0.0,
                bar_phase: None,
                beats_per_bar: 4,
                frame: 0,
            },
        };
        EngineSnapshot {
            running: live.is_some(),
            sample_rate: live.as_ref().map_or(0, |l| l.1.sample_rate),
            latency_ms: live.as_ref().map_or(0.0, |l| l.1.latency_ms),
            master_vu: live.as_ref().map_or(0.0, |l| l.1.master_vu),
            master_volume: live.as_ref().map_or(0.85, |l| l.1.master_volume),
            crossfader: live.as_ref().map_or(0.0, |l| l.1.crossfader),
            recording: live.as_ref().is_some_and(|l| l.0.is_recording()),
            clock,
            decks,
            channels: live.as_ref().map_or(0, |l| l.1.channels),
            buffer_frames: live.as_ref().and_then(|l| l.1.buffer_frames),
            output_device_id: live.as_ref().and_then(|l| l.0.output_info().device_id),
        }
    }
}

fn hot_cue_slot(slot: u8) -> Result<usize, DecksError> {
    if slot < HOT_CUES {
        Ok(slot as usize)
    } else {
        Err(DecksError::invalid(format!(
            "hot cue slot {slot} out of range 0..=7"
        )))
    }
}

#[cfg(test)]
mod grid_tests {
    use super::*;

    /// Click track (20 ms decaying noise burst per beat, accent on every 4th) at `sr`.
    fn clicks(sr: u32, secs: f64, times: &[f64]) -> Vec<f32> {
        let mut out = vec![0.0f32; (sr as f64 * secs) as usize];
        let mut seed = 42u64;
        for (k, &t) in times.iter().enumerate() {
            let start = (t * sr as f64).round() as usize;
            let amp = if k % 4 == 0 { 0.8 } else { 0.35 };
            for i in 0..(0.02 * sr as f64) as usize {
                let Some(o) = out.get_mut(start + i) else {
                    break;
                };
                seed = seed
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                let noise = ((seed >> 40) as f64 / (1u64 << 24) as f64) * 2.0 - 1.0;
                let tt = i as f64 / sr as f64;
                *o += (amp * noise * (-tt / 0.004).exp()) as f32;
            }
        }
        out
    }

    /// Worst |true beat − nearest grid beat| over `beats`, in seconds.
    fn worst_error(g: &mixai_core::BeatGrid, beats: &[f64]) -> f64 {
        worst_at(g, beats).0
    }

    /// (worst error, true beat time where it happens).
    fn worst_at(g: &mixai_core::BeatGrid, beats: &[f64]) -> (f64, f64) {
        beats
            .iter()
            .map(|&t| ((g.nearest_beat_time(t) - t).abs(), t))
            .fold((0.0, 0.0), |a, b| if b.0 > a.0 { b } else { a })
    }

    /// P1-8, measured: a four-section click track (120 → 127 → 117 → 129 BPM) analysed end to
    /// end. Before the fix every section start was re-integrated from the previous section's
    /// fitted tempo (`from_markers`), so the boundary disagreement of the line fits accumulated
    /// into a permanent offset; now each section is pinned to the beat the tracker counted.
    #[test]
    fn analysed_sections_do_not_accumulate_phase_error() {
        let sr = 22_050;
        let secs = 72.0;
        let mut times = Vec::new();
        let mut t = 0.25;
        while t < secs - 0.3 {
            times.push(t);
            let bpm = match t {
                x if x < 18.0 => 120.0,
                x if x < 36.0 => 127.0,
                x if x < 54.0 => 117.0,
                _ => 129.0,
            };
            t += 60.0 / bpm;
        }
        let audio = clicks(sr, secs, &times);
        let opts = decks_analysis::AnalyzeOptions {
            key: false,
            loudness: false,
            peaks_per_second: 0,
            ..Default::default()
        };
        let a = decks_analysis::analyze(&audio, 1, sr, &opts);
        let info = BeatGridInfo::from(a.beatgrid.as_ref().expect("grid"));
        assert!(
            info.is_variable && info.anchors.len() >= 3,
            "{:?}",
            info.anchors
        );
        assert!(!info.beats.is_empty(), "analysed grids carry their beats");

        // Before: the previous (integrating) conversion.
        let markers: Vec<TempoMarker> = info
            .anchors
            .iter()
            .skip(1)
            .map(|a| TempoMarker {
                sec: a.time_sec,
                bpm: a.bpm,
            })
            .collect();
        let before = mixai_core::BeatGrid::from_markers(
            info.anchors[0].bpm,
            info.first_beat_sec,
            &markers,
            false,
        );
        // After: what the deck now gets.
        let after = info.to_core();

        let tail = &times[times.len() - 16..];
        let (b_tail, a_tail) = (worst_error(&before, tail), worst_error(&after, tail));
        let (b_all, a_all) = (worst_error(&before, &times), worst_error(&after, &times));
        let (_, a_where) = worst_at(&after, &times);
        let sections: Vec<(u32, f64, f64)> = info
            .anchors
            .iter()
            .map(|a| (a.beat_index, a.time_sec, a.bpm))
            .collect();
        let report = format!(
            "P1-8 anchors={} | last 16 beats: before {:.2} ms, after {:.2} ms | \
             whole track: before {:.2} ms, after {:.2} ms (at {:.2} s) | sections {:?}",
            info.anchors.len(),
            b_tail * 1e3,
            a_tail * 1e3,
            b_all * 1e3,
            a_all * 1e3,
            a_where,
            sections,
        );
        println!("{report}");
        // Measured 2026-11-10: before 144.4 ms (last 16 beats) / 187.0 ms (worst), after
        // 0.64 / 0.73 ms. Bound: 5 ms everywhere (a DJ hears flamming from ~10 ms).
        assert!(a_tail < 0.005, "{report}");
        assert!(a_all < 0.005, "{report}");
        assert!(a_tail <= b_tail + 1e-9, "{report}");
    }

    /// P1-7: a variable grid is written to the library with its FIRST section's tempo, not the
    /// average, so every later marker keeps its beat number.
    #[test]
    fn library_grid_starts_at_the_first_section_tempo() {
        let info = BeatGridInfo {
            bpm: 124.0, // the average differs from the first section (120)
            confidence: 1.0,
            first_beat_sec: 0.5,
            downbeat_offset_beats: 0,
            downbeat_confidence: 1.0,
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
            ],
            beats: Vec::new(),
            fixed: false,
        };
        let lib = info.to_library();
        assert_eq!(lib.bpm, 120.0);
        assert_eq!(lib.anchors.len(), 1);
        // And the engine and library agree on where the marker falls (beat 32).
        let core = info.to_core();
        assert!((core.beat_at(16.5) - 32.0).abs() < 1e-9);
        let back = mixai_core::BeatGrid::from_markers(
            lib.bpm,
            lib.first_beat_sec,
            &[TempoMarker {
                sec: lib.anchors[0].sec,
                bpm: lib.anchors[0].bpm,
            }],
            false,
        );
        assert!((back.beat_at(16.5) - 32.0).abs() < 1e-9);
        // Constant grids still write the nominal tempo.
        let constant = BeatGridInfo {
            is_variable: false,
            anchors: Vec::new(),
            ..info
        };
        assert_eq!(constant.to_library().bpm, 124.0);
    }
}
