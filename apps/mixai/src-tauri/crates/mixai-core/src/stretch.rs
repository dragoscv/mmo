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
        StemMix {
            layers,
            gains,
            count: 1,
            len,
        }
    }

    /// Multi-layer stem source. `layers[i]` paired with `gains[i]`; `None`
    /// slots are skipped. Length is the shortest present layer.
    pub fn stems(
        layers: [Option<(&'a [f32], &'a [f32])>; MAX_LAYERS],
        gains: [f32; MAX_LAYERS],
    ) -> Self {
        let mut len = usize::MAX;
        let mut count = 0;
        for l in layers.iter().flatten() {
            len = len.min(l.0.len().min(l.1.len()));
            count += 1;
        }
        if count == 0 {
            len = 0;
        }
        StemMix {
            layers,
            gains,
            count,
            len,
        }
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
    /// `tempo` = time scale (>1 faster), `rate_ratio` = track_sr/device_sr,
    /// `pitch` = frequency multiplier (grains are read `pitch`× faster while the
    /// analysis hop stays tempo-driven, so duration is unaffected).
    /// Returns false when the source is exhausted.
    pub fn process_hop(
        &mut self,
        src: &StemMix<'_>,
        tempo: f64,
        rate_ratio: f64,
        pitch: f64,
    ) -> bool {
        let n = src.len();
        if n < FRAME {
            return false;
        }
        let step = rate_ratio * pitch.clamp(0.25, 4.0);

        // First grain: no tail to match, take it straight.
        let best_delta = if self.primed {
            self.find_best_delta(src, step)
        } else {
            0
        };

        let base = self.analysis_pos + best_delta as f64 * step;
        if base as usize >= n.saturating_sub(1) {
            return false; // Past end.
        }

        // Read + window the grain, overlap-add the first OVERLAP samples with
        // the stored tail, emit HOP samples, and keep the new tail.
        for k in 0..FRAME {
            let pos = base + k as f64 * step;
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
            let score = if energy > 1e-9 {
                dot / energy.sqrt()
            } else {
                dot
            };
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

// ---- Stretcher abstraction (WP19-07) ------------------------------------------------

/// A real-time, pitch-independent time-stretcher pulled one stereo frame at a time.
///
/// Implementations must not allocate or lock inside [`Stretcher::next_frame`]; all
/// buffers are sized at construction. `reset` is cheap and may be called from the
/// audio thread; the actual re-priming happens lazily on the next pull (it needs
/// the source).
pub trait Stretcher: Send {
    /// Short identifier for logs / UI (`"signalsmith"`, `"wsola"`).
    fn name(&self) -> &'static str;
    /// Discontinuity (seek, loop wrap, cue jump): restart at source frame `pos`.
    fn reset(&mut self, pos: f64);
    /// Produce the next output frame. `tempo` = time ratio (0.5..2.0), `rate_ratio` =
    /// track_sr / device_sr, `pitch` = frequency multiplier. `None` = source exhausted.
    fn next_frame(
        &mut self,
        src: &StemMix<'_>,
        tempo: f64,
        rate_ratio: f64,
        pitch: f64,
    ) -> Option<(f32, f32)>;
    /// Source frame (track rate) of the audio most recently returned.
    fn position(&self) -> f64;
}

/// The original WSOLA engine behind the [`Stretcher`] trait (fallback; pure Rust).
pub struct WsolaStretcher {
    ts: TimeStretch,
    pos: f64,
}

impl WsolaStretcher {
    pub fn new() -> Self {
        WsolaStretcher {
            ts: TimeStretch::new(),
            pos: 0.0,
        }
    }
}

impl Default for WsolaStretcher {
    fn default() -> Self {
        Self::new()
    }
}

impl Stretcher for WsolaStretcher {
    fn name(&self) -> &'static str {
        "wsola"
    }

    fn reset(&mut self, pos: f64) {
        self.ts.reset(pos);
        self.pos = pos.max(0.0);
    }

    fn next_frame(
        &mut self,
        src: &StemMix<'_>,
        tempo: f64,
        rate_ratio: f64,
        pitch: f64,
    ) -> Option<(f32, f32)> {
        if self.ts.available() == 0 && !self.ts.process_hop(src, tempo, rate_ratio, pitch) {
            return None;
        }
        let out = self.ts.pop();
        self.pos += tempo * rate_ratio;
        Some(out)
    }

    fn position(&self) -> f64 {
        self.pos
    }
}

/// Output frames rendered per Signalsmith `process` call.
const SS_BLOCK: usize = 128;
/// Max source frames consumed per block (tempo 2.0 × rate ratio up to 4.0).
const SS_MAX_IN: usize = SS_BLOCK * 8 + 4;

/// High-quality spectral stretcher: Signalsmith Stretch (MIT) via the
/// `signalsmith-stretch` crate. Default key-lock engine.
pub struct SignalsmithStretcher {
    inner: signalsmith_stretch::Stretch,
    /// Interleaved stereo scratch input (sized for both blocks and seek pre-roll).
    input: Vec<f32>,
    /// Interleaved stereo output block.
    output: Vec<f32>,
    out_idx: usize,
    out_len: usize,
    /// Next source frame to feed.
    read_pos: f64,
    /// Fractional input-frame accumulator.
    in_acc: f64,
    /// Source frame of the last returned output.
    pos: f64,
    pending_reset: bool,
    transpose: f32,
    in_latency: usize,
    out_latency: usize,
    seek_len: usize,
}

impl SignalsmithStretcher {
    /// Build for a device sample rate. Allocates (call off the audio thread).
    pub fn new(sample_rate: f32) -> Self {
        let sr = sample_rate.max(8_000.0);
        // ~80 ms block, 4× overlap: DJ-grade latency (~40 ms each side) with clean transients.
        let block = ((sr * 0.08) as usize).max(256);
        let interval = (block / 4).max(64);
        let mut inner = signalsmith_stretch::Stretch::new(2, block, interval);
        let in_latency = inner.input_latency();
        let out_latency = inner.output_latency();
        let seek_len = block + interval;
        let frames = seek_len.max(SS_MAX_IN);
        let input = vec![0.0f32; frames * 2];
        // Warm the C++ scratch buffers once so later process/seek calls never allocate.
        inner.seek(&input[..seek_len * 2], 1.0);
        let mut warm_out = vec![0.0f32; SS_BLOCK * 2];
        inner.process(&input[..SS_BLOCK * 2], &mut warm_out);
        inner.reset();
        SignalsmithStretcher {
            inner,
            input,
            output: vec![0.0f32; SS_BLOCK * 2],
            out_idx: 0,
            out_len: 0,
            read_pos: 0.0,
            in_acc: 0.0,
            pos: 0.0,
            pending_reset: true,
            transpose: 1.0,
            in_latency,
            out_latency,
            seek_len,
        }
    }

    /// Total algorithmic latency (input + output) in frames.
    pub fn latency_frames(&self) -> usize {
        self.in_latency + self.out_latency
    }

    fn fill_input(&mut self, src: &StemMix<'_>, start: f64, frames: usize) {
        for i in 0..frames {
            let (l, r) = src.read_stereo(start + i as f64);
            self.input[2 * i] = l;
            self.input[2 * i + 1] = r;
        }
    }

    fn render_block(&mut self, src: &StemMix<'_>, speed: f64) {
        let want = self.in_acc + SS_BLOCK as f64 * speed;
        let n_in = (want.floor() as usize).min(SS_MAX_IN);
        self.in_acc = (want - n_in as f64).clamp(0.0, 1.0);
        self.fill_input(src, self.read_pos, n_in);
        self.read_pos += n_in as f64;
        self.inner
            .process(&self.input[..n_in * 2], &mut self.output[..SS_BLOCK * 2]);
        self.out_idx = 0;
        self.out_len = SS_BLOCK;
    }

    /// Re-prime: pre-roll so the processing time lands exactly on `self.pos`, then
    /// discard the output latency so the first returned frame is the cue point.
    fn prime(&mut self, src: &StemMix<'_>, speed: f64) {
        self.inner.reset();
        self.inner.set_transpose_factor(self.transpose, None);
        let start = self.pos + self.in_latency as f64 - self.seek_len as f64;
        self.fill_input(src, start, self.seek_len);
        self.inner
            .seek(&self.input[..self.seek_len * 2], speed.max(0.01));
        self.read_pos = self.pos + self.in_latency as f64;
        self.in_acc = 0.0;
        let mut discard = self.out_latency;
        while discard > 0 {
            self.render_block(src, speed);
            let take = discard.min(SS_BLOCK);
            self.out_idx = take;
            discard -= take;
        }
        self.pending_reset = false;
    }
}

impl Stretcher for SignalsmithStretcher {
    fn name(&self) -> &'static str {
        "signalsmith"
    }

    fn reset(&mut self, pos: f64) {
        self.pos = pos.max(0.0);
        self.out_idx = 0;
        self.out_len = 0;
        self.pending_reset = true;
    }

    fn next_frame(
        &mut self,
        src: &StemMix<'_>,
        tempo: f64,
        rate_ratio: f64,
        pitch: f64,
    ) -> Option<(f32, f32)> {
        if src.is_empty() || self.pos >= src.len() as f64 {
            return None;
        }
        let speed = (tempo * rate_ratio).clamp(0.01, 8.0);
        // Input is fed at the track rate and played at the device rate: compensate
        // the resulting rate_ratio pitch change inside the transpose factor.
        let transpose = (pitch * rate_ratio).clamp(0.125, 8.0) as f32;
        if (transpose - self.transpose).abs() > 1e-6 {
            self.transpose = transpose;
            self.inner.set_transpose_factor(transpose, None);
        }
        if self.pending_reset {
            self.prime(src, speed);
        }
        if self.out_idx >= self.out_len {
            self.render_block(src, speed);
        }
        let i = self.out_idx;
        self.out_idx += 1;
        let out = (self.output[2 * i], self.output[2 * i + 1]);
        self.pos += speed;
        Some(out)
    }

    fn position(&self) -> f64 {
        self.pos
    }
}

/// Which engine a deck uses for key lock / key shift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StretcherKind {
    Signalsmith,
    Wsola,
}

