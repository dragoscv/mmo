//! Live analysis (deck preview / line input).
//!
//! Tempo and loudness are this crate's own fixed-size DSP: [`StreamingAnalyzer::new`] allocates
//! every buffer up front and those paths never touch the heap in [`StreamingAnalyzer::push`].
//!
//! The live key comes from the shared engine ([`mixai_listen::Listener`], WP18-01): mono samples
//! are batched in a preallocated buffer and handed to it, and its reading is mapped to
//! [`KeyResult`] on every estimate refresh. That engine allocates in its own `push`/`snapshot`
//! (tempo history copies, key ranking), so `push` is only allocation-free with
//! [`StreamingOptions::live_key`] = `false`; `tests/no_alloc.rs` checks exactly that mode.

use serde::{Deserialize, Serialize};

use mixai_listen::{Listener, ListenerConfig};

use crate::key_map::KeyResult;
use crate::loudness::{LiveLoudness, LoudnessMeter};
use crate::tempo::{ONSET_HOP, OnsetDetector, TempoEstimator, TempoRange};
use crate::util::Decimator;

/// Mono samples batched before each hand-off to the shared key engine.
const LISTEN_BATCH: usize = 1024;

/// Live analyser settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StreamingOptions {
    /// Run the shared `mixai-listen` key engine (allocates in `push`, see the module docs).
    pub live_key: bool,
    pub tempo_range: TempoRange,
    /// Seconds between estimate refreshes.
    pub update_interval_sec: f64,
    /// Onset history used for the tempo estimate.
    pub tempo_window_sec: f64,
}

impl Default for StreamingOptions {
    fn default() -> Self {
        Self {
            live_key: true,
            tempo_range: TempoRange::default(),
            update_interval_sec: 1.0,
            tempo_window_sec: 10.0,
        }
    }
}

/// Latest live estimates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveSnapshot {
    /// Seconds of audio pushed so far.
    pub elapsed_sec: f64,
    /// Number of estimate refreshes so far.
    pub updates: u64,
    pub bpm: Option<f64>,
    pub bpm_confidence: f32,
    pub key: Option<KeyResult>,
    pub loudness: LiveLoudness,
}

/// Streaming key + tempo + loudness analyser.
pub struct StreamingAnalyzer {
    channels: usize,
    sample_rate: u32,
    opts: StreamingOptions,
    carry: Vec<f32>,
    carry_len: usize,
    frames: u64,
    meter: LoudnessMeter,
    dec: Decimator,
    listener: Option<Listener>,
    listen_buf: Vec<f32>,
    onset: OnsetDetector,
    odf: Vec<f32>,
    odf_pos: usize,
    odf_filled: usize,
    tempo: TempoEstimator,
    since_update: usize,
    update_every: usize,
    updates: u64,
    key: Option<KeyResult>,
    bpm: Option<(f64, f32)>,
}

impl StreamingAnalyzer {
    pub fn new(channels: u16, sample_rate: u32, opts: StreamingOptions) -> Self {
        let ch = channels.max(1) as usize;
        let sample_rate = sample_rate.max(1);
        let factor = Decimator::factor_for(sample_rate);
        let dsr = sample_rate as f64 / factor as f64;
        let fps = dsr / ONSET_HOP as f64;
        let cap = ((opts.tempo_window_sec.max(2.0)) * fps).ceil() as usize;
        Self {
            channels: ch,
            sample_rate,
            carry: vec![0.0; ch],
            carry_len: 0,
            frames: 0,
            meter: LoudnessMeter::new(ch, sample_rate),
            dec: Decimator::new(factor),
            listener: opts
                .live_key
                .then(|| Listener::new(ListenerConfig::new(sample_rate))),
            listen_buf: Vec::with_capacity(if opts.live_key { LISTEN_BATCH } else { 0 }),
            onset: OnsetDetector::new(dsr),
            odf: vec![0.0; cap],
            odf_pos: 0,
            odf_filled: 0,
            tempo: TempoEstimator::new(cap, fps, &opts.tempo_range),
            since_update: 0,
            update_every: ((opts.update_interval_sec.max(0.1)) * dsr).round() as usize,
            updates: 0,
            key: None,
            bpm: None,
            opts,
        }
    }

