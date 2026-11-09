//! Real-time quadrature timecode decoder.

use std::f64::consts::{PI, TAU};
use std::fmt;
use std::sync::Arc;

use crate::calibration::{Calibration, SignalReport};
use crate::code::{MixAiCode, PositionCode};
use crate::format::{Support, TimecodeFormat};

/// Number of points kept for the X/Y (Lissajous) scope view.
pub const SCOPE_POINTS: usize = 512;
/// Consecutive consistent windows needed to (re)lock absolute position. Every non-zero 20-bit
/// window is a valid code word, so a window with one misread bit stays self-consistent for the
/// next window with p = 1/2; 4 confirmations bound a false lock to p = 1/8 per misread window,
/// and a false lock is dropped by the error monitor within ~12 cycles.
pub const LOCK_CONFIRM: u32 = 4;
/// Bit errors within [`ERROR_WINDOW`] decoded bits that drop the absolute lock.
pub const UNLOCK_ERRORS: u32 = 6;
const ERROR_WINDOW: u32 = 24;
/// Mid part of a carrier cycle where the AM level is flat (generator ramps at the edges).
const MID_LO: f64 = 0.35;
const MID_HI: f64 = 0.65;

/// What the decoder reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeMode {
    /// Speed and direction only (works with any quadrature carrier).
    Relative,
    /// Speed, direction and needle position (needs a [`PositionCode`]).
    Absolute,
}

/// Playback direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Record turning forwards.
    Forward,
    /// Record turning backwards.
    Reverse,
    /// Record stopped or no signal.
    Stopped,
}

/// Decoder configuration.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DvsConfig {
    /// Timecode format (sets carrier frequency and front-end options).
    pub format: TimecodeFormat,
    /// Input sample rate in Hz.
    pub sample_rate: u32,
    /// Relative or absolute decoding.
    pub mode: DecodeMode,
    /// Speed estimator window in ms; group delay = window / 2 (default 8 ms → 4 ms, under the
    /// 5 ms target while keeping the estimate within 0.2 % at 0.33× and 30 dB SNR).
    pub speed_window_ms: f32,
    /// |speed| below this is reported as stopped (default 0.03).
    pub stop_speed: f32,
    /// DC-blocker cut-off in Hz (default 20).
    pub dc_cutoff_hz: f32,
    /// Absolute floor of the presence threshold, linear envelope (default 0.002 ≈ −54 dBFS).
    pub min_level: f32,
    /// Signal dropouts shorter than this keep phase continuity and the lock (default 5 ms).
    pub dropout_hold_ms: f32,
    /// Swap left/right before decoding (reversed cartridge wiring or a vendor's opposite
    /// quadrature convention).
    pub swap_channels: bool,
    /// Max RMS deviation (in carrier cycles) of the phase from a straight line over the speed
    /// window before the estimate is rejected as noise (default 0.3; random phase gives > 2).
    pub max_phase_residual: f32,
}

impl DvsConfig {
    /// Defaults for `format`; absolute mode when the format supports it.
    pub fn new(format: TimecodeFormat, sample_rate: u32) -> Self {
        let mode = if format.absolute_support() == Support::Supported {
            DecodeMode::Absolute
        } else {
            DecodeMode::Relative
        };
        Self {
            format,
            sample_rate,
            mode,
            speed_window_ms: 8.0,
            stop_speed: 0.03,
            dc_cutoff_hz: 20.0,
            min_level: 0.002,
            dropout_hold_ms: 5.0,
            swap_channels: false,
            max_phase_residual: 0.3,
        }
    }

    /// Same config with another mode.
    pub fn with_mode(mut self, mode: DecodeMode) -> Self {
        self.mode = mode;
        self
    }
}

/// Construction errors.
#[derive(Debug, Clone, PartialEq)]
pub enum DvsError {
    /// The format/mode combination is not available; the text says why.
    Unsupported(&'static str),
    /// Sample rate below 8× the carrier or above 384 kHz.
    InvalidSampleRate(u32),
    /// The supplied position code uses another carrier frequency than the format.
    CarrierMismatch,
}

impl fmt::Display for DvsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(why) => write!(f, "unsupported: {why}"),
            Self::InvalidSampleRate(sr) => write!(f, "invalid sample rate {sr} Hz"),
            Self::CarrierMismatch => write!(f, "position code carrier does not match the format"),
        }
    }
}

