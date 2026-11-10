//! mixai-core — the MIXAI real-time DJ audio engine.
//!
//! Permissive-only DSP (cpal, symphonia, rubato, hand-written biquads). No
//! GPL/AGPL code links here so the engine stays distributable inside a
//! proprietary/commercial MIXAI build. See `docs/mixai/00-architecture-and-plan.md`.

pub mod analysis;
pub mod beatfx;
pub mod beatgrid;
pub mod colorfx;
pub mod deck;
pub mod decoder;
pub mod dsp;
pub mod engine;
pub mod error;
pub mod fx;
pub mod keys;
pub mod output;
pub mod recorder;
pub mod routing;
pub mod sampler;
pub mod state;
pub mod stretch;

pub use analysis::{BeatAnalysis, analyze};
pub use beatfx::BeatFxKind;
pub use beatgrid::{
    BeatGrid, GridAnchor, MAX_BPM, MIN_BPM, TempoMarker, TempoSection, valid_bpm, valid_sec,
};
pub use colorfx::ColorFxKind;
pub use engine::{ClockSource, ClockState, Command, DeckClock, Engine, list_output_devices};
pub use error::CoreError;
pub use output::{
    BufferChoice, ConfigChoice, ConfigRange, DefaultConfig, OutputInfo, choose_config,
    find_output_device,
};
pub use routing::{OutputMode, RoutingConfig};
pub use state::{AudioDevice, CrossfaderAssign, CrossfaderCurve, DeckId, DeckState, MixerState};
pub use stretch::{Stretcher, StretcherKind};
