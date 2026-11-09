//! [`DecksRemote`]: phone remote / second screen / Party DJ LAN server (`decks-remote`, WP19-21).
//!
//! The app starts it on demand, shows the three pairing QR codes, and calls [`DecksRemote::pump`]
//! from its UI tick (10–20 Hz): validated phone commands are applied to the engine and the engine
//! snapshot is published to every connected browser.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex};

use decks_remote::{
    EqBand as REq, RemoteCommand, RemoteConfig, RemoteDeck, RemoteServer, RemoteState,
    RequestStatus, Role,
};

use crate::{DecksEngine, DecksError, EqBand, lock};

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
#[derive(uniffi::Object)]
pub struct DecksRemote {
    server: Mutex<Option<RemoteServer>>,
    host: IpAddr,
    titles: Mutex<Vec<(Option<String>, Option<String>)>>,
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
}

pub(crate) fn apply(engine: &DecksEngine, cmd: &RemoteCommand) -> Result<(), DecksError> {
    match *cmd {
        RemoteCommand::Play { deck } => engine.play(deck),
        RemoteCommand::Pause { deck } => engine.pause(deck),
        RemoteCommand::Cue { deck, pressed } => engine.cue(deck, pressed),
        RemoteCommand::HotCue { deck, slot } => engine.hot_cue_jump(deck, slot),
        RemoteCommand::LoopAuto { deck, beats } => engine.loop_auto(deck, beats),
        RemoteCommand::LoopExit { deck } => engine.loop_exit(deck),
        RemoteCommand::BeatJump { deck, beats } => engine.beat_jump(deck, beats),
        RemoteCommand::Sync { deck, lock } => engine.phase_sync(deck, lock),
        RemoteCommand::Volume { deck, value } => engine.set_volume(deck, value),
        RemoteCommand::Eq { deck, band, db } => engine.set_eq(deck, eq_band(band), db),
        RemoteCommand::Filter { deck, value } => engine.set_filter(deck, value),
        RemoteCommand::Crossfader { value } => engine.set_crossfader(value),
        RemoteCommand::MasterVolume { value } => engine.set_master_volume(value),
    }
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
    pub fn pump(&self, engine: &DecksEngine) -> Result<RemotePumpReport, DecksError> {
        let cmds = self.with(|s| s.drain_commands())?;
        let mut applied = 0u32;
        let mut errors = Vec::new();
        let mut mixer_changes = Vec::new();
        for (client, c) in &cmds {
            match apply(engine, c) {
                Ok(()) => {
                    applied += 1;
                    mixer_changes.extend(mixer_change(c));
                }
                Err(e) => errors.push(format!("{client}: {e}")),
            }
        }
        let titles = lock(&self.titles).clone();
        let state = remote_state(engine, &titles);
        self.with(|s| s.publish(state))?;
        Ok(RemotePumpReport {
            applied,
            errors,
            mixer_changes,
        })
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

    /// Stop the server and disconnect everyone. Idempotent.
    pub fn stop(&self) {
        lock(&self.server).take();
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
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DecksEngineConfig;

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
        // A command against a stopped engine is refused, not panicking.
        assert!(apply(&engine, &RemoteCommand::Play { deck: 0 }).is_err());
        // Stored-while-stopped controls are accepted.
        assert!(
            apply(
                &engine,
                &RemoteCommand::Volume {
                    deck: 1,
                    value: 0.5
                }
            )
            .is_ok()
        );
        assert_eq!(engine.snapshot().decks[1].volume, 0.5);
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
}