impl std::error::Error for DvsError {}

/// Decoder output after each [`DvsDecoder::process`] call.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DvsState {
    /// Signed playback speed relative to nominal (1.0 = 33⅓ / reference speed; negative = reverse).
    pub speed: f32,
    /// Direction derived from `speed`.
    pub direction: Direction,
    /// Needle position in seconds of timecode (absolute mode, while locked).
    pub position_sec: Option<f64>,
    /// Carrier present and the speed estimate is valid.
    pub valid: bool,
    /// Record stopped (|speed| < stop threshold) or no carrier.
    pub stopped: bool,
    /// Absolute position locked.
    pub locked: bool,
    /// Signal quality 0..1 (SNR, and bit validity when locked).
    pub quality: f32,
}

impl DvsState {
    const IDLE: Self = Self {
        speed: 0.0,
        direction: Direction::Stopped,
        position_sec: None,
        valid: false,
        stopped: true,
        locked: false,
        quality: 0.0,
    };
}

/// Quadrature timecode decoder. `process` is real-time safe: no allocation, no locks, O(frames).
pub struct DvsDecoder {
    cfg: DvsConfig,
    sr: f64,
    carrier: f64,
    differentiate: bool,
    code: Option<Arc<dyn PositionCode>>,
    // Front end.
    diff_prev: [f32; 2],
    dc_x: [f32; 2],
    dc_y: [f32; 2],
    dc_r: f32,
    env_s: f32,
    env_coef: f32,
    a_ref: f32,
    ref_decay: f32,
    present: bool,
    absent_run: u32,
    hold_samples: u32,
    gap: u32,
    // Phase tracking.
    have_theta: bool,
    theta_prev: f64,
    phi: f64,
    slope_ema: f64,
    ring: Vec<f64>,
    ring_pos: usize,
    valid_run: usize,
    min_run: usize,
    // Bits.
    acc_cycle: i64,
    acc_sum: f32,
    acc_sq: f32,
    acc_n: u32,
    a_one: f32,
    win: u32,
    win_lo: i64,
    win_n: u32,
    win_fwd: bool,
    cand_off: i64,
    cand_n: u32,
    locked: bool,
    offset: i64,
    err_hist: u32,
    valid_bits: f32,
    // Scope.
    scope: Vec<[f32; 2]>,
    scope_pos: usize,
    scope_filled: usize,
    scope_decim: u32,
    scope_ctr: u32,
    calib: Calibration,
    state: DvsState,
}

impl fmt::Debug for DvsDecoder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DvsDecoder")
            .field("cfg", &self.cfg)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

fn wrap_pi(x: f64) -> f64 {
    let mut d = x;
    while d > PI {
        d -= TAU;
    }
    while d <= -PI {
        d += TAU;
    }
    d
}

impl DvsDecoder {
    /// Build a decoder. For MixAI absolute mode this builds the 4 MiB code table; with several
    /// decks build one [`MixAiCode`] and use [`DvsDecoder::with_code`].
    pub fn new(cfg: DvsConfig) -> Result<Self, DvsError> {
        let code: Option<Arc<dyn PositionCode>> =
            if cfg.mode == DecodeMode::Absolute && cfg.format == TimecodeFormat::MixAi {
                Some(Arc::new(MixAiCode::new()))
            } else {
                None
            };
        Self::build(cfg, code)
    }

    /// Build an absolute-mode decoder around an explicit position code.
    pub fn with_code(cfg: DvsConfig, code: Arc<dyn PositionCode>) -> Result<Self, DvsError> {
        let carrier = cfg.format.carrier_hz().unwrap_or(0.0) as f64;
        if (code.carrier_hz() - carrier).abs() > 1e-6 {
            return Err(DvsError::CarrierMismatch);
        }
        Self::build(cfg.with_mode(DecodeMode::Absolute), Some(code))
    }

