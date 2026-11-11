//! The MIXAI audio engine.
//!
//! Architecture:
//!   - The public `Engine` lives on the app/UI side. It owns the cpal output
//!     stream and a `crossbeam` command sender.
//!   - A `Mixer` (the real-time state) is moved into the audio callback and is
//!     only mutated there. The UI talks to it exclusively via `Command`s drained
//!     at the top of each callback — no locks in the RT path.
//!   - A shared `Arc<AtomicSnapshot>` lets the UI poll cheap meter/transport
//!     state at ~30 Hz without touching the RT mixer.
//!   - The mixer lives in a [`MixerHome`] inside the callback; when cpal drops the
//!     callback (stream stopped) the home hands the mixer back, so an output device
//!     switch rebuilds the stream around the same decks, routing and queued commands.

use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Stream, StreamConfig};
use crossbeam_channel::{Receiver, Sender, bounded};
use serde::{Deserialize, Serialize};

use crate::beatfx::BeatFxKind;
use crate::beatgrid::{BeatGrid, wrap_phase};
use crate::colorfx::ColorFxKind;
use crate::deck::{Deck, TEMPO_MAX, TEMPO_MIN, TrackBuffer};
use crate::dsp::{crossfader_gain, soft_clip};
use crate::error::CoreError;
use crate::output::{self, BufferChoice, OutputInfo};
use crate::routing::{CompDelay, RoutingConfig, write_frame};
use crate::state::{AudioDevice, CrossfaderAssign, CrossfaderCurve, DeckId, MixerState};

/// Where the master clock comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClockSource {
    /// First playing deck with a valid beatgrid, else the internal clock.
    #[default]
    Auto,
    /// Always the internal clock.
    Internal,
    /// This deck while it plays with a valid grid (internal clock otherwise).
    Deck(DeckId),
}

impl ClockSource {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(Self::Auto),
            "internal" => Some(Self::Internal),
            other => DeckId::from_str(other).map(Self::Deck),
        }
    }
}

/// Max correction applied by sync lock (fraction of tempo).
const SYNC_NUDGE_MAX: f64 = 0.02;
/// Beats per bar assumed for the internal clock.
const INTERNAL_BPB: f64 = 4.0;

/// Per-deck clock view for the UI / MIDI clock consumers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckClock {
    pub id: DeckId,
    /// Audible tempo (grid × tempo fader × sync nudge).
    pub bpm: f64,
    /// Fractional beat number at the playhead.
    pub beat: f64,
    /// Position inside the bar (0..beatsPerBar) when the downbeat is known.
    pub bar_phase: Option<f64>,
    pub key_shift: f64,
    pub slip: bool,
    pub quantize: bool,
    pub sync_lock: bool,
}

/// Master clock snapshot: enough to drive MIDI clock / Ableton-Link style followers.
/// `beat` is valid at audio frame `frame`; extrapolate with `bpm` and `sampleRate`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockState {
    /// Configured source (`auto`, `internal`, `a`..`d`).
    pub configured: String,
    /// Source actually driving the clock right now (`internal` or a deck id).
    pub source: String,
    pub bpm: f64,
    /// Fractional master beat count.
    pub beat: f64,
    /// `beat` modulo 1 (0..1).
    pub beat_phase: f64,
    /// Position in the bar (0..beatsPerBar); internal clock counts bars from beat 0.
    pub bar_phase: Option<f64>,
    pub beats_per_bar: u32,
    /// Output frame counter at which `beat` was sampled.
    pub frame: u64,
    pub sample_rate: u32,
    /// Output channels of the open stream.
    pub channels: u16,
    /// Frames per audio callback (fixed or observed; `None` until known).
    pub buffer_frames: Option<u32>,
    pub decks: Vec<DeckClock>,
}

/// Commands sent from the UI thread to the real-time mixer.
pub enum Command {
    Load {
        deck: DeckId,
        buffer: TrackBuffer,
        track_id: Option<String>,
        title: Option<String>,
        artist: Option<String>,
        bpm: f64,
    },
    Play(DeckId),
    Pause(DeckId),
    Seek(DeckId, f64),
    Volume(DeckId, f32),
    /// Channel trim in dB (−∞..+12), pre-EQ, independent of the fader.
    Trim(DeckId, f32),
    Tempo(DeckId, f64),
    KeyLock(DeckId, bool),
    Eq(DeckId, String, f32),
    Filter(DeckId, f32),
    Cue(DeckId, bool),
    Crossfader(f32),
    /// Crossfader gain law (linear / smooth = equal power / sharp = cut).
    CrossfaderCurve(CrossfaderCurve),
    /// Which crossfader side a deck sits on (`Thru` bypasses the crossfader).
    CrossfaderAssign(DeckId, CrossfaderAssign),
    MasterVolume(f32),
    // Hot cues (slot 0..7).
    SetHotCue(DeckId, usize),
    JumpHotCue(DeckId, usize),
    ClearHotCue(DeckId, usize),
    // Loops.
    LoopIn(DeckId),
    LoopOut(DeckId),
    LoopToggle(DeckId),
    LoopExit(DeckId),
    Beatloop(DeckId, f64),
    LoopScale(DeckId, f64),
    /// Toggle whether the master mix is captured into the recording channel.
    SetRecording(bool),
    // Stems: attach separated layers (vocals, drums, bass, melody) to a deck,
    // toggle stem playback, and blend per-stem gain live.
    LoadStems {
        deck: DeckId,
        layers: Box<[Option<TrackBuffer>; 4]>,
    },
    SetStemsActive(DeckId, bool),
    SetStemGain(DeckId, usize, f32),
    // FX: per-deck beat-synced echo / reverb.
    SetFxKind(DeckId, u8),
    SetFxWet(DeckId, f32),
    SetFxBeats(DeckId, f64),
    // Sampler: one-shot pad bank.
    LoadSample {
        pad: usize,
        buffer: TrackBuffer,
    },
    ClearSample(usize),
    TriggerSample(usize),
    StopSample(usize),
    SetSampleGain(usize, f32),
    SetSampleLooping(usize, bool),
    // ---- WP19-05 sync / performance ----
    /// Replace a deck's beatgrid (built off the audio thread).
    SetGrid(DeckId, Box<BeatGrid>),
    /// Match tempo + align beat (bar when downbeats known) phase to the master.
    /// `lock` keeps the deck locked (continuous tempo follow + phase nudging).
    PhaseSync {
        deck: DeckId,
        lock: bool,
    },
    SetSyncLock(DeckId, bool),
    SetQuantize(DeckId, bool),
    BeatJump(DeckId, f64),
    SetSlip(DeckId, bool),
    SetReverse(DeckId, bool),
    /// Key shift in semitones (independent of tempo).
    SetKeyShift(DeckId, f64),
    /// Master clock source and internal clock tempo (`None` keeps the current tempo).
    SetClock(ClockSource, Option<f64>),
    // ---- WP19-06 routing ----
    SetRouting(RoutingConfig),
    // ---- WP19-10 FX ----
    SetColorFx(DeckId, ColorFxKind, f32),
    SetBeatFx {
        deck: DeckId,
        kind: BeatFxKind,
        wet: f32,
        beats: f64,
        feedback: f32,
    },
}

/// Lightweight, lock-free snapshot for the UI poll (positions + meters).
/// Stored per deck as fixed-point to avoid float atomics on all platforms.
pub struct Snapshot {
    pub master_vu: AtomicU32,
    pub deck_vu: [AtomicU32; 4],
    pub deck_pos_ms: [AtomicU32; 4],
    pub deck_dur_ms: [AtomicU32; 4],
    pub deck_playing: [AtomicBool; 4],
    /// Hot-cue positions in ms; `u32::MAX` means unset. [deck][slot].
    pub deck_hot_cues_ms: [[AtomicU32; 8]; 4],
    pub deck_loop_active: [AtomicBool; 4],
    pub deck_loop_start_ms: [AtomicU32; 4],
    pub deck_loop_end_ms: [AtomicU32; 4],
    // Master clock (f64 values stored as bits).
    pub clock_bpm: AtomicU64,
    pub clock_beat: AtomicU64,
    /// 0..3 = deck index, 4 = internal.
    pub clock_source: AtomicU8,
    pub clock_frame: AtomicU64,
    pub deck_beat: [AtomicU64; 4],
    pub deck_bpm: [AtomicU64; 4],
    /// Bar phase bits; `u64::MAX` = unknown.
    pub deck_bar_phase: [AtomicU64; 4],
    /// Live tempo ratio (fader × sync nudge); sync lock changes it on the RT side.
    pub deck_tempo: [AtomicU64; 4],
    /// Slip shadow playhead in seconds (f64 bits); `u64::MAX` = slip not engaged.
    pub deck_slip_pos: [AtomicU64; 4],
    /// Frames in the last audio callback (0 = no callback yet).
    pub buffer_frames: AtomicU32,
    /// Audio callback load in permille of the buffer period (peak-held, slow decay).
    pub dsp_load: AtomicU32,
    /// Callbacks that took longer than their buffer period since the engine started. The
    /// snapshot belongs to the engine, not to one stream: the count (and the peak-held
    /// `dsp_load`) carries over an output device switch.
    pub overruns: AtomicU32,
}

