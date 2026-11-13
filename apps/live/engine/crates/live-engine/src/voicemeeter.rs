//! Voicemeeter (VB-Audio) integration over the Voicemeeter Remote API, Windows only.
//!
//! * [`info`]: what Voicemeeter runs and where each strip sits in the input-insert buffer (read-only).
//! * host [`crate::io::VOICEMEETER_INSERT`]: the engine runs inside Voicemeeter's own audio
//!   callback as an input insert, so the voice never leaves Voicemeeter's stream.
//!
//! The types are compiled on every platform (the CLI and the desktop shell print / read them);
//! everything that touches the DLL is Windows-only.
//!
//! Source of every layout and return code below: the official `VoicemeeterRemote.h` and the SDK
//! example `vmr_play.c` (VB-Audio). `Command.Save` / `Command.Load` come from the Remote API
//! manual; they were never sent to a live Voicemeeter from this code (see the control functions).

use serde::{Deserialize, Serialize};
use std::path::Path;

/// One Voicemeeter input strip and its channels in the input-insert buffer.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct StripInfo {
    /// 0-based strip index, as in the Remote API (`Strip[index]`).
    pub index: u32,
    /// `"hardware"` (2 channels) or `"virtual"` (8 channels).
    pub kind: String,
    pub label: String,
    /// Device selected on a hardware strip; empty when none (and for virtual strips).
    pub device: String,
    /// 0-based channel indices of this strip in the insert buffer (what `--in-ch` / `--main` take).
    pub channels: Vec<u16>,
    /// The strip is routed to bus A1 / B1.
    pub a1: bool,
    pub b1: bool,
}

/// Read-only picture of the local Voicemeeter. Fields are `None` / empty when Voicemeeter is not
/// installed or not running.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct VoicemeeterInfo {
    pub installed: bool,
    pub running: bool,
    /// `"standard"`, `"banana"` or `"potato"`.
    pub kind: Option<String>,
    /// e.g. `"3.1.2.2"`.
    pub version: Option<String>,
    pub sample_rate: Option<u32>,
    /// Buffer sizes (frames) Voicemeeter uses per driver type of the A1 device.
    pub buffer_mme: Option<u32>,
    pub buffer_wdm: Option<u32>,
    pub buffer_ks: Option<u32>,
    pub buffer_asio: Option<u32>,
    /// Device on bus A1 (the bus that clocks Voicemeeter's stream).
    pub a1_device: Option<String>,
    /// Channels of the input-insert buffer (12 / 22 / 34); 0 when unknown.
    pub insert_channels: u16,
    pub strips: Vec<StripInfo>,
}

/// Voicemeeter is installed on this machine (the insert host is offered only then).
pub fn installed() -> bool {
    #[cfg(windows)]
    {
        win::dll_path().is_some_and(|p| p.is_file())
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// What the local Voicemeeter runs. Never changes anything in Voicemeeter.
pub fn info() -> VoicemeeterInfo {
    #[cfg(windows)]
    {
        win::info()
    }
    #[cfg(not(windows))]
    {
        VoicemeeterInfo::default()
    }
}

/// Ask Voicemeeter to save its whole configuration to `path` (its own XML format). Changes
/// nothing in Voicemeeter. Take one before [`set_buffer`].
///
/// `path` must be absolute. Fails when the file is not there (and larger than a stub) a few
/// seconds after Voicemeeter accepted the request.
pub fn save_snapshot(path: &Path) -> Result<(), String> {
    let file = plan::snapshot_path(path)?;
    #[cfg(windows)]
    {
        win::save_snapshot(path, &file)
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        Err(plan::NOT_WINDOWS.into())
    }
}

/// Ask Voicemeeter to load a configuration saved by [`save_snapshot`]. Voicemeeter restarts
/// its audio (a short dropout for everything that plays through it).
pub fn load_snapshot(path: &Path) -> Result<(), String> {
    let file = plan::snapshot_path(path)?;
    #[cfg(windows)]
    {
        win::load_snapshot(path, &file)
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        Err(plan::NOT_WINDOWS.into())
    }
}

/// Set the buffer size Voicemeeter uses for one driver type (`"mme"`, `"wdm"`, `"ks"`,
/// `"asio"`) and restart its audio engine. Applies to everything that plays through Voicemeeter.
/// `frames` must be within 64..=2048.
pub fn set_buffer(driver: &str, frames: u32) -> Result<(), String> {
    let param = plan::buffer_param(driver, frames)?;
    #[cfg(windows)]
    {
        win::set_buffer(&param, frames)
    }
    #[cfg(not(windows))]
    {
        let _ = param;
        Err(plan::NOT_WINDOWS.into())
    }
}

/// The one pseudo device of the insert host.
#[cfg(windows)]
pub(crate) fn devices() -> Result<Vec<crate::io::DeviceInfo>, crate::io::IoError> {
    if !installed() {
        return Err(crate::io::IoError::NotFound(
            "Voicemeeter is not installed".into(),
        ));
    }
    let vm = info();
    // 34 = the largest insert buffer (Potato) when the type cannot be read.
    let channels = if vm.insert_channels == 0 {
        34
    } else {
        vm.insert_channels
    };
    Ok(vec![crate::io::DeviceInfo {
        id: "voicemeeter-insert".into(),
        name: "Voicemeeter input insert".into(),
        host: crate::io::VOICEMEETER_INSERT.into(),
        input_channels: channels,
        output_channels: channels,
        default_rate: vm.sample_rate.unwrap_or(48_000),
        is_default_input: true,
        is_default_output: true,
        voicemeeter: true,
        virtual_cable: false,
    }])
}

/// Start processing inside Voicemeeter's input insert. `cfg.input_channels` / `cfg.main_channels`
/// are 0-based channels of the insert buffer (see [`StripInfo::channels`]); the sample rate and
/// the buffer size are Voicemeeter's, the requested ones are not used.
#[cfg(windows)]
pub(crate) fn start(cfg: &crate::io::IoConfig) -> Result<crate::io::Running, crate::io::IoError> {
    win::start(cfg)
}

/// Layout of the insert buffer, routing and input validation: pure, compiled and tested on
/// every platform (only Windows calls it outside tests).
#[cfg_attr(not(windows), allow(dead_code))]
mod plan {
    use super::StripInfo;
    use crate::io::{IoConfig, IoError};
    use std::path::{Path, PathBuf};
    use std::time::SystemTime;

    #[cfg_attr(windows, allow(dead_code))]
    pub const NOT_WINDOWS: &str = "Voicemeeter exists only on Windows";
    pub const SAVE: &str = "Command.Save";
    pub const LOAD: &str = "Command.Load";
    pub const RESTART: &str = "Command.Restart";
    /// A saved configuration smaller than this is a failed save (a default Potato file is about
    /// 300 kB on the machine this was written on).
    pub const MIN_SNAPSHOT_BYTES: u64 = 1024;
    pub const DRIVERS: [&str; 4] = ["mme", "wdm", "ks", "asio"];
    pub const BUFFER_MIN: u32 = 64;
    pub const BUFFER_MAX: u32 = 2048;

    /// (hardware strips, virtual strips) of a Voicemeeter type as `VBVMR_GetVoicemeeterType`
    /// returns it: 1 = standard, 2 = Banana, 3 = Potato.
    pub fn strips(vm_type: i32) -> Option<(u32, u32)> {
        match vm_type {
            1 => Some((2, 1)),
            2 => Some((3, 2)),
            3 => Some((5, 3)),
            _ => None,
        }
    }

    pub fn kind(vm_type: i32) -> Option<&'static str> {
        match vm_type {
            1 => Some("standard"),
            2 => Some("banana"),
            3 => Some("potato"),
            _ => None,
        }
    }

    /// Channels of the input-insert buffer: a hardware strip has 2, a virtual strip 8
    /// (12 / 22 / 34 in the header's `VBVMR_CBCOMMAND_BUFFER_IN` tables); 0 = unknown type.
    pub fn insert_channels(vm_type: i32) -> u16 {
        strips(vm_type).map_or(0, |(hw, virt)| (hw * 2 + virt * 8) as u16)
    }

    pub fn strip_kind(vm_type: i32, index: u32) -> &'static str {
        match strips(vm_type) {
            Some((hw, _)) if index >= hw => "virtual",
            _ => "hardware",
        }
    }

    /// 0-based channels of one strip in the insert buffer; empty for an unknown type or strip.
    pub fn strip_channels(vm_type: i32, index: u32) -> Vec<u16> {
        let Some((hw, virt)) = strips(vm_type) else {
            return Vec::new();
        };
        let (first, count) = if index < hw {
            (index * 2, 2)
        } else if index < hw + virt {
            (hw * 2 + (index - hw) * 8, 8)
        } else {
            return Vec::new();
        };
        (first..first + count).map(|c| c as u16).collect()
    }

    /// `VBVMR_GetVoicemeeterVersion`: one byte per part, most significant first.
    pub fn version_text(v: i32) -> String {
        let v = v as u32;
        format!(
            "{}.{}.{}.{}",
            v >> 24,
            (v >> 16) & 0xFF,
            (v >> 8) & 0xFF,
            v & 0xFF
        )
    }

    /// Install folder from the registry's `UninstallString` (the uninstaller's full path).
    pub fn uninstall_folder(uninstall: &str) -> Option<PathBuf> {
        let s = uninstall.trim().trim_matches('"');
        let cut = s.rfind(['\\', '/'])?;
        (cut > 0).then(|| PathBuf::from(&s[..cut]))
    }

    /// Parameter name for a buffer size, e.g. `Option.buffer.wdm`.
    pub fn buffer_param(driver: &str, frames: u32) -> Result<String, String> {
        let driver = driver.trim().to_ascii_lowercase();
        if !DRIVERS.contains(&driver.as_str()) {
            return Err(format!(
                "unknown driver type `{driver}` (mme, wdm, ks, asio)"
            ));
        }
        if !(BUFFER_MIN..=BUFFER_MAX).contains(&frames) {
            return Err(format!(
                "buffer {frames} is outside {BUFFER_MIN}..{BUFFER_MAX} frames"
            ));
        }
        Ok(format!("Option.buffer.{driver}"))
    }

    /// The file name handed to `Command.Save` / `Command.Load`: absolute, with a file name, and
    /// nothing Voicemeeter's parameter parser could trip on.
    pub fn snapshot_path(path: &Path) -> Result<String, String> {
        if !path.is_absolute() {
            return Err(format!(
                "{} is not an absolute path (Voicemeeter resolves relative paths against its own folder)",
                path.display()
            ));
        }
        if path.file_name().is_none() {
            return Err(format!("{} names no file", path.display()));
        }
        let Some(text) = path.to_str() else {
            return Err(format!("{} is not valid Unicode", path.display()));
        };
        if text.chars().any(|c| c == '"' || c.is_control()) {
            return Err(format!("{text:?} contains a quote or a control character"));
        }
        // String parameters travel in 512-character buffers.
        if text.encode_utf16().count() > 500 {
            return Err("the path is longer than 500 characters".into());
        }
        Ok(text.to_owned())
    }

    /// The saved file is there: big enough, and newer than what was there before the request.
    pub fn snapshot_written(
        len: u64,
        modified: Option<SystemTime>,
        before: Option<SystemTime>,
    ) -> bool {
        len >= MIN_SNAPSHOT_BYTES
            && match (before, modified) {
                (Some(b), Some(m)) => m > b,
                _ => true,
            }
    }

    /// Channels of the insert buffer the engine reads and writes.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Route {
        /// Insert channels fed to the engine (`inputs` of them are used).
        pub input: [usize; 2],
        pub inputs: usize,
        /// Insert channels that receive the engine's main bus (equal = one channel, mono mix).
        pub main: [usize; 2],
    }

    /// Check the routing of `cfg` against an insert buffer of `channels` channels.
    pub fn route(cfg: &IoConfig, channels: u16) -> Result<Route, IoError> {
        if cfg.monitor_channels.is_some() {
            return Err(IoError::Config(
                "the Voicemeeter insert has no monitor bus: a monitor pair would replace the audio of other strips (leave the monitor channels out)".into(),
            ));
        }
        let n = cfg.input_channels.len();
        if !(1..=2).contains(&n) {
            return Err(IoError::Config(format!(
                "the Voicemeeter insert takes 1 or 2 input channels, got {n}"
            )));
        }
        let used = cfg.input_channels.iter().chain(&cfg.main_channels);
        if let Some(bad) = used.copied().find(|c| *c >= channels) {
            return Err(IoError::Config(format!(
                "channel {bad} is outside Voicemeeter's insert buffer ({channels} channels, 0-based)"
            )));
        }
        let first = cfg.input_channels[0] as usize;
        Ok(Route {
            input: [
                first,
                cfg.input_channels.get(1).map_or(first, |c| *c as usize),
            ],
            inputs: n,
            main: cfg.main_channels.map(|c| c as usize),
        })
    }

    /// The engine's own view: a 1- or 2-channel input and a 2-channel output. A main pair on one
    /// insert channel stays a pair on one channel, so the engine writes the mono mix there.
    pub fn engine_config(route: &Route) -> IoConfig {
        IoConfig {
            input_channels: (0..route.inputs as u16).collect(),
            main_channels: if route.main[0] == route.main[1] {
                [0, 0]
            } else {
                [0, 1]
            },
            monitor_channels: None,
            ..IoConfig::default()
        }
    }

    pub fn strip_of(strips: &[StripInfo], channel: usize) -> Option<&StripInfo> {
        strips
            .iter()
            .find(|s| s.channels.iter().any(|c| *c as usize == channel))
    }

    /// Name of a set of insert channels for people: the strip (index as in the Remote API, and
    /// its label) plus the channels.
    pub fn describe(strips: &[StripInfo], channels: &[usize]) -> String {
        let mut list: Vec<usize> = Vec::new();
        for c in channels {
            if !list.contains(c) {
                list.push(*c);
            }
        }
        let text: Vec<String> = list.iter().map(usize::to_string).collect();
        let chans = format!(
            "insert channel{} {}",
            if list.len() == 1 { "" } else { "s" },
            text.join("+")
        );
        match list.first().and_then(|c| strip_of(strips, *c)) {
            Some(s) if s.label.trim().is_empty() => {
                format!("Voicemeeter Strip[{}], {chans}", s.index)
            }
            Some(s) => format!("Voicemeeter Strip[{}] \"{}\", {chans}", s.index, s.label),
            None => format!("Voicemeeter {chans}"),
        }
    }

    /// Calculated, not measured: Voicemeeter's input buffer plus its A1 output buffer.
    pub fn nominal_ms(frames: u32, rate: u32) -> f32 {
        (frames as f32 * 2.0) / rate.max(1) as f32 * 1000.0
    }
}

