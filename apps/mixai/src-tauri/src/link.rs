//! LAN tempo sync between Decks instances (WP19-29): Tauri side of `decks-link`.
//!
//! The crate runs the network session; this module connects it to the audio engine:
//!
//! * while this instance **leads** the session, the engine's master clock (a playing deck or
//!   the internal clock, whatever the master clock panel says) is fed to the session;
//! * while it **follows**, the engine's clock source is set to `internal` and the internal
//!   clock is steered to the session; decks with SYNC on follow it as usual. The source the
//!   DJ had before (or picked later) is put back when sync stops.
//!
//! What "picked later" can and cannot mean. The engine has no record of who set its clock
//! source; this module only sees the configured source on every tick. A source other than
//! `internal` while following can only come from the DJ, so it is remembered as the one to
//! restore (the pump sets `internal` again). A choice of `internal` while following cannot
//! be seen: the panel already shows `internal` (the UI mirrors the engine's configured
//! source), so the select does not even fire, and the engine state would be the same
//! either way. Stopping then puts back the source sync found when it took over (or the last
//! other source the DJ picked). Telling the two apart needs the `master_set_clock` command
//! in `lib.rs` to report the DJ's choice to this module; it does not today.
//!
//! While the leader's master clock is a playing deck, the session tempo is that deck's: the
//! session is told so every tick and refuses tempo proposals (`tempo_locked`), instead of
//! taking one and being put back a moment later. Nudge is a follower's control.
//!
//! A pump thread does that every 50 ms while a node runs and emits `link://state` at 4 Hz.
//! Time base everywhere: `mixai_core::host_micros()`. Docs: `docs/decks/link.md`.

use std::collections::VecDeque;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError, TryLockError};
use std::time::Duration;

use decks_link::{
    DEFAULT_PORT, LinkClock, LinkConfig, LinkNode, LinkSnapshot, QUANTUM, key_from_pin, valid_tempo,
};
use mixai_core::{ClockSource, Engine, host_micros};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

/// Event with a [`LinkStatus`] payload, emitted at 4 Hz while sync runs and once when it stops.
const EVENT: &str = "link://state";
/// Pump period.
const TICK: Duration = Duration::from_millis(50);
/// The event goes out every this many ticks (4 Hz).
const EMIT_EVERY: u32 = 5;
/// After a tempo was pushed into the engine, wait this long before feeding the engine clock
/// to the session again: the audio callback has to pick the tempo up first.
const FEED_HOLDOFF_US: u64 = 150_000;
/// A follower's internal clock further than this from the session is set at once.
const STEER_JUMP_US: f64 = 20_000.0;
/// Below this the internal clock is left alone: it runs on the sample clock, which is
/// smoother than anything measured from outside the audio callback.
const STEER_DEADBAND_US: f64 = 2_000.0;
/// Measurements the median is taken over (7 ticks = 350 ms).
const STEER_WINDOW: usize = 7;
/// How long the exit hook waits for a start or stop that is in flight: that one stops a
/// node of its own (a few tens of milliseconds), and its goodbye should leave before the
/// process ends. Bounded, so an exit never hangs on it.
const EXIT_PATIENCE: Duration = Duration::from_millis(500);

/// Refusals of `link_set`. The UI maps these texts to catalogue strings
/// (`src/link/link-math.ts` `errorKey`; a test there reads this file): keep them in step.
const ERR_NOT_RUNNING: &str = "tempo sync is not running";
const ERR_TEMPO_LOCKED: &str = "tempo follows the playing deck";
const ERR_NUDGE_LEADER: &str = "nudge is not available while this instance leads";
/// `link_start` after the app began to exit (the exit hook ran): nothing may start now.
const ERR_CLOSING: &str = "could not start tempo sync: the app is closing";

/// What the UI shows (also the payload of `link://state`).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    pub running: bool,
    /// Another member's clock offset is known: the beat is the shared one.
    pub locked: bool,
    /// This instance drives the session timeline.
    pub leader: bool,
    /// Other instances in the session.
    pub peers: usize,
    pub bpm: f64,
    /// Session beat (with our nudge) at `host_us`.
    pub beat: f64,
    /// `beat` modulo 4: position in the bar.
    pub phase: f64,
    /// Leader clock minus ours, in microseconds (0 while we lead).
    pub offset_us: i64,
    pub pin_set: bool,
    /// Our phase shift against the session, in beats.
    pub nudge_beats: f64,
    /// `host_micros()` at which `beat` holds.
    pub host_us: u64,
    /// The node joined the multicast group and sends to it from a LAN address (false = this
    /// machine only, or no network yet).
    pub multicast: bool,
    /// UDP port the node listens on.
    pub port: u16,
    /// Instances heard with our PIN that are not in our session yet (about to merge).
    pub pending: usize,
    /// The session tempo follows a playing deck of the leader (ours while we lead): a tempo
    /// proposal is refused.
    pub tempo_locked: bool,
}

fn status_from(s: &LinkSnapshot) -> LinkStatus {
    LinkStatus {
        running: true,
        locked: s.locked,
        leader: s.clock.leader,
        peers: s.clock.peers,
        bpm: s.clock.bpm,
        beat: s.clock.beat,
        phase: s.clock.phase_in_quantum,
        offset_us: s.clock.offset_us,
        pin_set: s.key_set,
        nudge_beats: s.nudge_beats,
        host_us: s.now_us,
        multicast: s.multicast,
        port: s.local_addr.port(),
        pending: s.peers.iter().filter(|p| !p.in_session).count(),
        tempo_locked: s.clock.tempo_locked,
    }
}

/// The engine's master clock, as much of it as the bridge needs.
#[derive(Debug, Clone, Copy, PartialEq)]
struct EngineClock {
    /// Source the master clock panel is set to.
    configured: ClockSource,
    /// The internal clock is what drives the master clock right now.
    internal: bool,
    bpm: f64,
    beat: f64,
    /// `host_micros()` at which `beat` holds (0 = no audio callback ran yet).
    host_us: u64,
}

impl EngineClock {
    fn read(engine: &Engine) -> Self {
        let clock = engine.clock_state();
        Self {
            configured: engine.perf().clock,
            internal: clock.source == "internal",
            bpm: clock.bpm,
            beat: clock.beat,
            host_us: clock.host_us,
        }
    }

    fn usable(&self) -> bool {
        self.host_us > 0 && valid_tempo(self.bpm) && self.beat.is_finite()
    }

    /// The engine's beat at `now`, extrapolated with its tempo.
    fn beat_at(&self, now: u64) -> f64 {
        self.beat + (now as f64 - self.host_us as f64) * self.bpm / 60e6
    }

    /// A playing deck drives the master clock: its tempo is the deck's, not one that can be
    /// set from outside.
    fn tempo_locked(&self) -> bool {
        !self.internal
    }
}

/// What the bridge needs from the audio engine (the real one, or a stand-in in tests that
/// run without an audio device).
trait EngineOps {
    fn clock(&self) -> EngineClock;
    fn set_clock(&self, source: ClockSource, bpm: Option<f64>);
    fn steer(&self, bpm: f64, beat: f64, host_us: u64);
}

impl EngineOps for Engine {
    fn clock(&self) -> EngineClock {
        EngineClock::read(self)
    }

    fn set_clock(&self, source: ClockSource, bpm: Option<f64>) {
        Engine::set_clock(self, source, bpm);
    }

    fn steer(&self, bpm: f64, beat: f64, host_us: u64) {
        self.steer_internal_clock(bpm, beat, host_us);
    }
}

/// One thing the pump does after [`Bridge::plan`].
#[derive(Debug, Clone, Copy, PartialEq)]
enum Action {
    /// `Engine::set_clock`.
    SetClock(ClockSource, Option<f64>),
    /// `Engine::steer_internal_clock`.
    Steer { bpm: f64, beat: f64, host_us: u64 },
    /// `LinkNode::feed_local_clock`.
    Feed { bpm: f64, beat: f64, host_us: u64 },
}

/// Decides when a follower's internal clock needs to be set again. Between two decisions the
/// clock runs on the sample clock; what is measured from this thread carries the timing
/// jitter of the audio callback (a millisecond or two), so small errors are judged by the
/// median of the last few measurements and anything inside the deadband is left alone.
#[derive(Debug, Default)]
struct Steer {
    errors_us: VecDeque<f64>,
}

