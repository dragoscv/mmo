//! Connected mode in the desktop shell (WP19-42): phone remote, second screen and party
//! requests over the LAN. Tauri side of `decks-remote` (the crate owns the server, the three
//! role tokens, the request queue and the phone pages; `docs/decks/remote.md`).
//!
//! * [`RemoteCtl`] holds the running [`RemoteServer`] (none until the DJ turns Connect on), the
//!   deck labels the library knows and the transport cue point of every deck.
//! * A pump thread ([`init`]) runs every 50 ms while the server runs: validated phone commands
//!   go to the engine through [`apply`] (same mirror updates and engine commands as the Tauri
//!   deck commands in `lib.rs`, so the app's own knobs follow through `mixer://state`), then the
//!   engine state is published to the phones. It parks while the server is off.
//! * The UI hears about devices and requests through the `remote://state` event (at most twice
//!   a second, only when something changed) and about a cue point a phone moved through
//!   `remote://cue`.
//!
//! CUE on the phone is the CDJ button (`decks-ffi` `DecksEngine::cue`): playing = back to the
//! cue point and pause; paused on the cue point = play while held; paused elsewhere = set the
//! cue point there. `mixai-core` has no transport cue point, so it lives here, per deck and per
//! track; the UI sends its own point with the deck labels (`remote_set`) and takes over a point
//! a phone moved (`remote://cue`).
//!
//! A held CUE belongs to the connection that pressed it ([`CueDeck::hold`]): another phone's
//! CUE on that deck is ignored until it is let go. The hold ends by itself, with the deck
//! paused back on the cue point, when that phone is gone (the server drops a silent phone
//! within `decks_remote::DEAD_AFTER`), when the DJ locks the phone controls and when Connect is
//! turned off; it ends without touching the deck when another track is loaded. The DJ's own
//! controls end it too ([`note_local`], called by the deck commands in `lib.rs` before they
//! touch the engine): PLAY keeps the deck playing, PAUSE stops it where it is, and the app's
//! CUE (pause + seek to the cue point) takes the deck back; the phone's later release changes
//! nothing. Same rules as the native binding (`decks-ffi` `cue_button.rs`). Transport commands
//! of a mapped MIDI controller are noted the same way (`midi.rs`). Not noted: the co-pilot
//! (`copilot.rs`) and the legacy `deck_sync`.
//!
//! Which track a hold began on is told by the engine's track id and, because two files loaded
//! without a library id share the same (empty) id, by the track length to 10 ms
//! ([`SAME_TRACK_SEC`]): the shell has no load counter to read. Two id-less files of the same
//! length to 10 ms loaded during one hold count as the same track, so the release can seek the
//! new one to the old cue point (a limit, documented in `docs/decks/remote.md`).
//!
//! The engine applies a command at its next audio callback and reports its state once per
//! callback, so right after a command the snapshot is one buffer old. For that long
//! ([`SETTLE`]) the CUE button goes by what this module asked for ([`Expect`]), not by the
//! snapshot: a second press right after "back to the cue point" must not take the old playhead
//! for a new cue point. The app's own transport commands are noted the same way, so a phone's
//! press right after the DJ's hot cue, beat jump or sync does not set the cue point where the
//! playhead just was.
//!
//! "Controls locked" ([`Ctl::locked`], `remote_set`): the server refuses every phone command
//! except letting go of CUE; song requests, votes and moderation keep working.
//!
//! Lock order: `RemoteCtl` then `EngineState`. Nothing takes them the other way round.

use std::net::IpAddr;
use std::sync::{Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use decks_remote::{
    CommandFrom, EqBand, RemoteCommand, RemoteConfig, RemoteDeck, RemoteServer, RemoteState,
    RequestStatus, Role, SongRequestView,
};
use mixai_core::{Command, DeckId, DeckState, Engine, MixerState};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

use super::EngineState;

/// Devices, requests and the party switch changed (payload: [`RemoteEvent`]).
const STATE_EVENT: &str = "remote://state";
/// A phone moved the cue point of a deck (payload: [`CuePayload`]).
const CUE_EVENT: &str = "remote://cue";
/// Phone commands are applied and the deck state is published this often while the server runs.
const PUMP_INTERVAL: Duration = Duration::from_millis(50);
/// `remote://state` is offered to the UI at most this often.
const EVENT_INTERVAL: Duration = Duration::from_millis(500);
/// "On the cue point" tolerance, the same as the deck's CUE button in the UI.
const AT_CUE_SEC: f64 = 0.02;
/// How long the transport state this module asked for counts instead of the engine snapshot:
/// one audio buffer at the largest size (4096 frames at 44.1 kHz = 93 ms) plus one pump tick.
const SETTLE: Duration = Duration::from_millis(150);
/// Two track lengths closer than this are the same track (the engine reports whole ms).
const SAME_TRACK_SEC: f64 = 0.01;
/// Longest deck title / artist kept (characters).
const MAX_LABEL_CHARS: usize = 200;
/// Longest track id kept (bytes). Ids are library ids or file paths.
const MAX_ID_BYTES: usize = 4096;
/// Message of every command that needs the server while it is off. The UI recognises these
/// messages by their start (`src/remote/remote-core.ts` `errorKind`): keep them in step.
const NOT_RUNNING: &str = "connected mode is off";
/// `remote_start` without the pump thread (it could not be spawned at start-up): the server
/// would accept phones and drop every command, so it is not started at all.
const NO_PUMP: &str = "connected mode worker is not running";
/// Start of the message when the port cannot be opened (the OS reason follows).
const NO_PORT: &str = "cannot open the remote port";

// ---- state -------------------------------------------------------------------

/// Title and artist of a deck as the library knows them, valid for one track.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct DeckLabel {
    track_id: Option<String>,
    title: Option<String>,
    artist: Option<String>,
}

/// Where this module last sent the playhead of a deck.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Playhead {
    /// Sent to this position (seconds) with the deck paused.
    At(f64),
    /// Not moved by this module: the snapshot is right to within one buffer.
    Live,
    /// Moved by a jump the snapshot does not show yet (hot cue, beat jump, loop): unknown.
    Jumped,
}

/// What this module asked of a deck's transport, valid for [`SETTLE`] (module docs).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Expect {
    /// `None` = not changed by this module: the snapshot counts.
    playing: Option<bool>,
    playhead: Playhead,
    at: Instant,
}

/// A phone holding CUE on the cue point.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Hold {
    /// The connection that pressed (`ClientInfo::conn`): only it lets go.
    conn: u64,
    /// Length of the track when the hold began (seconds): with the track id it tells whether
    /// the deck still holds that track (two tracks loaded without an id have the same id; two
    /// of the same length to 10 ms are not told apart: module docs).
    duration: f64,
}

/// Transport cue point of a deck (seconds), valid for one track.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct CueDeck {
    track_id: Option<String>,
    point: f64,
    /// A phone holds CUE on the cue point: the deck plays until that phone lets go, or until
    /// it is gone.
    hold: Option<Hold>,
    expect: Option<Expect>,
}

impl CueDeck {
    /// Forget the hold and what was asked of the deck, without touching the deck.
    fn drop_hold(&mut self) {
        self.hold = None;
        self.expect = None;
    }

    /// The expectation still in force at `now`.
    fn expecting(&self, now: Instant) -> Option<Expect> {
        self.expect
            .filter(|e| now.saturating_duration_since(e.at) < SETTLE)
    }

    fn sent(&mut self, playing: Option<bool>, playhead: Playhead, now: Instant) {
        self.expect = Some(Expect {
            playing,
            playhead,
            at: now,
        });
    }

    /// A jump this module cannot predict was sent (the playing state stays as expected).
    fn sent_jump(&mut self, now: Instant) {
        let playing = self.expecting(now).and_then(|e| e.playing);
        self.sent(playing, Playhead::Jumped, now);
    }

    /// A transport command was sent to the deck, by a phone ([`apply`]) or by the app's own
    /// controls ([`note_local`]): PLAY / PAUSE end a hold (the deck stays where the DJ put it,
    /// the release changes nothing), a seek lands where it was sent, a jump nobody can predict
    /// here is unknown for [`SETTLE`].
    fn note(&mut self, what: LocalTransport, now: Instant) {
        match what {
            LocalTransport::Play => {
                // PLAY while CUE is held keeps the deck playing after the release.
                self.hold = None;
                self.sent(Some(true), Playhead::Live, now);
            }
            LocalTransport::Pause => {
                self.hold = None;
                // The deck stops within one buffer of the snapshot position: close enough
                // for a cue point set right after (the next press corrects it), and no press
                // is lost.
                self.sent(Some(false), Playhead::Live, now);
            }
            LocalTransport::Seek(sec) if sec.is_finite() => {
                let playing = self.expecting(now).and_then(|e| e.playing);
                self.sent(playing, Playhead::At(sec), now);
            }
            LocalTransport::Seek(_) | LocalTransport::Jump => self.sent_jump(now),
        }
    }
}

/// A transport command of the app's own controls (the Tauri deck commands in `lib.rs`), as
/// far as the CUE button cares.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum LocalTransport {
    Play,
    Pause,
    /// A seek to this position (seconds); a non-finite one counts as a jump.
    Seek(f64),
    /// Hot cue, beat jump, phase sync: the landing is not known here.
    Jump,
}

/// The app's own controls sent `what` to `deck` (`deck_play`, `deck_pause`, `deck_seek`,
/// `deck_jump_hot_cue`, `deck_beat_jump`, `deck_phase_sync` in `lib.rs`). Call it BEFORE
/// taking the engine lock (lock order: `RemoteCtl`, then `EngineState`; it takes and releases
/// the remote lock itself). Cheap: no allocation, one short lock, and nothing at all while
/// Connect is off and no phone holds CUE.
pub(crate) fn note_local(ctl: &RemoteCtl, deck: DeckId, what: LocalTransport, now: Instant) {
    let mut c = ctl.lock();
    let Ctl { server, cue, .. } = &mut *c;
    let cue = &mut cue[deck.index()];
    if server.is_none() && cue.hold.is_none() {
        return;
    }
    cue.note(what, now);
}

#[derive(Default)]
struct Ctl {
    server: Option<RemoteServer>,
    /// Address the pairing URLs name (the LAN address, or the bind address when one was given).
    host: Option<IpAddr>,
    labels: [DeckLabel; 4],
    cue: [CueDeck; 4],
    /// The DJ locked the phone controls (kept while the server is off; applied at the start).
    locked: bool,
    /// The pump thread, parked while the server is off. None = it could not be spawned.
    pump: Option<JoinHandle<()>>,
}

/// Managed state of the connected-mode server (`lib.rs` manages `RemoteCtl::default()`).
#[derive(Default)]
pub struct RemoteCtl(Mutex<Ctl>);

impl RemoteCtl {
    fn lock(&self) -> MutexGuard<'_, Ctl> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

// ---- wire types (camelCase towards the webview) ---------------------------------

/// Pairing data of one role: the URL and its QR code as an SVG (`currentColor`, no colour of
/// its own, 4-module quiet zone).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub role: Role,
    pub url: String,
    pub qr_svg: String,
}

/// A connected device.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientView {
    pub id: String,
    pub role: Role,
    pub addr: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub running: bool,
    pub port: Option<u16>,
    /// Address in the pairing URLs.
    pub host: Option<String>,
    pub url_controller: Option<String>,
    pub url_viewer: Option<String>,
    pub url_guest: Option<String>,
    /// Controller, viewer, guest (empty while off).
    pub pairings: Vec<Pairing>,
    pub clients: Vec<ClientView>,
    pub party_open: bool,
    pub requests_pending: u32,
    /// The DJ locked the phone controls (kept while off).
    pub controls_locked: bool,
}

/// Payload of `remote://state`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteEvent {
    running: bool,
    party_open: bool,
    controls_locked: bool,
    clients: Vec<ClientView>,
    requests: Vec<SongRequestView>,
}

/// Payload of `remote://cue`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CuePayload {
    deck: DeckId,
    sec: f64,
}

/// Deck label sent by the UI (`remote_set`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelReq {
    /// `a`..`d`.
    deck: String,
    #[serde(default)]
    track_id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    artist: Option<String>,
    /// The UI's transport cue point for this track (seconds, default 0 = start).
    #[serde(default)]
    cue_sec: Option<f64>,
}

// ---- parsing and validation ------------------------------------------------------

fn parse_role(s: &str) -> Result<Role, String> {
    match s {
        "controller" => Ok(Role::Controller),
        "viewer" => Ok(Role::Viewer),
        "guest" => Ok(Role::Guest),
        _ => Err(format!("invalid role '{s}' (controller, viewer or guest)")),
    }
}

/// A DJ decision on a request. `pending` is where requests start, not a decision.
fn parse_decision(s: &str) -> Result<RequestStatus, String> {
    match s {
        "accepted" => Ok(RequestStatus::Accepted),
        "rejected" => Ok(RequestStatus::Rejected),
        "played" => Ok(RequestStatus::Played),
        _ => Err(format!(
            "invalid status '{s}' (accepted, rejected or played)"
        )),
    }
}

/// Address to listen on: none / empty = every IPv4 interface. An IPv6 wildcard is refused: the
/// pairing URLs name the IPv4 LAN address, which such a socket does not serve on Windows.
fn parse_bind(s: Option<&str>) -> Result<IpAddr, String> {
    let s = s.map(str::trim).filter(|s| !s.is_empty());
    let Some(s) = s else {
        return Ok(IpAddr::from([0, 0, 0, 0]));
    };
    let ip: IpAddr = s
        .parse()
        .map_err(|_| format!("invalid bind address '{s}'"))?;
    if ip.is_ipv6() && ip.is_unspecified() {
        return Err("bind to 0.0.0.0 or to one address, not to the IPv6 wildcard".into());
    }
    Ok(ip)
}

/// Text for the phones: no control, zero-width or bidirectional formatting characters and no
/// variation selector without a character to vary (`decks_remote::strip_hidden`, the same
/// cleaning as for a guest's request: a title must not show blank, reversed or spoofed on a
/// phone), trimmed, at most [`MAX_LABEL_CHARS`]; empty after that = none. A line break or a
/// tab in a tag becomes a space (two lines do not run into one word); emoji joined with a
/// zero width joiner and subdivision flags stay whole.
fn clean_text(s: Option<String>) -> Option<String> {
    let mut t = decks_remote::strip_hidden(&s?);
    if let Some((cut, _)) = t.char_indices().nth(MAX_LABEL_CHARS) {
        // The cut can fall inside an emoji sequence: a joiner left at the end or the
        // unfinished tags of a flag are hidden characters again, so they go.
        t = decks_remote::strip_hidden(&t[..cut]);
    }
    let t = t.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// A track id as the engine has it. It is never shown on a phone, only compared with the
/// engine's id of the loaded track, so it is kept byte for byte (cleaning it like display text
/// would make a label miss its own track); empty or absurdly long = none.
fn clean_id(s: Option<String>) -> Option<String> {
    s.filter(|id| !id.is_empty() && id.len() <= MAX_ID_BYTES)
}

fn parse_deck(s: &str) -> Result<DeckId, String> {
    DeckId::from_str(s).ok_or_else(|| format!("invalid deck '{s}'"))
}

// ---- engine side: commands ---------------------------------------------------------

/// What [`apply`] reads of a deck before a CUE press.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct DeckView {
    loaded: bool,
    playing: bool,
    position: f64,
    /// Length of the loaded track in seconds.
    duration: f64,
    track_id: Option<String>,
}

