//! A single playback deck: holds decoded stereo samples and runs the per-deck
//! DSP chain (trim → EQ → filter → colour FX → [PFL tap] → volume → FX → beat FX)
//! in the audio callback.
//!
//! Without key lock or key shift the deck plays varispeed (tempo bends pitch).
//! With key lock and/or a key shift it pulls from a [`Stretcher`] (Signalsmith
//! Stretch by default, WSOLA fallback). Beatgrid, quantize, beat-jump, slip and
//! reverse implement WP19-05.

use crate::beatfx::{BeatFx, BeatFxKind};
use crate::beatgrid::BeatGrid;
use crate::colorfx::{ColorFx, ColorFxKind};
use crate::dsp::{Biquad, Smoothed, crossfader_gain, db_to_lin};
use crate::fx::{Fx, FxKind};
use crate::state::{CrossfaderAssign, DeckId, DeckState, stem_mute_step};
use crate::stretch::{MAX_LAYERS, StemMix, Stretcher, StretcherKind, make_stretcher};

/// Tempo range for every path (varispeed and key-locked stretch).
pub const TEMPO_MIN: f64 = 0.5;
pub const TEMPO_MAX: f64 = 2.0;
/// Key shift range in semitones.
pub const KEY_SHIFT_MAX: f64 = 12.0;
/// Channel trim ceiling in dB.
pub const TRIM_MAX_DB: f32 = 12.0;
/// Trim at or below this is silence (−∞ dB); also the value reported for −∞.
pub const TRIM_MIN_DB: f32 = -96.0;
/// Trim smoothing time constant.
const TRIM_SMOOTH_MS: f32 = 15.0;
/// Smoothing time constant of the per-stem gains (level and stem crossfader).
const STEM_SMOOTH_MS: f32 = 20.0;
/// A stem at or below this gain is silent (muted).
pub const STEM_SILENT: f32 = 0.001;
/// Stem mute FX: each echo repeat is this much of the one before it.
pub const STEM_TAIL_FEEDBACK: f32 = 0.55;
/// Stem mute FX: repeats in a tail. The last one is at 0.55^12 (−62 dB), so the tail ends
/// there: it is over 12 echo times (plus the fade) after the mute.
pub const STEM_TAIL_TAPS: i64 = 12;
/// Stem mute FX: fade of a repeat when it reaches the mute point, and of the tail on unmute.
const STEM_TAIL_FADE_MS: f32 = 20.0;
/// Stem mute FX echo time range in beats.
pub const STEM_MUTE_FX_BEATS_MIN: f64 = 1.0 / 32.0;
pub const STEM_MUTE_FX_BEATS_MAX: f64 = 8.0;

/// Linear gain for a trim in dB: ≤ [`TRIM_MIN_DB`] (incl. −∞) or NaN → 0, capped at
/// [`TRIM_MAX_DB`].
pub fn trim_gain(db: f32) -> f32 {
    if db.is_nan() || db <= TRIM_MIN_DB {
        0.0
    } else {
        db_to_lin(db.min(TRIM_MAX_DB))
    }
}

/// Gain of one stem for its stem crossfader position `pos` (−1 = side A .. +1 = side B) on a
/// deck that sits on crossfader side `side`: the mixer's crossfader law (`curve`, see
/// [`crossfader_gain`]) normalised so that the centre is unity and capped at unity. So 0 (the
/// default) changes nothing, the deck's own side changes nothing, and the far side is silence.
/// A deck on THRU has no side: its stems ignore the stem crossfader.
pub fn stem_xf_gain(pos: f32, side: CrossfaderAssign, curve: u8) -> f32 {
    let side_a = match side {
        CrossfaderAssign::A => true,
        CrossfaderAssign::B => false,
        CrossfaderAssign::Thru => return 1.0,
    };
    if pos.is_nan() || pos == 0.0 {
        return 1.0;
    }
    let centre = crossfader_gain(0.0, side_a, curve);
    if centre <= 0.0 {
        return 1.0;
    }
    (crossfader_gain(pos, side_a, curve) / centre).clamp(0.0, 1.0)
}

/// Echo tail of one muted stem (stem mute FX).
///
/// A stem is a buffer the deck already holds, so the echo of what was heard before the mute
/// needs no delay line: repeat `k` is the stem `k` echo times before the tail's own playhead
/// (`origin + age`), at `feedback^k`. A repeat stops when its read point reaches the mute
/// point (the send closed there), so the tail is exactly what a feedback echo with the stem
/// sent into it until the mute would play, and it ends after [`STEM_TAIL_TAPS`] repeats. The
/// playhead of the tail is its own: seeking or looping the deck after the mute does not move it.
/// (The stems are summed before the time-stretcher, so there is no per-stem signal a real
/// delay line could be fed with; reading the stem buffer is also free of allocation.)
///
/// Approximation: the repeats are read at the pitch the stem is heard at. With key lock and a
/// tempo other than ±0 % a repeat therefore covers slightly less (or more) of the track than
/// a delay line fed with the stretched audio would hold; its timing and level are exact.
#[derive(Clone, Copy)]
struct StemTail {
    /// Repeats are still due (false once the last one played or the stem was unmuted).
    ringing: bool,
    /// Deck playhead (source frames) when the stem was muted.
    origin: f64,
    /// Source frames played since the mute.
    age: f64,
    /// Echo time in source frames (fixed for the life of the tail).
    delay: f64,
    /// Level of the stem before the mute.
    level: f32,
    /// Return gain: 1 while the tail rings, 0 once it is ended (last repeat played, unmute,
    /// mute FX off, stems off). Smoothed, so an ended tail fades out instead of stopping dead.
    ret: Smoothed,
    /// Loop that was running at the mute (in-point and length in source frames; length 0 =
    /// none): what was heard before the mute was the loop, so a repeat that reaches back past
    /// the loop start reads from the loop end.
    wrap_in: f64,
    wrap_len: f64,
}

impl StemTail {
    fn new(sr: f32) -> Self {
        StemTail {
            ringing: false,
            origin: 0.0,
            age: 0.0,
            delay: 1.0,
            level: 0.0,
            ret: Smoothed::new(0.0, sr, STEM_TAIL_FADE_MS),
            wrap_in: 0.0,
            wrap_len: 0.0,
        }
    }

    /// No more repeats; the return fades out.
    fn stop(&mut self) {
        self.ringing = false;
        self.ret.set_target(0.0);
    }

    /// Nothing left to hear.
    fn silent(&self) -> bool {
        !self.ringing && self.ret.value() < 1e-4
    }

    /// Sum of the repeats at the tail's playhead, before level and return gain. `fade` =
    /// length in source frames over which a repeat fades once it is past the mute point.
    /// The flag is true when every repeat has played.
    #[inline]
    fn taps(&self, buf: &TrackBuffer, fade: f64) -> (f32, f32, bool) {
        // Repeats below `first` are entirely past the mute point.
        let first = (((self.age - fade) / self.delay).floor() as i64 + 1).max(1);
        if first > STEM_TAIL_TAPS {
            return (0.0, 0.0, true);
        }
        let frames = buf.left.len().min(buf.right.len());
        let head = self.origin + self.age;
        let mut level = STEM_TAIL_FEEDBACK.powi(first as i32);
        let (mut l, mut r) = (0.0f32, 0.0f32);
        for k in first..=STEM_TAIL_TAPS {
            let back = k as f64 * self.delay;
            // Frames this repeat's read point is past the mute point (the send closed there).
            let over = self.age - back;
            let w = if over <= 0.0 {
                1.0
            } else {
                (1.0 - over / fade).max(0.0) as f32
            };
            let mut q = head - back;
            if self.wrap_len > 0.0 && q < self.wrap_in {
                q = self.wrap_in + (q - self.wrap_in).rem_euclid(self.wrap_len);
            }
            if w > 0.0 && q >= 0.0 && (q as usize) + 1 < frames {
                let i = q as usize;
                let f = (q - i as f64) as f32;
                let g = level * w;
                l += (buf.left[i] + (buf.left[i + 1] - buf.left[i]) * f) * g;
                r += (buf.right[i] + (buf.right[i + 1] - buf.right[i]) * f) * g;
            }
            level *= STEM_TAIL_FEEDBACK;
        }
        (l, r, false)
    }
}

/// Next frame of every stem tail, summed. `xf` = the stems' current stem crossfader gains
/// (a stem faded out there takes its tail with it), `step` = source frames per output frame,
/// `fade` = the repeat fade in source frames. Reads preallocated buffers only.
#[inline]
fn render_tails(
    layers: &[Option<TrackBuffer>; MAX_LAYERS],
    tails: &mut [StemTail; MAX_LAYERS],
    xf: [f32; MAX_LAYERS],
    step: f64,
    fade: f64,
) -> (f32, f32) {
    let (mut l, mut r) = (0.0f32, 0.0f32);
    for (i, t) in tails.iter_mut().enumerate() {
        let ret = t.ret.next();
        if t.silent() {
            continue;
        }
        let Some(buf) = layers[i].as_ref() else {
            t.stop();
            continue;
        };
        let (tl, tr, done) = t.taps(buf, fade);
        if done {
            t.stop();
        }
        let g = t.level * ret * xf[i];
        l += tl * g;
        r += tr * g;
        t.age += step;
    }
    (l, r)
}

/// One rendered frame: post-fader main output and the pre-fader cue (PFL) tap.
#[derive(Clone, Copy, Debug, Default)]
pub struct DeckOut {
    pub main: (f32, f32),
    pub pfl: (f32, f32),
}

/// Stretch engine selected at deck construction. `MIXAI_STRETCHER=wsola` picks the
/// pure-Rust WSOLA fallback; the default is Signalsmith Stretch.
fn stretcher_kind_from_env() -> StretcherKind {
    match std::env::var("MIXAI_STRETCHER").as_deref() {
        Ok("wsola") => StretcherKind::Wsola,
        _ => StretcherKind::Signalsmith,
    }
}

/// Interleaved-stereo decoded track plus its native sample rate.
pub struct TrackBuffer {
    /// Left/right planar samples (already converted to f32, -1..1).
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    pub sample_rate: u32,
}

impl TrackBuffer {
    pub fn frames(&self) -> usize {
        self.left.len()
    }

    pub fn duration_secs(&self) -> f64 {
        if self.sample_rate == 0 {
            0.0
        } else {
            self.frames() as f64 / self.sample_rate as f64
        }
    }

    /// Downsample to `bins` amplitude values in 0..1 for the waveform overlay.
    /// Each bin holds the peak (max abs) of the mono mix over its window.
    pub fn compute_peaks(&self, bins: usize) -> Vec<f32> {
        let frames = self.frames();
        if frames == 0 || bins == 0 {
            return Vec::new();
        }
        let bins = bins.min(frames);
        let mut peaks = Vec::with_capacity(bins);
        let window = frames as f64 / bins as f64;
        for b in 0..bins {
            let start = (b as f64 * window) as usize;
            let end = (((b + 1) as f64 * window) as usize)
                .min(frames)
                .max(start + 1);
            let mut peak = 0.0f32;
            for i in start..end {
                let m = (self.left[i].abs() + self.right[i].abs()) * 0.5;
                if m > peak {
                    peak = m;
                }
            }
            peaks.push(peak.min(1.0));
        }
        peaks
    }

    /// One peak lane for a stem display: per point, the peak amplitude (0..255) of the mono
    /// mix. Same point grid as [`TrackBuffer::compute_band_peaks`], so stem lanes line up
    /// with the track's band waveform (and, like it, empty below [`MIN_WAVE_SAMPLE_RATE`]).
    pub fn compute_peak_lane(&self, points_per_second: u32) -> Vec<u8> {
        let frames = self.frames();
        let sr = self.sample_rate;
        if frames == 0 || !wave_grid_ok(sr, points_per_second) {
            return Vec::new();
        }
        let len = (frames as u64 * points_per_second as u64).div_ceil(sr as u64) as usize;
        let mut out = Vec::with_capacity(len);
        let boundary = |p: u64| (p * sr as u64) / points_per_second as u64;
        let mut point = 0u64;
        let mut next = boundary(1);
        let mut peak = 0.0f32;
        for i in 0..frames {
            peak = peak.max(((self.left[i] + self.right[i]) * 0.5).abs());
            if i as u64 + 1 == next {
                out.push((peak.min(1.0) * 255.0).round() as u8);
                peak = 0.0;
                point += 1;
                next = boundary(point + 1);
            }
        }
        if out.len() < len {
            out.push((peak.min(1.0) * 255.0).round() as u8);
        }
        out
    }

