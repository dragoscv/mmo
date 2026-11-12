//! [`DecksRemote`]: phone remote / second screen / Party DJ LAN server (`decks-remote`, WP19-21).
//!
//! The app starts it on demand, shows the three pairing QR codes, and calls [`DecksRemote::pump`]
//! from its UI tick (10–20 Hz): validated phone commands are applied to the engine and the engine
//! snapshot is published to every connected browser.
//!
//! Same rules as the Tauri shell (`src/remote.rs`, `docs/decks/remote.md`):
//!
//! * CUE on a phone is the deck's CDJ button (`cue_button.rs`). A held CUE belongs to
//!   the connection that pressed it; the pump ends a hold whose phone is gone (the server drops
//!   a silent phone within `decks_remote::DEAD_AFTER`), `stop()` / drop and the controls lock end
//!   every hold of this server's phones: the deck goes back to its cue point, paused. The DJ's
//!   own CUE button (`DecksEngine::cue`) takes a deck back from a phone the same way; `play` /
//!   `pause` in the app end a phone's hold where the deck is.
//! * Controls lock ([`DecksRemote::set_controls_locked`]): the server refuses every phone
//!   command except letting go of CUE, and the pump drops whatever still gets through; song
//!   requests, votes and moderation keep working.
//! * Phone values are validated by the server and AGAIN in [`apply`] (decks, slots, finite
//!   numbers, ranges), so nothing non-finite or out of range reaches the engine whatever the
//!   caller is.
//!
//! Lock order: `DecksRemote::server`, then the engine. Nothing takes them the other way round.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use decks_remote::{
    CommandFrom, EqBand as REq, RemoteCommand, RemoteConfig, RemoteDeck, RemoteServer, RemoteState,
    RequestStatus, Role,
};

use crate::engine::HoldReleaser;
use crate::engine::cue_button::CueHolder;
use crate::{DecksEngine, DecksError, EqBand, lock};

/// Names a [`DecksRemote`] in the CUE holds of its phones (two servers never share a number).
static NEXT_SERVER: AtomicU64 = AtomicU64::new(1);

/// Who a pairing code is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum RemoteRole {
    /// Phone remote with full deck control.
    Controller,
    /// Read-only second screen.
    Viewer,
    /// Party guest: song requests + votes.
    Guest,
}

impl From<RemoteRole> for Role {
    fn from(r: RemoteRole) -> Self {
        match r {
            RemoteRole::Controller => Role::Controller,
            RemoteRole::Viewer => Role::Viewer,
            RemoteRole::Guest => Role::Guest,
        }
    }
}

impl From<Role> for RemoteRole {
    fn from(r: Role) -> Self {
        match r {
            Role::Controller => RemoteRole::Controller,
            Role::Viewer => RemoteRole::Viewer,
            Role::Guest => RemoteRole::Guest,
        }
    }
}

/// Pairing data for one role.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct RemotePairing {
    pub role: RemoteRole,
    pub url: String,
    /// QR modules, row-major, `qr_width × qr_width`, `true` = dark. Draw with token colours and a
    /// 4-module quiet zone.
    pub qr_width: u32,
    pub qr_modules: Vec<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SongRequestState {
    Pending,
    Accepted,
    Rejected,
    Played,
}

impl From<RequestStatus> for SongRequestState {
    fn from(s: RequestStatus) -> Self {
        match s {
            RequestStatus::Pending => SongRequestState::Pending,
            RequestStatus::Accepted => SongRequestState::Accepted,
            RequestStatus::Rejected => SongRequestState::Rejected,
            RequestStatus::Played => SongRequestState::Played,
        }
    }
}

impl From<SongRequestState> for RequestStatus {
    fn from(s: SongRequestState) -> Self {
        match s {
            SongRequestState::Pending => RequestStatus::Pending,
            SongRequestState::Accepted => RequestStatus::Accepted,
            SongRequestState::Rejected => RequestStatus::Rejected,
            SongRequestState::Played => RequestStatus::Played,
        }
    }
}

/// A Party DJ song request.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SongRequest {
    pub id: u64,
    pub title: String,
    pub artist: String,
    pub note: String,
    pub votes: u32,
    pub state: SongRequestState,
}

/// A connected device.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct RemoteClient {
    pub id: String,
    pub role: RemoteRole,
    pub address: String,
}

/// Result of one [`DecksRemote::pump`].
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct RemotePumpReport {
    /// Commands applied to the engine.
    pub applied: u32,
    /// Commands the engine refused (e.g. engine stopped), one line each.
    pub errors: Vec<String>,
    /// Mixer changes applied from a phone, so the shell can move its own knobs / faders (the
    /// engine snapshot does not echo every control position).
    pub mixer_changes: Vec<RemoteMixerChange>,
    /// The DJ locked the phone controls ([`DecksRemote::set_controls_locked`]).
    #[uniffi(default = false)]
    pub controls_locked: bool,
}

/// A mixer control a phone moved.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Enum)]
pub enum RemoteMixerChange {
    Volume { deck: u8, value: f32 },
    Eq { deck: u8, band: EqBand, db: f32 },
    Filter { deck: u8, value: f32 },
    Crossfader { value: f32 },
    MasterVolume { value: f32 },
}

fn eq_band(b: REq) -> EqBand {
    match b {
        REq::Low => EqBand::Low,
        REq::Mid => EqBand::Mid,
        REq::High => EqBand::High,
    }
}

pub(crate) fn mixer_change(cmd: &RemoteCommand) -> Option<RemoteMixerChange> {
    Some(match *cmd {
        RemoteCommand::Volume { deck, value } => RemoteMixerChange::Volume { deck, value },
        RemoteCommand::Eq { deck, band, db } => RemoteMixerChange::Eq {
            deck,
            band: eq_band(band),
            db,
        },
        RemoteCommand::Filter { deck, value } => RemoteMixerChange::Filter { deck, value },
        RemoteCommand::Crossfader { value } => RemoteMixerChange::Crossfader { value },
        RemoteCommand::MasterVolume { value } => RemoteMixerChange::MasterVolume { value },
        _ => return None,
    })
}

/// The connected-mode server. Drop it (or call `stop`) to disconnect every device.
///
/// It serves ONE engine at a time: the one last handed to [`DecksRemote::pump`]. `stop()`,
/// drop and the controls lock let go of the CUE holds of this server's phones on that engine.
/// Pumping another engine first lets go of what they hold on the previous one (no pump looks
/// at that engine again).
#[derive(uniffi::Object)]
pub struct DecksRemote {
    server: Mutex<Option<RemoteServer>>,
    host: IpAddr,
    titles: Mutex<Vec<(Option<String>, Option<String>)>>,
    /// Names this server in the CUE holds of its phones.
    id: u64,
    /// The DJ locked the phone controls. Changed only with `server` locked.
    locked: AtomicBool,
    /// Lets go of CUE holds on the engine last pumped (`stop()` and drop are not handed one):
    /// the engine's [`RemoteTarget::target_id`] and its releaser, taken once per engine, not
    /// per pump.
    releaser: Mutex<Option<(usize, HoldReleaser)>>,
}

fn not_started() -> DecksError {
    DecksError::NotRunning {
        reason: "remote server stopped".into(),
    }
}

impl DecksRemote {
    fn with<R>(&self, f: impl FnOnce(&RemoteServer) -> R) -> Result<R, DecksError> {
        let s = lock(&self.server);
        s.as_ref().map(f).ok_or_else(not_started)
    }

    /// [`DecksRemote::pump`] on any [`RemoteTarget`].
    fn pump_target<T: RemoteTarget + ?Sized>(
        &self,
        target: &T,
    ) -> Result<RemotePumpReport, DecksError> {
        // Held for the whole step: `stop()` waits for it, so no hold is created after the
        // holds were ended.
        let guard = lock(&self.server);
        let server = guard.as_ref().ok_or_else(not_started)?;
        {
            let mut r = lock(&self.releaser);
            let engine = target.target_id();
            if r.as_ref().is_none_or(|(kept, _)| *kept != engine) {
                // Another engine than the last pump's: what this server's phones hold on the
                // old one is let go first.
                if let Some((_, release)) = r.as_ref() {
                    let id = self.id;
                    release(&|h| phone_of(id, h).is_none(), Instant::now());
                }
                *r = Some((engine, target.releaser()));
            }
        }
        let locked = self.locked.load(Ordering::SeqCst);
        let cmds = server.drain_commands_from();
        let done = pump_engine(
            target,
            self.id,
            &cmds,
            locked,
            |conn| server.is_connected(conn),
            Instant::now(),
        );
        let titles = lock(&self.titles).clone();
        server.publish(target.state(&titles));
        Ok(RemotePumpReport {
            applied: done.applied,
            errors: done.errors,
            mixer_changes: done.mixer_changes,
            controls_locked: locked,
        })
    }

