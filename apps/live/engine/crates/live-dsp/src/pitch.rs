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
/// White-noise correction of the LPC analysis: `r[0] *= 1 + LPC_NOISE`. Without it an order-12
/// model at 48 kHz fits the 50 dB spectral tilt of a voice (measured prediction gain 48 dB), and
/// the synthesis filter then amplifies any mismatch in the shifted excitation by as much.
/// Measured on the voice fixture (220 / 523 Hz, ratios 0.94–1.03): 0 → the guard plays the plain
/// output 91–100 % of the time at 220 Hz; 1e-3 → 0 guard trips, output within −2.0…+1.4 dB.
const LPC_NOISE: f32 = 1e-3;
/// Formant guard: when the coloured output carries more than this many times the energy of the
/// plain (formant-off) output, the all-pole filter is running away and the plain output plays
/// until it recovers.
const GUARD_RATIO: f32 = 4.0;
/// The guard lets the coloured output back in once it is under this multiple of the plain energy.
const GUARD_RELEASE: f32 = 2.0;
/// After a trip the plain output plays for at least this long (50 ms at 48 kHz): a model that is
/// wrong for a whole passage must not switch in and out several times per second.
const GUARD_HOLD: u32 = 2400;
/// Energies are compared above this fraction of the squared recent plain peak (−60 dB): in the
/// gap after a phrase the filter's ring-out must not count as a runaway.
const GUARD_FLOOR: f32 = 1e-6;
/// Energy followers of the guard (~10 ms at 48 kHz).
const GUARD_COEF: f32 = 0.002;
/// Crossfade between coloured and plain output when the guard trips or releases (~5 ms).
const GUARD_FADE: f32 = 0.004;
/// The formant path may not exceed the recent plain-output peak by more than this factor (6 dB).
const GUARD_CEIL: f32 = 2.0;
/// Per-sample decay of the peak follower (half-life ~36 ms at 48 kHz).
const GUARD_PEAK_DECAY: f32 = 0.9996;
/// Samples of whitened audio needed before colouring starts: more than the oldest sample a head
/// can read (4 × GRAIN + WSOLA_SEARCH at the largest ratio), so the colour filter never sees
/// audio that was written before the model existed.
const GUARD_WARMUP: u32 = 2048;
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
    /// Formant on only: unwhitened copy of the input, read at the same grain positions as `buf`.
    /// It is the formant-off output: the guard's level reference and its fallback.
    raw: Vec<f32>,
    w: usize,
    phase: [usize; HEADS],
    read: [f32; HEADS],
    ratio: [f32; HEADS],
    target: f32,
    env: Vec<f32>,
    wsola_ref: [f32; WSOLA_CORR],
    lpc: Lpc,
    formant: bool,
    /// Guard state: smoothed energy of the plain / of the coloured output, peak of the plain
    /// output, how much of the coloured signal is let through (1 = all, 0 = plain fallback) and
    /// how many whitened samples the grain buffer holds since the model became ready.
    plain_e: f32,
    out_e: f32,
    plain_pk: f32,
    trust: f32,
    tripped: bool,
    hold: u32,
    guard_trips: u32,
    warm: u32,
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
    /// `LPC_NOISE`; a field only so a test can switch it off and prove the guard holds.
    noise: f32,
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
            noise: LPC_NOISE,
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
        r[0] *= 1.0 + self.noise;
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

    /// Synthesis: re-applies the ORIGINAL envelope to the shifted excitation. `ceil` bounds the
    /// output and therefore the filter memory, so a mismatched model cannot ring without limit.
    #[inline]
    fn color(&mut self, x: f32, ceil: f32) -> f32 {
        if !self.ready {
            return x;
        }
        let mut y = x;
        for k in 1..=LPC_ORDER {
            y -= self.a[k] * self.syn_hist[(self.syn_w + LPC_HIST - k) % LPC_HIST];
        }
        y = if y.is_finite() {
            y.clamp(-ceil, ceil)
        } else {
            0.0
        };
        self.syn_hist[self.syn_w] = y;
        self.syn_w = (self.syn_w + 1) % LPC_HIST;
        y
    }

    /// Back to the just-built state without touching the heap (safe on the audio thread).
    fn clear(&mut self) {
        self.input.fill(0.0);
        self.input_w = 0;
        self.inv_hist = [0.0; LPC_HIST];
        self.inv_w = 0;
        self.syn_hist = [0.0; LPC_HIST];
        self.syn_w = 0;
        self.a = [0.0; LPC_HIST];
        self.a[0] = 1.0;
        self.delta = [0.0; LPC_HIST];
        self.interp_left = 0;
        self.since_update = LPC_UPDATE;
        self.ready = false;
        self.window.fill(0.0);
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
            raw: vec![0.0; BUF],
            w: 0,
            phase: [0; HEADS],
            read: [0.0; HEADS],
            ratio: [1.0; HEADS],
            target: 1.0,
            env,
            wsola_ref: [0.0; WSOLA_CORR],
            // Always built, so switching formant on or off never allocates or frees.
            lpc: Lpc::new(),
            formant,
            plain_e: 0.0,
            out_e: 0.0,
            plain_pk: 0.0,
            trust: 0.0,
            tripped: false,
            hold: 0,
            guard_trips: 0,
            warm: 0,
        };
        s.reset();
        s
    }

    /// Formant preservation on or off. Allocation-free: callable from the audio thread.
    pub fn set_formant(&mut self, on: bool) {
        if on == self.formant {
            return;
        }
        // Keep the grain buffer continuous in both directions: off → on starts from the plain
        // history, on → off must not leave whitened (near-silent) audio under the read heads.
        if on {
            self.raw.copy_from_slice(&self.buf);
        } else {
            self.buf.copy_from_slice(&self.raw);
        }
        self.formant = on;
        self.lpc.clear();
        self.clear_guard();
    }

    pub fn formant(&self) -> bool {
        self.formant
    }

    /// How many times the formant guard had to fall back since the last reset (telemetry, tests).
    pub fn guard_trips(&self) -> u32 {
        self.guard_trips
    }

    fn clear_guard(&mut self) {
        self.plain_e = 0.0;
        self.out_e = 0.0;
        self.plain_pk = 0.0;
        self.trust = 0.0;
        self.tripped = false;
        self.hold = 0;
        self.warm = 0;
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
        self.raw.fill(0.0);
        self.w = 0;
        for k in 0..HEADS {
            self.phase[k] = (STAGGER * k) % GRAIN;
            self.read[k] = ((BUF - GRAIN + STAGGER * k) % BUF) as f32;
            self.ratio[k] = 1.0;
        }
        self.lpc.clear();
        self.clear_guard();
        self.guard_trips = 0;
    }

    #[inline]
    fn at(&self, idx: f32) -> f32 {
        let i = idx.rem_euclid(BUF as f32);
        let i0 = i as usize & MASK;
        let i1 = (i0 + 1) & MASK;
        let f = i - i.floor();
        self.buf[i0] + f * (self.buf[i1] - self.buf[i0])
    }

    /// `at` on both buffers: (whitened, plain).
    #[inline]
    fn at_both(&self, idx: f32) -> (f32, f32) {
        let i = idx.rem_euclid(BUF as f32);
        let i0 = i as usize & MASK;
        let i1 = (i0 + 1) & MASK;
        let f = i - i.floor();
        (
            self.buf[i0] + f * (self.buf[i1] - self.buf[i0]),
            self.raw[i0] + f * (self.raw[i1] - self.raw[i0]),
        )
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
        if !self.formant {
            return;
        }
        let l = &mut self.lpc;
        if l.since_update >= LPC_UPDATE {
            l.compute();
            l.since_update = 0;
        }
        l.since_update += block;
    }

    #[inline]
    pub fn tick(&mut self, x: f32) -> f32 {
        // One NaN in the energy followers below would switch the guard off until the next reset.
        let x = if x.is_finite() { x } else { 0.0 };
        let formant = self.formant;
        if formant {
            self.raw[self.w] = x;
            self.buf[self.w] = self.lpc.whiten(x);
        } else {
            self.buf[self.w] = x;
        }
        self.w = (self.w + 1) & MASK;
        let (mut wet, mut plain) = (0.0, 0.0);
        for k in 0..HEADS {
            let env = self.env[self.phase[k]];
            if env > 0.0 {
                if formant {
                    let (a, b) = self.at_both(self.read[k]);
                    wet += a * env;
                    plain += b * env;
                } else {
                    wet += self.at(self.read[k]) * env;
                }
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
        if !formant {
            return wet;
        }
        // `plain` is what formant-off would output right now (same grains, unwhitened): a convex
        // mix of input samples, so it can never exceed the input peak. It is the reference for
        // both bounds below and the fallback.
        self.plain_pk = (self.plain_pk * GUARD_PEAK_DECAY).max(plain.abs());
        self.plain_e += GUARD_COEF * (plain * plain - self.plain_e);
        // Until every sample under the read heads was whitened by a model, colouring would
        // amplify plain audio by the model's whole gain (30–50 dB).
        if !self.lpc.ready {
            self.warm = 0;
            return plain;
        }
        if self.warm < GUARD_WARMUP {
            self.warm += 1;
            return plain;
        }
        // Colouring puts the vocal-tract envelope back on the shifted excitation. The filter is
        // all-pole: fed something its model does not match it can ring far above the input
        // (measured: +15 dB, pinned on the limiter). Two bounds:
        //  * a ceiling of GUARD_CEIL × the recent plain peak, on the filter memory and the output;
        //  * an energy guard: while the coloured output is implausibly loud, the plain output
        //    plays instead. The whitening model is left alone (dropping it would put unwhitened
        //    audio under the heads and trip again).
        let ceil = GUARD_CEIL * self.plain_pk + 1e-4;
        let colored = self.lpc.color(wet, ceil);
        self.out_e += GUARD_COEF * (colored * colored - self.out_e);
        let floor = GUARD_FLOOR * self.plain_pk * self.plain_pk + 1e-12;
        if self.tripped {
            self.hold = self.hold.saturating_sub(1);
            if self.hold == 0 && self.out_e <= GUARD_RELEASE * self.plain_e + floor {
                self.tripped = false;
            }
        } else if self.out_e > GUARD_RATIO * self.plain_e + floor {
            self.tripped = true;
            self.hold = GUARD_HOLD;
            self.guard_trips = self.guard_trips.saturating_add(1);
            self.lpc.syn_hist = [0.0; LPC_HIST];
        }
        let goal = if self.tripped { 0.0 } else { 1.0 };
        self.trust += GUARD_FADE * (goal - self.trust);
        (plain + self.trust * (colored - plain)).clamp(-ceil, ceil)
    }

    /// Algorithmic latency in samples (grain group delay).
    pub const fn latency() -> usize {
        GRAIN
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{rms, sine, voice};

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

    /// The formant path must never be much louder than what went in. On this voice-like signal
    /// (jittered pulse train through formant resonators, ±40 cent vibrato) it used to come out
    /// 13–15 dB hotter and sit on the limiter.
    #[test]
    fn formant_path_stays_near_the_input_level() {
        for f0 in [220.0, 440.0, 523.25] {
            let x = voice(f0, 40.0, 48000.0, 3 * 48000, 0.25);
            for ratio in [1.0f32, 1.02, 0.98, 1.06, 0.94] {
                let mut s = Shifter::new(true);
                s.set_ratio(ratio);
                let mut y = vec![0.0f32; x.len()];
                for (i, v) in x.iter().enumerate() {
                    if i % 128 == 0 {
                        s.control(128);
                    }
                    y[i] = s.tick(*v);
                }
                assert!(y.iter().all(|v| v.is_finite()));
                // Never more than 6 dB over the input peak (0.25), at any sample.
                let peak = y.iter().fold(0.0f32, |m, v| m.max(v.abs()));
                assert!(peak <= 0.51, "f0 {f0} ratio {ratio}: peak {peak}");
                // A bounded level alone does not prove the formant filter works: if the guard
                // had to step in, "formant on" would be the plain output in disguise.
                assert_eq!(s.guard_trips(), 0, "f0 {f0} ratio {ratio}: guard tripped");
                // ...and the coloured path must really be the one playing (model ready, warm-up
                // over, fade-in done), or the checks above would pass on the plain output.
                assert!(
                    s.lpc.ready && s.trust > 0.99,
                    "f0 {f0} ratio {ratio}: formant idle"
                );
                // 100 ms windows after the first half second: none may exceed the input by 6 dB.
                for (k, (wi, wo)) in x[24000..]
                    .chunks(4800)
                    .zip(y[24000..].chunks(4800))
                    .enumerate()
                {
                    let gain_db = 20.0 * (rms(wo) / rms(wi).max(1e-9)).log10();
                    assert!(
                        gain_db < 6.0,
                        "f0 {f0} ratio {ratio} window {k}: {gain_db:.1} dB over the input"
                    );
                }
            }
        }
    }

    #[test]
    fn formant_toggle_and_reset_do_not_allocate() {
        let mut s = Shifter::new(false);
        let x = sine(220.0, 48000.0, 2048, 0.3);
        assert_no_alloc::assert_no_alloc(|| {
            for round in 0..4 {
                s.set_formant(round % 2 == 0);
                for (i, v) in x.iter().enumerate() {
                    if i % 128 == 0 {
                        s.control(128);
                    }
                    let _ = s.tick(*v);
                }
                s.reset();
            }
        });
    }

    /// The safety net itself: with the white-noise correction off, the model over-fits (the
    /// case that used to come out +15 dB). The guard must then play the plain output, at the
    /// input level, instead of the runaway filter.
    #[test]
    fn guard_plays_the_plain_output_when_the_model_runs_away() {
        let x = voice(220.0, 40.0, 48000.0, 2 * 48000, 0.25);
        let mut s = Shifter::new(true);
        s.lpc.noise = 0.0;
        s.set_ratio(1.03);
        let (mut ex, mut ey) = (0.0f64, 0.0f64);
        let (mut fallback, mut total) = (0usize, 0usize);
        let mut peak = 0.0f32;
        for (i, v) in x.iter().enumerate() {
            if i % 128 == 0 {
                s.control(128);
            }
            let y = s.tick(*v);
            assert!(y.is_finite());
            peak = peak.max(y.abs());
            if i >= 24000 {
                ex += (*v as f64).powi(2);
                ey += (y as f64).powi(2);
                total += 1;
                if s.trust < 0.5 {
                    fallback += 1;
                }
            }
        }
        let gain_db = 10.0 * (ey / ex).log10();
        assert!(s.guard_trips() >= 1, "the over-fitted model should trip");
        // 50 ms hold: at most 20 trips per second, and far fewer in practice.
        assert!(
            s.guard_trips() <= 40,
            "guard chatters: {} trips",
            s.guard_trips()
        );
        assert!(fallback * 2 > total, "plain share {fallback}/{total}");
        assert!(gain_db.abs() < 1.5, "{gain_db} dB against the input");
        assert!(peak <= 0.51, "peak {peak}");
    }

    /// Phrases with silence between them, and one non-finite sample.
    ///
    /// Known limit of the formant path, measured here: at the attack of a phrase that follows
    /// silence the coloured output can overshoot (the model changes faster than the grain lag),
    /// and the guard then plays the plain output for its 50 ms hold. So the guard may step in
    /// once per phrase, in its first 2048 samples, and nowhere else: never while the input is
    /// silent (the filter's ring-out is not a runaway) and never in the body of a phrase.
    /// The bad sample must not disable it.
    #[test]
    fn guard_steps_in_only_at_phrase_attacks_and_survives_a_bad_sample() {
        const PHRASE: usize = 24000;
        const CYCLE: usize = 36000;
        let phrase = voice(220.0, 40.0, 48000.0, 24000, 0.25);
        let mut x = Vec::new();
        for _ in 0..4 {
            x.extend_from_slice(&phrase);
            x.extend(core::iter::repeat_n(0.0f32, CYCLE - PHRASE));
        }
        x[30000] = f32::NAN; // in the first gap
        let mut s = Shifter::new(true);
        s.set_ratio(1.03);
        let mut trips: Vec<usize> = Vec::new();
        for (i, v) in x.iter().enumerate() {
            if i % 128 == 0 {
                s.control(128);
            }
            let before = s.guard_trips();
            let y = s.tick(*v);
            assert!(y.is_finite() && y.abs() <= 0.51, "sample {i}: {y}");
            if s.guard_trips() != before {
                trips.push(i);
            }
        }
        for i in &trips {
            assert!(
                i % CYCLE < 2048,
                "trip at sample {i} (position {} in the phrase + gap cycle): not an attack",
                i % CYCLE
            );
        }
        let mut per_phrase = [0u32; 4];
        for i in &trips {
            per_phrase[i / CYCLE] += 1;
        }
        assert!(per_phrase.iter().all(|n| *n <= 1), "{per_phrase:?}");
        assert!(s.plain_e.is_finite() && s.out_e.is_finite());
    }
}
