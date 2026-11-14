//! LAN control server: one accept thread, one thread per WebSocket client, an OSC/UDP thread,
//! shared state behind one mutex. The engine side only polls: `drain` controls, `reply`,
//! `publish_state`, `publish_meters`. Protocol: `docs/live/remote-protocol.md`.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use live_engine::{Control, Role};
use serde::Serialize;
use serde_json::{Value, json};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

use crate::PROTOCOL_VERSION;
use crate::http::{self, Replay};
use crate::osc;
use crate::token::{ct_eq, new_token};

pub const DEFAULT_PORT: u16 = 17920;
pub const MAX_CLIENTS: usize = 32;
/// Device pairings the server will hold at once (a band is not a stadium; this is a backstop).
pub const MAX_PAIRINGS: usize = 64;
/// Raw TCP connections (HTTP + WebSocket) open at once, counted in `accept_loop` before a thread is
/// spawned: `MAX_CLIENTS` is only checked after the upgrade, so without this a flood of half-open
/// connections would spawn a thread each.
pub const MAX_CONNS: usize = 64;
pub const MAX_PENDING: usize = 512;
pub const MAX_MSGS_PER_SEC: u32 = 200;
pub const MAX_MESSAGE: usize = 16 * 1024;
const POLL: Duration = Duration::from_millis(15);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteConfig {
    pub bind: IpAddr,
    /// 0 = any free port.
    pub port: u16,
    /// Also listen for OSC on `port + 1` (UDP). Off unless asked for: every datagram must then
    /// carry an OSC key (see `osc.rs`); the sender's address grants nothing.
    pub osc: bool,
    pub engine_name: String,
    /// Reuse these tokens instead of generating fresh ones (the host keeps them on disk so a
    /// restart does not unpair every client). `None`, or a set with an empty field, means fresh.
    pub secrets: Option<TokenSet>,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self {
            bind: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            port: DEFAULT_PORT,
            osc: false,
            engine_name: "MixAI Live".into(),
            secrets: None,
        }
    }
}

/// One **device** pairing: the token a single phone, watch or browser uses, the role it grants and
/// the label the human list shows. Revoking one leaves every other device paired.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Pairing {
    pub id: u64,
    pub token: String,
    pub role: Role,
    #[serde(default)]
    pub label: String,
    /// Milliseconds since the server started when it was minted (0 for the ones seeded at start).
    pub created_ms: u64,
}

/// A pairing to seed the server with, before it has an id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedPairing {
    pub token: String,
    pub role: Role,
    #[allow(dead_code)]
    pub label: String,
}

/// What the host keeps on disk and hands back at start: the device pairings and the two OSC keys
/// (performer, controller — separate, because a control-surface layout that embeds a key is a file
/// people export and share).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TokenSet {
    pub pairings: Vec<SeedPairing>,
    pub osc_keys: [String; 2],
}

/// A validated control waiting for the engine, with where to send the answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Incoming {
    /// 0 = OSC (no reply channel).
    pub conn: u64,
    pub client: String,
    pub role: Role,
    pub id: Option<u32>,
    pub control: Control,
}

/// An authenticated connection: the device pairing it presented, the token it used and the id it
/// claimed. One value, so the connection loop does not take six arguments.
struct Client {
    id: String,
    pairing: u64,
    token: String,
    conn: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClientInfo {
    pub id: String,
    pub role: Role,
    pub addr: String,
    pub connected_ms: u64,
}

const ROLES: [Role; 3] = [Role::Viewer, Role::Performer, Role::Controller];

/// Parse a role name (`viewer` | `performer` | `controller`), as it is written to disk and on the
/// wire.
pub fn role_from(name: &str) -> Option<Role> {
    match name {
        "viewer" => Some(Role::Viewer),
        "performer" => Some(Role::Performer),
        "controller" => Some(Role::Controller),
        _ => None,
    }
}

/// The name of a role, the inverse of [`role_from`].
pub fn role_name(role: Role) -> &'static str {
    match role {
        Role::Viewer => "viewer",
        Role::Performer => "performer",
        Role::Controller => "controller",
    }
}

