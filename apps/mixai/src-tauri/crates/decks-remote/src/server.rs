//! The LAN server: one accept thread, one thread per connection (a handful of phones), shared
//! state behind one mutex. The app side is polling only: `publish` state, `drain_commands`.
//!
//! Threads are bounded: at most [`MAX_HANDSHAKES`] connections may be between `accept` and the
//! end of their HTTP request at once (the rest get 503 from the accept thread), and at most
//! [`MAX_CLIENTS`] WebSocket sessions run. Every session is pinged; one that stays silent is
//! dropped, so a phone that lost the network does not stay "connected".
//!
//! Besides the three roles there is the stream overlay (`/now`, an OBS Browser source): a
//! socket that authenticates with the overlay code ([`RemoteServer::overlay_token`]) is told
//! which track is on air ([`RemoteServer::publish_on_air`]) and nothing else, and everything it
//! sends except `ping` is refused ([`OVERLAY_READ_ONLY`]). It is not a [`Role`]: the native
//! bindings export that enum.
//!
//! A session keeps the code it was opened with and the revision of the codes at that moment,
//! both read under the state lock in one go ([`Paired`]). "New code" changes a code and the
//! revision under that same lock, so a session that was accepted just before a rotation
//! always notices it: it either holds the new code already, or an older revision.
//!
//! Requests are served only when their `Host` header names the server by an address or as
//! `localhost` ([`http::host_is_address`]): a DNS name that resolves to this computer is how a
//! web page elsewhere reaches a listener on the local network.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

use crate::PROTOCOL_VERSION;
use crate::http::{self, OVERLAY_PATH, Replay};
use crate::on_air::OnAirTrack;
use crate::party::{RequestQueue, RequestStatus, SongRequestView};
use crate::protocol::{ClientMsg, ModerateAction, RemoteCommand, RemoteState, Role, ServerMsg};
use crate::token::{ct_eq, is_token, new_token};

/// Connected devices at most (beyond this new sockets get 503).
pub const MAX_CLIENTS: usize = 48;
/// Connections that may be in their HTTP request at once (accepted, head not answered yet).
/// Beyond this the accept thread answers 503 itself and closes: no thread is spawned.
pub const MAX_HANDSHAKES: usize = 64;
/// The whole request head must arrive within this, however slowly it trickles.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Every session is pinged this often (browsers answer by themselves) ...
pub const PING_INTERVAL: Duration = Duration::from_secs(1);
/// ... and one that sent nothing for this long (no pong, no message) is dropped.
pub const DEAD_AFTER: Duration = Duration::from_secs(5);
/// Commands queued for the app at most (oldest dropped).
pub const MAX_PENDING_COMMANDS: usize = 512;
/// Messages per client per second before the excess is dropped.
pub const MAX_MSGS_PER_SEC: u32 = 120;
/// Largest WebSocket message accepted.
pub const MAX_MESSAGE: usize = 16 * 1024;
/// What a stream overlay socket is told when it sends anything but `ping`.
pub const OVERLAY_READ_ONLY: &str = "the stream overlay is read-only";
const POLL: Duration = Duration::from_millis(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteConfig {
    /// Address to bind (`0.0.0.0` = every LAN interface; tests use loopback).
    pub bind: IpAddr,
    /// TCP port (`0` = any free port; read it back with [`RemoteServer::port`]).
    pub port: u16,
    /// Party requests accepted at start.
    pub party_open: bool,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self {
            bind: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            port: 0,
            party_open: true,
        }
    }
}

/// A connected device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClientInfo {
    pub id: String,
    /// What the device may do. A stream overlay ([`ClientInfo::overlay`]) is listed as a
    /// viewer here (read-only is the nearest role); it gets less than a viewer.
    pub role: Role,
    pub addr: String,
    pub connected_ms: u64,
    /// Connection id: unique per socket for the life of this server (the client `id` is chosen
    /// by the device and two devices may share one).
    #[serde(default)]
    pub conn: u64,
    /// A stream overlay (`/now`), paired with the overlay code: it only hears the on-air track.
    #[serde(default)]
    pub overlay: bool,
}

/// A validated controller command with the connection it came from
/// ([`RemoteServer::drain_commands_from`]).
#[derive(Debug, Clone, PartialEq)]
pub struct CommandFrom {
    /// Connection id ([`ClientInfo::conn`]); ask [`RemoteServer::is_connected`] whether the
    /// device is still there.
    pub conn: u64,
    /// Client id the device announced.
    pub client: String,
    pub command: RemoteCommand,
}

/// What a socket may do: one of the three roles, or the stream overlay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Access {
    Role(Role),
    /// `/now`: the on-air track, nothing else, and nothing accepted but `ping`.
    Overlay,
}

struct State {
    tokens: [String; 3],
    /// Code of the stream overlay.
    overlay: String,
    /// The track on air, as the app last published it.
    on_air: Option<OnAirTrack>,
    remote: RemoteState,
    queue: RequestQueue,
    commands: VecDeque<CommandFrom>,
    clients: HashMap<u64, ClientInfo>,
    /// The DJ locked the phone controls: commands are refused (except releasing CUE).
    controls_locked: bool,
}

struct Inner {
    state: Mutex<State>,
    state_rev: AtomicU64,
    queue_rev: AtomicU64,
    /// Revision of the codes. Changed only while the state lock is held (with the code).
    token_rev: AtomicU64,
    controls_rev: AtomicU64,
    on_air_rev: AtomicU64,
    stop: AtomicBool,
    next_conn: AtomicU64,
    /// Connections between `accept` and the end of their HTTP request.
    handshakes: AtomicUsize,
    started: Instant,
    /// Tests only: while set, a session waits right before its loop ([`Inner::wait_at_gate`]).
    #[cfg(test)]
    hold_sessions: AtomicBool,
    /// Tests only: sessions waiting at that gate right now.
    #[cfg(test)]
    held_sessions: AtomicUsize,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Tests only: hold the calling session between its handshake and its loop while
    /// `hold_sessions` is set, so a test can do something in exactly that gap.
    #[cfg(test)]
    fn wait_at_gate(&self) {
        if !self.hold_sessions.load(Ordering::SeqCst) {
            return;
        }
        self.held_sessions.fetch_add(1, Ordering::SeqCst);
        while self.hold_sessions.load(Ordering::SeqCst) && !self.stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(2));
        }
        self.held_sessions.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The running server. Dropping it stops the accept loop and disconnects every client.
pub struct RemoteServer {
    inner: Arc<Inner>,
    addr: SocketAddr,
    accept: Option<JoinHandle<()>>,
}

