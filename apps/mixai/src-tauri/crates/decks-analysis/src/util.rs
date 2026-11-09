//! Small DSP building blocks shared by the offline and streaming paths.
//!
//! Everything here allocates only in its constructor; the per-sample / per-frame methods are
//! allocation-free so the streaming analyser can run them on a live input thread.

use std::f64::consts::PI;
use std::sync::Arc;

use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};

/// Sliding analysis window over a sample stream (double-written ring, so the current frame is
/// always one contiguous slice, oldest sample first).
pub(crate) struct FrameRing {
    buf: Vec<f32>,
    len: usize,
    pos: usize,
    hop: usize,
    since_hop: usize,
}

impl FrameRing {
    pub(crate) fn new(len: usize, hop: usize) -> Self {
        Self {
            buf: vec![0.0; 2 * len],
            len,
            pos: 0,
            hop: hop.max(1),
            since_hop: 0,
        }
    }

    /// Push one sample; `true` when a hop boundary was reached and [`Self::frame`] is new.
    ///
    /// Frame `i` (0-based) ends at sample `(i + 1) * hop`; samples before the stream start are 0.
    #[inline]
    pub(crate) fn push(&mut self, x: f32) -> bool {
        self.buf[self.pos] = x;
        self.buf[self.pos + self.len] = x;
        self.pos += 1;
        if self.pos == self.len {
            self.pos = 0;
        }
        self.since_hop += 1;
        if self.since_hop >= self.hop {
            self.since_hop = 0;
            true
        } else {
            false
        }
    }

    #[inline]
    pub(crate) fn frame(&self) -> &[f32] {
        &self.buf[self.pos..self.pos + self.len]
    }

    pub(crate) fn reset(&mut self) {
        self.buf.fill(0.0);
        self.pos = 0;
        self.since_hop = 0;
    }
}

/// Hann-windowed real FFT returning magnitudes normalised so a full-scale sine reads ~1.0.
pub(crate) struct Spectrum {
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    input: Vec<f32>,
    output: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    mag: Vec<f32>,
    norm: f32,
}

impl Spectrum {
    pub(crate) fn new(n: usize) -> Self {
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(n);
        let window: Vec<f32> = (0..n)
            .map(|i| (0.5 - 0.5 * (2.0 * PI * i as f64 / n as f64).cos()) as f32)
            .collect();
        let wsum: f32 = window.iter().sum();
        Self {
            input: fft.make_input_vec(),
            output: fft.make_output_vec(),
            scratch: fft.make_scratch_vec(),
            mag: vec![0.0; n / 2 + 1],
            norm: 2.0 / wsum,
            window,
            fft,
        }
    }

    /// Magnitude spectrum (`n / 2 + 1` bins) of `frame` (length `n`). Allocation-free.
    pub(crate) fn magnitudes(&mut self, frame: &[f32]) -> &[f32] {
        for ((d, &s), &w) in self.input.iter_mut().zip(frame).zip(&self.window) {
            *d = s * w;
        }
        // Lengths are fixed by construction, so this cannot fail.
        let res =
            self.fft
                .process_with_scratch(&mut self.input, &mut self.output, &mut self.scratch);
        debug_assert!(res.is_ok());
        for (m, c) in self.mag.iter_mut().zip(&self.output) {
            *m = c.norm() * self.norm;
        }
        &self.mag
    }
}

/// Transposed direct-form II biquad with f64 state (low-frequency filters stay stable).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    /// From un-normalised coefficients `b`, `a` (a[0] is divided out).
    pub(crate) fn new(b: [f64; 3], a: [f64; 3]) -> Self {
        Self {
            b0: b[0] / a[0],
            b1: b[1] / a[0],
            b2: b[2] / a[0],
            a1: a[1] / a[0],
            a2: a[2] / a[0],
            z1: 0.0,
            z2: 0.0,
        }
    }

    /// RBJ cookbook low-pass.
    pub(crate) fn lowpass(sr: f64, f: f64, q: f64) -> Self {
        let w0 = 2.0 * PI * f / sr;
        let (s, c) = w0.sin_cos();
        let alpha = s / (2.0 * q);
        Self::new(
            [(1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0],
            [1.0 + alpha, -2.0 * c, 1.0 - alpha],
        )
    }

    /// RBJ cookbook high-pass.
    pub(crate) fn highpass(sr: f64, f: f64, q: f64) -> Self {
        let w0 = 2.0 * PI * f / sr;
        let (s, c) = w0.sin_cos();
        let alpha = s / (2.0 * q);
        Self::new(
            [(1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0],
            [1.0 + alpha, -2.0 * c, 1.0 - alpha],
        )
    }

    #[inline]
    pub(crate) fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    pub(crate) fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }

    #[cfg(test)]
    pub(crate) fn b0_for_test(&self) -> f64 {
        self.b0
    }

    #[cfg(test)]
    pub(crate) fn a1_for_test(&self) -> f64 {
        self.a1
    }

    #[cfg(test)]
    pub(crate) fn a2_for_test(&self) -> f64 {
        self.a2
    }
}