/// Construct a stretcher (allocates; call off the audio thread).
pub fn make_stretcher(kind: StretcherKind, sample_rate: f32) -> Box<dyn Stretcher> {
    match kind {
        StretcherKind::Signalsmith => Box::new(SignalsmithStretcher::new(sample_rate)),
        StretcherKind::Wsola => Box::new(WsolaStretcher::new()),
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
            if !ts.process_hop(&src, 0.8, 1.0, 1.0) {
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
        ts.process_hop(&src, 1.0, 1.0, 1.0);
        let after_one = ts.analysis_pos;
        ts.process_hop(&src, 1.0, 1.0, 1.0);
        let after_two = ts.analysis_pos;
        // At tempo 1.0 each hop advances ~HOP source samples.
        let step = after_two - after_one;
        assert!(step > 0.0, "analysis position must advance");
        assert!(
            (step - HOP as f64).abs() < SEARCH as f64 + 2.0,
            "step {step} off"
        );
    }

    /// Frequency estimate from positive-going zero crossings (linear-interpolated).
    fn zero_cross_freq(x: &[f32], sr: f32) -> f32 {
        let mut first = None;
        let mut last = 0.0f32;
        let mut count = 0usize;
        for i in 1..x.len() {
            if x[i - 1] <= 0.0 && x[i] > 0.0 {
                let t = (i - 1) as f32 + (-x[i - 1]) / (x[i] - x[i - 1]);
                if first.is_none() {
                    first = Some(t);
                } else {
                    count += 1;
                }
                last = t;
            }
        }
        match first {
            Some(f) if count > 0 => count as f32 * sr / (last - f),
            _ => 0.0,
        }
    }

    fn run(st: &mut dyn Stretcher, tempo: f64, pitch: f64, frames: usize) -> Vec<f32> {
        let (l, r) = sine(1000.0, 48_000.0, 48_000 * 6);
        let src = StemMix::single(&l, &r);
        st.reset(4_800.0);
        let mut out = Vec::with_capacity(frames);
        for _ in 0..frames {
            match st.next_frame(&src, tempo, 1.0, pitch) {
                Some((a, _)) => out.push(a),
                None => break,
            }
        }
        out
    }

    fn assert_freq(out: &[f32], expect: f32, label: &str) {
        // Skip the first 0.25 s (spectral settling) and measure the next second.
        let seg = &out[12_000..12_000 + 48_000];
        assert!(seg.iter().all(|s| s.is_finite()), "{label}: non-finite");
        let f = zero_cross_freq(seg, 48_000.0);
        assert!(
            (f - expect).abs() / expect < 0.01,
            "{label}: got {f} Hz, want {expect} Hz"
        );
    }

    #[test]
    fn signalsmith_keeps_pitch_at_tempo_1_25() {
        let mut st = SignalsmithStretcher::new(48_000.0);
        let out = run(&mut st, 1.25, 1.0, 72_000);
        assert_freq(&out, 1000.0, "tempo 1.25");
        // Position advanced at 1.25× the output rate.
        let expect = 4_800.0 + out.len() as f64 * 1.25;
        assert!((st.position() - expect).abs() < 1.0);
    }

    #[test]
    fn signalsmith_key_shift_octave_doubles_frequency() {
        let mut st = SignalsmithStretcher::new(48_000.0);
        let out = run(&mut st, 1.0, 2.0, 72_000);
        assert_freq(&out, 2000.0, "+12 st");
    }

    #[test]
    fn wsola_fallback_pitch_shift_and_tempo() {
        let mut st = WsolaStretcher::new();
        let out = run(&mut st, 1.25, 1.0, 72_000);
        assert_freq(&out, 1000.0, "wsola tempo 1.25");
        let mut st = WsolaStretcher::new();
        let out = run(&mut st, 1.0, 2.0, 72_000);
        assert_freq(&out, 2000.0, "wsola +12 st");
    }
}