/// Best guess at this machine's LAN address (the interface the default route uses). Sends no
/// packets: a connected UDP socket only selects a source address.
pub fn lan_ip() -> IpAddr {
    UdpSocket::bind(("0.0.0.0", 0))
        .and_then(|s| {
            s.connect(("192.0.2.1", 9))?;
            s.local_addr()
        })
        .map(|a| a.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
}

impl RemoteServer {
    /// Start with a fresh code for every role and for the stream overlay.
    pub fn start(config: RemoteConfig) -> io::Result<Self> {
        Self::start_with_overlay(config, None)
    }

    /// Like [`Self::start`], with the stream overlay code of an earlier run (so the address a
    /// streamer pasted into OBS keeps working). It is taken only in the exact form
    /// [`new_token`] produces ([`is_token`]); anything else is replaced by a fresh code, read
    /// it back with [`Self::overlay_token`]. The code is valid from the first connection on.
    pub fn start_with_overlay(config: RemoteConfig, overlay: Option<String>) -> io::Result<Self> {
        let listener = TcpListener::bind((config.bind, config.port))?;
        listener.set_nonblocking(true)?;
        let addr = listener.local_addr()?;
        let mut queue = RequestQueue::default();
        queue.set_open(config.party_open);
        let overlay = overlay.filter(|t| is_token(t)).unwrap_or_else(new_token);
        let inner = Arc::new(Inner {
            state: Mutex::new(State {
                tokens: [new_token(), new_token(), new_token()],
                overlay,
                on_air: None,
                remote: RemoteState::default(),
                queue,
                commands: VecDeque::new(),
                clients: HashMap::new(),
                controls_locked: false,
            }),
            state_rev: AtomicU64::new(1),
            queue_rev: AtomicU64::new(1),
            token_rev: AtomicU64::new(1),
            controls_rev: AtomicU64::new(1),
            on_air_rev: AtomicU64::new(1),
            stop: AtomicBool::new(false),
            next_conn: AtomicU64::new(1),
            handshakes: AtomicUsize::new(0),
            started: Instant::now(),
            #[cfg(test)]
            hold_sessions: AtomicBool::new(false),
            #[cfg(test)]
            held_sessions: AtomicUsize::new(0),
        });
        let i2 = inner.clone();
        let accept = std::thread::Builder::new()
            .name("decks-remote-accept".into())
            .spawn(move || accept_loop(listener, i2))?;
        Ok(Self {
            inner,
            addr,
            accept: Some(accept),
        })
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// Current token of a role.
    pub fn token(&self, role: Role) -> String {
        self.inner.lock().tokens[role.index()].clone()
    }

    /// Pairing URL for `role` on `host` (normally [`lan_ip`]); put it in a QR code.
    pub fn pairing_url(&self, role: Role, host: IpAddr) -> String {
        let h = match host {
            IpAddr::V6(v6) => format!("[{v6}]"),
            IpAddr::V4(v4) => v4.to_string(),
        };
        format!(
            "http://{h}:{}{}?t={}",
            self.port(),
            role.path(),
            self.token(role)
        )
    }

    /// New token for `role`; every device paired with the old one is disconnected.
    pub fn rotate_token(&self, role: Role) -> String {
        let t = new_token();
        let mut s = self.inner.lock();
        s.tokens[role.index()] = t.clone();
        // Under the lock, with the code: a connection being accepted reads both or neither.
        self.inner.token_rev.fetch_add(1, Ordering::SeqCst);
        t
    }

    /// Current code of the stream overlay.
    pub fn overlay_token(&self) -> String {
        self.inner.lock().overlay.clone()
    }

    /// Address of the stream overlay page on `host`, with its code: what goes into the OBS
    /// Browser source.
    pub fn overlay_url(&self, host: IpAddr) -> String {
        let h = match host {
            IpAddr::V6(v6) => format!("[{v6}]"),
            IpAddr::V4(v4) => v4.to_string(),
        };
        format!(
            "http://{h}:{}{OVERLAY_PATH}?t={}",
            self.port(),
            self.overlay_token()
        )
    }

    /// New code for the stream overlay; overlays paired with the old one are disconnected
    /// (the phones, second screens and guests are not).
    pub fn rotate_overlay_token(&self) -> String {
        let t = new_token();
        let mut s = self.inner.lock();
        s.overlay = t.clone();
        // Under the lock, with the code (see `rotate_token`).
        self.inner.token_rev.fetch_add(1, Ordering::SeqCst);
        t
    }

    /// Publish the track that is on air (`None` = nothing). Overlays are told when the title
    /// or the artist changes.
    pub fn publish_on_air(&self, track: Option<OnAirTrack>) {
        let mut s = self.inner.lock();
        if s.on_air != track {
            s.on_air = track;
            self.inner.on_air_rev.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// The track on air as last published.
    pub fn on_air(&self) -> Option<OnAirTrack> {
        self.inner.lock().on_air.clone()
    }

    /// Publish the deck state (only changes are pushed to clients).
    pub fn publish(&self, state: RemoteState) {
        let mut s = self.inner.lock();
        if s.remote != state {
            s.remote = state;
            self.inner.state_rev.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Validated controller commands since the last call, oldest first, with the client id.
    pub fn drain_commands(&self) -> Vec<(String, RemoteCommand)> {
        self.drain_commands_from()
            .into_iter()
            .map(|c| (c.client, c.command))
            .collect()
    }

    /// Like [`Self::drain_commands`], with the connection each command came from (so the app
    /// can undo a held button when that device disappears).
    pub fn drain_commands_from(&self) -> Vec<CommandFrom> {
        self.inner.lock().commands.drain(..).collect()
    }

    /// Whether the connection `conn` ([`ClientInfo::conn`]) is still open. A device that lost
    /// the network stops counting within [`DEAD_AFTER`].
    pub fn is_connected(&self, conn: u64) -> bool {
        self.inner.lock().clients.contains_key(&conn)
    }

    /// Lock or unlock the phone controls. While locked, controller commands are refused
    /// (except releasing CUE) and commands not drained yet are dropped; requests, votes and
    /// moderation keep working. Controllers are told at once ([`ServerMsg::Controls`]).
    pub fn set_controls_locked(&self, locked: bool) {
        {
            let mut s = self.inner.lock();
            if s.controls_locked == locked {
                return;
            }
            s.controls_locked = locked;
            if locked {
                s.commands.retain(|c| c.command.allowed_when_locked());
            }
        }
        self.inner.controls_rev.fetch_add(1, Ordering::SeqCst);
    }

    pub fn controls_locked(&self) -> bool {
        self.inner.lock().controls_locked
    }

    /// Connections in their HTTP request right now (never more than [`MAX_HANDSHAKES`]).
    pub fn handshakes(&self) -> usize {
        self.inner.handshakes.load(Ordering::SeqCst)
    }

    pub fn requests(&self) -> Vec<SongRequestView> {
        self.inner.lock().queue.list()
    }

    pub fn set_request_status(&self, id: u64, status: RequestStatus) -> bool {
        let ok = self.inner.lock().queue.set_status(id, status).is_ok();
        if ok {
            self.inner.queue_rev.fetch_add(1, Ordering::SeqCst);
        }
        ok
    }

    pub fn set_party_open(&self, open: bool) {
        self.inner.lock().queue.set_open(open);
        self.inner.queue_rev.fetch_add(1, Ordering::SeqCst);
    }

    pub fn party_open(&self) -> bool {
        self.inner.lock().queue.is_open()
    }

    pub fn clear_done_requests(&self) {
        self.inner.lock().queue.clear_done();
        self.inner.queue_rev.fetch_add(1, Ordering::SeqCst);
    }

    pub fn clients(&self) -> Vec<ClientInfo> {
        let mut v: Vec<_> = self.inner.lock().clients.values().cloned().collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    pub fn stop(&mut self) {
        self.inner.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.accept.take() {
            let _ = h.join();
        }
    }
}

impl Drop for RemoteServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// One slot of [`MAX_HANDSHAKES`], given back when dropped.
struct HandshakeSlot(Arc<Inner>);

impl HandshakeSlot {
    /// Take a slot; `None` when [`MAX_HANDSHAKES`] connections are in their request already.
    fn take(inner: &Arc<Inner>) -> Option<Self> {
        // A plain compare-exchange loop: `fetch_update` is deprecated on new toolchains and
        // its replacement does not exist at this crate's MSRV.
        let slots = &inner.handshakes;
        let mut n = slots.load(Ordering::SeqCst);
        loop {
            if n >= MAX_HANDSHAKES {
                return None;
            }
            match slots.compare_exchange_weak(n, n + 1, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => return Some(Self(inner.clone())),
                Err(now) => n = now,
            }
        }
    }
}

impl Drop for HandshakeSlot {
    fn drop(&mut self) {
        self.0.handshakes.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A connection that was answered 503 and is kept a moment so the answer arrives: closing a
/// socket whose request was not read yet resets it, and the peer may never see the reply.
struct Refused {
    stream: TcpStream,
    until: Instant,
}

/// Refused connections kept at once (beyond this they are closed at once) and for how long.
const MAX_REFUSED: usize = 64;
const REFUSED_LINGER: Duration = Duration::from_millis(300);

/// Answer 503 from the accept thread without ever blocking it: the socket is non-blocking and
/// the reply fits the send buffer of a fresh connection.
fn refuse_busy(mut stream: TcpStream) -> Option<Refused> {
    stream.set_nonblocking(true).ok()?;
    http::respond(
        &mut stream,
        "503 Service Unavailable",
        "text/plain",
        "busy, try again",
    )
    .ok()?;
    stream.shutdown(Shutdown::Write).ok()?;
    Some(Refused {
        stream,
        until: Instant::now() + REFUSED_LINGER,
    })
}

/// Read off what a refused peer sent; false = close it now (it closed, failed, or time is up).
fn keep_refused(r: &mut Refused, now: Instant) -> bool {
    let mut sink = [0u8; 1024];
    match r.stream.read(&mut sink) {
        Ok(0) => false,
        Ok(_) => now < r.until,
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => now < r.until,
        Err(_) => false,
    }
}

fn accept_loop(listener: TcpListener, inner: Arc<Inner>) {
    let mut refused: Vec<Refused> = Vec::new();
    while !inner.stop.load(Ordering::SeqCst) {
        if !refused.is_empty() {
            let now = Instant::now();
            refused.retain_mut(|r| keep_refused(r, now));
        }
        match listener.accept() {
            Ok((stream, peer)) => {
                // A connection costs a thread only while a slot is free: sockets that are opened
                // and never send a request cannot pile threads up.
                let Some(slot) = HandshakeSlot::take(&inner) else {
                    let room = refused.len() < MAX_REFUSED;
                    refused.extend(refuse_busy(stream).filter(|_| room));
                    continue;
                };
                let i2 = inner.clone();
                // A failed spawn drops the closure: the slot is given back, the socket closed.
                let _ = std::thread::Builder::new()
                    .name("decks-remote-conn".into())
                    .spawn(move || {
                        let _ = handle(stream, peer, i2, slot);
                    });
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(POLL),
            Err(_) => std::thread::sleep(POLL),
        }
    }
}

fn valid_client_id(c: &str) -> bool {
    (1..=40).contains(&c.len())
        && c.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn role_for(state: &State, token: &str) -> Option<Role> {
    Role::ALL
        .into_iter()
        .find(|r| ct_eq(&state.tokens[r.index()], token))
}

/// What `token` unlocks. The overlay code is looked at first: should it ever equal a role's
/// code, the socket gets the lesser access.
fn access_for(state: &State, token: &str) -> Option<Access> {
    if ct_eq(&state.overlay, token) {
        return Some(Access::Overlay);
    }
    role_for(state, token).map(Access::Role)
}

/// The code `access` is paired with right now.
fn token_of(state: &State, access: Access) -> &str {
    match access {
        Access::Role(role) => &state.tokens[role.index()],
        Access::Overlay => &state.overlay,
    }
}

/// The code a session was opened with and the revision of the codes at that moment. Both are
/// read under the state lock in one go ([`Paired::read`]); the session compares its code
/// again whenever the revision is no longer this one.
struct Paired {
    token: String,
    rev: u64,
}

impl Paired {
    /// Call with the state lock held (`state` is the locked state).
    fn read(state: &State, inner: &Inner, access: Access) -> Self {
        Self {
            token: token_of(state, access).to_string(),
            rev: inner.token_rev.load(Ordering::SeqCst),
        }
    }
}

fn handle(
    mut stream: TcpStream,
    peer: SocketAddr,
    inner: Arc<Inner>,
    slot: HandshakeSlot,
) -> io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let raw = http::read_head(&mut stream, HANDSHAKE_TIMEOUT)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let head = match http::parse_head(&raw) {
        Ok(h) => h,
        Err(_) => {
            return http::respond(&mut stream, "400 Bad Request", "text/plain", "bad request");
        }
    };
    // Before anything else is answered: only a request that names this server by an address
    // (or as `localhost`) is served. A page on another site that points its own DNS name at
    // this computer sends that name here, and gets nothing: no page, no health answer, no
    // socket.
    if !http::host_is_address(head.host.as_deref()) {
        return http::respond(&mut stream, "403 Forbidden", "text/plain", "host");
    }
    if head.method != "GET" {
        return http::respond(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain",
            "GET only",
        );
    }
    if head.path == "/health" {
        return http::respond(&mut stream, "200 OK", "text/plain", "ok");
    }
    if let Some((ctype, body)) = http::static_route(&head.path) {
        return http::respond(&mut stream, "200 OK", ctype, body);
    }
    if head.path != "/ws" || !head.upgrade_ws {
        return http::respond(&mut stream, "404 Not Found", "text/plain", "not found");
    }
    if !http::same_origin(&head) {
        return http::respond(&mut stream, "403 Forbidden", "text/plain", "origin");
    }
    let (access, paired, conn, client) = {
        let mut s = inner.lock();
        let Some(access) = head.param("t").and_then(|t| access_for(&s, t)) else {
            drop(s);
            return http::respond(&mut stream, "401 Unauthorized", "text/plain", "token");
        };
        if s.clients.len() >= MAX_CLIENTS {
            drop(s);
            return http::respond(&mut stream, "503 Service Unavailable", "text/plain", "full");
        }
        let conn = inner.next_conn.fetch_add(1, Ordering::SeqCst);
        let overlay = access == Access::Overlay;
        let client = head
            .param("c")
            .filter(|c| valid_client_id(c))
            .map(str::to_string)
            .unwrap_or_else(|| {
                let kind = if overlay { "overlay" } else { "anon" };
                format!("{kind}-{}", &new_token()[..12])
            });
        s.clients.insert(
            conn,
            ClientInfo {
                id: client.clone(),
                role: match access {
                    Access::Role(role) => role,
                    Access::Overlay => Role::Viewer,
                },
                addr: peer.to_string(),
                connected_ms: inner.started.elapsed().as_millis() as u64,
                conn,
                overlay,
            },
        );
        // The code and its revision, under the same lock as the lookup above: a rotation
        // runs wholly before this (the session holds the new code) or wholly after (the
        // session sees a newer revision and compares).
        (access, Paired::read(&s, &inner, access), conn, client)
    };
    // The request is answered from here on: the session is bounded by `MAX_CLIENTS`, not by
    // the handshake slots.
    drop(slot);
    let who = Peer {
        conn,
        access,
        client: &client,
    };
    let result = session(stream, raw, &inner, who, paired);
    inner.lock().clients.remove(&conn);
    result
}

/// Who a session talks to.
#[derive(Clone, Copy)]
struct Peer<'a> {
    conn: u64,
    access: Access,
    client: &'a str,
}

fn ws_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE))
}

fn send(ws: &mut WebSocket<Replay>, msg: &ServerMsg) -> Result<(), tungstenite::Error> {
    let j = serde_json::to_string(msg).unwrap_or_default();
    ws.send(Message::text(j))
}

struct Seen {
    state: u64,
    queue: u64,
    controls: u64,
    now_playing: Vec<String>,
    on_air_rev: u64,
    /// Title and artist last sent to an overlay (`None` = nothing sent yet).
    on_air: Option<(Option<String>, Option<String>)>,
}

/// The only push an overlay gets: the on-air track, once at the start and when its texts change.
fn push_on_air(
    ws: &mut WebSocket<Replay>,
    inner: &Inner,
    seen: &mut Seen,
) -> Result<(), tungstenite::Error> {
    let rev = inner.on_air_rev.load(Ordering::SeqCst);
    if seen.on_air.is_some() && rev == seen.on_air_rev {
        return Ok(());
    }
    seen.on_air_rev = rev;
    let (title, artist) = match &inner.lock().on_air {
        Some(t) => (t.title.clone(), t.artist.clone()),
        None => (None, None),
    };
    let texts = (title, artist);
    if seen.on_air.as_ref() != Some(&texts) {
        send(
            ws,
            &ServerMsg::OnAir {
                title: texts.0.clone(),
                artist: texts.1.clone(),
            },
        )?;
        seen.on_air = Some(texts);
    }
    Ok(())
}

fn push_updates(
    ws: &mut WebSocket<Replay>,
    inner: &Inner,
    who: Peer<'_>,
    seen: &mut Seen,
) -> Result<(), tungstenite::Error> {
    let Peer { access, client, .. } = who;
    let role = match access {
        // No deck state, no request queue, no controls lock: the on-air track only.
        Access::Overlay => return push_on_air(ws, inner, seen),
        Access::Role(role) => role,
    };
    let crev = inner.controls_rev.load(Ordering::SeqCst);
    if crev != seen.controls {
        seen.controls = crev;
        if role == Role::Controller {
            let locked = inner.lock().controls_locked;
            send(ws, &ServerMsg::Controls { locked })?;
        }
    }
    let srev = inner.state_rev.load(Ordering::SeqCst);
    if srev != seen.state {
        seen.state = srev;
        let state = inner.lock().remote.clone();
        match role {
            Role::Controller | Role::Viewer => send(ws, &ServerMsg::State { state })?,
            Role::Guest => {
                let titles = state.now_playing();
                if titles != seen.now_playing {
                    seen.now_playing = titles.clone();
                    send(ws, &ServerMsg::NowPlaying { titles })?;
                }
            }
        }
    }
    let qrev = inner.queue_rev.load(Ordering::SeqCst);
    if qrev != seen.queue {
        seen.queue = qrev;
        let (items, party_open) = {
            let s = inner.lock();
            (
                s.queue.public_list(client, role == Role::Controller),
                s.queue.is_open(),
            )
        };
        send(ws, &ServerMsg::Requests { party_open, items })?;
    }
    Ok(())
}

fn on_message(inner: &Inner, who: Peer<'_>, msg: ClientMsg) -> Option<ServerMsg> {
    let Peer {
        conn,
        access,
        client,
    } = who;
    let err = |r: &str| Some(ServerMsg::Error { reason: r.into() });
    let role = match access {
        Access::Role(role) => role,
        // The overlay code only reads: no command, request, vote or moderation is taken.
        Access::Overlay => {
            return match msg {
                ClientMsg::Ping => Some(ServerMsg::Pong),
                _ => err(OVERLAY_READ_ONLY),
            };
        }
    };
    match msg {
        ClientMsg::Ping => Some(ServerMsg::Pong),
        ClientMsg::Command { command } => {
            if role != Role::Controller {
                return err("this device cannot control the decks");
            }
            match command.validated() {
                Ok(c) => {
                    let mut s = inner.lock();
                    if s.controls_locked && !c.allowed_when_locked() {
                        drop(s);
                        return err("the DJ locked the phone controls");
                    }
                    if s.commands.len() >= MAX_PENDING_COMMANDS {
                        s.commands.pop_front();
                    }
                    s.commands.push_back(CommandFrom {
                        conn,
                        client: client.to_string(),
                        command: c,
                    });
                    None
                }
                Err(e) => Some(ServerMsg::Error { reason: e }),
            }
        }
        ClientMsg::Request {
            title,
            artist,
            note,
        } => {
            if role == Role::Viewer {
                return err("this device cannot request songs");
            }
            let r = inner.lock().queue.submit(client, &title, &artist, &note);
            match r {
                Ok((id, merged)) => {
                    inner.queue_rev.fetch_add(1, Ordering::SeqCst);
                    Some(ServerMsg::Requested { id, merged })
                }
                Err(e) => Some(ServerMsg::Error {
                    reason: e.to_string(),
                }),
            }
        }
        ClientMsg::Vote { id } => {
            if role == Role::Viewer {
                return err("this device cannot vote");
            }
            let r = inner.lock().queue.vote(client, id);
            match r {
                Ok(_) => {
                    inner.queue_rev.fetch_add(1, Ordering::SeqCst);
                    None
                }
                Err(e) => Some(ServerMsg::Error {
                    reason: e.to_string(),
                }),
            }
        }
        ClientMsg::Moderate { id, action } => {
            if role != Role::Controller {
                return err("only the DJ can moderate requests");
            }
            let status = match action {
                ModerateAction::Accept => RequestStatus::Accepted,
                ModerateAction::Reject => RequestStatus::Rejected,
                ModerateAction::Played => RequestStatus::Played,
            };
            let r = inner.lock().queue.set_status(id, status);
            match r {
                Ok(()) => {
                    inner.queue_rev.fetch_add(1, Ordering::SeqCst);
                    None
                }
                Err(e) => Some(ServerMsg::Error {
                    reason: e.to_string(),
                }),
            }
        }
    }
}

fn is_timeout(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(io) if matches!(io.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut))
}

fn session(
    stream: TcpStream,
    raw: Vec<u8>,
    inner: &Inner,
    who: Peer<'_>,
    paired: Paired,
) -> io::Result<()> {
    let Peer { access, client, .. } = who;
    let replay = Replay::new(raw, stream);
    let mut ws = tungstenite::accept_with_config(replay, Some(ws_config()))
        .map_err(|e| io::Error::other(e.to_string()))?;
    ws.get_ref().inner.set_read_timeout(Some(POLL))?;
    let io_err = |e: tungstenite::Error| io::Error::other(e.to_string());
    let (party_open, locked) = {
        let s = inner.lock();
        (s.queue.is_open(), s.controls_locked)
    };
    // An overlay gets no hello (it has no role to be told): its first message is the on-air
    // track, pushed by the first pass of the loop.
    if let Access::Role(role) = access {
        send(
            &mut ws,
            &ServerMsg::Hello {
                protocol: PROTOCOL_VERSION,
                role,
                client: client.to_string(),
                party_open,
            },
        )
        .map_err(io_err)?;
    }
    let mut seen = Seen {
        state: 0,
        queue: 0,
        // Unlocked is what a page assumes: only a lock in force is announced at once.
        controls: if locked {
            0
        } else {
            inner.controls_rev.load(Ordering::SeqCst)
        },
        now_playing: vec![String::new()],
        on_air_rev: 0,
        on_air: None,
    };
    #[cfg(test)]
    inner.wait_at_gate();
    // The revision the code was read at, NOT the revision of this moment: a code rotated
    // since `handle` accepted this connection must be noticed by the first pass of the loop.
    let mut token_rev = paired.rev;
    let mut window = Instant::now();
    let mut in_window = 0u32;
    // Heartbeat: a phone that left the Wi-Fi sends no FIN; without this it would stay in the
    // client list (and keep a held CUE down) until the OS gave up on the socket.
    let mut heard = Instant::now();
    let mut pinged = Instant::now();
    loop {
        if inner.stop.load(Ordering::SeqCst) {
            let _ = ws.close(None);
            let _ = ws.flush();
            return Ok(());
        }
        if heard.elapsed() >= DEAD_AFTER {
            let _ = ws.close(None);
            let _ = ws.flush();
            return Ok(());
        }
        if pinged.elapsed() >= PING_INTERVAL {
            pinged = Instant::now();
            match ws.send(Message::Ping(tungstenite::Bytes::new())) {
                Err(e) if !is_timeout(&e) => return Err(io_err(e)),
                _ => {}
            }
        }
        let trev = inner.token_rev.load(Ordering::SeqCst);
        if trev != token_rev {
            token_rev = trev;
            let still = ct_eq(token_of(&inner.lock(), access), &paired.token);
            if !still {
                let _ = ws.close(None);
                let _ = ws.flush();
                return Ok(());
            }
        }
        push_updates(&mut ws, inner, who, &mut seen).map_err(io_err)?;
        let msg = ws.read();
        if msg.is_ok() {
            // Anything at all (a pong included) proves the device is there.
            heard = Instant::now();
        }
        match msg {
            Ok(Message::Text(t)) => {
                if window.elapsed() >= Duration::from_secs(1) {
                    window = Instant::now();
                    in_window = 0;
                }
                in_window += 1;
                if in_window > MAX_MSGS_PER_SEC {
                    continue;
                }
                let reply = match serde_json::from_str::<ClientMsg>(t.as_str()) {
                    Ok(m) => on_message(inner, who, m),
                    Err(e) => Some(ServerMsg::Error {
                        reason: format!("bad message: {e}"),
                    }),
                };
                if let Some(r) = reply {
                    send(&mut ws, &r).map_err(io_err)?;
                }
            }
            Ok(Message::Close(_)) => {
                // The reply to the close frame is queued by the read: let it leave.
                let _ = ws.flush();
                return Ok(());
            }
            Ok(_) => {}
            Err(e) if is_timeout(&e) => {
                // Keep pending pongs / close frames moving.
                match ws.flush() {
                    Err(e) if !is_timeout(&e) => return Err(io_err(e)),
                    _ => {}
                }
            }
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                return Ok(());
            }
            Err(e) => return Err(io_err(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use tungstenite::stream::MaybeTlsStream;

    use super::*;

    type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

    /// Every test binds loopback only.
    fn server() -> RemoteServer {
        RemoteServer::start(RemoteConfig {
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            ..Default::default()
        })
        .unwrap()
    }

    fn connect(s: &RemoteServer, role: Role, client: &str) -> Ws {
        let url = format!(
            "ws://127.0.0.1:{}/ws?t={}&c={client}",
            s.port(),
            s.token(role)
        );
        let (ws, _) = tungstenite::connect(url).unwrap();
        if let MaybeTlsStream::Plain(t) = ws.get_ref() {
            t.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        }
        ws
    }

    /// Read until `pred` matches (other pushes are skipped), within 5 s.
    fn until(ws: &mut Ws, pred: impl Fn(&ServerMsg) -> bool) -> ServerMsg {
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            if let Message::Text(t) = ws.read().expect("message") {
                let m: ServerMsg = serde_json::from_str(t.as_str()).unwrap();
                if pred(&m) {
                    return m;
                }
            }
        }
        panic!("expected message not received");
    }

    fn say(ws: &mut Ws, json: &str) {
        ws.send(Message::text(json.to_string())).unwrap();
    }

    fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            if f() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("timed out: {what}");
    }

    fn get(port: u16, path: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    const PLAY: &str = r#"{"type":"command","command":{"cmd":"play","deck":0}}"#;
    const CUE_UP: &str = r#"{"type":"command","command":{"cmd":"cue","deck":0,"pressed":false}}"#;

    /// Generous: a busy machine can hold a thread for seconds. A wait ends at once when what
    /// it waits for happens; only a failure takes this long.
    const LONG: Duration = Duration::from_secs(10);

    fn wait_long(what: &str, mut f: impl FnMut() -> bool) {
        let end = Instant::now() + LONG;
        while Instant::now() < end {
            if f() {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("timed out: {what}");
    }

    /// Open a socket with `token` while every new session is held between its handshake and
    /// its loop ([`Inner::wait_at_gate`]); returns once that session waits there. The gate
    /// stays shut until [`open_gate`].
    fn connect_held(s: &RemoteServer, token: &str, client: &str) -> Ws {
        s.inner.hold_sessions.store(true, Ordering::SeqCst);
        let before = s.inner.held_sessions.load(Ordering::SeqCst);
        let url = format!("ws://127.0.0.1:{}/ws?t={token}&c={client}", s.port());
        let (ws, _) = tungstenite::connect(url).unwrap();
        if let MaybeTlsStream::Plain(t) = ws.get_ref() {
            t.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        }
        wait_long("the session waits before its loop", || {
            s.inner.held_sessions.load(Ordering::SeqCst) == before + 1
        });
        ws
    }

    fn open_gate(s: &RemoteServer) {
        s.inner.hold_sessions.store(false, Ordering::SeqCst);
        wait_long("every held session went on", || {
            s.inner.held_sessions.load(Ordering::SeqCst) == 0
        });
    }

    /// Whether the server closes this socket within [`LONG`]. Its pings and pushes are read
    /// past, and a read that merely timed out is not a close.
    fn closes(ws: &mut Ws) -> bool {
        if let MaybeTlsStream::Plain(t) = ws.get_ref() {
            t.set_read_timeout(Some(Duration::from_millis(100)))
                .unwrap();
        }
        let end = Instant::now() + LONG;
        while Instant::now() < end {
            match ws.read() {
                Ok(Message::Close(_)) => return true,
                Ok(_) => {}
                Err(e) if is_timeout(&e) => {
                    let _ = ws.flush();
                }
                Err(_) => return true,
            }
        }
        false
    }

    #[test]
    fn a_code_changed_right_after_a_device_was_let_in_still_disconnects_it() {
        let s = server();
        // A second screen is let in with the viewer code; its session thread has answered the
        // handshake and has not reached its loop yet. "New code" lands in exactly that gap.
        // (A session that took the revision of the codes only now would find nothing changed
        // and keep the revoked code for as long as the socket lives.)
        let old = s.token(Role::Viewer);
        let mut viewer = connect_held(&s, &old, "tv");
        assert_eq!(s.clients().len(), 1, "it is listed as connected");
        let new = s.rotate_token(Role::Viewer);
        assert_ne!(old, new);
        open_gate(&s);
        assert!(closes(&mut viewer), "the viewer with the old code is gone");
        wait_long("the viewer is no longer listed", || s.clients().is_empty());

        // The same for the stream overlay and its own code.
        let old = s.overlay_token();
        let mut obs = connect_held(&s, &old, "obs");
        assert!(s.clients()[0].overlay);
        assert_ne!(old, s.rotate_overlay_token());
        open_gate(&s);
        assert!(closes(&mut obs), "the overlay with the old code is gone");
        wait_long("the overlay is no longer listed", || s.clients().is_empty());

        // Control: the gap by itself closes nobody. A device held there while ANOTHER code
        // changes stays connected and is served, and still goes when its own code changes.
        let mut phone = connect_held(&s, &s.token(Role::Controller), "phone");
        s.rotate_token(Role::Guest);
        s.rotate_overlay_token();
        open_gate(&s);
        until(&mut phone, |m| matches!(m, ServerMsg::Hello { .. }));
        say(&mut phone, r#"{"type":"ping"}"#);
        until(&mut phone, |m| matches!(m, ServerMsg::Pong));
        assert_eq!(s.clients().len(), 1);
        s.rotate_token(Role::Controller);
        assert!(closes(&mut phone));
        wait_long("the phone is no longer listed", || s.clients().is_empty());
        let mut obs = connect_held(&s, &s.overlay_token(), "obs");
        s.rotate_token(Role::Viewer);
        s.rotate_token(Role::Controller);
        open_gate(&s);
        until(&mut obs, |m| matches!(m, ServerMsg::OnAir { .. }));
        say(&mut obs, r#"{"type":"ping"}"#);
        until(&mut obs, |m| matches!(m, ServerMsg::Pong));
        assert_eq!(s.clients().len(), 1);
        s.rotate_overlay_token();
        assert!(closes(&mut obs));
        wait_long("nobody is left", || s.clients().is_empty());
    }

    #[test]
    fn a_session_is_paired_with_the_code_and_the_revision_of_one_moment() {
        let s = server();
        let rev = || s.inner.token_rev.load(Ordering::SeqCst);
        let r0 = rev();
        let read = |access| {
            let st = s.inner.lock();
            let p = Paired::read(&st, &s.inner, access);
            (p.token, p.rev)
        };
        assert_eq!(read(Access::Role(Role::Guest)), (s.token(Role::Guest), r0));
        assert_eq!(read(Access::Overlay), (s.overlay_token(), r0));
        // Every "New code" moves the revision, whichever code it is: that is what makes each
        // session look at its own code again.
        let guest = s.rotate_token(Role::Guest);
        assert_eq!(rev(), r0 + 1);
        assert_eq!(read(Access::Role(Role::Guest)), (guest, r0 + 1));
        let overlay = s.rotate_overlay_token();
        assert_eq!(rev(), r0 + 2);
        assert_eq!(read(Access::Overlay), (overlay, r0 + 2));
        // The other codes did not change.
        assert_eq!(
            read(Access::Role(Role::Viewer)),
            (s.token(Role::Viewer), r0 + 2)
        );
    }

    /// One request with the `Host` header as given (`None` = no header at all); the status
    /// line and the body (no body is read after `101`: the socket is a WebSocket then, and
    /// dropping it here ends its session).
    fn get_as(port: u16, path: &str, host: Option<&str>, extra: &str) -> (String, String) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let host = host.map(|h| format!("Host: {h}\r\n")).unwrap_or_default();
        write!(s, "GET {path} HTTP/1.1\r\n{host}{extra}\r\n").unwrap();
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            assert_eq!(s.read(&mut byte).unwrap(), 1, "an answer to {path}");
            head.push(byte[0]);
        }
        let head = String::from_utf8_lossy(&head).into_owned();
        let status = head.lines().next().unwrap_or("").to_string();
        let mut body = String::new();
        if !status.starts_with("HTTP/1.1 101") {
            let _ = s.read_to_string(&mut body);
        }
        (status, body)
    }

    #[test]
    fn a_request_that_names_the_server_by_a_dns_name_gets_nothing() {
        let s = server();
        let port = s.port();
        let upgrade = "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
        let ws = format!("/ws?t={}&c=x", s.overlay_token());
        let phone = format!("/ws?t={}&c=y", s.token(Role::Controller));
        // A page on another site whose name was pointed at this computer: the browser sends
        // that name as the host AND as the origin, so the origin check alone lets it through.
        for name in [
            format!("evil.example:{port}"),
            "evil.example".to_string(),
            format!("localhost.evil.example:{port}"),
            format!("127.0.0.1.evil.example:{port}"),
        ] {
            let origin = format!("Origin: http://{name}\r\n");
            for (path, extra) in [
                (ws.as_str(), format!("{upgrade}{origin}")),
                (phone.as_str(), format!("{upgrade}{origin}")),
                (ws.as_str(), upgrade.to_string()),
                ("/health", String::new()),
                ("/now", String::new()),
                ("/", String::new()),
                ("/tokens.css", String::new()),
                ("/nope", String::new()),
            ] {
                assert_eq!(
                    get_as(port, path, Some(&name), &extra),
                    ("HTTP/1.1 403 Forbidden".to_string(), "host".to_string()),
                    "{name} {path}"
                );
            }
        }
        // No host at all, an empty one, a port that is not one.
        for bad in [None, Some(""), Some("127.0.0.1:99999"), Some("[::1")] {
            assert_eq!(
                get_as(port, "/health", bad, "").0,
                "HTTP/1.1 403 Forbidden",
                "{bad:?}"
            );
            assert_eq!(
                get_as(port, &ws, bad, upgrade).0,
                "HTTP/1.1 403 Forbidden",
                "{bad:?}"
            );
        }
        assert!(s.clients().is_empty(), "nobody got in");
        // By address, `localhost` or an IPv6 literal, with any port or none (the port in the
        // header is the browser's business: a forwarded port differs from the one bound).
        for ok in [
            format!("127.0.0.1:{port}"),
            "127.0.0.1".to_string(),
            "192.168.1.20:8080".to_string(),
            format!("localhost:{port}"),
            "LOCALHOST".to_string(),
            format!("[::1]:{port}"),
            "[::1]".to_string(),
        ] {
            assert_eq!(
                get_as(port, "/health", Some(&ok), ""),
                ("HTTP/1.1 200 OK".to_string(), "ok".to_string()),
                "{ok}"
            );
            let origin = format!("Origin: http://{ok}\r\n");
            assert_eq!(
                get_as(port, &ws, Some(&ok), &format!("{upgrade}{origin}")).0,
                "HTTP/1.1 101 Switching Protocols",
                "{ok}"
            );
        }
        // The other checks still stand behind this one: a wrong code, a foreign origin.
        let me = format!("127.0.0.1:{port}");
        assert_eq!(
            get_as(
                port,
                "/ws?t=00000000000000000000000000000000",
                Some(&me),
                upgrade
            )
            .0,
            "HTTP/1.1 401 Unauthorized"
        );
        assert_eq!(
            get_as(
                port,
                &ws,
                Some(&me),
                &format!("{upgrade}Origin: http://evil.example\r\n")
            )
            .0,
            "HTTP/1.1 403 Forbidden"
        );
    }

    #[test]
    fn the_overlay_code_unlocks_the_overlay_and_each_role_code_its_role() {
        let s = server();
        let st = s.inner.lock();
        assert_eq!(access_for(&st, &st.overlay), Some(Access::Overlay));
        assert_eq!(token_of(&st, Access::Overlay), st.overlay);
        for role in Role::ALL {
            let t = &st.tokens[role.index()];
            assert_ne!(t, &st.overlay, "{role:?} has its own code");
            assert_eq!(access_for(&st, t), Some(Access::Role(role)));
            assert_eq!(token_of(&st, Access::Role(role)), t);
        }
        assert_eq!(access_for(&st, ""), None);
        assert_eq!(access_for(&st, &new_token()), None);
        assert_eq!(access_for(&st, &st.overlay[..31]), None);
    }

    #[test]
    fn an_overlay_may_only_ping() {
        let s = server();
        let play = || ClientMsg::Command {
            command: RemoteCommand::Play { deck: 0 },
        };
        let request = || ClientMsg::Request {
            title: "Strobe".into(),
            artist: "deadmau5".into(),
            note: String::new(),
        };
        let overlay = Peer {
            conn: 1,
            access: Access::Overlay,
            client: "obs",
        };
        let refused = Some(ServerMsg::Error {
            reason: OVERLAY_READ_ONLY.into(),
        });
        for msg in [
            play(),
            ClientMsg::Command {
                command: RemoteCommand::Cue {
                    deck: 0,
                    pressed: false,
                },
            },
            request(),
            ClientMsg::Vote { id: 1 },
            ClientMsg::Moderate {
                id: 1,
                action: ModerateAction::Accept,
            },
        ] {
            assert_eq!(
                on_message(&s.inner, overlay, msg.clone()),
                refused,
                "{msg:?}"
            );
        }
        assert_eq!(
            on_message(&s.inner, overlay, ClientMsg::Ping),
            Some(ServerMsg::Pong)
        );
        assert!(s.drain_commands_from().is_empty());
        assert!(s.requests().is_empty());
        // The same messages from a phone are taken: the refusal is about the access.
        let phone = Peer {
            conn: 2,
            access: Access::Role(Role::Controller),
            client: "phone",
        };
        assert_eq!(on_message(&s.inner, phone, play()), None);
        assert!(matches!(
            on_message(&s.inner, phone, request()),
            Some(ServerMsg::Requested { merged: false, .. })
        ));
        assert_eq!(s.drain_commands_from().len(), 1);
        assert_eq!(s.requests().len(), 1);
    }

    #[test]
    fn the_on_air_track_is_kept_and_republishing_it_is_not_a_change() {
        let s = server();
        assert_eq!(s.on_air(), None);
        let rev = || s.inner.on_air_rev.load(Ordering::SeqCst);
        let r0 = rev();
        let track = OnAirTrack {
            id: "t1".into(),
            title: Some("Strobe".into()),
            artist: None,
        };
        s.publish_on_air(Some(track.clone()));
        assert_eq!(s.on_air(), Some(track.clone()));
        assert_eq!(rev(), r0 + 1);
        s.publish_on_air(Some(track));
        assert_eq!(rev(), r0 + 1, "the same track again wakes nobody");
        s.publish_on_air(None);
        assert_eq!((s.on_air(), rev()), (None, r0 + 2));
    }

    #[test]
    fn client_ids_are_restricted_to_safe_ascii() {
        assert!(valid_client_id("phone-1_a"));
        assert!(!valid_client_id(""));
        assert!(!valid_client_id("a b"));
        assert!(!valid_client_id("<script>"));
        assert!(!valid_client_id(&"x".repeat(41)));
    }

    #[test]
    fn pairing_urls_carry_role_path_and_token() {
        let s = RemoteServer::start(RemoteConfig {
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            ..Default::default()
        })
        .unwrap();
        let ip = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));
        let u = s.pairing_url(Role::Guest, ip);
        assert_eq!(
            u,
            format!(
                "http://192.168.1.20:{}/party?t={}",
                s.port(),
                s.token(Role::Guest)
            )
        );
        assert!(
            s.pairing_url(Role::Controller, ip)
                .contains(&format!(":{}/?t=", s.port()))
        );
        let tokens: Vec<_> = Role::ALL.iter().map(|r| s.token(*r)).collect();
        assert_ne!(tokens[0], tokens[1]);
        assert_ne!(tokens[1], tokens[2]);
    }

    #[test]
    fn sockets_that_never_send_a_request_are_capped_and_the_rest_get_503() {
        let s = server();
        // A flooder: sockets that connect and say nothing. Each holds one handshake slot (and
        // one thread) until its deadline; no more than MAX_HANDSHAKES ever do.
        let idle: Vec<TcpStream> = (0..MAX_HANDSHAKES)
            .map(|_| TcpStream::connect(("127.0.0.1", s.port())).unwrap())
            .collect();
        wait_for("every slot taken", || s.handshakes() == MAX_HANDSHAKES);
        // Beyond the cap nothing is spawned: the accept thread answers 503 itself.
        let reply = get(s.port(), "/health");
        assert!(reply.starts_with("HTTP/1.1 503"), "{reply:?}");
        assert!(reply.ends_with("busy, try again"), "{reply:?}");
        // More silent sockets never take the count over the cap (the idle ones give their
        // slot back after HANDSHAKE_TIMEOUT, so on a slow machine it may already be lower).
        let more: Vec<TcpStream> = (0..20)
            .map(|_| TcpStream::connect(("127.0.0.1", s.port())).unwrap())
            .collect();
        for _ in 0..15 {
            assert!(s.handshakes() <= MAX_HANDSHAKES);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(s.clients().is_empty());
        // The flooder goes away: the slots come back and the server answers again.
        drop(idle);
        drop(more);
        wait_for("slots freed", || s.handshakes() == 0);
        assert!(get(s.port(), "/health").starts_with("HTTP/1.1 200"));
        // A real phone still gets in afterwards.
        let mut c = connect(&s, Role::Controller, "phone");
        until(&mut c, |m| matches!(m, ServerMsg::Hello { .. }));
        assert_eq!(s.handshakes(), 0, "a session holds no handshake slot");
    }

    #[test]
    fn commands_carry_their_connection_and_a_closed_socket_stops_counting() {
        let s = server();
        // Two phones may announce the same client id: the connection id tells them apart.
        let mut a = connect(&s, Role::Controller, "dup");
        let mut b = connect(&s, Role::Controller, "dup");
        until(&mut a, |m| matches!(m, ServerMsg::Hello { .. }));
        until(&mut b, |m| matches!(m, ServerMsg::Hello { .. }));
        say(&mut a, PLAY);
        let mut got = Vec::new();
        wait_for("command a", || {
            got.extend(s.drain_commands_from());
            got.len() == 1
        });
        say(&mut b, PLAY);
        wait_for("command b", || {
            got.extend(s.drain_commands_from());
            got.len() == 2
        });
        assert_eq!(
            (got[0].client.as_str(), got[1].client.as_str()),
            ("dup", "dup")
        );
        assert_ne!(got[0].conn, got[1].conn);
        assert_eq!(got[0].command, RemoteCommand::Play { deck: 0 });
        let conns: Vec<u64> = s.clients().iter().map(|c| c.conn).collect();
        assert!(conns.contains(&got[0].conn) && conns.contains(&got[1].conn));
        assert!(s.is_connected(got[0].conn) && s.is_connected(got[1].conn));
        assert!(!s.is_connected(999_999));
        // The old API still hands out the same commands, without the connection.
        say(&mut a, PLAY);
        wait_for("old api", || {
            s.drain_commands() == [("dup".to_string(), RemoteCommand::Play { deck: 0 })]
        });
        // Phone A closes its tab: its connection stops counting, B's does not.
        let _ = a.close(None);
        let _ = a.flush();
        drop(a);
        wait_for("a gone", || !s.is_connected(got[0].conn));
        assert!(s.is_connected(got[1].conn));
    }

    #[test]
    fn a_phone_that_stops_answering_is_dropped_and_one_that_answers_stays() {
        let s = server();
        // A phone that is there: reading answers the pings.
        let mut live = connect(&s, Role::Viewer, "live");
        until(&mut live, |m| matches!(m, ServerMsg::Hello { .. }));
        // Taken BEFORE the silent phone connects: its session cannot be older than this, so
        // the lower bound below holds however slowly the rest of the setup runs.
        let start = Instant::now();
        // A phone that left the Wi-Fi: the socket stays open, nothing is read or answered. No
        // FIN ever arrives; only the missing pongs tell.
        let mut dead = TcpStream::connect(("127.0.0.1", s.port())).unwrap();
        write!(
            dead,
            "GET /ws?t={}&c=dead HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            s.token(Role::Controller),
            s.port()
        )
        .unwrap();
        wait_for("both connected", || s.clients().len() == 2);
        let conn = |id: &str| s.clients().iter().find(|c| c.id == id).map(|c| c.conn);
        let (dead_conn, live_conn) = (conn("dead").unwrap(), conn("live").unwrap());
        let end = Instant::now() + DEAD_AFTER + Duration::from_secs(4);
        if let MaybeTlsStream::Plain(t) = live.get_ref() {
            t.set_read_timeout(Some(Duration::from_millis(100)))
                .unwrap();
        }
        while s.is_connected(dead_conn) && Instant::now() < end {
            let _ = live.read();
        }
        let took = start.elapsed();
        assert!(!s.is_connected(dead_conn), "the silent phone is dropped");
        assert!(
            took >= DEAD_AFTER - Duration::from_secs(1),
            "not before {DEAD_AFTER:?}: {took:?}"
        );
        assert!(s.is_connected(live_conn), "the answering phone stays");
        drop(dead);
    }

    #[test]
    fn locked_controls_refuse_phone_commands_and_keep_requests_working() {
        let s = server();
        let mut ctl = connect(&s, Role::Controller, "phone");
        let mut guest = connect(&s, Role::Guest, "guest");
        until(&mut ctl, |m| matches!(m, ServerMsg::Hello { .. }));
        until(&mut guest, |m| matches!(m, ServerMsg::Hello { .. }));
        assert!(!s.controls_locked());
        // A command already queued when the DJ locks never reaches the decks.
        say(&mut ctl, PLAY);
        wait_for("queued", || s.inner.lock().commands.len() == 1);
        s.set_controls_locked(true);
        assert!(s.controls_locked());
        assert!(s.drain_commands_from().is_empty());
        until(&mut ctl, |m| {
            matches!(m, ServerMsg::Controls { locked: true })
        });
        // Transport and mixer: refused, with the reason.
        for refused in [
            PLAY,
            r#"{"type":"command","command":{"cmd":"pause","deck":1}}"#,
            r#"{"type":"command","command":{"cmd":"master_volume","value":0}}"#,
            r#"{"type":"command","command":{"cmd":"crossfader","value":1}}"#,
            r#"{"type":"command","command":{"cmd":"cue","deck":0,"pressed":true}}"#,
        ] {
            say(&mut ctl, refused);
            until(
                &mut ctl,
                |m| matches!(m, ServerMsg::Error { reason } if reason.contains("locked")),
            );
        }
        // Letting go of CUE still goes through (a deck must not be left playing).
        say(&mut ctl, CUE_UP);
        let mut got = Vec::new();
        wait_for("cue release", || {
            got.extend(s.drain_commands_from());
            !got.is_empty()
        });
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0].command,
            RemoteCommand::Cue {
                deck: 0,
                pressed: false
            }
        );
        // Requests, votes and moderation are not controls.
        say(
            &mut guest,
            r#"{"type":"request","title":"Strobe","artist":"deadmau5"}"#,
        );
        let id = match until(&mut guest, |m| matches!(m, ServerMsg::Requested { .. })) {
            ServerMsg::Requested { id, .. } => id,
            _ => unreachable!(),
        };
        say(&mut ctl, &format!(r#"{{"type":"vote","id":{id}}}"#));
        wait_for("vote", || {
            s.requests().first().is_some_and(|r| r.votes == 2)
        });
        say(
            &mut ctl,
            &format!(r#"{{"type":"moderate","id":{id},"action":"accept"}}"#),
        );
        wait_for("moderated", || {
            s.requests()
                .first()
                .is_some_and(|r| r.status == RequestStatus::Accepted)
        });
        // A phone that pairs while locked is told at once; guests are never told.
        let mut late = connect(&s, Role::Controller, "late");
        until(&mut late, |m| {
            matches!(m, ServerMsg::Controls { locked: true })
        });
        // Unlocked: commands flow again.
        s.set_controls_locked(false);
        until(&mut ctl, |m| {
            matches!(m, ServerMsg::Controls { locked: false })
        });
        say(&mut ctl, PLAY);
        wait_for("play after unlock", || {
            s.drain_commands() == [("phone".to_string(), RemoteCommand::Play { deck: 0 })]
        });
    }
}