/// The processing step of the insert callback: pure Rust over the raw channel pointers of a
/// `VBVMR_T_AUDIOBUFFER`, no DLL, so it is tested with fake buffers on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
mod insert {
    use super::plan::{self, Route};
    use crate::io::{self, Duplex, Ends, InCb, IoError, OutCb};

    /// `VBVMR_T_AUDIOINFO` (`long` = 32-bit). Natural alignment: in the header both audio
    /// structs sit outside the `#pragma pack(1)` regions (those wrap only the VBAN packets).
    #[repr(C)]
    pub struct AudioInfo {
        pub samplerate: i32,
        pub nb_sample_per_frame: i32,
    }

    /// `VBVMR_T_AUDIOBUFFER`: `nbi` input and `nbo` output channel pointers, `nbs` f32 frames
    /// each (non-interleaved).
    #[repr(C)]
    pub struct AudioBuffer {
        pub sr: i32,
        pub nbs: i32,
        pub nbi: i32,
        pub nbo: i32,
        pub r: [*const f32; 128],
        pub w: [*mut f32; 128],
    }

    /// Everything the callback needs once Voicemeeter has told us its sample rate and block
    /// size. Built on the control thread, then owned by the callback.
    pub struct Engine {
        on_input: InCb,
        on_output: OutCb,
        pub route: Route,
        pub max_block: usize,
        /// Interleaved copy of the routed input channel(s), `inputs × max_block`.
        in_scratch: Vec<f32>,
        /// Interleaved main bus, `2 × max_block`.
        out_scratch: Vec<f32>,
    }

    impl Engine {
        /// The engine over a `inputs`-channel input and a 2-channel output, cushion 0: input and
        /// output are the same callback, so the input of a block is queued before its output is
        /// rendered.
        pub fn build(route: Route, rate: u32, max_block: usize) -> Result<(Engine, Ends), IoError> {
            let cfg = plan::engine_config(&route);
            let Duplex {
                on_input,
                on_output,
                ends,
            } = io::duplex(&cfg, rate, route.inputs as u16, 2, 0, max_block)?;
            Ok((
                Engine {
                    on_input,
                    on_output,
                    route,
                    max_block,
                    in_scratch: vec![0.0; max_block * route.inputs],
                    out_scratch: vec![0.0; max_block * 2],
                },
                ends,
            ))
        }

        /// An engine whose input step counts the call and panics (tests of the panic barrier in
        /// the callback).
        #[cfg(test)]
        pub fn poisoned(
            route: Route,
            max_block: usize,
            hits: std::sync::Arc<std::sync::atomic::AtomicU32>,
        ) -> Engine {
            Engine {
                on_input: Box::new(move |_| {
                    hits.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    panic!("poisoned test engine");
                }),
                on_output: Box::new(|_| {}),
                route,
                max_block,
                in_scratch: vec![0.0; max_block * route.inputs],
                out_scratch: vec![0.0; max_block * 2],
            }
        }
    }

    /// What one call did (for tests and logging).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Outcome {
        /// Every channel copied dry; the engine ran and wrote the main channel(s).
        Processed,
        /// Every channel copied dry; the engine did not run (not ready, stopped, dead, block
        /// too large, a routed channel missing or null).
        PassThrough,
        /// The buffer is not an input insert we understand (`nbi != nbo`, no frames): only the
        /// channels present on both sides were copied.
        Mismatch,
    }

    /// One insert block. First every channel is copied from `r` to `w` (an insert that does not
    /// copy silences every other strip), then, when the engine can run, the routed input
    /// channel(s) are fed to it and its main bus replaces the main channel(s). Whenever the engine
    /// cannot run the microphone stays dry: never silence, never stale data.
    ///
    /// Runs on Voicemeeter's time-critical thread: no allocation, no lock, no syscall.
    ///
    /// # Safety
    /// Every non-null pointer in `buf.r[..nbi]` / `buf.w[..nbo]` must point to `buf.nbs`
    /// readable (`r`) / writable (`w`) `f32`s for the duration of the call, as Voicemeeter
    /// guarantees for the buffer it hands to the callback.
    pub unsafe fn process(buf: &AudioBuffer, engine: Option<&mut Engine>, ready: bool) -> Outcome {
        let frames = buf.nbs.max(0) as usize;
        let nbi = buf.nbi.clamp(0, 128) as usize;
        let nbo = buf.nbo.clamp(0, 128) as usize;
        for c in 0..nbi.min(nbo) {
            let w = buf.w[c];
            if w.is_null() {
                continue;
            }
            let r = buf.r[c];
            // SAFETY: caller contract (`frames` samples behind every non-null pointer); `copy`
            // tolerates overlap, and a channel with no input is written as silence rather than
            // left with whatever the output buffer held.
            unsafe {
                if r.is_null() {
                    std::ptr::write_bytes(w, 0, frames);
                } else if r != w.cast_const() {
                    std::ptr::copy(r, w, frames);
                }
            }
        }
        if frames == 0 || nbi == 0 || nbi != nbo {
            return Outcome::Mismatch;
        }
        let Some(e) = engine else {
            return Outcome::PassThrough;
        };
        if !ready || frames > e.max_block {
            return Outcome::PassThrough;
        }
        let route = e.route;
        let n = route.inputs;
        let present = |c: usize| c < nbi && !buf.r[c].is_null() && !buf.w[c].is_null();
        if !route.input[..n]
            .iter()
            .chain(&route.main)
            .all(|c| present(*c))
        {
            return Outcome::PassThrough;
        }
        let inp = &mut e.in_scratch[..frames * n];
        for (k, &c) in route.input[..n].iter().enumerate() {
            let src = buf.r[c];
            for (f, slot) in inp.iter_mut().skip(k).step_by(n).enumerate() {
                // SAFETY: `c < nbi`, non-null, `f < frames` (caller contract).
                *slot = unsafe { *src.add(f) };
            }
        }
        (e.on_input)(inp);
        let out = &mut e.out_scratch[..frames * 2];
        (e.on_output)(out);
        let [m0, m1] = route.main;
        // SAFETY: both main channels were checked present; `f < frames`.
        unsafe {
            let w0 = buf.w[m0];
            if m0 == m1 {
                // A pair on one channel: the engine wrote the mono mix to its channel 0.
                for (f, s) in out.as_chunks::<2>().0.iter().enumerate() {
                    *w0.add(f) = s[0];
                }
            } else {
                let w1 = buf.w[m1];
                for (f, s) in out.as_chunks::<2>().0.iter().enumerate() {
                    *w0.add(f) = s[0];
                    *w1.add(f) = s[1];
                }
            }
        }
        Outcome::Processed
    }
}