    /// Three-band waveform for the scrolling / overview displays: per point, the peak
    /// amplitude (0..255) of the mono mix below 250 Hz, between 250 Hz and 4 kHz, and above
    /// 4 kHz (4th-order crossovers). Point `i` covers source frames
    /// `[floor(i·sr/pps), floor((i+1)·sr/pps))`, so points never drift against the audio clock.
    /// A file that declares a rate below [`MIN_WAVE_SAMPLE_RATE`] gets no waveform (empty).
    pub fn compute_band_peaks(&self, points_per_second: u32) -> BandWave {
        let frames = self.frames();
        let sr = self.sample_rate;
        if frames == 0 || !wave_grid_ok(sr, points_per_second) {
            return BandWave {
                points_per_second,
                ..BandWave::default()
            };
        }
        let len = (frames as u64 * points_per_second as u64).div_ceil(sr as u64) as usize;
        let srf = sr as f32;
        let q = std::f32::consts::FRAC_1_SQRT_2;
        let stage = |low_pass: bool, freq: f32| {
            let mut b = Biquad::identity();
            if low_pass {
                b.low_pass(freq, q, srf);
            } else {
                b.high_pass(freq, q, srf);
            }
            [b, b]
        };
        let mut low_f = stage(true, BAND_LOW_HZ);
        let mut mid_hp = stage(false, BAND_LOW_HZ);
        let mut mid_lp = stage(true, BAND_HIGH_HZ);
        let mut high_f = stage(false, BAND_HIGH_HZ);
        // Two statements: a nested `f[1].process(f[0].process(x))` borrows `f` mutably twice.
        let run = |f: &mut [Biquad; 2], x: f32| {
            let y = f[0].process(x);
            f[1].process(y)
        };
        let mut out = BandWave {
            points_per_second,
            low: Vec::with_capacity(len),
            mid: Vec::with_capacity(len),
            high: Vec::with_capacity(len),
        };
        let quant = |v: f32| (v.min(1.0) * 255.0).round() as u8;
        let boundary = |p: u64| (p * sr as u64) / points_per_second as u64;
        let mut point = 0u64;
        let mut next = boundary(1);
        let (mut pl, mut pm, mut ph) = (0.0f32, 0.0f32, 0.0f32);
        for i in 0..frames {
            let x = (self.left[i] + self.right[i]) * 0.5;
            // One NaN / infinity would stay in the filter state and flatten the rest of the track.
            let x = if x.is_finite() { x } else { 0.0 };
            pl = pl.max(run(&mut low_f, x).abs());
            let m = run(&mut mid_hp, x);
            pm = pm.max(run(&mut mid_lp, m).abs());
            ph = ph.max(run(&mut high_f, x).abs());
            if i as u64 + 1 == next {
                out.low.push(quant(pl));
                out.mid.push(quant(pm));
                out.high.push(quant(ph));
                (pl, pm, ph) = (0.0, 0.0, 0.0);
                point += 1;
                next = boundary(point + 1);
            }
        }
        // Trailing partial point.
        if out.low.len() < len {
            out.low.push(quant(pl));
            out.mid.push(quant(pm));
            out.high.push(quant(ph));
        }
        out
    }
}

/// Crossover between the low and mid waveform bands.
pub const BAND_LOW_HZ: f32 = 250.0;
/// Crossover between the mid and high waveform bands.
pub const BAND_HIGH_HZ: f32 = 4000.0;
/// Lowest file sample rate that gets a waveform. The rate comes from the file header, so it
/// can be anything: far below audio rates the crossovers have no room under Nyquist, and with
/// fewer frames than points per second the point grid collapses.
pub const MIN_WAVE_SAMPLE_RATE: u32 = 1_000;

/// True when a waveform can be built: a usable rate and at least one frame per point (with
/// more points than frames per second the first point boundary is frame 0 and every frame
/// would fall into one trailing point).
fn wave_grid_ok(sample_rate: u32, points_per_second: u32) -> bool {
    sample_rate >= MIN_WAVE_SAMPLE_RATE && points_per_second > 0 && points_per_second <= sample_rate
}

/// Three-band waveform peaks (see [`TrackBuffer::compute_band_peaks`]).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BandWave {
    pub points_per_second: u32,
    pub low: Vec<u8>,
    pub mid: Vec<u8>,
    pub high: Vec<u8>,
}

impl BandWave {
    /// Number of points in every lane.
    pub fn len(&self) -> usize {
        self.low.len()
    }

    pub fn is_empty(&self) -> bool {
        self.low.is_empty()
    }

    /// Wire form for the UI: `[u32 LE points_per_second][u32 LE len]` then the `low`, `mid`
    /// and `high` lanes (`len` bytes each).
    pub fn to_bytes(&self) -> Vec<u8> {
        let n = self.len();
        let mut out = Vec::with_capacity(8 + 3 * n);
        out.extend_from_slice(&self.points_per_second.to_le_bytes());
        out.extend_from_slice(&(n as u32).to_le_bytes());
        out.extend_from_slice(&self.low);
        out.extend_from_slice(&self.mid);
        out.extend_from_slice(&self.high);
        out
    }
}

pub struct Deck {
    pub id: DeckId,
    sr: f32,

    // Loaded audio (None when empty).
    track: Option<TrackBuffer>,

    // Metadata mirrored to the UI.
    pub track_id: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub bpm: f64,

    // Transport.
    pub playing: bool,
    /// Fractional read position in source frames (for varispeed interpolation).
    play_pos: f64,
    /// Effective playback rate = tempo * (track_sr / device_sr).
    rate_ratio: f64,
    pub tempo: f64,
    pub key_lock: bool,

    // Mixer params (smoothed).
    volume: Smoothed,
    /// Channel trim (linear gain, pre-EQ), separate from the fader.
    trim: Smoothed,
    eq_low_db: f32,
    eq_mid_db: f32,
    eq_high_db: f32,
    filter: f32,
    pub crossfader_assign: CrossfaderAssign,
    pub cue: bool,

    // Per-channel DSP state (L/R).
    eq_low: [Biquad; 2],
    eq_mid: [Biquad; 2],
    eq_high: [Biquad; 2],
    filt: [Biquad; 2],
    eq_dirty: bool,
    filter_dirty: bool,

    // Hot cues: up to 8 named positions in source frames (None = unset).
    hot_cues: [Option<f64>; 8],
    // Temporary "cue" point used by the CUE button (press-to-preview).
    cue_point: f64,

    // Loop: active region in source frames. `loop_active` gates wrap-around.
    loop_active: bool,
    loop_in: f64,
    loop_out: f64,
    /// Pending loop length in beats once an in-point is set via beatloop.
    loop_beats: f64,

    // Pitch-independent time-stretch (key lock and/or key shift).
    stretcher: Box<dyn Stretcher>,
    /// True when the last frame came from the stretcher (path switch = re-prime).
    stretching: bool,

    // Beatgrid + performance modes (WP19-05).
    grid: BeatGrid,
    pub quantize: bool,
    slip: bool,
    /// Shadow playhead (source frames) that keeps running while slip is engaged.
    slip_pos: f64,
    slip_engaged: bool,
    reverse: bool,
    /// Key shift in semitones, independent of tempo.
    key_shift: f64,
    /// Continuous sync: tempo follows the master and phase is nudged into place.
    pub sync_lock: bool,
    /// Small tempo factor applied by sync lock for phase correction (1.0 = none).
    sync_nudge: f64,

    // Master clock as seen by this deck (set once per audio block by the mixer).
    clock_bpm: f64,
    clock_beat: f64,
    clock_inc: f64,

    // Colour FX (pre-fader) and beat FX (post-fader), WP19-10.
    color: ColorFx,
    beat: BeatFx,

    // Stems: optional per-layer buffers (vocals, drums, bass, melody) aligned
    // to the full track. When present + `stems_active`, playback sums them with
    // smoothed per-stem gains instead of the full mix — enabling live
    // mute/solo/blend of each stem.
    stems: Option<[Option<TrackBuffer>; MAX_LAYERS]>,
    stems_active: bool,
    stem_gain: [Smoothed; MAX_LAYERS],
    /// Per-stem crossfader position (−1..1, 0 = follows the deck), smoothed as a gain.
    stem_xf_pos: [f32; MAX_LAYERS],
    stem_xf: [Smoothed; MAX_LAYERS],
    /// Crossfader law of the mixer (set once per block, see [`Deck::set_xf_context`]).
    xf_curve: u8,
    /// Crossfader side the stem crossfader gains were derived for.
    xf_assign: CrossfaderAssign,
    /// Stem mute FX on: a muted stem leaves an echo tail ([`StemTail`]).
    stem_mute_fx: bool,
    /// Echo time of the stem mute FX in beats.
    stem_mute_fx_beats: f64,
    stem_tails: [StemTail; MAX_LAYERS],
    /// Level each stem had when it was last muted (what an unmute brings back).
    stem_pre_mute: [f32; MAX_LAYERS],
    /// Loop length in beats stored on each hot cue (cue loops), `None` = a plain cue.
    hot_cue_loops: [Option<f64>; 8],

    // Per-deck FX unit (beat-synced echo / reverb).
    fx: Fx,
    /// Selected FX, mirrored for snapshot.
    fx_kind: FxKind,
    /// FX beat length (for echo time = beats × beat-duration).
    fx_beats: f64,

    // VU follower.
    vu: f32,
}

impl Deck {
    pub fn new(id: DeckId, sr: f32) -> Self {
        let mut deck = Deck {
            id,
            sr,
            track: None,
            track_id: None,
            title: None,
            artist: None,
            bpm: 0.0,
            playing: false,
            play_pos: 0.0,
            rate_ratio: 1.0,
            tempo: 1.0,
            key_lock: true,
            volume: Smoothed::new(0.85, sr, 12.0),
            trim: Smoothed::new(1.0, sr, TRIM_SMOOTH_MS),
            eq_low_db: 0.0,
            eq_mid_db: 0.0,
            eq_high_db: 0.0,
            filter: 0.0,
            crossfader_assign: DeckState::empty(id).crossfader_assign,
            cue: false,
            eq_low: [Biquad::identity(); 2],
            eq_mid: [Biquad::identity(); 2],
            eq_high: [Biquad::identity(); 2],
            filt: [Biquad::identity(); 2],
            eq_dirty: true,
            filter_dirty: true,
            hot_cues: [None; 8],
            cue_point: 0.0,
            loop_active: false,
            loop_in: 0.0,
            loop_out: 0.0,
            loop_beats: 4.0,
            stretcher: make_stretcher(stretcher_kind_from_env(), sr),
            stretching: false,
            grid: BeatGrid::default(),
            quantize: false,
            slip: false,
            slip_pos: 0.0,
            slip_engaged: false,
            reverse: false,
            key_shift: 0.0,
            sync_lock: false,
            sync_nudge: 1.0,
            clock_bpm: 120.0,
            clock_beat: 0.0,
            clock_inc: 0.0,
            color: ColorFx::new(sr),
            beat: BeatFx::new(sr),
            stems: None,
            stems_active: false,
            stem_gain: [
                Smoothed::new(1.0, sr, STEM_SMOOTH_MS),
                Smoothed::new(1.0, sr, STEM_SMOOTH_MS),
                Smoothed::new(1.0, sr, STEM_SMOOTH_MS),
                Smoothed::new(1.0, sr, STEM_SMOOTH_MS),
            ],
            stem_xf_pos: [0.0; MAX_LAYERS],
            stem_xf: [
                Smoothed::new(1.0, sr, STEM_SMOOTH_MS),
                Smoothed::new(1.0, sr, STEM_SMOOTH_MS),
                Smoothed::new(1.0, sr, STEM_SMOOTH_MS),
                Smoothed::new(1.0, sr, STEM_SMOOTH_MS),
            ],
            xf_curve: 1,
            xf_assign: DeckState::empty(id).crossfader_assign,
            stem_mute_fx: false,
            stem_mute_fx_beats: crate::state::STEM_MUTE_FX_BEATS,
            stem_tails: [StemTail::new(sr); MAX_LAYERS],
            stem_pre_mute: [1.0; MAX_LAYERS],
            hot_cue_loops: [None; 8],
            fx: Fx::new(sr),
            fx_kind: FxKind::Off,
            fx_beats: 0.5,
            vu: 0.0,
        };
        deck.recompute_eq();
        deck.recompute_filter();
        deck
    }

