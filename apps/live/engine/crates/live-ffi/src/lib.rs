//! # live-ffi — UniFFI surface of the MixAI Live engine (ADR-0015, tracker WP21-06)
//!
//! Runs the SAME engine as the desktop sidecar on a phone or tablet, as a backup processor when
//! no PC is around: device I/O (cpal → AAudio on Android, CoreAudio/AVAudioSession on iOS), the
//! realtime core, the control [`Session`](live_engine::Session) and the protocol v1 server
//! ([`EngineHost`]). The native apps then talk to it exactly like to a PC engine: their existing
//! WebSocket client connects to `127.0.0.1:<port>` with the controller token from
//! [`EngineReady`], so every screen (perform, chain, setlist, MIDI) works unchanged. A LAN bind
//! additionally lets a second phone or the watch control the phone engine.
//!
//! Conventions (same as `decks-ffi`): proc-macro UniFFI, polling instead of callbacks, objects are
//! `Send + Sync` behind one `Mutex`, the audio callback stays on the engine's own threads, and
//! every failure is one [`LiveError`] (field `reason`, never `message`: Kotlin exceptions own
//! `Throwable.message`). Documentation: `docs/live/ffi.md`.

#[cfg(target_os = "android")]
mod android;

use live_engine::{Control, IoConfig, ProbeState, Store, io};
use live_remote::{ControlError, ControlHandle, EngineHost, HostConfig, HostError};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

uniffi::setup_scaffolding!();

/// Every error the Live FFI can return.
#[derive(Debug, thiserror::Error, uniffi::Error, PartialEq)]
pub enum LiveError {
    /// An argument is out of range or malformed (bad JSON control, unknown field).
    #[error("invalid argument: {reason}")]
    InvalidArgument { reason: String },
    /// Audio device / stream failure (permission missing, device busy, unsupported format).
    #[error("audio: {reason}")]
    Audio { reason: String },
    /// The engine is stopped (after `stop()` or a fatal stream error).
    #[error("engine not running: {reason}")]
    NotRunning { reason: String },
    /// The session refused a control (unknown preset / insert / parameter...).
    #[error("{code}: {reason}")]
    Control { code: String, reason: String },
    /// The latency probe heard no click (no loopback) or timed out.
    #[error("latency: {reason}")]
    Latency { reason: String },
    /// The start-up preset does not exist.
    #[error("preset: {reason}")]
    Preset { reason: String },
    /// The control server could not listen (port in use).
    #[error("server: {reason}")]
    Server { reason: String },
    /// Too many commands queued: the audio callback is not running (stream paused, audio focus lost).
    #[error("busy: {reason}")]
    Busy { reason: String },
}

impl From<HostError> for LiveError {
    fn from(e: HostError) -> Self {
        match e {
            HostError::Audio(reason) => LiveError::Audio { reason },
            HostError::Preset(reason) => LiveError::Preset { reason },
            HostError::Server(reason) => LiveError::Server { reason },
        }
    }
}

impl From<ControlError> for LiveError {
    fn from(e: ControlError) -> Self {
        let reason = e.to_string();
        match e {
            ControlError::Session { code, message } => LiveError::Control {
                code: code.into(),
                reason: message,
            },
            ControlError::Busy => LiveError::Busy { reason },
            ControlError::Stopped | ControlError::Timeout => LiveError::NotRunning { reason },
        }
    }
}

/// How to start a phone engine.
#[derive(Clone, Debug, uniffi::Record)]
pub struct LocalEngineConfig {
    #[uniffi(default = 48000)]
    pub sample_rate: u32,
    /// Frames per callback. Phones: 96–256 (AAudio rounds to its burst size).
    #[uniffi(default = 192)]
    pub buffer_frames: u32,
    #[uniffi(default = "Natural Vocal")]
    pub preset: String,
    /// Listen on every interface + announce over mDNS so other devices can control this engine.
    /// false = loopback only (just this app).
    #[uniffi(default = false)]
    pub lan: bool,
    /// 0 = any free port.
    #[uniffi(default = 0)]
    pub port: u16,
    #[uniffi(default = "MixAI Live (phone)")]
    pub name: String,
    /// Where user presets, the setlist and MIDI bindings are kept (None = memory only).
    #[uniffi(default = None)]
    pub data_dir: Option<String>,
    /// Start with every output muted: a phone speaker next to its own mic howls.
    #[uniffi(default = true)]
    pub start_muted: bool,
    /// Audio host name (None = platform default: AAudio / CoreAudio). "Null" = simulated loopback
    /// device without hardware (tests, CI, the store reviewer's emulator).
    #[uniffi(default = None)]
    pub audio_host: Option<String>,
    /// Device ids from [`live_devices`] (None = system default).
    #[uniffi(default = None)]
    pub input_device: Option<String>,
    #[uniffi(default = None)]
    pub output_device: Option<String>,
}

