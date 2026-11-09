//! Pitch detection (YIN), granular pitch shifting with WSOLA anchoring and LPC formant
//! preservation, plus the scale logic. Rust port of `server/src/audio/pitch-dsp.ts`
//! (same algorithm, same latency budget: ~2.7 ms detection + ~2.7 ms grain group delay).

use core::f32::consts::PI;

pub const GRAIN: usize = 256;
const HEADS: usize = 2;
const STAGGER: usize = GRAIN / HEADS;
const BUF: usize = GRAIN * 32; // 8192, power of two
const MASK: usize = BUF - 1;
const WSOLA_SEARCH: i32 = 200;
const WSOLA_CORR: usize = 64;
const LPC_ORDER: usize = 12;
const LPC_WIN: usize = 512;
const LPC_UPDATE: usize = 256;
const LPC_HIST: usize = LPC_ORDER + 1;
pub const YIN_WINDOW: usize = 1024;
const YIN_THRESHOLD: f32 = 0.18;
pub const MIN_FREQ: f32 = 70.0;
pub const MAX_FREQ: f32 = 1200.0;

/// Result of one detection step.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PitchInfo {
    /// Hz, 0 when unvoiced.
    pub frequency: f32,
    /// Fractional MIDI note (69 = A4), 0 when unvoiced.
    pub midi: f32,
    /// 0..1.
    pub confidence: f32,
    pub rms: f32,
}

impl PitchInfo {
    pub fn voiced(&self) -> bool {
        self.frequency > 0.0 && self.confidence > 0.05
    }
    /// Deviation from the nearest equal-tempered note in cents (-50..50).
    pub fn cents(&self) -> f32 {
        (self.midi - self.midi.round()) * 100.0
    }
}

// ─── YIN detector ───────────────────────────────────────────────────────────

/// Allocation-free YIN over the last `YIN_WINDOW` samples it was fed.
pub struct Yin {
    sr: f32,
    hist: Vec<f32>,
    w: usize,
    sig: Vec<f32>,
    diff: Vec<f32>,
    max_tau: usize,
    min_tau: usize,
}

impl Yin {
    pub fn new(sample_rate: f32) -> Self {
        let max_tau = ((sample_rate / MIN_FREQ) as usize).min(YIN_WINDOW - 64);
        Self {
            sr: sample_rate,
            hist: vec![0.0; YIN_WINDOW],
            w: 0,
            sig: vec![0.0; YIN_WINDOW],
            diff: vec![0.0; max_tau + 2],
            max_tau,
            min_tau: ((sample_rate / MAX_FREQ) as usize).max(2),
        }
    }

    #[inline]
    pub fn push(&mut self, x: f32) {
        self.hist[self.w] = x;
        self.w = (self.w + 1) % YIN_WINDOW;
    }

    pub fn reset(&mut self) {
        self.hist.fill(0.0);
        self.w = 0;
    }