    /// End every CUE hold of this server's phones on the engine last pumped (back to the cue
    /// point, paused). Call with `server` locked: no pump can create a hold meanwhile.
    fn release_holds(&self) {
        if let Some((_, release)) = lock(&self.releaser).as_ref() {
            let id = self.id;
            release(&|h| phone_of(id, h).is_none(), Instant::now());
        }
    }
}

/// The connection of `h` when it is one of server `id`'s phones.
fn phone_of(id: u64, h: CueHolder) -> Option<u64> {
    match h {
        CueHolder::Remote { server, conn } if server == id => Some(conn),
        _ => None,
    }
}

/// The engine calls a phone command turns into. The real one is [`DecksEngine`]; the tests
/// record the calls.
pub(crate) trait RemoteTarget {
    fn play(&self, deck: u8) -> Result<(), DecksError>;
    fn pause(&self, deck: u8) -> Result<(), DecksError>;
    /// The deck's CUE button pressed / released by `by`.
    fn cue_by(
        &self,
        deck: u8,
        by: CueHolder,
        pressed: bool,
        now: Instant,
    ) -> Result<(), DecksError>;
    fn hot_cue(&self, deck: u8, slot: u8) -> Result<(), DecksError>;
    fn auto_loop(&self, deck: u8, beats: f64) -> Result<(), DecksError>;
    fn exit_loop(&self, deck: u8) -> Result<(), DecksError>;
    fn jump_beats(&self, deck: u8, beats: f64) -> Result<(), DecksError>;
    fn sync(&self, deck: u8, lock: bool) -> Result<(), DecksError>;
    fn volume(&self, deck: u8, value: f32) -> Result<(), DecksError>;
    fn eq(&self, deck: u8, band: EqBand, db: f32) -> Result<(), DecksError>;
    fn filter(&self, deck: u8, value: f32) -> Result<(), DecksError>;
    fn crossfader(&self, value: f32) -> Result<(), DecksError>;
    fn master_volume(&self, value: f32) -> Result<(), DecksError>;
    /// End every CUE hold whose holder `keep` rejects (back to the cue point, paused).
    fn end_holds(&self, keep: &dyn Fn(CueHolder) -> bool, now: Instant) -> u32;
    /// Identity of the engine behind this target: the pump keeps one [`RemoteTarget::releaser`]
    /// per engine. Must stay unique for as long as that releaser lives (an address the
    /// releaser keeps alive does).
    fn target_id(&self) -> usize;
    /// [`RemoteTarget::end_holds`] for later, without a reference to the target.
    fn releaser(&self) -> HoldReleaser;
    /// The deck state the phones show.
    fn state(&self, titles: &[(Option<String>, Option<String>)]) -> RemoteState;
}

impl RemoteTarget for DecksEngine {
    fn play(&self, deck: u8) -> Result<(), DecksError> {
        DecksEngine::play(self, deck)
    }
    fn pause(&self, deck: u8) -> Result<(), DecksError> {
        DecksEngine::pause(self, deck)
    }
    fn cue_by(
        &self,
        deck: u8,
        by: CueHolder,
        pressed: bool,
        now: Instant,
    ) -> Result<(), DecksError> {
        // A cue point a phone moved shows in `DeckSnapshot::cue_point_sec`.
        self.cue_from(deck, by, pressed, now).map(|_| ())
    }
    fn hot_cue(&self, deck: u8, slot: u8) -> Result<(), DecksError> {
        self.hot_cue_jump(deck, slot)
    }
    fn auto_loop(&self, deck: u8, beats: f64) -> Result<(), DecksError> {
        self.loop_auto(deck, beats)
    }
    fn exit_loop(&self, deck: u8) -> Result<(), DecksError> {
        self.loop_exit(deck)
    }
    fn jump_beats(&self, deck: u8, beats: f64) -> Result<(), DecksError> {
        self.beat_jump(deck, beats)
    }
    fn sync(&self, deck: u8, lock: bool) -> Result<(), DecksError> {
        self.phase_sync(deck, lock)
    }
    fn volume(&self, deck: u8, value: f32) -> Result<(), DecksError> {
        self.set_volume(deck, value)
    }
    fn eq(&self, deck: u8, band: EqBand, db: f32) -> Result<(), DecksError> {
        self.set_eq(deck, band, db)
    }
    fn filter(&self, deck: u8, value: f32) -> Result<(), DecksError> {
        self.set_filter(deck, value)
    }
    fn crossfader(&self, value: f32) -> Result<(), DecksError> {
        self.set_crossfader(value)
    }
    fn master_volume(&self, value: f32) -> Result<(), DecksError> {
        self.set_master_volume(value)
    }
    fn end_holds(&self, keep: &dyn Fn(CueHolder) -> bool, now: Instant) -> u32 {
        self.end_cue_holds(keep, now)
    }
    fn target_id(&self) -> usize {
        DecksEngine::target_id(self)
    }
    fn releaser(&self) -> HoldReleaser {
        self.hold_releaser()
    }
    fn state(&self, titles: &[(Option<String>, Option<String>)]) -> RemoteState {
        remote_state(self, titles)
    }
}

/// Apply one phone command; `by` is the phone it came from, `now` the time of this pump step.
///
/// The commands come from `RemoteServer::drain_commands_from`, which only hands out validated
/// ones; they are validated AGAIN here (decks 0..3, hot cue 0..7, finite numbers, loop and jump
/// lengths in range, continuous controls clamped to the engine ranges): an invalid one is an
/// `InvalidArgument` error and no engine call. Returns the command as applied (clamped).
pub(crate) fn apply<T: RemoteTarget + ?Sized>(
    target: &T,
    by: CueHolder,
    cmd: &RemoteCommand,
    now: Instant,
) -> Result<RemoteCommand, DecksError> {
    let cmd = cmd.clone().validated().map_err(DecksError::invalid)?;
    match cmd {
        RemoteCommand::Play { deck } => target.play(deck),
        RemoteCommand::Pause { deck } => target.pause(deck),
        RemoteCommand::Cue { deck, pressed } => target.cue_by(deck, by, pressed, now),
        RemoteCommand::HotCue { deck, slot } => target.hot_cue(deck, slot),
        RemoteCommand::LoopAuto { deck, beats } => target.auto_loop(deck, beats),
        RemoteCommand::LoopExit { deck } => target.exit_loop(deck),
        RemoteCommand::BeatJump { deck, beats } => target.jump_beats(deck, beats),
        RemoteCommand::Sync { deck, lock } => target.sync(deck, lock),
        RemoteCommand::Volume { deck, value } => target.volume(deck, value),
        RemoteCommand::Eq { deck, band, db } => target.eq(deck, eq_band(band), db),
        RemoteCommand::Filter { deck, value } => target.filter(deck, value),
        RemoteCommand::Crossfader { value } => target.crossfader(value),
        RemoteCommand::MasterVolume { value } => target.master_volume(value),
    }?;
    Ok(cmd)
}

/// What one pump step did on the engine side.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Pumped {
    pub(crate) applied: u32,
    pub(crate) errors: Vec<String>,
    pub(crate) mixer_changes: Vec<RemoteMixerChange>,
}