/// The engine calls [`apply`] makes. The real one is `mixai_core::Engine` (below: the bodies of
/// the Tauri deck commands in `lib.rs`); the tests record the calls.
pub(crate) trait EngineOps {
    fn deck_view(&self, deck: DeckId) -> DeckView;
    fn play(&self, deck: DeckId);
    fn pause(&self, deck: DeckId);
    fn seek(&self, deck: DeckId, sec: f64);
    fn hot_cue(&self, deck: DeckId, slot: usize);
    fn auto_loop(&self, deck: DeckId, beats: f64);
    fn exit_loop(&self, deck: DeckId);
    fn jump_beats(&self, deck: DeckId, beats: f64);
    fn sync(&self, deck: DeckId, lock: bool);
    fn set_volume(&self, deck: DeckId, value: f32);
    fn set_eq(&self, deck: DeckId, band: &'static str, db: f32);
    fn set_filter(&self, deck: DeckId, value: f32);
    fn set_crossfader(&self, value: f32);
    fn set_master(&self, value: f32);
}

fn mirror_deck(engine: &Engine, deck: DeckId, f: impl FnOnce(&mut DeckState)) {
    if let Some(d) = engine.mirror().decks.iter_mut().find(|d| d.id == deck) {
        f(d);
    }
}

impl EngineOps for Engine {
    fn deck_view(&self, deck: DeckId) -> DeckView {
        self.snapshot_state()
            .decks
            .into_iter()
            .find(|d| d.id == deck)
            .map(|d| DeckView {
                loaded: d.loaded,
                playing: d.playing,
                position: d.position,
                duration: d.duration,
                track_id: d.track_id,
            })
            .unwrap_or_default()
    }

    fn play(&self, deck: DeckId) {
        mirror_deck(self, deck, |d| d.playing = true);
        self.send(Command::Play(deck));
    }

    fn pause(&self, deck: DeckId) {
        mirror_deck(self, deck, |d| d.playing = false);
        self.send(Command::Pause(deck));
    }

    fn seek(&self, deck: DeckId, sec: f64) {
        self.send(Command::Seek(deck, sec));
    }

    fn hot_cue(&self, deck: DeckId, slot: usize) {
        self.send(Command::JumpHotCue(deck, slot));
    }

    fn auto_loop(&self, deck: DeckId, beats: f64) {
        self.send(Command::Beatloop(deck, beats));
    }

    fn exit_loop(&self, deck: DeckId) {
        self.send(Command::LoopExit(deck));
    }

    fn jump_beats(&self, deck: DeckId, beats: f64) {
        self.beat_jump(deck, beats);
    }

    fn sync(&self, deck: DeckId, lock: bool) {
        self.phase_sync(deck, lock);
    }

    fn set_volume(&self, deck: DeckId, value: f32) {
        mirror_deck(self, deck, |d| d.volume = value);
        self.send(Command::Volume(deck, value));
    }

    fn set_eq(&self, deck: DeckId, band: &'static str, db: f32) {
        mirror_deck(self, deck, |d| match band {
            "low" => d.eq_low = db,
            "mid" => d.eq_mid = db,
            "high" => d.eq_high = db,
            _ => {}
        });
        self.send(Command::Eq(deck, band.to_string(), db));
    }

    fn set_filter(&self, deck: DeckId, value: f32) {
        mirror_deck(self, deck, |d| d.filter = value);
        self.send(Command::Filter(deck, value));
    }

    fn set_crossfader(&self, value: f32) {
        self.mirror().crossfader = value;
        self.send(Command::Crossfader(value));
    }

    fn set_master(&self, value: f32) {
        self.mirror().master_volume = value;
        self.send(Command::MasterVolume(value));
    }
}

/// A phone moved the cue point of `deck` to `sec`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct CueMoved {
    deck: DeckId,
    sec: f64,
}

fn eq_band(band: EqBand) -> &'static str {
    match band {
        EqBand::Low => "low",
        EqBand::Mid => "mid",
        EqBand::High => "high",
    }
}

/// End a CUE hold: the deck goes back to the cue point, paused. When another track was loaded
/// while CUE was held there is nothing of the hold left to undo: the new track is not touched
/// (loading stopped the deck; the old cue point means nothing in it).
fn end_hold<E: EngineOps>(engine: &E, deck: DeckId, cue: &mut CueDeck, now: Instant) {
    let Some(hold) = cue.hold.take() else {
        return;
    };
    let view = engine.deck_view(deck);
    let same_track = view.loaded
        && view.track_id == cue.track_id
        && (view.duration - hold.duration).abs() < SAME_TRACK_SEC;
    if !same_track {
        cue.expect = None;
        return;
    }
    engine.pause(deck);
    engine.seek(deck, cue.point);
    cue.sent(Some(false), Playhead::At(cue.point), now);
}

/// End every CUE hold whose phone may no longer hold it (`may_hold(connection)` is false: the
/// phone is gone, or the controls were locked). Called by the pump on every step: a phone
/// that lost the Wi-Fi with a finger on CUE must not leave the deck playing.
pub(crate) fn end_orphan_holds<E: EngineOps>(
    engine: &E,
    cue: &mut [CueDeck; 4],
    may_hold: impl Fn(u64) -> bool,
    now: Instant,
) {
    for deck in DeckId::ALL {
        let c = &mut cue[deck.index()];
        if c.hold.is_some_and(|h| !may_hold(h.conn)) {
            end_hold(engine, deck, c, now);
        }
    }
}

/// One pump step on the engine side: the phone commands, then the holds nobody may keep.
/// While the controls are locked only letting go of CUE is applied (the server refuses the
/// rest already; this is the second lock on the same door) and every hold ends.
pub(crate) fn pump_engine<E: EngineOps>(
    engine: &E,
    cmds: &[CommandFrom],
    cue: &mut [CueDeck; 4],
    locked: bool,
    connected: impl Fn(u64) -> bool,
    now: Instant,
) -> Vec<CueMoved> {
    let mut moved = Vec::new();
    for c in cmds {
        if locked && !c.command.allowed_when_locked() {
            continue;
        }
        moved.extend(apply(engine, c.conn, &c.command, cue, now));
    }
    end_orphan_holds(engine, cue, |conn| !locked && connected(conn), now);
    moved
}

/// The CDJ CUE button (module docs). `from` is the connection that pressed or released it.
fn cue_press<E: EngineOps>(
    engine: &E,
    deck: DeckId,
    from: u64,
    pressed: bool,
    cue: &mut CueDeck,
    now: Instant,
) -> Option<CueMoved> {
    let view = engine.deck_view(deck);
    if !view.loaded {
        cue.drop_hold();
        return None;
    }
    // A cue point never carries over to another track: a new track starts at its beginning,
    // and a hold that began on the previous track is over (its release changes nothing here).
    if cue.track_id != view.track_id {
        *cue = CueDeck {
            track_id: view.track_id.clone(),
            ..CueDeck::default()
        };
    }
    if !pressed {
        // Only the phone that holds CUE lets it go.
        if cue.hold.is_some_and(|h| h.conn == from) {
            end_hold(engine, deck, cue, now);
        }
        return None;
    }
    // CUE is held: the first holder owns it. Another phone's press (and the holder's own
    // repeated press) changes nothing.
    if cue.hold.is_some() {
        return None;
    }
    // What this module asked for in the last moment counts, not the snapshot (module docs).
    let expect = cue.expecting(now);
    let playing = expect.and_then(|e| e.playing).unwrap_or(view.playing);
    if playing {
        engine.pause(deck);
        engine.seek(deck, cue.point);
        cue.sent(Some(false), Playhead::At(cue.point), now);
        return None;
    }
    let position = match expect.map(|e| e.playhead) {
        Some(Playhead::At(p)) => p,
        // The playhead is on its way somewhere the snapshot does not show yet: a cue point
        // set now would be the place it just left. The press is dropped; the next one counts.
        Some(Playhead::Jumped) => return None,
        Some(Playhead::Live) | None => view.position,
    };
    if (position - cue.point).abs() < AT_CUE_SEC {
        engine.play(deck);
        cue.hold = Some(Hold {
            conn: from,
            duration: view.duration,
        });
        cue.sent(Some(true), Playhead::Live, now);
        return None;
    }
    cue.point = position;
    Some(CueMoved {
        deck,
        sec: cue.point,
    })
}

/// Apply one phone command to the engine; `from` is the connection it came from, `now` the
/// time of this pump step. The commands come from `RemoteServer::drain_commands_from`, which
/// only hands out validated ones; they are validated AGAIN here (decks 0..3, hot cue 0..7,
/// finite numbers, loop and jump lengths in range, continuous controls clamped to the engine
/// ranges), so nothing non-finite or out of range reaches the engine whatever the caller is.
pub(crate) fn apply<E: EngineOps>(
    engine: &E,
    from: u64,
    cmd: &RemoteCommand,
    cue: &mut [CueDeck; 4],
    now: Instant,
) -> Option<CueMoved> {
    let cmd = cmd.clone().validated().ok()?;
    let id = |d: u8| DeckId::ALL.get(usize::from(d)).copied();
    match cmd {
        RemoteCommand::Play { deck } => {
            let d = id(deck)?;
            cue[d.index()].note(LocalTransport::Play, now);
            engine.play(d);
        }
        RemoteCommand::Pause { deck } => {
            let d = id(deck)?;
            cue[d.index()].note(LocalTransport::Pause, now);
            engine.pause(d);
        }
        RemoteCommand::Cue { deck, pressed } => {
            let d = id(deck)?;
            return cue_press(engine, d, from, pressed, &mut cue[d.index()], now);
        }
        RemoteCommand::HotCue { deck, slot } => {
            let d = id(deck)?;
            cue[d.index()].sent_jump(now);
            engine.hot_cue(d, usize::from(slot));
        }
        RemoteCommand::LoopAuto { deck, beats } => engine.auto_loop(id(deck)?, beats),
        RemoteCommand::LoopExit { deck } => engine.exit_loop(id(deck)?),
        RemoteCommand::BeatJump { deck, beats } => {
            let d = id(deck)?;
            cue[d.index()].sent_jump(now);
            engine.jump_beats(d, beats);
        }
        RemoteCommand::Sync { deck, lock } => {
            let d = id(deck)?;
            // A phase sync moves the playhead by a fraction of a beat.
            cue[d.index()].sent_jump(now);
            engine.sync(d, lock);
        }
        RemoteCommand::Volume { deck, value } => engine.set_volume(id(deck)?, value),
        RemoteCommand::Eq { deck, band, db } => engine.set_eq(id(deck)?, eq_band(band), db),
        RemoteCommand::Filter { deck, value } => engine.set_filter(id(deck)?, value),
        RemoteCommand::Crossfader { value } => engine.set_crossfader(value),
        RemoteCommand::MasterVolume { value } => engine.set_master(value),
    }
    None
}

// ---- engine side: state for the phones -------------------------------------------

/// Per-deck values the engine reports outside its mixer snapshot.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct DeckExtra {
    /// Audible tempo (0 = unknown).
    bpm: f64,
    /// Position in the bar, 0..beats per bar.
    bar_phase: Option<f64>,
    key_shift: f64,
    sync_lock: bool,
    /// Musical key 0..23 (`mixai_core::keys`).
    key: Option<u8>,
}

/// Everything [`remote_state`] reads of the engine, taken in one go.
pub(crate) struct EngineView {
    mixer: MixerState,
    decks: [DeckExtra; 4],
    beats_per_bar: u32,
    master_bpm: f64,
    recording: bool,
}

fn engine_view(engine: &Engine) -> EngineView {
    let clock = engine.clock_state();
    let keys = engine.perf().key;
    let mut decks = [DeckExtra::default(); 4];
    for c in &clock.decks {
        let i = c.id.index();
        decks[i] = DeckExtra {
            bpm: c.bpm,
            bar_phase: c.bar_phase,
            key_shift: c.key_shift,
            sync_lock: c.sync_lock,
            key: keys[i],
        };
    }
    EngineView {
        mixer: engine.snapshot_state(),
        decks,
        beats_per_bar: clock.beats_per_bar,
        master_bpm: clock.bpm,
        recording: engine.is_recording(),
    }
}

/// Key as heard (Camelot): the track key moved by the key shift and, without key lock, by the
/// tempo, to the nearest semitone.
fn effective_key(key: Option<u8>, key_shift: f64, tempo: f64, key_lock: bool) -> Option<String> {
    let key = key.filter(|k| *k < mixai_core::keys::KEY_COUNT)?;
    let pitch = key_shift + mixai_core::keys::tempo_semitones(tempo, key_lock);
    let shift = if pitch.is_finite() {
        pitch.round() as i32
    } else {
        0
    };
    let minor = mixai_core::keys::is_minor(key);
    let pc = (i32::from(key % 12) + shift).rem_euclid(12) as u8;
    mixai_core::keys::key_to_camelot(pc + if minor { 12 } else { 0 })
}

/// The deck state the phones show. A label counts only for the track it was sent for (the
/// engine's own title and artist otherwise); the bar phase goes out as 0..1 (protocol).
pub(crate) fn remote_state(v: &EngineView, labels: &[DeckLabel; 4]) -> RemoteState {
    let bar = f64::from(v.beats_per_bar.max(1));
    let decks = v
        .mixer
        .decks
        .iter()
        .map(|d| {
            let i = d.id.index();
            let x = &v.decks[i];
            let label = Some(&labels[i]).filter(|l| d.loaded && l.track_id == d.track_id);
            let bpm = if x.bpm > 0.0 {
                Some(x.bpm)
            } else if d.bpm > 0.0 {
                Some(d.bpm * d.tempo)
            } else {
                None
            };
            RemoteDeck {
                deck: i as u8,
                loaded: d.loaded,
                title: label
                    .and_then(|l| l.title.clone())
                    .or_else(|| clean_text(d.title.clone())),
                artist: label
                    .and_then(|l| l.artist.clone())
                    .or_else(|| clean_text(d.artist.clone())),
                bpm,
                key: effective_key(x.key, x.key_shift, d.tempo, d.key_lock),
                position_sec: d.position,
                duration_sec: d.duration,
                playing: d.playing,
                volume: d.volume,
                eq_low: d.eq_low,
                eq_mid: d.eq_mid,
                eq_high: d.eq_high,
                filter: d.filter,
                loop_active: d.loop_active,
                sync_lock: x.sync_lock,
                bar_phase: x.bar_phase.map(|p| (p / bar).clamp(0.0, 1.0)),
                vu: d.vu,
            }
        })
        .collect();
    RemoteState {
        decks,
        crossfader: v.mixer.crossfader,
        master_volume: v.mixer.master_volume,
        master_bpm: v.master_bpm,
        recording: v.recording,
    }
}

// ---- server control ------------------------------------------------------------------