/// What Voicemeeter's audio callback and the control side share, and the callback itself. No DLL
/// here, so tests drive the callback with fake buffers on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
mod host {
    use super::insert::{self, AudioBuffer, AudioInfo, Engine, Outcome};
    use std::ffi::c_void;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, AtomicU64, Ordering};

    /// `VBVMR_CBCOMMAND_*` (VoicemeeterRemote.h).
    pub const STARTING: i32 = 1;
    pub const ENDING: i32 = 2;
    pub const CHANGE: i32 = 3;
    pub const BUFFER_IN: i32 = 10;
    /// `VBVMR_AUDIOCALLBACK_IN`: the input insert.
    pub const MODE_INPUT_INSERT: i32 = 1;

    /// Handed to Voicemeeter as the callback's user pointer. Allocated once per start and never
    /// freed (about a hundred bytes), so a late callback can never read freed memory.
    pub struct Shared {
        /// The engine, published once by the control thread; null until then. Only the callback
        /// dereferences it (Voicemeeter's callback is not re-entrant).
        engine: AtomicPtr<Engine>,
        engine_rate: AtomicU32,
        /// The engine may process. Set once by [`Shared::publish`], cleared for good by a stop,
        /// a panic or a change of Voicemeeter's audio settings the engine does not fit.
        pub ready: AtomicBool,
        /// Sample rate and frames per buffer of the last `STARTING`.
        pub rate: AtomicU32,
        pub frames: AtomicU32,
        /// `STARTING` commands seen.
        pub starts: AtomicU32,
        /// Voicemeeter changed its audio stream and stopped calling: the stream must be started again.
        pub change: AtomicBool,
        pub panicked: AtomicBool,
        /// A callback is executing right now / callbacks seen so far (to prove silence on stop).
        pub busy: AtomicBool,
        pub calls: AtomicU64,
        pub alive: Arc<AtomicBool>,
        /// Blocks the engine should have processed and could not (block too large, other sample
        /// rate, a routed channel missing): the microphone passed through dry for that block.
        pub skipped: Arc<AtomicU32>,
    }

    impl Shared {
        pub fn new(alive: Arc<AtomicBool>, skipped: Arc<AtomicU32>) -> Shared {
            Shared {
                engine: AtomicPtr::new(std::ptr::null_mut()),
                engine_rate: AtomicU32::new(0),
                ready: AtomicBool::new(false),
                rate: AtomicU32::new(0),
                frames: AtomicU32::new(0),
                starts: AtomicU32::new(0),
                change: AtomicBool::new(false),
                panicked: AtomicBool::new(false),
                busy: AtomicBool::new(false),
                calls: AtomicU64::new(0),
                alive,
                skipped,
            }
        }

        /// Hand the engine (built for `rate`) to the callback. Call once.
        pub fn publish(&self, engine: Box<Engine>, rate: u32) {
            self.engine_rate.store(rate, Ordering::Relaxed);
            // A second publish would leave the first engine allocated: better than freeing
            // memory the callback may be using.
            self.engine.store(Box::into_raw(engine), Ordering::Release);
            self.ready.store(true, Ordering::Release);
        }

        /// Take the engine out of the callback's reach: the pointer the callback reads becomes null,
        /// so no callback that STARTS after this can obtain it. A callback that was already running
        /// may still hold the pointer, so the returned box must not be freed before that callback has
        /// returned (`Shared::busy` is false).
        ///
        /// # Safety
        /// The caller must not free the returned box while a callback may still be inside it.
        pub unsafe fn retire(&self) -> Option<Box<Engine>> {
            let p = self.engine.swap(std::ptr::null_mut(), Ordering::AcqRel);
            // SAFETY: `p` came from `Box::into_raw` in `publish`, and by the caller's contract
            // nothing else uses it any more.
            (!p.is_null()).then(|| unsafe { Box::from_raw(p) })
        }
    }

    /// May an engine built for `engine_rate` / `max_block` keep running on Voicemeeter's new stream?
    pub fn fits(engine_rate: u32, max_block: usize, rate: u32, frames: u32) -> Result<(), String> {
        if rate != engine_rate {
            Err(format!(
                "Voicemeeter changed its sample rate from {engine_rate} to {rate} Hz: start the engine again (meanwhile the microphone passes through unprocessed)"
            ))
        } else if frames as usize > max_block {
            Err(format!(
                "Voicemeeter changed its buffer to {frames} frames, more than the engine was started for ({max_block}): start the engine again (meanwhile the microphone passes through unprocessed)"
            ))
        } else {
            Ok(())
        }
    }

    /// `T_VBVMR_VBAUDIOCALLBACK`. Runs on Voicemeeter's time-critical thread: no allocation, no
    /// lock, no syscall on the buffer path. A panic never crosses into Voicemeeter's DLL: it is
    /// caught, the engine is switched off for good and the microphone passes through dry.
    ///
    /// # Safety
    /// `user` must be null or point to a [`Shared`] that is never freed; `data` must be what the
    /// header documents for `command` (null is tolerated).
    pub unsafe extern "system" fn callback(
        user: *mut c_void,
        command: i32,
        data: *mut c_void,
        _nnn: i32,
    ) -> i32 {
        // SAFETY: caller contract.
        let Some(shared) = (unsafe { user.cast::<Shared>().as_ref() }) else {
            return 0;
        };
        shared.busy.store(true, Ordering::Release);
        shared.calls.fetch_add(1, Ordering::Relaxed);
        // SAFETY: caller contract for `data`.
        let step = catch_unwind(AssertUnwindSafe(|| unsafe { run(shared, command, data) }));
        if step.is_err() {
            shared.ready.store(false, Ordering::Release);
            shared.panicked.store(true, Ordering::Release);
            shared.alive.store(false, Ordering::Relaxed);
        }
        shared.busy.store(false, Ordering::Release);
        0
    }

    /// # Safety
    /// As [`callback`].
    unsafe fn run(shared: &Shared, command: i32, data: *mut c_void) {
        match command {
            STARTING => {
                // SAFETY: `VBVMR_T_AUDIOINFO` for this command.
                if let Some(info) = unsafe { data.cast::<AudioInfo>().as_ref() } {
                    shared
                        .rate
                        .store(info.samplerate.max(0) as u32, Ordering::Relaxed);
                    shared
                        .frames
                        .store(info.nb_sample_per_frame.max(0) as u32, Ordering::Relaxed);
                }
                shared.starts.fetch_add(1, Ordering::Release);
            }
            CHANGE => shared.change.store(true, Ordering::Release),
            BUFFER_IN => {
                // SAFETY: `VBVMR_T_AUDIOBUFFER` for this command.
                let Some(buf) = (unsafe { data.cast::<AudioBuffer>().as_ref() }) else {
                    return;
                };
                let ready = shared.ready.load(Ordering::Acquire);
                // SAFETY: the pointer is null or the published engine, which only this
                // (non re-entrant) callback uses until `retire`.
                let engine = unsafe { shared.engine.load(Ordering::Acquire).as_mut() };
                let present = engine.is_some();
                // A buffer that names another sample rate than the engine's is not processed
                // (0 = Voicemeeter did not fill the field).
                let rate = shared.engine_rate.load(Ordering::Relaxed);
                let may_run = ready && (buf.sr <= 0 || buf.sr as u32 == rate);
                // SAFETY: Voicemeeter's buffer, valid for the duration of the callback.
                let outcome = unsafe { insert::process(buf, engine, may_run) };
                if ready && present && outcome != Outcome::Processed {
                    shared.skipped.fetch_add(1, Ordering::Relaxed);
                }
            }
            // Memory is never released on this thread: the control side frees the engine.
            ENDING => {}
            // Commands of the other insert points.
            _ => {}
        }
    }
}

