//! Device I/O over cpal: an input stream feeds a lock-free ring, the output stream pulls from it,
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
    /// cpal host name (e.g. "ASIO", "WASAPI", "CoreAudio", "JACK"); None = default host.
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

/// Real audio hosts. The simulated [`NULL_HOST`] is not listed (device pickers must not offer it); tests and
/// CI select it by name.
pub fn hosts() -> Vec<String> {
    cpal::available_hosts()
        .into_iter()
        .map(|h| h.name().to_string())
        .collect()
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
    let h = host_named(host)?;
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
            host: h.id().name().to_string(),
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
    pub notes: Vec<String>,
}

impl Running {
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
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

struct Ends {
    commands: rtrb::Producer<Command>,
    garbage: rtrb::Consumer<Garbage>,
    meters: rtrb::Consumer<Meters>,
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
    buf: u32,
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
    let target = buf as usize * 2; // samples (L+R) in the ring before we start pulling
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
        for f in 0..frames {
            let o = f * ch;
            data[o + main[0]] += ml[f];
            data[o + main[1]] += mr[f];
            if let Some([a, b]) = mon {
                data[o + a] += ol[f];
                data[o + b] += or[f];
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

/// Open input + output and start processing. Load a preset with a `SwapChain` command after.
pub fn start(cfg: &IoConfig) -> Result<Running, IoError> {
    if is_null(cfg.host.as_deref()) {
        return start_null(cfg);
    }
    let host = host_named(cfg.host.as_deref())?;
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
        return Err(IoError::Config("device offers no f32 stream format".into()));
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
    let input = indev
        .build_input_stream(
            in_conf,
            move |data: &[f32], _| on_input(data),
            move |e| on_error("input", e, &in_err_alive, &in_err_text, &in_xr),
            None,
        )
        .map_err(|e| IoError::Device(format!("input stream: {e}")))?;

    let main = cfg.main_channels.map(|c| c as usize);
    let mon = cfg.monitor_channels.map(|m| m.map(|c| c as usize));
    let mut on_output = output_callback(out_ch, buf, max_block, main, mon, p);
    let out_err_alive = alive.clone();
    let out_err_text = last_error.clone();
    let out_xr = driver_xruns.clone();
    let output = outdev
        .build_output_stream(
            out_conf,
            move |data: &mut [f32], _| on_output(data),
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
            notes,
        },
        alive,
        last_error,
        driver_xruns,
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
    check_routing(cfg, in_ch, out_ch)?;
    let rate = cfg.sample_rate.clamp(8_000, 192_000);
    let buf = cfg.buffer_frames.clamp(16, 4096);
    let max_block = (buf as usize * 8).max(2048);
    let (mut p, ends) = plumbing(rate, max_block);
    let in_tx = std::mem::replace(&mut p.in_tx, rtrb::RingBuffer::new(1).0);
    let mut on_input = input_callback(in_ch, cfg.input_channels.clone(), in_tx);
    let main = cfg.main_channels.map(|c| c as usize);
    let mon = cfg.monitor_channels.map(|m| m.map(|c| c as usize));
    let mut on_output = output_callback(out_ch, buf, max_block, main, mon, p);
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
    Ok(Running {
        _streams: Box::new(NullDevice {
            stop,
            thread: Some(thread),
        }),
        commands: ends.commands,
        garbage: ends.garbage,
        meters: ends.meters,
        info: RunningInfo {
            host: NULL_HOST.into(),
            input: "Null loopback in".into(),
            output: "Null loopback out".into(),
            sample_rate: rate,
            buffer_frames: buf,
            input_channels: in_ch,
            output_channels: out_ch,
            nominal_latency_ms: nominal_ms(buf, rate),
            notes: vec!["simulated device: the main output is looped back into the input".into()],
        },
        alive: Arc::new(AtomicBool::new(true)),
        last_error: Arc::new(Mutex::new(None)),
        driver_xruns: Arc::new(AtomicU32::new(0)),
    })
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