/// Run `x` through two cascaded biquads.
#[inline]
pub(crate) fn cascade2(f: &mut [Biquad; 2], x: f64) -> f64 {
    let y = f[0].process(x);
    f[1].process(y)
}

/// Streaming integer-factor decimator (Blackman-windowed sinc low-pass, polyphase output).
pub(crate) struct Decimator {
    taps: Vec<f32>,
    hist: Vec<f32>,
    pos: usize,
    factor: usize,
    phase: usize,
}

impl Decimator {
    pub(crate) fn new(factor: usize) -> Self {
        let factor = factor.max(1);
        let taps = if factor == 1 {
            vec![1.0]
        } else {
            let len = 16 * factor + 1;
            let mid = (len / 2) as f64;
            let fc = 0.45 / factor as f64; // cycles per input sample
            let mut t: Vec<f64> = (0..len)
                .map(|i| {
                    let x = i as f64 - mid;
                    let sinc = if x == 0.0 {
                        2.0 * fc
                    } else {
                        (2.0 * PI * fc * x).sin() / (PI * x)
                    };
                    let r = i as f64 / (len - 1) as f64;
                    let w = 0.42 - 0.5 * (2.0 * PI * r).cos() + 0.08 * (4.0 * PI * r).cos();
                    sinc * w
                })
                .collect();
            let sum: f64 = t.iter().sum();
            t.iter_mut().for_each(|v| *v /= sum);
            t.into_iter().map(|v| v as f32).collect()
        };
        let len = taps.len();
        Self {
            taps,
            hist: vec![0.0; 2 * len],
            pos: 0,
            factor,
            phase: 0,
        }
    }

    /// Output sample rate for an input rate.
    pub(crate) fn factor_for(sr: u32) -> usize {
        ((sr as f64 / 11_025.0).round() as usize).max(1)
    }

    /// Group delay of the (symmetric) low-pass, in input samples.
    pub(crate) fn delay(&self) -> f64 {
        (self.taps.len() - 1) as f64 / 2.0
    }

    #[inline]
    pub(crate) fn push(&mut self, x: f32) -> Option<f32> {
        let len = self.taps.len();
        self.hist[self.pos] = x;
        self.hist[self.pos + len] = x;
        self.pos += 1;
        if self.pos == len {
            self.pos = 0;
        }
        self.phase += 1;
        if self.phase < self.factor {
            return None;
        }
        self.phase = 0;
        let win = &self.hist[self.pos..self.pos + len];
        Some(win.iter().zip(&self.taps).map(|(a, b)| a * b).sum())
    }

    pub(crate) fn reset(&mut self) {
        self.hist.fill(0.0);
        self.pos = 0;
        self.phase = 0;
    }
}

pub(crate) fn mean(v: &[f32]) -> f32 {
    if v.is_empty() {
        0.0
    } else {
        v.iter().sum::<f32>() / v.len() as f32
    }
}

pub(crate) fn std_dev(v: &[f32]) -> f32 {
    if v.len() < 2 {
        return 0.0;
    }
    let m = mean(v);
    (v.iter().map(|x| (x - m) * (x - m)).sum::<f32>() / v.len() as f32).sqrt()
}

pub(crate) fn median(v: &[f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    let mut s = v.to_vec();
    s.sort_by(f32::total_cmp);
    s[s.len() / 2]
}

/// Weighted median of `(value, weight)` pairs.
pub(crate) fn weighted_median(pairs: &mut [(f64, f64)]) -> Option<f64> {
    let total: f64 = pairs.iter().map(|p| p.1).sum();
    if pairs.is_empty() || total <= 0.0 {
        return None;
    }
    pairs.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut acc = 0.0;
    for &(v, w) in pairs.iter() {
        acc += w;
        if acc >= total / 2.0 {
            return Some(v);
        }
    }
    pairs.last().map(|p| p.0)
}

/// Least-squares line `t = a + b k`. Returns `(a, b)`.
pub(crate) fn linear_fit(k: &[f64], t: &[f64]) -> Option<(f64, f64)> {
    let n = k.len().min(t.len());
    if n < 2 {
        return None;
    }
    let kb = k[..n].iter().sum::<f64>() / n as f64;
    let tb = t[..n].iter().sum::<f64>() / n as f64;
    let mut num = 0.0;
    let mut den = 0.0;
    for i in 0..n {
        num += (k[i] - kb) * (t[i] - tb);
        den += (k[i] - kb) * (k[i] - kb);
    }
    if den <= 0.0 {
        return None;
    }
    let b = num / den;
    Some((tb - b * kb, b))
}

/// Mono down-mix of an interleaved buffer.
pub(crate) fn downmix(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    let inv = 1.0 / channels as f32;
    samples
        .chunks_exact(channels)
        .map(|f| f.iter().sum::<f32>() * inv)
        .collect()
}
