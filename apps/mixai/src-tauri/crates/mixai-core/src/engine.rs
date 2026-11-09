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

use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

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
use crate::routing::{CompDelay, RoutingConfig, write_frame};
use crate::state::{AudioDevice, CrossfaderAssign, DeckId, MixerState};

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
    Tempo(DeckId, f64),
    KeyLock(DeckId, bool),
    Eq(DeckId, String, f32),
    Filter(DeckId, f32),
    Cue(DeckId, bool),
    Crossfader(f32),
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
    // Reserved for cue-bus + per-deck resampling work (v0.1 follow-ups).
    #[allow(dead_code)]
    sr: f32,
    decks: Vec<Deck>,
    crossfader: f32,
    curve: u8,
    master_vol: crate::dsp::Smoothed,
    master_vu: f32,
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
                Command::Tempo(d, t) => self.decks[d.index()].set_tempo(t),
                Command::KeyLock(d, on) => self.decks[d.index()].set_key_lock(on),
                Command::Eq(d, band, db) => self.decks[d.index()].set_eq(&band, db),
                Command::Filter(d, v) => self.decks[d.index()].set_filter(v),
                Command::Cue(d, on) => self.decks[d.index()].set_cue(on),
                Command::Crossfader(v) => self.crossfader = v.clamp(-1.0, 1.0),
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
        self.drain_commands();
        if channels == 0 {
            return;
        }
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
    _stream: Stream,
    tx: Sender<Command>,
    snapshot: Arc<Snapshot>,
    sample_rate: u32,
    channels: u16,
    latency_ms: f32,
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

impl Engine {
    /// Build the default output stream and start the audio thread.
    pub fn start() -> Result<Self, CoreError> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| CoreError::Device("no default output device".into()))?;
        let supported = device
            .default_output_config()
            .map_err(|e| CoreError::Device(format!("default config: {e}")))?;

        // cpal 0.17+: `SampleRate` is a plain `u32` alias.
        let sample_rate = supported.sample_rate();
        let channels = supported.channels();
        let config: StreamConfig = supported.config();

        let (tx, rx) = bounded::<Command>(1024);
        let snapshot = Arc::new(Snapshot::new());
        let (recorder, rec_tx) = crate::recorder::Recorder::spawn();
        let mut mixer = Mixer::new(sample_rate as f32, rx, snapshot.clone(), rec_tx);

        let ch = channels as usize;
        let err_fn = |e: cpal::Error| log::error!("mixai audio stream error: {e}");
        // cpal 0.18: `StreamConfig` is `Copy` and passed by value; streams no longer
        // auto-start, so the explicit `play()` below is required on every backend.
        let stream = device
            .build_output_stream(
                config,
                move |data: &mut [f32], _| mixer.render(data, ch),
                err_fn,
                None,
            )
            .map_err(|e| CoreError::Device(format!("build stream: {e}")))?;
        stream
            .play()
            .map_err(|e| CoreError::Device(format!("play stream: {e}")))?;

        // Rough latency estimate from buffer size when available.
        let latency_ms = match config.buffer_size {
            cpal::BufferSize::Fixed(frames) => frames as f32 / sample_rate as f32 * 1000.0,
            cpal::BufferSize::Default => 0.0,
        };

        Ok(Engine {
            _stream: stream,
            tx,
            snapshot,
            sample_rate,
            channels,
            latency_ms,
            mirror: Mutex::new(MixerState::initial(sample_rate)),
            recorder: Mutex::new(recorder),
            perf: Mutex::new(PerfMirror::default()),
        })
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
        state.latency_ms = self.latency_ms;
        let s = &self.snapshot;
        state.master_vu = s.master_vu.load(Ordering::Relaxed) as f32 / 1000.0;
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
}