    pub fn detect(&mut self) -> PitchInfo {
        for n in 0..YIN_WINDOW {
            self.sig[n] = self.hist[(self.w + n) % YIN_WINDOW];
        }
        let sig = &self.sig;
        let rms = (sig.iter().map(|x| x * x).sum::<f32>() / YIN_WINDOW as f32).sqrt();
        let unvoiced = PitchInfo {
            rms,
            ..Default::default()
        };
        if rms < 1e-5 {
            return unvoiced;
        }
        let max_tau = self.max_tau;
        let win = YIN_WINDOW - max_tau;
        let d = &mut self.diff;
        d[0] = 1.0;
        let mut running = 0.0f32;
        for tau in 1..=max_tau {
            let mut s = 0.0f32;
            for i in 0..win {
                let x = sig[i] - sig[i + tau];
                s += x * x;
            }
            running += s;
            d[tau] = if running > 0.0 {
                s * tau as f32 / running
            } else {
                1.0
            };
        }
        let mut est = None;
        let mut tau = self.min_tau;
        while tau <= max_tau {
            if d[tau] < YIN_THRESHOLD {
                while tau < max_tau && d[tau + 1] < d[tau] {
                    tau += 1;
                }
                est = Some(tau);
                break;
            }
            tau += 1;
        }
        let tau = match est {
            Some(t) => t,
            None => {
                let (bt, bv) = (self.min_tau..=max_tau).map(|t| (t, d[t])).fold(
                    (0, f32::INFINITY),
                    |acc, x| if x.1 < acc.1 { x } else { acc },
                );
                if bt == 0 || bv > 0.5 {
                    return unvoiced;
                }
                bt
            }
        };
        let s0 = d[tau - 1];
        let s1 = d[tau];
        let s2 = if tau < max_tau { d[tau + 1] } else { s1 };
        let den = s0 + s2 - 2.0 * s1;
        let refined = if den != 0.0 {
            tau as f32 + 0.5 * (s0 - s2) / den
        } else {
            tau as f32
        };
        let f = self.sr / refined;
        if !(MIN_FREQ..=MAX_FREQ).contains(&f) {
            return unvoiced;
        }
        PitchInfo {
            frequency: f,
            midi: 12.0 * (f / 440.0).log2() + 69.0,
            confidence: (1.0 - s1).clamp(0.0, 1.0),
            rms,
        }
    }
}

// ─── Scales ─────────────────────────────────────────────────────────────────

pub const KEY_NAMES: &[&str] = &[
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];
pub const SCALE_NAMES: &[&str] = &[
    "chromatic",
    "major",
    "minor",
    "harmonic_minor",
    "melodic_minor",
    "pentatonic_major",
    "pentatonic_minor",
    "blues",
    "dorian",
    "phrygian",
    "lydian",
    "mixolydian",
    "phrygian_dominant",
];

/// Semitone sets per `SCALE_NAMES` entry, as 12-bit masks (bit 0 = root).
const SCALE_MASKS: [u16; 13] = [
    0b1111_1111_1111,
    mask(&[0, 2, 4, 5, 7, 9, 11]),
    mask(&[0, 2, 3, 5, 7, 8, 10]),
    mask(&[0, 2, 3, 5, 7, 8, 11]),
    mask(&[0, 2, 3, 5, 7, 9, 11]),
    mask(&[0, 2, 4, 7, 9]),
    mask(&[0, 3, 5, 7, 10]),
    mask(&[0, 3, 5, 6, 7, 10]),
    mask(&[0, 2, 3, 5, 7, 9, 10]),
    mask(&[0, 1, 3, 5, 7, 8, 10]),
    mask(&[0, 2, 4, 6, 7, 9, 11]),
    mask(&[0, 2, 4, 5, 7, 9, 10]),
    mask(&[0, 1, 4, 5, 7, 8, 10]),
];

const fn mask(iv: &[u8]) -> u16 {
    let mut m = 0u16;
    let mut i = 0;
    while i < iv.len() {
        m |= 1 << iv[i];
        i += 1;
    }
    m
}

/// Absolute pitch-class set (bit n = pitch class n, C = 0).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Scale(pub u16);

impl Scale {
    pub fn new(key: usize, scale: usize) -> Self {
        let m = SCALE_MASKS[scale.min(SCALE_MASKS.len() - 1)] as u32;
        let k = (key % 12) as u32;
        let rot = ((m << k) | (m >> (12 - k))) & 0xFFF;
        Self(rot as u16)
    }

    pub fn contains(&self, midi: i32) -> bool {
        self.0 & (1 << midi.rem_euclid(12)) != 0
    }

    /// Nearest in-scale note to a fractional MIDI pitch (ties go up).
    pub fn nearest(&self, exact: f32) -> i32 {
        let base = exact.round() as i32;
        let mut best = base;
        let mut best_d = f32::INFINITY;
        for off in -6..=6 {
            let c = base + off;
            if !self.contains(c) {
                continue;
            }
            let d = (c as f32 - exact).abs();
            if d < best_d - 0.01 || ((d - best_d).abs() <= 0.01 && c > best) {
                best = c;
                best_d = d;
            }
        }
        best
    }