/// One pump step on the engine side: the phone commands of server `server`, then the CUE holds
/// its phones may no longer keep (the phone is gone: lost Wi-Fi, closed tab, rotated code; or
/// the controls are locked). While locked only letting go of CUE is applied (the server refuses
/// the rest already; this is the second lock on the same door). Holds of the app's own CUE
/// button and of another server's phones are not this server's to end.
pub(crate) fn pump_engine<T: RemoteTarget + ?Sized>(
    target: &T,
    server: u64,
    cmds: &[CommandFrom],
    locked: bool,
    connected: impl Fn(u64) -> bool,
    now: Instant,
) -> Pumped {
    let mut out = Pumped::default();
    for c in cmds {
        if locked && !c.command.allowed_when_locked() {
            continue;
        }
        let by = CueHolder::Remote {
            server,
            conn: c.conn,
        };
        match apply(target, by, &c.command, now) {
            Ok(done) => {
                out.applied += 1;
                out.mixer_changes.extend(mixer_change(&done));
            }
            Err(e) => out.errors.push(format!("{}: {e}", c.client)),
        }
    }
    target.end_holds(
        &|h| phone_of(server, h).is_none_or(|conn| !locked && connected(conn)),
        now,
    );
    out
}

pub(crate) fn remote_state(
    engine: &DecksEngine,
    titles: &[(Option<String>, Option<String>)],
) -> RemoteState {
    let snap = engine.snapshot();
    let eq = engine.mixer_eq();
    let decks = snap
        .decks
        .iter()
        .map(|d| {
            let i = d.deck as usize;
            let e = eq.get(i).copied().unwrap_or([0.0; 4]);
            let (t, a) = titles.get(i).cloned().unwrap_or((None, None));
            RemoteDeck {
                deck: d.deck,
                loaded: d.loaded,
                title: t.or_else(|| d.title.clone()),
                artist: a,
                bpm: d.effective_bpm,
                key: d.effective_key_camelot.clone(),
                position_sec: d.playhead_sec,
                duration_sec: d.duration_sec,
                playing: d.playing,
                volume: d.volume,
                eq_low: e[0],
                eq_mid: e[1],
                eq_high: e[2],
                filter: e[3],
                loop_active: d.loop_active,
                sync_lock: d.sync_lock,
                bar_phase: d.bar_phase,
                vu: d.vu,
            }
        })
        .collect();
    RemoteState {
        decks,
        crossfader: snap.crossfader,
        master_volume: snap.master_volume,
        master_bpm: snap.clock.bpm,
        recording: snap.recording,
    }
}

#[uniffi::export]
impl DecksRemote {
    /// Start listening on every LAN interface (`port` 0 = any free port). `party_open` = accept
    /// song requests from the start.
    #[uniffi::constructor]
    pub fn start(port: u16, party_open: bool) -> Result<Arc<Self>, DecksError> {
        Self::start_on(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port, party_open)
    }

    pub fn port(&self) -> Result<u16, DecksError> {
        self.with(|s| s.port())
    }

    /// Pairing URL + QR for a role.
    pub fn pairing(&self, role: RemoteRole) -> Result<RemotePairing, DecksError> {
        let url = self.with(|s| s.pairing_url(role.into(), self.host))?;
        let qr = decks_remote::qr_matrix(&url).map_err(DecksError::invalid)?;
        Ok(RemotePairing {
            role,
            url,
            qr_width: qr.width,
            qr_modules: qr.modules,
        })
    }

    /// New code for `role`; devices paired with the old one are disconnected.
    pub fn rotate(&self, role: RemoteRole) -> Result<RemotePairing, DecksError> {
        self.with(|s| s.rotate_token(role.into()))?;
        self.pairing(role)
    }

    /// Artist / title per deck as the library knows them (the engine only has file titles).
    pub fn set_track_labels(&self, deck: u8, title: Option<String>, artist: Option<String>) {
        let mut t = lock(&self.titles);
        let i = deck as usize;
        if t.len() <= i {
            t.resize(i + 1, (None, None));
        }
        t[i] = (title, artist);
    }

    /// Apply pending phone commands to `engine` and publish its state. Call from the UI tick.
    ///
    /// Also ends a CUE hold whose phone is gone or locked out (the deck goes back to its cue
    /// point, paused), so keep calling it while the server runs. An invalid command (never
    /// handed out by the server) is listed in `errors` and does not reach the engine.
    pub fn pump(&self, engine: &DecksEngine) -> Result<RemotePumpReport, DecksError> {
        self.pump_target(engine)
    }

    /// Lock or unlock the phone controls. While locked no phone command reaches the decks or
    /// the mixer (play, pause, CUE, hot cues, loops, sync, faders, EQ, crossfader, master): a
    /// phone in a pocket cannot pause a deck. Letting go of CUE still passes, a deck that plays
    /// because a phone holds CUE goes back to its cue point at once, and song requests, votes
    /// and moderation keep working. Phone remotes are told and show it. A new server starts
    /// unlocked.
    pub fn set_controls_locked(&self, locked: bool) -> Result<(), DecksError> {
        let guard = lock(&self.server);
        let server = guard.as_ref().ok_or_else(not_started)?;
        self.locked.store(locked, Ordering::SeqCst);
        server.set_controls_locked(locked);
        if locked {
            self.release_holds();
        }
        Ok(())
    }

    /// Whether the phone controls are locked (the last choice, also after `stop()`).
    pub fn controls_locked(&self) -> bool {
        self.locked.load(Ordering::SeqCst)
    }

    pub fn requests(&self) -> Result<Vec<SongRequest>, DecksError> {
        self.with(|s| {
            s.requests()
                .into_iter()
                .map(|r| SongRequest {
                    id: r.id,
                    title: r.title,
                    artist: r.artist,
                    note: r.note,
                    votes: r.votes,
                    state: r.status.into(),
                })
                .collect()
        })
    }

    pub fn set_request_state(&self, id: u64, state: SongRequestState) -> Result<(), DecksError> {
        if self.with(|s| s.set_request_status(id, state.into()))? {
            Ok(())
        } else {
            Err(DecksError::NotFound {
                reason: format!("request {id}"),
            })
        }
    }

    pub fn set_party_open(&self, open: bool) -> Result<(), DecksError> {
        self.with(|s| s.set_party_open(open))
    }

    pub fn clear_done_requests(&self) -> Result<(), DecksError> {
        self.with(|s| s.clear_done_requests())
    }

    pub fn clients(&self) -> Result<Vec<RemoteClient>, DecksError> {
        self.with(|s| {
            s.clients()
                .into_iter()
                .map(|c| RemoteClient {
                    id: c.id,
                    role: c.role.into(),
                    address: c.addr,
                })
                .collect()
        })
    }

    /// Stop the server and disconnect everyone. A deck that plays because a phone holds CUE
    /// goes back to its cue point, paused (no phone can let go of it any more). Idempotent;
    /// dropping the object does the same.
    pub fn stop(&self) {
        let server = {
            let mut guard = lock(&self.server);
            let server = guard.take();
            if server.is_some() {
                self.release_holds();
            }
            server
        };
        // Joins the accept thread (a few tens of ms): not under the lock.
        drop(server);
    }

    pub fn is_running(&self) -> bool {
        lock(&self.server).is_some()
    }
}

impl DecksRemote {
    /// Bind to a specific address (tests use loopback).
    pub fn start_on(bind: IpAddr, port: u16, party_open: bool) -> Result<Arc<Self>, DecksError> {
        let server = RemoteServer::start(RemoteConfig {
            bind,
            port,
            party_open,
        })
        .map_err(|e| DecksError::Unsupported {
            reason: format!("cannot open the remote port: {e}"),
        })?;
        let host = if bind.is_unspecified() {
            decks_remote::lan_ip()
        } else {
            bind
        };
        Ok(Arc::new(Self {
            server: Mutex::new(Some(server)),
            host,
            titles: Mutex::new(Vec::new()),
            id: NEXT_SERVER.fetch_add(1, Ordering::Relaxed),
            locked: AtomicBool::new(false),
            releaser: Mutex::new(None),
        }))
    }
}

impl Drop for DecksRemote {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    use super::*;
    use crate::engine::cue_button::{CueSend, CueState, DeckView};
    use crate::{DeckSnapshot, DecksEngineConfig, LoadState};

    const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
    /// Server number of the pure tests, and another server on the same engine.
    const SERVER: u64 = 900_001;
    const FOREIGN: u64 = 900_002;
    /// Connections of the two test phones.
    const PHONE: u64 = 7;
    const OTHER: u64 = 8;

