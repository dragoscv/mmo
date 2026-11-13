//! Device I/O over cpal (plus the own WASAPI hosts on Windows): an input stream feeds a lock-free
//! ring, the output stream pulls from it,
//! runs [`Core`] and writes the main + monitor buses to the chosen output channels.
//!
//! Processing happens in the OUTPUT callback so the in→out path costs one input period plus the
//! ring target (one block) plus one output period. Ring fill is held near the target: overfill
//! (clock drift) drops frames with a short fade, underfill counts an xrun and plays the last
//! block faded out instead of a click.

use crate::core::{Buses, Command, Core, Garbage, Meters};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleFormat, StreamConfig};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub host: String,
    pub input_channels: u16,
    pub output_channels: u16,
    pub default_rate: u32,
    pub is_default_input: bool,
    pub is_default_output: bool,
    /// Device name looks like a Voicemeeter / VB-Audio virtual endpoint.
    pub voicemeeter: bool,
    /// Device name looks like a virtual cable we can use for OBS/Zoom (VirtualDrivers, VB-Cable, BlackHole).
    pub virtual_cable: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct IoConfig {
    /// `host:id` from [`list_devices`]; None = system default.
    pub input: Option<String>,
    pub output: Option<String>,
    pub sample_rate: u32,
    pub buffer_frames: u32,
    /// Input channels used (0-based). One entry = mono mic, two = stereo source.
    pub input_channels: Vec<u16>,
    /// Output channel pair for the main (FOH / stream) bus.
    pub main_channels: [u16; 2],
    /// Output channel pair for the in-ear monitor bus (None = monitor not routed).
    pub monitor_channels: Option<[u16; 2]>,
    /// Host name: a cpal host (e.g. "ASIO", "WASAPI", "CoreAudio", "JACK") or one of the native
    /// [`WASAPI_EXCLUSIVE`] / [`WASAPI_LOW_LATENCY`] hosts; None = default host.
    pub host: Option<String>,
}