impl Steer {
    fn reset(&mut self) {
        self.errors_us.clear();
    }

    /// `engine` = (tempo, beat now) of the internal clock, `None` while it is not the one
    /// running or has no time stamp yet. True = set the internal clock to the session now.
    fn decide(&mut self, link_bpm: f64, link_beat: f64, engine: Option<(f64, f64)>) -> bool {
        let Some((bpm, beat)) = engine else {
            self.reset();
            return true;
        };
        let error_us = (link_beat - beat) * 60e6 / link_bpm;
        if (bpm - link_bpm).abs() > 1e-6 || !error_us.is_finite() || error_us.abs() > STEER_JUMP_US
        {
            self.reset();
            return true;
        }
        self.errors_us.push_back(error_us);
        if self.errors_us.len() < STEER_WINDOW {
            return false;
        }
        let mut sorted: Vec<f64> = self.errors_us.iter().copied().collect();
        sorted.sort_by(f64::total_cmp);
        let median = sorted[sorted.len() / 2];
        let _ = self.errors_us.pop_front();
        if median.abs() > STEER_DEADBAND_US {
            self.reset();
            return true;
        }
        false
    }
}

/// The link between the session and the engine clock (pure: [`Bridge::plan`] returns what to
/// do, the pump does it).
#[derive(Debug, Default)]
struct Bridge {
    /// Clock source to put back on stop: the one the DJ had when we set `internal` to follow,
    /// or the one the DJ picked since. `None` = nothing to put back (we never changed it, or
    /// the DJ chose a source while this instance led: that choice stands). A choice of
    /// `internal` made while following is not visible here (see the module documentation).
    previous: Option<ClockSource>,
    steer: Steer,
    /// No feeding of the engine clock before this time (see [`FEED_HOLDOFF_US`]).
    feed_after: u64,
}

impl Bridge {
    /// `tempo_request` = a tempo another instance asked for and the session adopted while we
    /// hold its timeline.
    fn plan(
        &mut self,
        link: &LinkClock,
        tempo_request: Option<f64>,
        engine: &EngineClock,
        now: u64,
    ) -> Vec<Action> {
        let mut out = Vec::new();
        if link.leader {
            self.steer.reset();
            if engine.configured != ClockSource::Internal {
                // The DJ picked a source while we lead (we only ever set `internal`): that
                // later choice stands, stopping must not replace it with an older one.
                self.previous = None;
            }
            // A request can only get here with a deck as the master when the deck started in
            // the same tick (the session refuses proposals while told so): then the deck's
            // tempo rules and the feed below puts it back at once.
            let request = tempo_request.filter(|b| valid_tempo(*b) && !engine.tempo_locked());
            if let Some(bpm) = request {
                out.push(Action::SetClock(engine.configured, Some(bpm)));
                self.feed_after = now.saturating_add(FEED_HOLDOFF_US);
            }
            if now >= self.feed_after && engine.usable() {
                out.push(Action::Feed {
                    bpm: engine.bpm,
                    beat: engine.beat,
                    host_us: engine.host_us,
                });
            }
            return out;
        }
        // Following (or settling right after joining): the internal clock is the session.
        if engine.configured != ClockSource::Internal {
            // What the DJ has now (first tick) or just picked in the master clock panel: the
            // source to give back when sync stops.
            self.previous = Some(engine.configured);
            out.push(Action::SetClock(ClockSource::Internal, None));
        }
        let on_internal = engine.configured == ClockSource::Internal && engine.internal;
        let current = (on_internal && engine.usable()).then(|| (engine.bpm, engine.beat_at(now)));
        if self.steer.decide(link.bpm, link.beat, current) {
            out.push(Action::Steer {
                bpm: link.bpm,
                beat: link.beat,
                host_us: now,
            });
        }
        out
    }

    /// The tempo was changed from this instance while it leads (see [`link_set`]).
    fn tempo_pushed(&mut self, now: u64) {
        self.feed_after = now.saturating_add(FEED_HOLDOFF_US);
    }

    /// Sync stops: the source to put back, if any. Only while the engine is still on the
    /// source sync set (`internal`); anything else is a choice the DJ made since.
    fn source_to_restore(&mut self, configured: ClockSource) -> Option<ClockSource> {
        self.previous
            .take()
            .filter(|_| configured == ClockSource::Internal)
    }
}

/// How the running node was started (a second `link_start` with the same values is a no-op).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Started {
    key: u32,
    bind: Ipv4Addr,
    port: u16,
}

#[derive(Default)]
struct Inner {
    node: Option<LinkNode>,
    started: Option<Started>,
    bridge: Bridge,
}

impl Inner {
    fn status(&self) -> LinkStatus {
        self.node
            .as_ref()
            .map(|node| status_from(&node.snapshot()))
            .unwrap_or_default()
    }

    /// One pump step: read both clocks, plan, act.
    fn pump<E: EngineOps>(&mut self, engine: Option<&E>, now: u64) {
        let (Some(node), Some(engine)) = (&self.node, engine) else {
            return;
        };
        let clock = engine.clock();
        // Before anything else: while a deck is our master clock the session must refuse
        // tempo proposals, not take one and be put back by the next feed.
        node.set_tempo_locked(clock.tempo_locked());
        let link = node.clock_at(now);
        let request = node.take_tempo_request();
        for action in self.bridge.plan(&link, request, &clock, now) {
            match action {
                Action::SetClock(source, bpm) => engine.set_clock(source, bpm),
                Action::Steer { bpm, beat, host_us } => engine.steer(bpm, beat, host_us),
                Action::Feed { bpm, beat, host_us } => {
                    let _ = node.feed_local_clock(bpm, beat, host_us);
                }
            }
        }
    }

    /// `link_set`: propose a tempo and / or shift our phase. Everything is checked before
    /// anything is applied, so a refused request changes nothing.
    fn set<E: EngineOps>(
        &mut self,
        bpm: Option<f64>,
        nudge_beats: Option<f64>,
        engine: Option<&E>,
        now: u64,
    ) -> Result<(), &'static str> {
        let Some(node) = &self.node else {
            return Err(ERR_NOT_RUNNING);
        };
        // The pump tells the session every 50 ms what our master clock is; a deck started
        // since the last tick counts too.
        let clock = engine.map(E::clock);
        if let Some(clock) = &clock {
            node.set_tempo_locked(clock.tempo_locked());
        }
        let link = node.clock_at(now);
        if bpm.is_some() && link.tempo_locked {
            return Err(ERR_TEMPO_LOCKED);
        }
        if nudge_beats.is_some() && link.leader {
            return Err(ERR_NUDGE_LEADER);
        }
        if let Some(bpm) = bpm {
            if !node.set_tempo(bpm) {
                // The range was checked: the session says the tempo is a deck's.
                return Err(ERR_TEMPO_LOCKED);
            }
            if link.leader {
                // Our engine is the session clock: it has to play the tempo too.
                if let (Some(engine), Some(clock)) = (engine, &clock) {
                    engine.set_clock(clock.configured, Some(bpm));
                }
                self.bridge.tempo_pushed(now);
            }
        }
        if let Some(beats) = nudge_beats
            && !node.nudge(beats)
        {
            return Err(ERR_NUDGE_LEADER);
        }
        Ok(())
    }

    /// Sync stops: give the clock source back and hand the node to the caller, who stops it
    /// (a thread join and the goodbye datagrams) AFTER releasing the locks it holds.
    #[must_use = "stop the node once the locks are released"]
    fn detach<E: EngineOps>(&mut self, engine: Option<&E>) -> Option<LinkNode> {
        let node = self.node.take();
        if let Some(engine) = engine {
            let restore = self.bridge.source_to_restore(engine.clock().configured);
            if let Some(previous) = restore {
                engine.set_clock(previous, None);
            }
        }
        self.bridge = Bridge::default();
        self.started = None;
        node
    }
}

/// Stop a detached node: it says goodbye to the session and its thread ends (a few tens of
/// milliseconds). Call with no lock held.
fn stop_node(node: Option<LinkNode>) {
    if let Some(mut node) = node {
        node.stop();
    }
}

/// Managed state of the tempo-sync session (`lib.rs` manages `LinkCtl::default()`).
#[derive(Default)]
pub struct LinkCtl {
    inner: Mutex<Inner>,
    /// Held for the whole of a start or stop, so two of them never interleave while the
    /// state lock is released around socket work. The pump never takes it.
    lifecycle: Mutex<()>,
    /// The app is exiting ([`shutdown`] ran): no node may be kept from now on. Set before
    /// the exit hook takes the node, read by a start under the state lock, so a start whose
    /// node was created while the hook ran stops that node itself (with its goodbye).
    closing: AtomicBool,
}

