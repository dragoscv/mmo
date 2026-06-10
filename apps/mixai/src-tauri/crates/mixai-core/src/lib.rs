//! mixai-core — the MIXAI real-time DJ audio engine.
//!
//! Permissive-only DSP (cpal, symphonia, rubato, hand-written biquads). No
//! GPL/AGPL code links here so the engine stays distributable inside a
//! proprietary/commercial MIXAI build. See `docs/mixai/00-architecture-and-plan.md`.

pub mod decoder;
pub mod deck;
pub mod dsp;
pub mod engine;
pub mod error;
pub mod state;
pub mod analysis;
pub mod stretch;
pub mod recorder;
pub mod fx;
pub mod sampler;

pub use engine::{list_output_devices, Command, Engine};
pub use error::CoreError;
pub use analysis::{analyze, BeatAnalysis};
pub use state::{
    AudioDevice, CrossfaderAssign, CrossfaderCurve, DeckId, DeckState, MixerState,
};