/// Everything that touches `VoicemeeterRemote64.dll`.
#[cfg(windows)]
mod win {
    use super::host::{self, Shared};
    use super::insert::Engine;
    use super::{StripInfo, VoicemeeterInfo, plan};
    use crate::io::{Ends, IoConfig, IoError, Running, RunningInfo, VOICEMEETER_INSERT};
    use std::ffi::{CString, c_char, c_void};
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, mpsc};
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::LibraryLoader::{
        GetProcAddress, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
        LoadLibraryExW,
    };
    use windows::Win32::System::Registry::{
        HKEY_LOCAL_MACHINE, REG_ROUTINE_FLAGS, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6432KEY, RegGetValueW,
    };
    use windows::core::{PCSTR, PCWSTR, w};

    #[cfg(target_pointer_width = "64")]
    const DLL: &str = "VoicemeeterRemote64.dll";
    #[cfg(not(target_pointer_width = "64"))]
    const DLL: &str = "VoicemeeterRemote.dll";

    /// `T_VBVMR_VBAUDIOCALLBACK`: `long __stdcall cb(void* user, long command, void* data, long nnn)`
    /// (`long` is 32-bit on Windows).
    pub(super) type AudioCallback =
        unsafe extern "system" fn(*mut c_void, i32, *mut c_void, i32) -> i32;
    type Plain = unsafe extern "system" fn() -> i32;
    type OutLong = unsafe extern "system" fn(*mut i32) -> i32;
    type GetFloat = unsafe extern "system" fn(*const c_char, *mut f32) -> i32;
    type GetStringW = unsafe extern "system" fn(*const c_char, *mut u16) -> i32;
    type SetFloat = unsafe extern "system" fn(*const c_char, f32) -> i32;
    type SetStringW = unsafe extern "system" fn(*const c_char, *const u16) -> i32;
    type Register = unsafe extern "system" fn(i32, AudioCallback, *mut c_void, *mut c_char) -> i32;

    /// The functions of the Remote API this module uses (signatures from `VoicemeeterRemote.h`).
    pub(super) struct Api {
        login: Plain,
        logout: Plain,
        get_type: OutLong,
        get_version: OutLong,
        is_dirty: Plain,
        get_float: GetFloat,
        get_string_w: GetStringW,
        set_float: SetFloat,
        set_string_w: SetStringW,
        pub(super) cb_register: Register,
        pub(super) cb_start: Plain,
        pub(super) cb_stop: Plain,
        pub(super) cb_unregister: Plain,
    }

    fn uninstall_string() -> Option<String> {
        // The 64-bit view first, then the 32-bit one (where the installer writes it), as the
        // SDK example does.
        for view in [0, RRF_SUBKEY_WOW6432KEY.0] {
            let mut buf = [0u16; 1024];
            let mut bytes = (buf.len() * 2) as u32;
            // SAFETY: static NUL-terminated strings; `buf` is `bytes` bytes long and both
            // outlive the call.
            let rc = unsafe {
                RegGetValueW(
                    HKEY_LOCAL_MACHINE,
                    w!(
                        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VB:Voicemeeter {17359A74-1236-5467}"
                    ),
                    w!("UninstallString"),
                    REG_ROUTINE_FLAGS(RRF_RT_REG_SZ.0 | view),
                    None,
                    Some(buf.as_mut_ptr().cast()),
                    Some(&mut bytes),
                )
            };
            if rc == ERROR_SUCCESS {
                let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
                return Some(String::from_utf16_lossy(&buf[..len]));
            }
        }
        None
    }

    /// Full path of the Remote API DLL next to the installed Voicemeeter; `None` when the
    /// registry has no Voicemeeter. Does not check that the file exists.
    pub(super) fn dll_path() -> Option<PathBuf> {
        Some(plan::uninstall_folder(&uninstall_string()?)?.join(DLL))
    }

    fn load() -> Result<Api, String> {
        let path = dll_path().ok_or("Voicemeeter is not installed")?;
        if !path.is_file() {
            return Err(format!("{} is missing", path.display()));
        }
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: `wide` is a NUL-terminated full path that outlives the call. The DLL's own
        // imports are looked up next to it and in System32 only.
        let module = unsafe {
            LoadLibraryExW(
                PCWSTR(wide.as_ptr()),
                None,
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        }
        .map_err(|e| format!("cannot load {}: {}", path.display(), e.message()))?;
        macro_rules! sym {
            ($name:literal, $ty:ty) => {{
                // SAFETY: `module` is the loaded DLL (never unloaded) and the name is a static
                // NUL-terminated string.
                match unsafe { GetProcAddress(module, PCSTR(concat!($name, "\0").as_ptr())) } {
                    // SAFETY: the export has the signature `$ty` (VoicemeeterRemote.h); both
                    // are `extern "system"` function pointers.
                    Some(f) => unsafe {
                        std::mem::transmute::<unsafe extern "system" fn() -> isize, $ty>(f)
                    },
                    None => {
                        return Err(format!(
                            "{} has no function {} (Voicemeeter too old?)",
                            path.display(),
                            $name
                        ));
                    }
                }
            }};
        }
        Ok(Api {
            login: sym!("VBVMR_Login", Plain),
            logout: sym!("VBVMR_Logout", Plain),
            get_type: sym!("VBVMR_GetVoicemeeterType", OutLong),
            get_version: sym!("VBVMR_GetVoicemeeterVersion", OutLong),
            is_dirty: sym!("VBVMR_IsParametersDirty", Plain),
            get_float: sym!("VBVMR_GetParameterFloat", GetFloat),
            get_string_w: sym!("VBVMR_GetParameterStringW", GetStringW),
            set_float: sym!("VBVMR_SetParameterFloat", SetFloat),
            set_string_w: sym!("VBVMR_SetParameterStringW", SetStringW),
            cb_register: sym!("VBVMR_AudioCallbackRegister", Register),
            cb_start: sym!("VBVMR_AudioCallbackStart", Plain),
            cb_stop: sym!("VBVMR_AudioCallbackStop", Plain),
            cb_unregister: sym!("VBVMR_AudioCallbackUnregister", Plain),
        })
    }

    /// The DLL, loaded once per process and never unloaded (a failure is not cached: Voicemeeter
    /// may be installed later).
    pub(super) fn api() -> Result<&'static Api, String> {
        static API: OnceLock<Api> = OnceLock::new();
        if let Some(a) = API.get() {
            return Ok(a);
        }
        let loaded = load()?;
        Ok(API.get_or_init(|| loaded))
    }

    /// Logins of this process. The Remote API has ONE login per process (a second `Login`
    /// fails, a `Logout` ends it for everybody), and its parameter calls "must be called from
    /// one thread only": the count shares the login between the running insert host and
    /// `info()`, and the lock serialises every parameter call.
    static REMOTE: Mutex<u32> = Mutex::new(0);

    fn remote() -> MutexGuard<'static, u32> {
        REMOTE.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Parameters are valid once Voicemeeter has pushed them to this client. Poll every 20 ms as
    /// the header asks, until a "new parameters" answer was followed by two quiet polls (or
    /// nothing changed for a while); at most 1.2 s. `false` = no Voicemeeter behind the login
    /// (errors only, for 300 ms).
    fn settle(api: &Api) -> bool {
        let (mut seen, mut quiet, mut errors) = (false, 0u32, 0u32);
        for i in 0..60u32 {
            // SAFETY: plain call on the loaded DLL; the caller holds the `REMOTE` lock.
            let r = unsafe { (api.is_dirty)() };
            if r < 0 {
                errors += 1;
                if errors >= 15 {
                    return false;
                }
            } else {
                errors = 0;
                if r > 0 {
                    seen = true;
                    quiet = 0;
                } else {
                    quiet += 1;
                }
            }
            if (seen && quiet >= 2) || (i >= 15 && quiet >= 10) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        true
    }

    /// One user of the process-wide login. Dropping the last one logs out.
    pub(super) struct Session {
        api: &'static Api,
        /// Voicemeeter itself runs (a login also succeeds without it).
        pub(super) running: bool,
    }

    impl Session {
        pub(super) fn open() -> Result<Session, String> {
            let api = api()?;
            let mut logins = remote();
            let fresh = *logins == 0;
            let mut running = true;
            if fresh {
                // SAFETY: plain call on the loaded DLL.
                let rep = unsafe { (api.login)() };
                if rep < 0 {
                    return Err(format!(
                        "the Voicemeeter Remote API refused the login (code {rep})"
                    ));
                }
                // 1 = logged in, but the Voicemeeter application is not launched.
                running = rep == 0;
            }
            *logins += 1;
            if running {
                running = if fresh {
                    settle(api)
                } else {
                    // SAFETY: as above; the lock is held.
                    unsafe { (api.is_dirty)() >= 0 }
                };
            }
            Ok(Session { api, running })
        }

        /// `VBVMR_IsParametersDirty`: negative = Voicemeeter is gone.
        pub(super) fn dirty(&self) -> i32 {
            let _lock = remote();
            // SAFETY: plain call on the loaded DLL, serialised by the lock.
            unsafe { (self.api.is_dirty)() }
        }

        pub(super) fn vm_type(&self) -> Option<i32> {
            let _lock = remote();
            let mut t = 0i32;
            // SAFETY: valid out pointer; serialised by the lock.
            (unsafe { (self.api.get_type)(&mut t) } == 0).then_some(t)
        }

        fn version(&self) -> Option<i32> {
            let _lock = remote();
            let mut v = 0i32;
            // SAFETY: valid out pointer; serialised by the lock.
            (unsafe { (self.api.get_version)(&mut v) } == 0).then_some(v)
        }

        fn float(&self, name: &str) -> Option<f32> {
            let name = CString::new(name).ok()?;
            let _lock = remote();
            let mut v = 0f32;
            // SAFETY: NUL-terminated name (the DLL only reads it) and a valid out pointer.
            (unsafe { (self.api.get_float)(name.as_ptr(), &mut v) } == 0).then_some(v)
        }

        fn string(&self, name: &str) -> Option<String> {
            let name = CString::new(name).ok()?;
            let _lock = remote();
            // The API writes at most 512 characters; the buffer is twice that.
            let mut buf = [0u16; 1024];
            // SAFETY: NUL-terminated name and a buffer larger than the documented 512 wchar.
            let rep = unsafe { (self.api.get_string_w)(name.as_ptr(), buf.as_mut_ptr()) };
            if rep != 0 {
                return None;
            }
            let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..len]).trim().to_owned())
        }

        fn set_float(&self, name: &str, value: f32) -> Result<(), String> {
            let c = CString::new(name).map_err(|e| e.to_string())?;
            let _lock = remote();
            // SAFETY: NUL-terminated name; serialised by the lock.
            match unsafe { (self.api.set_float)(c.as_ptr(), value) } {
                0 => Ok(()),
                rep => Err(format!("Voicemeeter refused {name} = {value} (code {rep})")),
            }
        }

        fn set_string(&self, name: &str, value: &str) -> Result<(), String> {
            let c = CString::new(name).map_err(|e| e.to_string())?;
            let wide: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
            let _lock = remote();
            // SAFETY: NUL-terminated name and value; serialised by the lock.
            match unsafe { (self.api.set_string_w)(c.as_ptr(), wide.as_ptr()) } {
                0 => Ok(()),
                rep => Err(format!("Voicemeeter refused {name} (code {rep})")),
            }
        }
    }

    impl Drop for Session {
        fn drop(&mut self) {
            let mut logins = remote();
            *logins = logins.saturating_sub(1);
            if *logins == 0 {
                // SAFETY: plain call; this was the last user of the login.
                let _ = unsafe { (self.api.logout)() };
            }
        }
    }

    /// Every read of [`info`], through an open session. Reads only.
    pub(super) fn read(s: &Session) -> VoicemeeterInfo {
        let mut out = VoicemeeterInfo {
            installed: true,
            running: s.running,
            ..VoicemeeterInfo::default()
        };
        if !s.running {
            return out;
        }
        let frames = |name: &str| {
            s.float(name)
                .filter(|v| v.is_finite() && *v >= 0.0)
                .map(|v| v.round() as u32)
        };
        out.version = s.version().map(plan::version_text);
        out.sample_rate = frames("Option.sr").filter(|r| *r > 0);
        out.buffer_mme = frames("Option.buffer.mme");
        out.buffer_wdm = frames("Option.buffer.wdm");
        out.buffer_ks = frames("Option.buffer.ks");
        out.buffer_asio = frames("Option.buffer.asio");
        out.a1_device = s.string("Bus[0].device.name").filter(|d| !d.is_empty());
        let Some(t) = s.vm_type() else {
            return out;
        };
        out.kind = plan::kind(t).map(str::to_owned);
        out.insert_channels = plan::insert_channels(t);
        let (hw, virt) = plan::strips(t).unwrap_or((0, 0));
        for index in 0..hw + virt {
            let on = |bus: &str| {
                s.float(&format!("Strip[{index}].{bus}"))
                    .is_some_and(|v| v != 0.0)
            };
            out.strips.push(StripInfo {
                index,
                kind: plan::strip_kind(t, index).into(),
                label: s
                    .string(&format!("Strip[{index}].Label"))
                    .unwrap_or_default(),
                device: if index < hw {
                    s.string(&format!("Strip[{index}].device.name"))
                        .unwrap_or_default()
                } else {
                    String::new()
                },
                channels: plan::strip_channels(t, index),
                a1: on("A1"),
                b1: on("B1"),
            });
        }
        out
    }

    pub(super) fn info() -> VoicemeeterInfo {
        if !super::installed() {
            return VoicemeeterInfo::default();
        }
        match Session::open() {
            Ok(s) => read(&s),
            Err(e) => {
                log::warn!("Voicemeeter: {e}");
                VoicemeeterInfo {
                    installed: true,
                    ..VoicemeeterInfo::default()
                }
            }
        }
    }

    fn running_session() -> Result<Session, String> {
        let s = Session::open()?;
        if !s.running {
            return Err("Voicemeeter is not running".into());
        }
        Ok(s)
    }

    pub(super) fn save_snapshot(path: &Path, file: &str) -> Result<(), String> {
        if !path.parent().is_some_and(Path::is_dir) {
            return Err(format!("the folder of {file} does not exist"));
        }
        let before = std::fs::metadata(path).ok().and_then(|m| m.modified().ok());
        let s = running_session()?;
        s.set_string(plan::SAVE, file)?;
        // The request is asynchronous: wait for a file that is there, new and no longer growing.
        let t0 = Instant::now();
        let mut last_len = None;
        while t0.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(100));
            let _ = s.dirty();
            if let Ok(m) = std::fs::metadata(path) {
                let done = plan::snapshot_written(m.len(), m.modified().ok(), before);
                if done && last_len == Some(m.len()) {
                    return Ok(());
                }
                last_len = Some(m.len());
            }
        }
        Err(format!(
            "Voicemeeter accepted {} but {file} was not written within 5 s",
            plan::SAVE
        ))
    }

    pub(super) fn load_snapshot(path: &Path, file: &str) -> Result<(), String> {
        let len = std::fs::metadata(path)
            .ok()
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .ok_or_else(|| format!("{file} does not exist"))?;
        if len < plan::MIN_SNAPSHOT_BYTES {
            return Err(format!(
                "{file} is {len} bytes: not a Voicemeeter configuration"
            ));
        }
        let s = running_session()?;
        s.set_string(plan::LOAD, file)?;
        // Keep the login while Voicemeeter picks the request up.
        for _ in 0..25 {
            std::thread::sleep(Duration::from_millis(20));
            let _ = s.dirty();
        }
        Ok(())
    }

    pub(super) fn set_buffer(param: &str, frames: u32) -> Result<(), String> {
        let s = running_session()?;
        s.set_float(param, frames as f32)?;
        std::thread::sleep(Duration::from_millis(100));
        s.set_float(plan::RESTART, 1.0)?;
        // Read it back once Voicemeeter has pushed the new value.
        let t0 = Instant::now();
        let mut got = None;
        while t0.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(20));
            let _ = s.dirty();
            got = s.float(param).map(|v| v.round() as i64);
            if got == Some(i64::from(frames)) && t0.elapsed() >= Duration::from_millis(300) {
                return Ok(());
            }
        }
        Err(match got {
            Some(v) => format!("Voicemeeter still reports {param} = {v} after asking for {frames}"),
            None => format!("{param} could not be read back"),
        })
    }

    /// The Remote API registers audio callbacks per process: one insert host at a time.
    static INSERT_ACTIVE: AtomicBool = AtomicBool::new(false);

    /// What keeps the insert running: dropping it stops the callback, unregisters and logs out.
    struct InsertStream {
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Drop for InsertStream {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    struct Started {
        ends: Ends,
        info: RunningInfo,
    }

    type ErrorText = Arc<Mutex<Option<String>>>;

    pub(super) fn start(cfg: &IoConfig) -> Result<Running, IoError> {
        if !super::installed() {
            return Err(IoError::NotFound("Voicemeeter is not installed".into()));
        }
        if INSERT_ACTIVE.swap(true, Ordering::AcqRel) {
            return Err(IoError::Config(
                "the Voicemeeter insert already runs in this process (or a previous start has not finished yet)"
                    .into(),
            ));
        }
        let alive = Arc::new(AtomicBool::new(true));
        let skipped = Arc::new(AtomicU32::new(0));
        let last_error: ErrorText = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::sync_channel::<Result<Started, IoError>>(1);
        let worker = {
            let (cfg, alive, skipped) = (cfg.clone(), alive.clone(), skipped.clone());
            let (last_error, stop) = (last_error.clone(), stop.clone());
            move || {
                insert_thread(&cfg, &alive, skipped, &last_error, &stop, &tx);
                INSERT_ACTIVE.store(false, Ordering::Release);
            }
        };
        let thread = std::thread::Builder::new()
            .name("live-voicemeeter".into())
            .spawn(worker)
            .map_err(|e| {
                INSERT_ACTIVE.store(false, Ordering::Release);
                IoError::Device(format!("Voicemeeter insert thread: {e}"))
            })?;
        // Login + settle (1.2 s at most), the reads, and 3 s for the first callback.
        match rx.recv_timeout(Duration::from_secs(8)) {
            Ok(Ok(started)) => Ok(Running::assemble(
                Box::new(InsertStream {
                    stop,
                    thread: Some(thread),
                }),
                started.ends,
                started.info,
                alive,
                last_error,
                // Reported as driver xruns: blocks the engine could not process (passed dry).
                skipped,
            )),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                // Not joined: the thread may sit inside a call that does not return. It sees
                // the stop flag (or the closed channel) and cleans up when it gets there.
                stop.store(true, Ordering::Release);
                Err(IoError::Device(
                    "Voicemeeter did not answer within 8 s".into(),
                ))
            }
        }
    }

    fn client_name() -> [c_char; 64] {
        let mut name: [c_char; 64] = [0; 64];
        for (slot, b) in name.iter_mut().zip(b"MixAI Live") {
            *slot = *b as c_char;
        }
        name
    }

    fn name_text(name: &[c_char; 64]) -> String {
        let bytes: Vec<u8> = name
            .iter()
            .take_while(|c| **c != 0)
            .map(|c| *c as u8)
            .collect();
        String::from_utf8_lossy(&bytes).trim().to_owned()
    }

    fn set_error(text: &ErrorText, message: String) {
        log::error!("Voicemeeter insert: {message}");
        if let Ok(mut slot) = text.lock() {
            *slot = Some(message);
        }
    }

    /// `VBVMR_AudioCallbackStart`, serialised with the other Remote API calls.
    fn callback_start(api: &Api) -> i32 {
        let _lock = remote();
        // SAFETY: plain call on the loaded DLL.
        unsafe { (api.cb_start)() }
    }

    /// Wait until the callback has seen more `STARTING` commands than `seen`.
    fn wait_start(shared: &Shared, seen: u32, limit: Duration) -> bool {
        let t0 = Instant::now();
        while t0.elapsed() < limit {
            if shared.starts.load(Ordering::Acquire) != seen {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        shared.starts.load(Ordering::Acquire) != seen
    }

    /// Stop and unregister the callback, then free the engine, but only once no callback is inside
    /// it; otherwise the engine stays allocated (a few hundred bytes, once).
    fn release(api: &Api, shared: &Shared) {
        shared.ready.store(false, Ordering::Release);
        {
            let _lock = remote();
            // SAFETY: plain calls on the loaded DLL; unregistering a stopped callback is fine.
            unsafe {
                let _ = (api.cb_stop)();
                let _ = (api.cb_unregister)();
            }
        }
        // Out of the callback's reach FIRST: Voicemeeter may call it once more after unregistering
        // (its own documented-but-unreliable case), and a callback that starts after this swap sees
        // a null pointer. A callback that was already running holds the pointer and has set `busy`
        // before loading it, so `busy == false` below proves nothing is inside the engine.
        let mut engine = unsafe { shared.retire() };
        let rate = shared.rate.load(Ordering::Relaxed).max(1);
        let frames = shared.frames.load(Ordering::Relaxed);
        let period = Duration::from_secs_f64(f64::from(frames) / f64::from(rate));
        let window = (period * 3).clamp(Duration::from_millis(40), Duration::from_millis(300));
        for _ in 0..5 {
            std::thread::sleep(window);
            if !shared.busy.load(Ordering::Acquire) {
                // SAFETY: the pointer is no longer reachable, and no callback is inside the engine.
                drop(engine.take());
                return;
            }
        }
        // Still calling: never free memory a callback may be reading.
        if let Some(e) = engine.take() {
            std::mem::forget(e);
        }
        log::warn!(
            "Voicemeeter still calls the insert callback after unregistering: the engine stays allocated"
        );
    }

    /// Every call of the callback part of the Remote API happens on this thread: register, start,
    /// restart after a stream change, stop, unregister.
    fn insert_thread(
        cfg: &IoConfig,
        alive: &Arc<AtomicBool>,
        skipped: Arc<AtomicU32>,
        last_error: &ErrorText,
        stop: &AtomicBool,
        tx: &mpsc::SyncSender<Result<Started, IoError>>,
    ) {
        let fail = |e: IoError| {
            let _ = tx.send(Err(e));
        };
        let session = match Session::open() {
            Ok(s) => s,
            Err(e) => return fail(IoError::Device(e)),
        };
        if !session.running {
            return fail(IoError::Device(
                "Voicemeeter is not running: open Voicemeeter, then start again".into(),
            ));
        }
        let vm = read(&session);
        if vm.insert_channels == 0 {
            return fail(IoError::Device(
                "this Voicemeeter type is not known: its insert channels cannot be told".into(),
            ));
        }
        let route = match plan::route(cfg, vm.insert_channels) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let api = session.api;
        // Never freed: a callback that arrives late must still find its state.
        let shared: &'static Shared = Box::leak(Box::new(Shared::new(alive.clone(), skipped)));
        let mut name = client_name();
        let rep = {
            let _lock = remote();
            // SAFETY: the callback has the header's signature, `shared` lives for ever and
            // `name` is the 64-character buffer the function reads and may overwrite.
            unsafe {
                (api.cb_register)(
                    host::MODE_INPUT_INSERT,
                    host::callback,
                    std::ptr::from_ref(shared).cast_mut().cast::<c_void>(),
                    name.as_mut_ptr(),
                )
            }
        };
        match rep {
            0 => {}
            1 => {
                return fail(IoError::Device(format!(
                    "Voicemeeter's input insert is already used by \"{}\": close it, then start again",
                    name_text(&name)
                )));
            }
            code => {
                return fail(IoError::Device(format!(
                    "Voicemeeter refused the input insert (code {code})"
                )));
            }
        }
        let rep = callback_start(api);
        if rep != 0 {
            release(api, shared);
            return fail(IoError::Device(format!(
                "Voicemeeter did not start the insert stream (code {rep})"
            )));
        }
        if !wait_start(shared, 0, Duration::from_secs(3)) {
            release(api, shared);
            return fail(IoError::Device(
                "Voicemeeter started no audio within 3 s (is an A1 output device selected?)".into(),
            ));
        }
        let mut handled = shared.starts.load(Ordering::Acquire);
        let rate = shared.rate.load(Ordering::Relaxed);
        let frames = shared.frames.load(Ordering::Relaxed);
        // Bounded on both ends: `frames` also sizes the engine's scratch buffers (`frames * 4`), so a
        // nonsense value from the DLL must not reach an allocation.
        if !(8_000..=384_000).contains(&rate) || !(8..=16_384).contains(&frames) {
            release(api, shared);
            return fail(IoError::Device(format!(
                "Voicemeeter reported a stream the engine cannot use ({rate} Hz, {frames} frames)"
            )));
        }
        // Room for a larger buffer chosen in Voicemeeter while the engine runs.
        let max_block = (frames as usize * 4).max(2048);
        let (engine, ends) = match Engine::build(route, rate, max_block) {
            Ok(built) => built,
            Err(e) => {
                release(api, shared);
                return fail(e);
            }
        };
        shared.publish(Box::new(engine), rate);
        let mut notes = vec![
            format!(
                "runs inside Voicemeeter's audio callback as an input insert: no audio device is opened; {rate} Hz and {frames} frames are Voicemeeter's settings (the requested rate and buffer are not used)"
            ),
            format!(
                "latency is calculated, not measured: Voicemeeter's input buffer plus its A1 output buffer (2 x {frames} frames); the engine adds no buffer of its own; whether the insert point adds one is not documented by VB-Audio"
            ),
            "every other Voicemeeter channel passes through untouched; whenever the engine cannot run, the microphone passes through unprocessed".to_owned(),
        ];
        if let Some(a1) = &vm.a1_device {
            notes.push(format!(
                "Voicemeeter's stream is clocked by its A1 device: {a1}"
            ));
        }
        let info = RunningInfo {
            host: VOICEMEETER_INSERT.into(),
            input: plan::describe(&vm.strips, &route.input[..route.inputs]),
            output: plan::describe(&vm.strips, &route.main),
            sample_rate: rate,
            buffer_frames: frames,
            input_channels: vm.insert_channels,
            output_channels: vm.insert_channels,
            nominal_latency_ms: plan::nominal_ms(frames, rate),
            input_period_frames: frames,
            cushion_frames: 0,
            output_period_frames: frames,
            notes,
        };
        if tx.send(Ok(Started { ends, info })).is_err() {
            // The caller gave up waiting.
            release(api, shared);
            return;
        }

        let dead = |message: String| {
            shared.ready.store(false, Ordering::Release);
            alive.store(false, Ordering::Relaxed);
            set_error(last_error, message);
        };
        let (mut tick, mut gone, mut panic_reported) = (0u32, 0u32, false);
        while !stop.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(20));
            tick = tick.wrapping_add(1);
            if !panic_reported && shared.panicked.load(Ordering::Acquire) {
                panic_reported = true;
                set_error(
                    last_error,
                    "the engine stopped after an internal error: the microphone passes through Voicemeeter unprocessed".into(),
                );
            }
            if shared.change.swap(false, Ordering::AcqRel) {
                // Voicemeeter restarted its audio (device, buffer or sample rate changed) and
                // stopped calling: start the stream again after a short pause, as the SDK
                // example does.
                std::thread::sleep(Duration::from_millis(50));
                if shared.starts.load(Ordering::Acquire) == handled {
                    let rep = callback_start(api);
                    if rep != 0 {
                        log::warn!("Voicemeeter insert: restart answered code {rep}");
                    }
                }
                if wait_start(shared, handled, Duration::from_secs(3)) {
                    handled = shared.starts.load(Ordering::Acquire);
                    let now_rate = shared.rate.load(Ordering::Relaxed);
                    let now_frames = shared.frames.load(Ordering::Relaxed);
                    match host::fits(rate, max_block, now_rate, now_frames) {
                        Ok(()) => log::info!(
                            "Voicemeeter insert: stream restarted at {now_rate} Hz, {now_frames} frames"
                        ),
                        Err(message) => dead(message),
                    }
                } else {
                    dead(
                        "Voicemeeter changed its audio settings and did not restart the insert stream: start the engine again".into(),
                    );
                }
            }
            // Twice a second, as the SDK example does: a negative answer = Voicemeeter is gone.
            if tick.is_multiple_of(25) {
                if session.dirty() < 0 {
                    gone += 1;
                    if gone == 3 {
                        dead("Voicemeeter was closed".into());
                    }
                } else {
                    gone = 0;
                }
            }
        }
        release(api, shared);
        // `session` drops here: the last user of the login logs out.
    }
}