impl Default for LocalEngineConfig {
    fn default() -> Self {
        Self {
            sample_rate: 48_000,
            buffer_frames: 192,
            preset: "Natural Vocal".into(),
            lan: false,
            port: 0,
            name: "MixAI Live (phone)".into(),
            data_dir: None,
            start_muted: true,
            audio_host: None,
            input_device: None,
            output_device: None,
        }
    }
}

/// Where and how to connect to a started engine (protocol v1, `docs/live/remote-protocol.md`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct EngineReady {
    /// Host to connect to from this device: always 127.0.0.1 (the server listens there too).
    pub local_host: String,
    /// Address other devices use (LAN IP when `lan`, else 127.0.0.1).
    pub lan_host: String,
    pub port: u16,
    pub osc_port: Option<u16>,
    pub controller_token: String,
    pub controller_url: String,
    pub performer_url: String,
    pub viewer_url: String,
    pub audio_host: String,
    pub input: String,
    pub output: String,
    pub sample_rate: u32,
    pub buffer_frames: u32,
    /// Theoretical in→out latency from buffer sizes; [`LiveEngine::measure_latency`] measures.
    pub nominal_latency_ms: f32,
    pub notes: Vec<String>,
    pub warnings: Vec<String>,
}

/// Telemetry snapshot (~30 Hz). Linear peak/RMS values (0..1+).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct LiveMeters {
    pub in_peak: f32,
    pub in_rms: f32,
    pub out_peak_l: f32,
    pub out_peak_r: f32,
    pub dsp_load: f32,
    pub dsp_load_max: f32,
    /// Engine ring underruns.
    pub xruns: u32,
    /// Xruns reported by the audio driver.
    pub driver_xruns: u32,
    pub clipped: bool,
    pub chain_latency_samples: u32,
    /// Detected input pitch as a fractional MIDI note (None when no pitch / no tuner).
    pub tune_midi: Option<f32>,
    /// "idle" | "running" | "done" | "failed".
    pub probe: String,
    pub probe_ms: Option<f32>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct LatencyResult {
    /// Measured in→out→in round trip (median of 5 clicks).
    pub round_trip_ms: f32,
    pub nominal_ms: f32,
    pub chain_latency_samples: u32,
    pub sample_rate: u32,
    pub buffer_frames: u32,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct LiveDevice {
    pub id: String,
    pub name: String,
    pub host: String,
    pub input_channels: u16,
    pub output_channels: u16,
    pub default_rate: u32,
    pub is_default_input: bool,
    pub is_default_output: bool,
}

fn audio(e: impl std::fmt::Display) -> LiveError {
    LiveError::Audio {
        reason: e.to_string(),
    }
}

/// Audio hosts available on this platform ("Null", the simulated loopback, is accepted but not listed).
#[uniffi::export]
pub fn live_hosts() -> Vec<String> {
    io::hosts()
}

/// Input/output devices of a host (None = default host).
#[uniffi::export]
pub fn live_devices(audio_host: Option<String>) -> Result<Vec<LiveDevice>, LiveError> {
    Ok(io::list_devices(audio_host.as_deref())
        .map_err(audio)?
        .into_iter()
        .map(|d| LiveDevice {
            id: d.id,
            name: d.name,
            host: d.host,
            input_channels: d.input_channels,
            output_channels: d.output_channels,
            default_rate: d.default_rate,
            is_default_input: d.is_default_input,
            is_default_output: d.is_default_output,
        })
        .collect())
}

/// Names of the built-in presets.
#[uniffi::export]
pub fn live_factory_presets() -> Vec<String> {
    live_engine::factory().into_iter().map(|p| p.name).collect()
}

#[uniffi::export]
pub fn live_protocol_version() -> u32 {
    live_remote::PROTOCOL_VERSION
}

#[uniffi::export]
pub fn live_version() -> String {
    env!("CARGO_PKG_VERSION").into()
}

/// A running phone engine. Drop or [`stop`](Self::stop) releases the audio devices.
#[derive(uniffi::Object)]
pub struct LiveEngine {
    host: Mutex<Option<EngineHost>>,
    /// Sends controls without holding `host` (a control can wait up to 2 s for the control thread).
    controls: ControlHandle,
    ready: EngineReady,
}

impl LiveEngine {
    fn lock(&self) -> MutexGuard<'_, Option<EngineHost>> {
        self.host.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn with<T>(&self, f: impl FnOnce(&EngineHost) -> T) -> Result<T, LiveError> {
        let g = self.lock();
        match g.as_ref() {
            Some(h) if h.alive() => Ok(f(h)),
            Some(h) => Err(LiveError::NotRunning {
                reason: h.error().unwrap_or_else(|| "engine stopped".into()),
            }),
            None => Err(LiveError::NotRunning {
                reason: "stopped".into(),
            }),
        }
    }
}

#[uniffi::export]
impl LiveEngine {
    /// Open the audio devices, load the preset and start the control server. Needs the
    /// microphone permission (RECORD_AUDIO / NSMicrophoneUsageDescription) granted first.
    #[uniffi::constructor]
    pub fn start(config: LocalEngineConfig) -> Result<Arc<Self>, LiveError> {
        if !(8_000..=192_000).contains(&config.sample_rate) {
            return Err(LiveError::InvalidArgument {
                reason: format!("sample rate {} out of range", config.sample_rate),
            });
        }
        if !(16..=4096).contains(&config.buffer_frames) {
            return Err(LiveError::InvalidArgument {
                reason: format!("buffer {} frames out of range", config.buffer_frames),
            });
        }
        let bind = if config.lan {
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        } else {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        };
        let host = EngineHost::start(HostConfig {
            io: IoConfig {
                host: config.audio_host.clone(),
                input: config.input_device.clone(),
                output: config.output_device.clone(),
                sample_rate: config.sample_rate,
                buffer_frames: config.buffer_frames,
                // Phone mics are mono; the main bus goes to the first output pair (speaker or
                // headphones / USB interface).
                input_channels: vec![0],
                main_channels: [0, 1],
                monitor_channels: None,
            },
            preset: config.preset.clone(),
            bind,
            port: config.port,
            name: config.name.clone(),
            announce: config.lan,
            // No OSC on phones: nothing there sends it, and an open UDP port is one more surface.
            osc: false,
            store: config.data_dir.as_ref().map(Store::new),
            start_muted: config.start_muted,
            midi: None,
        })?;
        let r = host.ready();
        let ready = EngineReady {
            local_host: "127.0.0.1".into(),
            lan_host: r.host.to_string(),
            port: r.port,
            osc_port: r.osc_port,
            controller_token: r.controller_token.clone(),
            controller_url: r.controller_url.clone(),
            performer_url: r.performer_url.clone(),
            viewer_url: r.viewer_url.clone(),
            audio_host: r.info.host.clone(),
            input: r.info.input.clone(),
            output: r.info.output.clone(),
            sample_rate: r.info.sample_rate,
            buffer_frames: r.info.buffer_frames,
            nominal_latency_ms: r.info.nominal_latency_ms,
            notes: r.info.notes.clone(),
            warnings: r.warnings.clone(),
        };
        Ok(Arc::new(Self {
            controls: host.handle(),
            host: Mutex::new(Some(host)),
            ready,
        }))
    }

    pub fn ready(&self) -> EngineReady {
        self.ready.clone()
    }

    pub fn alive(&self) -> bool {
        self.lock().as_ref().is_some_and(EngineHost::alive)
    }

    /// Why the engine stopped by itself (device removed, driver reset...).
    pub fn error(&self) -> Option<String> {
        self.lock().as_ref().and_then(EngineHost::error)
    }

    /// Current `SessionState` as JSON (the protocol's `state.state` object).
    pub fn state_json(&self) -> Result<String, LiveError> {
        self.with(EngineHost::state_json)
    }

    pub fn meters(&self) -> Result<Option<LiveMeters>, LiveError> {
        self.with(|h| {
            h.meters().map(|m| {
                let (probe, probe_ms) = match m.latency_probe {
                    ProbeState::Idle => ("idle", None),
                    ProbeState::Running => ("running", None),
                    ProbeState::Done(ms) => ("done", Some(ms)),
                    ProbeState::Failed => ("failed", None),
                };
                LiveMeters {
                    in_peak: m.in_peak,
                    in_rms: m.in_rms,
                    out_peak_l: m.out_peak[0],
                    out_peak_r: m.out_peak[1],
                    dsp_load: m.dsp_load,
                    dsp_load_max: m.dsp_load_max,
                    xruns: m.xruns,
                    driver_xruns: h.driver_xruns(),
                    clipped: m.clipped,
                    chain_latency_samples: m.chain_latency_samples,
                    tune_midi: m
                        .tune
                        .map(|t| t.input.midi)
                        .filter(|v| v.is_finite() && *v > 0.0),
                    probe: probe.into(),
                    probe_ms,
                }
            })
        })
    }

    /// Apply one protocol v1 client control (`{"type":"set_mix","mute":false}` ...) in-process.
    pub fn control_json(&self, json: String) -> Result<(), LiveError> {
        let c: Control = serde_json::from_str(&json).map_err(|e| LiveError::InvalidArgument {
            reason: e.to_string(),
        })?;
        self.control(c)
    }

    pub fn set_mute(&self, mute: bool) -> Result<(), LiveError> {
        self.control(Control::SetMix {
            input_db: None,
            main_db: None,
            monitor_db: None,
            monitor_dry: None,
            bypass: None,
            mute: Some(mute),
        })
    }

    pub fn load_preset(&self, name: String) -> Result<(), LiveError> {
        self.control(Control::LoadPreset { name })
    }

    pub fn panic(&self) -> Result<(), LiveError> {
        self.control(Control::Panic)
    }

    /// Play a click train and listen for it (blocks up to `timeout_ms`). Needs a loopback: on a
    /// phone the speaker → mic path (volume up, quiet room) or a cable from the headphone out to
    /// the mic in. Clicks go out even while muted.
    pub fn measure_latency(&self, timeout_ms: u32) -> Result<LatencyResult, LiveError> {
        self.control(Control::LatencyProbe)?;
        let t0 = Instant::now();
        let limit = Duration::from_millis(timeout_ms.clamp(2_500, 30_000) as u64);
        let mut seen_running = false;
        loop {
            std::thread::sleep(Duration::from_millis(15));
            let m = self.with(EngineHost::meters)?;
            if let Some(m) = m {
                match m.latency_probe {
                    ProbeState::Running => seen_running = true,
                    ProbeState::Done(ms) if seen_running => {
                        return Ok(LatencyResult {
                            round_trip_ms: ms,
                            nominal_ms: self.ready.nominal_latency_ms,
                            chain_latency_samples: m.chain_latency_samples,
                            sample_rate: self.ready.sample_rate,
                            buffer_frames: self.ready.buffer_frames,
                        });
                    }
                    ProbeState::Failed if seen_running => {
                        return Err(LiveError::Latency {
                            reason: "no click came back: raise the volume or connect the output to the input".into(),
                        });
                    }
                    _ => {}
                }
            }
            if t0.elapsed() > limit {
                return Err(LiveError::Latency {
                    reason: "probe timed out".into(),
                });
            }
        }
    }

    /// Release the audio devices and close the server. Idempotent.
    pub fn stop(&self) {
        let h = self.lock().take();
        drop(h);
    }
}

impl LiveEngine {
    fn control(&self, c: Control) -> Result<(), LiveError> {
        if !self.alive() {
            return Err(LiveError::NotRunning {
                reason: self.error().unwrap_or_else(|| "stopped".into()),
            });
        }
        Ok(self.controls.control(c)?)
    }
}
