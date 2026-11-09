//! MixAI Decks on-device stem separation (WP19-09, ADR-0014).
//!
//! * [`separate`] runs any [`SegmentModel`] over a whole track: resample to the model rate, cut into
//!   fixed segments with a 25 % linear cross-fade, overlap-add, resample back. Pure Rust, testable
//!   without a model.
//! * `OnnxSeparator` (feature `onnx`) is HT-Demucs v4 (MIT) exported to ONNX, run through ONNX Runtime
//!   with the platform accelerator (DirectML on Windows, CoreML on Apple, NNAPI / XNNPACK on Android,
//!   CPU everywhere else).
//! * [`StemCache`] stores the result as 32-bit float WAVs named like the MMO Server stems
//!   (`vocals.wav`, `drums.wav`, `bass.wav`, `other.wav`) so the server fallback and the on-device path
//!   fill the same cache.
//! * [`plan_source`] decides cache → device → server, the background pre-separation queue calls it.
//!
//! Output layer order is the mixai-core order (`0 = vocals, 1 = drums, 2 = bass, 3 = melody/other`),
//! ready for `Command::LoadStems`.

mod cache;
mod plan;
mod resample;
mod separate;

#[cfg(feature = "onnx")]
mod onnx;

pub use cache::{StemCache, cache_key};
pub use plan::{SourcePlan, StemSource, plan_source, server_stem_path};
pub use resample::resample_planar;
pub use separate::{Progress, SegmentModel, separate};

#[cfg(feature = "onnx")]
pub use onnx::{ExecutionTarget, OnnxSeparator, available_targets};

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

/// Stems in model order (HT-Demucs: drums, bass, other, vocals).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum StemKind {
    Drums,
    Bass,
    Other,
    Vocals,
}

impl StemKind {
    /// HT-Demucs output order.
    pub const MODEL_ORDER: [StemKind; 4] = [
        StemKind::Drums,
        StemKind::Bass,
        StemKind::Other,
        StemKind::Vocals,
    ];
    /// mixai-core `LoadStems` order (vocals, drums, bass, melody).
    pub const CORE_ORDER: [StemKind; 4] = [
        StemKind::Vocals,
        StemKind::Drums,
        StemKind::Bass,
        StemKind::Other,
    ];

    /// File stem used by the cache and the MMO Server (`/stems/:trackId/<name>.wav`).
    pub fn file_name(self) -> &'static str {
        match self {
            StemKind::Drums => "drums",
            StemKind::Bass => "bass",
            StemKind::Other => "other",
            StemKind::Vocals => "vocals",
        }
    }

    /// Index in [`StemKind::CORE_ORDER`].
    pub fn core_index(self) -> usize {
        match self {
            StemKind::Vocals => 0,
            StemKind::Drums => 1,
            StemKind::Bass => 2,
            StemKind::Other => 3,
        }
    }
}

/// One stereo stem, planar.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StemLayer {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

impl StemLayer {
    pub fn frames(&self) -> usize {
        self.left.len()
    }
}

/// Four stems at `sample_rate`, in [`StemKind::CORE_ORDER`].
#[derive(Clone, Debug, PartialEq)]
pub struct Stems {
    pub sample_rate: u32,
    pub layers: [StemLayer; 4],
}

impl Stems {
    pub fn layer(&self, kind: StemKind) -> &StemLayer {
        &self.layers[kind.core_index()]
    }

    pub fn frames(&self) -> usize {
        self.layers.iter().map(StemLayer::frames).min().unwrap_or(0)
    }
}

/// Cooperative cancel flag shared with the UI.
pub type CancelFlag = Arc<AtomicBool>;

#[derive(Debug, thiserror::Error)]
pub enum StemsError {
    #[error("input is empty")]
    EmptyInput,
    #[error("left/right length mismatch ({0} vs {1})")]
    ChannelMismatch(usize, usize),
    #[error("invalid sample rate {0}")]
    BadSampleRate(u32),
    #[error("model output has {got} values, expected {want}")]
    ModelShape { got: usize, want: usize },
    #[error("cancelled")]
    Cancelled,
    #[error("resampler: {0}")]
    Resample(String),
    #[error("model: {0}")]
    Model(String),
    #[error("cache: {0}")]
    Cache(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, StemsError>;