    pub fn load(
        &mut self,
        buffer: TrackBuffer,
        meta: (Option<String>, Option<String>, Option<String>, f64),
    ) {
        self.rate_ratio = buffer.sample_rate as f64 / self.sr as f64;
        self.track = Some(buffer);
        self.track_id = meta.0;
        self.title = meta.1;
        self.artist = meta.2;
        self.bpm = meta.3;
        self.play_pos = 0.0;
        self.playing = false;
        // Reset performance state for the new track.
        self.hot_cues = [None; 8];
        self.hot_cue_loops = [None; 8];
        self.cue_point = 0.0;
        self.loop_active = false;
        self.loop_in = 0.0;
        self.loop_out = 0.0;
        self.stretcher.reset(0.0);
        self.stretching = false;
        // Constant grid from the supplied BPM until a real grid arrives (SetGrid).
        self.grid = BeatGrid::constant(self.bpm, 0.0);
        self.slip_pos = 0.0;
        self.slip_engaged = false;
        self.reverse = false;
        self.sync_nudge = 1.0;
        // New track invalidates any previously loaded stems.
        self.stems = None;
        self.stems_active = false;
        for t in self.stem_tails.iter_mut() {
            *t = StemTail::new(self.sr);
        }
        // Re-size the FX echo time to the new track's tempo grid.
        self.recompute_fx_time();
    }

    pub fn loaded(&self) -> bool {
        self.track.is_some()
    }

    /// Move the deck to a new device sample rate (off the audio thread: rebuilds the
    /// sample-rate dependent DSP and keeps track, playhead, cues, loops and settings).
    pub fn set_sample_rate(&mut self, sr: f32) {
        if !sr.is_finite() || sr <= 0.0 || (sr - self.sr).abs() < f32::EPSILON {
            return;
        }
        self.sr = sr;
        if let Some(t) = &self.track {
            self.rate_ratio = t.sample_rate as f64 / sr as f64;
        }
        self.volume.set_rate(sr, 12.0);
        self.trim.set_rate(sr, TRIM_SMOOTH_MS);
        for g in self.stem_gain.iter_mut() {
            g.set_rate(sr, STEM_SMOOTH_MS);
        }
        for g in self.stem_xf.iter_mut() {
            g.set_rate(sr, STEM_SMOOTH_MS);
        }
        for t in self.stem_tails.iter_mut() {
            t.ret.set_rate(sr, STEM_TAIL_FADE_MS);
        }
        self.eq_dirty = true;
        self.filter_dirty = true;
        self.stretcher = make_stretcher(stretcher_kind_from_env(), sr);
        self.stretcher.reset(self.play_pos);
        self.stretching = false;
        let (ck, cp) = (self.color.kind(), self.color.param());
        self.color = ColorFx::new(sr);
        self.color.set(ck, cp);
        let (bk, bw, bb, bf) = self.beat.settings();
        self.beat = BeatFx::new(sr);
        self.beat.set(bk, bw, bb, bf);
        let (fw, ffb) = (self.fx.wet_target(), self.fx.feedback());
        self.fx = Fx::new(sr);
        self.fx.set_kind(self.fx_kind);
        self.fx.set_wet(fw);
        self.fx.set_feedback(ffb);
        self.recompute_fx_time();
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    pub fn play(&mut self) {
        if self.loaded() {
            self.playing = true;
        }
    }

    pub fn pause(&mut self) {
        self.playing = false;
    }

    pub fn seek_secs(&mut self, secs: f64) {
        if let Some(t) = &self.track {
            let frame = (secs * t.sample_rate as f64).clamp(0.0, t.frames() as f64);
            self.jump_to(frame);
        }
    }

    /// Move the playhead (source frames), re-priming the stretcher. While slip is
    /// engaged the shadow playhead is left alone.
    fn jump_to(&mut self, frame: f64) {
        let max = self
            .track
            .as_ref()
            .map(|t| t.frames() as f64)
            .unwrap_or(0.0);
        self.play_pos = frame.clamp(0.0, max);
        self.stretcher.reset(self.play_pos);
        if !self.slip_engaged {
            self.slip_pos = self.play_pos;
        }
    }

    // ---- beatgrid / sync (WP19-05) -----------------------------------------

    /// Replace the beatgrid (seconds-based; see [`BeatGrid`]).
    pub fn set_grid(&mut self, grid: BeatGrid) {
        if grid.is_valid() && !grid.anchors.is_empty() {
            // Keep metadata BPM in step with the grid for FX timing.
            self.bpm = grid.bpm_at(self.pos_secs());
        } else if grid.bpm > 0.0 {
            self.bpm = grid.bpm;
        }
        self.grid = grid;
        self.recompute_fx_time();
    }

    pub fn grid(&self) -> &BeatGrid {
        &self.grid
    }

    pub fn grid_valid(&self) -> bool {
        self.loaded() && self.grid.is_valid()
    }

    /// Exact playhead in seconds of source audio.
    pub fn pos_secs(&self) -> f64 {
        self.play_pos / self.track_sr()
    }

    /// Raw playhead in source frames.
    pub fn position_frames(&self) -> f64 {
        self.play_pos
    }

    /// Shadow (slip) playhead in source frames.
    pub fn slip_position_frames(&self) -> f64 {
        self.slip_pos
    }

    /// Fractional beat number at the playhead.
    pub fn beat_pos(&self) -> f64 {
        self.grid.beat_at(self.pos_secs())
    }

    /// Track tempo (grid) at the playhead, before the tempo fader.
    pub fn local_bpm(&self) -> f64 {
        let b = self.grid.bpm_at(self.pos_secs());
        if b > 0.0 { b } else { self.bpm }
    }

    /// Audible tempo: grid tempo × tempo fader × sync nudge.
    pub fn effective_bpm(&self) -> f64 {
        self.local_bpm() * self.tempo * self.sync_nudge
    }

    pub fn bar_phase(&self) -> Option<f64> {
        self.grid.bar_phase(self.pos_secs())
    }

    /// Shift the playhead by a (fractional) number of beats along the grid.
    pub fn shift_beats(&mut self, delta: f64) {
        if !self.grid_valid() {
            return;
        }
        let target = self.grid.time_at(self.beat_pos() + delta) * self.track_sr();
        self.jump_to(target);
    }

    /// Master clock for this audio block: tempo, beat at block start, beats per frame.
    pub fn set_clock(&mut self, bpm: f64, beat: f64, inc: f64) {
        self.clock_bpm = bpm;
        self.clock_beat = beat;
        self.clock_inc = inc;
    }

    /// Sync-lock correction factor (clamped ±5 %).
    pub fn set_sync_nudge(&mut self, nudge: f64) {
        self.sync_nudge = nudge.clamp(0.95, 1.05);
    }

    pub fn set_quantize(&mut self, on: bool) {
        self.quantize = on;
    }

    /// Snap a source frame to the nearest beat when quantize is on.
    fn snap(&self, frame: f64) -> f64 {
        if self.quantize && self.grid_valid() {
            let sr = self.track_sr();
            (self.grid.nearest_beat_time(frame / sr) * sr).max(0.0)
        } else {
            frame
        }
    }

    /// Jump target honouring quantize: paused = snap to the beat; playing = keep the
    /// playhead's current sub-beat phase so a synced deck stays in time.
    fn quantized_target(&self, target: f64) -> f64 {
        if !(self.quantize && self.grid_valid()) {
            return target;
        }
        if !self.playing {
            return self.snap(target);
        }
        let sr = self.track_sr();
        let cur = self.beat_pos();
        let tb = self.grid.beat_at(target / sr).round() + (cur - cur.round());
        (self.grid.time_at(tb) * sr).max(0.0)
    }

    /// Beat-jump by `beats` (±1/2/4/8/16/32, fractions allowed). An active loop
    /// moves with the playhead.
    pub fn beat_jump(&mut self, beats: f64) {
        if !self.grid_valid() || !beats.is_finite() {
            return;
        }
        let beats = beats.clamp(-64.0, 64.0);
        let sr = self.track_sr();
        let cur = self.beat_pos();
        let mut nb = cur + beats;
        if self.quantize && !self.playing {
            nb = nb.round();
        }
        let target = (self.grid.time_at(nb) * sr).max(0.0);
        let delta = target - self.play_pos;
        if self.loop_active {
            self.loop_in += delta;
            self.loop_out += delta;
        }
        self.jump_to(target);
    }

    /// Slip mode: during loops / reverse the shadow playhead keeps running and the
    /// deck returns to it on release.
    pub fn set_slip(&mut self, on: bool) {
        self.slip = on;
        if !self.slip_engaged {
            self.slip_pos = self.play_pos;
        }
    }

    pub fn slip(&self) -> bool {
        self.slip
    }

    /// True while slip is holding a shadow playhead (slip on + loop or reverse running).
    pub fn slip_engaged(&self) -> bool {
        self.slip_engaged
    }

    /// Shadow playhead in seconds while slip is engaged, else `None`.
    pub fn slip_shadow_secs(&self) -> Option<f64> {
        (self.slip_engaged && self.loaded()).then(|| self.slip_pos / self.track_sr())
    }

    /// Reverse playback (censor when combined with slip).
    pub fn set_reverse(&mut self, on: bool) {
        self.reverse = on;
    }

    /// Key shift in semitones (independent of tempo, via the stretcher).
    pub fn set_key_shift(&mut self, semitones: f64) {
        self.key_shift = if semitones.is_finite() {
            semitones.clamp(-KEY_SHIFT_MAX, KEY_SHIFT_MAX)
        } else {
            0.0
        };
    }

    pub fn key_shift(&self) -> f64 {
        self.key_shift
    }

    // ---- colour / beat FX (WP19-10) ----------------------------------------

    pub fn set_color_fx(&mut self, kind: ColorFxKind, param: f32) {
        self.color.set(kind, param);
    }

    pub fn set_beat_fx(&mut self, kind: BeatFxKind, wet: f32, beats: f64, feedback: f32) {
        self.beat.set(kind, wet, beats, feedback);
    }

    pub fn stretcher_name(&self) -> &'static str {
        self.stretcher.name()
    }

    pub fn set_volume(&mut self, v: f32) {
        self.volume.set_target(v.clamp(0.0, 1.0));
    }

    /// Channel trim in dB (−∞..+12, 0 = unity), applied pre-EQ and separate from the fader.
    pub fn set_trim_db(&mut self, db: f32) {
        self.trim.set_target(trim_gain(db));
    }

    /// Target trim as linear gain.
    pub fn trim_gain(&self) -> f32 {
        self.trim.target()
    }

    pub fn set_tempo(&mut self, t: f64) {
        if t.is_finite() {
            self.tempo = t.clamp(TEMPO_MIN, TEMPO_MAX);
            self.recompute_fx_time();
        }
    }

    pub fn set_key_lock(&mut self, on: bool) {
        self.key_lock = on;
        // Re-prime the stretcher from the current playhead so toggling is clean.
        self.stretcher.reset(self.play_pos);
    }

    pub fn set_eq(&mut self, band: &str, db: f32) {
        let db = db.clamp(-26.0, 6.0);
        match band {
            "low" => self.eq_low_db = db,
            "mid" => self.eq_mid_db = db,
            "high" => self.eq_high_db = db,
            _ => {}
        }
        self.eq_dirty = true;
    }

    pub fn set_filter(&mut self, v: f32) {
        self.filter = v.clamp(-1.0, 1.0);
        self.filter_dirty = true;
    }

    pub fn set_cue(&mut self, on: bool) {
        self.cue = on;
    }

    // ---- stems ----------------------------------------------------------

    /// Attach separated stems (vocals, drums, bass, melody) and enable stem
    /// playback. Buffers should be aligned to the full track; reads clamp to
    /// the shortest present layer. Passing all-None disables stems.
    pub fn set_stems(&mut self, layers: [Option<TrackBuffer>; MAX_LAYERS]) {
        let any = layers.iter().any(|l| l.is_some());
        for t in self.stem_tails.iter_mut() {
            *t = StemTail::new(self.sr);
        }
        if any {
            self.stems = Some(layers);
            self.stems_active = true;
        } else {
            self.stems = None;
            self.stems_active = false;
        }
    }

    /// Turn stem playback on/off without discarding the loaded stem buffers. Turning it off
    /// ends every mute FX tail: no more repeats, and what is sounding fades out over a few
    /// milliseconds (a tail cut in one sample clicks).
    pub fn set_stems_active(&mut self, on: bool) {
        if self.stems.is_some() {
            self.stems_active = on;
            if !on {
                for t in self.stem_tails.iter_mut() {
                    t.stop();
                }
            }
        }
    }

