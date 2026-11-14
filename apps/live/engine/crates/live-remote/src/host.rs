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

use crate::server::Pairing;
use crate::{RemoteConfig, RemoteServer, discovery::Announcer, meters_json, server_error_code};
use live_engine::{
    Command, Control, IoConfig, Meters, Role, RunningInfo, Session, Store, io, store::StoredTokens,
};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const TICK: Duration = Duration::from_millis(5);
/// How often the mix is written to disk at most (a fader drag sends many changes a second).
const SAVE_EVERY: Duration = Duration::from_millis(500);
/// Waits before each attempt to reopen the audio device after it failed, then give up.
const RESTART_BACKOFF_MS: [u64; 10] = [200, 400, 800, 1600, 3200, 5000, 5000, 5000, 5000, 5000];
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
    /// Open the OSC/UDP port. Off by default; see `osc.rs` for the key every address must carry.
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
            osc: false,
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
    /// OSC keys (`/<key>/live/...`), present only when OSC is on.
    pub osc_performer_key: Option<String>,
    pub osc_controller_key: Option<String>,
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
    /// How many times the audio stream was reopened after a failure (the engine keeps running).
    restarts: u32,
    /// Why the stream last failed, kept after a successful reopen as diagnostics.
    last_restart: Option<String>,
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

    /// How many times the audio stream was reopened after a failure (the engine kept running).
    pub fn restarts(&self) -> u32 {
        lock(&self.shared).restarts
    }

    /// Why the stream last failed, kept after a successful reopen as diagnostics.
    pub fn last_restart(&self) -> Option<String> {
        lock(&self.shared).last_restart.clone()
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
    let mut session = match cfg.store.clone() {
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
    // Restore the mix from the last run: faders, mute, bypass and the monitor option.
    if let Some(mix) = cfg.store.as_ref().and_then(|s| s.load_mix()) {
        pending.extend(session.restore_mix(mix));
    }
    if cfg.start_muted {
        pending.extend(session.set_mix(|m| m.mute = true));
    }
    // Reuse the pairing tokens from the last run when they are complete, so a restart keeps every
    // phone and watch paired instead of handing out new codes.
    let saved = cfg
        .store
        .as_ref()
        .and_then(|s| s.load_tokens())
        .filter(StoredTokens::complete);
    let server = match RemoteServer::start(RemoteConfig {
        bind: cfg.bind,
        port: cfg.port,
        osc: cfg.osc,
        engine_name: cfg.name.clone(),
        tokens: saved.map(|t| Pairing {
            tokens: [t.viewer, t.performer, t.controller],
            osc_keys: [t.osc_performer, t.osc_controller],
        }),
    }) {
        Ok(s) => s,
        Err(e) => {
            return fail(HostError::Server(format!(
                "control server on port {}: {e}",
                cfg.port
            )));
        }
    };
    if let Some(st) = &cfg.store {
        let p = server.pairing();
        let t = StoredTokens {
            viewer: p.tokens[0].clone(),
            performer: p.tokens[1].clone(),
            controller: p.tokens[2].clone(),
            osc_performer: p.osc_keys[0].clone(),
            osc_controller: p.osc_keys[1].clone(),
        };
        if let Err(e) = st.save_tokens(&t) {
            warnings.push(format!("could not save the pairing tokens: {e}"));
        }
    }
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
        osc_performer_key: server.osc_key(Role::Performer),
        osc_controller_key: server.osc_key(Role::Controller),
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
    let mut dirty = false;
    let mut last_save = Instant::now();
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(TICK);
        let mix_before = session.mix.clone();
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
        if session.mix != mix_before {
            dirty = true;
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
            let reason = running
                .last_error()
                .unwrap_or_else(|| "unknown driver error".into());
            match reopen(&cfg.io, &stop) {
                Some(r) => {
                    // The device is back: rebuild the chain and the mix on the fresh stream. The
                    // control server and the session survive, so clients stay paired.
                    running = r;
                    pending.clear();
                    let sr = running.info.sample_rate as f32;
                    let block = running.info.buffer_frames as usize * 8;
                    queue(&mut running, &mut pending, session.rebuild(sr, block));
                    let mut s = lock(&shared);
                    s.error = None;
                    s.restarts += 1;
                    s.last_restart = Some(reason.clone());
                    drop(s);
                    log::warn!("audio stream restarted after: {reason}");
                    continue;
                }
                None => {
                    let mut s = lock(&shared);
                    let tried = if s.restarts > 0 {
                        format!(" after {} restarts", s.restarts)
                    } else {
                        String::new()
                    };
                    s.error = Some(format!("audio stream stopped{tried}: {reason}"));
                    break;
                }
            }
        }
        if dirty && last_save.elapsed() >= SAVE_EVERY {
            if let Some(st) = &cfg.store
                && let Err(e) = st.save_mix(&session.mix)
            {
                log::warn!("saving the mix: {e}");
            }
            dirty = false;
            last_save = Instant::now();
        }
    }
    // Leave the mix where the user left it.
    if let Some(st) = &cfg.store
        && let Err(e) = st.save_mix(&session.mix)
    {
        log::warn!("saving the mix on exit: {e}");
    }
}

