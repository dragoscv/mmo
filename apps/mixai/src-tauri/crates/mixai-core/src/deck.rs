//! A single playback deck: holds decoded stereo samples and runs the per-deck
//! DSP chain (EQ → filter → colour FX → [PFL tap] → volume → FX → beat FX) in
//! the audio callback.
//!
//! Without key lock or key shift the deck plays varispeed (tempo bends pitch).
//! With key lock and/or a key shift it pulls from a [`Stretcher`] (Signalsmith
//! Stretch by default, WSOLA fallback). Beatgrid, quantize, beat-jump, slip and
//! reverse implement WP19-05.

use crate::beatfx::{BeatFx, BeatFxKind};
use crate::beatgrid::BeatGrid;
use crate::colorfx::{ColorFx, ColorFxKind};
use crate::dsp::{Biquad, Smoothed, db_to_lin};
use crate::fx::{Fx, FxKind};
use crate::state::{CrossfaderAssign, DeckId, DeckState};
use crate::stretch::{MAX_LAYERS, StemMix, Stretcher, StretcherKind, make_stretcher};

/// Tempo range for every path (varispeed and key-locked stretch).
pub const TEMPO_MIN: f64 = 0.5;
pub const TEMPO_MAX: f64 = 2.0;
/// Key shift range in semitones.
pub const KEY_SHIFT_MAX: f64 = 12.0;

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
                Smoothed::new(1.0, sr, 20.0),
                Smoothed::new(1.0, sr, 20.0),
                Smoothed::new(1.0, sr, 20.0),
                Smoothed::new(1.0, sr, 20.0),
            ],
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
        // Re-size the FX echo time to the new track's tempo grid.
        self.recompute_fx_time();
    }

    pub fn loaded(&self) -> bool {
        self.track.is_some()
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
        if any {
            self.stems = Some(layers);
            self.stems_active = true;
        } else {
            self.stems = None;
            self.stems_active = false;
        }
    }

    /// Turn stem playback on/off without discarding the loaded stem buffers.
    pub fn set_stems_active(&mut self, on: bool) {
        if self.stems.is_some() {
            self.stems_active = on;
        }
    }

    /// Set the gain (0..1) for stem `idx` (0=vocals,1=drums,2=bass,3=melody).
    pub fn set_stem_gain(&mut self, idx: usize, gain: f32) {
        if idx < MAX_LAYERS {
            self.stem_gain[idx].set_target(gain.clamp(0.0, 1.5));
        }
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
    pub fn set_hot_cue(&mut self, slot: usize) {
        if slot < 8 && self.loaded() {
            self.hot_cues[slot] = Some(self.snap(self.play_pos));
        }
    }

    /// Jump to hot cue `slot` if set. Returns true when a jump happened.
    pub fn jump_hot_cue(&mut self, slot: usize) -> bool {
        if let Some(pos) = self.hot_cues.get(slot).copied().flatten() {
            let target = self.quantized_target(pos);
            self.jump_to(target);
            return true;
        }
        false
    }

    /// Clear hot cue `slot`.
    pub fn clear_hot_cue(&mut self, slot: usize) {
        if slot < 8 {
            self.hot_cues[slot] = None;
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

        // Advance per-stem smoothed gains every frame (cheap, keeps mute/blend
        // click-free). Captured into locals so the disjoint borrow below can
        // still take `&mut stretcher` alongside `&track`/`&stems`.
        let sg = [
            self.stem_gain[0].next(),
            self.stem_gain[1].next(),
            self.stem_gain[2].next(),
            self.stem_gain[3].next(),
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
                        *play_pos = *loop_in + (*play_pos - *loop_out);
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
                                *play_pos = *loop_in + (*play_pos - *loop_out);
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

        // EQ chain.
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
}
