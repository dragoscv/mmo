//! Per-deck beat FX synced to the master clock (WP19-10): echo, FDN reverb,
//! roll (beat repeat) and gate (trance gate), each with wet/dry and a beat
//! fraction. Post-fader insert so tails follow the channel fader.
//!
//! The deck passes the master tempo and the master beat position (fractional
//! beats) every frame; time-based parameters derive from them, so the effect
//! stays locked to the master grid even while the deck itself is off-grid.
//! All buffers are preallocated; `process` never allocates or locks.
// Parallel per-line arrays (taps, damping, lines) read clearest as indexed loops.
#![allow(clippy::needless_range_loop)]

use crate::dsp::{Biquad, Smoothed};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BeatFxKind {
    #[default]
    None,
    Echo,
    Reverb,
    Roll,
    Gate,
}

impl BeatFxKind {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Echo,
            2 => Self::Reverb,
            3 => Self::Roll,
            4 => Self::Gate,
            _ => Self::None,
        }
    }

    pub fn as_u8(self) -> u8 {
        match self {
            Self::None => 0,
            Self::Echo => 1,
            Self::Reverb => 2,
            Self::Roll => 3,
            Self::Gate => 4,
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "none" | "off" => Self::None,
            "echo" => Self::Echo,
            "reverb" => Self::Reverb,
            "roll" => Self::Roll,
            "gate" => Self::Gate,
            _ => return None,
        })
    }
}

/// Max beat-synced memory: 4 s (e.g. 2 beats at 30 bpm, 8 beats at 120 bpm).
const MAX_SECS: f32 = 4.0;
/// FDN order (Householder feedback matrix).
const FDN: usize = 8;
/// Mutually prime-ish delay lengths at 48 kHz, scaled to the sample rate.
const FDN_LENS: [usize; FDN] = [1427, 1601, 1867, 2053, 2311, 2539, 2801, 3083];

struct MonoLine {
    buf: Vec<f32>,
    w: usize,
}

impl MonoLine {
    fn new(len: usize) -> Self {
        MonoLine {
            buf: vec![0.0; len.max(2)],
            w: 0,
        }
    }
    #[inline]
    fn tap(&self) -> f32 {
        // Oldest sample = full-length delay.
        self.buf[self.w]
    }
    #[inline]
    fn push(&mut self, x: f32) {
        self.buf[self.w] = x;
        self.w = (self.w + 1) % self.buf.len();
    }
    fn clear(&mut self) {
        self.buf.iter_mut().for_each(|x| *x = 0.0);
    }
}

pub struct BeatFx {
    sr: f32,
    kind: BeatFxKind,
    wet: Smoothed,
    beats: f64,
    feedback: f32,
    // Echo / roll memory (stereo, MAX_SECS).
    mem_l: Vec<f32>,
    mem_r: Vec<f32>,
    w: usize,
    // Roll state.
    roll_active: bool,
    roll_start: usize,
    roll_len: usize,
    roll_idx: usize,
    roll_fade: Smoothed,
    // FDN reverb.
    lines: [MonoLine; FDN],
    damp: [Biquad; FDN],
    // Gate envelope.
    gate_env: f32,
}