    fn phone(conn: u64) -> CueHolder {
        CueHolder::Remote {
            server: SERVER,
            conn,
        }
    }

    #[derive(Default)]
    struct MockInner {
        calls: Vec<String>,
        views: Vec<DeckView>,
        cue: Vec<CueState>,
        /// How many hold releasers were taken ([`RemoteTarget::releaser`]).
        releasers: u32,
    }

    impl MockInner {
        fn send(&mut self, deck: usize, send: Option<CueSend>) {
            match send {
                Some(CueSend::Play) => {
                    self.views[deck].playing = true;
                    self.calls.push(format!("play {deck}"));
                }
                Some(CueSend::Return(p)) => {
                    self.views[deck].playing = false;
                    self.views[deck].position = p;
                    self.calls.push(format!("pause {deck}"));
                    self.calls.push(format!("seek {deck} {p}"));
                }
                None => {}
            }
        }

        fn end(&mut self, keep: &dyn Fn(CueHolder) -> bool, now: Instant) -> u32 {
            let mut ended = 0;
            for i in 0..self.cue.len() {
                if !self.cue[i].has_hold_not_kept(keep) {
                    continue;
                }
                let view = self.views[i];
                let send = self.cue[i].end_hold_unless(view, keep, now);
                self.send(i, send);
                ended += 1;
            }
            ended
        }
    }

    /// Records every engine call; CUE runs the real button state machine on four test decks
    /// (track 1 loaded on each, paused at 0 s, cue point 0 s).
    #[derive(Clone)]
    struct Mock(Arc<Mutex<MockInner>>);

    impl Mock {
        fn new() -> Self {
            let view = DeckView {
                loaded: true,
                playing: false,
                position: 0.0,
                track: 1,
            };
            Mock(Arc::new(Mutex::new(MockInner {
                calls: Vec::new(),
                views: vec![view; 4],
                cue: vec![CueState::for_track(1, 0.0); 4],
                releasers: 0,
            })))
        }

        /// Deck `deck` paused at `position` with its cue point at `point`.
        fn with_deck(self, deck: usize, position: f64, point: f64) -> Self {
            {
                let mut m = lock(&self.0);
                m.views[deck].position = position;
                m.cue[deck] = CueState::for_track(1, point);
            }
            self
        }

        fn take(&self) -> Vec<String> {
            std::mem::take(&mut lock(&self.0).calls)
        }

        fn log(&self, s: String) -> Result<(), DecksError> {
            lock(&self.0).calls.push(s);
            Ok(())
        }

        fn view(&self, deck: usize) -> DeckView {
            lock(&self.0).views[deck]
        }

        fn set_view(&self, deck: usize, f: impl FnOnce(&mut DeckView)) {
            f(&mut lock(&self.0).views[deck]);
        }

        fn holder(&self, deck: usize) -> Option<CueHolder> {
            lock(&self.0).cue[deck].holder()
        }

        fn releasers(&self) -> u32 {
            lock(&self.0).releasers
        }
    }

    impl RemoteTarget for Mock {
        fn play(&self, deck: u8) -> Result<(), DecksError> {
            let mut m = lock(&self.0);
            let d = usize::from(deck);
            m.cue[d].asked_play(Instant::now());
            m.views[d].playing = true;
            m.calls.push(format!("play {deck}"));
            Ok(())
        }
        fn pause(&self, deck: u8) -> Result<(), DecksError> {
            let mut m = lock(&self.0);
            let d = usize::from(deck);
            m.cue[d].asked_pause(Instant::now());
            m.views[d].playing = false;
            m.calls.push(format!("pause {deck}"));
            Ok(())
        }
        fn cue_by(
            &self,
            deck: u8,
            by: CueHolder,
            pressed: bool,
            now: Instant,
        ) -> Result<(), DecksError> {
            let mut m = lock(&self.0);
            let d = usize::from(deck);
            let view = m.views[d];
            let step = m.cue[d].button(view, by, pressed, now);
            m.send(d, step.send);
            Ok(())
        }
        fn hot_cue(&self, deck: u8, slot: u8) -> Result<(), DecksError> {
            self.log(format!("hot_cue {deck} {slot}"))
        }
        fn auto_loop(&self, deck: u8, beats: f64) -> Result<(), DecksError> {
            self.log(format!("auto_loop {deck} {beats}"))
        }
        fn exit_loop(&self, deck: u8) -> Result<(), DecksError> {
            self.log(format!("exit_loop {deck}"))
        }
        fn jump_beats(&self, deck: u8, beats: f64) -> Result<(), DecksError> {
            self.log(format!("jump_beats {deck} {beats}"))
        }
        fn sync(&self, deck: u8, lock: bool) -> Result<(), DecksError> {
            self.log(format!("sync {deck} {lock}"))
        }
        fn volume(&self, deck: u8, value: f32) -> Result<(), DecksError> {
            self.log(format!("volume {deck} {value}"))
        }
        fn eq(&self, deck: u8, band: EqBand, db: f32) -> Result<(), DecksError> {
            let band = match band {
                EqBand::Low => "low",
                EqBand::Mid => "mid",
                EqBand::High => "high",
            };
            self.log(format!("eq {deck} {band} {db}"))
        }
        fn filter(&self, deck: u8, value: f32) -> Result<(), DecksError> {
            self.log(format!("filter {deck} {value}"))
        }
        fn crossfader(&self, value: f32) -> Result<(), DecksError> {
            self.log(format!("crossfader {value}"))
        }
        fn master_volume(&self, value: f32) -> Result<(), DecksError> {
            self.log(format!("master {value}"))
        }
        fn end_holds(&self, keep: &dyn Fn(CueHolder) -> bool, now: Instant) -> u32 {
            lock(&self.0).end(keep, now)
        }
        fn target_id(&self) -> usize {
            Arc::as_ptr(&self.0) as usize
        }
        fn releaser(&self) -> HoldReleaser {
            lock(&self.0).releasers += 1;
            let inner = Arc::clone(&self.0);
            Box::new(
                move |keep: &dyn Fn(CueHolder) -> bool, now: Instant| -> u32 {
                    lock(&inner).end(keep, now)
                },
            )
        }
        fn state(&self, _titles: &[(Option<String>, Option<String>)]) -> RemoteState {
            RemoteState::default()
        }
    }

    const NONE: [&str; 0] = [];

    fn press(deck: u8) -> RemoteCommand {
        RemoteCommand::Cue {
            deck,
            pressed: true,
        }
    }

    fn release(deck: u8) -> RemoteCommand {
        RemoteCommand::Cue {
            deck,
            pressed: false,
        }
    }