    /// Set the gain (0..1) for stem `idx` (0=vocals,1=drums,2=bass,3=melody).
    /// Bringing a stem back by its level ends its mute FX tail, like an unmute. A non-finite
    /// gain is ignored: it would pass the clamp and never leave the smoothed gain (that stem
    /// would be silence or garbage until the engine restarts).
    pub fn set_stem_gain(&mut self, idx: usize, gain: f32) {
        if idx < MAX_LAYERS && gain.is_finite() {
            let gain = gain.clamp(0.0, 1.5);
            self.stem_gain[idx].set_target(gain);
            if gain > STEM_SILENT {
                self.stem_tails[idx].stop();
            }
        }
    }

    /// Mute (`on`) or unmute stem `idx`: a mute takes the level to 0 and keeps the level the
    /// stem had, an unmute brings that level back ([`stem_mute_step`]). With the stem mute FX
    /// on, a mute leaves an echo tail of the stem at the echo time
    /// ([`Deck::set_stem_mute_fx`]); an unmute fades the tail out. Nothing happens for a stem
    /// that is already in that state.
    ///
    /// No tail, so a plain mute, when nothing was sounding (paused deck), when the deck has no
    /// tempo (the echo time is in beats) and in reverse playback (the tail reads the track
    /// forward from the mute point: in reverse that is audio that was never heard).
    pub fn set_stem_mute(&mut self, idx: usize, on: bool) {
        if idx >= MAX_LAYERS {
            return;
        }
        let level = self.stem_gain[idx].target();
        let Some((gain, keep)) = stem_mute_step(level, self.stem_pre_mute[idx], on) else {
            return;
        };
        self.stem_pre_mute[idx] = keep;
        self.stem_gain[idx].set_target(gain);
        if !on {
            self.stem_tails[idx].stop();
            return;
        }
        if self.stem_mute_fx && self.stems_on() && self.playing && !self.reverse {
            let delay = self.stem_tail_delay();
            // Armed only with a real echo time: a tail without one has no repeats, and its
            // return gain left open would let a burst through.
            if delay > 0.0 && delay.is_finite() {
                let (wrap_in, wrap_len) = if self.loop_active && self.loop_out > self.loop_in {
                    (self.loop_in, self.loop_out - self.loop_in)
                } else {
                    (0.0, 0.0)
                };
                let t = &mut self.stem_tails[idx];
                t.ringing = true;
                t.origin = self.play_pos;
                t.age = 0.0;
                t.delay = delay.max(1.0);
                t.level = level;
                t.wrap_in = wrap_in;
                t.wrap_len = wrap_len;
                t.ret.set_target(1.0);
            }
        }
    }

    /// Stem crossfader of stem `idx`: −1 = side A .. +1 = side B, 0 = follows the deck
    /// ([`stem_xf_gain`]). Non-finite values are ignored.
    pub fn set_stem_xf(&mut self, idx: usize, pos: f32) {
        if idx < MAX_LAYERS && pos.is_finite() {
            self.stem_xf_pos[idx] = pos.clamp(-1.0, 1.0);
            self.retarget_stem_xf();
        }
    }

    /// The mixer's crossfader law for this block (the stem crossfader follows it and the
    /// deck's crossfader side).
    pub fn set_xf_context(&mut self, curve: u8) {
        if curve != self.xf_curve || self.crossfader_assign != self.xf_assign {
            self.xf_curve = curve;
            self.xf_assign = self.crossfader_assign;
            self.retarget_stem_xf();
        }
    }

    /// Re-derive the stem crossfader gain targets (position, side or law changed).
    fn retarget_stem_xf(&mut self) {
        let (side, curve) = (self.crossfader_assign, self.xf_curve);
        for (gain, pos) in self.stem_xf.iter_mut().zip(self.stem_xf_pos) {
            gain.set_target(stem_xf_gain(pos, side, curve));
        }
    }

    /// Stem crossfader positions.
    pub fn stem_xf(&self) -> [f32; MAX_LAYERS] {
        self.stem_xf_pos
    }

    /// Stem mute FX on/off and its echo time in beats ([`STEM_MUTE_FX_BEATS_MIN`]..
    /// [`STEM_MUTE_FX_BEATS_MAX`]; non-finite = unchanged). Turning it off ends a running tail.
    pub fn set_stem_mute_fx(&mut self, on: bool, beats: f64) {
        self.stem_mute_fx = on;
        if beats.is_finite() {
            self.stem_mute_fx_beats = beats.clamp(STEM_MUTE_FX_BEATS_MIN, STEM_MUTE_FX_BEATS_MAX);
        }
        if !on {
            for t in self.stem_tails.iter_mut() {
                t.stop();
            }
        }
    }

    /// (on, beats) of the stem mute FX.
    pub fn stem_mute_fx(&self) -> (bool, f64) {
        (self.stem_mute_fx, self.stem_mute_fx_beats)
    }

    /// Source frames a stem tail advances per output frame: the rate the stem itself is heard
    /// at (varispeed: the tempo; key lock: the original pitch, with the key shift).
    fn stem_tail_step(&self) -> f64 {
        let speed = self.tempo * self.sync_nudge;
        let shift = 2f64.powf(self.key_shift / 12.0);
        let pitch = if self.reverse {
            speed
        } else if self.key_lock {
            shift
        } else {
            shift * speed
        };
        pitch * self.rate_ratio
    }

    /// Echo time of the stem mute FX in source frames of the tail (0 without a tempo): the
    /// chosen number of AUDIBLE beats.
    fn stem_tail_delay(&self) -> f64 {
        let bpm = self.effective_bpm();
        if bpm > 0.0 {
            60.0 / bpm * self.stem_mute_fx_beats * self.sr as f64 * self.stem_tail_step()
        } else {
            0.0
        }
    }

    /// A stem tail still has repeats to play. A tail that was cut short (unmute, mute FX off,
    /// stems off) is not live any more; it fades out over a few milliseconds.
    pub fn stem_tail_live(&self) -> bool {
        self.stem_tails.iter().any(|t| t.ringing)
    }

    /// A stem tail has something to render: repeats still due, or a fade-out still audible.
    fn stem_tail_audible(&self) -> bool {
        self.stem_tails.iter().any(|t| !t.silent())
    }

    /// True when stems are loaded and active.
    pub fn stems_on(&self) -> bool {
        self.stems_active && self.stems.is_some()
    }

    /// True when stems are loaded (regardless of active state).
    pub fn has_stems(&self) -> bool {
        self.stems.is_some()
    }

    // ---- FX -------------------------------------------------------------

    /// Select the active effect (0=off, 1=echo, 2=reverb).
    pub fn set_fx_kind(&mut self, kind: u8) {
        self.fx_kind = FxKind::from_u8(kind);
        self.fx.set_kind(self.fx_kind);
    }

    /// Set the FX wet/dry mix (0..1).
    pub fn set_fx_wet(&mut self, wet: f32) {
        self.fx.set_wet(wet);
    }

    /// Set the echo time in beats (¼, ½, 1, 2…); recomputes the delay length
    /// from the deck's current effective BPM.
    pub fn set_fx_beats(&mut self, beats: f64) {
        self.fx_beats = beats.max(0.03125);
        self.recompute_fx_time();
    }

    /// Recompute the echo delay length from BPM × tempo × beats.
    fn recompute_fx_time(&mut self) {
        let eff_bpm = self.bpm * self.tempo;
        if eff_bpm > 0.0 {
            let beat_secs = 60.0 / eff_bpm;
            let samples = (beat_secs * self.fx_beats * self.sr as f64) as usize;
            self.fx.set_echo_samples(samples.max(1));
        }
    }

    // ---- hot cues -------------------------------------------------------

    fn track_sr(&self) -> f64 {
        self.track
            .as_ref()
            .map(|t| t.sample_rate as f64)
            .unwrap_or(self.sr as f64)
    }

    /// Set hot cue `slot` (0..7) to the current playhead (snapped when quantize is on).
    /// The result is a plain cue: a loop stored on that slot before is dropped.
    pub fn set_hot_cue(&mut self, slot: usize) {
        if slot < 8 && self.loaded() {
            self.hot_cues[slot] = Some(self.snap(self.play_pos));
            self.hot_cue_loops[slot] = None;
        }
    }

    /// Jump to hot cue `slot` if set. Returns true when a jump happened.
    /// A cue that carries a loop (see [`Deck::save_cue_loop`]) also starts that loop there.
    pub fn jump_hot_cue(&mut self, slot: usize) -> bool {
        if let Some(pos) = self.hot_cues.get(slot).copied().flatten() {
            let mut target = self.quantized_target(pos);
            if let Some(beats) = self.hot_cue_loops.get(slot).copied().flatten() {
                // The loop sits at the stored cue even when quantize moved the landing point.
                // Quantize on a playing deck lands up to half a beat after the cue's beat, which
                // is past the end of a shorter loop: fold the landing point into the loop, so
                // the deck jumps once (a playhead left past the end wraps on the next frame).
                if self.loop_from(pos, beats) && target >= self.loop_out {
                    let len = self.loop_out - self.loop_in;
                    target = self.loop_in + (target - self.loop_in).rem_euclid(len);
                }
            }
            self.jump_to(target);
            return true;
        }
        false
    }

    /// Clear hot cue `slot` (and the loop stored on it).
    pub fn clear_hot_cue(&mut self, slot: usize) {
        if slot < 8 {
            self.hot_cues[slot] = None;
            self.hot_cue_loops[slot] = None;
        }
    }

    /// Cue loop: store the running loop on hot cue `slot` (the cue moves to the loop's
    /// in-point, the loop length in beats is kept with it). Without a running loop the slot's
    /// loop is removed and the cue stays. Returns true when a loop was stored.
    pub fn save_cue_loop(&mut self, slot: usize) -> bool {
        if slot >= 8 || !self.loaded() {
            return false;
        }
        if !(self.loop_active && self.loop_out > self.loop_in) {
            self.hot_cue_loops[slot] = None;
            return false;
        }
        let sr = self.track_sr();
        let beats = if self.grid_valid() {
            self.grid.beat_at(self.loop_out / sr) - self.grid.beat_at(self.loop_in / sr)
        } else if self.bpm > 0.0 {
            (self.loop_out - self.loop_in) / sr * self.bpm / 60.0
        } else {
            return false;
        };
        if !(beats.is_finite() && beats > 0.0) {
            return false;
        }
        self.hot_cues[slot] = Some(self.loop_in);
        self.hot_cue_loops[slot] = Some(beats);
        true
    }

    /// Loop lengths in beats stored on the hot cues (`None` = a plain cue).
    pub fn hot_cue_loops(&self) -> [Option<f64>; 8] {
        self.hot_cue_loops
    }

    /// Activate a `beats`-long loop from source frame `start` (grid-aware like
    /// [`Deck::beatloop`], but at a given point and never snapped). True when the loop was set.
    fn loop_from(&mut self, start: f64, beats: f64) -> bool {
        if !(beats.is_finite() && beats > 0.0) {
            return false;
        }
        let sr = self.track_sr();
        let out = if self.grid_valid() {
            self.grid.time_at(self.grid.beat_at(start / sr) + beats) * sr
        } else if self.bpm > 0.0 {
            start + (60.0 / self.bpm) * sr * beats
        } else {
            return false;
        };
        if out > start {
            self.loop_beats = beats;
            self.loop_in = start;
            self.loop_out = out;
            self.loop_active = true;
            true
        } else {
            false
        }
    }

    /// Positions (in seconds) of set hot cues, for the UI overlay.
    pub fn hot_cue_secs(&self) -> [Option<f64>; 8] {
        let sr = self.track_sr();
        let mut out = [None; 8];
        for (i, c) in self.hot_cues.iter().enumerate() {
            out[i] = c.map(|f| f / sr);
        }
        out
    }

    // ---- loops ----------------------------------------------------------

    /// Set the loop in-point to the current playhead.
    pub fn loop_in(&mut self) {
        self.loop_in = self.snap(self.play_pos);
    }

    /// Set the loop out-point to the current playhead and activate.
    pub fn loop_out(&mut self) {
        let out = self.snap(self.play_pos);
        if out > self.loop_in {
            self.loop_out = out;
            self.loop_active = true;
        }
    }

    /// Toggle the current loop on/off (keeps the in/out boundaries).
    pub fn loop_toggle(&mut self) {
        if self.loop_active {
            self.loop_active = false;
        } else if self.loop_out > self.loop_in {
            self.loop_active = true;
        }
    }