impl Snapshot {
    fn new() -> Self {
        Snapshot {
            clock_bpm: AtomicU64::new(120f64.to_bits()),
            clock_beat: AtomicU64::new(0f64.to_bits()),
            clock_source: AtomicU8::new(4),
            clock_frame: AtomicU64::new(0),
            deck_beat: Default::default(),
            deck_bpm: Default::default(),
            deck_bar_phase: Default::default(),
            deck_tempo: std::array::from_fn(|_| AtomicU64::new(1f64.to_bits())),
            deck_slip_pos: std::array::from_fn(|_| AtomicU64::new(u64::MAX)),
            buffer_frames: AtomicU32::new(0),
            dsp_load: AtomicU32::new(0),
            overruns: AtomicU32::new(0),
            master_vu: AtomicU32::new(0),
            deck_vu: Default::default(),
            deck_pos_ms: Default::default(),
            deck_dur_ms: Default::default(),
            deck_playing: Default::default(),
            deck_hot_cues_ms: Default::default(),
            deck_loop_active: Default::default(),
            deck_loop_start_ms: Default::default(),
            deck_loop_end_ms: Default::default(),
        }
    }
}

/// The real-time mixer state. Lives inside the audio callback only.
struct Mixer {
    /// Device sample rate (changes only between streams, see `set_sample_rate`).
    sr: f32,
    decks: Vec<Deck>,
    crossfader: f32,
    curve: u8,
    master_vol: crate::dsp::Smoothed,
    master_vu: f32,
    /// Callback time / buffer period, peak-held (see `Snapshot::dsp_load`).
    dsp_load: f32,
    // Master clock.
    clock_cfg: ClockSource,
    internal_bpm: f64,
    internal_beat: f64,
    /// Deck index driving the clock in the current block (None = internal).
    clock_master: Option<usize>,
    frames_total: u64,
    // Routing matrix (WP19-06).
    routing: RoutingConfig,
    comp_master: CompDelay,
    comp_phones: CompDelay,
    comp_booth: CompDelay,
    snapshot: Arc<Snapshot>,
    rx: Receiver<Command>,
    frame_counter: u64,
    // Recording: when `rec_on` is true the master mix is pushed to `rec_tx`
    // in fixed-size blocks (RT-safe; never blocks).
    rec_tx: Sender<crate::recorder::RecBlock>,
    rec_on: bool,
    rec_buf: Vec<f32>,
    // One-shot sampler pad bank (mixed into the master post-fader).
    sampler: crate::sampler::Sampler,
}

impl Mixer {
    fn new(
        sr: f32,
        rx: Receiver<Command>,
        snapshot: Arc<Snapshot>,
        rec_tx: Sender<crate::recorder::RecBlock>,
    ) -> Self {
        Mixer {
            sr,
            decks: DeckId::ALL.iter().map(|&id| Deck::new(id, sr)).collect(),
            crossfader: 0.0,
            curve: 1, // smooth
            master_vol: crate::dsp::Smoothed::new(0.85, sr, 15.0),
            master_vu: 0.0,
            dsp_load: 0.0,
            clock_cfg: ClockSource::Auto,
            internal_bpm: 120.0,
            internal_beat: 0.0,
            clock_master: None,
            frames_total: 0,
            routing: RoutingConfig::default(),
            comp_master: CompDelay::new(sr),
            comp_phones: CompDelay::new(sr),
            comp_booth: CompDelay::new(sr),
            snapshot,
            rx,
            frame_counter: 0,
            rec_tx,
            rec_on: false,
            rec_buf: Vec::with_capacity(2048),
            sampler: crate::sampler::Sampler::new(sr),
        }
    }

    /// Re-target the mixer to a new device rate (called off the audio thread, between streams).
    fn set_sample_rate(&mut self, sr: f32) {
        if !sr.is_finite() || sr <= 0.0 || (sr - self.sr).abs() < f32::EPSILON {
            return;
        }
        self.sr = sr;
        for d in self.decks.iter_mut() {
            d.set_sample_rate(sr);
        }
        let mv = self.master_vol.target();
        self.master_vol = crate::dsp::Smoothed::new(mv, sr, 15.0);
        self.comp_master = CompDelay::new(sr);
        self.comp_phones = CompDelay::new(sr);
        self.comp_booth = CompDelay::new(sr);
        self.comp_master.set_ms(self.routing.master_latency_ms, sr);
        self.comp_phones
            .set_ms(self.routing.headphone_latency_ms, sr);
        self.comp_booth.set_ms(self.routing.booth_latency_ms, sr);
        self.sampler.set_sample_rate(sr);
    }

    fn drain_commands(&mut self) {
        while let Ok(cmd) = self.rx.try_recv() {
            match cmd {
                Command::Load {
                    deck,
                    buffer,
                    track_id,
                    title,
                    artist,
                    bpm,
                } => {
                    let d = &mut self.decks[deck.index()];
                    d.load(buffer, (track_id, title, artist, bpm));
                }
                Command::Play(d) => self.decks[d.index()].play(),
                Command::Pause(d) => self.decks[d.index()].pause(),
                Command::Seek(d, s) => self.decks[d.index()].seek_secs(s),
                Command::Volume(d, v) => self.decks[d.index()].set_volume(v),
                Command::Trim(d, db) => self.decks[d.index()].set_trim_db(db),
                Command::Tempo(d, t) => self.decks[d.index()].set_tempo(t),
                Command::KeyLock(d, on) => self.decks[d.index()].set_key_lock(on),
                Command::Eq(d, band, db) => self.decks[d.index()].set_eq(&band, db),
                Command::Filter(d, v) => self.decks[d.index()].set_filter(v),
                Command::Cue(d, on) => self.decks[d.index()].set_cue(on),
                Command::Crossfader(v) => self.crossfader = v.clamp(-1.0, 1.0),
                Command::CrossfaderCurve(c) => self.curve = c.law(),
                Command::CrossfaderAssign(d, a) => self.decks[d.index()].crossfader_assign = a,
                Command::MasterVolume(v) => self.master_vol.set_target(v.clamp(0.0, 1.5)),
                Command::SetHotCue(d, slot) => self.decks[d.index()].set_hot_cue(slot),
                Command::JumpHotCue(d, slot) => {
                    self.decks[d.index()].jump_hot_cue(slot);
                }
                Command::ClearHotCue(d, slot) => self.decks[d.index()].clear_hot_cue(slot),
                Command::LoopIn(d) => self.decks[d.index()].loop_in(),
                Command::LoopOut(d) => self.decks[d.index()].loop_out(),
                Command::LoopToggle(d) => self.decks[d.index()].loop_toggle(),
                Command::LoopExit(d) => self.decks[d.index()].loop_exit(),
                Command::Beatloop(d, beats) => self.decks[d.index()].beatloop(beats),
                Command::LoopScale(d, factor) => self.decks[d.index()].loop_scale(factor),
                Command::SetRecording(on) => {
                    self.rec_on = on;
                    if !on {
                        // Flush any partial block so nothing is lost.
                        self.flush_rec_block();
                    }
                }
                Command::LoadStems { deck, layers } => {
                    self.decks[deck.index()].set_stems(*layers);
                }
                Command::SetStemsActive(d, on) => self.decks[d.index()].set_stems_active(on),
                Command::SetStemGain(d, idx, g) => self.decks[d.index()].set_stem_gain(idx, g),
                Command::SetFxKind(d, k) => self.decks[d.index()].set_fx_kind(k),
                Command::SetFxWet(d, w) => self.decks[d.index()].set_fx_wet(w),
                Command::SetFxBeats(d, b) => self.decks[d.index()].set_fx_beats(b),
                Command::LoadSample { pad, buffer } => self.sampler.load(pad, buffer),
                Command::ClearSample(pad) => self.sampler.clear(pad),
                Command::TriggerSample(pad) => self.sampler.trigger(pad),
                Command::StopSample(pad) => self.sampler.stop(pad),
                Command::SetSampleGain(pad, g) => self.sampler.set_gain(pad, g),
                Command::SetSampleLooping(pad, on) => self.sampler.set_looping(pad, on),
                Command::SetGrid(d, grid) => self.decks[d.index()].set_grid(*grid),
                Command::PhaseSync { deck, lock } => {
                    self.phase_sync(deck.index());
                    self.decks[deck.index()].sync_lock = lock;
                }
                Command::SetSyncLock(d, on) => {
                    let deck = &mut self.decks[d.index()];
                    deck.sync_lock = on;
                    if !on {
                        deck.set_sync_nudge(1.0);
                    }
                }
                Command::SetQuantize(d, on) => self.decks[d.index()].set_quantize(on),
                Command::BeatJump(d, beats) => self.decks[d.index()].beat_jump(beats),
                Command::SetSlip(d, on) => self.decks[d.index()].set_slip(on),
                Command::SetReverse(d, on) => self.decks[d.index()].set_reverse(on),
                Command::SetKeyShift(d, st) => self.decks[d.index()].set_key_shift(st),
                Command::SetClock(src, bpm) => {
                    // Hand over seamlessly: the internal clock continues from the current master.
                    let (_, cur_bpm, cur_beat) = self.master_now();
                    self.internal_bpm = cur_bpm;
                    self.internal_beat = cur_beat;
                    if let Some(b) = bpm.filter(|b| b.is_finite() && *b >= 20.0 && *b <= 300.0) {
                        self.internal_bpm = b;
                    }
                    self.clock_cfg = src;
                }
                Command::SetRouting(cfg) => {
                    let cfg = cfg.sanitized();
                    self.comp_master.set_ms(cfg.master_latency_ms, self.sr);
                    self.comp_phones.set_ms(cfg.headphone_latency_ms, self.sr);
                    self.comp_booth.set_ms(cfg.booth_latency_ms, self.sr);
                    self.routing = cfg;
                }
                Command::SetColorFx(d, kind, param) => {
                    self.decks[d.index()].set_color_fx(kind, param)
                }
                Command::SetBeatFx {
                    deck,
                    kind,
                    wet,
                    beats,
                    feedback,
                } => self.decks[deck.index()].set_beat_fx(kind, wet, beats, feedback),
            }
        }
    }

    // ---- master clock + sync (WP19-05) ---------------------------------------

