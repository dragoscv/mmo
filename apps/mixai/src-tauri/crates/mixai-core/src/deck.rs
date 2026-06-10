//! A single playback deck: holds decoded stereo samples and runs the per-deck
//! DSP chain (EQ → filter → volume) in the audio callback.
//!
//! v0.1 tempo is varispeed (resample by playback rate). Key-lock (constant
//! pitch while changing tempo) is wired as a flag now and will be backed by a
//! permissive time-stretch (Signalsmith) — see the roadmap. Until then,
//! `key_lock` simply marks intent and tempo acts as varispeed.

use crate::dsp::{db_to_lin, Biquad, Smoothed};
use crate::fx::{Fx, FxKind};
use crate::state::{CrossfaderAssign, DeckId, DeckState};
use crate::stretch::{StemMix, TimeStretch, MAX_LAYERS};

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
            let end = (((b + 1) as f64 * window) as usize).min(frames).max(start + 1);
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

    // Pitch-preserving time-stretch (used when key_lock is on).
    stretch: TimeStretch,

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
            stretch: TimeStretch::new(),
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

    pub fn load(&mut self, buffer: TrackBuffer, meta: (Option<String>, Option<String>, Option<String>, f64)) {
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
        self.stretch.reset(0.0);
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
            self.play_pos = frame;
            self.stretch.reset(frame);
        }
    }

    pub fn set_volume(&mut self, v: f32) {
        self.volume.set_target(v.clamp(0.0, 1.0));
    }

    pub fn set_tempo(&mut self, t: f64) {
        self.tempo = t.clamp(0.5, 1.5);
        self.recompute_fx_time();
    }

    pub fn set_key_lock(&mut self, on: bool) {
        self.key_lock = on;
        // Re-prime the stretcher from the current playhead so toggling is clean.
        self.stretch.reset(self.play_pos);
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
        self.track.as_ref().map(|t| t.sample_rate as f64).unwrap_or(self.sr as f64)
    }

    /// Set hot cue `slot` (0..7) to the current playhead.
    pub fn set_hot_cue(&mut self, slot: usize) {
        if slot < 8 && self.loaded() {
            self.hot_cues[slot] = Some(self.play_pos);
        }
    }

    /// Jump to hot cue `slot` if set. Returns true when a jump happened.
    pub fn jump_hot_cue(&mut self, slot: usize) -> bool {
        if slot < 8 {
            if let Some(pos) = self.hot_cues[slot] {
                self.play_pos = pos;
                self.stretch.reset(pos);
                return true;
            }
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
        self.loop_in = self.play_pos;
    }

    /// Set the loop out-point to the current playhead and activate.
    pub fn loop_out(&mut self) {
        if self.play_pos > self.loop_in {
            self.loop_out = self.play_pos;
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
        if self.bpm <= 0.0 || !self.loaded() {
            return;
        }
        self.loop_beats = beats;
        let sr = self.track_sr();
        let frames_per_beat = (60.0 / self.bpm) * sr;
        self.loop_in = self.play_pos;
        self.loop_out = self.play_pos + frames_per_beat * beats;
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
        self.track.as_ref().map(|t| t.duration_secs()).unwrap_or(0.0)
    }

    pub fn vu(&self) -> f32 {
        self.vu
    }

    /// Render the next stereo frame from this deck (post EQ/filter/volume,
    /// pre-crossfader). Returns (left, right). Advances the playhead.
    #[inline]
    pub fn render_frame(&mut self) -> (f32, f32) {
        if self.eq_dirty {
            self.recompute_eq();
        }
        if self.filter_dirty {
            self.recompute_filter();
        }

        let vol = self.volume.next();

        // Advance per-stem smoothed gains every frame (cheap, keeps mute/blend
        // click-free). Captured into locals so the disjoint borrow below can
        // still take `&mut stretch` alongside `&track`/`&stems`.
        let sg = [
            self.stem_gain[0].next(),
            self.stem_gain[1].next(),
            self.stem_gain[2].next(),
            self.stem_gain[3].next(),
        ];

        let (mut l, mut r) = (0.0f32, 0.0f32);
        if self.playing {
            // Disjoint borrows: the stretcher needs `&mut`, the track `&`.
            let Self {
                track,
                stems,
                stems_active,
                stretch,
                play_pos,
                playing,
                key_lock,
                tempo,
                rate_ratio,
                loop_active,
                loop_in,
                loop_out,
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
                if *key_lock {
                    // Pitch-preserving path: pull from the WSOLA stretcher.
                    if stretch.available() == 0 {
                        let ok = stretch.process_hop(&src, *tempo, *rate_ratio);
                        if !ok {
                            *playing = false;
                        }
                    }
                    if stretch.available() > 0 {
                        let (sl, sr) = stretch.pop();
                        l = sl;
                        r = sr;
                    }
                    // Mirror the stretcher's source position for UI + loops.
                    *play_pos = stretch.analysis_pos;
                    if *loop_active && *play_pos >= *loop_out {
                        *play_pos = *loop_in;
                        stretch.reset(*loop_in);
                    }
                } else {
                    // Varispeed path: tempo also shifts pitch (turntable feel).
                    let pos = *play_pos;
                    if pos >= 0.0 && (pos as usize) < frames.saturating_sub(1) {
                        let (sl, sr) = src.read_stereo(pos);
                        l = sl;
                        r = sr;
                        *play_pos += *tempo * *rate_ratio;
                        if *loop_active && *play_pos >= *loop_out {
                            *play_pos = *loop_in + (*play_pos - *loop_out);
                        }
                    } else {
                        *playing = false;
                    }
                }
            }
        }

        // EQ chain.
        l = self.eq_high[0].process(self.eq_mid[0].process(self.eq_low[0].process(l)));
        r = self.eq_high[1].process(self.eq_mid[1].process(self.eq_low[1].process(r)));
        // Filter.
        l = self.filt[0].process(l);
        r = self.filt[1].process(r);
        // Volume.
        l *= vol * db_to_lin(0.0);
        r *= vol;

        // FX unit (post-fader insert): echo/reverb tails follow the fader.
        let (fl, fr) = self.fx.process(l, r);
        l = fl;
        r = fr;

        // VU follower (peak with slow decay).
        let peak = l.abs().max(r.abs());
        if peak > self.vu {
            self.vu = peak;
        } else {
            self.vu *= 0.9995;
        }

        (l, r)
    }
}