/// Reopen the audio device after it failed, waiting in the backoff between attempts. Returns the
/// new stream, or `None` when the host was asked to stop or the device never came back. The wait
/// is interrupted by `stop` so shutdown does not block on a long backoff.
fn reopen(cfg: &IoConfig, stop: &AtomicBool) -> Option<io::Running> {
    for ms in RESTART_BACKOFF_MS {
        if !sleep_unless_stopped(stop, ms) {
            return None;
        }
        match io::start(cfg) {
            Ok(r) => return Some(r),
            Err(e) => log::warn!("audio restart: {e}"),
        }
    }
    None
}

/// Sleep `ms`, waking early when `stop` is set. Returns `false` when the host was asked to stop.
fn sleep_unless_stopped(stop: &AtomicBool, ms: u64) -> bool {
    let mut left = ms;
    while left > 0 {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        let step = left.min(50);
        std::thread::sleep(Duration::from_millis(step));
        left -= step;
    }
    !stop.load(Ordering::SeqCst)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn null_cfg(store: Option<Store>) -> HostConfig {
        HostConfig {
            io: IoConfig {
                host: Some("Null".into()),
                ..IoConfig::default()
            },
            preset: "Natural Vocal".into(),
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 0,
            name: "Test".into(),
            announce: false,
            osc: false,
            store,
            start_muted: false,
            midi: None,
        }
    }

    /// A restart of the engine process must not unpair every client: the tokens written on the
    /// first start are handed back to the second server, so the pairing codes stay valid.
    #[test]
    fn a_restart_reuses_the_saved_pairing_tokens() {
        let dir = std::env::temp_dir().join(format!("live-host-tokens-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::new(&dir);

        let mut first =
            EngineHost::start(null_cfg(Some(store.clone()))).expect("the Null host starts");
        let token = first.ready().controller_token.clone();
        let saved = store
            .load_tokens()
            .expect("the tokens are written on start");
        assert!(saved.complete(), "a full set is saved");
        first.stop();

        let mut second =
            EngineHost::start(null_cfg(Some(store.clone()))).expect("the Null host starts again");
        assert_eq!(
            second.ready().controller_token,
            token,
            "the second start must reuse the token"
        );
        second.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A mix change is written down and read back, so a restart keeps the faders where they were.
    #[test]
    fn the_mix_is_persisted_and_restored() {
        let dir = std::env::temp_dir().join(format!("live-host-mix-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::new(&dir);

        let mut host =
            EngineHost::start(null_cfg(Some(store.clone()))).expect("the Null host starts");
        host.control(Control::SetMix {
            input_db: None,
            main_db: None,
            monitor_db: None,
            monitor_dry: None,
            bypass: None,
            mute: Some(true),
            monitor_untuned: None,
        })
        .expect("mute is accepted");
        host.stop();
        let saved = store.load_mix().expect("the mix is written on exit");
        assert!(saved.mute, "the mute survived the shutdown");

        // A second start with the same directory adopts the saved mix.
        let mut again =
            EngineHost::start(null_cfg(Some(store.clone()))).expect("the Null host starts again");
        let state: serde_json::Value =
            serde_json::from_str(&again.state_json()).expect("state is JSON");
        assert_eq!(state["mix"]["mute"], serde_json::Value::Bool(true));
        again.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stop_interrupts_the_restart_wait() {
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            s2.store(true, Ordering::SeqCst);
        });
        let t0 = Instant::now();
        assert!(
            !sleep_unless_stopped(&stop, 5000),
            "the wait must report the stop"
        );
        assert!(
            t0.elapsed() < Duration::from_millis(1000),
            "the wait must wake as soon as stop is set, took {:?}",
            t0.elapsed()
        );
    }
}
