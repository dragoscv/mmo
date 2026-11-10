//! Engine host: the audio streams, the control [`Session`] and the protocol v1 [`RemoteServer`]
//! on one control thread. Shared by the headless binary (`mixai-live-engine serve`) and the
//! mobile FFI (`live-ffi`, phone as a backup processor), so every surface runs the same loop:
//!
//! 1. retry engine commands that did not fit the command ring last tick;
//! 2. drain remote controls + direct (in-process) controls, apply them, collect replies;
//! 3. feed MIDI bytes;
//! 4. publish state when the revision moved, then the acks (a client seeing `ack` has the state);
//! 5. publish meters, watch the stream health.
//!
//! The streams are opened INSIDE the control thread and never leave it, so the host does not
//! depend on `cpal::Stream` being `Send` on every platform.

use crate::{RemoteConfig, RemoteServer, discovery::Announcer, meters_json, server_error_code};
use live_engine::{Command, Control, IoConfig, Meters, Role, RunningInfo, Session, Store, io};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const TICK: Duration = Duration::from_millis(5);
/// Engine commands waiting for room in the command ring. Past this the audio callback is not running (stream
/// paused, audio focus lost): new controls are refused with `engine_busy` instead of growing without bound.
pub const MAX_PENDING_COMMANDS: usize = 1024;

/// Why [`EngineHost::start`] failed.
#[derive(Debug, Clone, PartialEq)]
pub enum HostError {
    /// Audio device / stream (permission, busy device, unsupported format).
    Audio(String),
    /// The start-up preset does not exist.
    Preset(String),
    /// The control server could not listen.
    Server(String),
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostError::Audio(s) | HostError::Preset(s) | HostError::Server(s) => f.write_str(s),
        }
    }
}

/// Why an in-process control was not applied.
#[derive(Debug, Clone, PartialEq)]
pub enum ControlError {
    /// The session refused it: protocol error code (`unknown_preset`, `chain_full`...) + message.
    Session { code: &'static str, message: String },
    /// Too many engine commands queued (the audio callback is not running).
    Busy,
    /// The host stopped.
    Stopped,
    /// The control thread did not answer within 2 s.
    Timeout,
}

impl std::fmt::Display for ControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ControlError::Session { message, .. } => f.write_str(message),
            ControlError::Busy => f.write_str("engine busy: audio is not running"),
            ControlError::Stopped => f.write_str("engine stopped"),
            ControlError::Timeout => f.write_str("engine did not answer"),
        }
    }
}

pub struct HostConfig {
    pub io: IoConfig,
    pub preset: String,
    /// Loopback = only this device (desktop shell, the phone's own UI); unspecified = LAN.
    pub bind: IpAddr,
    /// 0 = any free port.
    pub port: u16,
    pub name: String,
    /// Announce `_mixai-live._tcp` over mDNS (only meaningful with a LAN bind).
    pub announce: bool,
    pub osc: bool,
    pub store: Option<Store>,
    /// Start with every output muted (phones: the speaker next to the mic would howl).
    pub start_muted: bool,
    /// Raw MIDI messages from input ports the caller opened, plus their names for the UI.
    pub midi: Option<(Vec<String>, Receiver<Vec<u8>>)>,
}

impl Default for HostConfig {
    fn default() -> Self {
        Self {
            io: IoConfig::default(),
            preset: "Natural Vocal".into(),
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 0,
            name: "MixAI Live".into(),
            announce: false,
            osc: true,
            store: None,
            start_muted: false,
            midi: None,
        }
    }
}

/// What a client needs to connect, sent once the streams and the server are up.
#[derive(Clone, Debug, PartialEq)]
pub struct HostReady {
    pub info: RunningInfo,
    pub port: u16,
    pub osc_port: Option<u16>,
    /// Host advertised in the pairing URLs (LAN IP, or 127.0.0.1 for a loopback bind).
    pub host: IpAddr,
    pub controller_token: String,
    pub controller_url: String,
    pub performer_url: String,
    pub viewer_url: String,
    /// Non-fatal start-up problems (unreadable user presets, mDNS failure).
    pub warnings: Vec<String>,
}

#[derive(Default)]
struct Shared {
    state_json: String,
    meters: Option<Meters>,
    error: Option<String>,
    driver_xruns: u32,
}

type Direct = (Control, SyncSender<Result<(), ControlError>>);

