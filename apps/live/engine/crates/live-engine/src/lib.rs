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

#[cfg(test)]
#[global_allocator]
static ALLOC: assert_no_alloc::AllocDisabler = assert_no_alloc::AllocDisabler;