impl BeatFx {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sample_rate.max(8_000.0);
        let mem = (sr * MAX_SECS) as usize;
        let scale = sr / 48_000.0;
        let lines = std::array::from_fn(|i| MonoLine::new((FDN_LENS[i] as f32 * scale) as usize));
        let mut damp = [Biquad::identity(); FDN];
        for d in damp.iter_mut() {
            d.low_pass(7_000.0, 0.6, sr);
        }
        BeatFx {
            sr,
            kind: BeatFxKind::None,
            wet: Smoothed::new(0.0, sr, 30.0),
            beats: 0.5,
            feedback: 0.5,
            mem_l: vec![0.0; mem],
            mem_r: vec![0.0; mem],
            w: 0,
            roll_active: false,
            roll_start: 0,
            roll_len: 1,
            roll_idx: 0,
            roll_fade: Smoothed::new(0.0, sr, 4.0),
            lines,
            damp,
            gate_env: 1.0,
        }
    }

    pub fn kind(&self) -> BeatFxKind {
        self.kind
    }

    /// Select the effect, wet/dry (0..1), beat fraction (1/32..8) and feedback /
    /// depth (0..1; echo feedback, reverb decay, gate depth).
    pub fn set(&mut self, kind: BeatFxKind, wet: f32, beats: f64, feedback: f32) {
        if kind != self.kind {
            if kind == BeatFxKind::Reverb {
                self.lines.iter_mut().for_each(MonoLine::clear);
            }
            if kind == BeatFxKind::Echo {
                self.mem_l.iter_mut().for_each(|x| *x = 0.0);
                self.mem_r.iter_mut().for_each(|x| *x = 0.0);
            }
            self.roll_active = false;
            self.kind = kind;
        }
        self.wet.set_target(wet.clamp(0.0, 1.0));
        self.beats = beats.clamp(1.0 / 32.0, 8.0);
        self.feedback = feedback.clamp(0.0, 0.95);
    }

    #[inline]
    fn beat_samples(&self, bpm: f64) -> usize {
        let bpm = if bpm > 1.0 { bpm } else { 120.0 };
        let n = (60.0 / bpm * self.beats * self.sr as f64) as usize;
        n.clamp(1, self.mem_l.len() - 1)
    }

    /// Process one frame. `bpm` = master tempo, `master_beat` = master beat
    /// position (fractional beats since its beat 0).
    #[inline]
    pub fn process(&mut self, l: f32, r: f32, bpm: f64, master_beat: f64) -> (f32, f32) {
        let wet = self.wet.next();
        let n = self.mem_l.len();
        let mut out = (l, r);
        match self.kind {
            BeatFxKind::None => {}
            BeatFxKind::Echo => {
                let d = self.beat_samples(bpm);
                let i = (self.w + n - d) % n;
                let (el, er) = (self.mem_l[i], self.mem_r[i]);
                self.mem_l[self.w] = (l + el * self.feedback).clamp(-4.0, 4.0);
                self.mem_r[self.w] = (r + er * self.feedback).clamp(-4.0, 4.0);
                out = (l + el * wet, r + er * wet);
            }
            BeatFxKind::Reverb => {
                // 8-line FDN, Householder mixing (orthogonal: x - 2/N·sum).
                let decay = 0.6 + 0.38 * self.feedback;
                let mut taps = [0.0f32; FDN];
                let mut sum = 0.0;
                for (k, line) in self.lines.iter().enumerate() {
                    taps[k] = line.tap();
                    sum += taps[k];
                }
                let mix = 2.0 / FDN as f32 * sum;
                let input = (l + r) * 0.5;
                let (mut wl, mut wr) = (0.0f32, 0.0f32);
                for k in 0..FDN {
                    let fb = self.damp[k].process((taps[k] - mix) * decay);
                    self.lines[k].push(input + fb);
                    if k % 2 == 0 {
                        wl += taps[k]
                    } else {
                        wr += taps[k]
                    }
                }
                let g = 0.35;
                out = (
                    l * (1.0 - 0.5 * wet) + wl * g * wet,
                    r * (1.0 - 0.5 * wet) + wr * g * wet,
                );
            }
            BeatFxKind::Roll => {
                // Record continuously; while wet is up, repeat the last `beats` slice
                // that started on the master grid.
                self.mem_l[self.w] = l;
                self.mem_r[self.w] = r;
                let engaged = wet > 0.5;
                if engaged && !self.roll_active {
                    let len = self.beat_samples(bpm);
                    // Start the slice on the most recent grid point of size `beats`.
                    let beat_len = len as f64 / self.beats;
                    let since = (master_beat.rem_euclid(self.beats) * beat_len) as usize;
                    self.roll_len = len;
                    self.roll_start = (self.w + n - since.min(n - 1)) % n;
                    self.roll_idx = since % len;
                    self.roll_active = true;
                } else if !engaged {
                    self.roll_active = false;
                }
                self.roll_fade
                    .set_target(if self.roll_active { 1.0 } else { 0.0 });
                let f = self.roll_fade.next();
                if f > 1e-4 {
                    let i = (self.roll_start + self.roll_idx) % n;
                    let (rl, rr) = (self.mem_l[i], self.mem_r[i]);
                    self.roll_idx = (self.roll_idx + 1) % self.roll_len.max(1);
                    out = (l * (1.0 - f) + rl * f, r * (1.0 - f) + rr * f);
                }
            }
            BeatFxKind::Gate => {
                // Open for the first half of each `beats` step, with ~3 ms ramps.
                let phase = master_beat.rem_euclid(self.beats) / self.beats;
                let target = if phase < 0.5 {
                    1.0
                } else {
                    1.0 - self.feedback.max(0.6)
                };
                let coef = (-1.0 / (0.003 * self.sr)).exp();
                self.gate_env = target + (self.gate_env - target) * coef;
                let g = 1.0 - wet * (1.0 - self.gate_env);
                out = (l * g, r * g);
            }
        }
        self.w = (self.w + 1) % n;
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beat_fx_stay_finite_on_noise() {
        for kind in 1..=4u8 {
            let mut fx = BeatFx::new(48_000.0);
            fx.set(BeatFxKind::from_u8(kind), 1.0, 0.5, 0.9);
            let mut seed = 7u32;
            let mut beat = 0.0f64;
            let mut peak = 0.0f32;
            for _ in 0..48_000 * 10 {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let n = (seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0;
                beat += 128.0 / 60.0 / 48_000.0;
                let (l, r) = fx.process(n * 0.5, n * 0.4, 128.0, beat);
                assert!(l.is_finite() && r.is_finite(), "kind {kind}: NaN/inf");
                peak = peak.max(l.abs()).max(r.abs());
            }
            assert!(peak < 16.0, "kind {kind}: runaway {peak}");
        }
    }

    #[test]
    fn gate_closes_on_the_off_half() {
        let mut fx = BeatFx::new(48_000.0);
        fx.set(BeatFxKind::Gate, 1.0, 1.0, 1.0);
        for _ in 0..48_000 {
            fx.process(1.0, 1.0, 120.0, 0.1);
        }
        let (open, _) = fx.process(1.0, 1.0, 120.0, 0.2);
        for _ in 0..4_800 {
            fx.process(1.0, 1.0, 120.0, 0.7);
        }
        let (closed, _) = fx.process(1.0, 1.0, 120.0, 0.7);
        assert!(open > 0.95 && closed < 0.45, "open {open} closed {closed}");
    }
}