    fn build(cfg: DvsConfig, code: Option<Arc<dyn PositionCode>>) -> Result<Self, DvsError> {
        if let Support::Pending(why) = cfg.format.relative_support() {
            return Err(DvsError::Unsupported(why));
        }
        if cfg.mode == DecodeMode::Absolute && code.is_none() {
            return Err(match cfg.format.absolute_support() {
                Support::Pending(why) => DvsError::Unsupported(why),
                _ => DvsError::Unsupported("absolute mode needs a PositionCode"),
            });
        }
        let carrier = cfg.format.carrier_hz().unwrap_or(1000.0) as f64;
        let sr = cfg.sample_rate as f64;
        if sr < 8.0 * carrier || cfg.sample_rate > 384_000 {
            return Err(DvsError::InvalidSampleRate(cfg.sample_rate));
        }
        let win_len = ((cfg.speed_window_ms as f64 * 1e-3 * sr).round() as usize).max(32);
        let srf = sr as f32;
        let scope_decim = ((sr / (16.0 * carrier)).floor() as u32).max(1);
        let mut dec = Self {
            cfg,
            sr,
            carrier,
            differentiate: cfg.format.differentiate(),
            code,
            diff_prev: [0.0; 2],
            dc_x: [0.0; 2],
            dc_y: [0.0; 2],
            dc_r: (1.0 - TAU * cfg.dc_cutoff_hz as f64 / sr) as f32,
            env_s: 0.0,
            env_coef: 1.0 - (-1.0 / (1e-3 * srf)).exp(),
            a_ref: 0.0,
            ref_decay: (-1.0 / (2.0 * srf)).exp(),
            present: false,
            absent_run: u32::MAX,
            hold_samples: (cfg.dropout_hold_ms * 1e-3 * srf) as u32,
            gap: 0,
            have_theta: false,
            theta_prev: 0.0,
            phi: 0.0,
            slope_ema: 0.0,
            ring: vec![0.0; win_len],
            ring_pos: 0,
            valid_run: 0,
            min_run: (win_len / 4).max(16),
            acc_cycle: 0,
            acc_sum: 0.0,
            acc_sq: 0.0,
            acc_n: 0,
            a_one: 0.0,
            win: 0,
            win_lo: 0,
            win_n: 0,
            win_fwd: true,
            cand_off: 0,
            cand_n: 0,
            locked: false,
            offset: 0,
            err_hist: 0,
            valid_bits: 0.0,
            scope: vec![[0.0; 2]; SCOPE_POINTS],
            scope_pos: 0,
            scope_filled: 0,
            scope_decim,
            scope_ctr: 0,
            calib: Calibration::new(srf),
            state: DvsState::IDLE,
        };
        dec.reset();
        Ok(dec)
    }

    /// Configuration in use.
    pub fn config(&self) -> &DvsConfig {
        &self.cfg
    }

    /// The position code (absolute mode).
    pub fn code(&self) -> Option<&Arc<dyn PositionCode>> {
        self.code.as_ref()
    }

    /// Forget all signal history (e.g. after switching input).
    pub fn reset(&mut self) {
        self.diff_prev = [0.0; 2];
        self.dc_x = [0.0; 2];
        self.dc_y = [0.0; 2];
        self.env_s = 0.0;
        self.a_ref = 0.0;
        self.present = false;
        self.absent_run = u32::MAX;
        self.reacquire();
        self.a_one = 0.0;
        self.valid_bits = 0.0;
        self.scope.iter_mut().for_each(|p| *p = [0.0; 2]);
        self.scope_pos = 0;
        self.scope_filled = 0;
        self.calib.reset();
        self.state = DvsState::IDLE;
    }

    /// Last state returned by `process`.
    pub fn state(&self) -> DvsState {
        self.state
    }

    /// Decode `frames` frames of interleaved stereo (`[L, R, L, R, …]`).
    /// Real-time safe: no allocation, bounded work per frame.
    pub fn process(&mut self, interleaved: &[f32], frames: usize) -> DvsState {
        let n = frames.min(interleaved.len() / 2);
        for f in interleaved[..2 * n].chunks_exact(2) {
            self.step(f[0], f[1]);
        }
        self.state = self.compute_state();
        self.state
    }

    /// Signal quality for the calibration view.
    pub fn report(&self) -> SignalReport {
        let vb = self.locked.then_some(self.valid_bits);
        self.calib
            .report(self.present, self.threshold_on(), vb, self.state.speed)
    }