impl LinkCtl {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Plain data behind the lock: a panic elsewhere must not take sync down for good.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn lifecycle(&self) -> MutexGuard<'_, ()> {
        self.lifecycle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Keep a node that was just started: `Err(node)` when the app began to exit meanwhile
    /// (the caller stops it, outside every lock). Under the state lock, like
    /// [`LinkCtl::take_for_exit`]: one of the two sees the other's work.
    fn adopt(&self, node: LinkNode, started: Started) -> Result<LinkStatus, LinkNode> {
        let mut inner = self.lock();
        if self.closing.load(Ordering::SeqCst) {
            return Err(node);
        }
        inner.node = Some(node);
        inner.started = Some(started);
        inner.bridge = Bridge::default();
        Ok(inner.status())
    }

    /// The app exits: from now on no start keeps its node; the node running now, if any, is
    /// handed out to be stopped (outside the locks). The clock source is not touched (nothing
    /// plays on). Does not wait for the lifecycle lock: a start in flight finishes on its own
    /// and, finding the flag, stops the node it made.
    #[must_use = "stop the node once the locks are released"]
    fn take_for_exit(&self) -> Option<LinkNode> {
        self.closing.store(true, Ordering::SeqCst);
        let mut inner = self.lock();
        inner.started = None;
        inner.node.take()
    }

    /// Wait until no start or stop is in flight, at most `patience`; `false` when one still
    /// was. Takes no lock for longer than the look itself.
    fn lifecycle_idle(&self, patience: Duration) -> bool {
        let since = std::time::Instant::now();
        loop {
            match self.lifecycle.try_lock() {
                Ok(_) | Err(TryLockError::Poisoned(_)) => return true,
                Err(TryLockError::WouldBlock) if since.elapsed() >= patience => return false,
                Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(5)),
            }
        }
    }
}

/// Lock order everywhere in this module: lifecycle (commands only), `LinkCtl` state, then
/// the engine. A node is never stopped while the state or the engine lock is held.
fn engine_guard<'a>(state: &'a State<'_, super::EngineState>) -> MutexGuard<'a, Option<Engine>> {
    state.0.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The app exits: leave the session with a goodbye, so the other instances drop this one at
/// once instead of after the 3 s timeout (see [`LinkCtl::take_for_exit`]). A start or stop
/// that is in flight stops its own node; the hook gives it [`EXIT_PATIENCE`] to do so.
fn shutdown(app: &tauri::AppHandle) {
    let Some(ctl) = app.try_state::<LinkCtl>() else {
        return;
    };
    stop_node(ctl.take_for_exit());
    if !ctl.lifecycle_idle(EXIT_PATIENCE) {
        log::warn!("tempo sync: a start or stop was still running at exit");
    }
}

/// Called once from the app setup: starts the pump thread (idle while no node runs) and
/// hooks the app exit.
pub fn init(app: &tauri::AppHandle) {
    // `RunEvent::Exit` reaches plugins; registering one here keeps the hook in this module.
    let on_exit = tauri::plugin::Builder::<tauri::Wry>::new("link-exit")
        .on_event(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                shutdown(app);
            }
        })
        .build();
    if let Err(e) = app.plugin(on_exit) {
        log::warn!("tempo sync: no exit hook, peers will see this instance time out: {e}");
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("link-pump".into())
        .spawn(move || {
            let mut ticks = 0u32;
            loop {
                std::thread::sleep(TICK);
                ticks = ticks.wrapping_add(1);
                let ctl: State<'_, LinkCtl> = app.state();
                let engine: State<'_, super::EngineState> = app.state();
                let status = {
                    let mut inner = ctl.lock();
                    if inner.node.is_none() {
                        continue;
                    }
                    inner.pump(engine_guard(&engine).as_ref(), host_micros());
                    ticks.is_multiple_of(EMIT_EVERY).then(|| inner.status())
                };
                if let Some(status) = status {
                    let _ = app.emit(EVENT, status);
                }
            }
        });
    if let Err(e) = spawned {
        log::error!("tempo sync: could not start the pump thread: {e}");
    }
}

/// `None` or empty = open session (key 0); else exactly four digits.
fn parse_pin(pin: Option<&str>) -> Result<u32, String> {
    match pin.map(str::trim) {
        None | Some("") => Ok(0),
        Some(pin) => key_from_pin(pin).ok_or_else(|| "pin must be exactly 4 digits".to_string()),
    }
}

/// `None` or empty = every interface; else one local IPv4 address (`127.0.0.1` = this
/// machine only).
fn parse_bind(bind: Option<&str>) -> Result<Ipv4Addr, String> {
    match bind.map(str::trim) {
        None | Some("") => Ok(Ipv4Addr::UNSPECIFIED),
        Some(text) => match text.parse::<Ipv4Addr>() {
            Ok(ip) if !ip.is_multicast() && !ip.is_broadcast() => Ok(ip),
            _ => Err("bind must be a local IPv4 address".to_string()),
        },
    }
}

fn parse_port(port: Option<u16>) -> Result<u16, String> {
    match port {
        None => Ok(DEFAULT_PORT),
        Some(port) if port >= 1024 => Ok(port),
        Some(_) => Err("port must be within 1024..=65535".to_string()),
    }
}