    pub fn loop_exit(&mut self) {
        self.loop_active = false;
    }

    /// Beat-loop: set an `beats`-long loop starting at the current playhead,
    /// using the track BPM to size it. Activates immediately.
    pub fn beatloop(&mut self, beats: f64) {
        if !self.loaded() || beats.is_nan() || beats <= 0.0 {
            return;
        }
        self.loop_beats = beats;
        let sr = self.track_sr();
        if self.grid_valid() {
            // Grid-aware: start (snapped when quantize is on) + `beats` along the grid.
            let start = self.snap(self.play_pos);
            let b0 = self.grid.beat_at(start / sr);
            self.loop_in = start;
            self.loop_out = self.grid.time_at(b0 + beats) * sr;
        } else if self.bpm > 0.0 {
            let frames_per_beat = (60.0 / self.bpm) * sr;
            self.loop_in = self.play_pos;
            self.loop_out = self.play_pos + frames_per_beat * beats;
        } else {
            return;
        }
        self.loop_active = true;
    }

    /// Halve / double the active loop length around the in-point.
    pub fn loop_scale(&mut self, factor: f64) {
        if self.loop_active && self.loop_out > self.loop_in {
            let len = (self.loop_out - self.loop_in) * factor;
            self.loop_out = self.loop_in + len.max(16.0);
        }
    }

    pub fn loop_state_secs(&self) -> (bool, f64, f64) {
        let sr = self.track_sr();
        (self.loop_active, self.loop_in / sr, self.loop_out / sr)
    }

    fn recompute_eq(&mut self) {
        for ch in 0..2 {
            self.eq_low[ch].low_shelf(320.0, self.eq_low_db, self.sr);
            self.eq_mid[ch].peaking(1000.0, self.eq_mid_db, 0.7, self.sr);
            self.eq_high[ch].high_shelf(3200.0, self.eq_high_db, self.sr);
        }
        self.eq_dirty = false;
    }

    fn recompute_filter(&mut self) {
        for ch in 0..2 {
            if self.filter.abs() < 0.02 {
                self.filt[ch] = Biquad::identity();
            } else if self.filter < 0.0 {
                // Left → low-pass, exponential 20k → 200 Hz.
                let f = 200.0 * (20000.0f32 / 200.0).powf(1.0 + self.filter); // filter in -1..0
                self.filt[ch].low_pass(f, 0.9, self.sr);
            } else {
                // Right → high-pass, exponential 20 → 8k Hz.
                let f = 20.0 * (8000.0f32 / 20.0).powf(self.filter);
                self.filt[ch].high_pass(f, 0.9, self.sr);
            }
        }
        self.filter_dirty = false;
    }

    pub fn position_secs(&self) -> f64 {
        match &self.track {
            Some(t) if t.sample_rate > 0 => self.play_pos / t.sample_rate as f64,
            _ => 0.0,
        }
    }

    pub fn duration_secs(&self) -> f64 {
        self.track
            .as_ref()
            .map(|t| t.duration_secs())
            .unwrap_or(0.0)
    }

    pub fn vu(&self) -> f32 {
        self.vu
    }

    /// Render the next frame from this deck. `main` is post EQ/filter/colour/
    /// volume/FX (pre-crossfader); `pfl` is the pre-fader cue tap (silent unless
    /// the deck's CUE button is on). Advances the playhead.
    #[inline]
    pub fn render_frame(&mut self) -> DeckOut {
        if self.eq_dirty {
            self.recompute_eq();
        }
        if self.filter_dirty {
            self.recompute_filter();
        }

        let vol = self.volume.next();
        let trim = self.trim.next();

        // Advance per-stem smoothed gains (level × stem crossfader) every frame (cheap, keeps
        // mute/blend click-free). Captured into locals so the disjoint borrow below can
        // still take `&mut stretcher` alongside `&track`/`&stems`.
        let xf = [
            self.stem_xf[0].next(),
            self.stem_xf[1].next(),
            self.stem_xf[2].next(),
            self.stem_xf[3].next(),
        ];
        let sg = [
            self.stem_gain[0].next() * xf[0],
            self.stem_gain[1].next() * xf[1],
            self.stem_gain[2].next() * xf[2],
            self.stem_gain[3].next() * xf[3],
        ];

        // Slip: engage while a loop or reverse runs, return to the shadow on release.
        let want_slip = self.slip && (self.loop_active || self.reverse);
        if want_slip && !self.slip_engaged {
            self.slip_engaged = true;
            self.slip_pos = self.play_pos;
        } else if !want_slip && self.slip_engaged {
            self.slip_engaged = false;
            let back = self.slip_pos;
            self.jump_to(back);
        }

        let speed = self.tempo * self.sync_nudge;
        let (mut l, mut r) = (0.0f32, 0.0f32);
        if self.playing {
            let shift = 2f64.powf(self.key_shift / 12.0);
            let use_stretch = (self.key_lock || self.key_shift.abs() > 1e-3) && !self.reverse;
            // Key lock off + key shift on: tempo still bends pitch (turntable feel).
            let pitch = if self.key_lock { shift } else { shift * speed };
            // Disjoint borrows: the stretcher needs `&mut`, the track `&`.
            let Self {
                track,
                stems,
                stems_active,
                stretcher,
                stretching,
                play_pos,
                playing,
                rate_ratio,
                loop_active,
                loop_in,
                loop_out,
                reverse,
                slip_engaged,
                slip_pos,
                ..
            } = self;
            // Build the playback source: either the full track (single layer)
            // or the active stems summed with their current gains.
            let use_stems = *stems_active && stems.is_some();
            let src = if use_stems {
                let layers_ref = stems.as_ref().unwrap();
                let mut layers: [Option<(&[f32], &[f32])>; MAX_LAYERS] = [None; MAX_LAYERS];
                for (i, layer) in layers_ref.iter().enumerate() {
                    if let Some(b) = layer {
                        layers[i] = Some((b.left.as_slice(), b.right.as_slice()));
                    }
                }
                StemMix::stems(layers, sg)
            } else if let Some(t) = track.as_ref() {
                StemMix::single(&t.left, &t.right)
            } else {
                StemMix::single(&[], &[])
            };

            if !src.is_empty() {
                let frames = src.len();
                let step = speed * *rate_ratio;
                if use_stretch {
                    if !*stretching {
                        stretcher.reset(*play_pos);
                        *stretching = true;
                    }
                    match stretcher.next_frame(&src, speed, *rate_ratio, pitch) {
                        Some((sl, sr)) => {
                            l = sl;
                            r = sr;
                            *play_pos = stretcher.position();
                        }
                        None => *playing = false,
                    }
                    if *loop_active && *loop_out > *loop_in && *play_pos >= *loop_out {
                        // Folded into the loop in ONE wrap, however far past the end the
                        // playhead is (a seek past a running loop): each wrap resets the
                        // stretcher. One frame past the end, the usual case, is unchanged.
                        let len = *loop_out - *loop_in;
                        *play_pos = *loop_in + (*play_pos - *loop_out).rem_euclid(len);
                        stretcher.reset(*play_pos);
                    }
                } else {
                    *stretching = false;
                    // Varispeed path: tempo also shifts pitch (turntable feel).
                    let pos = *play_pos;
                    if pos >= 0.0 && (pos as usize) < frames.saturating_sub(1) {
                        let (sl, sr) = src.read_stereo(pos);
                        l = sl;
                        r = sr;
                        if *reverse {
                            *play_pos = (pos - step).max(0.0);
                        } else {
                            *play_pos = pos + step;
                            if *loop_active && *loop_out > *loop_in && *play_pos >= *loop_out {
                                let len = *loop_out - *loop_in;
                                *play_pos = *loop_in + (*play_pos - *loop_out).rem_euclid(len);
                            }
                        }
                    } else if !*reverse {
                        *playing = false;
                    }
                }
                if *slip_engaged {
                    *slip_pos = (*slip_pos + step).min(frames as f64);
                }
            }
        }

        // Stem mute FX: echo tails of muted stems join the stem mix (they keep sounding while
        // the deck is paused, like a delay line would). With stems switched off there are no
        // repeats any more, only the short fade-out of a tail that was ringing.
        if self.stem_tail_audible() {
            let step = self.stem_tail_step();
            let fade = STEM_TAIL_FADE_MS as f64 / 1000.0 * self.track_sr();
            if let Some(layers) = self.stems.as_ref() {
                let (tl, tr) = render_tails(layers, &mut self.stem_tails, xf, step, fade);
                l += tl;
                r += tr;
            }
        }

        // Trim (pre-EQ), then the EQ chain.
        l *= trim;
        r *= trim;
        l = self.eq_high[0].process(self.eq_mid[0].process(self.eq_low[0].process(l)));
        r = self.eq_high[1].process(self.eq_mid[1].process(self.eq_low[1].process(r)));
        // Filter.
        l = self.filt[0].process(l);
        r = self.filt[1].process(r);
        // Colour FX (pre-fader, so it is heard in the cue too).
        let (cl, cr) = self.color.process(l, r, self.clock_bpm);
        l = cl;
        r = cr;
        // PFL tap (pre-fader).
        let pfl = if self.cue { (l, r) } else { (0.0, 0.0) };
        // Volume.
        l *= vol * db_to_lin(0.0);
        r *= vol;

        // FX unit (post-fader insert): echo/reverb tails follow the fader.
        let (fl, fr) = self.fx.process(l, r);
        l = fl;
        r = fr;
        // Beat FX locked to the master clock.
        let (bl, br) = self.beat.process(l, r, self.clock_bpm, self.clock_beat);
        l = bl;
        r = br;
        self.clock_beat += self.clock_inc;

        // VU follower (peak with slow decay).
        let peak = l.abs().max(r.abs());
        if peak > self.vu {
            self.vu = peak;
        } else {
            self.vu *= 0.9995;
        }

        DeckOut { main: (l, r), pfl }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Stereo click track: a 2 ms 1 kHz burst on every beat from `first_beat` s.
    pub(crate) fn click_track(bpm: f64, first_beat: f64, secs: f64, sr: u32) -> TrackBuffer {
        let n = (secs * sr as f64) as usize;
        let mut left = vec![0.0f32; n];
        let beat = 60.0 / bpm;
        let mut t = first_beat;
        while t < secs {
            let start = (t * sr as f64) as usize;
            for i in 0..(sr as usize / 500) {
                if start + i < n {
                    left[start + i] =
                        (std::f32::consts::TAU * 1000.0 * i as f32 / sr as f32).sin() * 0.8;
                }
            }
            t += beat;
        }
        let right = left.clone();
        TrackBuffer {
            left,
            right,
            sample_rate: sr,
        }
    }

    fn loaded_deck(bpm: f64, first_beat: f64) -> Deck {
        let mut d = Deck::new(DeckId::A, 48_000.0);
        d.load(
            click_track(bpm, first_beat, 30.0, 48_000),
            (None, None, None, bpm),
        );
        d.set_grid(BeatGrid::constant(bpm, first_beat));
        d
    }

    #[test]
    fn quantize_snaps_hot_cue_and_loop_in() {
        let mut d = loaded_deck(120.0, 0.1);
        d.set_quantize(true);
        // 1.37 s is beat 2.54 → nearest beat 3 at 0.1 + 1.5 = 1.6 s.
        d.seek_secs(1.37);
        d.set_hot_cue(0);
        let cue = d.hot_cue_secs()[0].unwrap();
        assert!((cue - 1.6).abs() < 1e-6, "hot cue at {cue}");
        d.loop_in();
        assert!((d.loop_state_secs().1 - 1.6).abs() < 1e-6);
        // Paused jump to an unsnapped cue lands on the beat.
        d.hot_cues[1] = Some(1.33 * 48_000.0);
        d.jump_hot_cue(1);
        // 1.33 s = beat 2.46 → beat 2 at 1.1 s.
        assert!(
            (d.position_secs() - 1.1).abs() < 1e-6,
            "{}",
            d.position_secs()
        );
        // Quantize off: exact position kept.
        d.set_quantize(false);
        d.seek_secs(1.37);
        d.set_hot_cue(2);
        assert!((d.hot_cue_secs()[2].unwrap() - 1.37).abs() < 1e-6);
    }

    #[test]
    fn beat_jump_lands_on_grid() {
        let mut d = loaded_deck(126.0, 0.25);
        let beat = 60.0 / 126.0;
        d.seek_secs(0.25 + 4.0 * beat);
        for (jump, expect) in [
            (8.0, 12.0),
            (-2.0, 10.0),
            (32.0, 42.0),
            (-16.0, 26.0),
            (0.5, 26.5),
        ] {
            d.beat_jump(jump);
            assert!(
                (d.beat_pos() - expect).abs() < 1e-6,
                "jump {jump}: beat {}",
                d.beat_pos()
            );
        }
        // Paused + quantize: off-grid start snaps to an integer beat.
        d.set_quantize(true);
        d.seek_secs(0.25 + 5.3 * beat);
        d.beat_jump(4.0);
        assert!((d.beat_pos() - 9.0).abs() < 1e-6, "{}", d.beat_pos());
        // An active loop moves with the jump.
        d.beatloop(4.0);
        let (_, lin, lout) = d.loop_state_secs();
        d.beat_jump(4.0);
        let (_, lin2, lout2) = d.loop_state_secs();
        assert!((lin2 - lin - 4.0 * beat).abs() < 1e-6 && (lout2 - lout - 4.0 * beat).abs() < 1e-6);
    }

    #[test]
    fn slip_returns_to_shadow_position() {
        let mut d = loaded_deck(120.0, 0.0);
        d.set_key_lock(false);
        d.seek_secs(2.0);
        d.set_slip(true);
        d.play();
        d.beatloop(1.0); // 0.5 s loop
        let n = 48_000; // 1 s inside the loop
        for _ in 0..n {
            d.render_frame();
        }
        assert!(
            d.position_secs() < 2.5,
            "loop not holding: {}",
            d.position_secs()
        );
        d.loop_exit();
        d.render_frame();
        let expect = 2.0 + (n + 1) as f64 / 48_000.0;
        assert!(
            (d.position_secs() - expect).abs() < 2.0 / 48_000.0,
            "pos {} want {expect}",
            d.position_secs()
        );
        // Reverse + slip (censor): returns forward as if never reversed.
        d.set_reverse(true);
        for _ in 0..24_000 {
            d.render_frame();
        }
        d.set_reverse(false);
        d.render_frame();
        let expect = expect + 24_001.0 / 48_000.0;
        assert!(
            (d.position_secs() - expect).abs() < 2.0 / 48_000.0,
            "{}",
            d.position_secs()
        );
    }

    fn tone(freq: f32, secs: f32, sr: u32) -> TrackBuffer {
        let n = (secs * sr as f32) as usize;
        let s: Vec<f32> = (0..n)
            .map(|i| 0.8 * (2.0 * std::f32::consts::PI * freq * i as f32 / sr as f32).sin())
            .collect();
        TrackBuffer {
            left: s.clone(),
            right: s,
            sample_rate: sr,
        }
    }

    #[test]
    fn band_peaks_put_each_tone_in_its_band() {
        // Skip the first points: the crossover filters ring in.
        let settled = |v: &[u8]| *v[20..].iter().max().unwrap();
        for (freq, want) in [(60.0, 0usize), (1000.0, 1), (10_000.0, 2)] {
            let w = tone(freq, 1.0, 48_000).compute_band_peaks(150);
            let lanes = [settled(&w.low), settled(&w.mid), settled(&w.high)];
            for (i, v) in lanes.iter().enumerate() {
                if i == want {
                    assert!(*v > 170, "{freq} Hz: band {i} = {v}, want the tone here");
                } else {
                    assert!(*v < 40, "{freq} Hz: band {i} = {v}, want it quiet");
                }
            }
        }
    }

    #[test]
    fn band_peaks_length_follows_the_audio_clock() {
        // 1.5 s at 44.1 kHz, 150 points per second: ceil(66150 * 150 / 44100) = 225.
        let w = tone(440.0, 1.5, 44_100).compute_band_peaks(150);
        assert_eq!((w.len(), w.mid.len(), w.high.len()), (225, 225, 225));
        // A length that is not a whole number of points gets one trailing partial point.
        let w = tone(440.0, 1.003, 48_000).compute_band_peaks(150);
        assert_eq!(w.len(), 151);
        // Empty / degenerate input never panics.
        let empty = TrackBuffer {
            left: vec![],
            right: vec![],
            sample_rate: 48_000,
        };
        assert!(empty.compute_band_peaks(150).is_empty());
        assert!(tone(440.0, 0.1, 48_000).compute_band_peaks(0).is_empty());
    }

    #[test]
    fn waveforms_survive_a_tiny_sample_rate() {
        // The rate is whatever the file header says. Under 240 Hz the crossover cutoff clamp
        // used to panic (release aborts on panic); under 150 Hz the lane collapsed to one point.
        for sr in [1u32, 8, 100, 239, 240, 999] {
            let buf = TrackBuffer {
                left: vec![0.5; 2_000],
                right: vec![0.5; 2_000],
                sample_rate: sr,
            };
            let w = buf.compute_band_peaks(150);
            assert!(w.is_empty(), "{sr} Hz: {} points", w.len());
            assert_eq!(w.points_per_second, 150);
            assert!(buf.compute_peak_lane(150).is_empty(), "{sr} Hz lane");
        }
        // The lowest rate that gets a waveform: 2 s at 1 kHz = 300 points, in both forms.
        let buf = TrackBuffer {
            left: vec![0.5; 2_000],
            right: vec![0.5; 2_000],
            sample_rate: MIN_WAVE_SAMPLE_RATE,
        };
        assert_eq!(buf.compute_band_peaks(150).len(), 300);
        assert_eq!(buf.compute_peak_lane(150).len(), 300);
        // More points than frames per second is refused too, one point per frame is not.
        assert!(buf.compute_peak_lane(1_001).is_empty());
        assert!(buf.compute_band_peaks(1_001).is_empty());
        assert_eq!(buf.compute_peak_lane(1_000).len(), 2_000);
    }

    /// One full-scale sample at `frame`, silence elsewhere.
    fn impulse(frame: usize, frames: usize, sr: u32) -> TrackBuffer {
        let mut s = vec![0.0f32; frames];
        s[frame] = 1.0;
        TrackBuffer {
            left: s.clone(),
            right: s,
            sample_rate: sr,
        }
    }

    #[test]
    fn impulse_at_32k_lands_on_its_point_index() {
        // 32 kHz / 150 points per second = 213.33 frames per point, so the point boundaries
        // are floored: point 57 covers frames 12160..12373 and point 58 starts at 12373.
        // (44.1 k and 48 k divide evenly and never exercise the floor.)
        for (frame, want) in [
            (0usize, 0usize),
            (212, 0),
            (213, 1),
            (12_160, 57),
            (12_372, 57),
            (12_373, 58),
        ] {
            let buf = impulse(frame, 32_000, 32_000);
            let lane = buf.compute_peak_lane(150);
            assert_eq!(lane.len(), 150);
            let hits: Vec<usize> = (0..lane.len()).filter(|&i| lane[i] > 0).collect();
            assert_eq!(hits, [want], "lane, impulse at frame {frame}");
            assert_eq!(lane[want], 255);
            // Band waveform: the filters are causal, so nothing shows before the impulse's
            // point, and the high band reacts on the impulse's own frame.
            let w = buf.compute_band_peaks(150);
            assert_eq!(w.len(), 150);
            assert_eq!(
                w.high.iter().position(|v| *v > 0),
                Some(want),
                "high band, impulse at frame {frame}"
            );
            assert!(w.low[..want].iter().all(|v| *v == 0));
            assert!(w.mid[..want].iter().all(|v| *v == 0));
        }
    }

    #[test]
    fn band_peaks_recover_after_a_non_finite_sample() {
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut buf = tone(1_000.0, 1.0, 48_000);
            buf.left[4_800] = bad;
            let w = buf.compute_band_peaks(150);
            // 0.1 s in = point 15. The tone is still there half a second later.
            assert_eq!(w.len(), 150);
            let after = *w.mid[75..].iter().min().unwrap();
            assert!(
                after > 170,
                "{bad}: mid band after the bad sample = {after}"
            );
        }
    }

