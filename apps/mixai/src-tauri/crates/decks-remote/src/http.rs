//! Minimal HTTP/1.1 front: read one request head, route static pages, or hand the connection to
//! the WebSocket handshake with the already-read bytes replayed.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, TcpStream};
use std::time::{Duration, Instant};

/// Largest accepted request head.
pub const MAX_HEAD: usize = 8 * 1024;

pub const PAGE_REMOTE: &str = include_str!("../assets/remote.html");
pub const PAGE_PARTY: &str = include_str!("../assets/party.html");
/// The stream overlay ("Now playing" for OBS, WP19-59).
pub const PAGE_NOW: &str = include_str!("../assets/now.html");
/// Path of the stream overlay page.
pub const OVERLAY_PATH: &str = "/now";
/// Copy of `packages/design-tokens/dist/tokens.plain.css` (drift-tested in `tests/assets.rs`).
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
    /// Value of a query parameter (no percent-decoding: tokens and client ids are plain ASCII).
    pub fn param(&self, name: &str) -> Option<&str> {
        self.query.split('&').find_map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (k == name).then_some(v)
        })
    }
}

/// Parse a complete request head (`buf` ends with CRLFCRLF).
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

/// Read until the end of the request head. Returns the raw bytes (head plus anything after it).
/// The WHOLE head must arrive within `within`: a peer that trickles one byte at a time cannot
/// hold the connection (and its thread) longer than that.
pub fn read_head(stream: &mut TcpStream, within: Duration) -> io::Result<Vec<u8>> {
    let deadline = Instant::now() + within;
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "request head"));
        }
        stream.set_read_timeout(Some(left))?;
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

/// `Origin` must be absent (native clients) or name the same host as `Host` (blocks other web
/// pages from driving the remote through a visitor's browser).
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