fn pairing(server: &RemoteServer, role: Role, host: IpAddr) -> Result<Pairing, String> {
    let url = server.pairing_url(role, host);
    let qr_svg = decks_remote::qr_svg(&url)?;
    Ok(Pairing { role, url, qr_svg })
}

fn clients_of(server: &RemoteServer) -> Vec<ClientView> {
    server
        .clients()
        .into_iter()
        .map(|c| ClientView {
            id: c.id,
            role: c.role,
            addr: c.addr,
        })
        .collect()
}

impl Ctl {
    fn running(&self) -> Result<(&RemoteServer, IpAddr), String> {
        match (&self.server, self.host) {
            (Some(s), Some(h)) => Ok((s, h)),
            _ => Err(NOT_RUNNING.into()),
        }
    }

    /// Open the server (`port` 0 = any free port). Already running = nothing to do.
    ///
    /// Refused, before any port is opened, when the pump thread is not there (never spawned,
    /// or it ended): phones would connect to a server whose commands nobody applies.
    fn start(&mut self, party_open: bool, port: u16, bind: IpAddr) -> Result<(), String> {
        if self.server.is_some() {
            return Ok(());
        }
        let Some(pump) = self.pump.as_ref().filter(|p| !p.is_finished()) else {
            return Err(NO_PUMP.into());
        };
        let server = RemoteServer::start(RemoteConfig {
            bind,
            port,
            party_open,
        })
        .map_err(|e| format!("{NO_PORT}: {e}"))?;
        server.set_controls_locked(self.locked);
        self.host = Some(if bind.is_unspecified() {
            decks_remote::lan_ip()
        } else {
            bind
        });
        self.server = Some(server);
        // No hold can be left (`stop` ends them); what was asked of a deck before is history.
        for c in &mut self.cue {
            c.drop_hold();
        }
        // The token of `unpark` is kept: a pump that is about to park wakes at once.
        pump.thread().unpark();
        Ok(())
    }

    /// Turn the server off: every CUE hold ends first (the deck goes back to its cue point,
    /// paused: no phone can let go of it any more), then the server is taken out. Dropping it
    /// disconnects every device (do that outside the lock). `engine` is none when the audio
    /// engine is not running: nothing plays then.
    fn stop<E: EngineOps>(&mut self, engine: Option<&E>, now: Instant) -> Option<RemoteServer> {
        match engine {
            Some(engine) => end_orphan_holds(engine, &mut self.cue, |_| false, now),
            None => self.cue.iter_mut().for_each(CueDeck::drop_hold),
        }
        self.host = None;
        self.server.take()
    }

    /// Lock or unlock the phone controls (stored while the server is off too).
    fn set_locked(&mut self, locked: bool) {
        self.locked = locked;
        if let Some(server) = &self.server {
            server.set_controls_locked(locked);
        }
    }

    fn status(&self) -> RemoteStatus {
        let Ok((server, host)) = self.running() else {
            return RemoteStatus {
                controls_locked: self.locked,
                ..RemoteStatus::default()
            };
        };
        // A pairing URL always fits a QR code; should one ever not, the URL still goes out.
        let pairings: Vec<Pairing> = Role::ALL
            .into_iter()
            .map(|role| {
                pairing(server, role, host).unwrap_or_else(|_| Pairing {
                    role,
                    url: server.pairing_url(role, host),
                    qr_svg: String::new(),
                })
            })
            .collect();
        let url = |role: Role| {
            pairings
                .iter()
                .find(|p| p.role == role)
                .map(|p| p.url.clone())
        };
        let pending = server
            .requests()
            .iter()
            .filter(|r| r.status == RequestStatus::Pending)
            .count();
        RemoteStatus {
            running: true,
            port: Some(server.port()),
            host: Some(host.to_string()),
            url_controller: url(Role::Controller),
            url_viewer: url(Role::Viewer),
            url_guest: url(Role::Guest),
            clients: clients_of(server),
            party_open: server.party_open(),
            requests_pending: u32::try_from(pending).unwrap_or(u32::MAX),
            controls_locked: self.locked,
            pairings,
        }
    }

    fn event(&self) -> RemoteEvent {
        match &self.server {
            Some(server) => RemoteEvent {
                running: true,
                party_open: server.party_open(),
                controls_locked: self.locked,
                clients: clients_of(server),
                requests: server.requests(),
            },
            None => RemoteEvent::default(),
        }
    }

    fn rotate(&self, role: Role) -> Result<Pairing, String> {
        let (server, host) = self.running()?;
        server.rotate_token(role);
        pairing(server, role, host)
    }

    fn decide(&self, id: u64, status: RequestStatus) -> Result<(), String> {
        let (server, _) = self.running()?;
        if server.set_request_status(id, status) {
            Ok(())
        } else {
            Err(format!("request {id} not found"))
        }
    }

    /// Labels and cue points of the loaded decks (kept while the server is off too).
    fn set_labels(&mut self, labels: Vec<LabelReq>) -> Result<(), String> {
        if labels.len() > self.labels.len() {
            return Err("at most one label per deck".into());
        }
        // Validate everything before anything is stored.
        let mut parsed = Vec::with_capacity(labels.len());
        for l in labels {
            let deck = parse_deck(&l.deck)?;
            let cue = l.cue_sec.unwrap_or(0.0);
            if !cue.is_finite() || cue < 0.0 {
                return Err(format!("cueSec {cue} must be finite and >= 0"));
            }
            parsed.push((deck, l, cue));
        }
        for (deck, l, cue) in parsed {
            let i = deck.index();
            let track_id = clean_id(l.track_id);
            self.labels[i] = DeckLabel {
                track_id: track_id.clone(),
                title: clean_text(l.title),
                artist: clean_text(l.artist),
            };
            let c = &mut self.cue[i];
            // Another track: a hold that began on the previous one is over, and the deck is
            // not touched (loading stopped it).
            if c.track_id != track_id {
                c.drop_hold();
            }
            c.track_id = track_id;
            c.point = cue;
        }
        Ok(())
    }
}

// ---- pump ------------------------------------------------------------------------------

/// The last `remote://state` payload offered to the UI.
struct Emitted {
    json: String,
    at: Option<Instant>,
}

impl Emitted {
    /// Starts from "off, nobody connected": the UI assumes that until told otherwise.
    fn new() -> Self {
        Self {
            json: serde_json::to_string(&RemoteEvent::default()).unwrap_or_default(),
            at: None,
        }
    }

    fn due(&self, now: Instant) -> bool {
        self.at
            .is_none_or(|t| now.duration_since(t) >= EVENT_INTERVAL)
    }

    /// Remember `json`; true when it differs from the last one (= send it).
    fn changed(&mut self, json: String, now: Instant) -> bool {
        self.at = Some(now);
        if json == self.json {
            return false;
        }
        self.json = json;
        true
    }
}

/// One pump step; false when the server is off (the thread parks until the next start).
fn pump_once(app: &tauri::AppHandle, emitted: &mut Emitted) -> bool {
    let now = Instant::now();
    let ctl_state = app.state::<RemoteCtl>();
    let mut moved = Vec::new();
    let (running, event) = {
        let mut ctl = ctl_state.lock();
        let Ctl {
            server,
            labels,
            cue,
            locked,
            ..
        } = &mut *ctl;
        match server.as_ref() {
            Some(server) => {
                let cmds = server.drain_commands_from();
                let engine_state = app.state::<EngineState>();
                let state = {
                    let guard = engine_state.0.lock().unwrap_or_else(|p| p.into_inner());
                    match guard.as_ref() {
                        Some(engine) => {
                            // Commands first, then the CUE holds whose phone is gone (lost
                            // Wi-Fi, closed tab, rotated code) or locked out.
                            moved = pump_engine(
                                engine,
                                &cmds,
                                cue,
                                *locked,
                                |conn| server.is_connected(conn),
                                now,
                            );
                            remote_state(&engine_view(engine), labels)
                        }
                        // No audio engine (device failure): the phones see empty decks and
                        // their commands are dropped; requests keep working. Nothing plays,
                        // so no hold is left to end.
                        None => {
                            cue.iter_mut().for_each(CueDeck::drop_hold);
                            RemoteState::default()
                        }
                    }
                };
                server.publish(state);
                (true, emitted.due(now).then(|| ctl.event()))
            }
            // Just stopped: tell the UI at once, whatever the interval says.
            None => (false, Some(RemoteEvent::default())),
        }
    };
    for m in moved {
        let _ = app.emit(
            CUE_EVENT,
            CuePayload {
                deck: m.deck,
                sec: m.sec,
            },
        );
    }
    if let Some(event) = event
        && let Ok(json) = serde_json::to_string(&event)
        && emitted.changed(json, now)
    {
        let _ = app.emit(STATE_EVENT, event);
    }
    running
}

fn pump_loop(app: tauri::AppHandle) {
    let mut emitted = Emitted::new();
    loop {
        if pump_once(&app, &mut emitted) {
            std::thread::sleep(PUMP_INTERVAL);
        } else {
            // `Ctl::start` unparks; a wake-up without a server just parks again.
            std::thread::park();
        }
    }
}

/// Make sure the pump thread exists: `spawn` is called when it was never started or has
/// ended. Call it with the `RemoteCtl` lock held (`ctl` is the locked state): the new thread's
/// first step waits for that lock, so the handle is stored before the thread can look at the
/// state, and no `start` can run between the spawn and the store.
fn ensure_pump_with(
    ctl: &mut Ctl,
    spawn: impl FnOnce() -> std::io::Result<JoinHandle<()>>,
) -> Result<(), String> {
    if ctl.pump.as_ref().is_some_and(|p| !p.is_finished()) {
        return Ok(());
    }
    ctl.pump = None;
    let pump = spawn().map_err(|e| format!("{NO_PUMP}: {e}"))?;
    ctl.pump = Some(pump);
    Ok(())
}

fn ensure_pump(app: &tauri::AppHandle, ctl: &mut Ctl) -> Result<(), String> {
    let handle = app.clone();
    ensure_pump_with(ctl, move || {
        std::thread::Builder::new()
            .name("decks-remote-pump".into())
            .spawn(move || pump_loop(handle))
    })
}

/// Called once from the app setup: spawns the pump thread (parked until Connect is turned on).
/// A failure is logged here and tried again by `remote_start`, which reports it to the DJ.
pub fn init(app: &tauri::AppHandle) {
    let state = app.state::<RemoteCtl>();
    let mut ctl = state.lock();
    if let Err(e) = ensure_pump(app, &mut ctl) {
        log::error!("connected mode: {e}");
    }
}

// ---- commands ----------------------------------------------------------------------------

/// Server state, the three pairing URLs with their QR codes, connected devices.
#[tauri::command]
pub fn remote_status(ctl: State<'_, RemoteCtl>) -> RemoteStatus {
    ctl.lock().status()
}

/// Turn connected mode on. `party_open` (default true) = accept song requests from the start;
/// `port` (default 0) = any free port; `bind` (default `0.0.0.0`) = address to listen on, e.g.
/// `127.0.0.1` to stay off the network. Already on = the current status. An error (no port is
/// left open then) when the port cannot be opened or the worker thread cannot be started.
#[tauri::command]
pub fn remote_start(
    party_open: Option<bool>,
    port: Option<u16>,
    bind: Option<String>,
    app: tauri::AppHandle,
    ctl: State<'_, RemoteCtl>,
) -> Result<RemoteStatus, String> {
    let bind = parse_bind(bind.as_deref())?;
    let mut c = ctl.lock();
    ensure_pump(&app, &mut c)?;
    c.start(party_open.unwrap_or(true), port.unwrap_or(0), bind)?;
    Ok(c.status())
}

/// Turn connected mode off: a deck that plays because a phone holds CUE goes back to its cue
/// point, paused; every device is disconnected; the request queue is dropped.
#[tauri::command]
pub fn remote_stop(ctl: State<'_, RemoteCtl>, engine: State<'_, EngineState>) -> RemoteStatus {
    let server = {
        // Lock order: `RemoteCtl`, then `EngineState` (module docs).
        let mut c = ctl.lock();
        let guard = engine.0.lock().unwrap_or_else(|p| p.into_inner());
        c.stop(guard.as_ref(), Instant::now())
    };
    // Joins the accept thread (a few tens of ms): not under the lock the pump needs.
    drop(server);
    ctl.lock().status()
}

/// New code for `role` (`controller` / `viewer` / `guest`): devices paired with the old one are
/// disconnected.
#[tauri::command]
pub fn remote_rotate(role: String, ctl: State<'_, RemoteCtl>) -> Result<Pairing, String> {
    let role = parse_role(&role)?;
    ctl.lock().rotate(role)
}

/// The request queue: accepted (the shared playlist, in order), pending by votes, then done.
/// Empty while connected mode is off.
#[tauri::command]
pub fn remote_requests(ctl: State<'_, RemoteCtl>) -> Vec<SongRequestView> {
    ctl.lock()
        .server
        .as_ref()
        .map(RemoteServer::requests)
        .unwrap_or_default()
}

/// DJ decision on a request: `accepted`, `rejected` or `played`.
#[tauri::command]
pub fn remote_request_set(
    id: u64,
    status: String,
    ctl: State<'_, RemoteCtl>,
) -> Result<(), String> {
    let status = parse_decision(&status)?;
    ctl.lock().decide(id, status)
}