    /// Copy the newest X/Y scope points (x = right, y = left, normalised to the reference level,
    /// oldest first) into `out`; returns the number written. Forward motion turns
    /// counter-clockwise. Does not allocate.
    pub fn scope(&self, out: &mut [[f32; 2]]) -> usize {
        let n = out.len().min(self.scope_filled);
        let norm = if self.a_ref > 1e-6 {
            1.0 / self.a_ref
        } else {
            1.0
        };
        let start = (self.scope_pos + SCOPE_POINTS - n) % SCOPE_POINTS;
        for (i, o) in out.iter_mut().take(n).enumerate() {
            let p = self.scope[(start + i) % SCOPE_POINTS];
            *o = [p[0] * norm, p[1] * norm];
        }
        n
    }

    fn threshold_on(&self) -> f32 {
        self.cfg
            .min_level
            .max(4.0 * self.calib.absent_env())
            .max(0.2 * self.a_ref)
    }

    fn reacquire(&mut self) {
        self.have_theta = false;
        self.gap = 0;
        self.slope_ema = 0.0;
        self.valid_run = 0;
        self.ring_pos = 0;
        self.acc_n = 0;
        self.acc_sum = 0.0;
        self.acc_sq = 0.0;
        self.win_n = 0;
        self.cand_n = 0;
        self.locked = false;
        self.err_hist = 0;
    }

    fn push_scope(&mut self, l: f32, r: f32) {
        self.scope_ctr += 1;
        if self.scope_ctr >= self.scope_decim {
            self.scope_ctr = 0;
            self.scope[self.scope_pos] = [r, l];
            self.scope_pos = (self.scope_pos + 1) % SCOPE_POINTS;
            self.scope_filled = (self.scope_filled + 1).min(SCOPE_POINTS);
        }
    }

    #[inline]
    fn step(&mut self, l_in: f32, r_in: f32) {
        let (mut l, mut r) = if self.cfg.swap_channels {
            (r_in, l_in)
        } else {
            (l_in, r_in)
        };
        if self.differentiate {
            let (dl, dr) = (l - self.diff_prev[0], r - self.diff_prev[1]);
            self.diff_prev = [l, r];
            l = dl;
            r = dr;
        }
        // One-pole DC blocker (identical on both channels → no L/R phase error).
        let yl = l - self.dc_x[0] + self.dc_r * self.dc_y[0];
        let yr = r - self.dc_x[1] + self.dc_r * self.dc_y[1];
        self.dc_x = [l, r];
        self.dc_y = [yl, yr];
        // For a quadrature pair the instantaneous envelope is exact.
        let e = (yl * yl + yr * yr).sqrt();
        self.env_s += self.env_coef * (e - self.env_s);
        self.push_scope(yl, yr);
        let held = self.a_ref * self.ref_decay;
        self.a_ref = if self.present {
            held.max(self.env_s)
        } else {
            held
        };

        let thr_on = self.threshold_on();
        if self.present {
            if self.env_s < 0.6 * thr_on {
                self.present = false;
                self.absent_run = 0;
                self.acc_n = 0;
            }
        } else if self.env_s > thr_on {
            self.present = true;
            if self.absent_run > self.hold_samples {
                self.reacquire();
            } else {
                self.gap = self.absent_run;
            }
        }
        if !self.present {
            self.absent_run = self.absent_run.saturating_add(1);
            self.calib.observe_absent(e);
            if self.absent_run > self.hold_samples {
                self.locked = false;
            }
            return;
        }
        self.calib.observe_present(yl, yr);

        let theta = (yl as f64).atan2(yr as f64);
        if !self.have_theta {
            self.have_theta = true;
            self.theta_prev = theta;
            self.phi = theta / TAU;
            self.acc_cycle = self.phi.floor() as i64;
            self.push_phase();
            return;
        }
        let dc = if self.gap > 0 {
            // Short dropout: extrapolate the phase with the last speed so cycle count survives.
            let predicted = self.slope_ema * (self.gap as f64 + 1.0);
            self.gap = 0;
            self.valid_run = 0;
            predicted + wrap_pi(theta - self.theta_prev - TAU * predicted) / TAU
        } else {
            let dc = wrap_pi(theta - self.theta_prev) / TAU;
            if self.valid_run >= 16 && (dc - self.slope_ema).abs() > 0.25 {
                // Phase discontinuity (needle drop / edit point): restart estimators and lock.
                self.valid_run = 0;
                self.win_n = 0;
                self.cand_n = 0;
                self.acc_n = 0;
                self.locked = false;
            } else {
                let alpha = if self.valid_run < 16 { 0.3 } else { 0.05 };
                self.slope_ema += alpha * (dc - self.slope_ema);
            }
            dc
        };
        self.theta_prev = theta;
        self.phi += dc;
        self.push_phase();
        self.track_bits(e);
    }

