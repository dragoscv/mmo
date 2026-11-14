//! MixAI Live engine: device I/O, the realtime core, presets/setlists and the control session.
//! See ADR-0015 and `docs/live/architecture.md`.

pub mod checkup;
pub mod control;
pub mod core;
pub mod io;
pub mod latency;
pub mod midi;
pub mod preset;
pub mod sample;
pub mod session;
pub mod spectrum;
pub mod store;
pub mod voicemeeter;
#[cfg(windows)]
pub mod wasapi;

pub use crate::core::{Buses, Command, Core, Garbage, Meters, ProbeState};
pub use control::{Control, Role};
pub use io::{DeviceInfo, IoConfig, IoError, Running, RunningInfo, list_devices};
pub use midi::{MidiMap, MidiState, MidiTarget};
pub use preset::{Preset, Setlist, Song, SongPart, factory};
pub use session::{Session, SessionError, SessionState};
pub use store::Store;

// `assert_no_alloc::AllocDisabler` exists in debug builds only (its default `warn_debug` feature
// gates it on `debug_assertions`), so the allocator is declared exactly where it exists: without the
// `debug_assertions` term `cargo test --release` does not compile on Windows, which is the profile
// the two ignored measurements (`untuned_cpu_cost`, `voice_path_cpu_cost`) ask for.
#[cfg(all(test, debug_assertions))]
#[global_allocator]
static ALLOC: assert_no_alloc::AllocDisabler = assert_no_alloc::AllocDisabler;