    /// Deck index that may drive the clock now.
    fn resolve_master(&self) -> Option<usize> {
        match self.clock_cfg {
            ClockSource::Internal => None,
            ClockSource::Deck(id) => Some(id.index()).filter(|&i| clock_usable(&self.decks[i])),
            ClockSource::Auto => self.decks.iter().position(clock_usable),
        }
    }

    /// (master deck, bpm, beat) right now.
    fn master_now(&self) -> (Option<usize>, f64, f64) {
        match self.resolve_master() {
            Some(i) => {
                let d = &self.decks[i];
                (Some(i), d.effective_bpm(), d.beat_pos())
            }
            None => (None, self.internal_bpm, self.internal_beat),
        }
    }

    /// Beats (signed, shortest way round) deck `i` must move to line up with the
    /// master: bar phase when both downbeats are known, beat phase otherwise.
    fn phase_error(&self, i: usize, master: Option<usize>, master_beat: f64) -> f64 {
        let d = &self.decks[i];
        let master_bar = match master {
            Some(m) => self.decks[m]
                .bar_phase()
                .map(|p| (p, self.decks[m].grid().beats_per_bar as f64)),
            None => Some((master_beat.rem_euclid(INTERNAL_BPB), INTERNAL_BPB)),
        };
        match (master_bar, d.bar_phase()) {
            (Some((mp, bpb)), Some(dp)) if d.grid().beats_per_bar as f64 == bpb => {
                wrap_phase(mp - dp, bpb)
            }
            _ => wrap_phase(master_beat - d.beat_pos(), 1.0),
        }
    }

    /// One-shot phase sync: tempo match + phase alignment of deck `i`.
    fn phase_sync(&mut self, i: usize) {
        let (mut master, mut bpm, mut beat) = self.master_now();
        if master == Some(i) && self.clock_cfg == ClockSource::Auto {
            // The target itself drives the auto clock: follow the next playing deck.
            let other = (0..self.decks.len()).find(|&k| k != i && clock_usable(&self.decks[k]));
            match other {
                Some(k) => {
                    master = Some(k);
                    bpm = self.decks[k].effective_bpm();
                    beat = self.decks[k].beat_pos();
                }
                None => return,
            }
        }
        if master == Some(i) || !self.decks[i].grid_valid() {
            return;
        }
        let local = self.decks[i].local_bpm();
        if local <= 0.0 || bpm <= 0.0 {
            return;
        }
        let err = self.phase_error(i, master, beat);
        let d = &mut self.decks[i];
        d.set_sync_nudge(1.0);
        d.set_tempo((bpm / local).clamp(TEMPO_MIN, TEMPO_MAX));
        d.shift_beats(err);
    }

    /// Per-block clock update: resolve the master, keep sync-locked decks on it
    /// and hand every deck the clock for beat-synced FX.
    fn begin_block(&mut self) {
        let (master, bpm, beat) = self.master_now();
        self.clock_master = master;
        if master.is_some() {
            // Internal clock shadows the master so a handover never jumps.
            self.internal_bpm = bpm;
            self.internal_beat = beat;
        }
        for i in 0..self.decks.len() {
            if Some(i) == master || !self.decks[i].sync_lock {
                continue;
            }
            let local = self.decks[i].local_bpm();
            if !self.decks[i].playing || !self.decks[i].grid_valid() || local <= 0.0 {
                continue;
            }
            let err = self.phase_error(i, master, beat);
            let d = &mut self.decks[i];
            d.set_tempo((bpm / local).clamp(TEMPO_MIN, TEMPO_MAX));
            // Correct the phase error within ~1 s, inaudibly (±2 %).
            let nudge = (err * 60.0 / bpm).clamp(-SYNC_NUDGE_MAX, SYNC_NUDGE_MAX);
            d.set_sync_nudge(1.0 + nudge);
        }
        let inc = bpm / 60.0 / self.sr as f64;
        for d in self.decks.iter_mut() {
            d.set_clock(bpm, beat, inc);
        }
    }

    /// Push the accumulated recording buffer to the writer thread (non-blocking).
    #[inline]
    fn flush_rec_block(&mut self) {
        if !self.rec_buf.is_empty() {
            // try_send: never block the RT thread; drop on backpressure.
            let block = std::mem::take(&mut self.rec_buf);
            let _ = self.rec_tx.try_send(block);
            self.rec_buf = Vec::with_capacity(2048);
        }
    }