    pub fn channels(&self) -> u16 {
        self.channels as u16
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Feed interleaved samples of any length (partial frames are carried to the next call).
    pub fn push(&mut self, samples: &[f32]) {
        let ch = self.channels;
        let mut rest = samples;
        if self.carry_len > 0 {
            let need = ch - self.carry_len;
            if rest.len() < need {
                self.carry[self.carry_len..self.carry_len + rest.len()].copy_from_slice(rest);
                self.carry_len += rest.len();
                return;
            }
            self.carry[self.carry_len..].copy_from_slice(&rest[..need]);
            rest = &rest[need..];
            self.carry_len = 0;
            let mut frame = [0.0f32; 8];
            if ch <= frame.len() {
                frame[..ch].copy_from_slice(&self.carry);
                self.push_frame(&frame[..ch]);
            } else {
                // More than 8 channels: rotate the carry through the meter in place.
                let carry = std::mem::take(&mut self.carry);
                self.push_frame(&carry);
                self.carry = carry;
            }
        }
        let whole = rest.len() / ch * ch;
        for frame in rest[..whole].chunks_exact(ch) {
            self.push_frame(frame);
        }
        let tail = &rest[whole..];
        self.carry[..tail.len()].copy_from_slice(tail);
        self.carry_len = tail.len();
        self.flush_listener();
    }

    /// Hand the batched mono samples to the shared key engine.
    fn flush_listener(&mut self) {
        if let Some(l) = self.listener.as_mut() {
            if !self.listen_buf.is_empty() {
                l.push(&self.listen_buf);
                self.listen_buf.clear();
            }
        }
    }

    #[inline]
    fn push_frame(&mut self, frame: &[f32]) {
        self.frames += 1;
        self.meter.push_frame(frame);
        let mono = frame.iter().sum::<f32>() / frame.len() as f32;
        if self.listener.is_some() {
            self.listen_buf.push(mono);
            if self.listen_buf.len() >= LISTEN_BATCH {
                self.flush_listener();
            }
        }
        let Some(y) = self.dec.push(mono) else {
            return;
        };
        if let Some((f, _)) = self.onset.push(y) {
            self.odf[self.odf_pos] = f;
            self.odf_pos = (self.odf_pos + 1) % self.odf.len();
            self.odf_filled = (self.odf_filled + 1).min(self.odf.len());
        }
        self.since_update += 1;
        if self.since_update >= self.update_every {
            self.since_update = 0;
            self.update();
        }
    }

    fn update(&mut self) {
        self.updates += 1;
        self.flush_listener();
        if let Some(l) = self.listener.as_mut() {
            self.key = KeyResult::from_listen(&l.snapshot());
        }
        if self.odf_filled == self.odf.len() {
            let (a, b) = (&self.odf[self.odf_pos..], &self.odf[..self.odf_pos]);
            self.tempo.load(a, b);
        } else {
            self.tempo.load(&self.odf[..self.odf_filled], &[]);
        }
        self.bpm = self.tempo.estimate(&self.opts.tempo_range);
    }

    /// Latest estimates.
    pub fn snapshot(&self) -> LiveSnapshot {
        LiveSnapshot {
            elapsed_sec: self.frames as f64 / self.sample_rate as f64,
            updates: self.updates,
            bpm: self.bpm.map(|b| b.0),
            bpm_confidence: self.bpm.map_or(0.0, |b| b.1),
            key: self.key.clone(),
            loudness: self.meter.live(),
        }
    }

    /// Forget everything (e.g. when the user switches source).
    pub fn reset(&mut self) {
        self.carry_len = 0;
        self.frames = 0;
        self.meter.reset();
        self.dec.reset();
        if let Some(l) = self.listener.as_mut() {
            l.reset();
        }
        self.listen_buf.clear();
        self.onset.reset();
        self.odf.fill(0.0);
        self.odf_pos = 0;
        self.odf_filled = 0;
        self.since_update = 0;
        self.updates = 0;
        self.key = None;
        self.bpm = None;
    }
}
