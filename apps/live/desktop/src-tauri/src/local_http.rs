//! Minimal HTTP/1.1 GET against the local engine (`/api/fx`). The engine sends no CORS headers,
//! so the webview cannot fetch it directly; loopback only, fixed path, bounded response.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

const MAX_BODY: usize = 1 << 20;

pub fn get(port: u16, path: &'static str) -> Result<String, String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut s =
        TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    s.set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    s.take(MAX_BODY as u64 + 16 * 1024)
        .read_to_end(&mut raw)
        .map_err(|e| e.to_string())?;
    parse(&raw)
}

fn parse(raw: &[u8]) -> Result<String, String> {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| "malformed HTTP response".to_string())?;
    let status = head.lines().next().unwrap_or_default();
    if !status.contains(" 200 ") {
        return Err(format!("engine answered `{status}`"));
    }
    Ok(body.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ok_and_rejects_errors() {
        let ok = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n[1]";
        assert_eq!(parse(ok).unwrap(), "[1]");
        assert!(parse(b"HTTP/1.1 404 Not Found\r\n\r\nnope").is_err());
        assert!(parse(b"garbage").is_err());
    }
}