#[cfg(test)]
mod tests {
    use super::host::{self, Shared};
    use super::insert::{self, AudioBuffer, Engine, Outcome};
    use super::plan::{self, Route};
    use super::*;
    use crate::core::Command;
    use crate::io::{IoConfig, IoError};
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::time::{Duration, SystemTime};

    /// The header's `VBVMR_CBCOMMAND_BUFFER_IN` tables and `G_StripChannelIndex_v1/v2/v3` of
    /// the SDK example.
    #[test]
    fn strip_channels_match_the_header() {
        let firsts = |t: i32, strips: u32| -> Vec<u16> {
            (0..strips).map(|i| plan::strip_channels(t, i)[0]).collect()
        };
        assert_eq!(firsts(1, 3), [0, 2, 4]);
        assert_eq!(firsts(2, 5), [0, 2, 4, 6, 14]);
        assert_eq!(firsts(3, 8), [0, 2, 4, 6, 8, 10, 18, 26]);
        assert_eq!(
            [1, 2, 3].map(plan::insert_channels),
            [12, 22, 34],
            "insert buffer sizes"
        );
        // Hardware strips are stereo, virtual strips have 8 channels, and together they cover
        // the buffer exactly once.
        for (t, strips) in [(1, 3u32), (2, 5), (3, 8)] {
            let all: Vec<u16> = (0..strips)
                .flat_map(|i| plan::strip_channels(t, i))
                .collect();
            let want: Vec<u16> = (0..plan::insert_channels(t)).collect();
            assert_eq!(all, want, "type {t}");
            assert!(plan::strip_channels(t, strips).is_empty());
        }
        assert_eq!(plan::strip_channels(3, 4), [8, 9]);
        assert_eq!(plan::strip_channels(3, 5), [10, 11, 12, 13, 14, 15, 16, 17]);
        assert_eq!(plan::strip_kind(3, 4), "hardware");
        assert_eq!(plan::strip_kind(3, 5), "virtual");
        assert_eq!(plan::strip_kind(1, 2), "virtual");
        assert_eq!(
            [1, 2, 3, 0].map(plan::kind),
            [Some("standard"), Some("banana"), Some("potato"), None]
        );
        assert_eq!(plan::insert_channels(0), 0);
        assert!(plan::strip_channels(9, 0).is_empty());
    }