    /// Move `steps` scale degrees from an in-scale note (harmonies: +2 = third above).
    pub fn degree_offset(&self, from: i32, steps: i32) -> i32 {
        let mut n = from;
        let mut left = steps.abs();
        let dir = steps.signum();
        let mut guard = 0;
        while left > 0 && guard < 48 {
            n += dir;
            guard += 1;
            if self.contains(n) {
                left -= 1;
            }
        }
        n
    }
}

// ─── Granular shifter ───────────────────────────────────────────────────────

/// Two-head granular pitch shifter (Hann² grains, WSOLA-anchored restarts) with optional
/// LPC formant preservation. Mono, allocation-free after `new`.
pub struct Shifter {
    buf: Vec<f32>,
    w: usize,
    phase: [usize; HEADS],
    read: [f32; HEADS],
    ratio: [f32; HEADS],
    target: f32,
    env: Vec<f32>,
    wsola_ref: [f32; WSOLA_CORR],
    lpc: Option<Lpc>,
}

struct Lpc {
    input: Vec<f32>,
    input_w: usize,
    inv_hist: [f32; LPC_HIST],
    inv_w: usize,
    syn_hist: [f32; LPC_HIST],
    syn_w: usize,
    a: [f32; LPC_HIST],
    delta: [f32; LPC_HIST],
    interp_left: usize,
    since_update: usize,
    ready: bool,
    window: Vec<f32>,
    win_fn: Vec<f32>,
}

impl Lpc {
    fn new() -> Self {
        let win_fn = (0..LPC_WIN)
            .map(|n| 0.54 - 0.46 * (2.0 * PI * n as f32 / (LPC_WIN - 1) as f32).cos())
            .collect();
        let mut a = [0.0; LPC_HIST];
        a[0] = 1.0;
        Self {
            input: vec![0.0; LPC_WIN],
            input_w: 0,
            inv_hist: [0.0; LPC_HIST],
            inv_w: 0,
            syn_hist: [0.0; LPC_HIST],
            syn_w: 0,
            a,
            delta: [0.0; LPC_HIST],
            interp_left: 0,
            since_update: LPC_UPDATE,
            ready: false,
            window: vec![0.0; LPC_WIN],
            win_fn,
        }
    }

    fn compute(&mut self) {
        for n in 0..LPC_WIN {
            self.window[n] = self.input[(self.input_w + n) % LPC_WIN] * self.win_fn[n];
        }
        let mut r = [0.0f32; LPC_HIST];
        for (k, rk) in r.iter_mut().enumerate() {
            *rk = (0..LPC_WIN - k)
                .map(|n| self.window[n] * self.window[n + k])
                .sum();
        }
        if r[0] < 1e-10 {
            return;
        }
        let mut a = [0.0f32; LPC_HIST];
        a[0] = 1.0;
        let mut e = r[0];
        for i in 1..=LPC_ORDER {
            let mut acc = r[i];
            for j in 1..i {
                acc += a[j] * r[i - j];
            }
            let k = -acc / e;
            if k.abs() >= 0.999 {
                return;
            }
            let prev = a;
            a[i] = k;
            for j in 1..i {
                a[j] = prev[j] + k * prev[i - j];
            }
            e *= 1.0 - k * k;
            if e < 1e-12 {
                break;
            }
        }
        for k in 0..LPC_HIST {
            self.delta[k] = (a[k] - self.a[k]) / LPC_UPDATE as f32;
        }
        self.interp_left = LPC_UPDATE;
        self.ready = true;
    }