struct Shared {
    /// One token per device. Empty means nothing is paired yet.
    pairings: Vec<Pairing>,
    /// OSC keys: performer, controller. Separate from the pairing tokens because control-surface
    /// layouts that embed them are files people export and share.
    osc_keys: [String; 2],
    hello: Value,
    state: String,
    meters: String,
    /// The newest spectrum frame, sent to clients that asked for meters (15 Hz, one byte per bin).
    spectrum: String,
    incoming: VecDeque<Incoming>,
    replies: HashMap<u64, VecDeque<String>>,
    clients: HashMap<u64, ClientInfo>,
}

pub(crate) struct Inner {
    shared: Mutex<Shared>,
    state_rev: AtomicU64,
    meters_rev: AtomicU64,
    /// Bumped when a fresh spectrum frame is published.
    spectrum_rev: AtomicU64,
    token_rev: AtomicU64,
    /// Bumped when the pairing list changes, so controllers get a fresh `devices` frame.
    devices_rev: AtomicU64,
    next_pairing: AtomicU64,
    stop: AtomicBool,
    next_conn: AtomicU64,
    started: Instant,
    /// Set once when the OSC socket is bound.
    osc_port: OnceLock<u16>,
    /// Open raw TCP connections, guarded by `ConnGuard`.
    conns: AtomicUsize,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn push_incoming(&self, inc: Incoming) {
        let mut s = self.lock();
        if s.incoming.len() >= MAX_PENDING {
            // A flood must not be able to take the panic button away: drop the oldest control that
            // is not a PANIC instead of the oldest control outright.
            match s
                .incoming
                .iter()
                .position(|q| !matches!(q.control, Control::Panic))
            {
                Some(i) => {
                    s.incoming.remove(i);
                }
                None => {
                    s.incoming.pop_front();
                }
            }
        }
        s.incoming.push_back(inc);
    }

    /// Role granted by an OSC key (constant-time compare against both keys).
    pub(crate) fn osc_role(&self, key: &str) -> Option<Role> {
        let s = self.lock();
        let performer = ct_eq(&s.osc_keys[0], key);
        let controller = ct_eq(&s.osc_keys[1], key);
        if controller {
            Some(Role::Controller)
        } else if performer {
            Some(Role::Performer)
        } else {
            None
        }
    }

    pub(crate) fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// Mint a pairing for one more device. `None` when the list is full.
    fn add_pairing(&self, role: Role, label: &str) -> Option<Pairing> {
        let p = {
            let mut s = self.lock();
            if s.pairings.len() >= MAX_PAIRINGS {
                return None;
            }
            let p = Pairing {
                id: self.next_pairing.fetch_add(1, Ordering::SeqCst),
                token: new_token(),
                role,
                label: label.trim().chars().take(40).collect(),
                created_ms: self.started.elapsed().as_millis() as u64,
            };
            s.pairings.push(p.clone());
            p
        };
        self.devices_rev.fetch_add(1, Ordering::SeqCst);
        Some(p)
    }

    /// Revoke one device; its clients are dropped on the next token check. `None` revokes all.
    /// Returns how many were revoked.
    fn revoke_pairings(&self, id: Option<u64>) -> usize {
        let removed = {
            let mut s = self.lock();
            let before = s.pairings.len();
            match id {
                Some(id) => s.pairings.retain(|p| p.id != id),
                None => s.pairings.clear(),
            }
            before - s.pairings.len()
        };
        if removed > 0 {
            self.token_rev.fetch_add(1, Ordering::SeqCst);
            self.devices_rev.fetch_add(1, Ordering::SeqCst);
        }
        removed
    }

    /// The pairing list as a JSON array (what a controller is shown).
    pub(crate) fn pairings_json(&self) -> String {
        serde_json::to_string(&self.lock().pairings).unwrap_or_else(|_| "[]".into())
    }
}