    #[test]
    fn version_and_install_folder() {
        assert_eq!(plan::version_text(0x0301_0202), "3.1.2.2");
        assert_eq!(plan::version_text(0x0200_0608), "2.0.6.8");
        assert_eq!(
            plan::uninstall_folder(r"C:\Program Files (x86)\VB\Voicemeeter\Voicemeeter8Setup.exe"),
            Some(r"C:\Program Files (x86)\VB\Voicemeeter".into())
        );
        assert_eq!(
            plan::uninstall_folder("\"D:\\VB\\setup.exe\""),
            Some(r"D:\VB".into())
        );
        assert_eq!(plan::uninstall_folder("setup.exe"), None);
        assert_eq!(plan::uninstall_folder(""), None);
    }

    fn cfg(input: &[u16], main: [u16; 2]) -> IoConfig {
        IoConfig {
            input_channels: input.to_vec(),
            main_channels: main,
            ..IoConfig::default()
        }
    }

    /// A fake insert buffer: channel `c` carries the constant `0.01 × (c + 1)` on the read side,
    /// the write side starts as the sentinel 7.0 (so a channel left untouched is visible).
    struct Fake {
        r: Vec<Vec<f32>>,
        w: Vec<Vec<f32>>,
    }

    impl Fake {
        fn new(channels: usize, frames: usize) -> Fake {
            Fake {
                r: (0..channels)
                    .map(|c| vec![0.01 * (c as f32 + 1.0); frames])
                    .collect(),
                w: vec![vec![7.0; frames]; channels],
            }
        }

        fn buffer(&mut self, frames: usize) -> AudioBuffer {
            let mut r = [std::ptr::null::<f32>(); 128];
            let mut w = [std::ptr::null_mut::<f32>(); 128];
            for (c, ch) in self.r.iter().enumerate() {
                r[c] = ch.as_ptr();
            }
            for (c, ch) in self.w.iter_mut().enumerate() {
                w[c] = ch.as_mut_ptr();
            }
            AudioBuffer {
                sr: 48_000,
                nbs: frames as i32,
                nbi: self.r.len() as i32,
                nbo: self.w.len() as i32,
                r,
                w,
            }
        }

        fn written(&self, c: usize) -> f32 {
            self.r[c][0]
        }

        /// Output channels that do not equal their input exactly.
        fn changed(&self) -> Vec<usize> {
            (0..self.w.len())
                .filter(|c| self.w[*c] != self.r[*c])
                .collect()
        }
    }

    fn engine(input: &[u16], main: [u16; 2], max_block: usize) -> (Engine, crate::io::Ends) {
        let route = plan::route(&cfg(input, main), 34).unwrap();
        Engine::build(route, 48_000, max_block).unwrap()
    }

    /// Runs `blocks` insert blocks, each on a fresh fake buffer, and returns the last one.
    fn run(e: &mut Engine, ready: bool, blocks: usize, frames: usize) -> (Fake, Outcome) {
        let mut last = None;
        for _ in 0..blocks {
            let mut fake = Fake::new(34, frames);
            let buf = fake.buffer(frames);
            // SAFETY: every pointer comes from a `frames`-long Vec that outlives the call.
            let out = unsafe { insert::process(&buf, Some(&mut *e), ready) };
            last = Some((fake, out));
        }
        last.unwrap()
    }

    #[test]
    fn every_other_channel_is_copied_dry() {
        let (mut e, _ends) = engine(&[8], [8, 8], 2048);
        let (fake, out) = run(&mut e, true, 1, 256);
        assert_eq!(out, Outcome::Processed);
        for c in (0..34).filter(|c| *c != 8) {
            assert_eq!(fake.w[c], fake.r[c], "channel {c}");
        }
        // Stereo main: two channels are the engine's, the other 32 are copies.
        let (mut e, _ends) = engine(&[8, 9], [8, 9], 2048);
        let (fake, out) = run(&mut e, true, 1, 256);
        assert_eq!(out, Outcome::Processed);
        for c in (0..34).filter(|c| *c != 8 && *c != 9) {
            assert_eq!(fake.w[c], fake.r[c], "channel {c}");
        }
    }

