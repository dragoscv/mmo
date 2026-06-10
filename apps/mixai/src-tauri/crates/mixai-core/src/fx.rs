//! Real-time-safe per-deck FX unit: a beat-synced feedback **echo** and a
//! Schroeder **reverb**. Allocated once (ring buffers) at deck creation; the
//! audio callback only reads/writes preallocated storage — no locks, no alloc.
//!
//! Signal: each effect is a wet path; the deck blends `dry*(1-wet) + wet*W`
//! with a smoothed `wet` so toggling is click-free.

use crate::dsp::Smoothed;

/// Selected effect for a deck.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FxKind {
    Off,
    Echo,
    Reverb,
}

impl FxKind {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => FxKind::Echo,
            2 => FxKind::Reverb,
            _ => FxKind::Off,
        }
    }
    pub fn as_u8(self) -> u8 {
        match self {
            FxKind::Off => 0,
            FxKind::Echo => 1,
            FxKind::Reverb => 2,
        }
    }
}

/// A simple stereo delay line backed by a ring buffer.
struct DelayLine {
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    write: usize,
    cap: usize,
}

impl DelayLine {
    fn new(max_samples: usize) -> Self {
        let cap = max_samples.max(1);
        DelayLine {
            buf_l: vec![0.0; cap],
            buf_r: vec![0.0; cap],
            write: 0,
            cap,
        }
    }

    #[inline]
    fn read(&self, delay: usize) -> (f32, f32) {
        let d = delay.min(self.cap - 1);
        let idx = (self.write + self.cap - d) % self.cap;
        (self.buf_l[idx], self.buf_r[idx])
    }

    #[inline]
    fn write(&mut self, l: f32, r: f32) {
        self.buf_l[self.write] = l;
        self.buf_r[self.write] = r;
        self.write = (self.write + 1) % self.cap;
    }

    fn clear(&mut self) {
        self.buf_l.iter_mut().for_each(|x| *x = 0.0);
        self.buf_r.iter_mut().for_each(|x| *x = 0.0);
        self.write = 0;
    }
}

/// A mono Schroeder all-pass section (used in the reverb tail).
struct AllPass {
    buf: Vec<f32>,
    idx: usize,
    gain: f32,
}

impl AllPass {
    fn new(len: usize, gain: f32) -> Self {
        AllPass { buf: vec![0.0; len.max(1)], idx: 0, gain }
    }
    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let buffered = self.buf[self.idx];
        let out = -x + buffered;
        self.buf[self.idx] = x + buffered * self.gain;
        self.idx = (self.idx + 1) % self.buf.len();
        out
    }
    fn clear(&mut self) {
        self.buf.iter_mut().for_each(|x| *x = 0.0);
        self.idx = 0;
    }
}

/// A mono Schroeder comb filter with feedback (reverb body).
struct Comb {
    buf: Vec<f32>,
    idx: usize,
    feedback: f32,
}

impl Comb {
    fn new(len: usize, feedback: f32) -> Self {
        Comb { buf: vec![0.0; len.max(1)], idx: 0, feedback }
    }
    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let out = self.buf[self.idx];
        self.buf[self.idx] = x + out * self.feedback;
        self.idx = (self.idx + 1) % self.buf.len();
        out
    }
    fn clear(&mut self) {
        self.buf.iter_mut().for_each(|x| *x = 0.0);
        self.idx = 0;
    }
}

/// Per-deck effects processor.
pub struct Fx {
    kind: FxKind,
    /// Wet mix 0..1 (smoothed).
    wet: Smoothed,
    /// Echo feedback amount 0..0.95.
    feedback: f32,
    /// Echo delay length in samples (set from beats × tempo).
    echo_samples: usize,
    delay: DelayLine,
    // Reverb: 4 combs + 2 all-pass (classic Schroeder), mono core, stereo spread.
    combs_l: [Comb; 4],
    combs_r: [Comb; 4],
    aps_l: [AllPass; 2],
    aps_r: [AllPass; 2],
}