/// Whether a `Host` header names the server by an ADDRESS: an IPv4 literal, a bracketed IPv6
/// literal or `localhost`, each with an optional port. Everything else is refused, a missing
/// header included.
///
/// Why: [`same_origin`] compares `Origin` with `Host`, and both are whatever name the browser
/// was given. A page on another site can point its own DNS name at this computer ("DNS
/// rebinding"); its requests then arrive here with that name in both headers. The pairing
/// addresses and the stream overlay address always name an IP address, so a real phone, a
/// second screen or OBS never sends anything else.
pub fn host_is_address(host: Option<&str>) -> bool {
    let Some(host) = host else {
        return false;
    };
    // Digits only (`"+80".parse::<u16>()` is `Ok`), at most 65535.
    let port_ok = |p: &str| {
        !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u16>().is_ok()
    };
    if let Some(rest) = host.strip_prefix('[') {
        // `[v6]` or `[v6]:port`.
        let Some((v6, after)) = rest.split_once(']') else {
            return false;
        };
        return v6.parse::<Ipv6Addr>().is_ok()
            && (after.is_empty() || after.strip_prefix(':').is_some_and(port_ok));
    }
    let name = match host.rsplit_once(':') {
        Some((name, port)) if port_ok(port) => name,
        Some(_) => return false,
        None => host,
    };
    name.eq_ignore_ascii_case("localhost") || name.parse::<Ipv4Addr>().is_ok()
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

/// Static routes. `None` = not a static route.
pub fn static_route(path: &str) -> Option<(&'static str, &'static str)> {
    match path {
        "/" | "/remote" => Some(("text/html; charset=utf-8", PAGE_REMOTE)),
        "/party" => Some(("text/html; charset=utf-8", PAGE_PARTY)),
        OVERLAY_PATH => Some(("text/html; charset=utf-8", PAGE_NOW)),
        "/tokens.css" => Some(("text/css; charset=utf-8", TOKENS_CSS)),
        _ => None,
    }
}

/// A stream that first yields bytes already read, then reads from `inner`.
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
    fn parses_ws_upgrade_with_query() {
        let h = parse_head(
            b"GET /ws?t=abc&c=phone-1 HTTP/1.1\r\nHost: 10.0.0.2:47321\r\nUpgrade: websocket\r\nOrigin: http://10.0.0.2:47321\r\n\r\n",
        )
        .unwrap();
        assert_eq!(h.path, "/ws");
        assert_eq!(h.param("t"), Some("abc"));
        assert_eq!(h.param("c"), Some("phone-1"));
        assert_eq!(h.param("x"), None);
        assert!(h.upgrade_ws);
        assert!(same_origin(&h));
    }

    #[test]
    fn foreign_origin_is_rejected() {
        let h = parse_head(
            b"GET /ws HTTP/1.1\r\nHost: 10.0.0.2:47321\r\nOrigin: https://evil.example\r\n\r\n",
        )
        .unwrap();
        assert!(!same_origin(&h));
        let native = parse_head(b"GET /ws HTTP/1.1\r\nHost: 10.0.0.2:47321\r\n\r\n").unwrap();
        assert!(same_origin(&native));
    }

    #[test]
    fn only_an_address_or_localhost_is_a_host_this_server_answers_to() {
        // What a phone, a second screen and OBS send: the address they were given.
        for ok in [
            "127.0.0.1",
            "127.0.0.1:47831",
            "192.168.1.20:47831",
            "10.0.0.2:1",
            "10.0.0.2:65535",
            "localhost",
            "localhost:47831",
            "LocalHost:47831",
            "[::1]",
            "[::1]:47831",
            "[fe80::1c2a:3bff:fe4d:5e6f]:47831",
            "[::ffff:192.168.1.20]:80",
        ] {
            assert!(host_is_address(Some(ok)), "{ok}");
        }
        // A name is never an address, however much it looks like one.
        for name in [
            "evil.example",
            "evil.example:47831",
            "my-pc.local:47831",
            "my-pc",
            "127.0.0.1.evil.example",
            "127.0.0.1.evil.example:47831",
            "localhost.evil.example",
            "localhost.evil.example:47831",
            "notlocalhost",
            "localhost.",
            "xn--80ak6aa92e.com",
        ] {
            assert!(!host_is_address(Some(name)), "{name}");
        }
        // No header at all, an empty one, and forms no browser sends for an address.
        assert!(!host_is_address(None));
        for odd in [
            "",
            " ",
            ":47831",
            "127.0.0.1:",
            "127.0.0.1:65536",
            "127.0.0.1:123456",
            "127.0.0.1:-1",
            "127.0.0.1:+80",
            "127.0.0.1:80a",
            "127.0.0.1:47831:1",
            "127.0.0.1 ",
            "127.1",
            "2130706433",
            "0x7f.0.0.1",
            "0127.0.0.1",
            "256.0.0.1",
            "::1",
            "::1:47831",
            "[::1",
            "::1]",
            "[::1]47831",
            "[::1]:",
            "[::1]:65536",
            "[::1]x",
            "[127.0.0.1]",
            "[localhost]",
            "[fe80::1%eth0]",
            "[]",
            "user@127.0.0.1",
            "127.0.0.1/path",
            "127.0.0.1,evil.example",
        ] {
            assert!(!host_is_address(Some(odd)), "{odd:?}");
        }
        // The header as the parser hands it over: a rebinding page passes the origin check
        // (its `Origin` and its `Host` are the same name) and is stopped by this one.
        let rebound = parse_head(
            b"GET /ws?t=abc HTTP/1.1\r\nHost: evil.example:47831\r\nUpgrade: websocket\r\nOrigin: http://evil.example:47831\r\n\r\n",
        )
        .unwrap();
        assert!(same_origin(&rebound));
        assert!(!host_is_address(rebound.host.as_deref()));
        let phone = parse_head(
            b"GET /ws?t=abc HTTP/1.1\r\nHost: 192.168.1.20:47831\r\nUpgrade: websocket\r\nOrigin: http://192.168.1.20:47831\r\n\r\n",
        )
        .unwrap();
        assert!(same_origin(&phone) && host_is_address(phone.host.as_deref()));
        let no_host = parse_head(b"GET /health HTTP/1.1\r\n\r\n").unwrap();
        assert!(!host_is_address(no_host.host.as_deref()));
    }

    #[test]
    fn static_routes_cover_pages_and_tokens() {
        assert!(static_route("/").unwrap().1.contains("<html"));
        assert!(static_route("/party").unwrap().1.contains("<html"));
        let (ctype, now) = static_route("/now").unwrap();
        assert_eq!(ctype, "text/html; charset=utf-8");
        assert!(now.contains("<html") && now.contains("on_air"));
        assert_ne!(now, static_route("/party").unwrap().1);
        // Only the exact path: no prefix, no trailing slash, no other case.
        for not_a_page in ["/now/", "/now.html", "/NOW", "/nowhere", "/no"] {
            assert!(static_route(not_a_page).is_none(), "{not_a_page}");
        }
        assert!(
            static_route("/tokens.css")
                .unwrap()
                .1
                .contains("--background")
        );
        assert!(static_route("/etc/passwd").is_none());
    }

    #[test]
    fn a_head_that_trickles_in_is_cut_at_the_deadline() {
        use std::net::TcpListener;

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        // One byte every 40 ms, never the end of the head: each read succeeds, so a per-read
        // timeout alone would never fire.
        let slow = std::thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            for _ in 0..100 {
                if s.write_all(b"x").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        });
        let (mut peer, _) = listener.accept().unwrap();
        let start = Instant::now();
        let err = read_head(&mut peer, Duration::from_millis(300)).unwrap_err();
        let took = start.elapsed();
        assert!(
            matches!(
                err.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            ),
            "{err:?}"
        );
        assert!(
            took >= Duration::from_millis(250) && took < Duration::from_secs(2),
            "{took:?}"
        );
        drop(peer);
        slow.join().unwrap();
        // A whole head inside the deadline is read as before.
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.write_all(b"GET /health HTTP/1.1\r\nHost: x\r\n\r\n")
            .unwrap();
        let (mut peer, _) = listener.accept().unwrap();
        let raw = read_head(&mut peer, Duration::from_secs(5)).unwrap();
        assert_eq!(parse_head(&raw).unwrap().path, "/health");
    }
}