    /// The engine's main bus lands on the main channel(s) and nowhere else. Muting the engine is
    /// the proof that the channel carries the engine and not a copy of the input.
    #[test]
    fn main_channels_carry_the_engine_output() {
        // Mono mic on 8, main on 8 only: 8 = the engine (unity gain = the input), 9 untouched.
        let (mut e, _ends) = engine(&[8], [8, 8], 2048);
        let (fake, out) = run(&mut e, true, 4, 256);
        assert_eq!(out, Outcome::Processed);
        assert!(
            fake.w[8].iter().all(|v| (v - fake.written(8)).abs() < 1e-5),
            "{:?}",
            &fake.w[8][..4]
        );
        assert_eq!(fake.w[9], fake.r[9]);
        // Mute (10 ms fade): channel 8 goes silent, channel 9 still carries its own input.
        let mut ends = _ends;
        ends.commands.push(Command::Mute(true)).ok().unwrap();
        let (fake, _) = run(&mut e, true, 8, 256);
        assert!(
            fake.w[8].iter().all(|v| v.abs() < 1e-6),
            "{:?}",
            &fake.w[8][..4]
        );
        assert_eq!(fake.w[9], fake.r[9]);
        assert_eq!(fake.changed(), [8]);

        // Mono mic on 8, main pair 8+9: both carry the engine (the mono input, unity gain).
        let (mut e, _ends) = engine(&[8], [8, 9], 2048);
        let (fake, _) = run(&mut e, true, 4, 256);
        for c in [8, 9] {
            assert!(
                fake.w[c].iter().all(|v| (v - fake.written(8)).abs() < 1e-5),
                "channel {c}: {:?}",
                &fake.w[c][..4]
            );
        }
        assert_eq!(fake.changed(), [9]); // 8 equals its input by value, 9 now carries 8's
        let mut ends = _ends;
        ends.commands.push(Command::Mute(true)).ok().unwrap();
        let (fake, _) = run(&mut e, true, 8, 256);
        assert!(fake.w[8].iter().chain(&fake.w[9]).all(|v| v.abs() < 1e-6));
        assert_eq!(fake.changed(), [8, 9]);

        // Stereo source 8+9 on main 8+9: left stays left, right stays right.
        let (mut e, _ends) = engine(&[8, 9], [8, 9], 2048);
        let (fake, _) = run(&mut e, true, 4, 256);
        assert!((fake.w[8][100] - fake.written(8)).abs() < 1e-5);
        assert!((fake.w[9][100] - fake.written(9)).abs() < 1e-5);
    }

    /// Not ready, stopped, oversized block: the microphone channel equals its input and nothing
    /// is zeroed or left at the sentinel.
    #[test]
    fn when_the_engine_cannot_run_the_microphone_passes_through_dry() {
        let (mut e, mut ends) = engine(&[8], [8, 8], 256);
        ends.commands.push(Command::Mute(true)).ok().unwrap();
        // Muted engine, so a processed block would be silent on channel 8...
        let (fake, out) = run(&mut e, true, 8, 256);
        assert_eq!((out, fake.w[8][0]), (Outcome::Processed, 0.0));
        // ...but a stopped engine passes the input through.
        let (fake, out) = run(&mut e, false, 1, 256);
        assert_eq!(out, Outcome::PassThrough);
        assert!(fake.changed().is_empty(), "{:?}", fake.changed());
        // A block larger than the engine's maximum.
        let (fake, out) = run(&mut e, true, 1, 257);
        assert_eq!(out, Outcome::PassThrough);
        assert!(fake.changed().is_empty(), "{:?}", fake.changed());
        // No engine at all (not built yet).
        let mut fake = Fake::new(34, 256);
        let buf = fake.buffer(256);
        // SAFETY: pointers into `fake`'s Vecs, 256 frames each.
        let out = unsafe { insert::process(&buf, None, true) };
        assert_eq!(out, Outcome::PassThrough);
        assert!(fake.changed().is_empty());
        assert!(fake.w.iter().flatten().all(|v| *v != 7.0), "sentinel left");
        // Engine (and ring) still alive afterwards: the next ready block is processed again.
        let (_, out) = run(&mut e, true, 1, 256);
        assert_eq!(out, Outcome::Processed);
    }

    #[test]
    fn null_pointers_and_odd_buffers_do_not_crash() {
        let (mut e, _ends) = engine(&[8], [8, 8], 2048);
        // A null read pointer on a routed channel: pass-through, that channel written silent.
        let mut fake = Fake::new(34, 128);
        let mut buf = fake.buffer(128);
        buf.r[8] = std::ptr::null();
        buf.w[20] = std::ptr::null_mut();
        // SAFETY: the remaining pointers are valid for 128 frames.
        let out = unsafe { insert::process(&buf, Some(&mut e), true) };
        assert_eq!(out, Outcome::PassThrough);
        assert!(fake.w[8].iter().all(|v| *v == 0.0));
        assert_eq!(
            fake.w[20],
            vec![7.0; 128],
            "null output pointer: not written"
        );
        assert_eq!(fake.w[21], fake.r[21]);
        // A null write pointer on the main channel: nothing of the engine's lands anywhere.
        let mut fake = Fake::new(34, 128);
        let mut buf = fake.buffer(128);
        buf.w[8] = std::ptr::null_mut();
        // SAFETY: as above.
        let out = unsafe { insert::process(&buf, Some(&mut e), true) };
        assert_eq!(out, Outcome::PassThrough);
        assert!(fake.changed().iter().all(|c| *c == 8));
        // Fewer channels than the routing needs (channel 8 is not in an 8-channel buffer).
        let mut fake = Fake::new(8, 128);
        let buf = fake.buffer(128);
        // SAFETY: as above.
        let out = unsafe { insert::process(&buf, Some(&mut e), true) };
        assert_eq!(out, Outcome::PassThrough);
        assert!(fake.changed().is_empty());
        // nbi != nbo, zero frames, no channels: copied what exists, nothing processed.
        let mut fake = Fake::new(34, 64);
        let mut buf = fake.buffer(64);
        buf.nbo = 10;
        // SAFETY: as above.
        assert_eq!(
            unsafe { insert::process(&buf, Some(&mut e), true) },
            Outcome::Mismatch
        );
        assert_eq!(fake.w[9], fake.r[9]);
        assert_eq!(fake.w[10], vec![7.0; 64]);
        let mut buf = fake.buffer(64);
        buf.nbs = 0;
        // SAFETY: zero frames are never dereferenced.
        assert_eq!(
            unsafe { insert::process(&buf, Some(&mut e), true) },
            Outcome::Mismatch
        );
        buf.nbs = 64;
        buf.nbi = 0;
        buf.nbo = 0;
        // SAFETY: no channel is touched.
        assert_eq!(
            unsafe { insert::process(&buf, Some(&mut e), true) },
            Outcome::Mismatch
        );
        buf.nbi = 200;
        buf.nbo = 200;
        buf.nbs = -5;
        // SAFETY: counts are clamped to the 128 slots and negative frames to zero.
        assert_eq!(
            unsafe { insert::process(&buf, Some(&mut e), true) },
            Outcome::Mismatch
        );
    }

    /// The whole callback path, with a preset loaded, allocates nothing.
    #[test]
    fn processing_does_not_allocate() {
        let (mut e, mut ends) = engine(&[8], [8, 8], 2048);
        let preset = crate::preset::factory()[3]
            .build(48_000.0, 2048, 1)
            .unwrap();
        ends.commands
            .push(Command::SwapChain {
                chain: preset.chain,
            })
            .ok()
            .unwrap();
        let mut fake = Fake::new(34, 256);
        let buf = fake.buffer(256);
        assert_no_alloc::assert_no_alloc(|| {
            for _ in 0..50 {
                // SAFETY: pointers into `fake`'s Vecs, 256 frames each.
                let out = unsafe { insert::process(&buf, Some(&mut e), true) };
                assert_eq!(out, Outcome::Processed);
            }
        });
        assert!(fake.w[8].iter().all(|v| v.is_finite()));
        assert_eq!(fake.w[7], fake.r[7]);
    }

    /// One call of Voicemeeter's callback, as the DLL makes it.
    fn call(shared: &Shared, command: i32, data: *mut c_void) -> i32 {
        // SAFETY: `shared` outlives the call; `data` is null or the struct of `command`.
        unsafe {
            host::callback(
                std::ptr::from_ref(shared).cast_mut().cast(),
                command,
                data,
                0,
            )
        }
    }

    /// One input-insert block of 34 channels through the callback.
    fn insert_block(shared: &Shared, frames: usize) -> Fake {
        let mut fake = Fake::new(34, frames);
        let mut buf = fake.buffer(frames);
        assert_eq!(call(shared, host::BUFFER_IN, (&raw mut buf).cast()), 0);
        fake
    }

    #[test]
    fn the_callback_runs_the_engine_only_between_publish_and_retire() {
        let alive = Arc::new(AtomicBool::new(true));
        let skipped = Arc::new(AtomicU32::new(0));
        let shared = Shared::new(alive.clone(), skipped.clone());
        // Nothing published yet: every channel dry, nothing counted as skipped.
        let fake = insert_block(&shared, 256);
        assert!(fake.changed().is_empty(), "{:?}", fake.changed());
        assert!(fake.w.iter().flatten().all(|v| *v != 7.0), "sentinel left");
        assert_eq!(skipped.load(Ordering::Relaxed), 0);
        // STARTING carries Voicemeeter's sample rate and block size.
        let mut info = insert::AudioInfo {
            samplerate: 48_000,
            nb_sample_per_frame: 256,
        };
        assert_eq!(call(&shared, host::STARTING, (&raw mut info).cast()), 0);
        assert_eq!(
            (
                shared.rate.load(Ordering::Relaxed),
                shared.frames.load(Ordering::Relaxed),
                shared.starts.load(Ordering::Relaxed)
            ),
            (48_000, 256, 1)
        );
        // Published: the (muted) engine owns channel 8, every other channel stays dry.
        let (engine, mut ends) = engine(&[8], [8, 8], 1024);
        ends.commands.push(Command::Mute(true)).ok().unwrap();
        shared.publish(Box::new(engine), 48_000);
        let mut last = insert_block(&shared, 256);
        for _ in 0..8 {
            last = insert_block(&shared, 256);
        }
        assert!(
            last.w[8].iter().all(|v| v.abs() < 1e-6),
            "{:?}",
            &last.w[8][..4]
        );
        assert_eq!(last.changed(), [8]);
        assert_eq!(skipped.load(Ordering::Relaxed), 0);
        // A block larger than the engine's maximum: dry, and counted.
        assert!(insert_block(&shared, 1025).changed().is_empty());
        assert_eq!(skipped.load(Ordering::Relaxed), 1);
        // A buffer at another sample rate than the engine's: dry, and counted.
        let mut fake = Fake::new(34, 256);
        let mut buf = fake.buffer(256);
        buf.sr = 44_100;
        call(&shared, host::BUFFER_IN, (&raw mut buf).cast());
        assert!(fake.changed().is_empty(), "{:?}", fake.changed());
        assert_eq!(skipped.load(Ordering::Relaxed), 2);
        // CHANGE only raises the flag; the other commands and null data do nothing.
        assert!(!shared.change.load(Ordering::Relaxed));
        call(&shared, host::CHANGE, null_mut());
        assert!(shared.change.load(Ordering::Relaxed));
        call(&shared, host::ENDING, null_mut());
        call(&shared, host::BUFFER_IN, null_mut());
        call(&shared, host::STARTING, null_mut());
        call(&shared, 11, null_mut());
        // SAFETY: a null user pointer is tolerated.
        assert_eq!(
            unsafe { host::callback(null_mut(), host::BUFFER_IN, null_mut(), 0) },
            0
        );
        assert_eq!(shared.starts.load(Ordering::Relaxed), 2);
        assert_eq!(shared.rate.load(Ordering::Relaxed), 48_000);
        assert_eq!(shared.calls.load(Ordering::Relaxed), 18);
        assert!(alive.load(Ordering::Relaxed));
        assert!(!shared.panicked.load(Ordering::Relaxed));
        assert!(!shared.busy.load(Ordering::Relaxed));
        // Retired: the engine is handed back once, and the microphone is dry again.
        // SAFETY: single-threaded test, no callback is executing.
        assert!(unsafe { shared.retire() }.is_some());
        assert!(insert_block(&shared, 256).changed().is_empty());
        // SAFETY: as above.
        assert!(unsafe { shared.retire() }.is_none());
        assert_eq!(skipped.load(Ordering::Relaxed), 2);
    }