/// Cheap, cloneable sender for in-process controls (use it without holding a lock on the host).
#[derive(Clone)]
pub struct ControlHandle {
    tx: SyncSender<Direct>,
}

impl ControlHandle {
    /// Apply a control in-process (no WebSocket) and wait for the session's verdict.
    pub fn control(&self, c: Control) -> Result<(), ControlError> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.tx.send((c, tx)).map_err(|_| ControlError::Stopped)?;
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(r) => r,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(ControlError::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(ControlError::Stopped),
        }
    }
}

pub struct EngineHost {
    ready: HostReady,
    stop: Arc<AtomicBool>,
    shared: Arc<Mutex<Shared>>,
    direct: SyncSender<Direct>,
    thread: Option<JoinHandle<()>>,
}

fn lock(m: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl EngineHost {
    /// Open the devices, load the preset, start the server; returns once audio runs.
    pub fn start(cfg: HostConfig) -> Result<Self, HostError> {
        let stop = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Mutex::new(Shared::default()));
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<HostReady, HostError>>(1);
        let (direct_tx, direct_rx) = mpsc::sync_channel::<Direct>(64);
        let (s2, sh2) = (stop.clone(), shared.clone());
        let thread = std::thread::Builder::new()
            .name("live-host".into())
            .spawn(move || run(cfg, s2, sh2, ready_tx, direct_rx))
            .map_err(|e| HostError::Server(format!("control thread: {e}")))?;
        match ready_rx.recv() {
            Ok(Ok(ready)) => Ok(Self {
                ready,
                stop,
                shared,
                direct: direct_tx,
                thread: Some(thread),
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = thread.join();
                Err(HostError::Server(
                    "engine thread exited during start-up".into(),
                ))
            }
        }
    }

    pub fn ready(&self) -> &HostReady {
        &self.ready
    }

    /// Still processing (false after [`stop`](Self::stop) or a fatal stream error).
    pub fn alive(&self) -> bool {
        self.thread.as_ref().is_some_and(|t| !t.is_finished())
    }

    /// Why the host stopped by itself (device removed, driver reset...).
    pub fn error(&self) -> Option<String> {
        lock(&self.shared).error.clone()
    }

    /// Latest `SessionState` JSON (same object as the protocol's `state.state`).
    pub fn state_json(&self) -> String {
        lock(&self.shared).state_json.clone()
    }

    pub fn meters(&self) -> Option<Meters> {
        lock(&self.shared).meters
    }

    pub fn driver_xruns(&self) -> u32 {
        lock(&self.shared).driver_xruns
    }

    /// Apply a control in-process (no WebSocket) and wait for the session's verdict.
    pub fn control(&self, c: Control) -> Result<(), ControlError> {
        self.handle().control(c)
    }

    pub fn handle(&self) -> ControlHandle {
        ControlHandle {
            tx: self.direct.clone(),
        }
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for EngineHost {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run(
    cfg: HostConfig,
    stop: Arc<AtomicBool>,
    shared: Arc<Mutex<Shared>>,
    ready_tx: SyncSender<Result<HostReady, HostError>>,
    direct_rx: Receiver<Direct>,
) {
    let fail = |e: HostError| {
        let _ = ready_tx.send(Err(e));
    };
    let mut running = match io::start(&cfg.io) {
        Ok(r) => r,
        Err(e) => return fail(HostError::Audio(e.to_string())),
    };
    let mut warnings = Vec::new();
    // The device may run at another rate than requested (the Null host clamps, drivers round).
    let session = Session::new(
        running.info.sample_rate as f32,
        running.info.buffer_frames as usize * 8,
    );
    let mut session = match cfg.store {
        Some(st) => {
            let (s, w) = session.with_store(st);
            warnings.extend(w.into_iter().map(|w| format!("preset skipped: {w}")));
            s
        }
        None => session,
    };
    let (midi_names, midi_rx) = match cfg.midi {
        Some((n, rx)) => (n, Some(rx)),
        None => (Vec::new(), None),
    };
    session.midi.ports = midi_names;
    let mut pending: Vec<Command> = Vec::new();
    match session.load_preset(&cfg.preset) {
        Ok(c) => pending.push(c),
        Err(e) => return fail(HostError::Preset(e.to_string())),
    }
    if cfg.start_muted {
        pending.extend(session.set_mix(|m| m.mute = true));
    }
    let server = match RemoteServer::start(RemoteConfig {
        bind: cfg.bind,
        port: cfg.port,
        osc: cfg.osc,
        engine_name: cfg.name.clone(),
    }) {
        Ok(s) => s,
        Err(e) => {
            return fail(HostError::Server(format!(
                "control server on port {}: {e}",
                cfg.port
            )));
        }
    };
    server.set_hello(serde_json::json!({
        "sample_rate": running.info.sample_rate,
        "buffer_frames": running.info.buffer_frames,
        "devices": running.info,
    }));
    let host = if cfg.bind.is_loopback() {
        cfg.bind
    } else {
        crate::lan_ip()
    };
    let _mdns = (cfg.announce && !cfg.bind.is_loopback())
        .then(|| Announcer::start(&cfg.name, host, server.port(), server.osc_port()))
        .and_then(|r| {
            r.map_err(|e| warnings.push(format!("mDNS announcement failed ({e})")))
                .ok()
        });
    let ready = HostReady {
        info: running.info.clone(),
        port: server.port(),
        osc_port: server.osc_port(),
        host,
        controller_token: server.token(Role::Controller),
        controller_url: server.pairing_url(Role::Controller, host),
        performer_url: server.pairing_url(Role::Performer, host),
        viewer_url: server.pairing_url(Role::Viewer, host),
        warnings,
    };
    lock(&shared).state_json = serde_json::to_string(&session.state()).unwrap_or_default();
    if ready_tx.send(Ok(ready)).is_err() {
        return;
    }

    let mut last_rev = u64::MAX;
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(TICK);
        let mut retry = Vec::new();
        for c in pending.drain(..) {
            if let Err(c) = running.send(c) {
                retry.push(c);
            }
        }
        pending = retry;
        let now = Instant::now();
        let mut replies = Vec::new();
        for inc in server.drain() {
            if pending.len() >= MAX_PENDING_COMMANDS {
                let msg = ControlError::Busy.to_string();
                replies.push((inc.conn, inc.id, Err(("engine_busy", msg))));
                continue;
            }
            match session.apply_control(inc.control, now) {
                Ok(cmds) => {
                    queue(&mut running, &mut pending, cmds);
                    replies.push((inc.conn, inc.id, Ok(())));
                }
                Err(e) => replies.push((
                    inc.conn,
                    inc.id,
                    Err((server_error_code(&e), e.to_string())),
                )),
            }
        }
        let mut direct_replies = Vec::new();
        while let Ok((c, tx)) = direct_rx.try_recv() {
            let r = if pending.len() >= MAX_PENDING_COMMANDS {
                Err(ControlError::Busy)
            } else {
                session
                    .apply_control(c, now)
                    .map(|cmds| queue(&mut running, &mut pending, cmds))
                    .map_err(|e| ControlError::Session {
                        code: server_error_code(&e),
                        message: e.to_string(),
                    })
            };
            direct_replies.push((tx, r));
        }
        if let Some(rx) = &midi_rx {
            for bytes in rx.try_iter() {
                let cmds = session.apply_midi(&bytes, now);
                queue(&mut running, &mut pending, cmds);
            }
        }
        if session.revision != last_rev {
            last_rev = session.revision;
            let state = session.state();
            server.publish_state(&state);
            lock(&shared).state_json = serde_json::to_string(&state).unwrap_or_default();
        }
        for (conn, id, r) in replies {
            server.reply(conn, id, r);
        }
        for (tx, r) in direct_replies {
            let _ = tx.send(r);
        }
        if let Some(m) = running.poll() {
            server.publish_meters(meters_json(&m));
            let mut s = lock(&shared);
            s.meters = Some(m);
            s.driver_xruns = running.driver_xruns();
        }
        if !running.alive() {
            lock(&shared).error = Some(format!(
                "audio stream stopped: {}",
                running
                    .last_error()
                    .unwrap_or_else(|| "unknown driver error".into())
            ));
            return;
        }
    }
}

fn queue(running: &mut io::Running, pending: &mut Vec<Command>, cmds: Vec<Command>) {
    for c in cmds {
        if !pending.is_empty() {
            // Keep order: once something waits, everything after it waits too.
            pending.push(c);
        } else if let Err(c) = running.send(c) {
            pending.push(c);
        }
    }
}
