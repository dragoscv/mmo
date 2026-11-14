//! Spectrum for the UI, in the shape of the meters ring: the output callback **copies** the mono
//! main bus into a lock-free ring and never does the maths; the control thread drains it into a
//! sliding window and runs the FFT. One producer, one consumer, no allocation on the audio thread,
//! and a frame on the wire is one byte per bin (a display, never a signal path — if the control
//! thread is behind, the oldest samples are simply dropped).

use std::f32::consts::PI;

/// FFT size: ~10.7 ms at 48 kHz — long enough to show a note's harmonics, short enough to move with
/// the voice.
pub const FFT: usize = 512;
/// Published bins: the lower half of the spectrum (0 Hz .. Nyquist), pairs averaged.
pub const BINS: usize = 128;
/// Samples the tap ring holds (~170 ms at 48 kHz).
pub const TAP: usize = 8192;
/// The wire maps the bins from this floor up to 0 dB.
const FLOOR_DB: f32 = -90.0;

/// Iterative radix-2 FFT, in place, on fixed-size buffers: no allocation, no twiddle table (the 9
/// twiddle angles are cheap next to the cost of a Vec the audio path must not touch).
pub fn fft(re: &mut [f32; FFT], im: &mut [f32; FFT]) {
    // Bit-reversal permutation.
    let mut j = 0usize;
    for i in 1..FFT {
        let mut bit = FFT >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= FFT {
        let ang = -2.0 * PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        let mut i = 0;
        while i < FFT {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let (ur, ui) = (re[i + k], im[i + k]);
                let (xr, xi) = (re[i + k + len / 2], im[i + k + len / 2]);
                let (tr, ti) = (xr * cr - xi * ci, xr * ci + xi * cr);
                re[i + k] = ur + tr;
                im[i + k] = ui + ti;
                re[i + k + len / 2] = ur - tr;
                im[i + k + len / 2] = ui - ti;
                let ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
            i += len;
        }
        len <<= 1;
    }
}

/// Sliding-window analyser. `push` the tapped samples (any number), then `analyse` for the newest
/// spectrum.
pub struct Spectrum {
    /// The newest `FFT` samples as a ring; `w` is the next write slot.
    window: [f32; FFT],
    w: usize,
    re: [f32; FFT],
    im: [f32; FFT],
    hann: [f32; FFT],
    /// Window normalisation: a full-scale sine in one bin reads about 0 dB after this.
    scale: f32,
    /// Linear magnitudes of the lower half, kept for tests and for a different mapping.
    mag: [f32; FFT],
    bins: [u8; BINS],
    dirty: bool,
    /// Samples were pushed since the last `analyse` that were enough to be worth re-analysing.
    seen: usize,
}

impl Default for Spectrum {
    fn default() -> Self {
        Self::new()
    }
}

impl Spectrum {
    pub fn new() -> Self {
        let mut hann = [0.0f32; FFT];
        let mut sum = 0.0f32;
        for (i, h) in hann.iter_mut().enumerate() {
            *h = 0.5 - 0.5 * (2.0 * PI * i as f32 / FFT as f32).cos();
            sum += *h;
        }
        Self {
            window: [0.0; FFT],
            w: 0,
            re: [0.0; FFT],
            im: [0.0; FFT],
            hann,
            // A windowed sine of amplitude 1 puts `sum/2` in its bin.
            scale: 2.0 / sum.max(1e-6),
            mag: [0.0; FFT],
            bins: [0; BINS],
            dirty: false,
            seen: 0,
        }
    }

    /// Append tapped samples to the window.
    pub fn push(&mut self, samples: &[f32]) {
        for &s in samples {
            self.window[self.w] = if s.is_finite() { s } else { 0.0 };
            self.w = (self.w + 1) % FFT;
        }
        self.seen += samples.len();
        if self.seen >= FFT / 8 {
            self.dirty = true;
        }
    }

    /// Drain a tap ring into the window (control thread).
    pub fn drain(&mut self, tap: &mut rtrb::Consumer<f32>) {
        let mut batch = [0.0f32; 1024];
        while tap.slots() > 0 {
            let n = tap.slots().min(batch.len());
            let mut got = 0;
            for slot in batch.iter_mut().take(n) {
                match tap.pop() {
                    Ok(s) => {
                        *slot = s;
                        got += 1;
                    }
                    Err(_) => break,
                }
            }
            if got == 0 {
                break;
            }
            self.push(&batch[..got]);
        }
    }

    /// `true` when enough new samples arrived to be worth a new frame.
    pub fn fresh(&self) -> bool {
        self.dirty
    }

    /// The newest spectrum: `BINS` values, 0 = [`FLOOR_DB`], 255 = 0 dB.
    pub fn analyse(&mut self) -> &[u8; BINS] {
        if !self.dirty {
            return &self.bins;
        }
        self.dirty = false;
        self.seen = 0;
        for i in 0..FFT {
            self.re[i] = self.window[(self.w + i) % FFT] * self.hann[i];
            self.im[i] = 0.0;
        }
        fft(&mut self.re, &mut self.im);
        for i in 0..FFT {
            self.mag[i] = (self.re[i] * self.re[i] + self.im[i] * self.im[i]).sqrt();
        }
        let step = (FFT / 2) / BINS;
        for (b, out) in self.bins.iter_mut().enumerate() {
            let mut sum = 0.0;
            for k in 0..step {
                sum += self.mag[b * step + k];
            }
            let m = sum / step as f32 * self.scale;
            let db = 20.0 * m.max(1e-9).log10();
            *out = (((db - FLOOR_DB) * (255.0 / -FLOOR_DB)).clamp(0.0, 255.0)) as u8;
        }
        &self.bins
    }

    /// Bin index (of the published `BINS`) that a frequency lands in.
    pub fn bin_of(&self, hz: f32, sample_rate: f32) -> usize {
        let raw = (hz * FFT as f32 / sample_rate).round() as usize;
        (raw / ((FFT / 2) / BINS)).min(BINS - 1)
    }

    /// Linear magnitudes from the last `analyse` (tests, and a caller that wants its own mapping).
    pub fn magnitudes(&self) -> &[f32; FFT] {
        &self.mag
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dump(label: &str, spec: &Spectrum) {
        let peak = FFT / 2;
        let (mut best, mut at) = (0.0f32, 0usize);
        for i in 0..peak {
            if spec.magnitudes()[i] > best {
                best = spec.magnitudes()[i];
                at = i;
            }
        }
        println!(
            "{label}: peak bin {at} ({} Hz at 48 kHz), {best:.4}",
            at as f32 * 48000.0 / FFT as f32
        );
    }

    /// A sine lands in its own bin: 1 kHz at 48 kHz is bin 10-11 of 256, so 5 of the 128 published.
    #[test]
    fn a_sine_lands_in_its_bin() {
        let mut s = Spectrum::new();
        let sr = 48000.0f32;
        let x: Vec<f32> = (0..FFT)
            .map(|i| (2.0 * PI * 1000.0 * i as f32 / sr).sin())
            .collect();
        s.push(&x);
        assert!(s.fresh());
        let bins = *s.analyse();
        let peak = bins
            .iter()
            .enumerate()
            .max_by_key(|(_, v)| **v)
            .map(|(i, _)| i)
            .unwrap();
        assert!((4..=6).contains(&peak), "1000 Hz landed in bin {peak}");
        // Full scale reads near the top of the byte range, and a bin far away stays near the floor.
        assert!(
            bins[5] > 200,
            "the peak bin must be near full scale, got {}",
            bins[5]
        );
        dump("1 kHz", &s);
    }

    /// Nothing at all reads as the floor, and DC lands in bin 0.
    #[test]
    fn silence_is_the_floor_and_dc_is_bin_zero() {
        let mut s = Spectrum::new();
        s.push(&[0.0; FFT]);
        assert!(s.analyse().iter().all(|b| *b == 0), "silence is the floor");

        let mut s = Spectrum::new();
        s.push(&[0.5; FFT]);
        let bins = *s.analyse();
        let peak = bins
            .iter()
            .enumerate()
            .max_by_key(|(_, v)| **v)
            .map(|(i, _)| i)
            .unwrap();
        assert_eq!(peak, 0, "a constant signal is DC");
    }

    /// `bin_of` agrees with where the FFT actually puts a tone (used by the UI's scale).
    #[test]
    fn bin_of_matches_the_transform() {
        let s = Spectrum::new();
        for hz in [200.0f32, 1000.0, 4000.0] {
            let x: Vec<f32> = (0..FFT)
                .map(|i| (2.0 * PI * hz * i as f32 / 48000.0).sin())
                .collect();
            let mut probe = Spectrum::new();
            probe.push(&x);
            let bins = *probe.analyse();
            let peak = bins
                .iter()
                .enumerate()
                .max_by_key(|(_, v)| **v)
                .map(|(i, _)| i)
                .unwrap();
            let want = s.bin_of(hz, 48000.0);
            assert!(
                peak.abs_diff(want) <= 1,
                "{hz} Hz: transform says bin {peak}, bin_of says {want}"
            );
        }
    }

    /// The FFT of an impulse is flat: every bin of the lower half is within a hair of the others.
    #[test]
    fn an_impulse_is_flat() {
        let mut re = [0.0f32; FFT];
        let mut im = [0.0f32; FFT];
        re[0] = 1.0;
        fft(&mut re, &mut im);
        let mags: Vec<f32> = (0..FFT / 2)
            .map(|i| (re[i] * re[i] + im[i] * im[i]).sqrt())
            .collect();
        let lo = mags.iter().cloned().fold(f32::INFINITY, f32::min);
        let hi = mags.iter().cloned().fold(0.0f32, f32::max);
        assert!(
            (hi - lo) < 1e-3,
            "impulse spectrum is not flat: {lo} .. {hi}"
        );
    }

    /// A window that is not full yet (the first ~100 samples after start) must not panic and must
    /// still show the energy it has — and a couple of samples must not be worth a frame at all.
    #[test]
    fn a_partly_filled_window_is_safe() {
        let mut s = Spectrum::new();
        s.push(&[1.0, -1.0, 0.5]);
        assert!(!s.fresh(), "a few samples are not worth an FFT");
        assert!(s.analyse().iter().all(|b| *b == 0), "and show nothing yet");

        let x: Vec<f32> = (0..100)
            .map(|i| (2.0 * PI * 1000.0 * i as f32 / 48000.0).sin())
            .collect();
        s.push(&x);
        assert!(s.fresh(), "a hundred samples are worth a frame");
        let bins = *s.analyse();
        assert_eq!(bins.len(), BINS);
        assert!(
            bins.iter().any(|b| *b > 0),
            "a tone in a half-empty window is not silence"
        );
    }
}