pub struct RemoteServer {
    inner: Arc<Inner>,
    addr: SocketAddr,
    osc_port: Option<u16>,
    /// The OSC receiver blocks in a read with no timeout: `stop` wakes it at this address.
    osc: Option<(SocketAddr, JoinHandle<()>)>,
    threads: Vec<JoinHandle<()>>,
}

/// LAN address of the default route (no packets sent).
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
        // Seed the device pairings from disk; when nothing is paired, mint one per role, which is
        // what the `ready` line and the pairing URLs hand out.
        let mut pairings: Vec<Pairing> = Vec::new();
        let mut osc_keys = [String::new(), String::new()];
        let mut next = 1u64;
        if let Some(set) = config.secrets {
            osc_keys = set.osc_keys;
            for s in set.pairings {
                if s.token.is_empty() || pairings.len() >= MAX_PAIRINGS {
                    continue;
                }
                pairings.push(Pairing {
                    id: next,
                    token: s.token,
                    role: s.role,
                    label: s.label,
                    created_ms: 0,
                });
                next += 1;
            }
        }
        for role in ROLES {
            if !pairings.iter().any(|p| p.role == role) {
                pairings.push(Pairing {
                    id: next,
                    token: new_token(),
                    role,
                    label: String::new(),
                    created_ms: 0,
                });
                next += 1;
            }
        }
        for k in &mut osc_keys {
            if k.is_empty() {
                *k = new_token();
            }
        }
        let inner = Arc::new(Inner {
            shared: Mutex::new(Shared {
                pairings,
                osc_keys,
                hello: json!({ "engine_name": config.engine_name }),
                state: "null".into(),
                meters: String::new(),
                spectrum: String::new(),
                incoming: VecDeque::new(),
                replies: HashMap::new(),
                clients: HashMap::new(),
            }),
            // 0 = nothing published yet: connections send no `state` until the engine publishes
            // (a `"state": null` frame would wipe client UIs on connect).
            state_rev: AtomicU64::new(0),
            meters_rev: AtomicU64::new(0),
            spectrum_rev: AtomicU64::new(0),
            token_rev: AtomicU64::new(1),
            devices_rev: AtomicU64::new(1),
            next_pairing: AtomicU64::new(next),
            stop: AtomicBool::new(false),
            next_conn: AtomicU64::new(1),
            started: Instant::now(),
            osc_port: OnceLock::new(),
            conns: AtomicUsize::new(0),
        });
        let mut threads = Vec::new();
        let i2 = inner.clone();
        threads.push(
            std::thread::Builder::new()
                .name("live-remote-accept".into())
                .spawn(move || accept_loop(listener, i2))?,
        );
        let mut osc_port = None;
        let mut osc = None;
        if config.osc {
            let sock = UdpSocket::bind((config.bind, addr.port().wrapping_add(1)))
                .or_else(|_| UdpSocket::bind((config.bind, 0)))?;
            sock.set_read_timeout(None)?;
            let mut wake = sock.local_addr()?;
            osc_port = Some(wake.port());
            let _ = inner.osc_port.set(wake.port());
            // A socket bound to every interface is reached through loopback.
            if wake.ip().is_unspecified() {
                wake.set_ip(match wake.ip() {
                    IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::LOCALHOST),
                    IpAddr::V6(_) => IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
                });
            }
            let i3 = inner.clone();
            // 4 MiB: the OSC decoder recurses once per nested bundle of a (4 KiB) datagram.
            let handle = std::thread::Builder::new()
                .name("live-remote-osc".into())
                .stack_size(4 << 20)
                .spawn(move || osc::run(sock, i3))?;
            osc = Some((wake, handle));
        }
        Ok(Self {
            inner,
            addr,
            osc_port,
            osc,
            threads,
        })
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn osc_port(&self) -> Option<u16> {
        self.osc_port
    }

    /// The token the pairing URLs hand out for a role: the first device paired on it.
    pub fn token(&self, role: Role) -> String {
        self.inner
            .lock()
            .pairings
            .iter()
            .find(|p| p.role == role)
            .map(|p| p.token.clone())
            .unwrap_or_default()
    }

    /// Every device pairing (what a controller lists, and what the human revokes by id).
    pub fn pairings(&self) -> Vec<Pairing> {
        self.inner.lock().pairings.clone()
    }

    /// The pairings and OSC keys, to write down so the next start reuses them.
    pub fn token_set(&self) -> TokenSet {
        let s = self.inner.lock();
        TokenSet {
            pairings: s
                .pairings
                .iter()
                .map(|p| SeedPairing {
                    token: p.token.clone(),
                    role: p.role,
                    label: p.label.clone(),
                })
                .collect(),
            osc_keys: s.osc_keys.clone(),
        }
    }

    /// Mint a pairing for one more device: the token is what its QR carries, and revoking it later
    /// leaves every other device paired. `None` when the list is full.
    pub fn add_pairing(&self, role: Role, label: &str) -> Option<Pairing> {
        self.inner.add_pairing(role, label)
    }

    /// Revoke one device. Its clients are disconnected on the next token check. `false` when the id
    /// is not paired (already revoked).
    pub fn revoke_pairing(&self, id: u64) -> bool {
        self.inner.revoke_pairings(Some(id)) > 0
    }

    /// OSC key of a role (`None` when OSC is off, and for viewers: OSC only sends controls).
    pub fn osc_key(&self, role: Role) -> Option<String> {
        self.osc_port?;
        let s = self.inner.lock();
        match role {
            Role::Viewer => None,
            Role::Performer => Some(s.osc_keys[0].clone()),
            Role::Controller => Some(s.osc_keys[1].clone()),
        }
    }

    /// Rotate a role: revoke **every** device paired on it and hand out one fresh token (the
    /// "unpair everyone on this role" the CLI has always had). A single device is revoked by id
    /// through [`revoke_pairing`](Self::revoke_pairing). The role's OSC key rotates with it.
    pub fn rotate_token(&self, role: Role) -> String {
        let t = new_token();
        {
            let mut s = self.inner.lock();
            s.pairings.retain(|p| p.role != role);
            s.pairings.push(Pairing {
                id: self.inner.next_pairing.fetch_add(1, Ordering::SeqCst),
                token: t.clone(),
                role,
                label: String::new(),
                created_ms: self.inner.started.elapsed().as_millis() as u64,
            });
            match role {
                Role::Viewer => {}
                Role::Performer => s.osc_keys[0] = new_token(),
                Role::Controller => s.osc_keys[1] = new_token(),
            }
        }
        self.inner.token_rev.fetch_add(1, Ordering::SeqCst);
        self.inner.devices_rev.fetch_add(1, Ordering::SeqCst);
        t
    }

    /// `http://<ip>:<port>/?t=<token>` — opens the web remote; native apps read host/port/t from it.
    pub fn pairing_url(&self, role: Role, host: IpAddr) -> String {
        let h = match host {
            IpAddr::V6(v6) => format!("[{v6}]"),
            IpAddr::V4(v4) => v4.to_string(),
        };
        format!("http://{h}:{}/?t={}", self.port(), self.token(role))
    }

    /// Static fields sent in `hello` (sample rate, devices...).
    pub fn set_hello(&self, extra: Value) {
        let mut s = self.inner.lock();
        if let (Value::Object(base), Value::Object(add)) = (&mut s.hello, extra) {
            base.extend(add);
        }
    }

    pub fn publish_state<T: Serialize>(&self, state: &T) {
        let j = serde_json::to_string(state).unwrap_or_else(|_| "null".into());
        let mut s = self.inner.lock();
        if s.state != j {
            s.state = j;
            self.inner.state_rev.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Meters as a ready JSON object (see `crate::meters_json`).
    pub fn publish_meters(&self, json: String) {
        self.inner.lock().meters = json;
        self.inner.meters_rev.fetch_add(1, Ordering::SeqCst);
    }

    /// Publish a spectrum frame (see `spectrum_json`). Sent to the clients that asked for meters.
    pub fn publish_spectrum(&self, json: String) {
        self.inner.lock().spectrum = json;
        self.inner.spectrum_rev.fetch_add(1, Ordering::SeqCst);
    }

    pub fn drain(&self) -> Vec<Incoming> {
        self.inner.lock().incoming.drain(..).collect()
    }

    /// Answer a control (`ack` on Ok, `error` with a code on Err).
    pub fn reply(&self, conn: u64, id: Option<u32>, result: Result<(), (&str, String)>) {
        if conn == 0 {
            return;
        }
        let msg = match result {
            Ok(()) => json!({ "type": "ack", "id": id }),
            Err((code, message)) => {
                json!({ "type": "error", "id": id, "code": code, "message": message })
            }
        };
        let mut s = self.inner.lock();
        if let Some(q) = s.replies.get_mut(&conn)
            && q.len() < 256
        {
            q.push_back(msg.to_string());
        }
    }

    pub fn clients(&self) -> Vec<ClientInfo> {
        let mut v: Vec<_> = self.inner.lock().clients.values().cloned().collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    pub fn stop(&mut self) {
        self.inner.stop.store(true, Ordering::SeqCst);
        if let Some((wake, handle)) = self.osc.take() {
            // Wake the blocking read with a datagram to its own port; repeat until the thread
            // is gone (2 s at most, then leave it detached rather than hang the shutdown).
            let any: SocketAddr = match wake {
                SocketAddr::V4(_) => (Ipv4Addr::UNSPECIFIED, 0).into(),
                SocketAddr::V6(_) => (std::net::Ipv6Addr::UNSPECIFIED, 0).into(),
            };
            let sock = UdpSocket::bind(any).ok();
            for _ in 0..100 {
                if handle.is_finished() {
                    break;
                }
                if let Some(s) = &sock {
                    let _ = s.send_to(&[0], wake);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            if handle.is_finished() {
                let _ = handle.join();
            }
        }
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

impl Drop for RemoteServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn accept_loop(listener: TcpListener, inner: Arc<Inner>) {
    while !inner.stopped() {
        match listener.accept() {
            Ok((stream, peer)) => {
                // Cap before spawning a thread: the WebSocket cap is checked only after the
                // upgrade, so a flood of raw connections would otherwise spawn a thread each.
                if inner.conns.load(Ordering::SeqCst) >= MAX_CONNS {
                    drop(stream);
                    continue;
                }
                inner.conns.fetch_add(1, Ordering::SeqCst);
                let i2 = inner.clone();
                let _ = std::thread::Builder::new()
                    .name("live-remote-conn".into())
                    .spawn(move || {
                        let _guard = ConnGuard(i2.clone());
                        let _ = handle(stream, peer, i2);
                    });
            }
            Err(_) => std::thread::sleep(POLL),
        }
    }
}

/// Keeps the open-connection count honest even when `handle` returns early with an error.
struct ConnGuard(Arc<Inner>);

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.0.conns.fetch_sub(1, Ordering::SeqCst);
    }
}

fn valid_client_id(c: &str) -> bool {
    (1..=40).contains(&c.len())
        && c.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn fx_catalogue() -> String {
    let fx: Vec<Value> = live_dsp::FxKind::ALL
        .iter()
        .map(|k| {
            let params: Vec<Value> = k
                .specs()
                .iter()
                .map(|p| {
                    json!({
                        "id": p.id, "min": p.min, "max": p.max, "default": p.default,
                        "unit": format!("{:?}", p.unit).to_lowercase(),
                        "curve": format!("{:?}", p.curve).to_lowercase(),
                        "choices": p.choices,
                    })
                })
                .collect();
            json!({ "id": k.id(), "params": params })
        })
        .collect();
    Value::Array(fx).to_string()
}

fn handle(mut stream: TcpStream, peer: SocketAddr, inner: Arc<Inner>) -> io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let raw = http::read_head(&mut stream)?;
    let Ok(head) = http::parse_head(&raw) else {
        return http::respond(&mut stream, "400 Bad Request", "text/plain", "bad request");
    };
    if head.method != "GET" {
        return http::respond(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain",
            "GET only",
        );
    }
    match head.path.as_str() {
        "/health" => {
            let body = json!({ "ok": true, "protocol": PROTOCOL_VERSION, "version": env!("CARGO_PKG_VERSION") });
            return http::respond(&mut stream, "200 OK", "application/json", &body.to_string());
        }
        "/api/fx" => {
            return http::respond(&mut stream, "200 OK", "application/json", &fx_catalogue());
        }
        _ => {}
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
    let (role, who) = {
        let mut s = inner.lock();
        let found = head.param("t").and_then(|t| {
            s.pairings
                .iter()
                .find(|p| ct_eq(&p.token, t))
                .map(|p| (p.role, p.id, p.token.clone()))
        });
        let Some((role, pairing, token)) = found else {
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
        s.replies.insert(conn, VecDeque::new());
        (
            role,
            Client {
                id: client,
                pairing,
                token,
                conn,
            },
        )
    };
    let result = session(stream, raw, &inner, role, &who);
    let mut s = inner.lock();
    s.clients.remove(&who.conn);
    s.replies.remove(&who.conn);
    result
}

fn is_timeout(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(io) if matches!(io.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut))
}

/// What a client message turned into.
#[derive(Debug, PartialEq)]
pub(crate) enum Parsed {
    Subscribe {
        meters: bool,
        hz: u32,
    },
    Ping(Value),
    Control {
        id: Option<u32>,
        control: Control,
    },
    /// Mint a pairing for one more device (controller only). Answered by the `devices` frame.
    Pair {
        id: Option<u32>,
        role: String,
        label: String,
    },
    /// Revoke one device by id, or every device when `device` is absent (controller only).
    Unpair {
        id: Option<u32>,
        device: Option<u64>,
    },
    Bad {
        id: Option<u32>,
        message: String,
    },
}

pub(crate) fn parse_client(text: &str) -> Parsed {
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            return Parsed::Bad {
                id: None,
                message: format!("bad JSON: {e}"),
            };
        }
    };
    let id = v.get("id").and_then(Value::as_u64).map(|x| x as u32);
    match v.get("type").and_then(Value::as_str) {
        Some("subscribe") => Parsed::Subscribe {
            meters: v.get("meters").and_then(Value::as_bool).unwrap_or(false),
            hz: v
                .get("meters_hz")
                .and_then(Value::as_u64)
                .unwrap_or(30)
                .clamp(1, 30) as u32,
        },
        Some("ping") => Parsed::Ping(v.get("t").cloned().unwrap_or(Value::Null)),
        Some("pair") => Parsed::Pair {
            id,
            role: v
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("performer")
                .to_string(),
            label: v
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        },
        Some("unpair") => Parsed::Unpair {
            id,
            device: v.get("device").and_then(Value::as_u64),
        },
        Some(_) => match serde_json::from_value::<Control>(v) {
            Ok(control) => Parsed::Control { id, control },
            Err(e) => Parsed::Bad {
                id,
                message: e.to_string(),
            },
        },
        None => Parsed::Bad {
            id,
            message: "missing `type`".into(),
        },
    }
}

fn session(
    stream: TcpStream,
    raw: Vec<u8>,
    inner: &Inner,
    role: Role,
    who: &Client,
) -> io::Result<()> {
    let cfg = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let mut ws: WebSocket<Replay> =
        tungstenite::accept_with_config(Replay::new(raw, stream), Some(cfg))
            .map_err(|e| io::Error::other(e.to_string()))?;
    ws.get_ref().inner.set_read_timeout(Some(POLL))?;
    ws.get_ref().inner.set_nodelay(true)?;
    let io_err = |e: tungstenite::Error| io::Error::other(e.to_string());
    let send = |ws: &mut WebSocket<Replay>, s: String| ws.send(Message::text(s));
    let mut hello = inner.lock().hello.clone();
    if let Value::Object(m) = &mut hello {
        m.insert("type".into(), "hello".into());
        m.insert("protocol".into(), PROTOCOL_VERSION.into());
        m.insert("version".into(), env!("CARGO_PKG_VERSION").into());
        m.insert(
            "role".into(),
            serde_json::to_value(role).unwrap_or(Value::Null),
        );
        m.insert("client".into(), Value::from(who.id.as_str()));
        // OSC keys go only to devices that may send controls, and only when OSC is on.
        if role >= Role::Performer
            && let Some(port) = inner.osc_port.get()
        {
            let s = inner.lock();
            let mut osc = json!({ "port": port, "performer_key": s.osc_keys[0] });
            if role == Role::Controller {
                osc["controller_key"] = s.osc_keys[1].clone().into();
            }
            m.insert("osc".into(), osc);
        }
    }
    send(&mut ws, hello.to_string()).map_err(io_err)?;
    let mut seen_state = 0u64;
    let mut seen_meters = inner.meters_rev.load(Ordering::SeqCst);
    let mut seen_spectrum = inner.spectrum_rev.load(Ordering::SeqCst);
    let mut seen_devices = 0u64;
    let mut meters_on = false;
    let mut meters_every = Duration::from_millis(33);
    let mut meters_last = Instant::now();
    let mut token_rev = inner.token_rev.load(Ordering::SeqCst);
    let mut window = Instant::now();
    let mut in_window = 0u32;
    loop {
        if inner.stopped() {
            let _ = ws.close(None);
            let _ = ws.flush();
            return Ok(());
        }
        let trev = inner.token_rev.load(Ordering::SeqCst);
        if trev != token_rev {
            token_rev = trev;
            // Still paired? A revoked device (or a rotated role) is dropped on the spot.
            let paired = inner
                .lock()
                .pairings
                .iter()
                .any(|p| p.id == who.pairing && ct_eq(&p.token, &who.token));
            if !paired {
                let _ = ws.close(None);
                let _ = ws.flush();
                return Ok(());
            }
        }
        let drev = inner.devices_rev.load(Ordering::SeqCst);
        if role == Role::Controller && drev != seen_devices {
            seen_devices = drev;
            send(
                &mut ws,
                format!(
                    "{{\"type\":\"devices\",\"devices\":{}}}",
                    inner.pairings_json()
                ),
            )
            .map_err(io_err)?;
        }
        let srev = inner.state_rev.load(Ordering::SeqCst);
        if srev != seen_state {
            seen_state = srev;
            let st = inner.lock().state.clone();
            send(&mut ws, format!("{{\"type\":\"state\",\"state\":{st}}}")).map_err(io_err)?;
        }
        let mrev = inner.meters_rev.load(Ordering::SeqCst);
        if meters_on && mrev != seen_meters && meters_last.elapsed() >= meters_every {
            seen_meters = mrev;
            meters_last = Instant::now();
            let m = inner.lock().meters.clone();
            if !m.is_empty() {
                send(&mut ws, m).map_err(io_err)?;
            }
        }
        // The spectrum rides along with the meters (one byte per bin, ~15 Hz): no second
        // subscription, and a client that wants only meters can ignore the type.
        let srev = inner.spectrum_rev.load(Ordering::SeqCst);
        if meters_on && srev != seen_spectrum {
            seen_spectrum = srev;
            let spec = inner.lock().spectrum.clone();
            if !spec.is_empty() {
                send(&mut ws, spec).map_err(io_err)?;
            }
        }
        let pending: Vec<String> = inner
            .lock()
            .replies
            .get_mut(&who.conn)
            .map(|q| q.drain(..).collect())
            .unwrap_or_default();
        for r in pending {
            send(&mut ws, r).map_err(io_err)?;
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                if window.elapsed() >= Duration::from_secs(1) {
                    window = Instant::now();
                    in_window = 0;
                }
                let parsed = parse_client(t.as_str());
                // A PANIC is never rate-limited: a flood must not be able to delay or eat the panic
                // button (the OSC path exempts it the same way).
                let panic = matches!(
                    &parsed,
                    Parsed::Control {
                        control: Control::Panic,
                        ..
                    }
                );
                in_window += 1;
                if !panic && in_window > MAX_MSGS_PER_SEC {
                    if in_window == MAX_MSGS_PER_SEC + 1 {
                        let e = json!({ "type": "error", "code": "rate_limited", "message": "too many messages" });
                        send(&mut ws, e.to_string()).map_err(io_err)?;
                    }
                    continue;
                }
                match parsed {
                    Parsed::Subscribe { meters, hz } => {
                        meters_on = meters;
                        meters_every = Duration::from_millis(1000 / hz as u64);
                    }
                    Parsed::Ping(t) => send(&mut ws, json!({ "type": "pong", "t": t }).to_string())
                        .map_err(io_err)?,
                    Parsed::Control { id, control } => {
                        if role < control.required_role() {
                            let e = json!({ "type": "error", "id": id, "code": "forbidden", "message": "this device cannot do that" });
                            send(&mut ws, e.to_string()).map_err(io_err)?;
                        } else {
                            inner.push_incoming(Incoming {
                                conn: who.conn,
                                client: who.id.clone(),
                                role,
                                id,
                                control,
                            });
                        }
                    }
                    Parsed::Bad { id, message } => {
                        let e = json!({ "type": "error", "id": id, "code": "bad_request", "message": message });
                        send(&mut ws, e.to_string()).map_err(io_err)?;
                    }
                    Parsed::Pair {
                        id,
                        role: want,
                        label,
                    } => {
                        let answer = if role < Role::Controller {
                            json!({ "type": "error", "id": id, "code": "forbidden", "message": "this device cannot pair devices" })
                        } else if let Some(r) = role_from(&want) {
                            match inner.add_pairing(r, &label) {
                                Some(p) => json!({ "type": "ack", "id": id, "pairing": p.id }),
                                None => {
                                    json!({ "type": "error", "id": id, "code": "too_many", "message": "too many paired devices" })
                                }
                            }
                        } else {
                            json!({ "type": "error", "id": id, "code": "bad_request", "message": format!("unknown role `{want}`") })
                        };
                        send(&mut ws, answer.to_string()).map_err(io_err)?;
                    }
                    Parsed::Unpair { id, device } => {
                        let answer = if role < Role::Controller {
                            json!({ "type": "error", "id": id, "code": "forbidden", "message": "this device cannot unpair devices" })
                        } else {
                            json!({ "type": "ack", "id": id, "revoked": inner.revoke_pairings(device) })
                        };
                        send(&mut ws, answer.to_string()).map_err(io_err)?;
                    }
                }
            }
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => {}
            Err(e) if is_timeout(&e) => match ws.flush() {
                Err(e) if !is_timeout(&e) => return Err(io_err(e)),
                _ => {}
            },
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
    fn parse_client_messages() {
        assert_eq!(
            parse_client(r#"{"type":"subscribe","meters":true,"meters_hz":10}"#),
            Parsed::Subscribe {
                meters: true,
                hz: 10
            }
        );
        assert!(matches!(
            parse_client(r#"{"type":"next","id":7}"#),
            Parsed::Control {
                id: Some(7),
                control: Control::Next
            }
        ));
        assert!(matches!(
            parse_client(r#"{"type":"warp"}"#),
            Parsed::Bad { .. }
        ));
        assert!(matches!(parse_client("nope"), Parsed::Bad { .. }));
        assert!(valid_client_id("watch-1") && !valid_client_id("<x>"));
    }

    #[test]
    fn catalogue_lists_every_effect() {
        let v: Value = serde_json::from_str(&fx_catalogue()).unwrap();
        assert_eq!(v.as_array().unwrap().len(), live_dsp::FxKind::ALL.len());
    }
}