    #[test]
    fn band_wave_wire_form_is_header_plus_three_lanes() {
        let w = BandWave {
            points_per_second: 150,
            low: vec![1, 2],
            mid: vec![3, 4],
            high: vec![5, 6],
        };
        assert_eq!(
            w.to_bytes(),
            vec![150, 0, 0, 0, 2, 0, 0, 0, 1, 2, 3, 4, 5, 6]
        );
    }

    #[test]
    fn band_grid_peak_lane_lines_up_with_the_band_wave() {
        // Same point count as the band waveform for the same audio, at both common rates.
        for (secs, sr) in [(1.5, 44_100u32), (1.003, 48_000)] {
            let buf = tone(440.0, secs, sr);
            let lane = buf.compute_peak_lane(150);
            assert_eq!(lane.len(), buf.compute_band_peaks(150).len());
            // A steady tone: every full point holds (nearly) the same peak, and it is not silent.
            let body = &lane[1..lane.len() - 1];
            let (lo, hi) = (*body.iter().min().unwrap(), *body.iter().max().unwrap());
            assert!(lo > 20 && hi - lo <= 2, "lane {lo}..{hi}");
        }
        // Silence stays zero; degenerate input never panics.
        let silent = TrackBuffer {
            left: vec![0.0; 4_800],
            right: vec![0.0; 4_800],
            sample_rate: 48_000,
        };
        assert!(silent.compute_peak_lane(150).iter().all(|v| *v == 0));
        assert!(silent.compute_peak_lane(0).is_empty());
        let empty = TrackBuffer {
            left: vec![],
            right: vec![],
            sample_rate: 48_000,
        };
        assert!(empty.compute_peak_lane(150).is_empty());
    }

    #[test]
    fn pfl_tap_only_when_cue_on() {
        let mut d = loaded_deck(120.0, 0.0);
        d.set_key_lock(false);
        d.play();
        let mut pfl = 0.0f32;
        for _ in 0..2_000 {
            pfl = pfl.max(d.render_frame().pfl.0.abs());
        }
        assert_eq!(pfl, 0.0);
        d.set_cue(true);
        d.seek_secs(0.0);
        for _ in 0..2_000 {
            pfl = pfl.max(d.render_frame().pfl.0.abs());
        }
        assert!(pfl > 0.1);
    }

    // ---- WP19-41: stem crossfader, stem mute FX, cue loops ----------------------

    /// Four stem layers (12 s): a tone per `Some(freq)`, no layer per `None`.
    fn stem_layers(freqs: [Option<f32>; 4]) -> [Option<TrackBuffer>; 4] {
        freqs.map(|f| f.map(|hz| tone(hz, 12.0, 48_000)))
    }

    /// A playing deck (varispeed path) with two stems: vocals = 440 Hz, bass = 110 Hz.
    fn stem_deck(side: CrossfaderAssign) -> Deck {
        let mut d = loaded_deck(120.0, 0.0);
        d.set_key_lock(false);
        d.set_stems(stem_layers([Some(440.0), None, Some(110.0), None]));
        d.crossfader_assign = side;
        d.set_xf_context(1);
        d.seek_secs(2.0);
        d.play();
        d
    }

    fn peak(d: &mut Deck, frames: usize) -> f32 {
        (0..frames).fold(0.0f32, |p, _| p.max(d.render_frame().main.0.abs()))
    }

    #[test]
    fn stem_xf_gain_is_unity_at_centre_and_silence_on_the_far_side() {
        for curve in 0..3u8 {
            for side in [CrossfaderAssign::A, CrossfaderAssign::B] {
                assert_eq!(stem_xf_gain(0.0, side, curve), 1.0, "centre, curve {curve}");
                assert_eq!(stem_xf_gain(f32::NAN, side, curve), 1.0);
                let own = if side == CrossfaderAssign::A {
                    -1.0
                } else {
                    1.0
                };
                assert_eq!(
                    stem_xf_gain(own, side, curve),
                    1.0,
                    "own side, curve {curve}"
                );
                assert_eq!(
                    stem_xf_gain(-own, side, curve),
                    0.0,
                    "far side, curve {curve}"
                );
                // Nine tenths of the way: every law attenuates there (the sharp law holds
                // unity until the last quarter of the travel, so half way proves nothing).
                let near = stem_xf_gain(-own * 0.9, side, curve);
                assert!(near > 0.0 && near < 1.0, "0.9, curve {curve}: {near}");
            }
        }
        // The law is the mixer's, normalised to its centre: linear 0.25 / 0.5, smooth
        // sin(π/8) / sin(π/4), sharp min(4 · 0.25, 1) / 1.
        let half = |curve| stem_xf_gain(0.5, CrossfaderAssign::A, curve);
        assert!((half(0) - 0.5).abs() < 1e-6, "linear {}", half(0));
        let smooth = (std::f32::consts::FRAC_PI_8).sin() / (std::f32::consts::FRAC_PI_4).sin();
        assert!((half(1) - smooth).abs() < 1e-6, "smooth {}", half(1));
        assert_eq!(half(2), 1.0, "sharp");
        // THRU has no side: the stem crossfader does nothing.
        assert_eq!(stem_xf_gain(1.0, CrossfaderAssign::Thru, 1), 1.0);
        assert_eq!(stem_xf_gain(-1.0, CrossfaderAssign::Thru, 1), 1.0);
    }

