//! Real-time pitch-preserving time-stretch (WSOLA).
//!
//! Pure Rust, permissive — no C++ toolchain, ships inside the distributable
//! engine. Used by the deck when **key-lock** is enabled so changing tempo
//! does not change pitch (the DJ standard).
//!
//! WSOLA = Waveform-Similarity Overlap-Add: we cut overlapping grains from the
//! source, slide each by a small search offset to best match the previous
//! grain's tail (minimising phase discontinuity / clicks), Hann-window them and
//! overlap-add into the output. The analysis pointer advances by `tempo` faster
//! than the synthesis hop, which compresses/expands time while every grain is
//! read at the native rate (so pitch is preserved). An internal `rate_ratio`
//! step also maps the track sample-rate to the device rate inside each grain.

use std::collections::VecDeque;

/// Output grain length in samples.
const FRAME: usize = 1024;
/// 50% overlap → synthesis hop = FRAME/2.
const OVERLAP: usize = FRAME / 2;
const HOP: usize = FRAME - OVERLAP;
/// Max alignment search (± samples) for waveform similarity.
const SEARCH: isize = 96;

/// Max simultaneous stem layers (vocals / drums / bass / melody).
pub const MAX_LAYERS: usize = 4;

/// A read-only view of the deck's audio source: one or more stereo layers
/// (the full track = a single layer; stems = up to 4) summed with per-layer
/// gains. Built fresh each render hop from borrowed buffers + current smoothed
/// gains, so it never allocates and stays RT-safe. All layers are assumed to
/// share a sample rate and (near-)equal length; reads clamp to the shortest.
pub struct StemMix<'a> {
    layers: [Option<(&'a [f32], &'a [f32])>; MAX_LAYERS],
    gains: [f32; MAX_LAYERS],
    count: usize,
    len: usize,
}

impl<'a> StemMix<'a> {
    /// Single-layer source (the full track) at unity gain.
    pub fn single(left: &'a [f32], right: &'a [f32]) -> Self {
        let len = left.len().min(right.len());
        let mut layers = [None; MAX_LAYERS];
        layers[0] = Some((left, right));
        let mut gains = [0.0; MAX_LAYERS];
        gains[0] = 1.0;
        StemMix { layers, gains, count: 1, len }
    }

    /// Multi-layer stem source. `layers[i]` paired with `gains[i]`; `None`
    /// slots are skipped. Length is the shortest present layer.
    pub fn stems(layers: [Option<(&'a [f32], &'a [f32])>; MAX_LAYERS], gains: [f32; MAX_LAYERS]) -> Self {
        let mut len = usize::MAX;
        let mut count = 0;
        for l in layers.iter().flatten() {
            len = len.min(l.0.len().min(l.1.len()));
            count += 1;
        }
        if count == 0 {
            len = 0;
        }
        StemMix { layers, gains, count, len }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0 || self.count == 0
    }

    /// Linear-interpolated summed stereo read at fractional `pos`.
    #[inline]
    pub fn read_stereo(&self, pos: f64) -> (f32, f32) {
        if pos < 0.0 || pos as usize >= self.len.saturating_sub(1) {
            return (0.0, 0.0);
        }
        let i = pos as usize;
        let frac = (pos - i as f64) as f32;
        let (mut l, mut r) = (0.0f32, 0.0f32);
        for (idx, layer) in self.layers.iter().enumerate() {
            if let Some((left, right)) = layer {
                let g = self.gains[idx];
                l += (left[i] + (left[i + 1] - left[i]) * frac) * g;
                r += (right[i] + (right[i + 1] - right[i]) * frac) * g;
            }
        }
        (l, r)
    }

    /// Linear-interpolated summed mono read (for WSOLA correlation).
    #[inline]
    pub fn read_mono(&self, pos: f64) -> f32 {
        let (l, r) = self.read_stereo(pos);
        (l + r) * 0.5
    }
}

/// Streaming stereo WSOLA stretcher. One per deck.
pub struct TimeStretch {
    window: [f32; FRAME],
    // OLA carry tails (length OVERLAP) from the previous grain.
    tail_l: Vec<f32>,
    tail_r: Vec<f32>,
    // Ready output samples awaiting consumption.
    out_l: VecDeque<f32>,
    out_r: VecDeque<f32>,
    /// Source read position (in source frames) for the next grain.
    pub analysis_pos: f64,
    primed: bool,
}