impl Fx {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sample_rate.max(1.0);
        // Up to 2 s of echo memory.
        let delay = DelayLine::new((sr * 2.0) as usize);
        // Reverb comb/all-pass lengths (Freeverb-ish, scaled to SR).
        let scale = sr / 44100.0;
        let cl = |n: usize| (n as f32 * scale) as usize;
        let combs_l = [
            Comb::new(cl(1116), 0.84),
            Comb::new(cl(1188), 0.84),
            Comb::new(cl(1277), 0.84),
            Comb::new(cl(1356), 0.84),
        ];
        // Slight offset on the right channel for stereo width.
        let combs_r = [
            Comb::new(cl(1116 + 23), 0.84),
            Comb::new(cl(1188 + 23), 0.84),
            Comb::new(cl(1277 + 23), 0.84),
            Comb::new(cl(1356 + 23), 0.84),
        ];
        let aps_l = [AllPass::new(cl(556), 0.5), AllPass::new(cl(441), 0.5)];
        let aps_r = [AllPass::new(cl(556 + 23), 0.5), AllPass::new(cl(441 + 23), 0.5)];
        Fx {
            kind: FxKind::Off,
            wet: Smoothed::new(0.0, sr, 30.0),
            feedback: 0.45,
            echo_samples: (sr * 0.5) as usize,
            delay,
            combs_l,
            combs_r,
            aps_l,
            aps_r,
        }
    }

    pub fn set_kind(&mut self, kind: FxKind) {
        if kind != self.kind {
            // Clear tails so switching effects doesn't bleed old audio.
            self.delay.clear();
            for c in self.combs_l.iter_mut() {
                c.clear();
            }
            for c in self.combs_r.iter_mut() {
                c.clear();
            }
            for a in self.aps_l.iter_mut() {
                a.clear();
            }
            for a in self.aps_r.iter_mut() {
                a.clear();
            }
            self.kind = kind;
        }
    }

    pub fn kind(&self) -> FxKind {
        self.kind
    }

    /// Set the target wet mix (0..1). The active flag gates it: `off` forces 0.
    pub fn set_wet(&mut self, wet: f32) {
        self.wet.set_target(wet.clamp(0.0, 1.0));
    }

    /// Set the echo time in samples (deck computes from beats × effective BPM).
    pub fn set_echo_samples(&mut self, samples: usize) {
        self.echo_samples = samples.clamp(1, self.delay.cap - 1);
    }

    /// Set echo feedback (0..0.95).
    pub fn set_feedback(&mut self, fb: f32) {
        self.feedback = fb.clamp(0.0, 0.95);
    }

    /// Process one stereo frame, returning the dry/wet-blended output.
    #[inline]
    pub fn process(&mut self, dry_l: f32, dry_r: f32) -> (f32, f32) {
        let wet = self.wet.next();
        if self.kind == FxKind::Off || wet <= 0.0001 {
            // Still advance the echo line a touch so re-enabling isn't stale?
            // No — keeping it frozen is fine; we cleared on switch.
            return (dry_l, dry_r);
        }
        let (wl, wr) = match self.kind {
            FxKind::Echo => {
                let (el, er) = self.delay.read(self.echo_samples);
                // Feed input + feedback back into the line.
                self.delay
                    .write(dry_l + el * self.feedback, dry_r + er * self.feedback);
                (el, er)
            }
            FxKind::Reverb => {
                let mut acc_l = 0.0f32;
                let mut acc_r = 0.0f32;
                for c in self.combs_l.iter_mut() {
                    acc_l += c.process(dry_l);
                }
                for c in self.combs_r.iter_mut() {
                    acc_r += c.process(dry_r);
                }
                acc_l *= 0.25;
                acc_r *= 0.25;
                for a in self.aps_l.iter_mut() {
                    acc_l = a.process(acc_l);
                }
                for a in self.aps_r.iter_mut() {
                    acc_r = a.process(acc_r);
                }
                (acc_l, acc_r)
            }
            FxKind::Off => (0.0, 0.0),
        };
        (dry_l * (1.0 - wet) + wl * wet, dry_r * (1.0 - wet) + wr * wet)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_is_passthrough() {
        let mut fx = Fx::new(48_000.0);
        let (l, r) = fx.process(0.5, -0.5);
        assert_eq!((l, r), (0.5, -0.5));
    }

    #[test]
    fn echo_is_finite_and_bounded() {
        let mut fx = Fx::new(48_000.0);
        fx.set_kind(FxKind::Echo);
        fx.set_echo_samples(1000);
        fx.set_wet(1.0);
        let mut out = 0.0f32;
        for i in 0..5000 {
            let x = if i < 10 { 1.0 } else { 0.0 };
            let (l, _r) = fx.process(x, x);
            assert!(l.is_finite());
            out = out.max(l.abs());
        }
        // Echo should produce some non-silent tail without blowing up.
        assert!(out <= 4.0, "echo runaway: {out}");
    }

    #[test]
    fn reverb_decays() {
        let mut fx = Fx::new(48_000.0);
        fx.set_kind(FxKind::Reverb);
        fx.set_wet(1.0);
        // Impulse in.
        let _ = fx.process(1.0, 1.0);
        let mut last = 1.0f32;
        for _ in 0..48_000 {
            let (l, _r) = fx.process(0.0, 0.0);
            assert!(l.is_finite());
            last = l.abs();
        }
        // After a full second the tail should be quiet.
        assert!(last < 0.5, "reverb did not decay: {last}");
    }
}