    #[test]
    fn stem_crossfader_fades_one_stem_out_on_the_far_side() {
        // Deck on side B, vocals sent fully to side A: the vocals leave, the bass stays.
        let mut d = stem_deck(CrossfaderAssign::B);
        d.set_stem_xf(0, -1.0);
        // Mute the bass too, so only the vocals could be heard.
        d.set_stem_gain(2, 0.0);
        peak(&mut d, 24_000); // smoothing settles (20 ms)
        assert!(peak(&mut d, 4_800) < 1e-5, "vocals still audible");
        // The other stem passes untouched: bass back, vocals gone.
        d.set_stem_gain(2, 1.0);
        peak(&mut d, 24_000);
        let bass = peak(&mut d, 4_800);
        assert!(bass > 0.5, "bass missing: {bass}");
        // Sent to the deck's own side (B) the stem is at full level again.
        d.set_stem_xf(0, 1.0);
        d.set_stem_gain(2, 0.0);
        peak(&mut d, 24_000);
        assert!(peak(&mut d, 4_800) > 0.5);
        // A deck on side A mirrors it.
        let mut a = stem_deck(CrossfaderAssign::A);
        a.set_stem_xf(0, 1.0);
        a.set_stem_gain(2, 0.0);
        peak(&mut a, 24_000);
        assert!(peak(&mut a, 4_800) < 1e-5, "side A: vocals still audible");
        // Moving the deck to the other side (mixer context) brings them back.
        a.crossfader_assign = CrossfaderAssign::B;
        a.set_xf_context(1);
        peak(&mut a, 24_000);
        assert!(peak(&mut a, 4_800) > 0.5);
    }

    #[test]
    fn stem_crossfader_at_centre_is_bit_for_bit_a_no_op() {
        // Reference without a stem crossfader: a deck on THRU bypasses it altogether (the deck
        // output is taken before the mixer's crossfader, so the side itself changes nothing).
        // Two decks on the same side would both go through the same gain law and agree even
        // if the centre were not unity.
        let mut plain = stem_deck(CrossfaderAssign::Thru);
        let mut centred = stem_deck(CrossfaderAssign::B);
        for i in 0..4 {
            centred.set_stem_xf(i, 0.0);
        }
        // Away from the deck's side and back before any audio was rendered: still nothing.
        centred.set_stem_xf(0, -0.7);
        centred.set_stem_xf(0, 0.0);
        for _ in 0..48_000 {
            let a = plain.render_frame();
            let b = centred.render_frame();
            assert_eq!(a.main, b.main);
        }
        assert_eq!(centred.stem_xf(), [0.0; 4]);
    }

    #[test]
    fn stem_mute_fx_leaves_a_finite_bounded_echo_tail() {
        // 120 BPM, ½ beat = 0.25 s echo time = 12 000 frames (110 whole cycles of the 440 Hz
        // stem, so the repeats add up in phase: the loudest a tail can get).
        let run = |fx: bool| -> (f32, f32, f32, f32) {
            let mut d = stem_deck(CrossfaderAssign::B);
            d.set_stem_gain(2, 0.0); // bass off: only the vocals sound
            d.set_stem_mute_fx(fx, 0.5);
            peak(&mut d, 48_000);
            d.set_stem_mute(0, true);
            // 0.3..0.5 s after the mute: the gain reached 0 long ago (20 ms), one echo time passed.
            let first = peak(&mut d, 14_400);
            let early = peak(&mut d, 9_600);
            // 12 repeats + fade = 3.02 s after the mute; the loudest sample on the way to 3.2 s.
            let mut loudest = first.max(early);
            for _ in 0..27 {
                loudest = loudest.max(peak(&mut d, 4_800));
            }
            let after = peak(&mut d, 24_000);
            assert!(!d.stem_tail_live(), "tail still live 3.7 s after the mute");
            // Unmute: the stem is back at once.
            d.set_stem_mute(0, false);
            peak(&mut d, 4_800);
            (early, loudest, after, peak(&mut d, 4_800))
        };
        let (early, loudest, after, back) = run(true);
        assert!(early > 0.3, "no tail 0.3 s after the mute: {early}");
        assert!(loudest <= 1.2, "tail runaway: {loudest}");
        assert!(after < 1e-6, "tail not finite: {after}");
        assert!(back > 0.5, "unmute: {back}");
        let (early, _, after, _) = run(false);
        assert!(early < 1e-5, "hard cut still sounding: {early}");
        assert!(after < 1e-6);
    }

    #[test]
    fn stem_mute_fx_tail_fades_on_unmute_and_follows_the_stem_crossfader() {
        let mut d = stem_deck(CrossfaderAssign::B);
        d.set_stem_gain(2, 0.0);
        d.set_stem_mute_fx(true, 0.5);
        peak(&mut d, 48_000);
        d.set_stem_mute(0, true);
        peak(&mut d, 14_400);
        assert!(d.stem_tail_live());
        // Unmute while the tail rings: the tail fades (20 ms) and the stem itself is back.
        d.set_stem_mute(0, false);
        peak(&mut d, 14_400);
        assert!(!d.stem_tail_live(), "tail did not stop on unmute");
        // Mute again, then fade the vocals out on the stem crossfader: the tail goes with them.
        d.set_stem_mute(0, true);
        peak(&mut d, 14_400);
        assert!(peak(&mut d, 2_400) > 0.2);
        d.set_stem_xf(0, -1.0);
        peak(&mut d, 24_000);
        assert!(d.stem_tail_live(), "the tail should still be ringing here");
        assert!(
            peak(&mut d, 4_800) < 1e-5,
            "tail ignores the stem crossfader"
        );
        // Turning the mute FX off ends a tail; with it off a mute is a hard cut.
        d.set_stem_xf(0, 0.0);
        d.set_stem_mute(0, false);
        peak(&mut d, 4_800);
        d.set_stem_mute(0, true);
        peak(&mut d, 4_800);
        assert!(d.stem_tail_live());
        d.set_stem_mute_fx(false, 0.5);
        peak(&mut d, 14_400);
        assert!(!d.stem_tail_live());
        assert_eq!(d.stem_mute_fx(), (false, 0.5));
        // Bringing the stem back with its level (not the mute button) ends the tail too, and
        // pulling a level to zero is not a mute: no tail.
        d.set_stem_mute_fx(true, 0.5);
        d.set_stem_mute(0, false);
        peak(&mut d, 4_800);
        d.set_stem_mute(0, true);
        peak(&mut d, 4_800);
        assert!(d.stem_tail_live());
        d.set_stem_gain(0, 0.8);
        peak(&mut d, 14_400);
        assert!(!d.stem_tail_live(), "level up did not end the tail");
        d.set_stem_gain(0, 0.0);
        peak(&mut d, 4_800);
        assert!(!d.stem_tail_live(), "a level at zero must not start a tail");
        // Beats are clamped to 1/32..8 and non-finite values keep the old time.
        d.set_stem_mute_fx(true, 100.0);
        assert_eq!(d.stem_mute_fx(), (true, STEM_MUTE_FX_BEATS_MAX));
        d.set_stem_mute_fx(true, f64::NAN);
        assert_eq!(d.stem_mute_fx(), (true, STEM_MUTE_FX_BEATS_MAX));
        // A stem muted while the deck is paused leaves no tail: nothing was sounding.
        d.set_stem_mute_fx(true, 0.5);
        d.set_stem_gain(0, 1.0);
        peak(&mut d, 4_800);
        d.pause();
        d.set_stem_mute(0, true);
        assert!(!d.stem_tail_live(), "tail from a paused deck");
        assert!(peak(&mut d, 24_000) < 1e-6);
    }

    #[test]
    fn stem_mute_fx_tail_also_sounds_and_ends_with_key_lock() {
        // Key lock (the app default) plays the stems through the time-stretcher; the tail is
        // read beside it and must behave the same: there after the mute, gone 12 repeats later.
        let mut d = stem_deck(CrossfaderAssign::B);
        d.set_key_lock(true);
        d.set_tempo(1.06);
        d.set_stem_gain(2, 0.0);
        d.set_stem_mute_fx(true, 0.5);
        peak(&mut d, 48_000);
        d.set_stem_mute(0, true);
        // Past the stretcher's own latency (the muted stem itself has left it by 0.3 s).
        peak(&mut d, 14_400);
        let early = peak(&mut d, 9_600);
        // 0.3..0.5 s after the mute the first repeat is over and repeats 2..12 sound. The echo
        // time is half an AUDIBLE beat (127.2 BPM): 11 320.75 frames, not a whole number of
        // cycles of the 440 Hz stem, so the repeats add up as phasors: |Σ 0.55^k e^(-ikθ)|,
        // times the stem's amplitude (0.8) and the channel fader (0.85).
        let delay = 60.0 / (120.0 * 1.06) * 0.5 * 48_000.0;
        let theta = std::f64::consts::TAU * delay * 440.0 / 48_000.0;
        let (mut re, mut im) = (0.0f64, 0.0f64);
        for k in 2..=STEM_TAIL_TAPS {
            let g = (STEM_TAIL_FEEDBACK as f64).powi(k as i32);
            re += g * (k as f64 * theta).cos();
            im -= g * (k as f64 * theta).sin();
        }
        let want = (re * re + im * im).sqrt() * 0.8 * 0.85;
        assert!(
            (early as f64 - want).abs() < 0.01,
            "tail with key lock: {early}, the echo model gives {want}"
        );
        let mut loudest = early;
        for _ in 0..27 {
            loudest = loudest.max(peak(&mut d, 4_800));
        }
        assert!(loudest <= 1.2, "tail runaway with key lock: {loudest}");
        assert!(peak(&mut d, 24_000) < 1e-4, "tail not finite with key lock");
        assert!(!d.stem_tail_live());
    }

    #[test]
    fn cue_loop_is_saved_on_a_hot_cue_and_replayed_from_it() {
        let mut d = loaded_deck(120.0, 0.0);
        d.set_key_lock(false);
        d.seek_secs(4.0);
        d.beatloop(4.0); // 4.0 .. 6.0 s
        assert!(d.save_cue_loop(2));
        let beats = d.hot_cue_loops()[2].expect("loop stored on the cue");
        assert!((beats - 4.0).abs() < 1e-9, "{beats}");
        assert!((d.hot_cue_secs()[2].unwrap() - 4.0).abs() < 1e-9);
        // Elsewhere, no loop; the jump lands on the cue and starts the loop again.
        d.loop_exit();
        d.seek_secs(10.0);
        assert!(!d.loop_state_secs().0);
        assert!(d.jump_hot_cue(2));
        let (active, lin, lout) = d.loop_state_secs();
        assert!(active, "loop not active after the jump");
        assert!(
            (d.position_secs() - 4.0).abs() < 1e-9,
            "{}",
            d.position_secs()
        );
        assert!(
            (lin - 4.0).abs() < 1e-3 && (lout - 6.0).abs() < 1e-3,
            "{lin}..{lout}"
        );
        // Playing through: the deck stays inside the loop.
        d.play();
        for _ in 0..48_000 * 3 {
            d.render_frame();
        }
        assert!(
            d.position_secs() >= 4.0 && d.position_secs() < 6.0,
            "{}",
            d.position_secs()
        );
        // A plain cue has no loop; saving with no running loop stores nothing.
        d.loop_exit();
        d.set_hot_cue(3);
        assert_eq!(d.hot_cue_loops()[3], None);
        assert!(!d.save_cue_loop(3));
        assert!(d.jump_hot_cue(3));
        assert!(!d.loop_state_secs().0);
        // Clearing the cue clears its loop too.
        d.clear_hot_cue(2);
        assert_eq!(d.hot_cue_secs()[2], None);
        assert_eq!(d.hot_cue_loops()[2], None);
        assert!(!d.jump_hot_cue(2));
        // Setting a cue afresh on a slot that carried a loop gives a plain cue.
        d.seek_secs(8.0);
        d.beatloop(2.0);
        assert!(d.save_cue_loop(5));
        d.loop_exit();
        d.seek_secs(12.0);
        d.set_hot_cue(5);
        assert_eq!(d.hot_cue_loops()[5], None);
        assert!((d.hot_cue_secs()[5].unwrap() - 12.0).abs() < 1e-9);
        // Out-of-range slots are ignored.
        assert!(!d.save_cue_loop(8));
    }