    fn from(conn: u64, command: RemoteCommand) -> CommandFrom {
        CommandFrom {
            conn,
            client: format!("phone-{conn}"),
            command,
        }
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn pairing_qr_and_lifecycle() {
        let r = DecksRemote::start_on(IpAddr::V4(Ipv4Addr::LOCALHOST), 0, true).unwrap();
        let p = r.pairing(RemoteRole::Guest).unwrap();
        assert!(p.url.starts_with("http://127.0.0.1:"));
        assert!(p.url.contains("/party?t="));
        assert_eq!(p.qr_modules.len(), (p.qr_width * p.qr_width) as usize);
        let rotated = r.rotate(RemoteRole::Guest).unwrap();
        assert_ne!(rotated.url, p.url);
        assert!(r.requests().unwrap().is_empty());
        assert!(r.set_request_state(7, SongRequestState::Played).is_err());
        r.stop();
        assert!(!r.is_running());
        assert!(matches!(r.port(), Err(DecksError::NotRunning { .. })));
    }

    #[test]
    fn pump_publishes_a_state_for_a_stopped_engine_and_reports_refused_commands() {
        let engine = DecksEngine::new(DecksEngineConfig::default());
        let r = DecksRemote::start_on(IpAddr::V4(Ipv4Addr::LOCALHOST), 0, true).unwrap();
        r.set_track_labels(0, Some("Strobe".into()), Some("deadmau5".into()));
        let state = remote_state(&engine, &[(Some("Strobe".into()), Some("deadmau5".into()))]);
        assert_eq!(state.decks.len(), 4);
        assert_eq!(state.decks[0].title.as_deref(), Some("Strobe"));
        assert_eq!(state.decks[0].artist.as_deref(), Some("deadmau5"));
        assert!(!state.decks[0].playing);
        let rep = r.pump(&engine).unwrap();
        assert_eq!(rep.applied, 0);
        assert!(!rep.controls_locked);
        let by = phone(PHONE);
        let now = Instant::now();
        // A command against a stopped engine is refused, not panicking.
        assert!(apply(&engine, by, &RemoteCommand::Play { deck: 0 }, now).is_err());
        assert!(apply(&engine, by, &press(0), now).is_err());
        // Stored-while-stopped controls are accepted.
        let volume = |value: f32| RemoteCommand::Volume { deck: 1, value };
        assert_eq!(
            apply(&engine, by, &volume(0.5), now).ok(),
            Some(volume(0.5))
        );
        assert_eq!(engine.snapshot().decks[1].volume, 0.5);
        // The real engine never sees a value the server would have refused.
        assert!(matches!(
            apply(&engine, by, &volume(f32::NAN), now),
            Err(DecksError::InvalidArgument { .. })
        ));
        assert_eq!(engine.snapshot().decks[1].volume, 0.5);
        assert_eq!(
            apply(&engine, by, &volume(7.0), now).ok(),
            Some(volume(1.0))
        );
        assert_eq!(engine.snapshot().decks[1].volume, 1.0);
        // Nothing is held on a stopped engine; ending holds is a no-op, also once it is gone.
        assert_eq!(engine.end_cue_holds(&|_| false, now), 0);
        let release_later = engine.hold_releaser();
        assert_eq!(release_later(&|_| false, now), 0);
        drop(engine);
        assert_eq!(release_later(&|_| false, now), 0);
        assert_eq!(
            mixer_change(&RemoteCommand::Eq {
                deck: 1,
                band: REq::Mid,
                db: -3.0
            }),
            Some(RemoteMixerChange::Eq {
                deck: 1,
                band: EqBand::Mid,
                db: -3.0
            })
        );
        assert_eq!(mixer_change(&RemoteCommand::Play { deck: 0 }), None);
    }

    #[test]
    fn every_command_reaches_the_matching_engine_call() {
        let m = Mock::new().with_deck(1, 30.0, 12.5);
        let now = Instant::now();
        let cmds = [
            RemoteCommand::Play { deck: 0 },
            RemoteCommand::Pause { deck: 0 },
            RemoteCommand::HotCue { deck: 2, slot: 7 },
            RemoteCommand::LoopAuto {
                deck: 3,
                beats: 0.5,
            },
            RemoteCommand::LoopExit { deck: 3 },
            RemoteCommand::BeatJump {
                deck: 0,
                beats: -8.0,
            },
            RemoteCommand::Sync {
                deck: 1,
                lock: true,
            },
            RemoteCommand::Volume {
                deck: 1,
                value: 0.5,
            },
            RemoteCommand::Eq {
                deck: 0,
                band: REq::Low,
                db: -26.0,
            },
            RemoteCommand::Eq {
                deck: 0,
                band: REq::Mid,
                db: 1.5,
            },
            RemoteCommand::Eq {
                deck: 0,
                band: REq::High,
                db: 6.0,
            },
            RemoteCommand::Filter {
                deck: 2,
                value: -0.25,
            },
            RemoteCommand::Crossfader { value: -1.0 },
            RemoteCommand::MasterVolume { value: 0.75 },
        ];
        for c in &cmds {
            assert_eq!(apply(&m, phone(PHONE), c, now).ok().as_ref(), Some(c));
        }
        assert_eq!(
            m.take(),
            [
                "play 0",
                "pause 0",
                "hot_cue 2 7",
                "auto_loop 3 0.5",
                "exit_loop 3",
                "jump_beats 0 -8",
                "sync 1 true",
                "volume 1 0.5",
                "eq 0 low -26",
                "eq 0 mid 1.5",
                "eq 0 high 6",
                "filter 2 -0.25",
                "crossfader -1",
                "master 0.75",
            ]
        );
        // CUE on a paused deck away from its cue point sets the cue point: no engine call.
        assert!(apply(&m, phone(PHONE), &press(1), now).is_ok());
        assert_eq!(m.take(), NONE);
    }

    /// Every command that carries a number, built from one value.
    fn numeric(v: f64) -> Vec<RemoteCommand> {
        let f = v as f32;
        let mut out = vec![
            RemoteCommand::LoopAuto { deck: 0, beats: v },
            RemoteCommand::BeatJump { deck: 0, beats: v },
            RemoteCommand::Volume { deck: 0, value: f },
            RemoteCommand::Filter { deck: 0, value: f },
            RemoteCommand::Crossfader { value: f },
            RemoteCommand::MasterVolume { value: f },
        ];
        for band in [REq::Low, REq::Mid, REq::High] {
            out.push(RemoteCommand::Eq {
                deck: 0,
                band,
                db: f,
            });
        }
        out
    }

    #[test]
    fn non_finite_and_out_of_range_values_never_reach_the_engine() {
        let now = Instant::now();
        let by = phone(PHONE);
        // `apply` is handed commands as a phone could send them, NOT validated by the server.
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let m = Mock::new();
            for c in numeric(bad) {
                assert!(
                    matches!(
                        apply(&m, by, &c, now),
                        Err(DecksError::InvalidArgument { .. })
                    ),
                    "{c:?}"
                );
            }
            assert_eq!(m.take(), NONE, "{bad}: no engine call at all");
        }
        // Out of range: a loop or a jump is refused; a continuous control arrives clamped.
        let m = Mock::new();
        for c in numeric(1000.0) {
            let _ = apply(&m, by, &c, now);
        }
        assert_eq!(
            m.take(),
            [
                "volume 0 1",
                "filter 0 1",
                "crossfader 1",
                "master 1",
                "eq 0 low 6",
                "eq 0 mid 6",
                "eq 0 high 6",
            ]
        );
        for c in numeric(-1000.0) {
            let _ = apply(&m, by, &c, now);
        }
        assert_eq!(
            m.take(),
            [
                "volume 0 0",
                "filter 0 -1",
                "crossfader -1",
                "master 0",
                "eq 0 low -26",
                "eq 0 mid -26",
                "eq 0 high -26",
            ]
        );
        // Whole numbers out of range and lengths that are no length.
        for c in [
            RemoteCommand::Play { deck: 4 },
            press(200),
            release(4),
            RemoteCommand::HotCue { deck: 0, slot: 8 },
            RemoteCommand::HotCue { deck: 0, slot: 255 },
            RemoteCommand::HotCue { deck: 4, slot: 0 },
            RemoteCommand::LoopAuto {
                deck: 0,
                beats: 0.0,
            },
            RemoteCommand::LoopAuto {
                deck: 0,
                beats: 64.5,
            },
            RemoteCommand::BeatJump {
                deck: 0,
                beats: 0.0,
            },
            RemoteCommand::BeatJump {
                deck: 0,
                beats: -129.0,
            },
            RemoteCommand::Volume {
                deck: 4,
                value: 0.5,
            },
            RemoteCommand::Eq {
                deck: 255,
                band: REq::Low,
                db: 0.0,
            },
        ] {
            assert!(apply(&m, by, &c, now).is_err(), "{c:?}");
            assert_eq!(m.take(), NONE, "{c:?}");
        }
        // The pump reports them and echoes the mixer value that was applied, not the one sent.
        let cmds = [
            from(PHONE, RemoteCommand::Crossfader { value: f32::NAN }),
            from(PHONE, RemoteCommand::MasterVolume { value: 9.0 }),
        ];
        let done = pump_engine(&m, SERVER, &cmds, false, |_| true, now);
        assert_eq!(done.applied, 1);
        assert_eq!(done.errors.len(), 1);
        assert!(done.errors[0].starts_with("phone-7: "), "{:?}", done.errors);
        assert_eq!(
            done.mixer_changes,
            [RemoteMixerChange::MasterVolume { value: 1.0 }]
        );
        assert_eq!(m.take(), ["master 1"]);
    }