impl Default for IoConfig {
    fn default() -> Self {
        Self {
            input: None,
            output: None,
            sample_rate: 48_000,
            buffer_frames: 128,
            input_channels: vec![0],
            main_channels: [0, 1],
            monitor_channels: None,
            host: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum IoError {
    #[error("device not found: {0}")]
    NotFound(String),
    #[error("audio device error: {0}")]
    Device(String),
    #[error("unsupported configuration: {0}")]
    Config(String),
}

/// Own WASAPI backend, exclusive mode: the engine owns the endpoints (lowest latency without ASIO).
pub const WASAPI_EXCLUSIVE: &str = "WASAPI Exclusive";
/// Own WASAPI backend, shared mode at the smallest engine period (`IAudioClient3`).
pub const WASAPI_LOW_LATENCY: &str = "WASAPI Low Latency";
/// The engine runs inside Voicemeeter's own audio callback as an input insert (Windows, Voicemeeter
/// Remote API): no device is opened, the "device" is Voicemeeter's input channels.
pub const VOICEMEETER_INSERT: &str = "Voicemeeter Insert";

#[cfg(windows)]
fn is_vm_insert(host: Option<&str>) -> bool {
    host.is_some_and(|h| h.eq_ignore_ascii_case(VOICEMEETER_INSERT))
}

#[cfg(windows)]
fn native_mode(host: Option<&str>) -> Option<crate::wasapi::Mode> {
    let h = host?;
    if h.eq_ignore_ascii_case(WASAPI_EXCLUSIVE) {
        Some(crate::wasapi::Mode::Exclusive)
    } else if h.eq_ignore_ascii_case(WASAPI_LOW_LATENCY) {
        Some(crate::wasapi::Mode::LowLatency)
    } else {
        None
    }
}

/// Real audio hosts. The simulated [`NULL_HOST`] is not listed (device pickers must not offer it); tests and
/// CI select it by name.
pub fn hosts() -> Vec<String> {
    #[allow(unused_mut)]
    let mut all: Vec<String> = cpal::available_hosts()
        .into_iter()
        .map(|h| h.name().to_string())
        .collect();
    #[cfg(windows)]
    {
        all.extend([WASAPI_EXCLUSIVE.to_string(), WASAPI_LOW_LATENCY.to_string()]);
        if crate::voicemeeter::installed() {
            all.push(VOICEMEETER_INSERT.to_string());
        }
    }
    all
}

fn host_named(name: Option<&str>) -> Result<cpal::Host, IoError> {
    match name {
        None => Ok(cpal::default_host()),
        Some(n) => {
            let id = cpal::available_hosts()
                .into_iter()
                .find(|h| h.name().eq_ignore_ascii_case(n))
                .ok_or_else(|| IoError::NotFound(format!("audio host {n}")))?;
            cpal::host_from_id(id).map_err(|e| IoError::Device(e.to_string()))
        }
    }
}

fn dev_name(d: &cpal::Device) -> String {
    d.description()
        .map(|x| x.name().to_owned())
        .unwrap_or_else(|_| "Unknown".into())
}

fn dev_id(d: &cpal::Device) -> String {
    d.id()
        .map(|i| i.to_string())
        .unwrap_or_else(|_| dev_name(d))
}

pub fn classify(name: &str) -> (bool, bool) {
    let n = name.to_ascii_lowercase();
    let vm = n.contains("voicemeeter") || n.contains("vb-audio");
    let cable = n.contains("cable")
        || n.contains("virtual audio")
        || n.contains("blackhole")
        || n.contains("mixai live")
        || n.contains("loopback");
    (vm, cable)
}

/// Every input/output device of a host, merged by id.
pub fn list_devices(host: Option<&str>) -> Result<Vec<DeviceInfo>, IoError> {
    if is_null(host) {
        return Ok(vec![null_device()]);
    }
    #[cfg(windows)]
    if is_vm_insert(host) {
        return crate::voicemeeter::devices();
    }
    // The native WASAPI hosts list the same endpoints as cpal's WASAPI host, under their own name.
    #[cfg(windows)]
    let label = native_mode(host).map(native_label);
    #[cfg(not(windows))]
    let label: Option<&str> = None;
    let h = host_named(if label.is_some() {
        Some("WASAPI")
    } else {
        host
    })?;
    let di = h.default_input_device().map(|d| dev_id(&d));
    let do_ = h.default_output_device().map(|d| dev_id(&d));
    let mut out: Vec<DeviceInfo> = Vec::new();
    let devices = h.devices().map_err(|e| IoError::Device(e.to_string()))?;
    for d in devices {
        let id = dev_id(&d);
        let name = dev_name(&d);
        let ic = d.default_input_config().map(|c| c.channels()).unwrap_or(0);
        let oc = d.default_output_config().map(|c| c.channels()).unwrap_or(0);
        let rate = d
            .default_output_config()
            .map(|c| c.sample_rate())
            .or_else(|_| d.default_input_config().map(|c| c.sample_rate()))
            .unwrap_or(48_000);
        let (voicemeeter, virtual_cable) = classify(&name);
        out.push(DeviceInfo {
            is_default_input: di.as_deref() == Some(id.as_str()),
            is_default_output: do_.as_deref() == Some(id.as_str()),
            id,
            name,
            host: label.map_or_else(|| h.id().name().to_string(), str::to_owned),
            input_channels: ic,
            output_channels: oc,
            default_rate: rate,
            voicemeeter,
            virtual_cable,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn find(h: &cpal::Host, id: Option<&str>, input: bool) -> Result<cpal::Device, IoError> {
    let def = if input {
        h.default_input_device()
    } else {
        h.default_output_device()
    };
    let Some(id) = id else {
        return def.ok_or_else(|| {
            IoError::NotFound(
                if input {
                    "default input"
                } else {
                    "default output"
                }
                .into(),
            )
        });
    };
    if let Ok(did) = id.parse::<cpal::DeviceId>()
        && let Some(d) = h.device_by_id(&did)
    {
        return Ok(d);
    }
    let all = h.devices().map_err(|e| IoError::Device(e.to_string()))?;
    for d in all {
        if dev_name(&d) == id || dev_id(&d) == id {
            return Ok(d);
        }
    }
    Err(IoError::NotFound(id.into()))
}

fn has_f32(d: &cpal::Device, input: bool) -> bool {
    let it: Vec<_> = if input {
        d.supported_input_configs()
            .map(|i| i.collect())
            .unwrap_or_default()
    } else {
        d.supported_output_configs()
            .map(|i| i.collect())
            .unwrap_or_default()
    };
    it.iter().any(|c| c.sample_format() == SampleFormat::F32)
}

/// Shared between threads for telemetry.
pub struct Running {
    /// The device streams (or the simulated device): processing stops when this drops.
    _streams: Box<dyn std::any::Any>,
    pub commands: rtrb::Producer<Command>,
    pub garbage: rtrb::Consumer<Garbage>,
    pub meters: rtrb::Consumer<Meters>,
    pub info: RunningInfo,
    alive: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
    driver_xruns: Arc<AtomicU32>,
    /// Live figures of the adaptive cushion; None = fixed cushion.
    cushion: Option<Arc<CushionStats>>,
}

/// Audio callbacks of a duplex backend: interleaved input in, interleaved output out.
pub(crate) type InCb = Box<dyn FnMut(&[f32]) + Send>;
pub(crate) type OutCb = Box<dyn FnMut(&mut [f32]) + Send>;

/// What a backend needs to run the engine: call `on_input` with every captured block and
/// `on_output` for every block to play; hand `ends` to [`Running::assemble`].
pub(crate) struct Duplex {
    pub on_input: InCb,
    pub on_output: OutCb,
    pub ends: Ends,
}

/// Checks the routing against the device's channel counts and builds the rings, the core and the
/// two callbacks. `cushion` = frames kept queued between input and output before the output
/// starts pulling (one period on separate streams; 0 when input and output are the same
/// callback, so the input of a block is already queued when its output is rendered).
pub(crate) fn duplex(
    cfg: &IoConfig,
    rate: u32,
    in_ch: u16,
    out_ch: u16,
    cushion: u32,
    max_block: usize,
) -> Result<Duplex, IoError> {
    check_routing(cfg, in_ch, out_ch)?;
    let (mut p, ends) = plumbing(rate, max_block);
    let in_tx = std::mem::replace(&mut p.in_tx, rtrb::RingBuffer::new(1).0);
    let on_input = input_callback(in_ch, cfg.input_channels.clone(), in_tx);
    let main = cfg.main_channels.map(|c| c as usize);
    let mon = cfg.monitor_channels.map(|m| m.map(|c| c as usize));
    let on_output = output_callback(out_ch, Cushion::Fixed(cushion), max_block, main, mon, p);
    Ok(Duplex {
        on_input: Box::new(on_input),
        on_output: Box::new(on_output),
        ends,
    })
}

/// [`duplex`] with the adaptive cushion (see [`Tracker`]): the output side starts pulling at
/// one `period` queued, like the fixed mode, then trims the frames it measures as standing
/// idle in the ring down to `margin` and backs off on underruns. For hosts whose input and
/// output run whole blocks of `period` frames on one clock (the exclusive WASAPI host).
#[cfg_attr(not(windows), allow(dead_code))] // only the Windows exclusive host uses it so far
pub(crate) fn duplex_adaptive(
    cfg: &IoConfig,
    rate: u32,
    in_ch: u16,
    out_ch: u16,
    period: u32,
    margin: u32,
    max_block: usize,
) -> Result<(Duplex, Arc<CushionStats>), IoError> {
    check_routing(cfg, in_ch, out_ch)?;
    let stats = Arc::new(CushionStats::default());
    let (mut p, ends) = plumbing(rate, max_block);
    let in_tx = std::mem::replace(&mut p.in_tx, rtrb::RingBuffer::new(1).0);
    let on_input = input_callback(in_ch, cfg.input_channels.clone(), in_tx);
    let main = cfg.main_channels.map(|c| c as usize);
    let mon = cfg.monitor_channels.map(|m| m.map(|c| c as usize));
    let tracker = Tracker::new(period, margin, rate, stats.clone());
    let on_output = output_callback(out_ch, Cushion::Adaptive(tracker), max_block, main, mon, p);
    Ok((
        Duplex {
            on_input: Box::new(on_input),
            on_output: Box::new(on_output),
            ends,
        },
        stats,
    ))
}

/// Figures of the adaptive cushion, written by the audio thread with relaxed stores (no lock,
/// no syscall) and read by the control side.
#[derive(Default)]
pub(crate) struct CushionStats {
    /// Frames standing in the ring after a pull (the largest of the last 16 to 32 pulls, so the
    /// figure does not flicker when the order of the two events flips).
    cushion: AtomicU32,
    /// Trims decided (one per observation window that found idle frames).
    lowered: AtomicU32,
    /// Backoffs: one per underrun.
    raised: AtomicU32,
}

/// Frames removed per splice (0.33 ms at 48 kHz).
const TRIM_SPLICE: usize = 16;
/// Crossfade of a splice, frames: the block blends from the frames before the cut into the
/// frames after it over this length (`a_trim_splice_stays_below_the_bound`).
const TRIM_XFADE: usize = 64;
/// Smallest surplus worth a trim, frames: one splice.
const TRIM_STEP: usize = 16;
/// First observation window, seconds of audio (counted in frames rendered: no clock).
const OBSERVE_S: usize = 4;
/// Every underrun multiplies the window by 4, this many times at most: 4, 16, 64, 256 s.
const MAX_WINDOW_STEPS: u32 = 3;
/// Splices are at least 1/20 s apart.
const SPLICE_GAP_DIV: usize = 20;
/// Underruns that follow an own trim before the cushion stops lowering for good.
const MAX_STRIKES: u32 = 2;
/// Priming threshold ceiling, periods.
const MAX_THRESHOLD_PERIODS: usize = 3;
/// Pulls per bucket of the published figure.
const PUBLISH_PULLS: u32 = 16;

/// Adaptive duplex cushion (tracker WP21-26).
///
/// What it can and cannot remove. A frame waits in the ring for `spare + phase`: the frames
/// standing in the ring after the output pulled its block (the spare), plus the time from the
/// capture event to the next render event (the phase, between 0 and one period, a property of
/// the device that the ring cannot see or change). Input and output exchange whole blocks of
/// one `period` here, so the spare is a whole number of periods: none in a clean start, one
/// when the output started late or after any hiccup (the fixed cushion re-primes with the late
/// packet AND the next one queued, and keeps that period for the rest of the session). The
/// tracker removes exactly that standing spare; it does not shave the phase.
///
/// Lowering. The output primes at `threshold` frames queued (one period at start, as the fixed
/// cushion does) and notes the spare after every pull. A spare that never went below
/// `margin + TRIM_STEP` during a whole observation window is idle delay: `min - margin` frames
/// are removed, [`TRIM_SPLICE`] frames per splice, each splice crossfaded over [`TRIM_XFADE`]
/// frames and 1/20 s after the previous one (a 144-frame period goes in 9 splices). A spare
/// below one period cannot cover a late packet when blocks are whole, so the exclusive host
/// passes `margin = 0`; the parameter is the floor for hosts that would need one.
///
/// Backing off. An underrun counts as an engine xrun as before, and then: the priming
/// threshold goes up one period (ceiling [`MAX_THRESHOLD_PERIODS`]), or back to what the last
/// trim removed when the underrun follows a trim (a strike). After a LATE packet the raise
/// changes nothing (the re-prime finds the late packet and the next one queued, one period
/// stands, exactly as with the fixed cushion); it matters after a MISSING packet, where the
/// fixed cushion re-primes with nothing in reserve. The observation window is multiplied by 4
/// (4, 16, 64, 256 s), so jitter that comes back within the window is seen as a dip of the
/// spare and nothing is trimmed; after [`MAX_STRIKES`] strikes the cushion never lowers again.
/// Worst case against the fixed cushion: [`MAX_STRIKES`] extra underruns in a session, then
/// the same standing period as the fixed cushion.
///
/// Two clocks (input and output on different devices). Input faster: a packet accumulates
/// every period/drift and is trimmed with splices instead of the hard drop (the drop-oldest
/// rule stays as the backstop above `threshold` + one block). Input slower: packets go missing
/// at that rate whatever the cushion does; the threshold climbs to its ceiling, up to two
/// periods stand in the ring and drain, and the output underruns less often but for longer
/// (calculated: once per three periods of drift, against once per period for the fixed
/// cushion; simulated at 100 ppm with a 144-frame period: 5 underruns in 5 minutes against 10,
/// `slow_input_clock_stays_bounded`). Only a resampler removes those.
struct Tracker {
    period: usize,
    margin: usize,
    /// Frames the ring must hold before the output pulls.
    threshold: usize,
    cap: usize,
    primed: bool,
    trimmed_since_prime: bool,
    /// The spare the last trim found standing; restored on an underrun after that trim.
    safe_spare: usize,
    base_window: usize,
    window: usize,
    elapsed: usize,
    min_spare: usize,
    backoffs: u32,
    strikes: u32,
    latched: bool,
    /// Frames still to remove.
    pending: usize,
    /// Frames rendered since the last splice.
    since_splice: usize,
    gap: usize,
    /// Largest spare of the current and of the previous bucket of [`PUBLISH_PULLS`] pulls.
    recent: [usize; 2],
    recent_n: u32,
    stats: Arc<CushionStats>,
}

impl Tracker {
    fn new(period: u32, margin: u32, rate: u32, stats: Arc<CushionStats>) -> Self {
        let period = period.max(1) as usize;
        stats.cushion.store(period as u32, Ordering::Relaxed);
        let base_window = rate as usize * OBSERVE_S;
        Self {
            period,
            margin: margin as usize,
            threshold: period,
            cap: period * MAX_THRESHOLD_PERIODS,
            primed: false,
            trimmed_since_prime: false,
            safe_spare: 0,
            base_window,
            window: base_window,
            elapsed: 0,
            min_spare: usize::MAX,
            backoffs: 0,
            strikes: 0,
            latched: false,
            pending: 0,
            since_splice: 0,
            gap: rate as usize / SPLICE_GAP_DIV,
            recent: [0; 2],
            recent_n: 0,
            stats,
        }
    }

    fn underrun(&mut self) {
        self.primed = false;
        self.pending = 0;
        if self.trimmed_since_prime {
            self.strikes += 1;
            self.latched |= self.strikes >= MAX_STRIKES;
            self.threshold = self.threshold.max(self.period + self.safe_spare);
        } else {
            self.threshold += self.period;
        }
        self.threshold = self.threshold.min(self.cap);
        self.backoffs = (self.backoffs + 1).min(MAX_WINDOW_STEPS);
        self.window = self.base_window << (2 * self.backoffs);
        self.elapsed = 0;
        self.min_spare = usize::MAX;
        self.stats.raised.fetch_add(1, Ordering::Relaxed);
    }

    fn publish(&mut self, spare: usize) {
        self.recent[0] = self.recent[0].max(spare);
        let shown = self.recent[0].max(self.recent[1]);
        self.stats.cushion.store(shown as u32, Ordering::Relaxed);
        self.recent_n += 1;
        if self.recent_n == PUBLISH_PULLS {
            self.recent = [0, self.recent[0]];
            self.recent_n = 0;
        }
    }

    /// Pulls `frames` frames into `il`/`ir` (zeros when not primed or short), applies a splice
    /// of the pending trim when one is due, keeps the ring bounded and runs the observation.
    /// Returns true on an underrun.
    fn pull(&mut self, rx: &mut rtrb::Consumer<f32>, il: &mut [f32], ir: &mut [f32]) -> bool {
        let frames = il.len();
        let avail = rx.slots() / 2;
        if !self.primed && avail >= self.threshold {
            self.primed = true;
            self.trimmed_since_prime = false;
        }
        let take = if self.primed { avail.min(frames) } else { 0 };
        let xrun = self.primed && take < frames;
        if xrun {
            self.underrun();
        }
        // A splice removes `r` frames right after the first `x` frames of this block, which
        // crossfade from the frames before the cut into the frames after it.
        let (mut r, mut x) = (0, 0);
        if !xrun && take > 0 && self.pending > 0 && self.since_splice >= self.gap {
            let want = self.pending.min(TRIM_SPLICE);
            if avail - take >= want {
                r = want;
                x = TRIM_XFADE.min(take);
            } else {
                // The surplus is gone (the order of the two events flipped): observe again.
                self.pending = 0;
            }
        }
        let mut got = 0;
        if take > 0
            && let Ok(chunk) = rx.read_chunk((take + r) * 2)
        {
            let (s1, s2) = chunk.as_slices();
            let at = |j: usize| {
                if j < s1.len() {
                    s1[j]
                } else {
                    s2[j - s1.len()]
                }
            };
            for f in 0..take {
                let (bl, br) = (at((f + r) * 2), at((f + r) * 2 + 1));
                if f < x {
                    let w = (f + 1) as f32 / (x + 1) as f32;
                    let (al, ar) = (at(f * 2), at(f * 2 + 1));
                    il[f] = al + (bl - al) * w;
                    ir[f] = ar + (br - ar) * w;
                } else {
                    il[f] = bl;
                    ir[f] = br;
                }
            }
            chunk.commit_all();
            got = take;
        }
        il[got..].fill(0.0);
        ir[got..].fill(0.0);
        if r > 0 {
            self.pending -= r;
            self.since_splice = 0;
        } else {
            self.since_splice = self.since_splice.saturating_add(frames);
        }
        // Backstop against drift: at most threshold + one block queued (drop the oldest).
        let queued = rx.slots() / 2;
        let excess = queued.saturating_sub(self.threshold + frames);
        for _ in 0..excess * 2 {
            let _ = rx.pop();
        }
        // From the count taken before the pull: a packet pushed meanwhile by another thread
        // must not look like standing spare.
        let spare = (avail - take - r).min(queued - excess);
        self.publish(spare);
        if self.primed && self.pending == 0 && !self.latched {
            self.min_spare = self.min_spare.min(spare);
            self.elapsed += frames;
            if self.elapsed >= self.window {
                if self.min_spare >= self.margin + TRIM_STEP {
                    self.pending = self.min_spare - self.margin;
                    self.safe_spare = self.min_spare;
                    self.trimmed_since_prime = true;
                    self.stats.lowered.fetch_add(1, Ordering::Relaxed);
                }
                self.elapsed = 0;
                self.min_spare = usize::MAX;
            }
        }
        xrun
    }
}

/// How the output side handles the frames queued between the two callbacks.
enum Cushion {
    /// Pull once this many frames are queued, keep at most that plus one block: the rule every
    /// host used before the adaptive mode, kept sample for sample.
    Fixed(u32),
    Adaptive(Tracker),
}

/// Environment variable that switches the adaptive cushion off for diagnosis, read once when a
/// stream starts: any value except empty or `0` keeps the fixed cushion in the exclusive host
/// (`MIXAI_LIVE_FIXED_CUSHION=1`).
pub const FIXED_CUSHION_ENV: &str = "MIXAI_LIVE_FIXED_CUSHION";

#[cfg_attr(not(windows), allow(dead_code))]
fn fixed_cushion_forced(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_some_and(|v| !v.is_empty() && v != "0")
}

/// The adaptive cushion runs where its premise holds: the exclusive host (whole blocks, both
/// events on one thread) with equal periods. Unequal periods and the shared host keep the fixed
/// cushion: there the ring also has to bridge the difference between the block sizes.
#[cfg_attr(not(windows), allow(dead_code))]
fn wants_adaptive(exclusive: bool, in_period: u32, out_period: u32, forced_fixed: bool) -> bool {
    exclusive && in_period == out_period && !forced_fixed
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RunningInfo {
    pub host: String,
    pub input: String,
    pub output: String,
    pub sample_rate: u32,
    pub buffer_frames: u32,
    pub input_channels: u16,
    pub output_channels: u16,
    /// Theoretical in→out latency from buffer sizes (the probe measures the real one).
    pub nominal_latency_ms: f32,
    /// The three buffer terms behind `nominal_latency_ms`, in frames: one input period, the
    /// frames kept queued between input and output, one output period.
    #[serde(default)]
    pub input_period_frames: u32,
    #[serde(default)]
    pub cushion_frames: u32,
    #[serde(default)]
    pub output_period_frames: u32,
    pub notes: Vec<String>,
}

impl Running {
    /// Put a started backend together. `streams` is whatever keeps the audio running; dropping
    /// it must stop the callbacks.
    pub(crate) fn assemble(
        streams: Box<dyn std::any::Any>,
        ends: Ends,
        info: RunningInfo,
        alive: Arc<AtomicBool>,
        last_error: Arc<Mutex<Option<String>>>,
        driver_xruns: Arc<AtomicU32>,
    ) -> Running {
        Running {
            _streams: streams,
            commands: ends.commands,
            garbage: ends.garbage,
            meters: ends.meters,
            info,
            alive,
            last_error,
            driver_xruns,
            cushion: None,
        }
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    /// Frames queued between input and output right now: the adaptive cushion's live figure, or
    /// the configured value (`info.cushion_frames`) on a fixed cushion.
    pub fn cushion_frames(&self) -> u32 {
        self.cushion.as_ref().map_or(self.info.cushion_frames, |c| {
            c.cushion.load(Ordering::Relaxed)
        })
    }

    /// Whether the cushion adapts (exclusive WASAPI host with equal periods).
    pub fn cushion_adaptive(&self) -> bool {
        self.cushion.is_some()
    }

    /// (times the adaptive cushion was lowered, times an underrun raised it); (0, 0) when fixed.
    pub fn cushion_changes(&self) -> (u32, u32) {
        self.cushion.as_ref().map_or((0, 0), |c| {
            (
                c.lowered.load(Ordering::Relaxed),
                c.raised.load(Ordering::Relaxed),
            )
        })
    }

    /// Last error reported by either stream callback (device removed, driver reset...).
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|e| e.clone())
    }

    /// Xruns reported by the driver (in addition to the engine's own ring underruns).
    pub fn driver_xruns(&self) -> u32 {
        self.driver_xruns.load(Ordering::Relaxed)
    }

    /// Send a command; returns it back when the ring is full (caller retries next tick).
    pub fn send(&mut self, cmd: Command) -> Result<(), Command> {
        self.commands
            .push(cmd)
            .map_err(|rtrb::PushError::Full(c)| c)
    }

    /// Drop boxes returned by the audio thread and return the newest meters.
    pub fn poll(&mut self) -> Option<Meters> {
        while let Ok(g) = self.garbage.pop() {
            drop(g);
        }
        let mut last = None;
        while let Ok(m) = self.meters.pop() {
            last = Some(m);
        }
        last
    }
}

/// Name of the simulated host: no hardware, a real-time clock thread, and the main output fed
/// back into the input (a perfect loopback cable). Used by tests, CI and the FFI test suites.
pub const NULL_HOST: &str = "Null";

fn is_null(host: Option<&str>) -> bool {
    host.is_some_and(|h| h.eq_ignore_ascii_case(NULL_HOST))
}

/// The two ring ends + core every backend wires into its callbacks.
struct Plumbing {
    core: Core,
    cmd_rx: rtrb::Consumer<Command>,
    gar_tx: rtrb::Producer<Garbage>,
    met_tx: rtrb::Producer<Meters>,
    in_tx: rtrb::Producer<f32>,
    in_rx: rtrb::Consumer<f32>,
}

pub(crate) struct Ends {
    pub(crate) commands: rtrb::Producer<Command>,
    pub(crate) garbage: rtrb::Consumer<Garbage>,
    pub(crate) meters: rtrb::Consumer<Meters>,
}

fn plumbing(rate: u32, max_block: usize) -> (Plumbing, Ends) {
    let (cmd_tx, cmd_rx) = rtrb::RingBuffer::<Command>::new(1024);
    let (gar_tx, gar_rx) = rtrb::RingBuffer::<Garbage>::new(256);
    let (met_tx, met_rx) = rtrb::RingBuffer::<Meters>::new(64);
    // Mono-or-stereo input ring, interleaved L/R, ~170 ms of capacity.
    let (in_tx, in_rx) = rtrb::RingBuffer::<f32>::new((rate as usize / 6).next_power_of_two() * 2);
    (
        Plumbing {
            core: Core::new(rate as f32, max_block),
            cmd_rx,
            gar_tx,
            met_tx,
            in_tx,
            in_rx,
        },
        Ends {
            commands: cmd_tx,
            garbage: gar_rx,
            meters: met_rx,
        },
    )
}

/// Input callback: picks the selected channels and queues them as interleaved L/R.
fn input_callback(
    in_ch: u16,
    sel: Vec<u16>,
    mut in_tx: rtrb::Producer<f32>,
) -> impl FnMut(&[f32]) + Send + 'static {
    move |data: &[f32]| {
        let ch = in_ch as usize;
        let (a, b) = (sel[0] as usize, *sel.get(1).unwrap_or(&sel[0]) as usize);
        let frames = data.len() / ch;
        if let Ok(mut chunk) = in_tx.write_chunk_uninit((frames * 2).min(in_tx.slots())) {
            let (s1, s2) = chunk.as_mut_slices();
            let mut k = 0;
            for f in 0..frames {
                for v in [data[f * ch + a], data[f * ch + b]] {
                    if k < s1.len() {
                        s1[k].write(v);
                    } else if k - s1.len() < s2.len() {
                        s2[k - s1.len()].write(v);
                    }
                    k += 1;
                }
            }
            let n = s1.len() + s2.len();
            // SAFETY: every slot of both slices was written above (k covered n slots).
            unsafe { chunk.commit(n.min(k)) };
        }
    }
}

/// Output callback: applies commands, pulls the input ring, renders, writes the buses.
#[allow(clippy::too_many_arguments)]
fn output_callback(
    out_ch: u16,
    cushion: Cushion,
    max_block: usize,
    main: [usize; 2],
    mon: Option<[usize; 2]>,
    p: Plumbing,
) -> impl FnMut(&mut [f32]) + Send + 'static {
    let Plumbing {
        mut core,
        mut cmd_rx,
        mut gar_tx,
        mut met_tx,
        in_tx: _,
        mut in_rx,
    } = p;
    let mut cushion = cushion;
    // Fixed mode: samples (L+R) in the ring before we start pulling.
    let target = match &cushion {
        Cushion::Fixed(buf) => *buf as usize * 2,
        Cushion::Adaptive(_) => 0,
    };
    let mut scratch: [Vec<f32>; 6] = core::array::from_fn(|_| vec![0.0; max_block]);
    let mut primed = false;
    move |data: &mut [f32]| {
        let t0 = Instant::now();
        let ch = out_ch as usize;
        let frames = (data.len() / ch).min(max_block);
        while let Ok(cmd) = cmd_rx.pop() {
            core.apply(cmd, &mut |g| {
                let _ = gar_tx.push(g);
            });
        }
        let [il, ir, ml, mr, ol, or] = &mut scratch;
        match &mut cushion {
            Cushion::Fixed(_) => {
                let avail = in_rx.slots() / 2;
                if !primed {
                    primed = avail * 2 >= target;
                }
                let take = if primed { avail.min(frames) } else { 0 };
                if primed && take < frames {
                    core.xruns += 1;
                    primed = false;
                }
                for f in 0..frames {
                    if f < take {
                        il[f] = in_rx.pop().unwrap_or(0.0);
                        ir[f] = in_rx.pop().unwrap_or(0.0);
                    } else {
                        il[f] = 0.0;
                        ir[f] = 0.0;
                    }
                }
                // Drift: keep at most target + one period queued (drop the oldest frames).
                let excess = (in_rx.slots() / 2).saturating_sub(target / 2 + frames);
                if excess > 0 {
                    for _ in 0..excess * 2 {
                        let _ = in_rx.pop();
                    }
                }
            }
            Cushion::Adaptive(t) => {
                if t.pull(&mut in_rx, &mut il[..frames], &mut ir[..frames]) {
                    core.xruns += 1;
                }
            }
        }
        core.render(
            &il[..frames],
            &ir[..frames],
            Buses {
                main_l: &mut ml[..frames],
                main_r: &mut mr[..frames],
                mon_l: &mut ol[..frames],
                mon_r: &mut or[..frames],
            },
        );
        data.fill(0.0);
        // A pair routed to ONE channel (`--main 8`) gets the mono mix, not L + R (+6 dB).
        let side = |pair: [usize; 2]| if pair[0] == pair[1] { 0.5 } else { 1.0 };
        let (mg, og) = (side(main), mon.map_or(1.0, side));
        for f in 0..frames {
            let o = f * ch;
            data[o + main[0]] += ml[f] * mg;
            data[o + main[1]] += mr[f] * mg;
            if let Some([a, b]) = mon {
                data[o + a] += ol[f] * og;
                data[o + b] += or[f] * og;
            }
        }
        if let Some(t) = core.take_finished_tail() {
            let _ = gar_tx.push(Garbage::Chain(t));
        }
        let period = frames as f32 / core.sample_rate();
        let load = t0.elapsed().as_secs_f32() / period.max(1e-6);
        core.dsp_load = core.dsp_load * 0.9 + load * 0.1;
        core.dsp_load_max = core.dsp_load_max.max(load);
        if let Some(m) = core.meters_due() {
            let _ = met_tx.push(m);
        }
    }
}

fn check_routing(cfg: &IoConfig, in_ch: u16, out_ch: u16) -> Result<(), IoError> {
    let max_ch_needed = cfg
        .monitor_channels
        .map_or(cfg.main_channels[1], |m| m[1].max(cfg.main_channels[1]))
        .max(cfg.main_channels[0])
        + 1;
    if max_ch_needed > out_ch {
        return Err(IoError::Config(format!(
            "output has {out_ch} channels, routing needs {max_ch_needed}"
        )));
    }
    if cfg.input_channels.iter().any(|c| *c >= in_ch) || cfg.input_channels.is_empty() {
        return Err(IoError::Config(format!(
            "input has {in_ch} channels, requested {:?}",
            cfg.input_channels
        )));
    }
    Ok(())
}

fn nominal_ms(buf: u32, rate: u32) -> f32 {
    // input period + ring target (one block) + output period
    (buf as f32 * 3.0) / rate as f32 * 1000.0
}

#[cfg(windows)]
fn native_label(mode: crate::wasapi::Mode) -> &'static str {
    match mode {
        crate::wasapi::Mode::Exclusive => WASAPI_EXCLUSIVE,
        crate::wasapi::Mode::LowLatency => WASAPI_LOW_LATENCY,
    }
}

/// Windows endpoint id (`{0.0.0.00000000}.{guid}`) and display name of a device given by name
/// or id as in [`list_devices`]; `None` = the default device of that direction.
#[cfg(windows)]
pub(crate) fn wasapi_endpoint(
    device: Option<&str>,
    input: bool,
) -> Result<(String, String), IoError> {
    let host = host_named(Some("WASAPI"))?;
    let d = find(&host, device, input)?;
    let id = dev_id(&d);
    let endpoint = id.split_once(':').map_or(id.clone(), |(_, e)| e.to_owned());
    Ok((endpoint, dev_name(&d)))
}

/// Smallest periods a Windows endpoint offers.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DevicePeriods {
    pub device: String,
    /// Minimum device period (exclusive mode), in frames at the requested rate.
    pub exclusive_min: u32,
    /// Minimum shared engine period (`IAudioClient3`), in frames at `shared_rate`.
    pub shared_min: Option<u32>,
    /// Default shared engine period (what plain shared mode runs at), in frames at `shared_rate`.
    pub shared_default: Option<u32>,
    /// Rate of the Windows mixer on this device; None = no low-latency shared mode.
    pub shared_rate: Option<u32>,
}

/// Period limits of one device (by name or id); None when the platform or driver has no answer.
pub fn device_periods(device: &str, rate: u32) -> Result<Option<DevicePeriods>, IoError> {
    #[cfg(windows)]
    {
        // A name or id is looked up among capture and render devices alike.
        let (endpoint, name) = wasapi_endpoint(Some(device), false)?;
        Ok(
            crate::wasapi::periods(&endpoint, rate).map(|(exclusive_min, shared)| DevicePeriods {
                device: name.clone(),
                exclusive_min,
                shared_min: shared.map(|s| s.0),
                shared_default: shared.map(|s| s.1),
                shared_rate: shared.map(|s| s.2),
            }),
        )
    }
    #[cfg(not(windows))]
    {
        let _ = (device, rate);
        Ok(None)
    }
}

/// The own WASAPI backend: one MMCSS "Pro Audio" thread drives both endpoints.
#[cfg(windows)]
fn start_native(cfg: &IoConfig, mode: crate::wasapi::Mode) -> Result<Running, IoError> {
    use crate::wasapi;
    // Resolve names / ids with the same rules as the cpal hosts, then hand over the endpoint ids.
    let (in_id, out_id, in_name, out_name) = {
        let host = host_named(Some("WASAPI"))?;
        let i = find(&host, cfg.input.as_deref(), true)?;
        let o = find(&host, cfg.output.as_deref(), false)?;
        let endpoint = |d: &cpal::Device| {
            let id = dev_id(d);
            id.split_once(':').map_or(id.clone(), |(_, e)| e.to_owned())
        };
        (endpoint(&i), endpoint(&o), dev_name(&i), dev_name(&o))
    };
    let rate = cfg.sample_rate.clamp(8_000, 384_000);
    let buf = cfg.buffer_frames.clamp(16, 4096);
    let alive = Arc::new(AtomicBool::new(true));
    let last_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let driver_xruns = Arc::new(AtomicU32::new(0));
    let (ends_tx, ends_rx) = std::sync::mpsc::sync_channel::<(Ends, Option<Arc<CushionStats>>)>(1);
    let routing = cfg.clone();
    let exclusive = mode == wasapi::Mode::Exclusive;
    let forced_fixed = fixed_cushion_forced(std::env::var_os(FIXED_CUSHION_ENV).as_deref());
    let make: wasapi::Make = Box::new(move |o: &wasapi::Opened| {
        // The ring has to hold a whole capture packet plus one render block, so the target is
        // the larger period (a 480-frame input into a 144-frame output would underrun forever).
        let target = o.in_period.max(o.out_period);
        let max_block = (target as usize * 8).max(2048);
        let (d, stats) = if wants_adaptive(exclusive, o.in_period, o.out_period, forced_fixed) {
            // Margin 0: with whole blocks a reserve below one period covers no late packet (see
            // `Tracker`); the backoff adds whole periods where the machine needs them.
            let (d, stats) =
                duplex_adaptive(&routing, rate, o.in_ch, o.out_ch, target, 0, max_block)?;
            (d, Some(stats))
        } else {
            let d = duplex(&routing, rate, o.in_ch, o.out_ch, target, max_block)?;
            (d, None)
        };
        let _ = ends_tx.send((d.ends, stats));
        Ok((d.on_input, d.on_output))
    });
    let shared = wasapi::Shared {
        alive: alive.clone(),
        last_error: last_error.clone(),
        driver_xruns: driver_xruns.clone(),
    };
    let (handle, opened) = wasapi::start(mode, in_id, out_id, rate, buf, make, shared)?;
    let (ends, cushion) = ends_rx
        .recv()
        .map_err(|_| IoError::Device("audio thread sent no control rings".into()))?;
    let mut notes = opened.notes;
    if in_name != out_name {
        notes.push(
            "input and output are different devices: clock drift is corrected by dropping frames"
                .into(),
        );
    }
    if opened.out_period != buf {
        notes.push(format!(
            "requested {buf} frames, the driver runs {} frames",
            opened.out_period
        ));
    }
    if cushion.is_some() {
        notes.push(format!(
            "adaptive cushion: starts at one period ({} frames), removes frames that stand idle in the queue, adds a period back after an underrun ({FIXED_CUSHION_ENV}=1 keeps it fixed)",
            opened.out_period
        ));
    } else if exclusive && forced_fixed {
        notes.push(format!("fixed cushion: {FIXED_CUSHION_ENV} is set"));
    } else if exclusive {
        notes.push("fixed cushion: the input and output periods differ".into());
    }
    Ok(Running {
        _streams: Box::new(handle),
        commands: ends.commands,
        garbage: ends.garbage,
        meters: ends.meters,
        info: RunningInfo {
            host: native_label(mode).into(),
            input: in_name,
            output: out_name,
            sample_rate: rate,
            buffer_frames: opened.out_period,
            input_channels: opened.in_ch,
            output_channels: opened.out_ch,
            // input period + ring target (the larger period) + output period
            nominal_latency_ms: (opened.in_period
                + opened.in_period.max(opened.out_period)
                + opened.out_period) as f32
                / rate as f32
                * 1000.0,
            input_period_frames: opened.in_period,
            cushion_frames: opened.in_period.max(opened.out_period),
            output_period_frames: opened.out_period,
            notes,
        },
        alive,
        last_error,
        driver_xruns,
        cushion,
    })
}

/// Registers a cpal WASAPI stream thread with MMCSS "Pro Audio" on its first callback (cpal's own
/// `realtime` feature does the promotion when enabled).
#[cfg(all(windows, not(feature = "realtime")))]
fn promote_once(done: &mut bool, wanted: bool) {
    if wanted && !*done {
        match crate::wasapi::Mmcss::join() {
            Some(m) => m.keep(),
            None => log::warn!("MMCSS Pro Audio refused for a stream thread"),
        }
    }
    *done = true;
}

#[cfg(not(all(windows, not(feature = "realtime"))))]
fn promote_once(done: &mut bool, _wanted: bool) {
    *done = true;
}

/// Open input + output and start processing. Load a preset with a `SwapChain` command after.
pub fn start(cfg: &IoConfig) -> Result<Running, IoError> {
    if is_null(cfg.host.as_deref()) {
        return start_null(cfg);
    }
    #[cfg(windows)]
    if let Some(mode) = native_mode(cfg.host.as_deref()) {
        return start_native(cfg, mode);
    }
    #[cfg(windows)]
    if is_vm_insert(cfg.host.as_deref()) {
        return crate::voicemeeter::start(cfg);
    }
    let host = host_named(cfg.host.as_deref())?;
    let mmcss = host.id().name().eq_ignore_ascii_case("WASAPI");
    let indev = find(&host, cfg.input.as_deref(), true)?;
    let outdev = find(&host, cfg.output.as_deref(), false)?;
    let in_def = indev
        .default_input_config()
        .map_err(|e| IoError::Config(format!("input: {e}")))?;
    let out_def = outdev
        .default_output_config()
        .map_err(|e| IoError::Config(format!("output: {e}")))?;
    let mut notes = Vec::new();
    if !has_f32(&indev, true) || !has_f32(&outdev, false) {
        // A host whose device list is empty is a missing driver, not a format problem: ASIO on a
        // machine that only has the Windows class driver, for instance. Say which it is.
        let listed = host
            .devices()
            .map(|d| d.filter(|x| has_f32(x, true) || has_f32(x, false)).count())
            .unwrap_or(0);
        return Err(IoError::Config(if listed == 0 {
            format!(
                "the {} host has no usable device: is a driver installed for it?",
                host.id().name()
            )
        } else {
            format!(
                "{} offers no f32 stream format ({} device(s) on the {} host do)",
                dev_name(&indev),
                listed,
                host.id().name()
            )
        }));
    }
    let in_ch = in_def.channels();
    let out_ch = out_def.channels();
    check_routing(cfg, in_ch, out_ch)?;
    let rate = cfg.sample_rate;
    let buf = cfg.buffer_frames.clamp(16, 4096);
    let in_conf = StreamConfig {
        channels: in_ch,
        sample_rate: rate,
        buffer_size: BufferSize::Fixed(buf),
    };
    let out_conf = StreamConfig {
        channels: out_ch,
        sample_rate: rate,
        buffer_size: BufferSize::Fixed(buf),
    };

    // Generous blocks: some drivers ignore the fixed size and call with larger periods.
    let max_block = (buf as usize * 8).max(2048);
    let (mut p, ends) = plumbing(rate, max_block);
    let alive = Arc::new(AtomicBool::new(true));
    let last_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let driver_xruns = Arc::new(AtomicU32::new(0));

    /// Xruns and a refused realtime priority are glitches, not a dead stream.
    fn on_error(
        side: &str,
        e: cpal::Error,
        alive: &AtomicBool,
        text: &Mutex<Option<String>>,
        xruns: &AtomicU32,
    ) {
        match e.kind() {
            cpal::ErrorKind::Xrun => {
                xruns.fetch_add(1, Ordering::Relaxed);
            }
            cpal::ErrorKind::RealtimeDenied => {
                log::warn!("{side}: realtime priority denied ({e})");
                if let Ok(mut s) = text.lock() {
                    *s = Some(format!("{side}: realtime priority denied"));
                }
            }
            _ => {
                log::error!("{side} stream error: {e}");
                if let Ok(mut s) = text.lock() {
                    *s = Some(format!("{side}: {e}"));
                }
                alive.store(false, Ordering::Relaxed);
            }
        }
    }

    let in_tx = std::mem::replace(&mut p.in_tx, rtrb::RingBuffer::new(1).0);
    let mut on_input = input_callback(in_ch, cfg.input_channels.clone(), in_tx);
    let in_err_alive = alive.clone();
    let in_err_text = last_error.clone();
    let in_xr = driver_xruns.clone();
    let mut in_promoted = false;
    let input = indev
        .build_input_stream(
            in_conf,
            move |data: &[f32], _| {
                promote_once(&mut in_promoted, mmcss);
                on_input(data)
            },
            move |e| on_error("input", e, &in_err_alive, &in_err_text, &in_xr),
            None,
        )
        .map_err(|e| IoError::Device(format!("input stream: {e}")))?;

    let main = cfg.main_channels.map(|c| c as usize);
    let mon = cfg.monitor_channels.map(|m| m.map(|c| c as usize));
    let mut on_output = output_callback(out_ch, Cushion::Fixed(buf), max_block, main, mon, p);
    let out_err_alive = alive.clone();
    let out_err_text = last_error.clone();
    let out_xr = driver_xruns.clone();
    let mut out_promoted = false;
    let output = outdev
        .build_output_stream(
            out_conf,
            move |data: &mut [f32], _| {
                promote_once(&mut out_promoted, mmcss);
                on_output(data)
            },
            move |e| on_error("output", e, &out_err_alive, &out_err_text, &out_xr),
            None,
        )
        .map_err(|e| IoError::Device(format!("output stream: {e}")))?;

    input
        .play()
        .map_err(|e| IoError::Device(format!("start input: {e}")))?;
    output
        .play()
        .map_err(|e| IoError::Device(format!("start output: {e}")))?;
    if dev_name(&indev) != dev_name(&outdev) {
        notes.push(
            "input and output are different devices: clock drift is corrected by dropping frames"
                .into(),
        );
    }
    Ok(Running {
        _streams: Box::new((input, output)),
        commands: ends.commands,
        garbage: ends.garbage,
        meters: ends.meters,
        info: RunningInfo {
            host: host.id().name().to_string(),
            input: dev_name(&indev),
            output: dev_name(&outdev),
            sample_rate: rate,
            buffer_frames: buf,
            input_channels: in_ch,
            output_channels: out_ch,
            nominal_latency_ms: nominal_ms(buf, rate),
            input_period_frames: buf,
            cushion_frames: buf,
            output_period_frames: buf,
            notes,
        },
        alive,
        last_error,
        driver_xruns,
        cushion: None,
    })
}

/// Stops the simulated device thread when the [`Running`] drops.
struct NullDevice {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for NullDevice {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// The [`NULL_HOST`] backend: one thread ticks every buffer period in real time, delivers the
/// previous output block (main pair) as the input block, then renders the next one.
fn start_null(cfg: &IoConfig) -> Result<Running, IoError> {
    let (in_ch, out_ch) = (2u16, 4u16);
    let rate = cfg.sample_rate.clamp(8_000, 192_000);
    let buf = cfg.buffer_frames.clamp(16, 4096);
    let max_block = (buf as usize * 8).max(2048);
    let Duplex {
        mut on_input,
        mut on_output,
        ends,
    } = duplex(cfg, rate, in_ch, out_ch, buf, max_block)?;
    let main = cfg.main_channels.map(|c| c as usize);
    let stop = Arc::new(AtomicBool::new(false));
    let s2 = stop.clone();
    let thread = std::thread::Builder::new()
        .name("live-null-device".into())
        .spawn(move || {
            let n = buf as usize;
            let mut out = vec![0.0f32; n * out_ch as usize];
            let mut inp = vec![0.0f32; n * in_ch as usize];
            let period = std::time::Duration::from_secs_f64(n as f64 / rate as f64);
            let mut next = Instant::now();
            while !s2.load(Ordering::SeqCst) {
                for f in 0..n {
                    inp[f * 2] = out[f * out_ch as usize + main[0]];
                    inp[f * 2 + 1] = out[f * out_ch as usize + main[1]];
                }
                on_input(&inp);
                on_output(&mut out);
                next += period;
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                } else if now - next > period * 8 {
                    next = now; // fell far behind (debugger, suspended VM): resync, no burst
                }
            }
        })
        .map_err(|e| IoError::Device(format!("null device thread: {e}")))?;
    Ok(Running::assemble(
        Box::new(NullDevice {
            stop,
            thread: Some(thread),
        }),
        ends,
        RunningInfo {
            host: NULL_HOST.into(),
            input: "Null loopback in".into(),
            output: "Null loopback out".into(),
            sample_rate: rate,
            buffer_frames: buf,
            input_channels: in_ch,
            output_channels: out_ch,
            nominal_latency_ms: nominal_ms(buf, rate),
            input_period_frames: buf,
            cushion_frames: buf,
            output_period_frames: buf,
            notes: vec!["simulated device: the main output is looped back into the input".into()],
        },
        Arc::new(AtomicBool::new(true)),
        Arc::new(Mutex::new(None)),
        Arc::new(AtomicU32::new(0)),
    ))
}

fn null_device() -> DeviceInfo {
    DeviceInfo {
        id: "null".into(),
        name: "Null loopback".into(),
        host: NULL_HOST.into(),
        input_channels: 2,
        output_channels: 4,
        default_rate: 48_000,
        is_default_input: true,
        is_default_output: true,
        voicemeeter: false,
        virtual_cable: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ProbeState, Session};
    use std::collections::VecDeque;

    /// Deterministic generator, the same sequence on every platform.
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> u32 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 33) as u32
        }

        /// Uniform in [-0.5, 0.5): below the safety ceiling, so an empty chain is the identity.
        fn sample(&mut self) -> f32 {
            self.next() as f32 / (1u64 << 31) as f32 - 0.5
        }
    }

    /// The fixed cushion, as it was before the adaptive mode existed: an irregular schedule
    /// (bursts, droughts, odd block sizes) through `duplex` must give, sample for sample, what
    /// this plain model of the old rules gives - prime at one period, underrun = xrun + re-prime,
    /// at most cushion + one block left queued - and the same output hash as the code had then.
    #[test]
    fn the_fixed_cushion_is_unchanged_sample_for_sample() {
        const P: usize = 144;
        // Hash of the output of the code before the adaptive mode (measured on it, 2026-11-12).
        const GOLDEN: u64 = 0xdf38_a1b6_96af_79f9;
        let cfg = IoConfig {
            input_channels: vec![0],
            main_channels: [0, 1],
            ..IoConfig::default()
        };
        let mut d = duplex(&cfg, 48_000, 2, 2, P as u32, 2048).unwrap();
        let mut rng = Lcg(0x5EED);
        let mut model: VecDeque<f32> = VecDeque::new();
        let (mut primed, mut model_xruns, mut model_drops) = (false, 0u32, 0u32);
        let (mut xruns, mut hash) = (0u32, 0xcbf2_9ce4_8422_2325u64);
        let mut inp = vec![0.0f32; 240 * 2];
        let mut out = vec![0.0f32; 200 * 2];
        for step in 0..6060 {
            let r = rng.next();
            // Mostly alternating, with bursts of captures and droughts; a regular tail at the
            // end so the last xrun count is published.
            let regular = step >= 6000;
            let capture = match r % 16 {
                0 if !regular => true,
                1 if !regular => false,
                _ => step % 2 == 0,
            };
            if capture {
                let n = if regular {
                    P
                } else {
                    [144, 144, 144, 48, 240][(r >> 8) as usize % 5]
                };
                for f in 0..n {
                    let v = rng.sample();
                    inp[f * 2] = v;
                    inp[f * 2 + 1] = 0.25; // channel 1 is not routed
                    model.push_back(v);
                }
                (d.on_input)(&inp[..n * 2]);
            } else {
                let n = if regular {
                    P
                } else {
                    [144, 144, 144, 96, 200][(r >> 8) as usize % 5]
                };
                (d.on_output)(&mut out[..n * 2]);
                let avail = model.len();
                if !primed {
                    primed = avail >= P;
                }
                let take = if primed { avail.min(n) } else { 0 };
                if primed && take < n {
                    model_xruns += 1;
                    primed = false;
                }
                for f in 0..n {
                    let want = if f < take {
                        model.pop_front().unwrap()
                    } else {
                        0.0
                    };
                    for c in 0..2 {
                        let got = out[f * 2 + c];
                        assert_eq!(got.to_bits(), want.to_bits(), "step {step} frame {f}");
                        hash = (hash ^ got.to_bits() as u64).wrapping_mul(0x0000_0100_0000_01b3);
                    }
                }
                let excess = model.len().saturating_sub(P + n);
                if excess > 0 {
                    model_drops += 1;
                    model.drain(..excess);
                }
            }
            while let Ok(m) = d.ends.meters.pop() {
                xruns = m.xruns;
            }
        }
        // The schedule must exercise both rules, or the comparison proves little.
        assert!(
            model_xruns > 20 && model_drops > 20,
            "{model_xruns} underruns, {model_drops} drops"
        );
        assert_eq!(xruns, model_xruns);
        assert_eq!(hash, GOLDEN, "output hash {hash:#018x}");
    }

    /// Simulated exclusive host: whole packets of `p` frames in, whole buffers of `p` frames
    /// out, no threads, no clock, event times in frames. Input channel 0 carries
    /// `signal(frame index)`; impulses in it are timed on the way in and on the way out.
    struct Sim {
        d: Duplex,
        /// None = the fixed cushion.
        stats: Option<Arc<CushionStats>>,
        p: usize,
        rate: u32,
        in_idx: usize,
        inp: Vec<f32>,
        out: Vec<f32>,
        xruns: u32,
        /// Largest sample-to-sample step seen on the output.
        max_step: f32,
        last: f32,
        /// Event time + offset in the block of every impulse captured / played.
        impulse_in: Vec<f64>,
        impulse_out: Vec<f64>,
    }

    const IMPULSE: f32 = 0.75;

    impl Sim {
        /// `margin` = Some: adaptive cushion with that margin; None: fixed cushion of one period.
        fn new(p: usize, margin: Option<u32>) -> Sim {
            Sim::at_rate(p, margin, 48_000)
        }

        fn at_rate(p: usize, margin: Option<u32>, rate: u32) -> Sim {
            let cfg = IoConfig {
                input_channels: vec![0],
                main_channels: [0, 1],
                ..IoConfig::default()
            };
            let (d, stats) = match margin {
                Some(m) => {
                    let (d, s) = duplex_adaptive(&cfg, rate, 2, 2, p as u32, m, 2048).unwrap();
                    (d, Some(s))
                }
                None => (duplex(&cfg, rate, 2, 2, p as u32, 2048).unwrap(), None),
            };
            Sim {
                d,
                stats,
                p,
                rate,
                in_idx: 0,
                inp: vec![0.0; p * 2],
                out: vec![0.0; p * 2],
                xruns: 0,
                max_step: 0.0,
                last: 0.0,
                impulse_in: Vec::with_capacity(8),
                impulse_out: Vec::with_capacity(8),
            }
        }

        /// A capture event at time `t`: the packet holds the `p` frames captured up to `t`.
        fn capture(&mut self, signal: &dyn Fn(usize) -> f32, t: f64) {
            for f in 0..self.p {
                let v = signal(self.in_idx + f);
                if v == IMPULSE {
                    self.impulse_in.push(t - self.p as f64 + f as f64);
                }
                self.inp[f * 2] = v;
                self.inp[f * 2 + 1] = 0.0;
            }
            self.in_idx += self.p;
            // The callbacks must not allocate (the crate's test allocator aborts if they do).
            assert_no_alloc::assert_no_alloc(|| (self.d.on_input)(&self.inp));
        }

        /// A render event at time `t`: frame f of the buffer is timed `t + f` (the output
        /// period and the converters come on top, the same for every case).
        fn render(&mut self, t: f64) {
            assert_no_alloc::assert_no_alloc(|| (self.d.on_output)(&mut self.out));
            for f in 0..self.p {
                let v = self.out[f * 2];
                self.max_step = self.max_step.max((v - self.last).abs());
                self.last = v;
                if v == IMPULSE {
                    self.impulse_out.push(t + f as f64);
                }
            }
            while let Ok(m) = self.d.ends.meters.pop() {
                self.xruns = m.xruns;
            }
        }

        /// Reported cushion (adaptive only).
        fn cushion(&self) -> usize {
            self.stats.as_ref().unwrap().cushion.load(Ordering::Relaxed) as usize
        }

        /// (lowered, raised).
        fn changes(&self) -> (u32, u32) {
            let s = self.stats.as_ref().unwrap();
            (
                s.lowered.load(Ordering::Relaxed),
                s.raised.load(Ordering::Relaxed),
            )
        }

        /// Frames impulse `n` waited between its capture event and the render event that
        /// played it: what the ring adds (standing frames + the phase between the two events).
        fn ring_wait(&self, n: usize) -> i64 {
            (self.impulse_out[n] - self.impulse_in[n]).round() as i64 - self.p as i64
        }

        /// Runs `seconds` of simulated audio. Capture packet i is delivered at
        /// `(i + 1) * p / (1 + ppm) + k + late(i)` frames of output time, render event j at
        /// `(j + 1) * p`: `k < 0` = capture before render each period, `k > 0` = after.
        /// `leftover` extra packets are queued before anything else (an output that started
        /// that many periods late).
        /// `at(seconds)` is called before every render event.
        #[allow(clippy::too_many_arguments)]
        fn run(
            &mut self,
            seconds: f64,
            ppm: f64,
            k: f64,
            leftover: usize,
            signal: &dyn Fn(usize) -> f32,
            late: &mut dyn FnMut(usize) -> f64,
            at: &mut dyn FnMut(&Sim, f64),
        ) {
            let p = self.p as f64;
            let rate = self.rate as f64;
            let end = seconds * rate;
            for _ in 0..leftover {
                self.capture(signal, 0.0);
            }
            let (mut i, mut j) = (0usize, 0usize);
            loop {
                let tc = (i + 1) as f64 * p / (1.0 + ppm * 1e-6) + k + late(i);
                let tr = (j + 1) as f64 * p;
                if tr > end {
                    break;
                }
                if tc <= tr {
                    self.capture(signal, tc);
                    i += 1;
                } else {
                    at(self, tr / rate);
                    self.render(tr);
                    j += 1;
                }
            }
        }
    }

    fn silence(_: usize) -> f32 {
        0.0
    }

    /// Impulses at two input frames.
    fn impulses(at: [usize; 2]) -> impl Fn(usize) -> f32 {
        move |i| if at.contains(&i) { IMPULSE } else { 0.0 }
    }

    /// The baseline the adaptive mode is measured against, on the same simulated host: the
    /// fixed cushion has nothing standing after a clean start, and keeps a whole period for
    /// good once the output started one packet late (148 = 144 standing + 4 of phase, at 1 s
    /// and still at 7 s). The adaptive cushion starts the same and is back at the phase by 7 s.
    #[test]
    fn the_fixed_cushion_keeps_a_standing_period_the_adaptive_one_removes_it() {
        let wait = |margin: Option<u32>, leftover: usize| {
            let mut sim = Sim::new(144, margin);
            sim.run(
                8.0,
                0.0,
                -4.0,
                leftover,
                &two_impulses,
                &mut |_| 0.0,
                &mut |_, _| {},
            );
            (sim.ring_wait(0), sim.ring_wait(1), sim.xruns)
        };
        assert_eq!(wait(None, 0), (4, 4, 0), "fixed, clean start");
        assert_eq!(wait(Some(0), 0), (4, 4, 0), "adaptive, clean start");
        assert_eq!(wait(None, 1), (148, 148, 0), "fixed, late output start");
        assert_eq!(wait(Some(0), 1), (148, 4, 0), "adaptive, late output start");
    }

    /// One hiccup in a session on one clock: a single packet 40 frames late at 2 s. Both
    /// cushions underrun once and re-prime with a period standing. The fixed one keeps it (148
    /// frames of wait at 30 s); the adaptive one observes for 16 s, splices it away, and the
    /// wait at 30 s is the 4 frames of phase again.
    #[test]
    fn after_one_hiccup_the_standing_period_goes_away() {
        let late_packet = 2 * 48_000 / 144;
        let wait = |margin: Option<u32>| {
            let mut sim = Sim::new(144, margin);
            sim.run(
                31.0,
                0.0,
                -4.0,
                0,
                &impulses([48_000, 30 * 48_000]),
                &mut |i| if i == late_packet { 40.0 } else { 0.0 },
                &mut |_, _| {},
            );
            (sim.ring_wait(0), sim.ring_wait(1), sim.xruns)
        };
        assert_eq!(wait(None), (4, 148, 1), "fixed");
        assert_eq!(wait(Some(0)), (4, 4, 1), "adaptive");
    }

    /// Impulses at these input frames: 1 s (before the first observation window ends) and 7 s
    /// (after a trim of up to two periods has finished).
    fn two_impulses(i: usize) -> f32 {
        if i == 48_000 || i == 7 * 48_000 {
            IMPULSE
        } else {
            0.0
        }
    }

    /// The convergence table (P = 144 frames at 48 kHz, one clock, capture k frames after the
    /// render event, negative = before). What an impulse waits between its capture event and
    /// the render event that plays it equals, to the frame, the reported cushion plus the phase
    /// between the two events - before the trim and after it. The cushion converges to the
    /// margin (0) for every k; the phase stays, it belongs to the device.
    #[test]
    fn convergence_table_same_clock() {
        const P: i64 = 144;
        let ms = |frames: i64| frames as f32 / 48.0;
        println!(
            "TABLE k | late start | phase | cushion start -> settled | ring wait start -> settled"
        );
        let mut trimmed_cases = 0;
        for leftover in [0usize, 1, 2] {
            for k in [-140i64, -72, -4, 4, 72, 140] {
                let mut sim = Sim::new(P as usize, Some(0));
                let mut c0 = 0;
                sim.run(
                    8.0,
                    0.0,
                    k as f64,
                    leftover,
                    &two_impulses,
                    &mut |_| 0.0,
                    &mut |s, t| {
                        if t < 1.0 {
                            c0 = s.cushion() as i64;
                        }
                    },
                );
                let (w0, w1, c1) = (sim.ring_wait(0), sim.ring_wait(1), sim.cushion() as i64);
                let phase = if k < 0 { -k } else { P - k };
                println!(
                    "TABLE {k:>4} | {leftover} | {phase:>3} ({:.2} ms) | {c0:>3} ({:.2} ms) -> {c1} ({:.2} ms) | {w0:>3} ({:.2} ms) -> {w1:>3} ({:.2} ms)",
                    ms(phase),
                    ms(c0),
                    ms(c1),
                    ms(w0),
                    ms(w1)
                );
                let case = format!("k={k} leftover={leftover}");
                assert_eq!(w0, c0 + phase, "start, {case}");
                assert_eq!(w1, c1 + phase, "settled, {case}");
                assert_eq!(c1, 0, "settled cushion, {case}");
                assert_eq!(sim.xruns, 0, "underruns, {case}");
                trimmed_cases += usize::from(c0 > 0);
            }
        }
        // Without cases that start with a standing period the table would prove nothing.
        assert!(
            trimmed_cases >= 9,
            "{trimmed_cases} cases had something to trim"
        );
    }

    /// A late output start leaves one packet standing: trimmed to the margin within 5 s of
    /// audio (one window + nine splices), no underrun, one lowering, no raise.
    #[test]
    fn a_standing_period_is_trimmed_within_five_seconds() {
        let mut sim = Sim::new(144, Some(0));
        let mut when = None;
        sim.run(12.0, 0.0, -4.0, 1, &silence, &mut |_| 0.0, &mut |s, t| {
            if when.is_none() && s.cushion() == 0 && t > 0.1 {
                when = Some(t);
            }
        });
        let when = when.expect("never reached the margin");
        assert!(when < 5.0, "reached the margin after {when:.2} s");
        assert_eq!((sim.cushion(), sim.xruns, sim.changes()), (0, 0, (1, 0)));
    }

    /// `margin` is a floor: a standing period over a 48-frame margin settles at 48 frames,
    /// reported and measured (48 + the 4 frames of phase).
    #[test]
    fn the_cushion_never_goes_below_the_margin() {
        let mut sim = Sim::new(144, Some(48));
        sim.run(
            8.0,
            0.0,
            -4.0,
            1,
            &two_impulses,
            &mut |_| 0.0,
            &mut |_, _| {},
        );
        assert_eq!((sim.ring_wait(0), sim.ring_wait(1)), (144 + 4, 48 + 4));
        assert_eq!((sim.cushion(), sim.xruns, sim.changes()), (48, 0, (1, 0)));
    }

    /// Runs with the capture 4 frames before the render, except the packets `is_late` names:
    /// those come 40 frames late, after the render. Returns the underruns at the end of the run
    /// and at `mark` seconds into it.
    fn underruns(
        sim: &mut Sim,
        seconds: f64,
        ppm: f64,
        is_late: &dyn Fn(usize) -> bool,
        mark: f64,
    ) -> (u32, u32) {
        let mut at_mark = None;
        sim.run(
            seconds,
            ppm,
            -4.0,
            0,
            &silence,
            &mut |i| if is_late(i) { 40.0 } else { 0.0 },
            &mut |s, t| {
                if t >= mark && at_mark.is_none() {
                    at_mark = Some(s.xruns);
                }
            },
        );
        (sim.xruns, at_mark.unwrap())
    }

    /// Capture normally 4 frames before the render; every 48th packet (7 times a second) is 40
    /// frames late and lands after the render. The first late packet underruns; the re-prime
    /// finds it and the next packet queued, so one period stands and covers every later late
    /// packet. One underrun in 60 s, and the standing period is never trimmed: every
    /// observation window sees the dips to zero.
    #[test]
    fn jitter_settles_one_period_up_without_oscillating() {
        const P: usize = 144;
        let mut sim = Sim::new(P, Some(0));
        let (total, at_1s) = underruns(&mut sim, 60.0, 0.0, &|i| i % 48 == 47, 1.0);
        assert_eq!(
            (total, at_1s),
            (1, 1),
            "underruns in 60 s / in the first second"
        );
        assert_eq!((sim.cushion(), sim.changes()), (P, (0, 1)));
    }

    /// A late packet every 30 s (rarer than the first window): the underrun at 30 s is followed
    /// by a trim, the underrun at 60 s punishes it and stretches the window to 64 s, which then
    /// always sees a dip. Two underruns in 200 s, one lowering, cushion one period.
    #[test]
    fn rare_jitter_stops_the_trimming_after_one_strike() {
        const P: usize = 144;
        let mut sim = Sim::new(P, Some(0));
        let (total, at_70s) = underruns(&mut sim, 200.0, 0.0, &|i| i % 10_000 == 9_999, 70.0);
        assert_eq!(
            (total, at_70s),
            (2, 2),
            "underruns in 200 s / in the first 70 s"
        );
        assert_eq!((sim.cushion(), sim.changes()), (P, (1, 2)));
    }

    /// Late packets at 30, 60, 140 and 420 s, each after the window that followed the previous
    /// underrun: 30 s underruns (window 16 s, trim at 46 s), 60 s punishes that trim (window
    /// 64 s, trim at 124 s), 140 s punishes the second one and latches the cushion. Without the
    /// latch the 256 s window would end at 396 s, trim again, and the packet at 420 s would
    /// underrun. Run at 8 kHz with a 24-frame period (the same 3 ms, a sixth of the samples):
    /// there the 40 frames of lateness are 5 ms, longer than a period, the late packet misses
    /// two renders, and the cushion that covers it - where it latches - is two periods.
    #[test]
    fn two_punished_trims_latch_the_cushion() {
        const P: usize = 24;
        let mut sim = Sim::at_rate(P, Some(0), 8_000);
        let late_at = [30usize, 60, 140, 420].map(|s| s * 8_000 / P);
        let (total, at_150s) = underruns(&mut sim, 430.0, 0.0, &|i| late_at.contains(&i), 150.0);
        assert_eq!(
            (total, at_150s),
            (3, 3),
            "underruns in 430 s / in the first 150 s"
        );
        assert_eq!((sim.cushion(), sim.changes()), (2 * P, (2, 3)));
    }

    /// Input clock 100 ppm fast (two devices): one packet too many every 30 s. The adaptive
    /// cushion splices each one away within two windows: no underrun in 120 s, never more than
    /// one period standing. The fixed cushion lets two periods accumulate and hard-cuts.
    #[test]
    fn fast_input_clock_is_trimmed_without_underruns() {
        const P: usize = 144;
        let mut sim = Sim::new(P, Some(0));
        let (mut max, mut sum, mut n) = (0, 0usize, 0usize);
        sim.run(
            120.0,
            100.0,
            -4.0,
            0,
            &silence,
            &mut |_| 0.0,
            &mut |s, _| {
                max = max.max(s.cushion());
                sum += s.cushion();
                n += 1;
            },
        );
        println!(
            "DRIFT +100 ppm, 120 s: underruns {}, cushion max {max}, mean {:.1} frames, lowered {}",
            sim.xruns,
            sum as f64 / n as f64,
            sim.changes().0
        );
        assert_eq!(sim.xruns, 0);
        assert_eq!(max, P, "largest standing cushion");
        assert_eq!(sim.changes(), (3, 0));
    }

    /// Input clock 100 ppm slow (two devices): one packet is missing every 30 s whatever the
    /// cushion does. The fixed cushion underruns every 30 s; the adaptive one climbs to its
    /// ceiling of three periods and then underruns every 90 s: at most 6 in 5 minutes, at most
    /// 2 in the last 2 minutes, never more than two periods standing.
    #[test]
    fn slow_input_clock_stays_bounded() {
        const P: usize = 144;
        let mut fixed = Sim::new(P, None);
        let fixed_runs = underruns(&mut fixed, 300.0, -100.0, &|_| false, 180.0);
        let mut sim = Sim::new(P, Some(0));
        let (mut max, mut at_180) = (0, None);
        sim.run(
            300.0,
            -100.0,
            -4.0,
            0,
            &silence,
            &mut |_| 0.0,
            &mut |s, t| {
                max = max.max(s.cushion());
                if t >= 180.0 && at_180.is_none() {
                    at_180 = Some(s.xruns);
                }
            },
        );
        let last = sim.xruns - at_180.unwrap();
        println!(
            "DRIFT -100 ppm, 300 s: adaptive underruns {} ({last} in the last 120 s), cushion max {max}, changes {:?}; fixed underruns {} ({} in the last 120 s)",
            sim.xruns,
            sim.changes(),
            fixed_runs.0,
            fixed_runs.0 - fixed_runs.1
        );
        assert!((9..=12).contains(&fixed_runs.0), "fixed: {fixed_runs:?}");
        assert!(
            (3..=6).contains(&sim.xruns),
            "{} underruns in 5 min",
            sim.xruns
        );
        assert!(last <= 2, "{last} underruns in the last 2 min");
        assert_eq!(max, 2 * P, "largest standing cushion");
    }

    /// A trim of one period is nine splices of 16 frames, each crossfaded over 64 frames. On a
    /// 1 kHz sine (16 frames = 120° of phase, the hard cut would jump by up to 1.73× the
    /// amplitude = 13× the sine's own steepest step) the largest sample-to-sample step of the
    /// whole run stays within 1.25× that steepest step.
    #[test]
    fn a_trim_splice_stays_below_the_bound() {
        let amp = 0.5f32;
        // 48 frames per cycle, phase from the frame index modulo 48: no precision loss late on.
        let sine = move |i: usize| amp * ((i % 48) as f32 * core::f32::consts::TAU / 48.0).sin();
        let mut sim = Sim::new(144, Some(0));
        sim.run(8.0, 0.0, -4.0, 1, &sine, &mut |_| 0.0, &mut |_, _| {});
        assert_eq!((sim.cushion(), sim.changes().0), (0, 1), "no trim happened");
        let natural = amp * core::f32::consts::TAU * 1000.0 / 48_000.0;
        assert!(
            sim.max_step <= natural * 1.25,
            "step {} vs natural {natural}",
            sim.max_step
        );
    }

    /// A bus routed to one channel carries the mono mix. It used to carry L + R: a mono
    /// microphone came out 6 dB hotter on `--main 8` than on `--main 8,9`.
    #[test]
    fn a_pair_routed_to_one_channel_is_not_doubled() {
        let run = |main: [u16; 2]| {
            let cfg = IoConfig {
                input_channels: vec![0],
                main_channels: main,
                ..IoConfig::default()
            };
            // Cushion 0: the input of a block is queued before its output is rendered.
            let mut d = duplex(&cfg, 48_000, 2, 4, 0, 2048).unwrap();
            let input: Vec<f32> = (0..256).flat_map(|_| [0.25f32, 0.0]).collect();
            let mut out = vec![0.0f32; 256 * 4];
            for _ in 0..8 {
                (d.on_input)(&input);
                (d.on_output)(&mut out);
            }
            let peak = |c: usize| out.chunks(4).map(|f| f[c].abs()).fold(0.0f32, f32::max);
            [peak(0), peak(1), peak(2), peak(3)]
        };
        let mono = run([2, 2]);
        assert!((mono[2] - 0.25).abs() < 1e-4, "{mono:?}");
        assert!(
            mono[0] == 0.0 && mono[1] == 0.0 && mono[3] == 0.0,
            "{mono:?}"
        );
        let stereo = run([2, 3]);
        assert!(
            (stereo[2] - 0.25).abs() < 1e-4 && (stereo[3] - 0.25).abs() < 1e-4,
            "{stereo:?}"
        );
    }

    #[test]
    fn classify_names() {
        assert_eq!(
            classify("Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)"),
            (true, false)
        );
        assert_eq!(
            classify("CABLE Input (VB-Audio Virtual Cable)"),
            (true, true)
        );
        assert_eq!(classify("BlackHole 2ch"), (false, true));
        assert_eq!(classify("Audio Interface IN (2- HD-II)"), (false, false));
    }

    /// Only the exclusive host with equal periods adapts, and the switch turns it off.
    #[test]
    fn the_adaptive_cushion_is_for_the_exclusive_host_with_equal_periods() {
        assert!(wants_adaptive(true, 144, 144, false));
        assert!(!wants_adaptive(false, 144, 144, false), "shared host");
        assert!(!wants_adaptive(true, 480, 144, false), "unequal periods");
        assert!(!wants_adaptive(true, 144, 144, true), "switched off");
        let forced = |v: Option<&str>| fixed_cushion_forced(v.map(std::ffi::OsStr::new));
        assert!(forced(Some("1")) && forced(Some("true")));
        assert!(!forced(None) && !forced(Some("")) && !forced(Some("0")));
    }

    /// `Running` reports the live cushion of an adaptive stream and the configured one of a
    /// fixed stream, without touching the audio side.
    #[test]
    fn running_reports_the_live_cushion() {
        const P: usize = 144;
        let info = |cushion: u32| RunningInfo {
            host: "test".into(),
            input: "in".into(),
            output: "out".into(),
            sample_rate: 48_000,
            buffer_frames: P as u32,
            input_channels: 2,
            output_channels: 2,
            nominal_latency_ms: 9.0,
            input_period_frames: P as u32,
            cushion_frames: cushion,
            output_period_frames: P as u32,
            notes: Vec::new(),
        };
        let mut sim = Sim::new(P, Some(0));
        let stats = sim.stats.clone().unwrap();
        let (_, ends) = plumbing(48_000, 64);
        let running = Running {
            cushion: Some(stats),
            ..Running::assemble(
                Box::new(()),
                ends,
                info(P as u32),
                Arc::new(AtomicBool::new(true)),
                Arc::new(Mutex::new(None)),
                Arc::new(AtomicU32::new(0)),
            )
        };
        // Before the first block: the start value, as in `info`.
        assert_eq!(
            (running.cushion_frames(), running.cushion_adaptive()),
            (P as u32, true)
        );
        let mut seen = Vec::new();
        sim.run(8.0, 0.0, -4.0, 1, &silence, &mut |_| 0.0, &mut |_, t| {
            if seen.len() < (t / 2.0) as usize + 1 {
                seen.push(running.cushion_frames());
            }
        });
        // One period standing for the first window (4 s), then trimmed away.
        assert_eq!(seen, [144, 144, 144, 0], "every 2 s");
        assert_eq!(running.cushion_changes(), (1, 0));
        assert_eq!(
            running.info.cushion_frames, P as u32,
            "info keeps the start value"
        );

        let (_, ends) = plumbing(48_000, 64);
        let fixed = Running::assemble(
            Box::new(()),
            ends,
            info(96),
            Arc::new(AtomicBool::new(true)),
            Arc::new(Mutex::new(None)),
            Arc::new(AtomicU32::new(0)),
        );
        assert_eq!(
            (
                fixed.cushion_frames(),
                fixed.cushion_adaptive(),
                fixed.cushion_changes()
            ),
            (96, false, (0, 0))
        );
    }

    fn null_cfg(buf: u32) -> IoConfig {
        IoConfig {
            host: Some(NULL_HOST.into()),
            buffer_frames: buf,
            ..IoConfig::default()
        }
    }

    #[test]
    fn null_host_lists_one_loopback_device() {
        let d = list_devices(Some("null")).unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].host, NULL_HOST);
    }

    #[cfg(windows)]
    #[test]
    fn native_wasapi_hosts_are_offered_and_label_their_devices() {
        let h = hosts();
        assert!(h.iter().any(|x| x == WASAPI_EXCLUSIVE));
        assert!(h.iter().any(|x| x == WASAPI_LOW_LATENCY));
        assert_eq!(
            native_mode(Some("wasapi exclusive")),
            Some(crate::wasapi::Mode::Exclusive)
        );
        assert_eq!(native_mode(Some("WASAPI")), None);
        // Machines without an audio service (CI) return an error or an empty list: both fine.
        if let Ok(devices) = list_devices(Some("wasapi low latency")) {
            assert!(devices.iter().all(|d| d.host == WASAPI_LOW_LATENCY));
        }
    }

    #[cfg(windows)]
    #[test]
    fn native_host_reports_a_missing_device() {
        let cfg = IoConfig {
            host: Some(WASAPI_EXCLUSIVE.into()),
            input: Some("no such microphone".into()),
            output: Some("no such speaker".into()),
            ..IoConfig::default()
        };
        // The message proves the native path looked the device up: without the native dispatch
        // the error would name the unknown host instead.
        match start(&cfg) {
            Err(IoError::NotFound(m)) => assert!(m.contains("no such microphone"), "{m}"),
            Err(IoError::Device(_)) => {} // no audio service on this machine
            Err(e) => panic!("unexpected error: {e}"),
            Ok(_) => panic!("started without devices"),
        }
    }

    #[test]
    fn null_loopback_measures_the_simulated_round_trip() {
        assert_no_alloc::permit_alloc(|| {
            let buf = 64;
            let mut r = start(&null_cfg(buf)).unwrap();
            assert!(r.alive());
            let mut s = Session::new(48_000.0, buf as usize * 8);
            r.send(s.load_preset("Natural Vocal").unwrap())
                .ok()
                .unwrap();
            for c in s.set_mix(|m| m.mute = true) {
                r.send(c).ok().unwrap();
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
            r.send(Command::StartLatencyProbe).ok().unwrap();
            let t0 = Instant::now();
            let ms = loop {
                std::thread::sleep(std::time::Duration::from_millis(20));
                if let Some(m) = r.poll() {
                    match m.latency_probe {
                        ProbeState::Done(ms) => break ms,
                        ProbeState::Failed => panic!("probe failed on a perfect loopback"),
                        _ => {}
                    }
                }
                assert!(t0.elapsed().as_secs() < 10, "probe timed out");
            };
            // One block of loopback + the input ring target (one block) + <=1 block of phase.
            let block_ms = buf as f32 / 48.0;
            assert!(
                ms >= block_ms && ms <= block_ms * 4.0,
                "round trip {ms} ms outside [{block_ms}, {}]",
                block_ms * 4.0
            );
        });
    }

    #[test]
    fn null_host_rejects_impossible_routing() {
        let cfg = IoConfig {
            main_channels: [6, 7],
            ..null_cfg(64)
        };
        assert!(matches!(start(&cfg), Err(IoError::Config(_))));
    }
}