    /// Whitening (inverse filter): removes the vocal-tract envelope before shifting.
    #[inline]
    fn whiten(&mut self, x: f32) -> f32 {
        self.input[self.input_w] = x;
        self.input_w = (self.input_w + 1) % LPC_WIN;
        if !self.ready {
            return x;
        }
        if self.interp_left > 0 {
            for k in 1..=LPC_ORDER {
                self.a[k] += self.delta[k];
            }
            self.interp_left -= 1;
        }
        let mut r = x;
        for k in 1..=LPC_ORDER {
            r += self.a[k] * self.inv_hist[(self.inv_w + LPC_HIST - k) % LPC_HIST];
        }
        self.inv_hist[self.inv_w] = x;
        self.inv_w = (self.inv_w + 1) % LPC_HIST;
        r
    }

    /// Synthesis: re-applies the ORIGINAL envelope to the shifted excitation.
    #[inline]
    fn color(&mut self, x: f32) -> f32 {
        if !self.ready {
            return x;
        }
        let mut y = x;
        for k in 1..=LPC_ORDER {
            y -= self.a[k] * self.syn_hist[(self.syn_w + LPC_HIST - k) % LPC_HIST];
        }
        let ay = y.abs();
        if ay > 3.0 {
            y = y.signum() * (3.0 + (1.0 - 1.0 / (1.0 + (ay - 3.0) * 0.5)));
        }
        self.syn_hist[self.syn_w] = y;
        self.syn_w = (self.syn_w + 1) % LPC_HIST;
        y
    }
}

impl Shifter {
    pub fn new(formant: bool) -> Self {
        let env = (0..GRAIN)
            .map(|p| {
                let s = (PI * p as f32 / GRAIN as f32).sin();
                s * s
            })
            .collect();
        let mut s = Self {
            buf: vec![0.0; BUF],
            w: 0,
            phase: [0; HEADS],
            read: [0.0; HEADS],
            ratio: [1.0; HEADS],
            target: 1.0,
            env,
            wsola_ref: [0.0; WSOLA_CORR],
            lpc: if formant { Some(Lpc::new()) } else { None },
        };
        s.reset();
        s
    }

    pub fn set_formant(&mut self, on: bool) {
        if on && self.lpc.is_none() {
            // Allocation outside the audio thread: callers toggle formant from the control path.
            self.lpc = Some(Lpc::new());
        } else if !on {
            self.lpc = None;
        }
    }

    pub fn formant(&self) -> bool {
        self.lpc.is_some()
    }

    #[inline]
    pub fn set_ratio(&mut self, r: f32) {
        self.target = r.clamp(0.25, 4.0);
    }

    pub fn ratio(&self) -> f32 {
        self.ratio.iter().sum::<f32>() / HEADS as f32
    }

    pub fn reset(&mut self) {
        self.buf.fill(0.0);
        self.w = 0;
        for k in 0..HEADS {
            self.phase[k] = (STAGGER * k) % GRAIN;
            self.read[k] = ((BUF - GRAIN + STAGGER * k) % BUF) as f32;
            self.ratio[k] = 1.0;
        }
        if let Some(l) = self.lpc.as_mut() {
            *l = Lpc::new();
        }
    }

    #[inline]
    fn at(&self, idx: f32) -> f32 {
        let i = idx.rem_euclid(BUF as f32);
        let i0 = i as usize & MASK;
        let i1 = (i0 + 1) & MASK;
        let f = i - i.floor();
        self.buf[i0] + f * (self.buf[i1] - self.buf[i0])
    }

    fn wsola(&mut self, nominal: f32, other_read: f32, other_r: f32, new_r: f32) -> f32 {
        let mut ref_e = 0.0;
        for j in 0..WSOLA_CORR {
            let v = self.at(other_read + j as f32 * other_r);
            self.wsola_ref[j] = v;
            ref_e += v * v;
        }
        if ref_e < 1e-9 {
            return nominal;
        }
        let mut best = f32::NEG_INFINITY;
        let mut best_off = 0;
        // Coarse search every 2 samples then refine ±1: same result, half the cost.
        let mut off = -WSOLA_SEARCH;
        while off <= WSOLA_SEARCH {
            let score = self.corr(nominal + off as f32, new_r, ref_e);
            if score > best {
                best = score;
                best_off = off;
            }
            off += 2;
        }
        for o in [best_off - 1, best_off + 1] {
            let score = self.corr(nominal + o as f32, new_r, ref_e);
            if score > best {
                best = score;
                best_off = o;
            }
        }
        nominal + best_off as f32
    }