impl TimeStretch {
    pub fn new() -> Self {
        let mut window = [0.0f32; FRAME];
        for (i, w) in window.iter_mut().enumerate() {
            // Periodic Hann (constant-overlap-add at 50%).
            *w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FRAME as f32).cos();
        }
        TimeStretch {
            window,
            tail_l: vec![0.0; OVERLAP],
            tail_r: vec![0.0; OVERLAP],
            out_l: VecDeque::with_capacity(FRAME * 2),
            out_r: VecDeque::with_capacity(FRAME * 2),
            analysis_pos: 0.0,
            primed: false,
        }
    }

    /// Reset all state and re-prime from `pos` (call on seek / cue jump /
    /// key-lock toggle / load — any playhead discontinuity).
    pub fn reset(&mut self, pos: f64) {
        self.tail_l.iter_mut().for_each(|x| *x = 0.0);
        self.tail_r.iter_mut().for_each(|x| *x = 0.0);
        self.out_l.clear();
        self.out_r.clear();
        self.analysis_pos = pos.max(0.0);
        self.primed = false;
    }

    /// Number of buffered output samples ready to pop.
    pub fn available(&self) -> usize {
        self.out_l.len()
    }

    /// Pop one stereo output sample (call only when `available() > 0`).
    pub fn pop(&mut self) -> (f32, f32) {
        (
            self.out_l.pop_front().unwrap_or(0.0),
            self.out_r.pop_front().unwrap_or(0.0),
        )
    }

    /// Synthesize one hop (HOP samples) from the source and append to output.
    /// `tempo` = time scale (>1 faster), `rate_ratio` = track_sr/device_sr.
    /// Returns false when the source is exhausted.
    pub fn process_hop(
        &mut self,
        src: &StemMix<'_>,
        tempo: f64,
        rate_ratio: f64,
    ) -> bool {
        let n = src.len();
        if n < FRAME {
            return false;
        }

        // First grain: no tail to match, take it straight.
        let best_delta = if self.primed {
            self.find_best_delta(src, rate_ratio)
        } else {
            0
        };

        let base = self.analysis_pos + best_delta as f64 * rate_ratio;
        if base as usize >= n.saturating_sub(1) {
            return false; // Past end.
        }

        // Read + window the grain, overlap-add the first OVERLAP samples with
        // the stored tail, emit HOP samples, and keep the new tail.
        for k in 0..FRAME {
            let pos = base + k as f64 * rate_ratio;
            let (sl, sr) = src.read_stereo(pos);
            let w = self.window[k];
            let gl = sl * w;
            let gr = sr * w;
            if k < OVERLAP {
                let out_l = self.tail_l[k] + gl;
                let out_r = self.tail_r[k] + gr;
                if self.primed {
                    self.out_l.push_back(out_l);
                    self.out_r.push_back(out_r);
                } else {
                    // While priming, the tail is zero; only emit once we have a
                    // full overlap of real data (after the first grain we mark
                    // primed and its second half becomes the tail).
                    self.out_l.push_back(gl);
                    self.out_r.push_back(gr);
                }
            } else {
                // Store the second half as the next tail.
                self.tail_l[k - OVERLAP] = gl;
                self.tail_r[k - OVERLAP] = gr;
            }
        }
        self.primed = true;

        // Advance the analysis pointer by the (tempo-scaled) hop.
        self.analysis_pos = base + (HOP as f64) * tempo * rate_ratio;
        true
    }

    /// Search ±SEARCH source samples for the offset whose grain head best
    /// matches the stored tail (max normalised cross-correlation, mono).
    fn find_best_delta(&self, src: &StemMix<'_>, rate_ratio: f64) -> isize {
        let mut best = 0isize;
        let mut best_score = f32::NEG_INFINITY;
        for delta in -SEARCH..=SEARCH {
            let base = self.analysis_pos + delta as f64 * rate_ratio;
            if base < 0.0 {
                continue;
            }
            let mut dot = 0.0f32;
            let mut energy = 0.0f32;
            // Correlate against the tail over the overlap region.
            for j in 0..OVERLAP {
                let pos = base + j as f64 * rate_ratio;
                let s = src.read_mono(pos);
                let t = (self.tail_l[j] + self.tail_r[j]) * 0.5;
                dot += s * t;
                energy += s * s;
            }
            // Normalise by grain energy to avoid biasing toward loud regions.
            let score = if energy > 1e-9 { dot / energy.sqrt() } else { dot };
            if score > best_score {
                best_score = score;
                best = delta;
            }
        }
        best
    }
}

impl Default for TimeStretch {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Generate a stereo sine of `freq` Hz at `sr` for `n` samples.
    fn sine(freq: f32, sr: f32, n: usize) -> (Vec<f32>, Vec<f32>) {
        let mut l = Vec::with_capacity(n);
        for i in 0..n {
            let t = i as f32 / sr;
            l.push((2.0 * std::f32::consts::PI * freq * t).sin() * 0.5);
        }
        let r = l.clone();
        (l, r)
    }

    #[test]
    fn produces_bounded_finite_output() {
        let (l, r) = sine(440.0, 48_000.0, 48_000);
        let mut ts = TimeStretch::new();
        ts.reset(0.0);
        // Stretch slower (tempo 0.8) — output should be longer than input hops.
        let mut emitted = 0usize;
        for _ in 0..200 {
            let src = StemMix::single(&l, &r);
            if !ts.process_hop(&src, 0.8, 1.0) {
                break;
            }
            while ts.available() > 0 {
                let (sl, sr) = ts.pop();
                assert!(sl.is_finite() && sr.is_finite(), "non-finite sample");
                assert!(sl.abs() <= 1.5, "sample out of range: {sl}");
                emitted += 1;
            }
        }
        assert!(emitted > 0, "stretcher emitted nothing");
    }

    #[test]
    fn advances_analysis_position_with_tempo() {
        let (l, r) = sine(220.0, 48_000.0, 48_000);
        let mut ts = TimeStretch::new();
        ts.reset(0.0);
        let src = StemMix::single(&l, &r);
        ts.process_hop(&src, 1.0, 1.0);
        let after_one = ts.analysis_pos;
        ts.process_hop(&src, 1.0, 1.0);
        let after_two = ts.analysis_pos;
        // At tempo 1.0 each hop advances ~HOP source samples.
        let step = after_two - after_one;
        assert!(step > 0.0, "analysis position must advance");
        assert!((step - HOP as f64).abs() < SEARCH as f64 + 2.0, "step {step} off");
    }
}