    #[inline]
    fn push_phase(&mut self) {
        self.ring[self.ring_pos] = self.phi;
        self.ring_pos = (self.ring_pos + 1) % self.ring.len();
        self.valid_run = self.valid_run.saturating_add(1);
    }

    #[inline]
    fn track_bits(&mut self, e: f32) {
        let c = self.phi.floor() as i64;
        if c != self.acc_cycle {
            let done = self.acc_cycle;
            self.acc_cycle = c;
            self.finish_cycle(done);
            self.acc_n = 0;
            self.acc_sum = 0.0;
            self.acc_sq = 0.0;
        }
        let frac = self.phi - c as f64;
        if (MID_LO..MID_HI).contains(&frac) {
            self.acc_sum += e;
            self.acc_sq += e * e;
            self.acc_n += 1;
        }
    }

    fn finish_cycle(&mut self, cycle: i64) {
        if self.acc_n < 2 {
            return;
        }
        let n = self.acc_n as f32;
        let m = self.acc_sum / n;
        self.calib.observe_cycle((self.acc_sq / n - m * m).max(0.0));
        let z = match &self.code {
            Some(code) => code.zero_level(),
            None => return,
        };
        // Bit-level AGC: fast attack on louder cycles, then one EMA that both classes pull
        // (zeros scaled by 1/z). A cycle clearly louder than the current "one" level means the
        // level was learnt on zeros only, so every bit read so far was a 0 misread as 1: the
        // window bits are all zeros (keep their count, no re-reading needed).
        if self.a_one > 0.0 && m > self.a_one * 0.5 * (1.0 + 1.0 / z) && !self.locked {
            self.win = 0;
            self.cand_n = 0;
        }
        if m > self.a_one {
            self.a_one = m;
        }
        let b = m > self.a_one * 0.5 * (1.0 + z);
        let target = if b { m } else { m / z };
        self.a_one += 0.1 * (target - self.a_one);
        self.push_bit(cycle, b);
    }

    fn push_bit(&mut self, c: i64, b: bool) {
        let Some(code) = self.code.clone() else {
            return;
        };
        let w = code.window_bits();
        let mask: u32 = if w >= 32 { u32::MAX } else { (1u32 << w) - 1 };
        let bit = u32::from(b);
        if self.win_n == 0 {
            self.win = bit;
            self.win_lo = c;
            self.win_n = 1;
        } else if c == self.win_lo + self.win_n as i64 {
            self.win_fwd = true;
            if self.win_n < w {
                self.win |= bit << self.win_n;
                self.win_n += 1;
            } else {
                self.win = (self.win >> 1) | (bit << (w - 1));
                self.win_lo += 1;
            }
        } else if c == self.win_lo - 1 {
            self.win_fwd = false;
            self.win = ((self.win << 1) | bit) & mask;
            self.win_lo = c;
            self.win_n = (self.win_n + 1).min(w);
        } else if c >= self.win_lo && c < self.win_lo + self.win_n as i64 {
            let i = (c - self.win_lo) as u32;
            self.win = (self.win & !(1 << i)) | (bit << i);
        } else {
            self.win = bit;
            self.win_lo = c;
            self.win_n = 1;
        }

        let len = code.len_cycles() as i64;
        if self.locked {
            let predicted = code.bit((c + self.offset).rem_euclid(len) as u32);
            let err = predicted != b;
            let hist_mask = (1u32 << ERROR_WINDOW) - 1;
            self.err_hist = ((self.err_hist << 1) | u32::from(err)) & hist_mask;
            self.valid_bits += 0.02 * (if err { 0.0 } else { 1.0 } - self.valid_bits);
            if self.err_hist.count_ones() >= UNLOCK_ERRORS {
                self.unlock_keep_recent();
            }
            return;
        }
        // Only lock while the phase tracker is coherent (no lock on noise or mid-discontinuity).
        if self.win_n < w || self.valid_run < self.min_run {
            return;
        }
        match code.lookup(self.win) {
            Some(k) => {
                let off = (k as i64 - self.win_lo).rem_euclid(len);
                if self.cand_n > 0 && off == self.cand_off {
                    self.cand_n += 1;
                } else {
                    self.cand_off = off;
                    self.cand_n = 1;
                }
                if self.cand_n >= LOCK_CONFIRM {
                    self.locked = true;
                    self.offset = off;
                    self.err_hist = 0;
                    self.valid_bits = 1.0;
                }
            }
            None => self.cand_n = 0,
        }
    }