    #[test]
    fn a_phone_that_disappears_while_holding_cue_stops_the_deck_on_the_cue_point() {
        let m = Mock::new()
            .with_deck(0, 12.5, 12.5)
            .with_deck(1, 60.0, 60.0);
        let t0 = Instant::now();
        // Two phones hold CUE, one on each deck: both decks play.
        let cmds = [from(PHONE, press(0)), from(OTHER, press(1))];
        let done = pump_engine(&m, SERVER, &cmds, false, |_| true, t0);
        assert_eq!(done.applied, 2);
        assert_eq!(m.take(), ["play 0", "play 1"]);
        m.set_view(0, |d| d.position = 31.0);
        // While both are connected nothing happens, however many pump steps pass.
        for i in 1..=40 {
            pump_engine(&m, SERVER, &[], false, |_| true, t0 + ms(50 * i));
        }
        assert_eq!(m.take(), NONE);
        assert!(m.view(0).playing && m.view(1).playing);
        // PHONE leaves the Wi-Fi with the finger down: no release ever arrives. Its deck stops
        // on the cue point; the other plays on.
        pump_engine(&m, SERVER, &[], false, |c| c == OTHER, t0 + ms(7000));
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);
        assert!(!m.view(0).playing && m.view(0).position == 12.5);
        assert!(m.view(1).playing);
        assert_eq!((m.holder(0), m.holder(1)), (None, Some(phone(OTHER))));
        // Once only; a release that arrives late from the vanished phone is not a second one.
        let late = [from(PHONE, release(0))];
        pump_engine(&m, SERVER, &late, false, |c| c == OTHER, t0 + ms(7100));
        assert_eq!(m.take(), NONE);
    }

    #[test]
    fn the_first_holder_owns_cue_and_other_holders_are_not_this_servers_to_end() {
        let m = Mock::new()
            .with_deck(0, 12.5, 12.5)
            .with_deck(1, 5.0, 5.0)
            .with_deck(2, 9.0, 9.0);
        let t0 = Instant::now();
        pump_engine(&m, SERVER, &[from(PHONE, press(0))], false, |_| true, t0);
        assert_eq!(m.take(), ["play 0"]);
        m.set_view(0, |d| d.position = 14.0);
        // A second phone's press and release on that deck change nothing.
        let cmds = [from(OTHER, press(0)), from(OTHER, release(0))];
        pump_engine(&m, SERVER, &cmds, false, |_| true, t0 + ms(500));
        assert_eq!(m.take(), NONE);
        assert!(m.view(0).playing);
        assert_eq!(m.holder(0), Some(phone(PHONE)));
        // The second phone dropping off does not matter while the holder is there.
        pump_engine(&m, SERVER, &[], false, |c| c == PHONE, t0 + ms(900));
        assert_eq!(m.take(), NONE);
        // The app's own button holds deck B, a phone of ANOTHER server holds deck C: a pump of
        // this server with nobody connected and the controls locked ends only its own hold.
        let foreign = CueHolder::Remote {
            server: FOREIGN,
            conn: PHONE,
        };
        m.cue_by(1, CueHolder::Local, true, t0 + ms(1000)).unwrap();
        m.cue_by(2, foreign, true, t0 + ms(1000)).unwrap();
        assert_eq!(m.take(), ["play 1", "play 2"]);
        pump_engine(&m, SERVER, &[], true, |_| false, t0 + ms(1100));
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);
        assert_eq!(
            (m.holder(0), m.holder(1), m.holder(2)),
            (None, Some(CueHolder::Local), Some(foreign))
        );
        // A phone cannot let go of the app's own hold either.
        pump_engine(
            &m,
            SERVER,
            &[from(PHONE, release(1))],
            false,
            |_| true,
            t0 + ms(1200),
        );
        assert_eq!(m.take(), NONE);
        assert!(m.view(1).playing);
    }

    #[test]
    fn the_djs_own_cue_button_takes_a_deck_back_from_a_phone() {
        let m = Mock::new().with_deck(0, 12.5, 12.5);
        let t0 = Instant::now();
        pump_engine(&m, SERVER, &[from(PHONE, press(0))], false, |_| true, t0);
        assert_eq!(m.take(), ["play 0"]);
        m.set_view(0, |d| d.position = 14.0);
        // A guest previews the deck; the DJ presses CUE on it in the app (or on the controller).
        m.cue_by(0, CueHolder::Local, true, t0 + ms(500)).unwrap();
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);
        assert!(!m.view(0).playing && m.view(0).position == 12.5);
        assert_eq!(m.holder(0), None);
        // The DJ lets go, the phone lets go late, the phone drops off: nothing more happens.
        m.cue_by(0, CueHolder::Local, false, t0 + ms(600)).unwrap();
        let late = [from(PHONE, release(0))];
        pump_engine(&m, SERVER, &late, false, |_| true, t0 + ms(700));
        pump_engine(&m, SERVER, &[], false, |_| false, t0 + ms(800));
        assert_eq!(m.take(), NONE);
        // PLAY / PAUSE in the app during a phone's hold end it where the deck is.
        for (dj_plays, playing) in [(true, true), (false, false)] {
            let m = Mock::new().with_deck(0, 12.5, 12.5);
            pump_engine(&m, SERVER, &[from(PHONE, press(0))], false, |_| true, t0);
            m.set_view(0, |d| d.position = 14.0);
            m.take();
            if dj_plays {
                m.play(0).unwrap();
            } else {
                m.pause(0).unwrap();
            }
            m.take();
            let late = [from(PHONE, release(0))];
            pump_engine(&m, SERVER, &late, false, |_| true, t0 + ms(700));
            assert_eq!(m.take(), NONE, "DJ plays: {dj_plays}");
            assert_eq!(m.view(0).playing, playing);
            assert_eq!(m.view(0).position, 14.0, "no seek back");
        }
    }

    #[test]
    fn locked_controls_drop_phone_commands_and_end_holds() {
        let m = Mock::new().with_deck(0, 12.5, 12.5);
        let t0 = Instant::now();
        pump_engine(&m, SERVER, &[from(PHONE, press(0))], false, |_| true, t0);
        assert_eq!(m.take(), ["play 0"]);
        // The DJ locks the phones: the held CUE ends at the next step, phone still connected.
        pump_engine(&m, SERVER, &[], true, |_| true, t0 + ms(400));
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);
        assert_eq!(m.holder(0), None);
        // Whatever a phone still gets through is dropped here as well.
        let cmds = [
            from(PHONE, RemoteCommand::Play { deck: 0 }),
            from(PHONE, RemoteCommand::MasterVolume { value: 0.0 }),
            from(PHONE, RemoteCommand::Crossfader { value: 1.0 }),
            from(PHONE, RemoteCommand::Pause { deck: 1 }),
            from(PHONE, press(0)),
            from(PHONE, RemoteCommand::HotCue { deck: 0, slot: 0 }),
            from(PHONE, release(0)),
        ];
        let done = pump_engine(&m, SERVER, &cmds, true, |_| true, t0 + ms(800));
        assert_eq!(m.take(), NONE, "locked: no engine call");
        assert_eq!(done.applied, 1, "only letting go of CUE is taken");
        assert!(done.mixer_changes.is_empty() && done.errors.is_empty());
        // Unlocked, the same commands act.
        let done = pump_engine(&m, SERVER, &cmds[..3], false, |_| true, t0 + ms(1200));
        assert_eq!(m.take(), ["play 0", "master 0", "crossfader 1"]);
        assert_eq!(done.applied, 3);
        assert_eq!(done.mixer_changes.len(), 2);
    }

    /// A phone remote on a real loopback socket, paired as a controller. The WebSocket
    /// handshake is written by hand: the crate has no WebSocket client.
    fn connect(r: &DecksRemote, client: &str) -> TcpStream {
        let url = r.pairing(RemoteRole::Controller).unwrap().url;
        let token = url.split("?t=").nth(1).unwrap().to_string();
        let port = r.port().unwrap();
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        write!(
            s,
            "GET /ws?t={token}&c={client} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        )
        .unwrap();
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            assert_eq!(s.read(&mut byte).unwrap(), 1, "handshake answer");
            head.push(byte[0]);
        }
        assert!(
            head.starts_with(b"HTTP/1.1 101"),
            "{}",
            String::from_utf8_lossy(&head)
        );
        s
    }

    /// One masked text frame from a phone (payload under 126 bytes).
    fn say(s: &mut TcpStream, json: &str) {
        assert!(json.len() < 126);
        let mask = [0x12u8, 0x34, 0x56, 0x78];
        let mut frame = vec![0x81, 0x80 | json.len() as u8];
        frame.extend_from_slice(&mask);
        frame.extend(json.bytes().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        s.write_all(&frame).unwrap();
    }

    /// Pump like the app's UI tick until the engine saw `done` (5 s at most).
    fn pump_until(
        r: &DecksRemote,
        m: &Mock,
        what: &str,
        done: impl Fn(&[String]) -> bool,
    ) -> Vec<String> {
        let end = Instant::now() + Duration::from_secs(5);
        let mut calls = Vec::new();
        while Instant::now() < end {
            r.pump_target(m).unwrap();
            calls.extend(m.take());
            if done(&calls) {
                return calls;
            }
            std::thread::sleep(ms(10));
        }
        panic!("timed out: {what}; engine calls so far: {calls:?}");
    }

    const HOLD_A: &str = r#"{"type":"command","command":{"cmd":"cue","deck":0,"pressed":true}}"#;
    const HOLD_B: &str = r#"{"type":"command","command":{"cmd":"cue","deck":1,"pressed":true}}"#;
    const PLAY_C: &str = r#"{"type":"command","command":{"cmd":"play","deck":2}}"#;

    #[test]
    fn a_real_phone_that_goes_away_while_holding_cue_lets_the_deck_go() {
        let m = Mock::new()
            .with_deck(0, 12.5, 12.5)
            .with_deck(1, 60.0, 60.0);
        let r = DecksRemote::start_on(LOOPBACK, 0, true).unwrap();
        let mut closing = connect(&r, "closing");
        let mut rotated = connect(&r, "rotated");
        say(&mut closing, HOLD_A);
        let calls = pump_until(&r, &m, "first hold", |c| !c.is_empty());
        assert_eq!(calls, ["play 0"]);
        say(&mut rotated, HOLD_B);
        let calls = pump_until(&r, &m, "second hold", |c| !c.is_empty());
        assert_eq!(calls, ["play 1"]);
        let (a, b) = (m.holder(0).unwrap(), m.holder(1).unwrap());
        assert_ne!(a, b, "each hold names its own connection");
        assert!(matches!(a, CueHolder::Remote { server, .. } if server == r.id));
        // The tab of the first phone is killed with the finger down: no release is sent.
        drop(closing);
        let calls = pump_until(&r, &m, "socket closed", |c| !c.is_empty());
        assert_eq!(calls, ["pause 0", "seek 0 12.5"]);
        assert!(m.view(1).playing, "the other phone still holds its deck");
        // "New code" for the remote: the server disconnects the second phone.
        r.rotate(RemoteRole::Controller).unwrap();
        let calls = pump_until(&r, &m, "code rotated", |c| !c.is_empty());
        assert_eq!(calls, ["pause 1", "seek 1 60"]);
        assert_eq!((m.holder(0), m.holder(1)), (None, None));
        drop(rotated);
        r.stop();
        assert_eq!(m.take(), NONE, "nothing is left for stop to end");
    }

    #[test]
    fn stopping_or_dropping_the_server_ends_the_holds_of_its_phones_only() {
        let m = Mock::new()
            .with_deck(0, 12.5, 12.5)
            .with_deck(1, 60.0, 60.0)
            .with_deck(3, 5.0, 5.0);
        let r = DecksRemote::start_on(LOOPBACK, 0, true).unwrap();
        // Stop before any pump: there is no engine to let go on, and nothing held.
        let idle = DecksRemote::start_on(LOOPBACK, 0, true).unwrap();
        idle.stop();
        idle.stop();
        let mut one = connect(&r, "one");
        let mut two = connect(&r, "two");
        say(&mut one, HOLD_A);
        say(&mut two, HOLD_B);
        pump_until(&r, &m, "two holds", |c| c.len() == 2);
        // The app's own CUE button holds deck D meanwhile.
        m.cue_by(3, CueHolder::Local, true, Instant::now()).unwrap();
        assert_eq!(m.take(), ["play 3"]);
        m.set_view(0, |d| d.position = 20.0);
        // Another track is loaded on deck B while its phone still holds CUE (loading stops the
        // deck) and the DJ starts it: stop must not touch it.
        m.set_view(1, |d| {
            *d = DeckView {
                loaded: true,
                playing: true,
                position: 3.0,
                track: 2,
            }
        });
        r.stop();
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);
        assert!(!m.view(0).playing && m.view(0).position == 12.5);
        assert!(m.view(1).playing && m.view(1).position == 3.0);
        assert_eq!(
            (m.holder(0), m.holder(1), m.holder(3)),
            (None, None, Some(CueHolder::Local))
        );
        assert!(!r.is_running());
        assert!(matches!(
            r.pump_target(&m),
            Err(DecksError::NotRunning { .. })
        ));
        // Idempotent.
        r.stop();
        assert_eq!(m.take(), NONE);
        drop((one, two));

        // Dropping the object (Kotlin `close()`, Swift deinit) without `stop()` does the same.
        let r = DecksRemote::start_on(LOOPBACK, 0, true).unwrap();
        let mut one = connect(&r, "one");
        say(&mut one, HOLD_A);
        let calls = pump_until(&r, &m, "hold before drop", |c| !c.is_empty());
        assert_eq!(calls, ["play 0"]);
        drop(r);
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);
        assert_eq!(m.holder(3), Some(CueHolder::Local));
    }

    #[test]
    fn one_hold_releaser_is_kept_per_engine_and_another_engine_frees_the_first() {
        let first = Mock::new().with_deck(0, 12.5, 12.5);
        let r = DecksRemote::start_on(LOOPBACK, 0, true).unwrap();
        for _ in 0..25 {
            r.pump_target(&first).unwrap();
        }
        assert_eq!(first.releasers(), 1, "taken once, not on every tick");
        let mut p = connect(&r, "one");
        say(&mut p, HOLD_A);
        let calls = pump_until(&r, &first, "hold", |c| !c.is_empty());
        assert_eq!(calls, ["play 0"]);
        assert_eq!(first.releasers(), 1);
        // The app hands the pump another engine: nobody pumps the first one again, so the
        // phone's hold on it is let go now.
        let second = Mock::new();
        assert_ne!(first.target_id(), second.target_id());
        r.pump_target(&second).unwrap();
        assert_eq!(first.take(), ["pause 0", "seek 0 12.5"]);
        assert_eq!(first.holder(0), None);
        assert_eq!((first.releasers(), second.releasers()), (1, 1));
        for _ in 0..5 {
            r.pump_target(&second).unwrap();
        }
        assert_eq!(second.releasers(), 1);
        // Back to the first: a fresh releaser for it, and stop lets go on the engine pumped last.
        say(&mut p, HOLD_A);
        let calls = pump_until(&r, &first, "hold on the first engine again", |c| {
            !c.is_empty()
        });
        assert_eq!(calls, ["play 0"]);
        assert_eq!(first.releasers(), 2);
        r.stop();
        assert_eq!(first.take(), ["pause 0", "seek 0 12.5"]);
        assert_eq!(second.take(), NONE);
    }

    #[test]
    fn the_controls_lock_reaches_the_server_the_report_and_the_holds() {
        let m = Mock::new().with_deck(0, 12.5, 12.5);
        let r = DecksRemote::start_on(LOOPBACK, 0, true).unwrap();
        assert!(!r.controls_locked());
        let mut p = connect(&r, "pocket");
        say(&mut p, HOLD_A);
        let calls = pump_until(&r, &m, "hold", |c| !c.is_empty());
        assert_eq!(calls, ["play 0"]);
        // Locking lets go of the held CUE at once, without waiting for the next pump.
        r.set_controls_locked(true).unwrap();
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);
        assert!(r.controls_locked());
        assert!(r.with(|s| s.controls_locked()).unwrap());
        assert!(r.pump_target(&m).unwrap().controls_locked);
        // A pocket touch: the server refuses it, nothing reaches the engine.
        say(&mut p, PLAY_C);
        say(&mut p, HOLD_A);
        for _ in 0..30 {
            assert_eq!(r.pump_target(&m).unwrap().applied, 0);
            std::thread::sleep(ms(10));
        }
        assert_eq!(m.take(), NONE);
        // Requests keep working while locked (the queue is not behind the lock).
        assert!(r.requests().unwrap().is_empty());
        r.set_party_open(false).unwrap();
        // Unlocked: the same phone controls the decks again.
        r.set_controls_locked(false).unwrap();
        assert!(!r.with(|s| s.controls_locked()).unwrap());
        say(&mut p, PLAY_C);
        let calls = pump_until(&r, &m, "play after unlock", |c| !c.is_empty());
        assert_eq!(calls, ["play 2"]);
        assert!(!r.pump_target(&m).unwrap().controls_locked);
        // The choice outlives the server; a stopped server cannot be (un)locked.
        r.set_controls_locked(true).unwrap();
        r.stop();
        assert!(r.controls_locked());
        assert!(matches!(
            r.set_controls_locked(false),
            Err(DecksError::NotRunning { .. })
        ));
        // A new server starts unlocked.
        let fresh = DecksRemote::start_on(LOOPBACK, 0, true).unwrap();
        assert!(!fresh.controls_locked());
        assert!(!fresh.with(|s| s.controls_locked()).unwrap());
    }

    /// A quiet stereo tone of `secs` seconds.
    fn write_tone(path: &std::path::Path, secs: f64) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 44_100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).expect("wav");
        for i in 0..(secs * 44_100.0) as usize {
            let t = i as f64 / 44_100.0;
            let s = (0.1 * (std::f64::consts::TAU * 220.0 * t).sin() * 32_000.0) as i16;
            w.write_sample(s).unwrap();
            w.write_sample(s).unwrap();
        }
        w.finalize().unwrap();
    }

    fn load_on_deck_a(e: &DecksEngine, path: &std::path::Path) {
        let ticket = e.load(0, path.display().to_string()).unwrap();
        let end = Instant::now() + Duration::from_secs(60);
        loop {
            let st = e.load_status(ticket).expect("ticket known");
            if st.state == LoadState::Ready {
                return;
            }
            assert!(
                !matches!(st.state, LoadState::Failed | LoadState::Cancelled),
                "{st:?}"
            );
            assert!(Instant::now() < end, "load timed out");
            std::thread::sleep(ms(10));
        }
    }

    /// Wait (5 s at most) until deck A reports `ok`.
    fn deck_a(e: &DecksEngine, what: &str, ok: impl Fn(&DeckSnapshot) -> bool) {
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            let s = e.snapshot();
            if ok(&s.decks[0]) {
                return;
            }
            assert!(Instant::now() < end, "{what}: {:?}", s.decks[0]);
            std::thread::sleep(ms(10));
        }
    }

    fn at(d: &DeckSnapshot, sec: f64) -> bool {
        (d.playhead_sec - sec).abs() < 0.05
    }

    #[test]
    fn the_real_engine_ends_orphan_holds_and_survives_a_fast_second_press() {
        let dir = tempfile::tempdir().unwrap();
        let (one, two) = (dir.path().join("one.wav"), dir.path().join("two.wav"));
        write_tone(&one, 8.0);
        write_tone(&two, 3.0);
        let e = DecksEngine::new(DecksEngineConfig::default());
        // Silent: the channel fader is stored while stopped.
        e.set_volume(0, 0.0).unwrap();
        load_on_deck_a(&e, &one);
        if let Err(err) = e.start() {
            eprintln!("no audio output, live cue part skipped: {err}");
            return;
        }
        let gone = |h: CueHolder| phone_of(SERVER, h).is_none();
        e.set_cue_point(0, 1.0).unwrap();
        e.seek(0, 1.0).unwrap();
        // A phone holds CUE on the cue point (the seek was just sent: it counts already).
        assert_eq!(
            e.cue_from(0, phone(PHONE), true, Instant::now()).ok(),
            Some(None)
        );
        deck_a(&e, "held by the phone", |d| d.playing);
        // Another phone, and a release of the app's own button, change nothing meanwhile.
        let other = e.cue_from(0, phone(OTHER), true, Instant::now());
        assert_eq!(other.ok(), Some(None));
        e.cue(0, false).unwrap();
        let other = e.cue_from(0, phone(OTHER), false, Instant::now());
        assert_eq!(other.ok(), Some(None));
        std::thread::sleep(ms(150));
        assert!(
            e.snapshot().decks[0].playing,
            "still held by the first phone"
        );
        // The phone is still there: nothing to end. Then it is gone.
        assert_eq!(e.end_cue_holds(&|_| true, Instant::now()), 0);
        assert_eq!(e.end_cue_holds(&gone, Instant::now()), 1);
        deck_a(&e, "back on the cue point", |d| !d.playing && at(d, 1.0));
        assert_eq!(e.end_cue_holds(&|_| false, Instant::now()), 0, "once only");

        // The DJ's own CUE button takes the deck back from a phone that previews it: back on
        // the cue point, paused; the phone holds nothing any more.
        std::thread::sleep(ms(200));
        assert_eq!(
            e.cue_from(0, phone(PHONE), true, Instant::now()).ok(),
            Some(None)
        );
        deck_a(&e, "held by the phone again", |d| d.playing);
        e.cue(0, true).unwrap();
        deck_a(&e, "taken back by the app's button", |d| {
            !d.playing && at(d, 1.0)
        });
        e.cue(0, false).unwrap();
        assert_eq!(e.end_cue_holds(&gone, Instant::now()), 0, "no hold is left");
        assert_eq!(
            e.cue_from(0, phone(PHONE), false, Instant::now()).ok(),
            Some(None)
        );
        std::thread::sleep(ms(150));
        let snap = e.snapshot();
        let d = &snap.decks[0];
        assert!(
            !d.playing && at(d, 1.0),
            "the late release did nothing: {d:?}"
        );
        assert_eq!(d.cue_point_sec, 1.0);

        // A second press before the audio thread applied "pause + seek" must not take the old
        // playhead for a new cue point: it previews from the cue point. The deck first plays
        // two seconds on, so "from the cue point" is told from "from the old playhead" by the
        // position the deck had BEFORE the press, however late this thread is polled.
        e.play(0).unwrap();
        deck_a(&e, "playing on", |d| d.playing && d.playhead_sec > 3.0);
        let before = e.snapshot().decks[0].playhead_sec;
        e.cue(0, true).unwrap();
        e.cue(0, false).unwrap();
        e.cue(0, true).unwrap();
        assert_eq!(e.snapshot().decks[0].cue_point_sec, 1.0);
        deck_a(&e, "preview from the cue point", |d| {
            d.playing && d.playhead_sec > 0.95 && d.playhead_sec < before
        });
        // The app's own hold is not the remote's to end; its release goes back.
        assert_eq!(e.end_cue_holds(&gone, Instant::now()), 0);
        e.cue(0, false).unwrap();
        deck_a(&e, "released", |d| !d.playing && at(d, 1.0));
        assert_eq!(e.snapshot().decks[0].cue_point_sec, 1.0);

        // Another track loaded while a phone holds CUE: the hold is over and the new track is
        // not paused or moved by the late release, by the phone vanishing or by a stop.
        std::thread::sleep(ms(200));
        assert_eq!(
            e.cue_from(0, phone(PHONE), true, Instant::now()).ok(),
            Some(None)
        );
        deck_a(&e, "held again", |d| d.playing);
        load_on_deck_a(&e, &two);
        deck_a(&e, "the new track is loaded, stopped", |d| {
            !d.playing && (d.duration_sec - 3.0).abs() < 0.01
        });
        e.play(0).unwrap();
        deck_a(&e, "the new track plays", |d| d.playing);
        assert_eq!(
            e.cue_from(0, phone(PHONE), false, Instant::now()).ok(),
            Some(None)
        );
        assert_eq!(e.end_cue_holds(&|_| false, Instant::now()), 0);
        std::thread::sleep(ms(150));
        assert!(
            e.snapshot().decks[0].playing,
            "the new track was not touched"
        );
        e.stop();
    }
}
