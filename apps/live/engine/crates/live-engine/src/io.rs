//! Device I/O over cpal: an input stream feeds a lock-free ring, the output stream pulls from it,
//! runs [`Core`] and writes the main + monitor buses to the chosen output channels.
//!
//! Processing happens in the OUTPUT callback so the in→out path costs one input period plus the
//! ring target (one block) plus one output period. Ring fill is held near the target: overfill
//! (clock drift) drops frames with a short fade, underfill counts an xrun and plays the last
//! block faded out instead of a click.

use crate::core::{Buses, Command, Core, Garbage, Meters};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleFormat, Stream, StreamConfig};
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
    _input: Stream,
    _output: Stream,
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

/// Open input + output and start processing. `core` arrives preconfigured (chain loaded).
pub fn start(cfg: &IoConfig) -> Result<Running, IoError> {
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
    let max_ch_needed = cfg
        .monitor_channels
        .map_or(cfg.main_channels[1], |m| m[1].max(cfg.main_channels[1]))
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
    let mut core = Core::new(rate as f32, max_block);

    let (mut cmd_tx, mut cmd_rx) = rtrb::RingBuffer::<Command>::new(1024);
    let (mut gar_tx, gar_rx) = rtrb::RingBuffer::<Garbage>::new(256);
    let (mut met_tx, met_rx) = rtrb::RingBuffer::<Meters>::new(64);
    let _ = &mut cmd_tx;
    // Mono-or-stereo input ring, interleaved L/R, ~170 ms of capacity.
    let (mut in_tx, mut in_rx) =
        rtrb::RingBuffer::<f32>::new((rate as usize / 6).next_power_of_two() * 2);
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

    let sel = cfg.input_channels.clone();
    let in_err_alive = alive.clone();
    let in_err_text = last_error.clone();
    let in_xr = driver_xruns.clone();
    let input = indev
        .build_input_stream(
            in_conf,
            move |data: &[f32], _| {
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
            },
            move |e| on_error("input", e, &in_err_alive, &in_err_text, &in_xr),
            None,
        )
        .map_err(|e| IoError::Device(format!("input stream: {e}")))?;

    let main = cfg.main_channels.map(|c| c as usize);
    let mon = cfg.monitor_channels.map(|m| m.map(|c| c as usize));
    let target = buf as usize * 2; // samples (L+R) in the ring before we start pulling
    let mut scratch: [Vec<f32>; 6] = core::array::from_fn(|_| vec![0.0; max_block]);
    let mut primed = false;
    let out_err_alive = alive.clone();
    let out_err_text = last_error.clone();
    let out_xr = driver_xruns.clone();
    let output = outdev
        .build_output_stream(
            out_conf,
            move |data: &mut [f32], _| {
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
    let nominal = (buf as f32 * 2.0 + target as f32 / 2.0) / rate as f32 * 1000.0;
    Ok(Running {
        _input: input,
        _output: output,
        commands: cmd_tx,
        garbage: gar_rx,
        meters: met_rx,
        info: RunningInfo {
            host: host.id().name().to_string(),
            input: dev_name(&indev),
            output: dev_name(&outdev),
            sample_rate: rate,
            buffer_frames: buf,
            input_channels: in_ch,
            output_channels: out_ch,
            nominal_latency_ms: nominal,
            notes,
        },
        alive,
        last_error,
        driver_xruns,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
