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

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Stream, StreamConfig};
use crossbeam_channel::{bounded, Receiver, Sender};

use crate::deck::{Deck, TrackBuffer};
use crate::dsp::{crossfader_gain, soft_clip};
use crate::error::CoreError;
use crate::state::{AudioDevice, CrossfaderAssign, DeckId, MixerState};

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
}

impl Snapshot {
    fn new() -> Self {
        Snapshot {
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
    // Reserved for the headphone cue bus mixdown (full routing matrix).
    #[allow(dead_code)]
    cue_vol: f32,
    master_vu: f32,
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
            cue_vol: 0.7,
            master_vu: 0.0,
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
                Command::Load { deck, buffer, track_id, title, artist, bpm } => {
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
            }
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

    /// Fill an interleaved stereo output buffer.
    fn render(&mut self, out: &mut [f32], channels: usize) {
        self.drain_commands();

        for frame in out.chunks_mut(channels) {
            let mut mix_l = 0.0f32;
            let mut mix_r = 0.0f32;

            for deck in self.decks.iter_mut() {
                let (l, r) = deck.render_frame();
                let g = match deck.crossfader_assign {
                    CrossfaderAssign::Thru => 1.0,
                    CrossfaderAssign::A => crossfader_gain(self.crossfader, true, self.curve),
                    CrossfaderAssign::B => crossfader_gain(self.crossfader, false, self.curve),
                };
                mix_l += l * g;
                mix_r += r * g;
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

            // Write to all output channels (mono-sum to extras).
            if channels >= 2 {
                frame[0] = mix_l;
                frame[1] = mix_r;
                for c in frame.iter_mut().skip(2) {
                    *c = 0.0;
                }
            } else if channels == 1 {
                frame[0] = (mix_l + mix_r) * 0.5;
            }
        }

        self.publish_snapshot();
    }

    fn publish_snapshot(&mut self) {
        // Publish a few times per buffer is wasteful; once per buffer is fine.
        let s = &self.snapshot;
        s.master_vu.store((self.master_vu.clamp(0.0, 1.0) * 1000.0) as u32, Ordering::Relaxed);
        for (i, deck) in self.decks.iter().enumerate() {
            s.deck_vu[i].store((deck.vu().clamp(0.0, 1.0) * 1000.0) as u32, Ordering::Relaxed);
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
        }
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

        let sample_rate = supported.sample_rate().0;
        let channels = supported.channels();
        let config: StreamConfig = supported.config();

        let (tx, rx) = bounded::<Command>(1024);
        let snapshot = Arc::new(Snapshot::new());
        let (recorder, rec_tx) = crate::recorder::Recorder::spawn();
        let mut mixer = Mixer::new(sample_rate as f32, rx, snapshot.clone(), rec_tx);

        let ch = channels as usize;
        let err_fn = |e| log::error!("mixai audio stream error: {e}");
        let stream = device
            .build_output_stream(
                &config,
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
        })
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
        self.send(Command::LoadStems { deck, layers: Box::new(layers) });
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
                deck.hot_cues[slot] = if v == u32::MAX { None } else { Some(v as f64 / 1000.0) };
            }
            deck.loop_active = s.deck_loop_active[i].load(Ordering::Relaxed);
            deck.loop_start = s.deck_loop_start_ms[i].load(Ordering::Relaxed) as f64 / 1000.0;
            deck.loop_end = s.deck_loop_end_ms[i].load(Ordering::Relaxed) as f64 / 1000.0;
        }
        state
    }
}

/// Enumerate output devices for the settings UI.
pub fn list_output_devices() -> Vec<AudioDevice> {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|d| d.name().ok());
    let mut out = Vec::new();
    if let Ok(devices) = host.output_devices() {
        for d in devices {
            let name = d.name().unwrap_or_else(|_| "Unknown".into());
            let channels = d
                .default_output_config()
                .map(|c| c.channels())
                .unwrap_or(2);
            out.push(AudioDevice {
                id: name.clone(),
                is_default: Some(&name) == default_name.as_ref(),
                name,
                channels,
            });
        }
    }
    out
}
