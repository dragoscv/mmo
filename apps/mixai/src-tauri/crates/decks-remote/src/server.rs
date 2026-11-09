//! The LAN server: one accept thread, one thread per connection (a handful of phones), shared
//! state behind one mutex. The app side is polling only: `publish` state, `drain_commands`.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

use crate::PROTOCOL_VERSION;
use crate::http::{self, Head, Replay};
use crate::party::{RequestQueue, RequestStatus, SongRequestView};
use crate::protocol::{ClientMsg, ModerateAction, RemoteCommand, RemoteState, Role, ServerMsg};
use crate::token::{ct_eq, new_token};

/// Connected devices at most (beyond this new sockets get 503).
pub const MAX_CLIENTS: usize = 48;
/// Commands queued for the app at most (oldest dropped).
pub const MAX_PENDING_COMMANDS: usize = 512;
/// Messages per client per second before the excess is dropped.
pub const MAX_MSGS_PER_SEC: u32 = 120;
/// Largest WebSocket message accepted.
pub const MAX_MESSAGE: usize = 16 * 1024;
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
    pub role: Role,
    pub addr: String,
    pub connected_ms: u64,
}

struct State {
    tokens: [String; 3],
    remote: RemoteState,
    queue: RequestQueue,
    commands: VecDeque<(String, RemoteCommand)>,
    clients: HashMap<u64, ClientInfo>,
}

struct Inner {
    state: Mutex<State>,
    state_rev: AtomicU64,
    queue_rev: AtomicU64,
    token_rev: AtomicU64,
    stop: AtomicBool,
    next_conn: AtomicU64,
    started: Instant,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
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
    pub fn start(config: RemoteConfig) -> io::Result<Self> {
        let listener = TcpListener::bind((config.bind, config.port))?;
        listener.set_nonblocking(true)?;
        let addr = listener.local_addr()?;
        let mut queue = RequestQueue::default();
        queue.set_open(config.party_open);
        let inner = Arc::new(Inner {
            state: Mutex::new(State {
                tokens: [new_token(), new_token(), new_token()],
                remote: RemoteState::default(),
                queue,
                commands: VecDeque::new(),
                clients: HashMap::new(),
            }),
            state_rev: AtomicU64::new(1),
            queue_rev: AtomicU64::new(1),
            token_rev: AtomicU64::new(1),
            stop: AtomicBool::new(false),
            next_conn: AtomicU64::new(1),
            started: Instant::now(),
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
        self.inner.lock().tokens[role.index()] = t.clone();
        self.inner.token_rev.fetch_add(1, Ordering::SeqCst);
        t
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
        self.inner.lock().commands.drain(..).collect()
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

fn accept_loop(listener: TcpListener, inner: Arc<Inner>) {
    while !inner.stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, peer)) => {
                let i2 = inner.clone();
                let _ = std::thread::Builder::new()
                    .name("decks-remote-conn".into())
                    .spawn(move || {
                        let _ = handle(stream, peer, i2);
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

fn handle(mut stream: TcpStream, peer: SocketAddr, inner: Arc<Inner>) -> io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let raw = http::read_head(&mut stream)?;
    let head = match http::parse_head(&raw) {
        Ok(h) => h,
        Err(_) => {
            return http::respond(&mut stream, "400 Bad Request", "text/plain", "bad request");
        }
    };
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
    let (role, token, conn, client) = {
        let mut s = inner.lock();
        let Some(role) = head.param("t").and_then(|t| role_for(&s, t)) else {
            drop(s);
            return http::respond(&mut stream, "401 Unauthorized", "text/plain", "token");
        };
        if s.clients.len() >= MAX_CLIENTS {
            drop(s);
            return http::respond(&mut stream, "503 Service Unavailable", "text/plain", "full");
        }
        let conn = inner.next_conn.fetch_add(1, Ordering::SeqCst);
        let client = head
            .param("c")
            .filter(|c| valid_client_id(c))
            .map(str::to_string)
            .unwrap_or_else(|| format!("anon-{}", &new_token()[..12]));
        s.clients.insert(
            conn,
            ClientInfo {
                id: client.clone(),
                role,
                addr: peer.to_string(),
                connected_ms: inner.started.elapsed().as_millis() as u64,
            },
        );
        (role, s.tokens[role.index()].clone(), conn, client)
    };
    let result = session(stream, raw, &head, &inner, role, &token, &client);
    inner.lock().clients.remove(&conn);
    result
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
    now_playing: Vec<String>,
}

fn push_updates(
    ws: &mut WebSocket<Replay>,
    inner: &Inner,
    role: Role,
    client: &str,
    seen: &mut Seen,
) -> Result<(), tungstenite::Error> {
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

fn on_message(inner: &Inner, role: Role, client: &str, msg: ClientMsg) -> Option<ServerMsg> {
    let err = |r: &str| Some(ServerMsg::Error { reason: r.into() });
    match msg {
        ClientMsg::Ping => Some(ServerMsg::Pong),
        ClientMsg::Command { command } => {
            if role != Role::Controller {
                return err("this device cannot control the decks");
            }
            match command.validated() {
                Ok(c) => {
                    let mut s = inner.lock();
                    if s.commands.len() >= MAX_PENDING_COMMANDS {
                        s.commands.pop_front();
                    }
                    s.commands.push_back((client.to_string(), c));
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
    _head: &Head,
    inner: &Inner,
    role: Role,
    token: &str,
    client: &str,
) -> io::Result<()> {
    let replay = Replay::new(raw, stream);
    let mut ws = tungstenite::accept_with_config(replay, Some(ws_config()))
        .map_err(|e| io::Error::other(e.to_string()))?;
    ws.get_ref().inner.set_read_timeout(Some(POLL))?;
    let io_err = |e: tungstenite::Error| io::Error::other(e.to_string());
    let party_open = inner.lock().queue.is_open();
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
    let mut seen = Seen {
        state: 0,
        queue: 0,
        now_playing: vec![String::new()],
    };
    let mut token_rev = inner.token_rev.load(Ordering::SeqCst);
    let mut window = Instant::now();
    let mut in_window = 0u32;
    loop {
        if inner.stop.load(Ordering::SeqCst) {
            let _ = ws.close(None);
            let _ = ws.flush();
            return Ok(());
        }
        let trev = inner.token_rev.load(Ordering::SeqCst);
        if trev != token_rev {
            token_rev = trev;
            let still = ct_eq(&inner.lock().tokens[role.index()], token);
            if !still {
                let _ = ws.close(None);
                let _ = ws.flush();
                return Ok(());
            }
        }
        push_updates(&mut ws, inner, role, client, &mut seen).map_err(io_err)?;
        match ws.read() {
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
                    Ok(m) => on_message(inner, role, client, m),
                    Err(e) => Some(ServerMsg::Error {
                        reason: format!("bad message: {e}"),
                    }),
                };
                if let Some(r) = reply {
                    send(&mut ws, &r).map_err(io_err)?;
                }
            }
            Ok(Message::Close(_)) => return Ok(()),
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
    use super::*;

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
}
