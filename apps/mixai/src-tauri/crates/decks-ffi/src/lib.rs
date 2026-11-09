//! # decks-ffi — UniFFI surface of MixAI Decks (ADR-0014 D61, tracker WP19-04)
//!
//! One stable command / snapshot API for the native shells: SwiftUI (macOS, iPadOS, iOS) and
//! Kotlin (Android, Compose Multiplatform Desktop via JNA). Objects:
//!
//! * [`DecksEngine`] — 4-deck audio engine (`mixai-core`): background load + analysis
//!   (`decks-analysis`), transport, loops, cues, sync, key, mixer, routing, master clock, FX,
//!   and a cheap [`EngineSnapshot`] meant to be polled at 60–120 Hz.
//! * [`DecksLibrary`] — SQLite library (`decks-library`): scan, search, crates, smart crates,
//!   history, import / export / migration.
//! * [`DecksMapping`] + [`MidiClock`] — controller mapping engine (`decks-mapping`).
//! * [`DvsInput`] — timecode decoder (`decks-dvs`).
//! * [`DecksRenderer`] — wgpu deck views (`decks-render`), headless or on a native surface.
//! * [`DecksRemote`] — phone remote, second screen and Party DJ over the LAN (`decks-remote`).
//! * [`TransitionRunner`] + `transition_*` functions — AI Transition Designer (`decks-transition`).
//! * [`SetRecorder`] + `tracklist_export` — set recording with automatic tracklist (`decks-setlog`).
//!
//! Conventions (same as `crates/mixai-listen-ffi`): proc-macro UniFFI, **polling instead of
//! callbacks** (every foreign call happens on a thread the app owns), objects are `Send + Sync`
//! behind one `Mutex` each, the audio callback stays on the engine's own cpal thread, and every
//! failure is one [`DecksError`] enum (field `reason`, never `message`: Kotlin exceptions already
//! own `Throwable.message`). Documentation: `docs/decks/ffi.md`.

use std::sync::{Mutex, MutexGuard};

#[cfg(target_os = "android")]
mod android;
mod dvs;
mod engine;
mod library;
mod mapping;
mod remote;
mod render;
mod setlog;
mod transition;

pub use dvs::*;
pub use engine::*;
pub use library::*;
pub use mapping::*;
pub use remote::*;
pub use render::*;
pub use setlog::*;
pub use transition::*;

uniffi::setup_scaffolding!();

/// Every error the Decks FFI can return.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum DecksError {
    /// An argument is out of range or malformed.
    #[error("invalid argument: {reason}")]
    InvalidArgument { reason: String },
    /// The audio engine is stopped; call `DecksEngine.start()` first.
    #[error("engine not running: {reason}")]
    NotRunning { reason: String },
    /// Audio device / stream failure.
    #[error("audio: {reason}")]
    Audio { reason: String },
    /// File decoding failure.
    #[error("decode: {reason}")]
    Decode { reason: String },
    /// Library (SQLite / interop) failure.
    #[error("library: {reason}")]
    Library { reason: String },
    /// Mapping file / script / binding failure.
    #[error("mapping: {reason}")]
    Mapping { reason: String },
    /// DVS decoder construction failure.
    #[error("dvs: {reason}")]
    Dvs { reason: String },
    /// GPU renderer failure.
    #[error("render: {reason}")]
    Render { reason: String },
    /// The requested item does not exist.
    #[error("not found: {reason}")]
    NotFound { reason: String },
    /// The operation is not available (format, platform or engine capability).
    #[error("unsupported: {reason}")]
    Unsupported { reason: String },
}

impl DecksError {
    pub(crate) fn invalid(reason: impl Into<String>) -> Self {
        Self::InvalidArgument {
            reason: reason.into(),
        }
    }
}

/// Poison-tolerant lock: a panic on another thread must not wedge the native UI.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Version of this FFI surface (bump the minor on additive changes, the major on breaking ones).
#[uniffi::export]
pub fn decks_ffi_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