/// `link_set` arguments: a tempo within 20..=300 and / or a phase shift of at most one bar.
fn check_set(bpm: Option<f64>, nudge_beats: Option<f64>) -> Result<(), String> {
    if bpm.is_some_and(|b| !valid_tempo(b)) {
        return Err("bpm must be within 20..300".to_string());
    }
    if nudge_beats.is_some_and(|n| !n.is_finite() || n.abs() > QUANTUM) {
        return Err("nudge must be within -4..4 beats".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn link_status(ctl: State<'_, LinkCtl>) -> LinkStatus {
    ctl.lock().status()
}

/// Start tempo sync (or restart it when the PIN, address or port differ from the running
/// one). `pin` = four digits, or none for an open session. `bind` / `port` default to every
/// interface and the protocol port; `bind = "127.0.0.1"` keeps it on this machine.
#[tauri::command]
pub async fn link_start(
    pin: Option<String>,
    bind: Option<String>,
    port: Option<u16>,
    ctl: State<'_, LinkCtl>,
    engine: State<'_, super::EngineState>,
) -> Result<LinkStatus, String> {
    let wanted = Started {
        key: parse_pin(pin.as_deref())?,
        bind: parse_bind(bind.as_deref())?,
        port: parse_port(port)?,
    };
    let _starting = ctl.lifecycle();
    if ctl.closing.load(Ordering::SeqCst) {
        return Err(ERR_CLOSING.to_string());
    }
    let (old, tempo) = {
        let mut inner = ctl.lock();
        if inner.node.is_some() && inner.started == Some(wanted) {
            return Ok(inner.status());
        }
        let engine = engine_guard(&engine);
        let old = inner.detach(engine.as_ref());
        let tempo = engine
            .as_ref()
            .map(|e| e.clock_state().bpm)
            .filter(|bpm| valid_tempo(*bpm))
            .unwrap_or(128.0);
        (old, tempo)
    };
    // No state or engine lock from here: stopping joins a thread, starting opens sockets.
    stop_node(old);
    let node = LinkNode::start(LinkConfig {
        port: wanted.port,
        bind: wanted.bind,
        tempo,
        key: wanted.key,
        clock: host_micros,
        ..LinkConfig::default()
    })
    .map_err(|e| format!("could not start tempo sync: {e}"))?;
    ctl.adopt(node, wanted).map_err(|node| {
        // The exit hook ran while the node was being made: it never saw this node, so this
        // start stops it (goodbye included), with no lock held.
        stop_node(Some(node));
        ERR_CLOSING.to_string()
    })
}

#[tauri::command]
pub async fn link_stop(
    app: tauri::AppHandle,
    ctl: State<'_, LinkCtl>,
    engine: State<'_, super::EngineState>,
) -> Result<LinkStatus, String> {
    let _stopping = ctl.lifecycle();
    let node = ctl.lock().detach(engine_guard(&engine).as_ref());
    stop_node(node);
    let status = ctl.lock().status();
    let _ = app.emit(EVENT, status.clone());
    Ok(status)
}

/// Propose a session tempo (`bpm`) and / or shift our own phase against the session by
/// `nudge_beats` (positive = we run ahead; ours only, the session does not move).
///
/// Refused, with nothing changed: a tempo while the session tempo follows a playing deck of
/// the leader (`tempo follows the playing deck`), and a nudge while this instance leads (its
/// clock is the session; `nudge is not available while this instance leads`).
#[tauri::command]
pub fn link_set(
    bpm: Option<f64>,
    nudge_beats: Option<f64>,
    ctl: State<'_, LinkCtl>,
    engine: State<'_, super::EngineState>,
) -> Result<LinkStatus, String> {
    check_set(bpm, nudge_beats)?;
    let mut inner = ctl.lock();
    let engine = engine_guard(&engine);
    inner.set(bpm, nudge_beats, engine.as_ref(), host_micros())?;
    Ok(inner.status())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixai_core::DeckId;
    use std::cell::RefCell;
    use std::time::Instant;

    fn link(leader: bool, bpm: f64, beat: f64) -> LinkClock {
        LinkClock {
            bpm,
            beat,
            phase_in_quantum: beat.rem_euclid(4.0),
            peers: 1,
            leader,
            offset_us: 0,
            tempo_locked: false,
        }
    }

    fn engine(
        configured: ClockSource,
        internal: bool,
        bpm: f64,
        beat: f64,
        host_us: u64,
    ) -> EngineClock {
        EngineClock {
            configured,
            internal,
            bpm,
            beat,
            host_us,
        }
    }

    const AUTO: ClockSource = ClockSource::Auto;
    const INTERNAL: ClockSource = ClockSource::Internal;

    /// An engine with no audio device: a master clock that runs on `host_micros()` like the
    /// real one (every read is stamped "now"), and a record of what the pump told it.
    struct FakeEngine {
        /// Tempo, source, and the beat that holds at `host_us`.
        anchor: RefCell<EngineClock>,
        calls: RefCell<Vec<Action>>,
    }

    impl FakeEngine {
        fn new(configured: ClockSource, internal: bool, bpm: f64) -> Self {
            let now = host_micros().max(1);
            Self {
                anchor: RefCell::new(engine(configured, internal, bpm, 0.0, now)),
                calls: RefCell::new(Vec::new()),
            }
        }

        /// The DJ turns the master clock panel to `source`.
        fn dj_picks(&self, source: ClockSource) {
            let mut c = self.anchor.borrow_mut();
            c.configured = source;
            c.internal = source == INTERNAL;
        }

        fn taken(&self) -> Vec<Action> {
            std::mem::take(&mut *self.calls.borrow_mut())
        }
    }

    impl EngineOps for FakeEngine {
        fn clock(&self) -> EngineClock {
            let c = *self.anchor.borrow();
            let now = host_micros().max(c.host_us);
            EngineClock {
                beat: c.beat_at(now),
                host_us: now,
                ..c
            }
        }

        fn set_clock(&self, source: ClockSource, bpm: Option<f64>) {
            // Like the engine: the clock goes on from where it is, at the new tempo.
            let running = self.clock();
            let mut c = self.anchor.borrow_mut();
            *c = running;
            c.configured = source;
            c.internal = source == INTERNAL;
            if let Some(bpm) = bpm {
                c.bpm = bpm;
            }
            self.calls.borrow_mut().push(Action::SetClock(source, bpm));
        }

        fn steer(&self, bpm: f64, beat: f64, host_us: u64) {
            let mut c = self.anchor.borrow_mut();
            c.bpm = bpm;
            c.beat = beat;
            c.host_us = host_us;
            self.calls
                .borrow_mut()
                .push(Action::Steer { bpm, beat, host_us });
        }
    }

    fn loopback_inner(peer_id: u64, tempo: f64, peer: Option<&LinkNode>) -> Inner {
        Inner {
            node: Some(loopback_node(peer_id, tempo, host_micros, peer)),
            ..Inner::default()
        }
    }

    /// Pump `inner` against `engine` every tick until `done`; false when `limit` passed first.
    fn pump_fake(
        inner: &mut Inner,
        engine: &FakeEngine,
        limit: Duration,
        mut done: impl FnMut(&Inner) -> bool,
    ) -> bool {
        let start = Instant::now();
        while start.elapsed() < limit {
            inner.pump(Some(engine), host_micros());
            if done(inner) {
                return true;
            }
            std::thread::sleep(TICK);
        }
        false
    }

    #[test]
    fn the_leader_feeds_the_engine_clock_and_leaves_the_source_alone() {
        let mut b = Bridge::default();
        let e = engine(AUTO, false, 126.0, 300.5, 9_000_000);
        let out = b.plan(&link(true, 128.0, 10.0), None, &e, 9_010_000);
        assert_eq!(
            out,
            vec![Action::Feed {
                bpm: 126.0,
                beat: 300.5,
                host_us: 9_000_000
            }]
        );
        assert_eq!(b.previous, None);
        // No audio callback yet, or a clock that is not usable: nothing is fed.
        for bad in [
            engine(AUTO, true, 126.0, 1.0, 0),
            engine(AUTO, true, 0.0, 1.0, 5),
            engine(AUTO, true, f64::NAN, 1.0, 5),
            engine(AUTO, true, 126.0, f64::INFINITY, 5),
        ] {
            assert!(
                b.plan(&link(true, 128.0, 10.0), None, &bad, 9_010_000)
                    .is_empty()
            );
        }
    }

    #[test]
    fn a_follower_switches_to_the_internal_clock_once_and_steers_it() {
        let mut b = Bridge::default();
        let now = 5_000_000;
        // Deck A drives the clock; we just joined a session at 128 BPM, beat 40.
        let out = b.plan(
            &link(false, 128.0, 40.0),
            None,
            &engine(AUTO, false, 120.0, 7.0, now),
            now,
        );
        assert_eq!(
            out,
            vec![
                Action::SetClock(INTERNAL, None),
                Action::Steer {
                    bpm: 128.0,
                    beat: 40.0,
                    host_us: now
                }
            ]
        );
        assert_eq!(b.previous, Some(AUTO));
        // Next tick the internal clock runs where it was steered: nothing to do.
        let t = now + 50_000;
        let beat = 40.0 + 0.05 * 128.0 / 60.0;
        let out = b.plan(
            &link(false, 128.0, beat),
            None,
            &engine(INTERNAL, true, 128.0, beat, t),
            t,
        );
        assert!(out.is_empty(), "{out:?}");
        // The DJ picks a deck in the master clock panel while following: it goes back to
        // internal, and the source to restore stays the first one.
        let deck = ClockSource::Deck(DeckId::A);
        let out = b.plan(
            &link(false, 128.0, beat),
            None,
            &engine(deck, false, 128.0, 3.0, t),
            t,
        );
        assert_eq!(out[0], Action::SetClock(INTERNAL, None));
        assert!(matches!(out[1], Action::Steer { .. }));
        // The DJ's later choice is the one to give back, not the older one.
        assert_eq!(b.previous, Some(deck));
        assert_eq!(b.source_to_restore(INTERNAL), Some(deck));
    }

    #[test]
    fn a_follower_that_becomes_leader_keeps_the_session_clock_running() {
        let mut b = Bridge::default();
        let now = 5_000_000;
        let _ = b.plan(
            &link(false, 128.0, 40.0),
            None,
            &engine(AUTO, false, 120.0, 7.0, now),
            now,
        );
        // The leader left: we lead, on the internal clock that already holds the session beat.
        let t = now + 50_000;
        let out = b.plan(
            &link(true, 128.0, 40.1),
            None,
            &engine(INTERNAL, true, 128.0, 40.1, t),
            t,
        );
        assert_eq!(
            out,
            vec![Action::Feed {
                bpm: 128.0,
                beat: 40.1,
                host_us: t
            }]
        );
        // The source to give back on stop is still remembered.
        assert_eq!(b.previous, Some(AUTO));
        // Unless the DJ picks a source while we lead: then that choice stands on stop.
        let out = b.plan(
            &link(true, 128.0, 40.2),
            None,
            &engine(ClockSource::Deck(DeckId::B), false, 128.0, 40.2, t + 50_000),
            t + 50_000,
        );
        assert!(matches!(out[..], [Action::Feed { .. }]));
        assert_eq!(b.previous, None);
        assert_eq!(b.source_to_restore(ClockSource::Deck(DeckId::B)), None);
    }

    // Stop gives back the source only while the engine is still on the one sync set.
    #[test]
    fn stop_restores_the_source_only_when_the_dj_did_not_change_it_since() {
        let mut b = Bridge::default();
        let _ = b.plan(
            &link(false, 128.0, 40.0),
            None,
            &engine(AUTO, false, 120.0, 7.0, 1_000_000),
            1_000_000,
        );
        assert_eq!(b.previous, Some(AUTO));
        // The DJ set deck A while following: the pump put internal back and remembered A.
        let deck = ClockSource::Deck(DeckId::A);
        let _ = b.plan(
            &link(false, 128.0, 40.0),
            None,
            &engine(deck, false, 128.0, 40.0, 1_050_000),
            1_050_000,
        );
        assert_eq!(b.previous, Some(deck));
        // Stop while the engine still runs internal (as sync left it): A comes back.
        let mut b2 = Bridge {
            previous: b.previous,
            ..Bridge::default()
        };
        assert_eq!(b2.source_to_restore(INTERNAL), Some(deck));
        assert_eq!(b2.source_to_restore(INTERNAL), None, "given back once");
        // Stop while the engine is on something the DJ chose after the last tick: untouched.
        assert_eq!(b.source_to_restore(ClockSource::Deck(DeckId::C)), None);
        assert_eq!(b.previous, None);
    }

    #[test]
    fn a_tempo_asked_by_a_follower_reaches_the_leaders_engine_before_the_next_feed() {
        let mut b = Bridge::default();
        let e = engine(INTERNAL, true, 128.0, 16.0, 1_000_000);
        let out = b.plan(&link(true, 140.0, 16.0), Some(140.0), &e, 1_000_000);
        assert_eq!(out, vec![Action::SetClock(INTERNAL, Some(140.0))]);
        // The engine still reports 128 for a moment: it must not be fed back.
        assert!(
            b.plan(&link(true, 140.0, 16.1), None, &e, 1_100_000)
                .is_empty()
        );
        let e = engine(INTERNAL, true, 140.0, 16.4, 1_160_000);
        let out = b.plan(&link(true, 140.0, 16.4), None, &e, 1_160_000);
        assert_eq!(
            out,
            vec![Action::Feed {
                bpm: 140.0,
                beat: 16.4,
                host_us: 1_160_000
            }]
        );
        // A request that is not a tempo is dropped; a follower never pushes one to its engine.
        let out = b.plan(&link(true, 140.0, 16.4), Some(f64::NAN), &e, 2_000_000);
        assert!(matches!(out[..], [Action::Feed { .. }]));
        let out = b.plan(&link(false, 150.0, 16.4), Some(150.0), &e, 2_000_000);
        assert!(
            out.iter()
                .all(|a| !matches!(a, Action::SetClock(_, Some(_)))),
            "{out:?}"
        );
        // (P0-1) a request that arrives while a deck is the master clock (the deck started in
        // the same tick the session adopted it) is dropped: the deck's tempo rules and is fed.
        let deck = engine(AUTO, false, 126.0, 16.4, 2_000_000);
        let out = b.plan(&link(true, 140.0, 16.4), Some(140.0), &deck, 2_000_000);
        assert_eq!(
            out,
            vec![Action::Feed {
                bpm: 126.0,
                beat: 16.4,
                host_us: 2_000_000
            }]
        );
    }

    // (P0-1, bridge level) while the leader's master clock is a playing deck the pump tells
    // the session so every tick, a follower's proposal is refused and the followers never
    // hear the proposed tempo; the leader's own `link_set` is refused with a message the UI
    // shows. Two real nodes over loopback, no audio device.
    #[test]
    fn a_proposal_is_refused_while_the_leaders_master_clock_is_a_deck() {
        // Deck A (126 BPM) drives the leader's master clock: `internal = false`.
        let deck = FakeEngine::new(AUTO, false, 126.0);
        let mut inner = loopback_inner(3, 126.0, None);
        let follower = loopback_node(8, 90.0, other_clock, inner.node.as_ref());
        let joined = pump_fake(&mut inner, &deck, Duration::from_secs(5), |inner| {
            inner.status().leader && follower.is_locked() && follower.status().tempo_locked
        });
        assert!(
            joined,
            "ours {:?}, theirs {:?}",
            inner.status(),
            follower.status()
        );
        assert!(inner.status().tempo_locked);
        assert_eq!(follower.status().bpm, 126.0);
        // The follower asks for 132: refused on its side (it knows from the beacons).
        assert!(!follower.set_tempo(132.0));
        // Nothing moves on either side: pump for half a second and watch both tempos. (A
        // proposal that reaches the leader on the wire anyway is covered in the crate:
        // `a_tempo_proposal_is_refused_while_the_leaders_clock_is_a_deck`.)
        let changed = pump_fake(&mut inner, &deck, Duration::from_millis(500), |inner| {
            inner.status().bpm != 126.0 || follower.status().bpm != 126.0
        });
        assert!(!changed, "a tempo moved: {:?}", inner.status());
        assert!(
            deck.taken()
                .iter()
                .all(|a| !matches!(a, Action::SetClock(_, Some(_)))),
            "the engine tempo was set although a deck is the master"
        );
        // The leader's own request: refused, with the text the UI maps.
        let now = host_micros();
        assert_eq!(
            inner.set(Some(132.0), None, Some(&deck), now),
            Err(ERR_TEMPO_LOCKED)
        );
        assert!(
            deck.taken().is_empty(),
            "a refused set must not touch the engine"
        );
        assert_eq!(inner.status().bpm, 126.0);
        // The deck stops: the internal clock is the master, the same proposal goes through
        // and reaches the leader's engine.
        deck.dj_picks(INTERNAL);
        let freed = pump_fake(&mut inner, &deck, Duration::from_secs(5), |inner| {
            !inner.status().tempo_locked && !follower.status().tempo_locked
        });
        assert!(freed);
        assert!(follower.set_tempo(132.0));
        let took = pump_fake(&mut inner, &deck, Duration::from_secs(5), |inner| {
            inner.status().bpm == 132.0
                && deck.clock().bpm == 132.0
                && follower.status().bpm == 132.0
        });
        assert!(took, "ours {:?}, engine {:?}", inner.status(), deck.clock());
        assert!(
            deck.taken()
                .contains(&Action::SetClock(INTERNAL, Some(132.0))),
            "the adopted tempo reaches the engine"
        );
        let node = inner.detach(Some(&deck));
        stop_node(node);
    }

    // (P1-6) nudge is a follower's control: the leader's `link_set` with a nudge is refused
    // and nothing moves; the follower's goes through and moves only the follower.
    #[test]
    fn nudge_is_refused_on_the_leader_and_moves_only_the_follower() {
        let engine = FakeEngine::new(INTERNAL, true, 128.0);
        let mut leader = loopback_inner(3, 128.0, None);
        let mut follower = loopback_inner(8, 100.0, leader.node.as_ref());
        let theirs = FakeEngine::new(AUTO, false, 100.0);
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            leader.pump(Some(&engine), host_micros());
            follower.pump(Some(&theirs), host_micros());
            if leader.status().leader && follower.status().locked && !follower.status().leader {
                break;
            }
            std::thread::sleep(TICK);
        }
        assert!(leader.status().leader && follower.status().locked);
        let now = host_micros();
        let before = (leader.status().beat, follower.status().nudge_beats);
        assert_eq!(
            leader.set(None, Some(0.25), Some(&engine), now),
            Err(ERR_NUDGE_LEADER)
        );
        assert_eq!(leader.status().nudge_beats, 0.0);
        assert!(engine.taken().is_empty());
        assert_eq!(follower.set(None, Some(0.25), Some(&theirs), now), Ok(()));
        assert_eq!(follower.status().nudge_beats, 0.25);
        assert_eq!(before.1, 0.0);
        // Both at once: refused as a whole on the leader, nothing applied.
        assert_eq!(
            leader.set(Some(130.0), Some(0.25), Some(&engine), now),
            Err(ERR_NUDGE_LEADER)
        );
        assert_eq!(leader.status().bpm, 128.0);
        assert_eq!(leader.status().nudge_beats, 0.0);
        // Not running: its own message.
        let mut idle = Inner::default();
        assert_eq!(
            idle.set(Some(130.0), None, Some(&engine), now),
            Err(ERR_NOT_RUNNING)
        );
        let (a, b) = (leader.detach(Some(&engine)), follower.detach(Some(&theirs)));
        stop_node(a);
        stop_node(b);
        // Detaching gave the follower's engine its source back (it ran internal for sync).
        assert_eq!(theirs.clock().configured, AUTO);
        assert_eq!(engine.clock().configured, INTERNAL);
    }

    #[test]
    fn steering_ignores_jitter_follows_drift_and_jumps_at_once() {
        let beats = |us: f64| us * 128.0 / 60e6;
        let mut s = Steer::default();
        // Not on the internal clock yet: steer blindly.
        assert!(s.decide(128.0, 10.0, None));
        // ±1.5 ms of measurement jitter around zero: never.
        let mut jitter = 1_500.0;
        for i in 0..200 {
            jitter = -jitter;
            assert!(
                !s.decide(128.0, 10.0, Some((128.0, 10.0 + beats(jitter)))),
                "tick {i}"
            );
        }
        // The engine runs 3 ms late for good (drift): one correction, after a full window.
        let mut steered_at = None;
        for i in 0..20 {
            if s.decide(128.0, 10.0, Some((128.0, 10.0 - beats(3_000.0)))) {
                steered_at = Some(i);
                break;
            }
        }
        // The window still held four of the jitter samples: the median turns after four more.
        assert_eq!(steered_at, Some(3));
        // After a correction the window starts again.
        assert!(!s.decide(128.0, 10.0, Some((128.0, 10.0))));
        // One outlier inside the jump limit does not trigger anything.
        assert!(!s.decide(128.0, 10.0, Some((128.0, 10.0 + beats(15_000.0)))));
        // A jump (seek, nudge of a quarter beat = 117 ms) is taken at once.
        assert!(s.decide(128.0, 10.25, Some((128.0, 10.0))));
        // So is another tempo.
        assert!(s.decide(140.0, 10.0, Some((128.0, 10.0))));
        assert!(!s.decide(140.0, 10.0, Some((140.0, 10.0))));
        // Garbage in the measurement steers rather than poisons the window.
        assert!(s.decide(128.0, 10.0, Some((128.0, f64::NAN))));
        assert!(s.errors_us.is_empty());
    }

    #[test]
    fn arguments_are_validated() {
        assert_eq!(parse_pin(None), Ok(0));
        assert_eq!(parse_pin(Some("")), Ok(0));
        assert_eq!(parse_pin(Some("  ")), Ok(0));
        assert_eq!(parse_pin(Some("1234")), Ok(key_from_pin("1234").unwrap()));
        assert_eq!(parse_pin(Some(" 1234 ")), parse_pin(Some("1234")));
        for bad in ["123", "12345", "12a4", "١٢٣٤", "-123", "1 23"] {
            assert!(parse_pin(Some(bad)).is_err(), "{bad:?}");
        }
        assert_eq!(parse_bind(None), Ok(Ipv4Addr::UNSPECIFIED));
        assert_eq!(parse_bind(Some("")), Ok(Ipv4Addr::UNSPECIFIED));
        assert_eq!(parse_bind(Some("127.0.0.1")), Ok(Ipv4Addr::LOCALHOST));
        assert_eq!(
            parse_bind(Some(" 192.168.1.20 ")),
            Ok(Ipv4Addr::new(192, 168, 1, 20))
        );
        for bad in [
            "localhost",
            "::1",
            "239.255.42.29",
            "255.255.255.255",
            "1.2.3",
            "1.2.3.4:80",
        ] {
            assert!(parse_bind(Some(bad)).is_err(), "{bad:?}");
        }
        assert_eq!(parse_port(None), Ok(DEFAULT_PORT));
        assert_eq!(parse_port(Some(1024)), Ok(1024));
        assert!(parse_port(Some(0)).is_err() && parse_port(Some(1023)).is_err());

        assert!(check_set(None, None).is_ok());
        assert!(check_set(Some(128.0), Some(-0.25)).is_ok());
        assert!(check_set(Some(20.0), Some(4.0)).is_ok());
        for bpm in [f64::NAN, f64::INFINITY, 0.0, 19.9, 300.1, -128.0] {
            assert!(check_set(Some(bpm), None).is_err(), "{bpm}");
        }
        for nudge in [f64::NAN, f64::NEG_INFINITY, 4.01, -5.0] {
            assert!(check_set(None, Some(nudge)).is_err(), "{nudge}");
        }
    }

    #[test]
    fn a_node_on_loopback_reports_through_the_status_and_stops_cleanly() {
        let mut inner = Inner::default();
        assert_eq!(inner.status(), LinkStatus::default());
        assert!(!inner.status().running);
        let started = host_micros();
        let node = LinkNode::start(LinkConfig {
            peer_id: 7,
            tempo: 126.0,
            key: key_from_pin("4821").unwrap(),
            clock: host_micros,
            ..LinkConfig::loopback(0)
        })
        .expect("a loopback node starts");
        let port = node.local_addr().port();
        inner.node = Some(node);
        // Beat 0 is the node thread's first tick: wait for the beat to move instead of
        // sleeping a fixed time (the thread may be late on a busy machine).
        let waited = Instant::now();
        let s = loop {
            let s = inner.status();
            if s.beat > 0.0 {
                break s;
            }
            assert!(
                waited.elapsed() < Duration::from_secs(5),
                "the session beat never moved: {s:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        let read = host_micros();
        assert!(s.running && s.leader && s.pin_set);
        assert!(!s.locked && !s.multicast);
        assert_eq!((s.peers, s.pending, s.offset_us, s.port), (0, 0, 0, port));
        assert_eq!(s.bpm, 126.0);
        // The beat counts from the node's first tick, which lies between `started` and the
        // read: it cannot be further than the time that really passed, however long that was.
        let most = (read - started) as f64 * 126.0 / 60e6;
        assert!(
            s.beat <= most + 1e-9,
            "beat {} after at most {most} beats of run time",
            s.beat
        );
        assert!((s.phase - s.beat.rem_euclid(4.0)).abs() < 1e-9);
        assert!(
            (started..=read).contains(&s.host_us),
            "host_us {} outside {started}..={read}",
            s.host_us
        );
        assert!(!s.tempo_locked, "no engine told the session about a deck");
        // The JSON the UI gets.
        let json = serde_json::to_value(&s).unwrap();
        for key in [
            "running",
            "locked",
            "leader",
            "peers",
            "bpm",
            "beat",
            "phase",
            "offsetUs",
            "pinSet",
            "nudgeBeats",
            "hostUs",
            "multicast",
            "port",
            "pending",
            "tempoLocked",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        assert_eq!(json.as_object().map(|o| o.len()), Some(15), "{json}");
        // Without an engine the pump does nothing and does not fail.
        inner.pump(None::<&FakeEngine>, host_micros());
        inner.bridge.previous = Some(AUTO);
        let node = inner.detach(None::<&FakeEngine>);
        assert!(node.is_some(), "the node is handed out to be stopped");
        stop_node(node);
        assert!(inner.node.is_none() && inner.started.is_none());
        assert_eq!(inner.bridge.previous, None);
        assert_eq!(inner.status(), LinkStatus::default());
        // Stopping twice is harmless.
        stop_node(inner.detach(None::<&FakeEngine>));
    }

    // The pump against an engine without an audio device: a follower switches the source,
    // steers the internal clock to the session, follows a tempo change, and gets the source
    // back when sync stops. (The two tests further down do the same with a real engine and
    // are skipped where there is no audio output.)
    #[test]
    fn the_pump_follows_and_leads_without_an_audio_device() {
        // The other computer: lower id, never joined anybody, so it leads, at 128 BPM.
        let leader = loopback_node(5, 128.0, other_clock, None);
        let engine = FakeEngine::new(AUTO, false, 100.0);
        let mut inner = loopback_inner(9, 100.0, Some(&leader));
        let joined = pump_fake(&mut inner, &engine, Duration::from_secs(5), |inner| {
            let s = inner.status();
            s.locked && !s.leader && s.peers == 1
        });
        assert!(joined, "never locked as a follower: {:?}", inner.status());
        let calls = engine.taken();
        assert_eq!(calls[0], Action::SetClock(INTERNAL, None), "{calls:?}");
        assert!(
            calls
                .iter()
                .any(|a| matches!(a, Action::Steer { bpm, .. } if *bpm == 128.0)),
            "{calls:?}"
        );
        assert_eq!(engine.clock().configured, INTERNAL);
        assert_eq!(inner.bridge.previous, Some(AUTO));
        // The steered clock is the session: the engine's beat is the leader's own beat at
        // the same instant (the tolerance is part of the wait: the first clock sample may be
        // a slow one, the pump corrects with the next).
        let error_ms = || {
            let now = host_micros();
            let there = leader.clock_at(now + 3_000_000);
            (engine.clock().beat_at(now) - there.beat).abs() * 60_000.0 / there.bpm
        };
        let aligned = pump_fake(&mut inner, &engine, Duration::from_secs(5), |_| {
            error_ms() < 25.0
        });
        assert!(aligned, "the engine is {} ms from the leader", error_ms());
        // A tempo change on the leader reaches the engine.
        assert!(leader.set_tempo(140.0));
        let changed = pump_fake(&mut inner, &engine, Duration::from_secs(5), |_| {
            engine.clock().bpm == 140.0
        });
        assert!(changed, "engine tempo {}", engine.clock().bpm);
        // A follower's own request goes to the leader, not to its engine.
        let _ = engine.taken();
        assert_eq!(
            inner.set(Some(150.0), None, Some(&engine), host_micros()),
            Ok(())
        );
        assert!(
            engine.taken().is_empty(),
            "a follower does not set its own engine"
        );
        let took = pump_fake(&mut inner, &engine, Duration::from_secs(5), |_| {
            leader.status().bpm == 150.0 && engine.clock().bpm == 150.0
        });
        assert!(
            took,
            "leader {}, engine {}",
            leader.status().bpm,
            engine.clock().bpm
        );
        // Stop: the node leaves (the leader is told) and the DJ's source is back.
        let node = inner.detach(Some(&engine));
        stop_node(node);
        assert_eq!(engine.clock().configured, AUTO);
        assert!(!inner.status().running);
        let alone = Instant::now();
        while leader.status().peers != 0 && alone.elapsed() < Duration::from_millis(2_500) {
            std::thread::sleep(TICK);
        }
        assert_eq!(leader.status().peers, 0, "the leader was told we left");

        // Leading: the engine clock is fed to the session and the source is left alone.
        let engine = FakeEngine::new(INTERNAL, true, 126.0);
        let mut inner = loopback_inner(3, 100.0, None);
        let follower = loopback_node(8, 90.0, other_clock, inner.node.as_ref());
        // The follower hears the engine's tempo and bar phase (the fed clock is the session).
        let phase_ms = || {
            let now = host_micros();
            let there = follower.clock_at(now + 3_000_000);
            phase_error_ms(engine.clock().beat_at(now), there.beat, 126.0)
        };
        let led = pump_fake(&mut inner, &engine, Duration::from_secs(5), |inner| {
            inner.status().leader
                && follower.is_locked()
                && follower.status().bpm == 126.0
                && phase_ms() < 25.0
        });
        assert!(
            led,
            "ours {:?}, theirs {:?}, phase error {} ms",
            inner.status(),
            follower.status(),
            phase_ms()
        );
        assert!(
            engine.taken().is_empty(),
            "leading never touches the engine"
        );
        assert_eq!(inner.bridge.previous, None);
        stop_node(inner.detach(Some(&engine)));
        assert_eq!(engine.clock().configured, INTERNAL);
    }

    // ---- with a real audio engine -----------------------------------------------------------
    // The engine opens the default audio output and plays silence (no deck is loaded); the
    // nodes talk over 127.0.0.1 only. On a machine without an audio output (CI) these two
    // tests cannot run: they print a SKIPPED line (see it with `--nocapture`) and the same
    // logic is covered, with a stand-in engine, by the tests above.

    /// The engine, or `None` with a line that says the test did not run. Written straight to
    /// stderr: the test harness captures `println!` of a passing test, and a test that
    /// asserted nothing must not look like one that passed.
    fn real_engine(test: &str) -> Option<Engine> {
        match Engine::start() {
            Ok(engine) => Some(engine),
            Err(err) => {
                use std::io::Write;
                let line = format!(
                    "SKIPPED {test}: no audio output on this machine ({err}); nothing was asserted\n"
                );
                let _ = std::io::stderr().write_all(line.as_bytes());
                None
            }
        }
    }

    /// The clock of "the other computer": three seconds ahead of ours.
    fn other_clock() -> u64 {
        host_micros() + 3_000_000
    }

    /// Pump `inner` every tick until `done` says so; false when `limit` passed first.
    fn pump_until(
        inner: &mut Inner,
        engine: &Engine,
        limit: Duration,
        mut done: impl FnMut(&Inner) -> bool,
    ) -> bool {
        let start = Instant::now();
        while start.elapsed() < limit {
            inner.pump(Some(engine), host_micros());
            if done(inner) {
                return true;
            }
            std::thread::sleep(TICK);
        }
        false
    }

    /// Distance of two beat counts modulo the bar, as milliseconds at `bpm`.
    fn phase_error_ms(a: f64, b: f64, bpm: f64) -> f64 {
        let d = (a - b).rem_euclid(QUANTUM);
        d.min(QUANTUM - d) * 60_000.0 / bpm
    }

    fn median(mut values: Vec<f64>) -> f64 {
        values.sort_by(f64::total_cmp);
        values[values.len() / 2]
    }

    /// Samples the median is taken over: 1.5 s at one per tick.
    const WINDOW: usize = 30;

    /// Call `sample` every tick until the median of the last [`WINDOW`] samples is below
    /// `limit_ms` (absolute), or `patience` is over. `Ok((median, worst of that window, samples
    /// taken))`, or `Err(the best median seen)`.
    ///
    /// A wait, not one fixed window: the samples come from a live audio engine, and on a
    /// machine busy with other builds the audio callback runs late, so one window can be out
    /// although nothing is wrong (2026-11-11, same sources, seven minutes apart: 0.76 ms, then
    /// 12.4 ms with a worst sample of 480 ms while unit tests ran fifty times slower than
    /// usual). An error of the code (a wrong phase, a buffer of offset) is in every window and
    /// still fails.
    fn settle(
        patience: Duration,
        limit_ms: f64,
        mut sample: impl FnMut() -> f64,
    ) -> Result<(f64, f64, usize), f64> {
        let start = Instant::now();
        let mut window: VecDeque<f64> = VecDeque::with_capacity(WINDOW);
        let mut best = f64::INFINITY;
        let mut taken = 0;
        while start.elapsed() < patience {
            std::thread::sleep(TICK);
            if window.len() == WINDOW {
                let _ = window.pop_front();
            }
            window.push_back(sample());
            taken += 1;
            if window.len() < WINDOW {
                continue;
            }
            let mid = median(window.iter().copied().collect());
            if mid.abs() < best.abs() {
                best = mid;
            }
            if mid.abs() < limit_ms {
                let worst = window.iter().fold(0.0f64, |m, e| m.max(e.abs()));
                return Ok((mid, worst, taken));
            }
        }
        Err(best)
    }

    fn loopback_node(
        peer_id: u64,
        tempo: f64,
        clock: fn() -> u64,
        peer: Option<&LinkNode>,
    ) -> LinkNode {
        LinkNode::start(LinkConfig {
            peer_id,
            tempo,
            clock,
            extra_peers: peer.map(|p| p.local_addr()).into_iter().collect(),
            ..LinkConfig::loopback(0)
        })
        .expect("a loopback node starts")
    }

    // (P2) the exit hook and a start that is in flight: whichever of the two stores or takes
    // the node second sees the other's work, so a node never survives the exit hook without
    // its goodbye, and a start after the hook is refused.
    #[test]
    fn a_node_started_while_the_app_exits_is_handed_back_to_be_stopped() {
        let ctl = LinkCtl::default();
        let wanted = Started {
            key: 0,
            bind: Ipv4Addr::LOCALHOST,
            port: 0,
        };
        // Before the exit: a started node is kept.
        let node = loopback_node(3, 128.0, host_micros, None);
        let status = ctl.adopt(node, wanted).expect("kept");
        assert!(status.running);
        assert!(ctl.lock().node.is_some());
        // The exit hook: it gets the node to stop and marks the app as closing.
        let taken = ctl.take_for_exit();
        assert!(taken.is_some(), "the running node is handed out");
        {
            let inner = ctl.lock();
            assert!(inner.node.is_none() && inner.started.is_none());
        }
        assert!(ctl.closing.load(Ordering::SeqCst));
        stop_node(taken);
        // A start that released the locks to open its sockets while the hook ran: its node is
        // handed back instead of stored, so the hook's goodbye is not undone.
        let late = loopback_node(9, 128.0, host_micros, None);
        let port = late.local_addr().port();
        let back = ctl
            .adopt(late, wanted)
            .expect_err("not kept after the exit hook");
        assert_eq!(back.local_addr().port(), port, "the same node comes back");
        assert!(ctl.lock().node.is_none(), "nothing was stored");
        assert_eq!(ctl.lock().status(), LinkStatus::default());
        stop_node(Some(back));
        // The hook again (a second exit event): nothing to hand out, still closing.
        assert!(ctl.take_for_exit().is_none());
        assert!(ctl.closing.load(Ordering::SeqCst));
        // The refusal starts like every other failed start: the UI maps "could not start"
        // to its start sentence (`src/link/link-math.ts` `errorKey`).
        assert!(ERR_CLOSING.starts_with("could not start tempo sync: "));
    }

    // The exit hook gives a start or stop that is in flight a bounded time to finish (it
    // stops a node of its own), and never waits longer than that.
    #[test]
    fn the_exit_hook_waits_for_a_start_in_flight_but_not_for_ever() {
        let ctl = LinkCtl::default();
        assert!(ctl.lifecycle_idle(Duration::ZERO), "nothing in flight");
        let shared = &ctl;
        std::thread::scope(|scope| {
            // A start that holds the lifecycle lock until it is told to finish.
            let (held, is_held) = std::sync::mpsc::channel();
            let (finish, finished) = std::sync::mpsc::channel::<()>();
            scope.spawn(move || {
                let _starting = shared.lifecycle();
                held.send(()).unwrap();
                let _ = finished.recv();
            });
            is_held.recv().unwrap();
            let since = Instant::now();
            assert!(
                !shared.lifecycle_idle(Duration::from_millis(30)),
                "still held"
            );
            assert!(since.elapsed() >= Duration::from_millis(30), "it waited");
            // The start finishes: with patience the hook sees it, and returns then, not at
            // the limit.
            finish.send(()).unwrap();
            let since = Instant::now();
            assert!(shared.lifecycle_idle(Duration::from_secs(10)));
            assert!(since.elapsed() < Duration::from_secs(8));
        });
        assert!(ctl.lifecycle_idle(Duration::ZERO));
    }

    #[test]
    fn a_real_engine_follows_a_session_and_gets_its_clock_source_back() {
        let Some(engine) =
            real_engine("a_real_engine_follows_a_session_and_gets_its_clock_source_back")
        else {
            return;
        };
        engine.set_clock(AUTO, Some(100.0));
        // The other computer: the lower id, so it leads, at 128 BPM.
        let leader = loopback_node(5, 128.0, other_clock, None);
        let mut inner = Inner {
            node: Some(loopback_node(9, 100.0, host_micros, Some(&leader))),
            ..Inner::default()
        };
        let joined = pump_until(&mut inner, &engine, Duration::from_secs(4), |inner| {
            let s = inner.status();
            s.locked && !s.leader && s.peers == 1
        });
        assert!(joined, "never locked as a follower: {:?}", inner.status());
        assert_eq!(
            engine.perf().clock,
            INTERNAL,
            "following runs on the internal clock"
        );
        assert_eq!(inner.bridge.previous, Some(AUTO));

        // Following: the engine's beat against the leader's own beat, read at the same instant
        // on both clocks, until 1.5 s of it have a median inside 10 ms.
        let mut steers = 0;
        let settled = settle(Duration::from_secs(10), 10.0, || {
            let now = host_micros();
            let node = inner.node.as_ref().unwrap();
            let planned =
                inner
                    .bridge
                    .plan(&node.clock_at(now), None, &EngineClock::read(&engine), now);
            for action in planned {
                if let Action::Steer { bpm, beat, host_us } = action {
                    engine.steer_internal_clock(bpm, beat, host_us);
                    steers += 1;
                }
            }
            let now = host_micros();
            let e = EngineClock::read(&engine);
            let there = leader.clock_at(now + 3_000_000);
            (e.beat_at(now) - there.beat) * 60_000.0 / there.bpm
        });
        let e = EngineClock::read(&engine);
        assert!(e.internal && e.usable());
        assert_eq!(e.bpm, 128.0, "the engine plays the session tempo");
        // Only the median is asserted: single samples carry the timing of one audio callback,
        // which on a busy machine is late by tens of milliseconds now and then.
        let (mid, worst, taken) = settled.unwrap_or_else(|best| {
            panic!("the engine never held the leader's beat: best median {best:+.2} ms in 10 s")
        });
        println!(
            "follower engine vs leader: median {mid:+.2} ms, worst {worst:.2} ms over {WINDOW} samples (after {taken} samples), {steers} steer(s)"
        );

        // A tempo change on the leader reaches the engine.
        assert!(leader.set_tempo(140.0));
        let changed = pump_until(&mut inner, &engine, Duration::from_secs(3), |_| {
            EngineClock::read(&engine).bpm == 140.0
        });
        assert!(changed, "engine tempo {}", EngineClock::read(&engine).bpm);

        // Stop: the node leaves and the clock source the DJ had is back.
        stop_node(inner.detach(Some(&engine)));
        assert_eq!(engine.perf().clock, AUTO);
        assert!(!inner.status().running);
        let alone = Instant::now();
        while leader.status().peers != 0 && alone.elapsed() < Duration::from_millis(2_500) {
            std::thread::sleep(TICK);
        }
        assert_eq!(leader.status().peers, 0, "the leader was told we left");
    }

    #[test]
    fn a_real_engine_leads_a_session_with_its_own_clock() {
        let Some(engine) = real_engine("a_real_engine_leads_a_session_with_its_own_clock") else {
            return;
        };
        engine.set_clock(INTERNAL, Some(126.0));
        let mut inner = Inner {
            node: Some(loopback_node(3, 100.0, host_micros, None)),
            ..Inner::default()
        };
        // The other computer follows (higher id), started with another tempo.
        let follower = loopback_node(8, 90.0, other_clock, inner.node.as_ref());
        let joined = pump_until(&mut inner, &engine, Duration::from_secs(4), |inner| {
            inner.status().leader && follower.is_locked() && follower.status().bpm == 126.0
        });
        assert!(
            joined,
            "ours {:?}, theirs {:?}",
            inner.status(),
            follower.status()
        );

        // Leading: the follower's bar phase against the engine's, until 1.5 s of it have a
        // median inside 10 ms.
        let settled = settle(Duration::from_secs(10), 10.0, || {
            inner.pump(Some(&engine), host_micros());
            let now = host_micros();
            let e = EngineClock::read(&engine);
            let there = follower.clock_at(now + 3_000_000);
            phase_error_ms(e.beat_at(now), there.beat, 126.0)
        });
        let (mid, worst, taken) = settled.unwrap_or_else(|best| {
            panic!("the follower never held the engine's phase: best median {best:.2} ms in 10 s")
        });
        println!(
            "follower node vs leading engine: median {mid:.2} ms, worst {worst:.2} ms over {WINDOW} samples (after {taken} samples)"
        );

        // The follower proposes a tempo: the engine's internal clock takes it and the session
        // keeps it (it is not overwritten by the engine's old tempo).
        assert!(follower.set_tempo(132.0));
        let changed = pump_until(&mut inner, &engine, Duration::from_secs(3), |inner| {
            EngineClock::read(&engine).bpm == 132.0 && inner.status().bpm == 132.0
        });
        assert!(changed, "engine tempo {}", EngineClock::read(&engine).bpm);
        let fell_back = pump_until(&mut inner, &engine, Duration::from_secs(1), |inner| {
            inner.status().bpm != 132.0
        });
        assert!(
            !fell_back,
            "the session fell back to {}",
            inner.status().bpm
        );
        assert_eq!(follower.status().bpm, 132.0);

        // Leading never touches the clock source, and stopping does not either.
        assert_eq!(engine.perf().clock, INTERNAL);
        assert_eq!(inner.bridge.previous, None);
        stop_node(inner.detach(Some(&engine)));
        assert_eq!(engine.perf().clock, INTERNAL);
    }
}
