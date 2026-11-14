//! Minimal HTTP/1.1 front (same design as `decks-remote`): one request head, static pages + JSON,
//! or the WebSocket handshake with the already-read bytes replayed.

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

pub const MAX_HEAD: usize = 8 * 1024;

/// How long a client has to send a complete request head. The socket's per-read timeout alone is
/// not a bound: a client sending one byte just before each timeout would otherwise hold a
/// connection (and its thread) open indefinitely.
pub const HEAD_DEADLINE: Duration = Duration::from_secs(5);

pub const PAGE_REMOTE: &str = include_str!("../assets/remote.html");
/// Byte copy of `packages/design-tokens/dist/tokens.plain.css` (drift-tested in `tests/assets.rs`).
pub const TOKENS_CSS: &str = include_str!("../assets/tokens.css");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub method: String,
    pub path: String,
    pub query: String,
    pub host: Option<String>,
    pub origin: Option<String>,
    pub upgrade_ws: bool,
}

impl Head {
    pub fn param(&self, name: &str) -> Option<&str> {
        self.query.split('&').find_map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (k == name).then_some(v)
        })
    }
}

pub fn parse_head(buf: &[u8]) -> Result<Head, String> {
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut req = httparse::Request::new(&mut headers);
    match req.parse(buf) {
        Ok(httparse::Status::Complete(_)) => {}
        Ok(httparse::Status::Partial) => return Err("incomplete request".into()),
        Err(e) => return Err(e.to_string()),
    }
    let target = req.path.unwrap_or("/");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let header = |name: &str| {
        req.headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(name))
            .and_then(|h| std::str::from_utf8(h.value).ok())
            .map(str::to_string)
    };
    let upgrade_ws = header("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket"));
    Ok(Head {
        method: req.method.unwrap_or("").to_string(),
        path: path.to_string(),
        query: query.to_string(),
        host: header("host"),
        origin: header("origin"),
        upgrade_ws,
    })
}

pub fn read_head(stream: &mut TcpStream) -> io::Result<Vec<u8>> {
    read_head_within(stream, HEAD_DEADLINE)
}

/// [`read_head`] with an explicit deadline (tests use a short one).
pub fn read_head_within(stream: &mut TcpStream, deadline: Duration) -> io::Result<Vec<u8>> {
    let started = Instant::now();
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        if started.elapsed() > deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "request head took too long",
            ));
        }
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed"));
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            return Ok(buf);
        }
        if buf.len() > MAX_HEAD {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "head too large"));
        }
    }
}

/// `Origin` absent (native clients) or equal to `Host` (blocks other sites driving the engine).
pub fn same_origin(head: &Head) -> bool {
    match (&head.origin, &head.host) {
        (None, _) => true,
        (Some(o), Some(h)) => {
            let o = o
                .strip_prefix("http://")
                .or_else(|| o.strip_prefix("https://"))
                .unwrap_or(o);
            o.eq_ignore_ascii_case(h)
        }
        (Some(_), None) => false,
    }
}

const SECURITY_HEADERS: &str = "Cache-Control: no-store\r\n\
X-Content-Type-Options: nosniff\r\n\
X-Frame-Options: DENY\r\n\
Referrer-Policy: no-referrer\r\n\
Content-Security-Policy: default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'\r\n";

pub fn respond(stream: &mut TcpStream, status: &str, ctype: &str, body: &str) -> io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n{SECURITY_HEADERS}\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

pub fn static_route(path: &str) -> Option<(&'static str, &'static str)> {
    match path {
        "/" | "/remote" => Some(("text/html; charset=utf-8", PAGE_REMOTE)),
        "/tokens.css" => Some(("text/css; charset=utf-8", TOKENS_CSS)),
        _ => None,
    }
}

pub struct Replay {
    prefix: Vec<u8>,
    pos: usize,
    pub inner: TcpStream,
}

impl Replay {
    pub fn new(prefix: Vec<u8>, inner: TcpStream) -> Self {
        Self {
            prefix,
            pos: 0,
            inner,
        }
    }
}

impl Read for Replay {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos < self.prefix.len() {
            let n = (self.prefix.len() - self.pos).min(buf.len());
            buf[..n].copy_from_slice(&self.prefix[self.pos..self.pos + n]);
            self.pos += n;
            return Ok(n);
        }
        self.inner.read(buf)
    }
}

impl Write for Replay {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_upgrade_and_rejects_foreign_origin() {
        let h = parse_head(
            b"GET /ws?t=abc&c=phone-1 HTTP/1.1\r\nHost: 10.0.0.2:17920\r\nUpgrade: websocket\r\nOrigin: http://10.0.0.2:17920\r\n\r\n",
        )
        .unwrap();
        assert_eq!(h.param("t"), Some("abc"));
        assert!(h.upgrade_ws && same_origin(&h));
        let evil = parse_head(
            b"GET /ws HTTP/1.1\r\nHost: 10.0.0.2:17920\r\nOrigin: https://evil.example\r\n\r\n",
        )
        .unwrap();
        assert!(!same_origin(&evil));
        assert!(static_route("/etc/passwd").is_none());
    }

    /// A client that dribbles its request head one byte at a time passes every per-read timeout,
    /// so only a total deadline stops it. Without one, a single client could hold a connection
    /// (and its thread) for as long as it wanted.
    #[test]
    fn a_dribbled_head_is_cut_at_the_deadline() {
        use std::net::{TcpListener, TcpStream};

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let mut client = TcpStream::connect(addr).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        server
            .set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();

        // One byte every 20 ms: every read succeeds, so only the total deadline can stop the loop.
        let writer = std::thread::spawn(move || {
            for _ in 0..60 {
                if client.write_all(b"X").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let t0 = Instant::now();
        let err = read_head_within(&mut server, Duration::from_millis(300)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut, "got {err}");
        assert!(
            t0.elapsed() < Duration::from_secs(2),
            "it must fail at the deadline, took {:?}",
            t0.elapsed()
        );
        drop(server);
        let _ = writer.join();
    }
}