    /// Lock lost to a burst of errors: keep only the window bits from the first error of the
    /// burst onwards (they all belong to the new groove position), so relock needs no garbage.
    fn unlock_keep_recent(&mut self) {
        let span = ERROR_WINDOW
            - self
                .err_hist
                .leading_zeros()
                .saturating_sub(32 - ERROR_WINDOW);
        let keep = span.min(self.win_n);
        if self.win_fwd {
            // Newest bits sit at the top of the window when moving forward.
            let drop = self.win_n - keep;
            self.win >>= drop;
            self.win_lo += drop as i64;
        } else if keep < 32 {
            self.win &= (1u32 << keep) - 1;
        }
        self.win_n = keep;
        self.locked = false;
        self.cand_n = 0;
        self.err_hist = 0;
    }

    /// Least-squares slope (cycles/sample) of the newest phase samples and the RMS residual.
    fn ls_slope(&self) -> Option<(f64, f64)> {
        let len = self.ring.len();
        let n = self.valid_run.min(len);
        if n < self.min_run {
            return None;
        }
        let start = (self.ring_pos + len - n) % len;
        let base = self.ring[start];
        let xm = (n as f64 - 1.0) * 0.5;
        let (mut sxy, mut sy, mut syy) = (0.0, 0.0, 0.0);
        for i in 0..n {
            let y = self.ring[(start + i) % len] - base;
            sxy += (i as f64 - xm) * y;
            sy += y;
            syy += y * y;
        }
        let nf = n as f64;
        let sxx = nf * (nf * nf - 1.0) / 12.0;
        let slope = sxy / sxx;
        let resid = ((syy - sy * sy / nf - slope * sxy) / nf).max(0.0).sqrt();
        Some((slope, resid))
    }

    fn compute_state(&self) -> DvsState {
        if !self.present {
            return DvsState::IDLE;
        }
        let Some((slope, resid)) = self.ls_slope() else {
            return DvsState {
                quality: self.quality(),
                ..DvsState::IDLE
            };
        };
        if resid > self.cfg.max_phase_residual as f64 {
            // Incoherent phase: noise, music or a needle in the run-out groove.
            return DvsState::IDLE;
        }
        let mut speed = (slope * self.sr / self.carrier) as f32;
        let stopped = speed.abs() < self.cfg.stop_speed;
        if stopped {
            speed = 0.0;
        }
        let direction = if stopped {
            Direction::Stopped
        } else if speed > 0.0 {
            Direction::Forward
        } else {
            Direction::Reverse
        };
        let position_sec = match (&self.code, self.locked) {
            (Some(code), true) => {
                let len = code.len_cycles() as f64;
                Some((self.phi + self.offset as f64).rem_euclid(len) / code.carrier_hz())
            }
            _ => None,
        };
        DvsState {
            speed,
            direction,
            position_sec,
            valid: true,
            stopped,
            locked: position_sec.is_some(),
            quality: self.quality(),
        }
    }

    fn quality(&self) -> f32 {
        if !self.present {
            return 0.0;
        }
        let q = ((self.calib.snr_db() - 10.0) / 20.0).clamp(0.0, 1.0);
        if self.locked { q * self.valid_bits } else { q }
    }
}