    /// A panic inside the engine never unwinds into Voicemeeter's DLL: the block still carries
    /// the dry microphone, and the engine is not called again.
    #[test]
    fn a_panic_in_the_engine_stays_inside_the_callback() {
        let alive = Arc::new(AtomicBool::new(true));
        let hits = Arc::new(AtomicU32::new(0));
        let shared = Shared::new(alive.clone(), Arc::new(AtomicU32::new(0)));
        let route = plan::route(&cfg(&[8], [8, 8]), 34).unwrap();
        shared.publish(
            Box::new(Engine::poisoned(route, 1024, hits.clone())),
            48_000,
        );
        let fake = insert_block(&shared, 256);
        assert_eq!(hits.load(Ordering::Relaxed), 1, "the engine was reached");
        assert!(fake.changed().is_empty(), "{:?}", fake.changed());
        assert!(fake.w.iter().flatten().all(|v| *v != 7.0), "sentinel left");
        assert!(shared.panicked.load(Ordering::Relaxed));
        assert!(!shared.ready.load(Ordering::Relaxed));
        assert!(!alive.load(Ordering::Relaxed));
        assert!(!shared.busy.load(Ordering::Relaxed));
        // Off for good.
        let fake = insert_block(&shared, 256);
        assert!(fake.changed().is_empty());
        assert_eq!(
            hits.load(Ordering::Relaxed),
            1,
            "called again after a panic"
        );
        assert_eq!(shared.calls.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn a_restarted_stream_must_fit_the_running_engine() {
        assert!(host::fits(48_000, 2048, 48_000, 256).is_ok());
        assert!(host::fits(48_000, 2048, 48_000, 2048).is_ok());
        let rate = host::fits(48_000, 2048, 44_100, 256).unwrap_err();
        assert!(rate.contains("48000") && rate.contains("44100"), "{rate}");
        let block = host::fits(48_000, 2048, 48_000, 2049).unwrap_err();
        assert!(block.contains("2049") && block.contains("2048"), "{block}");
        assert_eq!((host::STARTING, host::ENDING, host::CHANGE), (1, 2, 3));
        assert_eq!((host::BUFFER_IN, host::MODE_INPUT_INSERT), (10, 1));
    }

    #[test]
    fn routing_is_validated() {
        // The owner's rig: mono microphone on the left channel of Potato strip index 4.
        assert_eq!(
            plan::route(&cfg(&[8], [8, 8]), 34).unwrap(),
            Route {
                input: [8, 8],
                inputs: 1,
                main: [8, 8]
            }
        );
        assert_eq!(
            plan::route(&cfg(&[8, 9], [8, 9]), 34).unwrap(),
            Route {
                input: [8, 9],
                inputs: 2,
                main: [8, 9]
            }
        );
        let config_error = |c: &IoConfig, channels: u16| match plan::route(c, channels) {
            Err(IoError::Config(m)) => m,
            other => panic!("expected a configuration error, got {other:?}"),
        };
        // A monitor pair would overwrite other strips.
        let with_monitor = IoConfig {
            monitor_channels: Some([10, 11]),
            ..cfg(&[8], [8, 8])
        };
        assert!(config_error(&with_monitor, 34).contains("monitor"));
        // Outside the buffer: 34 is one past Potato's last channel, 12 one past standard's.
        assert!(config_error(&cfg(&[34], [8, 8]), 34).contains("channel 34"));
        assert!(config_error(&cfg(&[8], [8, 34]), 34).contains("channel 34"));
        assert!(config_error(&cfg(&[8], [34, 8]), 34).contains("channel 34"));
        assert!(config_error(&cfg(&[8], [8, 12]), 12).contains("channel 12"));
        assert!(plan::route(&cfg(&[33], [33, 33]), 34).is_ok());
        // One or two inputs.
        assert!(config_error(&cfg(&[], [8, 8]), 34).contains("1 or 2"));
        assert!(config_error(&cfg(&[8, 9, 10], [8, 8]), 34).contains("1 or 2"));
        // Unknown buffer (0 channels): nothing fits.
        assert!(plan::route(&cfg(&[0], [0, 0]), 0).is_err());
    }

    #[test]
    fn engine_config_keeps_a_single_channel_a_mono_mix() {
        let mono = plan::engine_config(&plan::route(&cfg(&[8], [8, 8]), 34).unwrap());
        assert_eq!(
            (mono.input_channels.as_slice(), mono.main_channels),
            (&[0u16][..], [0, 0])
        );
        assert_eq!(mono.monitor_channels, None);
        let stereo = plan::engine_config(&plan::route(&cfg(&[8, 9], [8, 9]), 34).unwrap());
        assert_eq!(
            (stereo.input_channels.as_slice(), stereo.main_channels),
            (&[0u16, 1][..], [0, 1])
        );
    }

    #[test]
    fn control_parameters_and_validation() {
        assert_eq!(plan::buffer_param("wdm", 160).unwrap(), "Option.buffer.wdm");
        assert_eq!(plan::buffer_param(" KS ", 64).unwrap(), "Option.buffer.ks");
        assert_eq!(
            plan::buffer_param("asio", 2048).unwrap(),
            "Option.buffer.asio"
        );
        assert_eq!(plan::buffer_param("mme", 512).unwrap(), "Option.buffer.mme");
        assert!(
            plan::buffer_param("wasapi", 256)
                .unwrap_err()
                .contains("wasapi")
        );
        assert!(plan::buffer_param("wdm", 63).unwrap_err().contains("63"));
        assert!(plan::buffer_param("wdm", 2049).is_err());
        assert!(plan::buffer_param("wdm;Command.Shutdown=1", 256).is_err());
        assert_eq!(
            (plan::SAVE, plan::LOAD, plan::RESTART),
            ("Command.Save", "Command.Load", "Command.Restart")
        );

        let abs = std::env::temp_dir().join("vm snapshot ă.xml");
        assert_eq!(plan::snapshot_path(&abs).unwrap(), abs.to_str().unwrap());
        assert!(
            plan::snapshot_path(Path::new("snapshot.xml"))
                .unwrap_err()
                .contains("absolute")
        );
        assert!(
            plan::snapshot_path(&std::env::temp_dir().join("a\"b.xml"))
                .unwrap_err()
                .contains("quote")
        );
        assert!(plan::snapshot_path(&std::env::temp_dir().join("a\nb.xml")).is_err());
        let long = std::env::temp_dir().join("x".repeat(600));
        assert!(plan::snapshot_path(&long).unwrap_err().contains("500"));
        // `save_snapshot` / `load_snapshot` / `set_buffer` themselves are never called from a
        // test: on a machine with Voicemeeter they would reach the live mixer.
    }

    #[test]
    fn a_saved_snapshot_must_be_big_enough_and_new() {
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let later = t + Duration::from_secs(1);
        assert!(plan::snapshot_written(300_000, Some(later), None));
        assert!(plan::snapshot_written(300_000, Some(later), Some(t)));
        // The file that was already there, untouched: not a new save.
        assert!(!plan::snapshot_written(300_000, Some(t), Some(t)));
        assert!(!plan::snapshot_written(1023, Some(later), None));
        assert!(plan::snapshot_written(1024, None, None));
    }

    fn potato_strips() -> Vec<StripInfo> {
        (0..8u32)
            .map(|index| StripInfo {
                index,
                kind: plan::strip_kind(3, index).into(),
                label: if index == 4 {
                    "Q-28 (L mixer, R DJI)".into()
                } else {
                    String::new()
                },
                channels: plan::strip_channels(3, index),
                ..StripInfo::default()
            })
            .collect()
    }

    #[test]
    fn channels_are_named_after_their_strip() {
        let strips = potato_strips();
        assert_eq!(
            plan::describe(&strips, &[8, 8]),
            "Voicemeeter Strip[4] \"Q-28 (L mixer, R DJI)\", insert channel 8"
        );
        assert_eq!(
            plan::describe(&strips, &[8, 9]),
            "Voicemeeter Strip[4] \"Q-28 (L mixer, R DJI)\", insert channels 8+9"
        );
        assert_eq!(
            plan::describe(&strips, &[12]),
            "Voicemeeter Strip[5], insert channel 12"
        );
        assert_eq!(plan::describe(&[], &[8]), "Voicemeeter insert channel 8");
        assert_eq!(plan::strip_of(&strips, 33).map(|s| s.index), Some(7));
        assert!(plan::strip_of(&strips, 34).is_none());
        // 2 x 256 frames at 48 kHz.
        assert!((plan::nominal_ms(256, 48_000) - 10.666_667).abs() < 1e-3);
    }

    #[test]
    fn info_serialises_with_the_documented_field_names() {
        let v = serde_json::to_value(VoicemeeterInfo::default()).unwrap();
        for key in [
            "installed",
            "running",
            "kind",
            "version",
            "sample_rate",
            "buffer_wdm",
            "a1_device",
            "insert_channels",
            "strips",
        ] {
            assert!(v.get(key).is_some(), "{key}");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn other_platforms_have_no_voicemeeter() {
        assert!(!installed());
        assert_eq!(info(), VoicemeeterInfo::default());
        let abs = std::env::temp_dir().join("x.xml");
        assert_eq!(save_snapshot(&abs).unwrap_err(), plan::NOT_WINDOWS);
        assert_eq!(load_snapshot(&abs).unwrap_err(), plan::NOT_WINDOWS);
        assert_eq!(set_buffer("wdm", 256).unwrap_err(), plan::NOT_WINDOWS);
    }

    /// Read-only picture of the Voicemeeter on this machine; run by hand through the isolated
    /// copy: `cargo test -p live-engine --lib -- --ignored print_voicemeeter_info --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore = "logs in to the local Voicemeeter (read-only) and prints what it runs"]
    fn print_voicemeeter_info_on_this_machine() {
        println!("installed() = {}", installed());
        println!("{}", serde_json::to_string_pretty(&info()).unwrap());
    }
}