/// `labels`: title / artist / cue point of the loaded decks (stored while off too);
/// `party_open`: open or close song requests; `clear_done`: drop played and rejected requests.
/// `controls_locked`: lock or unlock the phone controls (stored while off too): while locked
/// no phone command reaches the decks or the mixer, requests keep working.
/// Everything is validated before anything is applied.
#[tauri::command]
pub fn remote_set(
    party_open: Option<bool>,
    labels: Option<Vec<LabelReq>>,
    clear_done: Option<bool>,
    controls_locked: Option<bool>,
    ctl: State<'_, RemoteCtl>,
) -> Result<(), String> {
    let mut c = ctl.lock();
    if party_open.is_some() || clear_done == Some(true) {
        c.running()?;
    }
    if let Some(labels) = labels {
        c.set_labels(labels)?;
    }
    if let Some(locked) = controls_locked {
        // The pump ends the CUE holds at its next step (within 50 ms).
        c.set_locked(locked);
    }
    if let Ok((server, _)) = c.running() {
        if let Some(open) = party_open {
            server.set_party_open(open);
        }
        if clear_done == Some(true) {
            server.clear_done_requests();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, TcpStream};
    use std::sync::mpsc;

    use super::*;

    const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

    /// A transport change on its way to the snapshot.
    enum Change {
        Playing(bool),
        Position(f64),
    }

    /// Records every engine call and keeps a tiny transport state per deck. With `lag` it
    /// behaves like the real engine: a command changes what `deck_view` reports only at the
    /// next audio callback ([`Mock::callback`]).
    #[derive(Default)]
    struct Mock {
        calls: RefCell<Vec<String>>,
        decks: RefCell<[DeckView; 4]>,
        lag: Cell<bool>,
        queued: RefCell<VecDeque<(usize, Change)>>,
    }

    impl Mock {
        fn with_deck(deck: DeckId, view: DeckView) -> Self {
            let m = Mock::default();
            m.decks.borrow_mut()[deck.index()] = view;
            m
        }

        /// Like [`Mock::with_deck`], with the engine's delay between a command and the snapshot.
        fn lagging(deck: DeckId, view: DeckView) -> Self {
            let m = Mock::with_deck(deck, view);
            m.lag.set(true);
            m
        }

        fn log(&self, s: String) {
            self.calls.borrow_mut().push(s);
        }

        fn take(&self) -> Vec<String> {
            std::mem::take(&mut *self.calls.borrow_mut())
        }

        fn set(&self, deck: DeckId, f: impl FnOnce(&mut DeckView)) {
            f(&mut self.decks.borrow_mut()[deck.index()]);
        }

        fn commit(&self, deck: usize, change: Change) {
            let d = &mut self.decks.borrow_mut()[deck];
            match change {
                Change::Playing(p) => d.playing = p,
                Change::Position(s) => d.position = s,
            }
        }

        fn change(&self, deck: DeckId, change: Change) {
            if self.lag.get() {
                self.queued.borrow_mut().push_back((deck.index(), change));
            } else {
                self.commit(deck.index(), change);
            }
        }

        /// An audio callback that picks up the first `n` queued commands (`usize::MAX` = all).
        fn callback(&self, n: usize) {
            for _ in 0..n {
                let next = self.queued.borrow_mut().pop_front();
                let Some((deck, change)) = next else { break };
                self.commit(deck, change);
            }
        }
    }

    impl EngineOps for Mock {
        fn deck_view(&self, deck: DeckId) -> DeckView {
            self.decks.borrow()[deck.index()].clone()
        }
        fn play(&self, deck: DeckId) {
            self.change(deck, Change::Playing(true));
            self.log(format!("play {}", deck.index()));
        }
        fn pause(&self, deck: DeckId) {
            self.change(deck, Change::Playing(false));
            self.log(format!("pause {}", deck.index()));
        }
        fn seek(&self, deck: DeckId, sec: f64) {
            self.change(deck, Change::Position(sec));
            self.log(format!("seek {} {sec}", deck.index()));
        }
        fn hot_cue(&self, deck: DeckId, slot: usize) {
            self.log(format!("hot_cue {} {slot}", deck.index()));
        }
        fn auto_loop(&self, deck: DeckId, beats: f64) {
            self.log(format!("auto_loop {} {beats}", deck.index()));
        }
        fn exit_loop(&self, deck: DeckId) {
            self.log(format!("exit_loop {}", deck.index()));
        }
        fn jump_beats(&self, deck: DeckId, beats: f64) {
            self.log(format!("jump_beats {} {beats}", deck.index()));
        }
        fn sync(&self, deck: DeckId, lock: bool) {
            self.log(format!("sync {} {lock}", deck.index()));
        }
        fn set_volume(&self, deck: DeckId, value: f32) {
            self.log(format!("volume {} {value}", deck.index()));
        }
        fn set_eq(&self, deck: DeckId, band: &'static str, db: f32) {
            self.log(format!("eq {} {band} {db}", deck.index()));
        }
        fn set_filter(&self, deck: DeckId, value: f32) {
            self.log(format!("filter {} {value}", deck.index()));
        }
        fn set_crossfader(&self, value: f32) {
            self.log(format!("crossfader {value}"));
        }
        fn set_master(&self, value: f32) {
            self.log(format!("master {value}"));
        }
    }

    /// Length of the test track "t1" (seconds).
    const T1_SEC: f64 = 300.0;
    /// Connections of the two test phones.
    const PHONE: u64 = 7;
    const OTHER: u64 = 8;

    fn loaded(position: f64, playing: bool) -> DeckView {
        DeckView {
            loaded: true,
            playing,
            position,
            duration: T1_SEC,
            track_id: Some("t1".into()),
        }
    }

    fn cues() -> [CueDeck; 4] {
        Default::default()
    }

    /// The cue point of track "t1".
    fn cue_at(point: f64) -> CueDeck {
        CueDeck {
            track_id: Some("t1".into()),
            point,
            ..CueDeck::default()
        }
    }

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

    fn holder(cue: &CueDeck) -> Option<u64> {
        cue.hold.map(|h| h.conn)
    }

    /// A stand-in for the pump thread: it lives until the returned sender is dropped.
    fn fake_pump(ctl: &mut Ctl) -> mpsc::Sender<()> {
        let (tx, rx) = mpsc::channel::<()>();
        ctl.pump = Some(std::thread::spawn(move || {
            let _ = rx.recv();
        }));
        tx
    }

    #[test]
    fn every_command_reaches_the_matching_engine_call() {
        let m = Mock::default();
        let mut cue = cues();
        let t0 = Instant::now();
        let cmds = [
            RemoteCommand::Play { deck: 0 },
            RemoteCommand::Pause { deck: 1 },
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
                band: EqBand::Low,
                db: -26.0,
            },
            RemoteCommand::Eq {
                deck: 0,
                band: EqBand::Mid,
                db: 1.5,
            },
            RemoteCommand::Eq {
                deck: 0,
                band: EqBand::High,
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
            assert_eq!(apply(&m, PHONE, c, &mut cue, t0), None, "{c:?}");
        }
        assert_eq!(
            m.take(),
            [
                "play 0",
                "pause 1",
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
    }

    #[test]
    fn a_deck_out_of_range_is_ignored_not_indexed() {
        let m = Mock::default();
        let mut cue = cues();
        for c in [
            RemoteCommand::Play { deck: 4 },
            press(200),
            RemoteCommand::Volume {
                deck: 9,
                value: 1.0,
            },
        ] {
            assert_eq!(apply(&m, PHONE, &c, &mut cue, Instant::now()), None);
        }
        assert!(m.take().is_empty());
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
        for band in [EqBand::Low, EqBand::Mid, EqBand::High] {
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
        let t0 = Instant::now();
        // `apply` is handed commands as a phone could send them, NOT validated by the server.
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let m = Mock::default();
            let mut cue = cues();
            for c in numeric(bad) {
                assert_eq!(apply(&m, PHONE, &c, &mut cue, t0), None, "{c:?}");
            }
            assert_eq!(m.take(), [""; 0], "{bad}: no engine call at all");
        }
        // Out of range: a loop or a jump is refused; a continuous control arrives clamped.
        let m = Mock::default();
        let mut cue = cues();
        for c in numeric(1000.0) {
            apply(&m, PHONE, &c, &mut cue, t0);
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
            apply(&m, PHONE, &c, &mut cue, t0);
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
                band: EqBand::Low,
                db: 0.0,
            },
        ] {
            assert_eq!(apply(&m, PHONE, &c, &mut cue, t0), None, "{c:?}");
            assert_eq!(m.take(), [""; 0], "{c:?}");
        }
    }

    #[test]
    fn cue_on_a_playing_deck_goes_back_to_the_cue_point_and_pauses() {
        let m = Mock::with_deck(DeckId::B, loaded(42.0, true));
        let mut cue = cues();
        cue[1] = cue_at(12.5);
        let t0 = Instant::now();
        assert_eq!(apply(&m, PHONE, &press(1), &mut cue, t0), None);
        assert_eq!(m.take(), ["pause 1", "seek 1 12.5"]);
        assert_eq!(holder(&cue[1]), None);
        // Releasing after that does nothing: it was not a preview.
        assert_eq!(apply(&m, PHONE, &release(1), &mut cue, t0 + ms(400)), None);
        assert!(m.take().is_empty());
    }

    #[test]
    fn cue_held_on_the_cue_point_previews_until_released() {
        let m = Mock::with_deck(DeckId::A, loaded(12.51, false));
        let mut cue = cues();
        cue[0] = cue_at(12.5);
        let t0 = Instant::now();
        assert_eq!(apply(&m, PHONE, &press(0), &mut cue, t0), None);
        assert_eq!(m.take(), ["play 0"]);
        assert_eq!(holder(&cue[0]), Some(PHONE));
        m.set(DeckId::A, |d| d.position = 14.0);
        assert_eq!(apply(&m, PHONE, &release(0), &mut cue, t0 + ms(1500)), None);
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);
        assert_eq!(holder(&cue[0]), None);
    }

    #[test]
    fn play_while_cue_is_held_keeps_the_deck_playing_after_the_release() {
        let m = Mock::with_deck(DeckId::A, loaded(0.0, false));
        let mut cue = cues();
        cue[0].track_id = Some("t1".into());
        let t0 = Instant::now();
        apply(&m, PHONE, &press(0), &mut cue, t0);
        apply(
            &m,
            PHONE,
            &RemoteCommand::Play { deck: 0 },
            &mut cue,
            t0 + ms(300),
        );
        apply(&m, PHONE, &release(0), &mut cue, t0 + ms(600));
        assert_eq!(m.take(), ["play 0", "play 0"]);
        assert!(m.deck_view(DeckId::A).playing);
        // The phone going away later must not stop a deck it no longer holds.
        end_orphan_holds(&m, &mut cue, |_| false, t0 + ms(900));
        assert!(m.take().is_empty());
        assert!(m.deck_view(DeckId::A).playing);
    }

    #[test]
    fn cue_on_a_paused_deck_elsewhere_moves_the_cue_point_and_reports_it() {
        let m = Mock::with_deck(DeckId::C, loaded(33.25, false));
        let mut cue = cues();
        cue[2].track_id = Some("t1".into());
        assert_eq!(
            apply(&m, PHONE, &press(2), &mut cue, Instant::now()),
            Some(CueMoved {
                deck: DeckId::C,
                sec: 33.25
            })
        );
        assert!(m.take().is_empty(), "setting a cue point moves nothing");
        assert_eq!(cue[2].point, 33.25);
        assert_eq!(holder(&cue[2]), None);
    }

    #[test]
    fn a_cue_point_does_not_carry_over_to_another_track_and_empty_decks_ignore_cue() {
        // The point was set on track t0; the deck now holds t1 and plays.
        let m = Mock::with_deck(DeckId::A, loaded(50.0, true));
        let mut cue = cues();
        cue[0] = CueDeck {
            track_id: Some("t0".into()),
            point: 90.0,
            ..CueDeck::default()
        };
        let t0 = Instant::now();
        apply(&m, PHONE, &press(0), &mut cue, t0);
        assert_eq!(m.take(), ["pause 0", "seek 0 0"], "start of the new track");
        assert_eq!(cue[0].track_id.as_deref(), Some("t1"));
        // Nothing loaded: no engine call, no cue point.
        let empty = Mock::default();
        assert_eq!(apply(&empty, PHONE, &press(0), &mut cue, t0), None);
        assert!(empty.take().is_empty());
    }

    // ---- R1: a held CUE never outlives the phone that holds it ----

    #[test]
    fn a_phone_that_disappears_while_holding_cue_stops_the_deck_on_the_cue_point() {
        let m = Mock::with_deck(DeckId::A, loaded(12.5, false));
        m.set(DeckId::B, |d| *d = loaded(60.0, false));
        let mut cue = cues();
        cue[0] = cue_at(12.5);
        cue[1] = cue_at(60.0);
        let t0 = Instant::now();
        // Two phones hold CUE, one on each deck: both decks play.
        let cmds = [from(PHONE, press(0)), from(OTHER, press(1))];
        assert!(pump_engine(&m, &cmds, &mut cue, false, |_| true, t0).is_empty());
        assert_eq!(m.take(), ["play 0", "play 1"]);
        m.set(DeckId::A, |d| d.position = 31.0);
        // While both are connected nothing happens, however many pump steps pass.
        for i in 1..=40 {
            pump_engine(&m, &[], &mut cue, false, |_| true, t0 + ms(50 * i));
        }
        assert!(m.take().is_empty());
        assert!(m.deck_view(DeckId::A).playing && m.deck_view(DeckId::B).playing);
        // PHONE leaves the Wi-Fi with the finger down: no release ever arrives, the server
        // stops counting its connection. Its deck stops on the cue point; the other plays on.
        pump_engine(&m, &[], &mut cue, false, |c| c == OTHER, t0 + ms(7000));
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);
        assert!(!m.deck_view(DeckId::A).playing);
        assert_eq!(m.deck_view(DeckId::A).position, 12.5);
        assert!(m.deck_view(DeckId::B).playing);
        assert_eq!((holder(&cue[0]), holder(&cue[1])), (None, Some(OTHER)));
        // Once only: later steps find nothing left to end.
        pump_engine(&m, &[], &mut cue, false, |c| c == OTHER, t0 + ms(7050));
        assert!(m.take().is_empty());
        // A release that arrives late from the vanished phone (queued before it dropped) is
        // not a second release.
        let late = [from(PHONE, release(0))];
        pump_engine(&m, &late, &mut cue, false, |c| c == OTHER, t0 + ms(7100));
        assert!(m.take().is_empty());
    }

    #[test]
    fn turning_connect_off_ends_every_hold_and_a_new_start_begins_clean() {
        let m = Mock::with_deck(DeckId::A, loaded(12.5, false));
        m.set(DeckId::C, |d| *d = loaded(40.0, false));
        let mut ctl = Ctl::default();
        let _pump = fake_pump(&mut ctl);
        ctl.start(true, 0, LOOPBACK).unwrap();
        ctl.cue[0] = cue_at(12.5);
        ctl.cue[2] = cue_at(40.0);
        let t0 = Instant::now();
        let cmds = [from(PHONE, press(0)), from(OTHER, press(2))];
        pump_engine(&m, &cmds, &mut ctl.cue, false, |_| true, t0);
        assert_eq!(m.take(), ["play 0", "play 2"]);
        // Connect off: no phone can let go any more, so the shell does.
        let server = ctl.stop(Some(&m), t0 + ms(1000));
        assert!(
            server.is_some(),
            "the running server is handed back to be dropped"
        );
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5", "pause 2", "seek 2 40"]);
        assert!(!m.deck_view(DeckId::A).playing && !m.deck_view(DeckId::C).playing);
        assert!(ctl.cue.iter().all(|c| c.hold.is_none()));
        drop(server);
        assert!(!ctl.status().running);
        // Off again: nothing to do.
        assert!(ctl.stop(Some(&m), t0 + ms(1100)).is_none());
        assert!(m.take().is_empty());
        // Without an audio engine nothing plays: the holds are only forgotten.
        ctl.cue[0].hold = Some(Hold {
            conn: PHONE,
            duration: T1_SEC,
        });
        assert!(ctl.stop::<Mock>(None, t0 + ms(1200)).is_none());
        assert_eq!(ctl.cue[0].hold, None);
        // The next start keeps the cue points and has no hold to "silently clear".
        ctl.start(true, 0, LOOPBACK).unwrap();
        assert_eq!((ctl.cue[0].point, ctl.cue[2].point), (12.5, 40.0));
        assert!(ctl.cue.iter().all(|c| c.hold.is_none()));
        drop(ctl.stop(Some(&m), t0 + ms(1300)));
        assert!(m.take().is_empty());
    }

    #[test]
    fn another_track_loaded_during_a_hold_is_released_without_touching_it() {
        /// A deck on which PHONE holds CUE at 12.5 s of track t1.
        fn held() -> (Mock, [CueDeck; 4], Instant) {
            let m = Mock::with_deck(DeckId::A, loaded(12.5, false));
            let mut cue = cues();
            cue[0] = cue_at(12.5);
            let t0 = Instant::now();
            apply(&m, PHONE, &press(0), &mut cue, t0);
            assert_eq!(m.take(), ["play 0"]);
            (m, cue, t0)
        }
        /// The DJ loads track `id` of `duration` seconds on the deck (loading stops it).
        fn load(m: &Mock, id: &str, duration: f64) {
            m.set(DeckId::A, |d| {
                *d = DeckView {
                    loaded: true,
                    playing: false,
                    position: 0.0,
                    duration,
                    track_id: Some(id.into()),
                }
            });
        }

        // The phone lets go after the load: nothing is sent to the new track.
        let (m, mut cue, t0) = held();
        load(&m, "t2", 200.0);
        assert_eq!(apply(&m, PHONE, &release(0), &mut cue, t0 + ms(2000)), None);
        assert_eq!(m.take(), [""; 0], "no pause, no seek into the new track");
        assert_eq!(holder(&cue[0]), None);

        // The DJ already started the new track: the release must not stop it or jump in it.
        let (m, mut cue, t0) = held();
        load(&m, "t2", 200.0);
        m.set(DeckId::A, |d| {
            d.playing = true;
            d.position = 33.0;
        });
        apply(&m, PHONE, &release(0), &mut cue, t0 + ms(2000));
        assert!(m.take().is_empty());
        assert!(m.deck_view(DeckId::A).playing);
        assert_eq!(m.deck_view(DeckId::A).position, 33.0);

        // The phone vanished instead of letting go: same.
        let (m, mut cue, t0) = held();
        load(&m, "t2", 200.0);
        end_orphan_holds(&m, &mut cue, |_| false, t0 + ms(6000));
        assert!(m.take().is_empty());
        assert_eq!(holder(&cue[0]), None);

        // Connect turned off instead: same.
        let (m, cue, t0) = held();
        load(&m, "t2", 200.0);
        let mut ctl = Ctl {
            cue,
            ..Ctl::default()
        };
        assert!(ctl.stop(Some(&m), t0 + ms(6000)).is_none());
        assert!(m.take().is_empty());

        // Two files without a library id have the same id: the length tells them apart.
        let (m, mut cue, t0) = held();
        load(&m, "t1", 187.3);
        apply(&m, PHONE, &release(0), &mut cue, t0 + ms(2000));
        assert_eq!(m.take(), [""; 0], "same id, another track");
        assert_eq!(holder(&cue[0]), None);

        // The limit of that rule (module docs): the same id AND the same length to 10 ms is
        // taken for the same track, so this release does go back to the old cue point.
        let (m, mut cue, t0) = held();
        load(&m, "t1", T1_SEC + 0.004);
        apply(&m, PHONE, &release(0), &mut cue, t0 + ms(2000));
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);

        // The deck was emptied.
        let (m, mut cue, t0) = held();
        m.set(DeckId::A, |d| *d = DeckView::default());
        apply(&m, PHONE, &release(0), &mut cue, t0 + ms(2000));
        end_orphan_holds(&m, &mut cue, |_| false, t0 + ms(2050));
        assert!(m.take().is_empty());
        assert_eq!(holder(&cue[0]), None);

        // The UI announcing the new track ends the hold too (before any release arrives).
        let (m, cue, t0) = held();
        load(&m, "t2", 200.0);
        let mut ctl = Ctl {
            cue,
            ..Ctl::default()
        };
        ctl.set_labels(vec![label("a", "t2", "Other", Some(8.0))])
            .unwrap();
        assert_eq!(holder(&ctl.cue[0]), None);
        end_orphan_holds(&m, &mut ctl.cue, |_| false, t0 + ms(6000));
        assert!(m.take().is_empty());
        assert_eq!(ctl.cue[0].point, 8.0);

        // The control: with the SAME track still loaded the release does go back to the cue.
        let (m, mut cue, t0) = held();
        apply(&m, PHONE, &release(0), &mut cue, t0 + ms(2000));
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);
    }

    #[test]
    fn the_first_phone_to_hold_cue_owns_it() {
        let m = Mock::with_deck(DeckId::A, loaded(12.5, false));
        let mut cue = cues();
        cue[0] = cue_at(12.5);
        let t0 = Instant::now();
        apply(&m, PHONE, &press(0), &mut cue, t0);
        assert_eq!(m.take(), ["play 0"]);
        m.set(DeckId::A, |d| d.position = 14.0);
        // A second phone presses CUE on the same deck. The deck plays, so without an owner
        // this press would be "back to the cue point and pause" under the first finger.
        assert_eq!(apply(&m, OTHER, &press(0), &mut cue, t0 + ms(500)), None);
        assert_eq!(m.take(), [""; 0], "the second press is ignored");
        // ... and its release must not end the first phone's hold.
        assert_eq!(apply(&m, OTHER, &release(0), &mut cue, t0 + ms(700)), None);
        assert_eq!(m.take(), [""; 0], "the second release is ignored");
        assert!(m.deck_view(DeckId::A).playing);
        assert_eq!(holder(&cue[0]), Some(PHONE));
        // A repeated press of the holder itself changes nothing either.
        assert_eq!(apply(&m, PHONE, &press(0), &mut cue, t0 + ms(800)), None);
        assert!(m.take().is_empty());
        // The second phone dropping off does not matter while the holder is there.
        end_orphan_holds(&m, &mut cue, |c| c == PHONE, t0 + ms(900));
        assert!(m.take().is_empty());
        // The holder lets go: back to the cue point.
        apply(&m, PHONE, &release(0), &mut cue, t0 + ms(1000));
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);
        assert_eq!(holder(&cue[0]), None);
        // Now the deck is free: the other phone can hold it.
        apply(&m, OTHER, &press(0), &mut cue, t0 + ms(2000));
        assert_eq!(m.take(), ["play 0"]);
        assert_eq!(holder(&cue[0]), Some(OTHER));
        // Another deck is another button: PHONE may hold deck B meanwhile.
        m.set(DeckId::B, |d| *d = loaded(0.0, false));
        cue[1].track_id = Some("t1".into());
        apply(&m, PHONE, &press(1), &mut cue, t0 + ms(2100));
        assert_eq!(m.take(), ["play 1"]);
        assert_eq!(holder(&cue[1]), Some(PHONE));
    }

    // ---- the app's own controls and a phone's CUE (parity with decks-ffi) ----

    /// Connect on (loopback) with the cue point of deck A at 12.5 s of track "t1". Keep the
    /// sender: the stand-in pump thread lives until it is dropped.
    fn connected() -> (RemoteCtl, mpsc::Sender<()>) {
        let ctl = RemoteCtl::default();
        let pump = {
            let mut c = ctl.lock();
            let pump = fake_pump(&mut c);
            c.start(true, 0, LOOPBACK).unwrap();
            c.cue[0] = cue_at(12.5);
            pump
        };
        (ctl, pump)
    }

    /// What the Tauri deck commands in `lib.rs` do for the app's own controls: tell this
    /// module first, then the engine (`Jump` stands for hot cue / beat jump / phase sync).
    fn local(ctl: &RemoteCtl, m: &Mock, deck: DeckId, what: LocalTransport, now: Instant) {
        note_local(ctl, deck, what, now);
        match what {
            LocalTransport::Play => m.play(deck),
            LocalTransport::Pause => m.pause(deck),
            LocalTransport::Seek(sec) => m.seek(deck, sec),
            LocalTransport::Jump => m.hot_cue(deck, 0),
        }
    }

    /// One phone command through `apply` on the state of `ctl`.
    fn phone_cmd(
        ctl: &RemoteCtl,
        m: &Mock,
        conn: u64,
        cmd: &RemoteCommand,
        now: Instant,
    ) -> Option<CueMoved> {
        apply(m, conn, cmd, &mut ctl.lock().cue, now)
    }

    fn holder_of(ctl: &RemoteCtl, deck: usize) -> Option<u64> {
        holder(&ctl.lock().cue[deck])
    }

    #[test]
    fn the_apps_own_deck_commands_tell_the_remote_module_before_the_engine() {
        // The six commands of the app's own transport controls. Without the call a phone's
        // held CUE outlives the DJ's PLAY / PAUSE / CUE and a phone's press right after the
        // DJ's jump reads a stale playhead (the tests below).
        let src = include_str!("lib.rs").replace("\r\n", "\n");
        for (name, what) in [
            ("deck_play", "LocalTransport::Play"),
            ("deck_pause", "LocalTransport::Pause"),
            ("deck_seek", "LocalTransport::Seek(position)"),
            ("deck_jump_hot_cue", "LocalTransport::Jump"),
            ("deck_beat_jump", "LocalTransport::Jump"),
            ("deck_phase_sync", "LocalTransport::Jump"),
        ] {
            let start = src
                .find(&format!("\nfn {name}("))
                .unwrap_or_else(|| panic!("{name} not found in lib.rs"));
            let body = &src[start..];
            let body = &body[..body.find("\n}\n").expect("end of the command")];
            assert!(
                body.contains("remote_ctl: State<'_, remote::RemoteCtl>"),
                "{name} takes the remote state"
            );
            let note = body
                .find("remote::note_local(&remote_ctl, deck, ")
                .unwrap_or_else(|| panic!("{name} does not call remote::note_local"));
            assert!(body.contains(what), "{name} notes {what}");
            // Lock order: `RemoteCtl` (taken and released inside `note_local`), then the engine.
            let engine = body
                .find("state.0.lock()")
                .or_else(|| body.find("with_engine("))
                .unwrap_or_else(|| panic!("{name}: no engine lock found"));
            assert!(note < engine, "{name}: note_local comes before the engine");
        }
        // A mapped MIDI controller is the DJ's own transport too.
        let midi = include_str!("midi.rs").replace("\r\n", "\n");
        let start = midi
            .find("\nfn handle_message(")
            .expect("handle_message in midi.rs");
        let body = &midi[start..];
        let body = &body[..body.find("\n}\n").expect("end of handle_message")];
        let note = body
            .find("crate::remote::note_local(")
            .expect("midi.rs notes the remote module");
        let engine = body.find("state.0.lock()").expect("midi.rs engine lock");
        assert!(note < engine, "midi.rs: note_local comes before the engine");
        for cmd in ["Command::Play", "Command::Pause", "Command::JumpHotCue"] {
            assert!(midi.contains(&format!("{cmd}(deck")), "midi.rs maps {cmd}");
        }
    }

    #[test]
    fn the_djs_play_in_the_app_during_a_phone_hold_keeps_the_deck_playing() {
        let (ctl, _pump) = connected();
        let m = Mock::with_deck(DeckId::A, loaded(12.5, false));
        let t0 = Instant::now();
        phone_cmd(&ctl, &m, PHONE, &press(0), t0);
        assert_eq!(m.take(), ["play 0"]);
        assert_eq!(holder_of(&ctl, 0), Some(PHONE));
        m.set(DeckId::A, |d| d.position = 14.0);
        // The DJ presses PLAY in the app: the deck is the DJ's now.
        local(&ctl, &m, DeckId::A, LocalTransport::Play, t0 + ms(500));
        assert_eq!(m.take(), ["play 0"]);
        assert_eq!(holder_of(&ctl, 0), None);
        // The phone lets go: no pause, no seek back.
        assert_eq!(phone_cmd(&ctl, &m, PHONE, &release(0), t0 + ms(900)), None);
        assert_eq!(m.take(), [""; 0], "the release must not stop the deck");
        assert!(m.deck_view(DeckId::A).playing);
        assert_eq!(m.deck_view(DeckId::A).position, 14.0);
        // Nor does the phone vanishing, the lock, or Connect off.
        {
            let mut c = ctl.lock();
            pump_engine(&m, &[], &mut c.cue, true, |_| false, t0 + ms(1200));
            drop(c.stop(Some(&m), t0 + ms(1300)));
        }
        assert!(m.take().is_empty());
        assert!(m.deck_view(DeckId::A).playing);
    }

    #[test]
    fn the_djs_pause_in_the_app_during_a_phone_hold_stops_the_deck_where_it_is() {
        let (ctl, _pump) = connected();
        let m = Mock::with_deck(DeckId::A, loaded(12.5, false));
        let t0 = Instant::now();
        phone_cmd(&ctl, &m, PHONE, &press(0), t0);
        m.set(DeckId::A, |d| d.position = 14.0);
        m.take();
        local(&ctl, &m, DeckId::A, LocalTransport::Pause, t0 + ms(500));
        assert_eq!(m.take(), ["pause 0"]);
        assert_eq!(holder_of(&ctl, 0), None);
        // The phone lets go: the deck is not sent back to the cue point.
        assert_eq!(phone_cmd(&ctl, &m, PHONE, &release(0), t0 + ms(900)), None);
        assert_eq!(m.take(), [""; 0], "the release must not seek");
        assert_eq!(m.deck_view(DeckId::A), loaded(14.0, false));
        drop(ctl.lock().stop(Some(&m), t0 + ms(1000)));
        assert!(m.take().is_empty());
    }

    #[test]
    fn the_apps_own_cue_takes_a_deck_back_from_a_phone() {
        let (ctl, _pump) = connected();
        let m = Mock::lagging(DeckId::A, loaded(12.5, false));
        let t0 = Instant::now();
        phone_cmd(&ctl, &m, PHONE, &press(0), t0);
        m.callback(usize::MAX);
        m.set(DeckId::A, |d| d.position = 14.0);
        assert_eq!(m.take(), ["play 0"]);
        // The app's CUE on a playing deck (`cueAction` in Deck.tsx): pause, then seek to the
        // cue point.
        local(&ctl, &m, DeckId::A, LocalTransport::Pause, t0 + ms(500));
        local(
            &ctl,
            &m,
            DeckId::A,
            LocalTransport::Seek(12.5),
            t0 + ms(501),
        );
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);
        assert_eq!(holder_of(&ctl, 0), None, "the phone holds nothing any more");
        // The phone's late release does nothing (not a second pause + seek).
        assert_eq!(phone_cmd(&ctl, &m, PHONE, &release(0), t0 + ms(520)), None);
        assert_eq!(m.take(), [""; 0]);
        // The engine has applied the pause only: the snapshot says "paused at 14 s". A phone
        // press now goes by what the app asked for (the cue point): a preview, not a new cue
        // point at 14 s.
        m.callback(1);
        assert_eq!(m.deck_view(DeckId::A), loaded(14.0, false));
        assert_eq!(phone_cmd(&ctl, &m, OTHER, &press(0), t0 + ms(540)), None);
        assert_eq!(m.take(), ["play 0"]);
        assert_eq!(ctl.lock().cue[0].point, 12.5);
        assert_eq!(holder_of(&ctl, 0), Some(OTHER));
        drop(ctl.lock().stop::<Mock>(None, t0 + ms(600)));
    }

    #[test]
    fn a_phone_press_right_after_the_djs_own_jump_or_seek_does_not_read_a_stale_playhead() {
        let moved = |sec: f64| {
            Some(CueMoved {
                deck: DeckId::A,
                sec,
            })
        };
        // The deck is paused at 50 s, the cue point is at 12.5 s. The DJ jumps in the app (hot
        // cue, beat jump or phase sync); the engine has not reported the new position yet.
        let (ctl, _pump) = connected();
        let m = Mock::lagging(DeckId::A, loaded(50.0, false));
        let t0 = Instant::now();
        local(&ctl, &m, DeckId::A, LocalTransport::Jump, t0);
        assert_eq!(m.take(), ["hot_cue 0 0"]);
        // A phone presses CUE one pump tick later: 50 s is where the playhead just WAS.
        assert_eq!(
            phone_cmd(&ctl, &m, PHONE, &press(0), t0 + ms(40)),
            None,
            "no cue point at the stale position"
        );
        assert_eq!(ctl.lock().cue[0].point, 12.5);
        assert_eq!(m.take(), [""; 0]);
        assert_eq!(holder_of(&ctl, 0), None);
        // Once the engine has caught up, the press counts where the playhead landed.
        m.set(DeckId::A, |d| d.position = 96.0);
        assert_eq!(
            phone_cmd(&ctl, &m, PHONE, &press(0), t0 + ms(40) + SETTLE),
            moved(96.0)
        );
        drop(ctl.lock().stop::<Mock>(None, t0 + ms(400)));

        // A seek in the app (waveform click, CUE) lands where it was sent: a press right after
        // it sets the cue point THERE, not at the old playhead.
        let (ctl, _pump) = connected();
        let m = Mock::lagging(DeckId::A, loaded(50.0, false));
        local(&ctl, &m, DeckId::A, LocalTransport::Seek(30.0), t0);
        assert_eq!(
            phone_cmd(&ctl, &m, PHONE, &press(0), t0 + ms(40)),
            moved(30.0)
        );
        // ... and a seek to the cue point makes it a preview.
        local(
            &ctl,
            &m,
            DeckId::A,
            LocalTransport::Seek(30.0),
            t0 + ms(1000),
        );
        m.take();
        assert_eq!(phone_cmd(&ctl, &m, PHONE, &press(0), t0 + ms(1040)), None);
        assert_eq!(m.take(), ["play 0"]);
        // A position that is no position counts as "unknown", not as a place.
        phone_cmd(&ctl, &m, PHONE, &release(0), t0 + ms(2000));
        m.callback(usize::MAX);
        m.take();
        local(
            &ctl,
            &m,
            DeckId::A,
            LocalTransport::Seek(f64::NAN),
            t0 + ms(3000),
        );
        assert_eq!(phone_cmd(&ctl, &m, PHONE, &press(0), t0 + ms(3040)), None);
        assert_eq!(holder_of(&ctl, 0), None);
        drop(ctl.lock().stop::<Mock>(None, t0 + ms(3100)));

        // The DJ's PLAY, then a phone's CUE before the engine reports "playing": back to the
        // cue point, not "set a cue point on a paused deck".
        let (ctl, _pump) = connected();
        let m = Mock::lagging(DeckId::A, loaded(50.0, false));
        local(&ctl, &m, DeckId::A, LocalTransport::Play, t0);
        assert_eq!(phone_cmd(&ctl, &m, PHONE, &press(0), t0 + ms(40)), None);
        assert_eq!(m.take(), ["play 0", "pause 0", "seek 0 12.5"]);
        assert_eq!(ctl.lock().cue[0].point, 12.5);
        drop(ctl.lock().stop::<Mock>(None, t0 + ms(100)));
    }

    #[test]
    fn noting_the_apps_own_controls_costs_nothing_while_connect_is_off() {
        let ctl = RemoteCtl::default();
        let t0 = Instant::now();
        for what in [
            LocalTransport::Play,
            LocalTransport::Pause,
            LocalTransport::Seek(3.0),
            LocalTransport::Jump,
        ] {
            for deck in DeckId::ALL {
                note_local(&ctl, deck, what, t0);
            }
        }
        assert_eq!(
            ctl.lock().cue,
            cues(),
            "off and nothing held: nothing is kept"
        );
        // The cue points and a hold are kept while off; a hold is still ended by PLAY.
        ctl.lock().cue[1] = CueDeck {
            hold: Some(Hold {
                conn: PHONE,
                duration: T1_SEC,
            }),
            ..cue_at(60.0)
        };
        note_local(&ctl, DeckId::A, LocalTransport::Play, t0);
        assert_eq!(holder_of(&ctl, 1), Some(PHONE), "another deck's hold stays");
        note_local(&ctl, DeckId::B, LocalTransport::Play, t0);
        assert_eq!(holder_of(&ctl, 1), None);
        assert_eq!(ctl.lock().cue[1].point, 60.0);
    }

    // ---- the scenario table shared with the native binding ------------------------------
    //
    // The SAME rows are in `crates/decks-ffi/src/cue_button.rs`
    // (`tests::the_shared_cue_scenarios`): the two CUE implementations must make the same
    // engine calls for the same presses. Edit both.

    #[derive(Debug, Clone, Copy)]
    enum Who {
        Phone,
        Other,
    }

    #[derive(Debug, Clone, Copy)]
    enum Step {
        /// A phone presses / lets go of CUE.
        Press(Who),
        Release(Who),
        /// The DJ's own PLAY / PAUSE / CUE (CUE on a playing deck = pause + back to the cue
        /// point; the desktop UI sends it as pause + seek).
        Play,
        Pause,
        Cue,
        /// Another track is loaded on the deck and the DJ starts it (playing at 33 s).
        NewTrack,
        /// The DJ locks the phone controls.
        Lock,
        /// The playhead has moved here.
        At(f64),
    }

    type Scenario = (
        &'static str,
        &'static [(Step, &'static [&'static str])],
        bool,
    );

    /// Deck A paused on its cue point 12.5 s; expected engine calls per step ("play", "pause",
    /// "seek <sec>"), and whether the deck plays at the end.
    const SCENARIOS: &[Scenario] = &[
        (
            "phone press and release",
            &[
                (Step::Press(Who::Phone), &["play"]),
                (Step::At(14.0), &[]),
                (Step::Release(Who::Phone), &["pause", "seek 12.5"]),
            ],
            false,
        ),
        (
            "second phone ignored",
            &[
                (Step::Press(Who::Phone), &["play"]),
                (Step::At(14.0), &[]),
                (Step::Press(Who::Other), &[]),
                (Step::Release(Who::Other), &[]),
                (Step::Release(Who::Phone), &["pause", "seek 12.5"]),
            ],
            false,
        ),
        (
            "local CUE overrides a phone hold",
            &[
                (Step::Press(Who::Phone), &["play"]),
                (Step::At(14.0), &[]),
                (Step::Cue, &["pause", "seek 12.5"]),
                (Step::Release(Who::Phone), &[]),
            ],
            false,
        ),
        (
            "local PLAY during a phone hold keeps the deck playing",
            &[
                (Step::Press(Who::Phone), &["play"]),
                (Step::At(14.0), &[]),
                (Step::Play, &["play"]),
                (Step::Release(Who::Phone), &[]),
            ],
            true,
        ),
        (
            "local PAUSE during a phone hold stops where the deck is",
            &[
                (Step::Press(Who::Phone), &["play"]),
                (Step::At(14.0), &[]),
                (Step::Pause, &["pause"]),
                (Step::Release(Who::Phone), &[]),
            ],
            false,
        ),
        (
            "track change during a hold",
            &[
                (Step::Press(Who::Phone), &["play"]),
                (Step::NewTrack, &[]),
                (Step::Release(Who::Phone), &[]),
            ],
            true,
        ),
        (
            "lock ends holds",
            &[
                (Step::Press(Who::Phone), &["play"]),
                (Step::At(14.0), &[]),
                (Step::Lock, &["pause", "seek 12.5"]),
                (Step::Release(Who::Phone), &[]),
            ],
            false,
        ),
    ];

    /// The mock's log in the shared vocabulary: "seek 0 12.5" = "seek 12.5" (deck A only).
    fn canon(calls: Vec<String>) -> Vec<String> {
        calls
            .into_iter()
            .map(|c| {
                let mut words = c.split(' ');
                let verb = words.next().unwrap_or_default().to_string();
                assert_eq!(words.next(), Some("0"), "deck A: {c}");
                words.fold(verb, |line, w| format!("{line} {w}"))
            })
            .collect()
    }

    #[test]
    fn the_shared_cue_scenarios() {
        let t0 = Instant::now();
        let who = |w: Who| match w {
            Who::Phone => PHONE,
            Who::Other => OTHER,
        };
        for (name, steps, playing) in SCENARIOS {
            let (ctl, _pump) = connected();
            let m = Mock::with_deck(DeckId::A, loaded(12.5, false));
            // One pump step with these phone commands, as the pump thread runs it.
            let pump = |cmds: &[CommandFrom], now: Instant| {
                let mut c = ctl.lock();
                let locked = c.locked;
                pump_engine(&m, cmds, &mut c.cue, locked, |_| true, now);
            };
            for (i, (step, calls)) in steps.iter().enumerate() {
                let t = t0 + ms(1000 * (i as u64 + 1));
                match *step {
                    Step::Press(w) => pump(&[from(who(w), press(0))], t),
                    Step::Release(w) => pump(&[from(who(w), release(0))], t),
                    Step::Play => local(&ctl, &m, DeckId::A, LocalTransport::Play, t),
                    Step::Pause => local(&ctl, &m, DeckId::A, LocalTransport::Pause, t),
                    Step::Cue => {
                        local(&ctl, &m, DeckId::A, LocalTransport::Pause, t);
                        local(&ctl, &m, DeckId::A, LocalTransport::Seek(12.5), t + ms(1));
                    }
                    Step::NewTrack => m.set(DeckId::A, |d| {
                        *d = DeckView {
                            loaded: true,
                            playing: true,
                            position: 33.0,
                            duration: 200.0,
                            track_id: Some("t2".into()),
                        }
                    }),
                    Step::Lock => {
                        ctl.lock().set_locked(true);
                        pump(&[], t);
                    }
                    Step::At(p) => m.set(DeckId::A, |d| d.position = p),
                }
                assert_eq!(canon(m.take()), *calls, "{name}: step {i} {step:?}");
            }
            assert_eq!(
                m.deck_view(DeckId::A).playing,
                *playing,
                "{name}: playing at the end"
            );
            // Nothing is left for Connect off to end.
            drop(ctl.lock().stop(Some(&m), t0 + ms(60_000)));
            assert!(m.take().is_empty(), "{name}: a hold was left");
        }
    }

    /// A phone remote on a real loopback socket, paired as a controller. The WebSocket
    /// handshake is written by hand: the app crate has no WebSocket client.
    fn phone(server: &RemoteServer, client: &str) -> TcpStream {
        let mut s = TcpStream::connect(("127.0.0.1", server.port())).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        write!(
            s,
            "GET /ws?t={}&c={client} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            server.token(Role::Controller),
            server.port()
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

    /// What the pump thread does on every step, until the engine saw `done` (5 s at most).
    fn pump_until(
        m: &Mock,
        server: &RemoteServer,
        cue: &mut [CueDeck; 4],
        what: &str,
        done: impl Fn(&[String]) -> bool,
    ) -> Vec<String> {
        let end = Instant::now() + Duration::from_secs(5);
        let mut calls = Vec::new();
        while Instant::now() < end {
            let cmds = server.drain_commands_from();
            let connected = |conn| server.is_connected(conn);
            pump_engine(m, &cmds, cue, false, connected, Instant::now());
            calls.extend(m.take());
            if done(&calls) {
                return calls;
            }
            std::thread::sleep(ms(10));
        }
        panic!("timed out: {what}; engine calls so far: {calls:?}");
    }

    #[test]
    fn a_real_phone_that_goes_away_while_holding_cue_lets_the_deck_go() {
        const HOLD_A: &str =
            r#"{"type":"command","command":{"cmd":"cue","deck":0,"pressed":true}}"#;
        const HOLD_B: &str =
            r#"{"type":"command","command":{"cmd":"cue","deck":1,"pressed":true}}"#;
        let m = Mock::with_deck(DeckId::A, loaded(12.5, false));
        m.set(DeckId::B, |d| *d = loaded(60.0, false));
        let mut ctl = Ctl::default();
        let _pump = fake_pump(&mut ctl);
        ctl.start(true, 0, LOOPBACK).unwrap();
        ctl.cue[0] = cue_at(12.5);
        ctl.cue[1] = cue_at(60.0);
        {
            let Ctl { server, cue, .. } = &mut ctl;
            let server = server.as_ref().unwrap();
            // Two phones, each holding CUE on its deck, through the real server.
            let mut closing = phone(server, "closing");
            let mut rotated = phone(server, "rotated");
            say(&mut closing, HOLD_A);
            let calls = pump_until(&m, server, cue, "first hold", |c| !c.is_empty());
            assert_eq!(calls, ["play 0"]);
            say(&mut rotated, HOLD_B);
            let calls = pump_until(&m, server, cue, "second hold", |c| !c.is_empty());
            assert_eq!(calls, ["play 1"]);
            let (a, b) = (holder(&cue[0]).unwrap(), holder(&cue[1]).unwrap());
            assert_ne!(a, b, "each hold names its own connection");
            assert!(server.is_connected(a) && server.is_connected(b));
            // The tab of the first phone is killed with the finger down: no release is sent.
            drop(closing);
            let calls = pump_until(&m, server, cue, "socket closed", |c| !c.is_empty());
            assert_eq!(calls, ["pause 0", "seek 0 12.5"]);
            assert!(!server.is_connected(a));
            assert!(
                m.deck_view(DeckId::B).playing,
                "the other phone still holds its deck"
            );
            // "New code" for the remote: the server disconnects the second phone.
            server.rotate_token(Role::Controller);
            let calls = pump_until(&m, server, cue, "code rotated", |c| !c.is_empty());
            assert_eq!(calls, ["pause 1", "seek 1 60"]);
            assert!(cue.iter().all(|c| c.hold.is_none()));
            drop(rotated);
        }
        // Nothing is left for Connect off to end.
        drop(ctl.stop(Some(&m), Instant::now()));
        assert!(m.take().is_empty());
    }

    // ---- R4: the engine answers one audio buffer late ----

    #[test]
    fn a_second_press_before_the_engine_caught_up_does_not_move_the_cue_point() {
        // The deck plays at 42 s; the cue point is at 12.5 s.
        let m = Mock::lagging(DeckId::A, loaded(42.0, true));
        let mut cue = cues();
        cue[0] = cue_at(12.5);
        let t0 = Instant::now();
        assert_eq!(apply(&m, PHONE, &press(0), &mut cue, t0), None);
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);
        assert_eq!(apply(&m, PHONE, &release(0), &mut cue, t0 + ms(20)), None);
        // The audio callback took the pause; the seek is applied one callback later. The
        // snapshot says: paused, still at 42 s.
        m.callback(1);
        assert_eq!(m.deck_view(DeckId::A), loaded(42.0, false));
        // Second press one pump tick later. Read from the snapshot this is "paused elsewhere"
        // and would MOVE the cue point to 42 s.
        assert_eq!(
            apply(&m, PHONE, &press(0), &mut cue, t0 + ms(50)),
            None,
            "the cue point must not move to the old playhead"
        );
        assert_eq!(cue[0].point, 12.5);
        // The deck was sent to the cue point, so this press is "hold to preview".
        assert_eq!(m.take(), ["play 0"]);
        assert_eq!(holder(&cue[0]), Some(PHONE));

        // The same race on the other path: letting go of a hold sends "pause + seek"; a press
        // right after it reads the place the preview had reached.
        m.callback(usize::MAX);
        m.set(DeckId::A, |d| d.position = 14.0);
        apply(&m, PHONE, &release(0), &mut cue, t0 + ms(2000));
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);
        m.callback(1);
        assert_eq!(m.deck_view(DeckId::A), loaded(14.0, false));
        assert_eq!(apply(&m, PHONE, &press(0), &mut cue, t0 + ms(2040)), None);
        assert_eq!(cue[0].point, 12.5);
        assert_eq!(m.take(), ["play 0"]);
        apply(&m, PHONE, &release(0), &mut cue, t0 + ms(2080));
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);

        // A press while the snapshot still says "playing" (nothing applied yet) is not a
        // second "back to the cue point" either: the deck was already sent there.
        let m = Mock::lagging(DeckId::A, loaded(42.0, true));
        let mut cue = cues();
        cue[0] = cue_at(12.5);
        apply(&m, PHONE, &press(0), &mut cue, t0);
        apply(&m, PHONE, &release(0), &mut cue, t0 + ms(10));
        m.take();
        assert!(
            m.deck_view(DeckId::A).playing,
            "the engine has not answered"
        );
        apply(&m, PHONE, &press(0), &mut cue, t0 + ms(30));
        assert_eq!(m.take(), ["play 0"]);
        assert_eq!(cue[0].point, 12.5);
    }

    #[test]
    fn the_snapshot_counts_again_once_the_engine_has_settled() {
        let m = Mock::lagging(DeckId::A, loaded(42.0, true));
        let mut cue = cues();
        cue[0] = cue_at(12.5);
        let t0 = Instant::now();
        apply(&m, PHONE, &press(0), &mut cue, t0);
        apply(&m, PHONE, &release(0), &mut cue, t0 + ms(10));
        m.callback(usize::MAX);
        m.take();
        // Later the DJ moves the playhead in the app (paused at 30 s): a press there sets the
        // cue point, as before.
        m.set(DeckId::A, |d| d.position = 30.0);
        assert_eq!(
            apply(&m, PHONE, &press(0), &mut cue, t0 + SETTLE),
            Some(CueMoved {
                deck: DeckId::A,
                sec: 30.0
            })
        );
        assert!(m.take().is_empty());

        // PLAY from the phone, then CUE before the engine reports "playing": the press is
        // "back to the cue point", not "set a cue point on a paused deck".
        let m = Mock::lagging(DeckId::A, loaded(42.0, false));
        let mut cue = cues();
        cue[0] = cue_at(12.5);
        apply(&m, PHONE, &RemoteCommand::Play { deck: 0 }, &mut cue, t0);
        assert_eq!(apply(&m, PHONE, &press(0), &mut cue, t0 + ms(40)), None);
        assert_eq!(m.take(), ["play 0", "pause 0", "seek 0 12.5"]);
        assert_eq!(cue[0].point, 12.5);

        // A jump on a paused deck (hot cue, beat jump): where the playhead lands is not known
        // for one buffer. A press in that moment is dropped rather than read from the place
        // the playhead just left; the next one counts.
        let m = Mock::lagging(DeckId::A, loaded(12.5, false));
        let mut cue = cues();
        cue[0] = cue_at(12.5);
        apply(
            &m,
            PHONE,
            &RemoteCommand::HotCue { deck: 0, slot: 2 },
            &mut cue,
            t0,
        );
        assert_eq!(apply(&m, PHONE, &press(0), &mut cue, t0 + ms(40)), None);
        assert_eq!(
            m.take(),
            ["hot_cue 0 2"],
            "no preview from the stale position"
        );
        assert_eq!(holder(&cue[0]), None);
        m.set(DeckId::A, |d| d.position = 96.0);
        assert_eq!(
            apply(&m, PHONE, &press(0), &mut cue, t0 + ms(40) + SETTLE),
            Some(CueMoved {
                deck: DeckId::A,
                sec: 96.0
            })
        );
    }

    // ---- R6: controls lock ----

    #[test]
    fn locked_controls_drop_phone_commands_and_end_holds() {
        let m = Mock::with_deck(DeckId::A, loaded(12.5, false));
        let mut cue = cues();
        cue[0] = cue_at(12.5);
        let t0 = Instant::now();
        pump_engine(&m, &[from(PHONE, press(0))], &mut cue, false, |_| true, t0);
        assert_eq!(m.take(), ["play 0"]);
        // The DJ locks the phones: the held CUE ends at the next step, phone still connected.
        pump_engine(&m, &[], &mut cue, true, |_| true, t0 + ms(400));
        assert_eq!(m.take(), ["pause 0", "seek 0 12.5"]);
        assert_eq!(holder(&cue[0]), None);
        // Whatever a phone still gets through is dropped here as well; a pocket touch cannot
        // pause a deck or zero the master.
        let cmds = [
            from(PHONE, RemoteCommand::Play { deck: 0 }),
            from(PHONE, RemoteCommand::MasterVolume { value: 0.0 }),
            from(PHONE, RemoteCommand::Crossfader { value: 1.0 }),
            from(PHONE, RemoteCommand::Pause { deck: 1 }),
            from(PHONE, press(0)),
            from(PHONE, RemoteCommand::HotCue { deck: 0, slot: 0 }),
            from(PHONE, release(0)),
        ];
        let moved = pump_engine(&m, &cmds, &mut cue, true, |_| true, t0 + ms(800));
        assert!(moved.is_empty());
        assert_eq!(m.take(), [""; 0], "locked: no engine call");
        // Unlocked, the same commands act.
        pump_engine(&m, &cmds[..3], &mut cue, false, |_| true, t0 + ms(1200));
        assert_eq!(m.take(), ["play 0", "master 0", "crossfader 1"]);
    }

    #[test]
    fn the_controls_lock_is_kept_while_off_and_applied_to_the_server() {
        let mut ctl = Ctl::default();
        assert!(!ctl.status().controls_locked);
        ctl.set_locked(true);
        let off = ctl.status();
        assert!(off.controls_locked && !off.running, "stored while off");
        let _pump = fake_pump(&mut ctl);
        ctl.start(true, 0, LOOPBACK).unwrap();
        assert!(ctl.server.as_ref().unwrap().controls_locked());
        assert!(ctl.status().controls_locked && ctl.event().controls_locked);
        ctl.set_locked(false);
        assert!(!ctl.server.as_ref().unwrap().controls_locked());
        assert!(!ctl.status().controls_locked && !ctl.event().controls_locked);
        // Locked, off and on again: still locked.
        ctl.set_locked(true);
        drop(ctl.stop::<Mock>(None, Instant::now()));
        ctl.start(true, 0, LOOPBACK).unwrap();
        assert!(ctl.server.as_ref().unwrap().controls_locked());
        drop(ctl.stop::<Mock>(None, Instant::now()));
    }

    // ---- R2: no server without the thread that serves it ----

    #[test]
    fn connect_refuses_to_start_without_its_worker_thread() {
        let mut ctl = Ctl::default();
        // The pump thread was never spawned (`init` failed): Connect must not say "on".
        assert_eq!(ctl.start(true, 0, LOOPBACK), Err(NO_PUMP.to_string()));
        assert!(
            ctl.server.is_none() && ctl.host.is_none(),
            "no port was opened"
        );
        assert!(!ctl.status().running);
        // The thread ended (a panic): the same.
        let (tx, rx) = mpsc::channel::<()>();
        let ended = std::thread::spawn(move || {
            let _ = rx.recv();
        });
        drop(tx);
        while !ended.is_finished() {
            std::thread::sleep(ms(5));
        }
        ctl.pump = Some(ended);
        assert_eq!(ctl.start(true, 0, LOOPBACK), Err(NO_PUMP.to_string()));
        assert!(ctl.server.is_none());
        // A spawn that fails is reported to the caller, not only logged.
        let err = ensure_pump_with(&mut ctl, || Err(std::io::Error::other("no threads left")))
            .unwrap_err();
        assert!(
            err.starts_with(NO_PUMP) && err.contains("no threads left"),
            "{err}"
        );
        assert!(ctl.pump.is_none());
        assert_eq!(ctl.start(true, 0, LOOPBACK), Err(NO_PUMP.to_string()));
        // A spawn that works: the handle is stored at once (the caller holds the state lock),
        // a second call spawns nothing, and Connect starts.
        let spawned = Cell::new(0);
        let (tx, rx) = mpsc::channel::<()>();
        let mut rx = Some(rx);
        let mut spawn = || {
            spawned.set(spawned.get() + 1);
            let rx = rx.take().expect("spawned once");
            Ok(std::thread::spawn(move || {
                let _ = rx.recv();
            }))
        };
        ensure_pump_with(&mut ctl, &mut spawn).unwrap();
        assert!(ctl.pump.is_some());
        ensure_pump_with(&mut ctl, &mut spawn).unwrap();
        assert_eq!(spawned.get(), 1);
        ctl.start(true, 0, LOOPBACK).unwrap();
        assert!(ctl.status().running);
        drop(ctl.stop::<Mock>(None, Instant::now()));
        drop(tx);
    }

    #[test]
    fn starting_connect_wakes_the_parked_pump() {
        let mut ctl = Ctl::default();
        let (woke_tx, woke_rx) = mpsc::channel::<()>();
        ctl.pump = Some(std::thread::spawn(move || {
            std::thread::park();
            let _ = woke_tx.send(());
        }));
        ctl.start(false, 0, LOOPBACK).unwrap();
        assert_eq!(woke_rx.recv_timeout(Duration::from_secs(5)), Ok(()));
        drop(ctl.stop::<Mock>(None, Instant::now()));
    }

    fn view() -> EngineView {
        EngineView {
            mixer: MixerState::initial(48_000),
            decks: [DeckExtra::default(); 4],
            beats_per_bar: 4,
            master_bpm: 0.0,
            recording: false,
        }
    }

    fn labels() -> [DeckLabel; 4] {
        Default::default()
    }

    #[test]
    fn an_idle_engine_publishes_four_empty_decks() {
        let s = remote_state(&view(), &labels());
        assert_eq!(s.decks.len(), 4);
        assert_eq!(
            s.decks.iter().map(|d| d.deck).collect::<Vec<_>>(),
            [0, 1, 2, 3]
        );
        assert!(s.decks.iter().all(|d| !d.loaded && !d.playing));
        assert!(
            s.decks
                .iter()
                .all(|d| d.title.is_none() && d.bpm.is_none() && d.key.is_none())
        );
        assert!(s.now_playing().is_empty());
    }

    #[test]
    fn state_maps_mixer_clock_and_keys() {
        let mut v = view();
        v.mixer.crossfader = -0.5;
        v.mixer.master_volume = 0.6;
        v.master_bpm = 126.0;
        v.recording = true;
        {
            let d = &mut v.mixer.decks[1];
            d.loaded = true;
            d.playing = true;
            d.track_id = Some("t1".into());
            d.title = Some("file title".into());
            d.position = 61.5;
            d.duration = 300.0;
            d.bpm = 120.0;
            d.tempo = 1.05;
            d.volume = 0.8;
            d.eq_low = -26.0;
            d.eq_mid = 1.0;
            d.eq_high = 2.0;
            d.filter = 0.25;
            d.loop_active = true;
            d.vu = 0.4;
        }
        // 8A = A minor; one semitone up = B flat minor = 3A.
        v.decks[1] = DeckExtra {
            bpm: 126.0,
            bar_phase: Some(3.0),
            key_shift: 1.0,
            sync_lock: true,
            key: mixai_core::keys::camelot_to_key("8A"),
        };
        let s = remote_state(&v, &labels());
        assert_eq!(s.crossfader, -0.5);
        assert_eq!(s.master_volume, 0.6);
        assert_eq!(s.master_bpm, 126.0);
        assert!(s.recording);
        let d = &s.decks[1];
        assert_eq!(d.deck, 1);
        assert!(d.loaded && d.playing && d.loop_active && d.sync_lock);
        assert_eq!(d.title.as_deref(), Some("file title"));
        assert_eq!(d.bpm, Some(126.0));
        assert_eq!(d.key.as_deref(), Some("3A"));
        assert_eq!((d.position_sec, d.duration_sec), (61.5, 300.0));
        assert_eq!(
            (d.volume, d.eq_low, d.eq_mid, d.eq_high, d.filter, d.vu),
            (0.8, -26.0, 1.0, 2.0, 0.25, 0.4)
        );
        assert_eq!(
            d.bar_phase,
            Some(0.75),
            "beat 3 of 4, as 0..1 for the phones"
        );
        // No clock tempo yet: the grid tempo times the tempo fader.
        v.decks[1].bpm = 0.0;
        assert_eq!(remote_state(&v, &labels()).decks[1].bpm, Some(126.0));
        // No key lock: +5 % tempo is +0.84 semitones on top of the shift, so two up = 10A.
        v.mixer.decks[1].key_lock = false;
        assert_eq!(
            remote_state(&v, &labels()).decks[1].key.as_deref(),
            Some("10A")
        );
    }

    #[test]
    fn a_label_counts_only_for_the_track_it_was_sent_for() {
        let mut v = view();
        {
            let d = &mut v.mixer.decks[0];
            d.loaded = true;
            d.playing = true;
            d.track_id = Some("t1".into());
            d.title = Some("strobe.flac".into());
        }
        let mut l = labels();
        l[0] = DeckLabel {
            track_id: Some("t1".into()),
            title: Some("Strobe".into()),
            artist: Some("deadmau5".into()),
        };
        let s = remote_state(&v, &l);
        assert_eq!(s.decks[0].title.as_deref(), Some("Strobe"));
        assert_eq!(s.decks[0].artist.as_deref(), Some("deadmau5"));
        assert_eq!(s.now_playing(), ["deadmau5 — Strobe"]);
        // Another track on the deck: the old label must not name it.
        v.mixer.decks[0].track_id = Some("t2".into());
        v.mixer.decks[0].title = Some("other.flac".into());
        let s = remote_state(&v, &l);
        assert_eq!(s.decks[0].title.as_deref(), Some("other.flac"));
        assert_eq!(s.decks[0].artist, None);
    }

    #[test]
    fn effective_key_wraps_and_refuses_unknown_keys() {
        assert_eq!(effective_key(None, 0.0, 1.0, true), None);
        assert_eq!(effective_key(Some(24), 0.0, 1.0, true), None);
        let c_major = mixai_core::keys::camelot_to_key("8B");
        assert_eq!(
            effective_key(c_major, 0.0, 1.0, true).as_deref(),
            Some("8B")
        );
        assert_eq!(
            effective_key(c_major, -1.0, 1.0, true).as_deref(),
            Some("1B")
        );
        assert_eq!(
            effective_key(c_major, 12.0, 1.0, true).as_deref(),
            Some("8B")
        );
        assert_eq!(
            effective_key(c_major, f64::NAN, 1.0, true).as_deref(),
            Some("8B")
        );
    }

    #[test]
    fn roles_decisions_and_bind_addresses_are_parsed_strictly() {
        assert_eq!(parse_role("controller"), Ok(Role::Controller));
        assert_eq!(parse_role("viewer"), Ok(Role::Viewer));
        assert_eq!(parse_role("guest"), Ok(Role::Guest));
        assert!(parse_role("Guest").is_err());
        assert!(parse_role("").is_err());
        assert_eq!(parse_decision("accepted"), Ok(RequestStatus::Accepted));
        assert_eq!(parse_decision("rejected"), Ok(RequestStatus::Rejected));
        assert_eq!(parse_decision("played"), Ok(RequestStatus::Played));
        assert!(parse_decision("pending").is_err());
        assert!(parse_decision("done").is_err());
        assert_eq!(parse_bind(None), Ok(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
        assert_eq!(
            parse_bind(Some("  ")),
            Ok(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
        );
        assert_eq!(parse_bind(Some("127.0.0.1")), Ok(LOOPBACK));
        assert!(parse_bind(Some("::1")).is_ok());
        assert!(parse_bind(Some("::")).is_err());
        assert!(parse_bind(Some("localhost")).is_err());
        assert!(parse_bind(Some("300.1.1.1")).is_err());
    }

    #[test]
    fn stopped_status_serialises_as_off_with_camel_case_keys() {
        let ctl = Ctl::default();
        let v = serde_json::to_value(ctl.status()).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "running": false,
                "port": null,
                "host": null,
                "urlController": null,
                "urlViewer": null,
                "urlGuest": null,
                "pairings": [],
                "clients": [],
                "partyOpen": false,
                "requestsPending": 0,
                "controlsLocked": false,
            })
        );
        assert_eq!(
            serde_json::to_value(ctl.event()).unwrap(),
            serde_json::json!({ "running": false, "partyOpen": false, "controlsLocked": false, "clients": [], "requests": [] })
        );
        assert_eq!(
            serde_json::to_value(CuePayload {
                deck: DeckId::B,
                sec: 1.5
            })
            .unwrap(),
            serde_json::json!({ "deck": "b", "sec": 1.5 })
        );
    }

    #[test]
    fn lifecycle_on_loopback_pairings_rotation_requests_and_stop() {
        let mut ctl = Ctl::default();
        let _pump = fake_pump(&mut ctl);
        assert_eq!(ctl.rotate(Role::Guest), Err(NOT_RUNNING.to_string()));
        assert_eq!(
            ctl.decide(1, RequestStatus::Played),
            Err(NOT_RUNNING.to_string())
        );
        ctl.start(false, 0, LOOPBACK).unwrap();
        let s = ctl.status();
        assert!(s.running && !s.party_open);
        let port = s.port.unwrap();
        assert_ne!(port, 0);
        assert_eq!(s.host.as_deref(), Some("127.0.0.1"));
        let base = format!("http://127.0.0.1:{port}");
        assert!(
            s.url_controller
                .as_deref()
                .unwrap()
                .starts_with(&format!("{base}/?t="))
        );
        assert!(
            s.url_viewer
                .as_deref()
                .unwrap()
                .starts_with(&format!("{base}/?t="))
        );
        assert!(
            s.url_guest
                .as_deref()
                .unwrap()
                .starts_with(&format!("{base}/party?t="))
        );
        assert_ne!(
            s.url_controller, s.url_viewer,
            "every role has its own token"
        );
        assert_eq!(
            s.pairings.iter().map(|p| p.role).collect::<Vec<_>>(),
            [Role::Controller, Role::Viewer, Role::Guest]
        );
        for p in &s.pairings {
            // The UI inlines this SVG: it must take the page's colour and carry none of its own.
            assert!(p.qr_svg.starts_with("<svg "), "{:?}", p.role);
            assert!(p.qr_svg.contains("fill=\"currentColor\""));
            assert!(!p.qr_svg.contains('#') && !p.qr_svg.contains("<script"));
        }
        assert!(s.clients.is_empty());
        assert_eq!(s.requests_pending, 0);
        // A second start changes nothing (same port, same codes).
        ctl.start(true, 0, LOOPBACK).unwrap();
        assert_eq!(ctl.status(), s);
        // New code: only that role's URL changes.
        let fresh = ctl.rotate(Role::Guest).unwrap();
        assert_eq!(fresh.role, Role::Guest);
        assert_ne!(Some(&fresh.url), s.url_guest.as_ref());
        let after = ctl.status();
        assert_eq!(after.url_guest.as_ref(), Some(&fresh.url));
        assert_eq!(after.url_controller, s.url_controller);
        assert_eq!(
            ctl.decide(7, RequestStatus::Accepted),
            Err("request 7 not found".to_string())
        );
        assert!(ctl.event().running);
        drop(ctl.stop::<Mock>(None, Instant::now()));
        assert_eq!(ctl.status(), RemoteStatus::default());
        assert!(!ctl.event().running);
    }

    fn label(deck: &str, track: &str, title: &str, cue: Option<f64>) -> LabelReq {
        LabelReq {
            deck: deck.into(),
            track_id: Some(track.into()),
            title: Some(title.into()),
            artist: None,
            cue_sec: cue,
        }
    }

    #[test]
    fn labels_are_cleaned_capped_and_carry_the_cue_point() {
        let mut ctl = Ctl::default();
        let hold = Some(Hold {
            conn: PHONE,
            duration: T1_SEC,
        });
        ctl.cue[1].hold = hold;
        ctl.set_labels(vec![
            label("a", "t1", "  Str\u{7}obe\n ", Some(12.5)),
            LabelReq {
                deck: "b".into(),
                track_id: None,
                title: Some("x".repeat(500)),
                artist: Some("   ".into()),
                cue_sec: None,
            },
        ])
        .unwrap();
        assert_eq!(ctl.labels[0].title.as_deref(), Some("Strobe"));
        assert_eq!(ctl.labels[0].track_id.as_deref(), Some("t1"));
        assert_eq!(ctl.cue[0], cue_at(12.5));
        assert_eq!(
            ctl.labels[1].title.as_ref().map(|t| t.chars().count()),
            Some(MAX_LABEL_CHARS)
        );
        assert_eq!(ctl.labels[1].artist, None, "blank = none");
        assert_eq!(ctl.cue[1].point, 0.0);
        assert_eq!(
            ctl.cue[1].hold, hold,
            "no id before, no id now: whether the track is the same is the engine's to say"
        );
        // The same track again keeps a running hold; another track ends it.
        ctl.cue[0].hold = hold;
        ctl.set_labels(vec![label("a", "t1", "Strobe", Some(3.0))])
            .unwrap();
        assert_eq!(ctl.cue[0].hold, hold);
        assert_eq!(ctl.cue[0].point, 3.0);
        ctl.set_labels(vec![label("a", "t2", "Other", None)])
            .unwrap();
        assert_eq!(ctl.cue[0].hold, None);
        assert_eq!(ctl.cue[0].point, 0.0);
    }

    #[test]
    fn bidi_and_zero_width_characters_never_reach_a_phone() {
        // What a track tag (or a renamed file) could carry to reverse or blank a title.
        let hidden = [
            '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}', '\u{202E}', '\u{2066}', '\u{2067}',
            '\u{2068}', '\u{2069}', '\u{200B}', '\u{200C}', '\u{200D}', '\u{200E}', '\u{200F}',
            '\u{FEFF}',
        ];
        for c in hidden {
            assert_eq!(
                clean_text(Some(format!("{c}Str{c}obe{c}"))).as_deref(),
                Some("Strobe"),
                "U+{:04X}",
                c as u32
            );
            // Nothing but hidden characters is no text at all, like an empty string.
            assert_eq!(
                clean_text(Some(format!("{c} {c}"))),
                None,
                "U+{:04X}",
                c as u32
            );
        }
        assert_eq!(
            clean_text(Some("\u{202E}\u{2066}\u{200B}\u{FEFF}".into())),
            None
        );
        // A variation selector with nothing to vary draws nothing; after an emoji it stays.
        assert_eq!(clean_text(Some("\u{FE0F} \u{200B}\u{FE0F}".into())), None);
        assert_eq!(
            clean_text(Some("\u{2764}\u{FE0F} Love".into())).as_deref(),
            Some("\u{2764}\u{FE0F} Love")
        );
        assert_eq!(clean_text(Some(String::new())), None);
        assert_eq!(clean_text(None), None);
        // Real text of any script and emoji stay as they are.
        for keep in ["Ștefan Bănică", "Жара", "אהבה", "夜に駆ける", "🎧 Set 2"] {
            assert_eq!(clean_text(Some(keep.into())).as_deref(), Some(keep));
        }
        // Romanian letters, emoji sequences (family, rainbow flag) and a subdivision flag
        // (England) arrive whole.
        for keep in [
            "ă â î ș ț Ă Â Î Ș Ț",
            "Înger și demon în țară",
            "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} Family Affair",
            "Pride \u{1F3F3}\u{FE0F}\u{200D}\u{1F308}",
            "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} Three Lions",
        ] {
            assert_eq!(clean_text(Some(keep.into())).as_deref(), Some(keep));
        }
        // A line break or a tab in a tag is a gap, not nothing; a bidi override next to it
        // still goes, and so do a joiner between letters and tag characters outside a flag.
        for (tag, want) in [
            ("a\nb", "a b"),
            ("Line1\r\nLine2", "Line1 Line2"),
            ("Side A\tTrack 1\n", "Side A Track 1"),
            ("Zdob\u{2028}și\u{2029}Zdub", "Zdob și Zdub"),
            ("\u{202E}evil\n\u{202C}live", "evil live"),
            ("Str\u{200D}obe", "Strobe"),
            ("Strobe\u{E0067}\u{E0062}\u{E007F}", "Strobe"),
            (
                "\u{1F3F4}\u{E0067}\u{E0062} half a flag",
                "\u{1F3F4} half a flag",
            ),
        ] {
            assert_eq!(
                clean_text(Some(tag.into())).as_deref(),
                Some(want),
                "{tag:?}"
            );
        }
        assert_eq!(clean_text(Some("\n\t\r\n".into())), None);
        // The length limit never leaves half a sequence behind: a flag cut in its tags is a
        // plain flag, a family cut after a joiner ends on a whole emoji.
        let england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
        let cut = clean_text(Some(format!(
            "{}{england}",
            "x".repeat(MAX_LABEL_CHARS - 3)
        )));
        assert_eq!(
            cut,
            Some(format!("{}\u{1F3F4}", "x".repeat(MAX_LABEL_CHARS - 3)))
        );
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        let cut = clean_text(Some(format!("{}{family}", "x".repeat(MAX_LABEL_CHARS - 2))));
        assert_eq!(
            cut,
            Some(format!("{}\u{1F468}", "x".repeat(MAX_LABEL_CHARS - 2)))
        );
        // Hidden characters do not use up the length limit.
        let padded = format!("{}{}", "\u{200B}".repeat(300), "x".repeat(MAX_LABEL_CHARS));
        assert_eq!(
            clean_text(Some(padded)).map(|t| t.chars().count()),
            Some(MAX_LABEL_CHARS)
        );
        // Through the command: label, artist, and the engine's own title as the fallback.
        let mut ctl = Ctl::default();
        ctl.set_labels(vec![LabelReq {
            deck: "a".into(),
            track_id: Some("t1".into()),
            title: Some("\u{202E}ebortS".into()),
            artist: Some("\u{200B}\u{FEFF}".into()),
            cue_sec: None,
        }])
        .unwrap();
        assert_eq!(ctl.labels[0].title.as_deref(), Some("ebortS"));
        assert_eq!(ctl.labels[0].artist, None);
        let mut v = view();
        {
            let d = &mut v.mixer.decks[1];
            d.loaded = true;
            d.track_id = Some("t9".into());
            d.title = Some("\u{202E}3pm.kcart".into());
            d.artist = Some("\u{2067}".into());
        }
        let s = remote_state(&v, &labels());
        assert_eq!(s.decks[1].title.as_deref(), Some("3pm.kcart"));
        assert_eq!(s.decks[1].artist, None);
    }

    #[test]
    fn track_ids_are_kept_byte_for_byte_so_a_label_finds_its_track() {
        // A file path as an id, with characters display text would lose.
        let id = "C:\\Music\\  Dj\u{200B}Set\t01.flac ";
        let mut ctl = Ctl::default();
        ctl.set_labels(vec![label("a", id, "Set 01", Some(4.0))])
            .unwrap();
        assert_eq!(ctl.labels[0].track_id.as_deref(), Some(id));
        assert_eq!(ctl.cue[0].track_id.as_deref(), Some(id));
        let mut v = view();
        {
            let d = &mut v.mixer.decks[0];
            d.loaded = true;
            d.track_id = Some(id.into());
            d.title = Some("01.flac".into());
        }
        assert_eq!(
            remote_state(&v, &ctl.labels).decks[0].title.as_deref(),
            Some("Set 01"),
            "the label is used for its own track"
        );
        // Empty and absurdly long ids are no id.
        assert_eq!(clean_id(Some(String::new())), None);
        assert_eq!(clean_id(Some("x".repeat(MAX_ID_BYTES + 1))), None);
        assert_eq!(clean_id(None), None);
    }

    #[test]
    fn bad_labels_are_refused_and_nothing_of_the_batch_is_stored() {
        let mut ctl = Ctl::default();
        for bad in [
            vec![label("a", "t1", "ok", None), label("e", "t1", "x", None)],
            vec![
                label("a", "t1", "ok", None),
                label("b", "t1", "x", Some(f64::NAN)),
            ],
            vec![
                label("a", "t1", "ok", None),
                label("b", "t1", "x", Some(-1.0)),
            ],
            vec![
                label("a", "t1", "ok", None),
                label("b", "t1", "x", Some(f64::INFINITY)),
            ],
            (0..5).map(|_| label("a", "t1", "ok", None)).collect(),
        ] {
            assert!(ctl.set_labels(bad).is_err());
            assert_eq!(ctl.labels, labels(), "a refused batch stores nothing");
            assert_eq!(ctl.cue, cues());
        }
    }

    #[test]
    fn the_ui_event_goes_out_only_when_it_changed_and_not_too_often() {
        let t0 = Instant::now();
        let mut e = Emitted::new();
        assert!(e.due(t0), "nothing was offered yet");
        let off = serde_json::to_string(&RemoteEvent::default()).unwrap();
        assert!(
            !e.changed(off.clone(), t0),
            "off is what the UI assumes at start"
        );
        assert!(!e.due(t0 + Duration::from_millis(100)));
        assert!(e.due(t0 + EVENT_INTERVAL));
        let on = serde_json::to_string(&RemoteEvent {
            running: true,
            ..Default::default()
        })
        .unwrap();
        assert!(e.changed(on.clone(), t0 + EVENT_INTERVAL));
        assert!(!e.changed(on, t0 + EVENT_INTERVAL * 2), "same again");
        assert!(e.changed(off, t0 + EVENT_INTERVAL * 3));
    }
}