    #[inline]
    fn corr(&self, start: f32, r: f32, ref_e: f32) -> f32 {
        let mut dot = 0.0;
        let mut e = 0.0;
        for j in 0..WSOLA_CORR {
            let v = self.at(start + j as f32 * r);
            dot += v * self.wsola_ref[j];
            e += v * v;
        }
        if e < 1e-9 {
            f32::NEG_INFINITY
        } else {
            dot / (e * ref_e).sqrt()
        }
    }

    /// Recompute LPC when due. Call once per control quantum before `tick`s.
    pub fn control(&mut self, block: usize) {
        if let Some(l) = self.lpc.as_mut() {
            if l.since_update >= LPC_UPDATE {
                l.compute();
                l.since_update = 0;
            }
            l.since_update += block;
        }
    }

    #[inline]
    pub fn tick(&mut self, x: f32) -> f32 {
        let to_shift = match self.lpc.as_mut() {
            Some(l) => l.whiten(x),
            None => x,
        };
        self.buf[self.w] = to_shift;
        self.w = (self.w + 1) & MASK;
        let mut wet = 0.0;
        for k in 0..HEADS {
            let env = self.env[self.phase[k]];
            if env > 0.0 {
                wet += self.at(self.read[k]) * env;
            }
            self.phase[k] += 1;
            self.read[k] += self.ratio[k];
            if self.phase[k] >= GRAIN {
                self.phase[k] = 0;
                let nr = self.target;
                self.ratio[k] = nr;
                let lag = GRAIN as f32 * nr.max(1.0);
                let nominal = self.w as f32 - lag;
                let o = (k + 1) % HEADS;
                let anchored = self.wsola(nominal, self.read[o], self.ratio[o], nr);
                self.read[k] = anchored.rem_euclid(BUF as f32);
            } else if self.read[k] >= BUF as f32 {
                self.read[k] -= BUF as f32;
            }
        }
        match self.lpc.as_mut() {
            Some(l) => l.color(wet),
            None => wet,
        }
    }

    /// Algorithmic latency in samples (grain group delay).
    pub const fn latency() -> usize {
        GRAIN
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::sine;

    #[test]
    fn yin_detects_a4() {
        let mut y = Yin::new(48000.0);
        for x in sine(440.0, 48000.0, 2048, 0.5) {
            y.push(x);
        }
        let p = y.detect();
        assert!((p.frequency - 440.0).abs() < 2.0, "{p:?}");
        assert!((p.midi - 69.0).abs() < 0.05);
    }

    #[test]
    fn scale_nearest_and_degrees() {
        let c_major = Scale::new(0, 1);
        assert_eq!(c_major.nearest(61.4), 62); // C#+40c -> D
        assert_eq!(c_major.nearest(60.6), 60); // C+60c -> C (C# not in scale; D is 1.4 away)
        assert_eq!(c_major.degree_offset(60, 2), 64); // third above C = E
        assert_eq!(c_major.degree_offset(64, 2), 67); // third above E = G
        let a_minor = Scale::new(9, 2);
        assert!(a_minor.contains(60) && !a_minor.contains(61));
    }

    #[test]
    fn shifter_shifts_up_an_octave() {
        let mut s = Shifter::new(false);
        s.set_ratio(2.0);
        let input = sine(220.0, 48000.0, 48000, 0.5);
        let mut out = vec![0.0f32; input.len()];
        for (i, x) in input.iter().enumerate() {
            out[i] = s.tick(*x);
        }
        let mut y = Yin::new(48000.0);
        for x in &out[40000..42048] {
            y.push(*x);
        }
        let p = y.detect();
        assert!((p.frequency - 440.0).abs() < 8.0, "{p:?}");
    }
}
