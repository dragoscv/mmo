//! # decks-dvs — MixAI Decks digital vinyl system (DVS) decoder
//!
//! Clean-room implementation (ADR-0014, decision D65). No code, tables or constants from xwax,
//! Mixxx or any other GPL timecode implementation were viewed or used; see
//! `docs/decks/dvs-clean-room.md` for the list of public sources consulted.
//!
//! ## Pipeline
//!
//! ```text
//! stereo in ─► [optional d/dt] ─► DC blocker ─► envelope/AGC ─► presence gate
//!                                      │
//!                                      └─► atan2(L, R) ─► unwrap ─► phase ring ─► LS slope ─► speed
//!                                                            │
//!                                                            └─► per-cycle mid amplitude ─► bit ─► PositionCode ─► position
//! ```
//!
//! * Relative mode works for any quadrature carrier (MixAI, Serato CV02.5, Traktor MK2 — the
//!   latter two marked experimental until checked against real media).
//! * Absolute mode is built around the pluggable [`PositionCode`] trait. The only shipped
//!   implementation is our own [`MixAiCode`] (1 kHz, 20-bit maximal LFSR, AM bits).
//! * [`DvsDecoder::process`] performs no heap allocation (proved by `tests/no_alloc.rs`).
//!
//! ```no_run
//! use decks_dvs::{DvsConfig, DvsDecoder, TimecodeFormat};
//! let mut dec = DvsDecoder::new(DvsConfig::new(TimecodeFormat::MixAi, 48_000)).unwrap();
//! let block = vec![0.0f32; 512]; // 256 interleaved stereo frames from the audio callback
//! let state = dec.process(&block, 256);
//! if state.valid { let _ = (state.speed, state.position_sec); }
//! ```

#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod calibration;
mod code;
mod decoder;
mod format;
pub mod generator;

pub use calibration::SignalReport;
pub use code::{
    MIXAI_CARRIER_HZ, MIXAI_LFSR_BITS, MIXAI_LFSR_SEED, MIXAI_LFSR_TAP, MIXAI_ZERO_LEVEL,
    MixAiCode, PositionCode,
};
pub use decoder::{
    DecodeMode, Direction, DvsConfig, DvsDecoder, DvsError, DvsState, LOCK_CONFIRM, SCOPE_POINTS,
    UNLOCK_ERRORS,
};
pub use format::{Support, TimecodeFormat};
pub use generator::{DEFAULT_LEVEL, TimecodeGenerator, max_minutes, write_timecode_wav};
