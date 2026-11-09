//! LAN control server: one accept thread, one thread per WebSocket client, an OSC/UDP thread,
//! shared state behind one mutex. The engine side only polls: `drain` controls, `reply`,
//! `publish_state`, `publish_meters`. Protocol: `docs/live/remote-protocol.md`.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
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
pub const MAX_PENDING: usize = 512;
pub const MAX_MSGS_PER_SEC: u32 = 200;
pub const MAX_MESSAGE: usize = 16 * 1024;
const POLL: Duration = Duration::from_millis(15);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteConfig {
    pub bind: IpAddr,
    /// 0 = any free port.
    pub port: u16,
    /// Also listen for OSC on `port + 1` (UDP).
    pub osc: bool,
    pub engine_name: String,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self {
            bind: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            port: DEFAULT_PORT,
            osc: true,
            engine_name: "MixAI Live".into(),
        }
    }
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

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClientInfo {
    pub id: String,
    pub role: Role,
    pub addr: String,
    pub connected_ms: u64,
}

const ROLES: [Role; 3] = [Role::Viewer, Role::Performer, Role::Controller];

fn role_index(r: Role) -> usize {
    match r {
        Role::Viewer => 0,
        Role::Performer => 1,
        Role::Controller => 2,
    }
}

struct Shared {
    tokens: [String; 3],
    hello: Value,
    state: String,
    meters: String,
    incoming: VecDeque<Incoming>,
    replies: HashMap<u64, VecDeque<String>>,
    clients: HashMap<u64, ClientInfo>,
}

pub(crate) struct Inner {
    shared: Mutex<Shared>,
    state_rev: AtomicU64,
    meters_rev: AtomicU64,
    token_rev: AtomicU64,
    stop: AtomicBool,
    next_conn: AtomicU64,
    started: Instant,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn push_incoming(&self, inc: Incoming) {
        let mut s = self.lock();
        if s.incoming.len() >= MAX_PENDING {
            s.incoming.pop_front();
        }
        s.incoming.push_back(inc);
    }

    /// Highest role among connected WebSocket clients from `ip` (OSC authorisation).
    pub(crate) fn role_of_ip(&self, ip: IpAddr) -> Option<Role> {
        if ip.is_loopback() {
            return Some(Role::Controller);
        }
        let s = self.lock();
        s.clients
            .values()
            .filter(|c| c.addr.parse::<SocketAddr>().is_ok_and(|a| a.ip() == ip))
            .map(|c| c.role)
            .max()
    }

    pub(crate) fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
}

pub struct RemoteServer {
    inner: Arc<Inner>,
    addr: SocketAddr,
    osc_port: Option<u16>,
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
        let inner = Arc::new(Inner {
            shared: Mutex::new(Shared {
                tokens: [new_token(), new_token(), new_token()],
                hello: json!({ "engine_name": config.engine_name }),
                state: "null".into(),
                meters: String::new(),
                incoming: VecDeque::new(),
                replies: HashMap::new(),
                clients: HashMap::new(),
            }),
            state_rev: AtomicU64::new(1),
            meters_rev: AtomicU64::new(0),
            token_rev: AtomicU64::new(1),
            stop: AtomicBool::new(false),
            next_conn: AtomicU64::new(1),
            started: Instant::now(),
        });
        let mut threads = Vec::new();
        let i2 = inner.clone();
        threads.push(
            std::thread::Builder::new()
                .name("live-remote-accept".into())
                .spawn(move || accept_loop(listener, i2))?,
        );
        let mut osc_port = None;
        if config.osc {
            let sock = UdpSocket::bind((config.bind, addr.port().wrapping_add(1)))
                .or_else(|_| UdpSocket::bind((config.bind, 0)))?;
            sock.set_read_timeout(Some(Duration::from_millis(100)))?;
            osc_port = Some(sock.local_addr()?.port());
            let i3 = inner.clone();
            threads.push(
                std::thread::Builder::new()
                    .name("live-remote-osc".into())
                    .spawn(move || osc::run(sock, i3))?,
            );
        }
        Ok(Self {
            inner,
            addr,
            osc_port,
            threads,
        })
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn osc_port(&self) -> Option<u16> {
        self.osc_port
    }

    pub fn token(&self, role: Role) -> String {
        self.inner.lock().tokens[role_index(role)].clone()
    }

    /// Rotate a role's token; clients paired with the old one are disconnected.
    pub fn rotate_token(&self, role: Role) -> String {
        let t = new_token();
        self.inner.lock().tokens[role_index(role)] = t.clone();
        self.inner.token_rev.fetch_add(1, Ordering::SeqCst);
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
                let i2 = inner.clone();
                let _ = std::thread::Builder::new()
                    .name("live-remote-conn".into())
                    .spawn(move || {
                        let _ = handle(stream, peer, i2);
                    });
            }
            Err(_) => std::thread::sleep(POLL),
        }
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
    let (role, token, conn, client) = {
        let mut s = inner.lock();
        let role = head.param("t").and_then(|t| {
            ROLES
                .into_iter()
                .find(|r| ct_eq(&s.tokens[role_index(*r)], t))
        });
        let Some(role) = role else {
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
        (role, s.tokens[role_index(role)].clone(), conn, client)
    };
    let result = session(stream, raw, &inner, role, &token, conn, &client);
    let mut s = inner.lock();
    s.clients.remove(&conn);
    s.replies.remove(&conn);
    result
}

fn is_timeout(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(io) if matches!(io.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut))
}

/// What a client message turned into.
#[derive(Debug, PartialEq)]
pub(crate) enum Parsed {
    Subscribe { meters: bool, hz: u32 },
    Ping(Value),
    Control { id: Option<u32>, control: Control },
    Bad { id: Option<u32>, message: String },
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
    token: &str,
    conn: u64,
    client: &str,
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
        m.insert("client".into(), client.into());
    }
    send(&mut ws, hello.to_string()).map_err(io_err)?;
    let mut seen_state = 0u64;
    let mut seen_meters = inner.meters_rev.load(Ordering::SeqCst);
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
            if !ct_eq(&inner.lock().tokens[role_index(role)], token) {
                let _ = ws.close(None);
                let _ = ws.flush();
                return Ok(());
            }
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
        let pending: Vec<String> = inner
            .lock()
            .replies
            .get_mut(&conn)
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
                in_window += 1;
                if in_window > MAX_MSGS_PER_SEC {
                    if in_window == MAX_MSGS_PER_SEC + 1 {
                        let e = json!({ "type": "error", "code": "rate_limited", "message": "too many messages" });
                        send(&mut ws, e.to_string()).map_err(io_err)?;
                    }
                    continue;
                }
                match parse_client(t.as_str()) {
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
                                conn,
                                client: client.into(),
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