    /// Fill an interleaved output buffer through the routing matrix.
    fn render(&mut self, out: &mut [f32], channels: usize) {
        // First statement, so draining is timed too: a `Load` drops the previous track buffer
        // there, which is the work most likely to overrun the period.
        // Monotonic clock read: no allocation, no lock (QPC / clock_gettime).
        let started = std::time::Instant::now();
        self.drain_commands();
        if channels == 0 {
            return;
        }
        self.snapshot
            .buffer_frames
            .store((out.len() / channels) as u32, Ordering::Relaxed);
        self.begin_block();

        for frame in out.chunks_mut(channels) {
            let mut mix_l = 0.0f32;
            let mut mix_r = 0.0f32;
            let (mut cue_l, mut cue_r) = (0.0f32, 0.0f32);

            for deck in self.decks.iter_mut() {
                let o = deck.render_frame();
                let (l, r) = o.main;
                let g = match deck.crossfader_assign {
                    CrossfaderAssign::Thru => 1.0,
                    CrossfaderAssign::A => crossfader_gain(self.crossfader, true, self.curve),
                    CrossfaderAssign::B => crossfader_gain(self.crossfader, false, self.curve),
                };
                mix_l += l * g;
                mix_r += r * g;
                cue_l += o.pfl.0;
                cue_r += o.pfl.1;
            }

            // Sampler pads sum straight into the master bus (no crossfader).
            let (sl, sr) = self.sampler.render_frame();
            mix_l += sl;
            mix_r += sr;

            let mvol = self.master_vol.next();
            mix_l = soft_clip(mix_l * mvol);
            mix_r = soft_clip(mix_r * mvol);

            // Recording tap: accumulate post-fader stereo into a block buffer.
            if self.rec_on {
                self.rec_buf.push(mix_l);
                self.rec_buf.push(mix_r);
                // Flush ~once per 1024 frames (2048 samples) to bound latency.
                if self.rec_buf.len() >= 2048 {
                    self.flush_rec_block();
                }
            }

            // VU follower.
            let peak = mix_l.abs().max(mix_r.abs());
            if peak > self.master_vu {
                self.master_vu = peak;
            } else {
                self.master_vu *= 0.9995;
            }

            // Headphone bus: PFL sum blended with master, then the headphone level.
            let rt = &self.routing;
            let hp = rt.headphone_level;
            let phones = (
                soft_clip((cue_l * (1.0 - rt.cue_mix) + mix_l * rt.cue_mix) * hp),
                soft_clip((cue_r * (1.0 - rt.cue_mix) + mix_r * rt.cue_mix) * hp),
            );
            let booth = (mix_l * rt.booth_level, mix_r * rt.booth_level);
            let master = self.comp_master.process(mix_l, mix_r);
            let phones = self.comp_phones.process(phones.0, phones.1);
            let booth = self.comp_booth.process(booth.0, booth.1);
            write_frame(frame, &self.routing, master, phones, booth);
        }

        let frames = (out.len() / channels) as u64;
        if self.clock_master.is_none() {
            self.internal_beat += self.internal_bpm / 60.0 / self.sr as f64 * frames as f64;
        }
        self.frames_total = self.frames_total.wrapping_add(frames);
        self.publish_snapshot();

        // DSP load: time spent in this callback against the time the buffer lasts.
        let period = frames as f64 / self.sr.max(1.0) as f64;
        if period > 0.0 {
            let load = (started.elapsed().as_secs_f64() / period).min(4.0) as f32;
            self.dsp_load = if load > self.dsp_load {
                load
            } else {
                self.dsp_load * 0.97 + load * 0.03
            };
            self.snapshot
                .dsp_load
                .store((self.dsp_load * 1000.0) as u32, Ordering::Relaxed);
            if load >= 1.0 {
                self.snapshot.overruns.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn publish_snapshot(&mut self) {
        // Publish a few times per buffer is wasteful; once per buffer is fine.
        let s = &self.snapshot;
        s.master_vu.store(
            (self.master_vu.clamp(0.0, 1.0) * 1000.0) as u32,
            Ordering::Relaxed,
        );
        for (i, deck) in self.decks.iter().enumerate() {
            s.deck_vu[i].store(
                (deck.vu().clamp(0.0, 1.0) * 1000.0) as u32,
                Ordering::Relaxed,
            );
            s.deck_pos_ms[i].store((deck.position_secs() * 1000.0) as u32, Ordering::Relaxed);
            s.deck_dur_ms[i].store((deck.duration_secs() * 1000.0) as u32, Ordering::Relaxed);
            s.deck_playing[i].store(deck.playing, Ordering::Relaxed);

            let cues = deck.hot_cue_secs();
            for (slot, c) in cues.iter().enumerate() {
                let v = match c {
                    Some(secs) => (secs * 1000.0) as u32,
                    None => u32::MAX,
                };
                s.deck_hot_cues_ms[i][slot].store(v, Ordering::Relaxed);
            }
            let (lact, lstart, lend) = deck.loop_state_secs();
            s.deck_loop_active[i].store(lact, Ordering::Relaxed);
            s.deck_loop_start_ms[i].store((lstart * 1000.0) as u32, Ordering::Relaxed);
            s.deck_loop_end_ms[i].store((lend * 1000.0) as u32, Ordering::Relaxed);
            s.deck_beat[i].store(deck.beat_pos().to_bits(), Ordering::Relaxed);
            s.deck_bpm[i].store(deck.effective_bpm().to_bits(), Ordering::Relaxed);
            let bar = deck.bar_phase().map(f64::to_bits).unwrap_or(u64::MAX);
            s.deck_bar_phase[i].store(bar, Ordering::Relaxed);
            s.deck_tempo[i].store(deck.tempo.to_bits(), Ordering::Relaxed);
            let slip = deck
                .slip_shadow_secs()
                .map(f64::to_bits)
                .unwrap_or(u64::MAX);
            s.deck_slip_pos[i].store(slip, Ordering::Relaxed);
        }
        let (master, bpm, beat) = self.master_now();
        s.clock_bpm.store(bpm.to_bits(), Ordering::Relaxed);
        s.clock_beat.store(beat.to_bits(), Ordering::Relaxed);
        s.clock_source
            .store(master.map(|m| m as u8).unwrap_or(4), Ordering::Relaxed);
        s.clock_frame.store(self.frames_total, Ordering::Relaxed);
        self.frame_counter = self.frame_counter.wrapping_add(1);
    }
}

/// UI-side handle. Owns the stream + command sender + a mirror of UI-set params
/// (so `get_state` can report values the RT thread doesn't echo back cheaply).
pub struct Engine {
    /// The open output stream (`None` only after a failed device switch that could not
    /// restore the previous device; the mixer is then parked in `parked`).
    stream: Option<Stream>,
    /// Mixer hand-back channel: the callback's [`MixerHome`] sends the mixer here when cpal
    /// drops it (stream dropped or build failed).
    home_tx: Sender<Mixer>,
    home_rx: Receiver<Mixer>,
    parked: Option<Mixer>,
    tx: Sender<Command>,
    snapshot: Arc<Snapshot>,
    sample_rate: u32,
    channels: u16,
    /// Device / config actually opened, with fallback notes.
    output: OutputInfo,
    /// Requested device (`None` = system default), sample rate and buffer size.
    want_device: Option<String>,
    want_rate: Option<u32>,
    want_buffer: Option<u32>,
    /// UI-visible mirror of params (metadata, knob values) guarded by a mutex;
    /// only touched on the UI thread, never in the audio callback.
    mirror: Mutex<MixerState>,
    /// Owns the WAV writer thread; the RT mixer holds the matching sender.
    recorder: Mutex<crate::recorder::Recorder>,
    /// UI-side mirror of the WP19 performance / routing settings.
    perf: Mutex<PerfMirror>,
}

/// UI-side record of WP19 settings (the RT side never echoes these back).
#[derive(Debug, Clone, Default)]
pub struct PerfMirror {
    pub clock: ClockSource,
    pub routing: RoutingConfig,
    pub key_shift: [f64; 4],
    pub quantize: [bool; 4],
    pub slip: [bool; 4],
    pub sync_lock: [bool; 4],
    /// Last known musical key per deck (0..23), see [`crate::keys`].
    pub key: [Option<u8>; 4],
}

// cpal::Stream isn't Send on all platforms; the Tauri state wrapper keeps the
// Engine pinned to the thread that created it via a dedicated manager. We mark
// the handle Send because all cross-thread access goes through `tx`/`snapshot`,
// which are Send, and the mirror is mutex-guarded.
unsafe impl Send for Engine {}
unsafe impl Sync for Engine {}

/// Owns the mixer inside the audio callback and hands it back when cpal drops the callback.
struct MixerHome {
    mixer: Option<Mixer>,
    back: Sender<Mixer>,
}

impl Drop for MixerHome {
    fn drop(&mut self) {
        if let Some(m) = self.mixer.take() {
            let _ = self.back.try_send(m);
        }
    }
}

/// How long to wait for cpal to drop a callback (the backend thread joins on stream drop).
const RECLAIM_TIMEOUT: Duration = Duration::from_secs(3);

/// A failed stream open: the error plus the mixer when cpal released the callback in time.
type Failed = Box<(CoreError, Option<Mixer>)>;

fn resolve_device(id: Option<&str>) -> Result<cpal::Device, CoreError> {
    match id {
        Some(id) => output::find_output_device(id)
            .ok_or_else(|| CoreError::Device(format!("output device {id} not found"))),
        None => cpal::default_host()
            .default_output_device()
            .ok_or_else(|| CoreError::Device("no default output device".into())),
    }
}

/// Pick the config for `device` (pure fallback rules in [`output::choose_config`]).
fn plan(
    device: &cpal::Device,
    rate: Option<u32>,
    buffer: Option<u32>,
) -> Result<output::ConfigChoice, CoreError> {
    let (ranges, default) = output::device_ranges(device).map_err(CoreError::Device)?;
    Ok(output::choose_config(&ranges, &default, rate, buffer))
}

/// Build + start one stream around `mixer`. On failure the mixer comes back (when cpal
/// released the callback in time).
fn open_stream(
    device: &cpal::Device,
    config: StreamConfig,
    mixer: Mixer,
    home_tx: &Sender<Mixer>,
    home_rx: &Receiver<Mixer>,
) -> Result<Stream, Failed> {
    let ch = config.channels as usize;
    let mut home = MixerHome {
        mixer: Some(mixer),
        back: home_tx.clone(),
    };
    let err_fn = |e: cpal::Error| log::error!("mixai audio stream error: {e}");
    let reclaim = || home_rx.recv_timeout(RECLAIM_TIMEOUT).ok();
    // cpal 0.18: `StreamConfig` is `Copy` and passed by value; streams no longer
    // auto-start, so the explicit `play()` below is required on every backend.
    let built = device.build_output_stream(
        config,
        move |data: &mut [f32], _| {
            if let Some(m) = home.mixer.as_mut() {
                m.render(data, ch);
            }
        },
        err_fn,
        None,
    );
    match built {
        Ok(stream) => match stream.play() {
            Ok(()) => Ok(stream),
            Err(e) => {
                drop(stream);
                Err(Box::new((
                    CoreError::Device(format!("play stream: {e}")),
                    reclaim(),
                )))
            }
        },
        Err(e) => Err(Box::new((
            CoreError::Device(format!("build stream: {e}")),
            reclaim(),
        ))),
    }
}

/// Open `device` with `choice`; a rejected fixed buffer is retried with the default buffer.
fn launch(
    device: &cpal::Device,
    choice: output::ConfigChoice,
    mut mixer: Mixer,
    home_tx: &Sender<Mixer>,
    home_rx: &Receiver<Mixer>,
    mut notes: Vec<String>,
) -> Result<(Stream, OutputInfo), Failed> {
    mixer.set_sample_rate(choice.sample_rate as f32);
    notes.extend(choice.notes.iter().cloned());
    let mut config = StreamConfig {
        channels: choice.channels,
        sample_rate: choice.sample_rate,
        buffer_size: match choice.buffer {
            BufferChoice::Fixed(n) => cpal::BufferSize::Fixed(n),
            BufferChoice::Default => cpal::BufferSize::Default,
        },
    };
    let stream = match open_stream(device, config, mixer, home_tx, home_rx) {
        Ok(s) => s,
        Err(failed) => match (*failed, choice.buffer) {
            ((e, Some(m)), BufferChoice::Fixed(n)) => {
                notes.push(format!(
                    "buffer_frames {n} rejected by the device ({e}); using the device default buffer"
                ));
                config.buffer_size = cpal::BufferSize::Default;
                open_stream(device, config, m, home_tx, home_rx)?
            }
            (failed, _) => return Err(Box::new(failed)),
        },
    };
    let buffer_frames = match config.buffer_size {
        cpal::BufferSize::Fixed(n) => Some(n),
        cpal::BufferSize::Default => None,
    };
    let info = OutputInfo {
        device_id: output::device_id_of(device),
        device_name: output::device_name_of(device),
        sample_rate: config.sample_rate,
        channels: config.channels,
        buffer_frames,
        latency_ms: buffer_frames.map_or(0.0, |n| n as f32 / config.sample_rate as f32 * 1000.0),
        notes,
    };
    Ok((stream, info))
}

impl Engine {
    /// Build the default output stream with the device's default config.
    pub fn start() -> Result<Self, CoreError> {
        Self::start_with(None, None, None)
    }

    /// Open `device_id` (`host:id` from [`list_output_devices`]; `None` = system default) with
    /// the requested sample rate and frames per callback. Unsupported values fall back to the
    /// device default; an unknown device falls back to the system default. Every fallback is
    /// listed in [`Engine::output_info`]`.notes`.
    pub fn start_with(
        device_id: Option<&str>,
        sample_rate: Option<u32>,
        buffer_frames: Option<u32>,
    ) -> Result<Self, CoreError> {
        let mut notes = Vec::new();
        let device = match device_id.map(output::find_output_device) {
            Some(Some(d)) => d,
            Some(None) => {
                notes.push(format!(
                    "output device {} not found; using the system default device",
                    device_id.unwrap_or_default()
                ));
                resolve_device(None)?
            }
            None => resolve_device(None)?,
        };
        let choice = plan(&device, sample_rate, buffer_frames)?;

        let (tx, rx) = bounded::<Command>(1024);
        let snapshot = Arc::new(Snapshot::new());
        let (recorder, rec_tx) = crate::recorder::Recorder::spawn();
        let mixer = Mixer::new(choice.sample_rate as f32, rx, snapshot.clone(), rec_tx);
        let (home_tx, home_rx) = bounded::<Mixer>(1);
        let (stream, info) =
            launch(&device, choice, mixer, &home_tx, &home_rx, notes).map_err(|f| f.0)?;

        Ok(Engine {
            stream: Some(stream),
            home_tx,
            home_rx,
            parked: None,
            tx,
            snapshot,
            sample_rate: info.sample_rate,
            channels: info.channels,
            want_device: device_id.map(str::to_owned),
            want_rate: sample_rate,
            want_buffer: buffer_frames,
            mirror: Mutex::new(MixerState::initial(info.sample_rate)),
            output: info,
            recorder: Mutex::new(recorder),
            perf: Mutex::new(PerfMirror::default()),
        })
    }

    /// Move playback to another output device (`None` = system default), keeping decks,
    /// routing, FX and queued commands. The requested sample rate / buffer size from
    /// [`Engine::start_with`] are re-applied with the same fallback rules. On failure the
    /// previous device is reopened and the error is returned.
    pub fn switch_output_device(
        &mut self,
        device_id: Option<&str>,
    ) -> Result<OutputInfo, CoreError> {
        let device = resolve_device(device_id)?;
        let choice = plan(&device, self.want_rate, self.want_buffer)?;
        let mixer = self.take_mixer()?;
        let mut notes = Vec::new();
        if choice.sample_rate != self.sample_rate && self.is_recording() {
            self.stop_recording();
            notes.push(format!(
                "recording stopped: the sample rate changed from {} to {} Hz",
                self.sample_rate, choice.sample_rate
            ));
        }
        match launch(&device, choice, mixer, &self.home_tx, &self.home_rx, notes) {
            Ok((stream, info)) => {
                self.want_device = device_id.map(str::to_owned);
                self.install(stream, info);
                Ok(self.output_info())
            }
            Err(failed) => {
                let (e, mixer) = *failed;
                let Some(mixer) = mixer else {
                    return Err(CoreError::Device(format!(
                        "{e}; the audio callback was not released, engine stopped"
                    )));
                };
                self.restore(mixer);
                Err(e)
            }
        }
    }

    /// Reopen the previous device after a failed switch (parks the mixer if that fails too).
    fn restore(&mut self, mixer: Mixer) {
        let prev = self.want_device.clone();
        let reopened = resolve_device(prev.as_deref()).and_then(|d| {
            let choice = plan(&d, self.want_rate, self.want_buffer)?;
            Ok((d, choice))
        });
        let (device, choice) = match reopened {
            Ok(v) => v,
            Err(e) => {
                log::error!("mixai: previous output device unavailable: {e}");
                self.parked = Some(mixer);
                return;
            }
        };
        match launch(
            &device,
            choice,
            mixer,
            &self.home_tx,
            &self.home_rx,
            Vec::new(),
        ) {
            Ok((stream, info)) => self.install(stream, info),
            Err(failed) => {
                let (e, m) = *failed;
                log::error!("mixai: could not reopen the previous output device: {e}");
                self.parked = m;
            }
        }
    }

    /// Stop the current stream and get the mixer back.
    fn take_mixer(&mut self) -> Result<Mixer, CoreError> {
        if let Some(m) = self.parked.take() {
            return Ok(m);
        }
        let stream = self
            .stream
            .take()
            .ok_or_else(|| CoreError::Device("engine has no stream".into()))?;
        // Dropping the stream drops the callback, whose MixerHome sends the mixer back.
        drop(stream);
        self.home_rx
            .recv_timeout(RECLAIM_TIMEOUT)
            .map_err(|_| CoreError::Device("audio callback did not release the mixer".into()))
    }

    fn install(&mut self, stream: Stream, info: OutputInfo) {
        self.stream = Some(stream);
        self.sample_rate = info.sample_rate;
        self.channels = info.channels;
        self.snapshot.buffer_frames.store(0, Ordering::Relaxed);
        self.mirror().sample_rate = info.sample_rate;
        self.output = info;
    }

    /// True while an output stream is open.
    pub fn is_streaming(&self) -> bool {
        self.stream.is_some()
    }

    /// Device and stream config actually in use, with fallback notes.
    pub fn output_info(&self) -> OutputInfo {
        let mut info = self.output.clone();
        if info.buffer_frames.is_none() {
            info.buffer_frames = self.observed_buffer_frames();
        }
        info.latency_ms = self.latency_ms();
        info
    }

    fn observed_buffer_frames(&self) -> Option<u32> {
        Some(self.snapshot.buffer_frames.load(Ordering::Relaxed)).filter(|n| *n > 0)
    }

    /// Frames per audio callback: the fixed size, else the last observed callback size.
    pub fn buffer_frames(&self) -> Option<u32> {
        self.output
            .buffer_frames
            .or_else(|| self.observed_buffer_frames())
    }

    /// Output buffer latency in ms (0 until the buffer size is known).
    pub fn latency_ms(&self) -> f32 {
        self.buffer_frames()
            .map_or(0.0, |n| n as f32 / self.sample_rate.max(1) as f32 * 1000.0)
    }

    /// Channel trim in dB (−∞..+12; ≤ −96 dB = silence), pre-EQ and separate from the fader.
    pub fn set_trim(&self, deck: DeckId, db: f32) {
        if db.is_nan() {
            return;
        }
        let db = db.min(crate::deck::TRIM_MAX_DB);
        self.mirror().decks[deck.index()].trim_db = db.max(crate::deck::TRIM_MIN_DB);
        self.send(Command::Trim(deck, db));
    }

    /// Crossfader gain law (linear / smooth = equal power / sharp = cut).
    pub fn set_crossfader_curve(&self, curve: CrossfaderCurve) {
        self.mirror().crossfader_curve = curve;
        self.send(Command::CrossfaderCurve(curve));
    }

    /// Put a deck on crossfader side A / B, or `Thru` (always at full level, crossfader ignored).
    pub fn set_crossfader_assign(&self, deck: DeckId, assign: CrossfaderAssign) {
        self.mirror().decks[deck.index()].crossfader_assign = assign;
        self.send(Command::CrossfaderAssign(deck, assign));
    }

    /// Slip shadow playhead in seconds while slip is engaged (published by the audio thread).
    pub fn slip_shadow_secs(&self, deck: DeckId) -> Option<f64> {
        let bits = self.snapshot.deck_slip_pos[deck.index()].load(Ordering::Relaxed);
        (bits != u64::MAX).then(|| f64::from_bits(bits))
    }

    // ---- WP19-05 sync / clock ---------------------------------------------

    pub fn perf(&self) -> std::sync::MutexGuard<'_, PerfMirror> {
        self.perf.lock().unwrap()
    }

    /// Replace a deck's beatgrid (normalised here, off the audio thread).
    pub fn set_grid(&self, deck: DeckId, grid: BeatGrid) {
        let grid = grid.normalized();
        {
            let mut m = self.mirror();
            let d = &mut m.decks[deck.index()];
            if grid.bpm > 0.0 {
                d.bpm = grid.bpm;
            }
            d.first_beat = grid.first_beat;
        }
        self.send(Command::SetGrid(deck, Box::new(grid)));
    }

    /// Phase sync `deck` to the master clock; `lock` keeps it locked.
    pub fn phase_sync(&self, deck: DeckId, lock: bool) {
        self.perf().sync_lock[deck.index()] = lock;
        self.send(Command::PhaseSync { deck, lock });
    }

    pub fn set_sync_lock(&self, deck: DeckId, on: bool) {
        self.perf().sync_lock[deck.index()] = on;
        self.send(Command::SetSyncLock(deck, on));
    }

    pub fn set_quantize(&self, deck: DeckId, on: bool) {
        self.perf().quantize[deck.index()] = on;
        self.send(Command::SetQuantize(deck, on));
    }

    pub fn beat_jump(&self, deck: DeckId, beats: f64) {
        self.send(Command::BeatJump(deck, beats));
    }

    pub fn set_slip(&self, deck: DeckId, on: bool) {
        self.perf().slip[deck.index()] = on;
        self.send(Command::SetSlip(deck, on));
    }

    pub fn set_reverse(&self, deck: DeckId, on: bool) {
        self.send(Command::SetReverse(deck, on));
    }

    pub fn set_key_shift(&self, deck: DeckId, semitones: f64) {
        let st = if semitones.is_finite() {
            semitones.clamp(-crate::deck::KEY_SHIFT_MAX, crate::deck::KEY_SHIFT_MAX)
        } else {
            0.0
        };
        self.perf().key_shift[deck.index()] = st;
        self.send(Command::SetKeyShift(deck, st));
    }

    /// Remember a deck's musical key (0..23) for key matching.
    pub fn set_deck_key(&self, deck: DeckId, key: Option<u8>) {
        self.perf().key[deck.index()] = key.filter(|k| *k < crate::keys::KEY_COUNT);
    }

    /// Key-shift `deck` so it sounds in the master deck's key (or its relative).
    /// Keys default to the remembered ones; returns the applied shift.
    pub fn key_match(
        &self,
        deck: DeckId,
        deck_key: Option<u8>,
        master_key: Option<u8>,
    ) -> Result<f64, CoreError> {
        let master = self.clock_master_deck();
        let (dk, mk, master_shift) = {
            let mut p = self.perf();
            if let Some(k) = deck_key {
                p.key[deck.index()] = Some(k);
            }
            let dk = deck_key.or(p.key[deck.index()]);
            let mk = master_key.or_else(|| master.and_then(|m| p.key[m.index()]));
            let ms = master.map(|m| p.key_shift[m.index()]).unwrap_or(0.0);
            (dk, mk, ms)
        };
        let (Some(dk), Some(mk)) = (dk, mk) else {
            return Err(CoreError::Device("key unknown for deck or master".into()));
        };
        let offset = |id: DeckId| {
            let tempo =
                f64::from_bits(self.snapshot.deck_tempo[id.index()].load(Ordering::Relaxed));
            let lock = self.mirror().decks[id.index()].key_lock;
            crate::keys::tempo_semitones(tempo, lock)
        };
        let deck_off = offset(deck);
        let master_off = master_shift + master.map(offset).unwrap_or(0.0);
        let shift = crate::keys::key_match_shift(dk, deck_off, mk, master_off)
            .ok_or_else(|| CoreError::Device("key out of range (0..23)".into()))?;
        self.set_key_shift(deck, shift);
        Ok(shift)
    }

    fn clock_master_deck(&self) -> Option<DeckId> {
        let src = self.snapshot.clock_source.load(Ordering::Relaxed) as usize;
        DeckId::ALL.get(src).copied()
    }

    /// Set the master clock source and/or the internal clock tempo.
    pub fn set_clock(&self, source: ClockSource, bpm: Option<f64>) {
        self.perf().clock = source;
        self.send(Command::SetClock(source, bpm));
    }

    /// Master clock + per-deck beat positions (for UI, MIDI clock out, Link).
    pub fn clock_state(&self) -> ClockState {
        let s = &self.snapshot;
        let ld = |a: &AtomicU64| f64::from_bits(a.load(Ordering::Relaxed));
        let beat = ld(&s.clock_beat);
        let master = self.clock_master_deck();
        let p = self.perf().clone();
        let configured = match p.clock {
            ClockSource::Auto => "auto".to_string(),
            ClockSource::Internal => "internal".to_string(),
            ClockSource::Deck(d) => deck_name(d).to_string(),
        };
        let bar_bits = master.map(|m| s.deck_bar_phase[m.index()].load(Ordering::Relaxed));
        let bar_phase = match bar_bits {
            None => Some(beat.rem_euclid(INTERNAL_BPB)),
            Some(u64::MAX) => None,
            Some(b) => Some(f64::from_bits(b)),
        };
        let decks = DeckId::ALL
            .iter()
            .map(|&id| {
                let i = id.index();
                let bar = s.deck_bar_phase[i].load(Ordering::Relaxed);
                DeckClock {
                    id,
                    bpm: ld(&s.deck_bpm[i]),
                    beat: ld(&s.deck_beat[i]),
                    bar_phase: (bar != u64::MAX).then(|| f64::from_bits(bar)),
                    key_shift: p.key_shift[i],
                    slip: p.slip[i],
                    quantize: p.quantize[i],
                    sync_lock: p.sync_lock[i],
                }
            })
            .collect();
        ClockState {
            configured,
            source: master.map(deck_name).unwrap_or("internal").to_string(),
            bpm: ld(&s.clock_bpm),
            beat,
            beat_phase: beat.rem_euclid(1.0),
            bar_phase,
            beats_per_bar: INTERNAL_BPB as u32,
            frame: s.clock_frame.load(Ordering::Relaxed),
            sample_rate: self.sample_rate,
            channels: self.channels,
            buffer_frames: self.buffer_frames(),
            decks,
        }
    }

    // ---- WP19-06 routing ---------------------------------------------------

    pub fn set_routing(&self, cfg: RoutingConfig) {
        let cfg = cfg.sanitized();
        {
            let mut m = self.mirror();
            m.cue_volume = cfg.headphone_level;
        }
        self.perf().routing = cfg;
        self.send(Command::SetRouting(cfg));
    }

    pub fn routing(&self) -> RoutingConfig {
        self.perf().routing
    }

    // ---- WP19-10 FX --------------------------------------------------------

    pub fn set_color_fx(&self, deck: DeckId, kind: ColorFxKind, param: f32) {
        self.send(Command::SetColorFx(deck, kind, param));
    }

    pub fn set_beat_fx(&self, deck: DeckId, kind: BeatFxKind, wet: f32, beats: f64, feedback: f32) {
        self.send(Command::SetBeatFx {
            deck,
            kind,
            wet,
            beats,
            feedback,
        });
    }

    pub fn send(&self, cmd: Command) {
        // Non-blocking; if the queue is full we drop (UI will resend on next tick).
        let _ = self.tx.try_send(cmd);
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    /// Start capturing the master mix to a WAV file at `path`.
    pub fn start_recording(&self, path: std::path::PathBuf) {
        // Open the file first, then turn on the RT tap so no samples are
        // pushed before the writer is ready.
        self.recorder.lock().unwrap().start(path, self.sample_rate);
        self.send(Command::SetRecording(true));
    }

    /// Stop capturing and finalize the WAV file.
    pub fn stop_recording(&self) {
        // Turn off the RT tap first so it flushes its partial block, then
        // finalize the file.
        self.send(Command::SetRecording(false));
        self.recorder.lock().unwrap().stop();
    }

    pub fn is_recording(&self) -> bool {
        self.recorder.lock().unwrap().is_recording()
    }

    /// Attach separated stem buffers to a deck and enable stem playback.
    pub fn load_stems(&self, deck: DeckId, layers: [Option<TrackBuffer>; 4]) {
        let any = layers.iter().any(|l| l.is_some());
        {
            let mut m = self.mirror();
            let d = &mut m.decks[deck.index()];
            d.has_stems = any;
            d.stems_active = any;
        }
        self.send(Command::LoadStems {
            deck,
            layers: Box::new(layers),
        });
    }

    /// Enable/disable stem playback for a deck (keeps loaded buffers).
    pub fn set_stems_active(&self, deck: DeckId, on: bool) {
        self.mirror().decks[deck.index()].stems_active = on;
        self.send(Command::SetStemsActive(deck, on));
    }

    /// Set the live gain (0..1.5) for stem `idx` (0=vocals,1=drums,2=bass,3=melody).
    pub fn set_stem_gain(&self, deck: DeckId, idx: usize, gain: f32) {
        if idx < 4 {
            let mut m = self.mirror();
            let gains = &mut m.decks[deck.index()].stem_gains;
            if gains.len() < 4 {
                gains.resize(4, 1.0);
            }
            gains[idx] = gain.clamp(0.0, 1.5);
        }
        self.send(Command::SetStemGain(deck, idx, gain));
    }

    /// Select the active FX (0=off, 1=echo, 2=reverb) for a deck.
    pub fn set_fx_kind(&self, deck: DeckId, kind: u8) {
        self.mirror().decks[deck.index()].fx_kind = kind;
        self.send(Command::SetFxKind(deck, kind));
    }

    /// Set the FX wet/dry mix (0..1) for a deck.
    pub fn set_fx_wet(&self, deck: DeckId, wet: f32) {
        self.mirror().decks[deck.index()].fx_wet = wet.clamp(0.0, 1.0);
        self.send(Command::SetFxWet(deck, wet));
    }

    /// Set the FX beat division (echo time) for a deck.
    pub fn set_fx_beats(&self, deck: DeckId, beats: f64) {
        self.mirror().decks[deck.index()].fx_beats = beats;
        self.send(Command::SetFxBeats(deck, beats));
    }

    // ---- sampler --------------------------------------------------------

    /// Load a sample into a pad (buffer decoded off the audio thread).
    pub fn load_sample(&self, pad: usize, buffer: TrackBuffer) {
        self.send(Command::LoadSample { pad, buffer });
    }

    /// Clear a sampler pad.
    pub fn clear_sample(&self, pad: usize) {
        self.send(Command::ClearSample(pad));
    }

    /// Trigger a sampler pad from the start.
    pub fn trigger_sample(&self, pad: usize) {
        self.send(Command::TriggerSample(pad));
    }

    /// Stop a sampler pad immediately.
    pub fn stop_sample(&self, pad: usize) {
        self.send(Command::StopSample(pad));
    }

    /// Set a sampler pad's gain (0..1.5).
    pub fn set_sample_gain(&self, pad: usize, gain: f32) {
        self.send(Command::SetSampleGain(pad, gain));
    }

    /// Toggle one-shot vs. loop for a sampler pad.
    pub fn set_sample_looping(&self, pad: usize, on: bool) {
        self.send(Command::SetSampleLooping(pad, on));
    }

    /// Mutable access to the UI-side mirror to record knob/transport intent.
    pub fn mirror(&self) -> std::sync::MutexGuard<'_, MixerState> {
        self.mirror.lock().unwrap()
    }

    /// Build the full MixerState to hand to the UI by combining the UI mirror
    /// (knob values, metadata) with the live RT snapshot (positions, meters).
    pub fn snapshot_state(&self) -> MixerState {
        let mut state = self.mirror().clone();
        state.sample_rate = self.sample_rate;
        state.latency_ms = self.latency_ms();
        state.channels = self.channels;
        state.buffer_frames = self.buffer_frames();
        let s = &self.snapshot;
        state.master_vu = s.master_vu.load(Ordering::Relaxed) as f32 / 1000.0;
        state.dsp_load = s.dsp_load.load(Ordering::Relaxed) as f32 / 1000.0;
        state.overruns = s.overruns.load(Ordering::Relaxed);
        for (i, deck) in state.decks.iter_mut().enumerate() {
            deck.vu = s.deck_vu[i].load(Ordering::Relaxed) as f32 / 1000.0;
            deck.position = s.deck_pos_ms[i].load(Ordering::Relaxed) as f64 / 1000.0;
            deck.duration = s.deck_dur_ms[i].load(Ordering::Relaxed) as f64 / 1000.0;
            deck.playing = s.deck_playing[i].load(Ordering::Relaxed);
            for slot in 0..8 {
                let v = s.deck_hot_cues_ms[i][slot].load(Ordering::Relaxed);
                deck.hot_cues[slot] = if v == u32::MAX {
                    None
                } else {
                    Some(v as f64 / 1000.0)
                };
            }
            deck.loop_active = s.deck_loop_active[i].load(Ordering::Relaxed);
            deck.loop_start = s.deck_loop_start_ms[i].load(Ordering::Relaxed) as f64 / 1000.0;
            deck.loop_end = s.deck_loop_end_ms[i].load(Ordering::Relaxed) as f64 / 1000.0;
            // Sync lock moves the tempo on the RT side; report the live value.
            deck.tempo = f64::from_bits(s.deck_tempo[i].load(Ordering::Relaxed));
            let slip = s.deck_slip_pos[i].load(Ordering::Relaxed);
            deck.slip_shadow = (slip != u64::MAX).then(|| f64::from_bits(slip));
        }
        state
    }
}

fn deck_name(d: DeckId) -> &'static str {
    match d {
        DeckId::A => "a",
        DeckId::B => "b",
        DeckId::C => "c",
        DeckId::D => "d",
    }
}

/// A deck can drive the master clock while it plays with a valid grid.
fn clock_usable(d: &Deck) -> bool {
    d.playing && d.grid_valid() && d.effective_bpm() > 0.0
}

/// Enumerate output devices for the settings UI.
pub fn list_output_devices() -> Vec<AudioDevice> {
    let host = cpal::default_host();
    // cpal 0.18 removed `DeviceTrait::name()`: the human name comes from
    // `description()`, and `id()` is a stable per-host identifier (`host:id`).
    let default_device = host.default_output_device();
    let mut out = Vec::new();
    if let Ok(devices) = host.output_devices() {
        for d in devices {
            let name = d
                .description()
                .map(|desc| desc.name().to_owned())
                .unwrap_or_else(|_| "Unknown".into());
            let id = d
                .id()
                .map(|id| id.to_string())
                .unwrap_or_else(|_| name.clone());
            let channels = d.default_output_config().map(|c| c.channels()).unwrap_or(2);
            out.push(AudioDevice {
                id,
                is_default: default_device.as_ref() == Some(&d),
                name,
                channels,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck::tests::click_track;

    const SR: f32 = 48_000.0;

    fn mixer() -> (Mixer, Sender<Command>) {
        let (tx, rx) = bounded::<Command>(64);
        let (rec_tx, _rec_rx) = bounded(4);
        (Mixer::new(SR, rx, Arc::new(Snapshot::new()), rec_tx), tx)
    }

    fn load(m: &mut Mixer, d: DeckId, bpm: f64, first_beat: f64) {
        let deck = &mut m.decks[d.index()];
        deck.load(
            click_track(bpm, first_beat, 40.0, SR as u32),
            (None, None, None, bpm),
        );
        deck.set_grid(BeatGrid::constant(bpm, first_beat));
        deck.set_key_lock(false);
    }

    /// Render `frames` in 256-frame blocks, returning onset frames per deck
    /// (first sample above 0.1 after >= 10 ms of silence).
    fn run(m: &mut Mixer, frames: usize, start: usize, onsets: &mut [Vec<usize>; 2]) {
        let mut quiet = [usize::MAX / 2; 2];
        let mut f = 0;
        while f < frames {
            m.drain_commands();
            m.begin_block();
            for _ in 0..256 {
                for (k, deck) in m.decks.iter_mut().take(2).enumerate() {
                    let s = deck.render_frame().main.0.abs();
                    if s > 0.1 {
                        if quiet[k] >= 480 {
                            onsets[k].push(start + f);
                        }
                        quiet[k] = 0;
                    } else {
                        quiet[k] += 1;
                    }
                }
                for deck in m.decks.iter_mut().skip(2) {
                    deck.render_frame();
                }
                f += 1;
            }
        }
    }

    #[test]
    fn phase_sync_aligns_clicks_within_1ms() {
        let (mut m, tx) = mixer();
        load(&mut m, DeckId::A, 120.0, 0.1);
        load(&mut m, DeckId::B, 126.0, 0.37);
        m.decks[0].play();
        m.decks[1].seek_secs(3.013);
        m.decks[1].play();
        let mut onsets = [Vec::new(), Vec::new()];
        run(&mut m, 24_000, 0, &mut onsets);
        tx.send(Command::PhaseSync {
            deck: DeckId::B,
            lock: false,
        })
        .unwrap();
        let mut onsets = [Vec::new(), Vec::new()];
        run(&mut m, 48_000 * 4, 24_000, &mut onsets);
        assert!((m.decks[1].effective_bpm() - 120.0).abs() < 1e-9);
        let (a, b) = (&onsets[0], &onsets[1]);
        assert!(b.len() >= 6, "B onsets {b:?}");
        for &ob in b {
            let near = a.iter().map(|&oa| oa.abs_diff(ob)).min().unwrap();
            assert!(
                near <= 48,
                "B onset {ob} is {near} samples from A (A {a:?})"
            );
        }
    }

    #[test]
    fn phase_sync_matches_bar_phase_when_downbeats_known() {
        let (mut m, tx) = mixer();
        load(&mut m, DeckId::A, 120.0, 0.0);
        load(&mut m, DeckId::B, 126.0, 0.0);
        let mut ga = BeatGrid::constant(120.0, 0.0);
        ga.downbeat = Some(0);
        let mut gb = BeatGrid::constant(126.0, 0.0);
        gb.downbeat = Some(1);
        m.decks[0].set_grid(ga);
        m.decks[1].set_grid(gb);
        m.decks[0].play();
        m.decks[1].seek_secs(5.0);
        m.decks[1].play();
        tx.send(Command::PhaseSync {
            deck: DeckId::B,
            lock: true,
        })
        .unwrap();
        let mut onsets = [Vec::new(), Vec::new()];
        run(&mut m, 48_000 * 2, 0, &mut onsets);
        let pa = m.decks[0].bar_phase().unwrap();
        let pb = m.decks[1].bar_phase().unwrap();
        let err = wrap_phase(pa - pb, 4.0) * 0.5; // seconds at 120 bpm
        assert!(err.abs() < 0.001, "bar phase A {pa} B {pb}");
    }

    #[test]
    fn internal_clock_runs_and_is_reported() {
        let (mut m, tx) = mixer();
        tx.send(Command::SetClock(ClockSource::Internal, Some(128.0)))
            .unwrap();
        let mut out = vec![0.0f32; 512];
        for _ in 0..375 {
            m.render(&mut out, 2); // 375 × 256 frames = 2 s
        }
        let beat = f64::from_bits(m.snapshot.clock_beat.load(Ordering::Relaxed));
        assert!((beat - 128.0 / 60.0 * 2.0).abs() < 1e-6, "beat {beat}");
        assert_eq!(m.snapshot.clock_source.load(Ordering::Relaxed), 4);
    }

    #[test]
    fn command_draining_counts_towards_dsp_load() {
        // 100 000 queued commands take far longer to drain than the 167 µs an 8-frame buffer
        // lasts, while rendering 8 frames of empty decks takes a few µs: the callback is an
        // overrun only when the drain is inside the timed span.
        let (tx, rx) = bounded::<Command>(100_000);
        let (rec_tx, _rec_rx) = bounded(4);
        let mut m = Mixer::new(SR, rx, Arc::new(Snapshot::new()), rec_tx);
        for _ in 0..100_000 {
            tx.send(Command::Eq(DeckId::A, "low".to_owned(), 0.0))
                .unwrap();
        }
        let mut out = vec![0.0f32; 16];
        m.render(&mut out, 2);
        assert!(tx.is_empty(), "queue drained");
        assert_eq!(m.snapshot.overruns.load(Ordering::Relaxed), 1);
        assert!(m.snapshot.dsp_load.load(Ordering::Relaxed) >= 1000);
    }

    #[test]
    fn split_mono_routes_cue_only_left() {
        let (mut m, tx) = mixer();
        load(&mut m, DeckId::A, 120.0, 0.0);
        load(&mut m, DeckId::B, 120.0, 0.0);
        // Deck A: cued, crossfader closed on its side → only in the headphones.
        m.decks[0].set_cue(true);
        m.decks[0].play();
        tx.send(Command::Crossfader(1.0)).unwrap();
        tx.send(Command::SetRouting(RoutingConfig {
            split_mono: true,
            cue_mix: 0.0,
            headphone_level: 1.0,
            ..Default::default()
        }))
        .unwrap();
        let mut out = vec![0.0f32; 512];
        let (mut l, mut r) = (0.0f32, 0.0f32);
        for _ in 0..200 {
            m.render(&mut out, 2);
            for fr in out.chunks(2) {
                l = l.max(fr[0].abs());
                r = r.max(fr[1].abs());
            }
        }
        assert!(l > 0.1, "cue missing on L: {l}");
        assert!(r < 1e-6, "cue leaked to R: {r}");
        // Deck B on master, not cued → R only.
        m.decks[0].pause();
        m.decks[1].play();
        let (mut l, mut r) = (0.0f32, 0.0f32);
        for _ in 0..200 {
            m.render(&mut out, 2);
            for fr in out.chunks(2) {
                l = l.max(fr[0].abs());
                r = r.max(fr[1].abs());
            }
        }
        assert!(r > 0.1 && l < 1e-6, "master L {l} R {r}");
    }

    #[test]
    fn four_channel_puts_headphones_on_3_4() {
        let (mut m, tx) = mixer();
        load(&mut m, DeckId::A, 120.0, 0.0);
        m.decks[0].set_cue(true);
        m.decks[0].play();
        tx.send(Command::Crossfader(1.0)).unwrap();
        tx.send(Command::SetRouting(RoutingConfig::default()))
            .unwrap();
        let mut out = vec![0.0f32; 1024];
        let mut peak = [0.0f32; 4];
        for _ in 0..200 {
            m.render(&mut out, 4);
            for fr in out.chunks(4) {
                for (p, s) in peak.iter_mut().zip(fr) {
                    *p = p.max(s.abs());
                }
            }
        }
        assert!(peak[0] < 1e-6 && peak[1] < 1e-6, "{peak:?}");
        assert!(peak[2] > 0.05 && peak[3] > 0.05, "{peak:?}");
    }

    fn sine_track(secs: f64) -> TrackBuffer {
        let n = (secs * SR as f64) as usize;
        let left: Vec<f32> = (0..n)
            .map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / SR).sin() * 0.2)
            .collect();
        TrackBuffer {
            right: left.clone(),
            left,
            sample_rate: SR as u32,
        }
    }

    /// RMS of deck `d`'s main output over frames 9600..28800 (after the trim ramp settled).
    fn deck_rms(m: &mut Mixer, d: usize) -> f64 {
        let mut acc = 0.0f64;
        let mut n = 0usize;
        for f in 0..28_800 {
            let o = m.decks[d].render_frame().main.0 as f64;
            if f >= 9_600 {
                acc += o * o;
                n += 1;
            }
        }
        (acc / n as f64).sqrt()
    }

    #[test]
    fn trim_plus_6db_doubles_amplitude() {
        let (mut m, tx) = mixer();
        for d in [DeckId::A, DeckId::B] {
            let deck = &mut m.decks[d.index()];
            deck.load(sine_track(2.0), (None, None, None, 0.0));
            deck.set_key_lock(false);
            deck.play();
        }
        tx.send(Command::Trim(DeckId::B, 6.0)).unwrap();
        m.drain_commands();
        let a = deck_rms(&mut m, 0);
        let b = deck_rms(&mut m, 1);
        let ratio = b / a;
        assert!((ratio - 2.0).abs() < 0.02, "ratio {ratio} (a {a}, b {b})");
        // Trim is independent of the fader: the fader still scales on top.
        assert!((m.decks[1].trim_gain() - crate::dsp::db_to_lin(6.0)).abs() < 1e-6);
        // −∞ silences, the ceiling is +12 dB.
        assert_eq!(crate::deck::trim_gain(f32::NEG_INFINITY), 0.0);
        assert!((crate::deck::trim_gain(40.0) - crate::dsp::db_to_lin(12.0)).abs() < 1e-6);
    }

    /// Master RMS (left) over ~0.2 s after letting ramps settle for ~0.2 s.
    fn master_rms(m: &mut Mixer) -> f64 {
        let mut out = vec![0.0f32; 512];
        let (mut acc, mut n) = (0.0f64, 0usize);
        for block in 0..80 {
            m.render(&mut out, 2);
            if block >= 40 {
                for fr in out.chunks(2) {
                    acc += (fr[0] as f64) * (fr[0] as f64);
                    n += 1;
                }
            }
        }
        (acc / n as f64).sqrt()
    }

    /// Deck A alone, playing a steady sine; master low enough that the soft clip is linear.
    fn sine_on_a() -> (Mixer, Sender<Command>) {
        let (mut m, tx) = mixer();
        let deck = &mut m.decks[0];
        deck.load(sine_track(8.0), (None, None, None, 0.0));
        deck.set_key_lock(false);
        deck.play();
        tx.send(Command::MasterVolume(0.1)).unwrap();
        (m, tx)
    }

    #[test]
    fn crossfader_curve_command_changes_the_gain_law() {
        let (mut m, tx) = sine_on_a();
        // Fader three quarters of the way to B: deck A sits at x = 0.25 of its travel.
        tx.send(Command::Crossfader(0.5)).unwrap();
        tx.send(Command::CrossfaderCurve(CrossfaderCurve::Linear))
            .unwrap();
        let linear = master_rms(&mut m);
        assert!(linear > 1e-4, "deck A is audible: {linear}");
        tx.send(Command::CrossfaderCurve(CrossfaderCurve::Smooth))
            .unwrap();
        let smooth = master_rms(&mut m);
        tx.send(Command::CrossfaderCurve(CrossfaderCurve::Sharp))
            .unwrap();
        let sharp = master_rms(&mut m);
        // linear = 0.25, smooth = sin(0.25 · π/2) = 0.3827, sharp = min(4 · 0.25, 1) = 1.
        let want_smooth = (0.25f64 * std::f64::consts::FRAC_PI_2).sin() / 0.25;
        assert!(
            (smooth / linear - want_smooth).abs() < 0.02,
            "smooth/linear {} (want {want_smooth})",
            smooth / linear
        );
        assert!(
            (sharp / linear - 4.0).abs() < 0.05,
            "sharp/linear {}",
            sharp / linear
        );
        // Sharp cuts fully at the far end, like every curve.
        tx.send(Command::Crossfader(1.0)).unwrap();
        assert!(master_rms(&mut m) < 1e-6);
    }

    #[test]
    fn crossfader_assign_thru_ignores_the_crossfader() {
        let (mut m, tx) = sine_on_a();
        // Default side of deck A is A: open at -1, closed at +1.
        tx.send(Command::Crossfader(-1.0)).unwrap();
        let open = master_rms(&mut m);
        assert!(open > 1e-4, "deck A is audible: {open}");
        tx.send(Command::Crossfader(1.0)).unwrap();
        assert!(master_rms(&mut m) < 1e-6, "side A is closed at +1");
        // THRU: full level wherever the crossfader is.
        tx.send(Command::CrossfaderAssign(DeckId::A, CrossfaderAssign::Thru))
            .unwrap();
        for pos in [1.0f32, 0.0, -1.0] {
            tx.send(Command::Crossfader(pos)).unwrap();
            let thru = master_rms(&mut m);
            assert!(
                (thru / open - 1.0).abs() < 0.01,
                "thru at {pos}: {thru} vs open {open}"
            );
        }
        // Side B mirrors side A; other decks keep their own side.
        tx.send(Command::CrossfaderAssign(DeckId::A, CrossfaderAssign::B))
            .unwrap();
        tx.send(Command::Crossfader(-1.0)).unwrap();
        assert!(master_rms(&mut m) < 1e-6, "side B is closed at -1");
        tx.send(Command::Crossfader(1.0)).unwrap();
        assert!((master_rms(&mut m) / open - 1.0).abs() < 0.01);
        assert_eq!(m.decks[1].crossfader_assign, CrossfaderAssign::B);
    }

    #[test]
    fn crossfader_wire_names_parse_and_reject_junk() {
        // Same names as the serde `rename_all = "lowercase"` form the UI receives in the snapshot.
        for (wire, c) in [
            ("linear", CrossfaderCurve::Linear),
            ("smooth", CrossfaderCurve::Smooth),
            ("sharp", CrossfaderCurve::Sharp),
        ] {
            assert_eq!(CrossfaderCurve::parse(wire), Some(c));
        }
        for (wire, a) in [
            ("a", CrossfaderAssign::A),
            ("thru", CrossfaderAssign::Thru),
            ("b", CrossfaderAssign::B),
        ] {
            assert_eq!(CrossfaderAssign::parse(wire), Some(a));
        }
        for junk in ["", "Smooth", "c", "THRU", "linear "] {
            assert_eq!(CrossfaderCurve::parse(junk), None, "{junk:?}");
            assert_eq!(CrossfaderAssign::parse(junk), None, "{junk:?}");
        }
        // The mixer starts on the law the UI mirror reports.
        let (m, _tx) = mixer();
        assert_eq!(m.curve, MixerState::initial(48_000).crossfader_curve.law());
    }

    #[test]
    fn slip_shadow_position_is_published_while_looping() {
        let (mut m, tx) = mixer();
        load(&mut m, DeckId::A, 120.0, 0.0);
        m.decks[0].seek_secs(2.0);
        tx.send(Command::SetSlip(DeckId::A, true)).unwrap();
        tx.send(Command::Play(DeckId::A)).unwrap();
        let mut out = vec![0.0f32; 512];
        m.render(&mut out, 2);
        let slot = |m: &Mixer| m.snapshot.deck_slip_pos[0].load(Ordering::Relaxed);
        assert_eq!(slot(&m), u64::MAX, "no shadow before a loop");
        tx.send(Command::Beatloop(DeckId::A, 1.0)).unwrap(); // 0.5 s loop
        for _ in 0..188 {
            m.render(&mut out, 2); // 188 × 256 frames ≈ 1 s inside the loop
        }
        let shadow = f64::from_bits(slot(&m));
        let pos = m.snapshot.deck_pos_ms[0].load(Ordering::Relaxed) as f64 / 1000.0;
        assert!(pos < 2.51, "loop holds the playhead: {pos}");
        assert!(shadow > 2.9 && shadow < 3.1, "shadow {shadow}");
        for _ in 0..10 {
            m.render(&mut out, 2);
        }
        assert!(f64::from_bits(slot(&m)) > shadow, "shadow keeps running");
        tx.send(Command::LoopExit(DeckId::A)).unwrap();
        m.render(&mut out, 2);
        assert_eq!(slot(&m), u64::MAX, "cleared on release");
    }

    #[test]
    fn sample_rate_change_keeps_deck_state() {
        let (mut m, tx) = mixer();
        load(&mut m, DeckId::A, 120.0, 0.0);
        m.decks[0].seek_secs(3.0);
        m.decks[0].set_hot_cue(2);
        tx.send(Command::Trim(DeckId::A, -6.0)).unwrap();
        m.drain_commands();
        m.set_sample_rate(44_100.0);
        let d = &m.decks[0];
        assert!((d.position_secs() - 3.0).abs() < 1e-9);
        assert!((d.hot_cue_secs()[2].unwrap() - 3.0).abs() < 1e-9);
        assert!((d.trim_gain() - crate::dsp::db_to_lin(-6.0)).abs() < 1e-6);
        assert_eq!(d.sample_rate(), 44_100.0);
        // Track at 48 kHz played on 44.1 kHz: 1 s of output advances 1 s of track.
        m.decks[0].play();
        for _ in 0..44_100 {
            m.decks[0].render_frame();
        }
        assert!((m.decks[0].position_secs() - 4.0).abs() < 1e-3);
    }
}
