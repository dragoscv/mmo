//! [`DvsInput`]: the `decks-dvs` timecode decoder for one deck input.

use std::sync::{Arc, Mutex, OnceLock};

use decks_dvs::{
    DecodeMode, Direction, DvsConfig, DvsDecoder, MixAiCode, SCOPE_POINTS, TimecodeFormat,
    TimecodeGenerator,
};

use crate::{DecksError, lock};

/// One shared MixAI code table (4 MiB) for every DVS input in the process.
fn mixai_code() -> Arc<MixAiCode> {
    static CODE: OnceLock<Arc<MixAiCode>> = OnceLock::new();
    CODE.get_or_init(|| Arc::new(MixAiCode::new())).clone()
}

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Enum)]
pub enum DvsFormat {
    /// MixAI timecode (1 kHz, absolute + relative).
    MixAi,
    /// Serato CV02.5 (relative, experimental).
    SeratoCv25,
    /// Traktor MK2 (relative, experimental).
    TraktorMk2,
    /// Phase (not supported: no public signal description).
    Phase,
    /// Any other quadrature carrier (relative).
    Custom {
        carrier_hz: f32,
        differentiate: bool,
    },
}

impl From<DvsFormat> for TimecodeFormat {
    fn from(f: DvsFormat) -> Self {
        match f {
            DvsFormat::MixAi => Self::MixAi,
            DvsFormat::SeratoCv25 => Self::SeratoCv25,
            DvsFormat::TraktorMk2 => Self::TraktorMk2,
            DvsFormat::Phase => Self::Phase,
            DvsFormat::Custom {
                carrier_hz,
                differentiate,
            } => Self::Custom {
                carrier_hz,
                differentiate,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum DvsMode {
    Relative,
    Absolute,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum DvsDirection {
    Forward,
    Reverse,
    Stopped,
}

/// Decoder settings (`None` = crate default for the format).
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct DvsSettings {
    pub format: DvsFormat,
    pub sample_rate: u32,
    /// `None` = absolute when the format supports it.
    pub mode: Option<DvsMode>,
    pub swap_channels: bool,
    /// Speed estimator window, ms (default 8).
    pub speed_window_ms: Option<f32>,
    /// |speed| below this counts as stopped (default 0.03).
    pub stop_speed: Option<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct DvsReading {
    /// Signed speed relative to nominal (1.0 = 33⅓).
    pub speed: f32,
    pub direction: DvsDirection,
    /// Needle position, seconds (absolute mode while locked).
    pub position_sec: Option<f64>,
    pub valid: bool,
    pub stopped: bool,
    pub locked: bool,
    /// 0..1.
    pub quality: f32,
}

impl From<decks_dvs::DvsState> for DvsReading {
    fn from(s: decks_dvs::DvsState) -> Self {
        Self {
            speed: s.speed,
            direction: match s.direction {
                Direction::Forward => DvsDirection::Forward,
                Direction::Reverse => DvsDirection::Reverse,
                Direction::Stopped => DvsDirection::Stopped,
            },
            position_sec: s.position_sec,
            valid: s.valid,
            stopped: s.stopped,
            locked: s.locked,
            quality: s.quality,
        }
    }
}

/// Calibration panel data.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct DvsCalibration {
    pub present: bool,
    pub level_left_dbfs: f32,
    pub level_right_dbfs: f32,
    pub balance_db: f32,
    pub phase_error_deg: f32,
    pub noise_floor_dbfs: f32,
    pub snr_db: f32,
    pub valid_bits_pct: Option<f32>,
    pub threshold: f32,
    pub speed: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct ScopePoint {
    pub x: f32,
    pub y: f32,
}

struct DvsInner {
    dec: DvsDecoder,
    scope: Vec<[f32; 2]>,
}

/// Timecode decoder for one deck. Call `process` from the audio input callback (it does not
/// allocate); poll `report` / `scope_points` from the UI.
#[derive(uniffi::Object)]
pub struct DvsInput {
    state: Mutex<DvsInner>,
}

#[uniffi::export]
impl DvsInput {
    #[uniffi::constructor]
    pub fn new(settings: DvsSettings) -> Result<Self, DecksError> {
        let format: TimecodeFormat = settings.format.into();
        let mut cfg = DvsConfig::new(format, settings.sample_rate);
        if let Some(m) = settings.mode {
            cfg = cfg.with_mode(match m {
                DvsMode::Relative => DecodeMode::Relative,
                DvsMode::Absolute => DecodeMode::Absolute,
            });
        }
        cfg.swap_channels = settings.swap_channels;
        if let Some(w) = settings.speed_window_ms {
            cfg.speed_window_ms = w;
        }
        if let Some(s) = settings.stop_speed {
            cfg.stop_speed = s;
        }
        let dec = if cfg.mode == DecodeMode::Absolute && format == TimecodeFormat::MixAi {
            DvsDecoder::with_code(cfg, mixai_code())
        } else {
            DvsDecoder::new(cfg)
        }
        .map_err(|e| DecksError::Dvs {
            reason: e.to_string(),
        })?;
        Ok(Self {
            state: Mutex::new(DvsInner {
                dec,
                scope: vec![[0.0; 2]; SCOPE_POINTS],
            }),
        })
    }

    /// Decode interleaved stereo `[L, R, L, R, …]`.
    pub fn process(&self, interleaved: Vec<f32>) -> DvsReading {
        let frames = interleaved.len() / 2;
        lock(&self.state).dec.process(&interleaved, frames).into()
    }

    pub fn reading(&self) -> DvsReading {
        lock(&self.state).dec.state().into()
    }

    pub fn report(&self) -> DvsCalibration {
        let r = lock(&self.state).dec.report();
        DvsCalibration {
            present: r.present,
            level_left_dbfs: r.level_left_dbfs,
            level_right_dbfs: r.level_right_dbfs,
            balance_db: r.balance_db,
            phase_error_deg: r.phase_error_deg,
            noise_floor_dbfs: r.noise_floor_dbfs,
            snr_db: r.snr_db,
            valid_bits_pct: r.valid_bits_pct,
            threshold: r.threshold,
            speed: r.speed,
        }
    }

    /// Newest X/Y scope points (oldest first, up to 512).
    pub fn scope_points(&self) -> Vec<ScopePoint> {
        let mut s = lock(&self.state);
        let DvsInner { dec, scope } = &mut *s;
        let n = dec.scope(scope);
        scope[..n]
            .iter()
            .map(|p| ScopePoint { x: p[0], y: p[1] })
            .collect()
    }

    pub fn reset(&self) {
        lock(&self.state).dec.reset();
    }
}

/// Render MixAI timecode as interleaved stereo (test signals, demo mode, cutting).
#[uniffi::export]
pub fn dvs_generate_mixai(sample_rate: u32, start_sec: f64, speed: f64, frames: u32) -> Vec<f32> {
    let code = mixai_code();
    let g = TimecodeGenerator::new(code, sample_rate, decks_dvs::DEFAULT_LEVEL);
    let mut out = vec![0.0f32; frames as usize * 2];
    g.render(start_sec * decks_dvs::MIXAI_CARRIER_HZ, speed, &mut out);
    out
}