    // ---- WP19-41 review fixes ---------------------------------------------------

    /// The next `frames` output samples (left channel).
    fn render(d: &mut Deck, frames: usize) -> Vec<f32> {
        (0..frames).map(|_| d.render_frame().main.0).collect()
    }

    /// A playing stem deck whose track has no tempo (no BPM, no beatgrid).
    fn stem_deck_without_tempo() -> Deck {
        let mut d = Deck::new(DeckId::A, 48_000.0);
        d.load(tone(220.0, 12.0, 48_000), (None, None, None, 0.0));
        d.set_key_lock(false);
        d.set_stems(stem_layers([Some(440.0), None, Some(110.0), None]));
        d.seek_secs(2.0);
        d.play();
        d
    }

    #[test]
    fn non_finite_stem_values_are_ignored_and_never_reach_the_audio() {
        let mut d = stem_deck(CrossfaderAssign::B);
        d.set_stem_gain(2, 0.0);
        d.set_stem_gain(0, 0.6);
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            d.set_stem_gain(0, bad);
            d.set_stem_xf(0, bad);
            assert_eq!(d.stem_gain[0].target(), 0.6, "stem gain after {bad}");
        }
        assert_eq!(d.stem_xf(), [0.0; 4]);
        d.set_stem_mute_fx(true, f64::NAN);
        d.set_stem_mute_fx(true, f64::INFINITY);
        assert_eq!(d.stem_mute_fx(), (true, crate::state::STEM_MUTE_FX_BEATS));
        let out = render(&mut d, 48_000);
        assert!(
            out.iter().all(|s| s.is_finite()),
            "a non-finite sample reached the output"
        );
        // 0.6 (stem level) x 0.8 (the tone) x 0.85 (channel fader).
        let level = out[24_000..].iter().fold(0.0f32, |p, s| p.max(s.abs()));
        assert!((level - 0.6 * 0.8 * 0.85).abs() < 0.01, "level {level}");
        // The stem still answers: a mute leaves its tail and the output stays finite.
        d.set_stem_mute(0, true);
        assert!(d.stem_tail_live());
        assert!(render(&mut d, 24_000).iter().all(|s| s.is_finite()));
        // A cue loop with a junk length is a plain cue.
        d.set_hot_cue(1);
        d.hot_cue_loops[1] = Some(f64::NAN);
        assert!(d.jump_hot_cue(1));
        assert!(!d.loop_state_secs().0);
    }

    #[test]
    fn quantized_jump_to_a_short_cue_loop_lands_inside_the_loop() {
        for key_lock in [false, true] {
            let mut d = loaded_deck(120.0, 0.0);
            d.set_key_lock(key_lock);
            // A 1/8-beat loop (62.5 ms) stored on a cue at beat 8 (4.0 s).
            d.seek_secs(4.0);
            d.beatloop(0.125);
            assert!(d.save_cue_loop(0));
            d.loop_exit();
            // Playing 0.4 beats after a beat with quantize on: the jump keeps those 0.4 beats,
            // which is 0.2 s after the cue, three loop lengths past the loop's end.
            d.seek_secs(10.2);
            d.set_quantize(true);
            d.play();
            assert!(d.jump_hot_cue(0));
            let (active, lin, lout) = d.loop_state_secs();
            assert!(
                active && (lin - 4.0).abs() < 1e-9 && (lout - 4.0625).abs() < 1e-9,
                "loop {lin}..{lout}"
            );
            let pos = d.position_secs();
            assert!(
                pos >= lin && pos < lout,
                "key lock {key_lock}: landed at {pos}, outside {lin}..{lout}"
            );
            // 0.2 s into a 62.5 ms loop is 12.5 ms after its start.
            assert!((pos - 4.0125).abs() < 1e-6, "{pos}");
            // And the deck stays in the loop from the first frame on.
            for _ in 0..4_800 {
                d.render_frame();
                let p = d.position_secs();
                assert!(p >= lin && p < lout, "key lock {key_lock}: {p}");
            }
        }
    }

    #[test]
    fn a_playhead_far_past_a_running_loop_folds_into_it_in_one_frame() {
        for key_lock in [false, true] {
            let mut d = loaded_deck(120.0, 0.0);
            d.set_key_lock(key_lock);
            d.seek_secs(4.0);
            d.beatloop(0.125); // 4.0 .. 4.0625 s
            d.play();
            // 95 loop lengths past the end: one wrap (one stretcher reset), not one per frame.
            d.seek_secs(10.0);
            d.render_frame();
            let (_, lin, lout) = d.loop_state_secs();
            let pos = d.position_secs();
            assert!(
                pos >= lin && pos < lout,
                "key lock {key_lock}: {pos} after one frame, loop {lin}..{lout}"
            );
        }
    }

    #[test]
    fn stem_mute_in_reverse_is_a_plain_mute_without_a_tail() {
        let run = |fx: bool| {
            let mut d = stem_deck(CrossfaderAssign::B);
            d.set_stem_gain(2, 0.0);
            d.set_stem_mute_fx(fx, 0.5);
            d.set_reverse(true);
            peak(&mut d, 24_000);
            d.set_stem_mute(0, true);
            (d.stem_tail_live(), render(&mut d, 48_000))
        };
        let (live, with_fx) = run(true);
        let (_, plain) = run(false);
        assert!(!live, "a tail started in reverse");
        // Sample for sample what a mute without the mute FX gives: nothing that was not heard.
        assert!(with_fx == plain, "the mute FX added something in reverse");
        assert!(with_fx[14_400..].iter().all(|s| s.abs() < 1e-5));
        // Forward again, the mute FX is back.
        let mut d = stem_deck(CrossfaderAssign::B);
        d.set_stem_mute_fx(true, 0.5);
        d.set_reverse(true);
        peak(&mut d, 4_800);
        d.set_reverse(false);
        peak(&mut d, 4_800);
        d.set_stem_mute(0, true);
        assert!(d.stem_tail_live(), "no tail after reverse was released");
    }

    #[test]
    fn stem_mute_fx_without_a_tempo_is_a_plain_mute() {
        // `fx` = the mute FX is on when the vocals are muted on a track without a tempo. Later
        // the track gets one and the bass is muted with the mute FX on (a real tail).
        let run = |fx: bool| {
            let mut d = stem_deck_without_tempo();
            assert_eq!(d.effective_bpm(), 0.0);
            d.set_stem_mute_fx(fx, 0.5);
            peak(&mut d, 24_000);
            d.set_stem_mute(0, true);
            let live = d.stem_tail_live();
            let armed = d.stem_tails[0].ret.target();
            let mut out = render(&mut d, 24_000);
            d.set_grid(BeatGrid::constant(120.0, 0.0));
            d.set_stem_mute_fx(true, 0.5);
            d.set_stem_mute(2, true);
            assert!(d.stem_tail_live(), "no tail once the track has a tempo");
            out.extend(render(&mut d, 24_000));
            (live, armed, out)
        };
        let (live, armed, with_fx) = run(true);
        let (_, _, plain) = run(false);
        assert!(!live, "a tail without an echo time");
        assert_eq!(armed, 0.0, "the tail's return was left open");
        // Sample for sample a mute without the mute FX, also once another stem's tail rings:
        // a return left open would let a 20 ms burst of the vocals through there.
        assert!(
            with_fx == plain,
            "the mute FX left something on a track without a tempo"
        );
        // The bass tail itself is there (110 Hz, repeats of 0.25 s = 27.5 cycles: they alternate
        // in sign, so the level is the alternating sum, well above silence).
        let tail = with_fx[38_400..].iter().fold(0.0f32, |p, s| p.max(s.abs()));
        assert!(tail > 0.05, "bass tail missing: {tail}");
    }

    #[test]
    fn turning_stems_off_fades_a_ringing_tail_instead_of_cutting_it() {
        let mut d = stem_deck(CrossfaderAssign::B);
        d.set_stem_gain(2, 0.0);
        d.set_stem_mute_fx(true, 0.5);
        peak(&mut d, 48_000); // 2.0 -> 3.0 s
        d.set_stem_mute(0, true);
        peak(&mut d, 14_400); // -> 3.3 s: the stem itself is gone, its tail rings
        let ringing = render(&mut d, 480); // -> 3.31 s
        let before = ringing.iter().fold(0.0f32, |p, s| p.max(s.abs()));
        assert!(before > 0.2, "no tail to cut: {before}");
        d.set_stems_active(false);
        assert!(!d.stem_tail_live(), "repeats still due after stems off");
        // The full mix takes over (a click track: silent between its beats at 3.0 and 3.5 s).
        // 5 ms later the tail is still there (it fades with a 20 ms time constant) ...
        let fading = render(&mut d, 240); // -> 3.315 s
        let just_after = fading.iter().fold(0.0f32, |p, s| p.max(s.abs()));
        assert!(
            just_after > before * 0.5 && just_after <= before * 1.05,
            "tail {before} -> {just_after} right after stems off"
        );
        // ... without a step at the switch: a 440 Hz tone moves 6 % of its peak per sample.
        let step = (fading[0] - ringing[479]).abs();
        assert!(step < before * 0.1, "step of {step} at stems off");
        // ... and it is gone 0.3 s later.
        peak(&mut d, 14_160); // -> 3.61 s
        assert!(peak(&mut d, 2_400) < 1e-4, "the tail did not fade out");
    }

    #[test]
    fn unmute_brings_back_the_level_the_stem_had_before_the_mute() {
        let mut d = stem_deck(CrossfaderAssign::B);
        // The UI mirror gets the same commands and must report the same levels.
        let mut mirror = DeckState::empty(DeckId::A);
        d.set_stem_gain(2, 0.0);
        mirror.stem_gains[2] = 0.0;
        d.set_stem_gain(0, 0.6);
        mirror.stem_gains[0] = 0.6;
        peak(&mut d, 24_000);
        d.set_stem_mute(0, true);
        assert_eq!(mirror.mirror_stem_mute(0, true), Some(0.0));
        peak(&mut d, 24_000);
        assert!(peak(&mut d, 4_800) < 1e-5, "muted stem still audible");
        d.set_stem_mute(0, false);
        assert_eq!(mirror.mirror_stem_mute(0, false), Some(0.6));
        assert_eq!(d.stem_gain[0].target(), 0.6);
        peak(&mut d, 24_000);
        let back = peak(&mut d, 4_800);
        assert!((back - 0.6 * 0.8 * 0.85).abs() < 0.01, "level {back}");
        // The same command again changes nothing, on either side.
        d.set_stem_mute(0, false);
        assert_eq!(mirror.mirror_stem_mute(0, false), None);
        assert_eq!(d.stem_gain[0].target(), 0.6);
        // A stem pulled to silence by its level was never muted: unmute is unity.
        d.set_stem_gain(0, 0.0);
        mirror.stem_gains[0] = 0.0;
        d.set_stem_mute(0, false);
        assert_eq!(mirror.mirror_stem_mute(0, false), Some(1.0));
        assert_eq!(d.stem_gain[0].target(), 1.0);
        // A solo and its release (three mutes, three unmutes) put every level back.
        for (idx, level) in [(0usize, 0.5f32), (1, 0.7), (3, 1.2)] {
            d.set_stem_gain(idx, level);
            mirror.stem_gains[idx] = level;
        }
        for on in [true, false] {
            for idx in [0usize, 1, 3] {
                d.set_stem_mute(idx, on);
                mirror.mirror_stem_mute(idx, on);
            }
            let want = if on {
                [0.0, 0.0, 0.0, 0.0]
            } else {
                [0.5, 0.7, 0.0, 1.2]
            };
            for (idx, level) in want.into_iter().enumerate() {
                assert_eq!(d.stem_gain[idx].target(), level, "deck, stem {idx}");
                assert_eq!(mirror.stem_gains[idx], level, "mirror, stem {idx}");
            }
        }
        // Out-of-range stems are ignored.
        d.set_stem_mute(4, true);
        assert_eq!(mirror.mirror_stem_mute(4, true), None);
    }
}
