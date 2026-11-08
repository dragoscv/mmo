//! LAN servers for the remote web UI (D59, WP17-97 / WP17-100).
//!
//! music.mixai.ro is served over https, so the page cannot fetch an `http://192.168.x:17899` MMO Server (mixed
//! content). The shell runs a tiny loopback proxy: `desktop_lan_proxy {target}` registers an http LAN server and
//! returns `http://127.0.0.1:<port>/s/<id>`, which the page uses as the server base URL (loopback counts as a
//! trustworthy origin). Requests are forwarded verbatim (method, path, query, auth headers, Range) and streamed back.
//! `desktop_lan_servers` lists servers announced with mDNS (`_mmo-companion._tcp`), like the phone apps.
//!
//! Safety: only private/link-local/`.local` http targets are accepted, ids are derived from the target (stable across
//! launches) and persisted next to the app data, the proxy binds 127.0.0.1 only and answers CORS solely for the
//! MixAI web origins. WebSockets (hub) are not proxied: remote control is unavailable for LAN-proxied servers.

use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tiny_http::{Header, Method, Response, Server, StatusCode};
use url::Url;

/// Preferred port so saved base URLs keep working after a restart; falls back to a random free port.
const PREFERRED_PORT: u16 = 17_891;
const ALLOWED_ORIGINS: [&str; 3] = ["https://music.mixai.ro", "https://tv.mixai.ro", "http://localhost:13789"];
const HOP_BY_HOP: [&str; 6] = ["connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "host"];

pub struct LanState {
    port: u16,
    targets: Arc<Mutex<HashMap<String, String>>>,
    file: Option<PathBuf>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct LanServer {
    pub name: String,
    pub url: String,
}

/// `http://192.168.1.10:17899/x?y` → `http://192.168.1.10:17899` when it is an http server on the local network.
pub fn normalize_target(raw: &str) -> Option<String> {
    let u = Url::parse(raw.trim()).ok()?;
    if u.scheme() != "http" || !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    let host = u.host_str()?.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    let local = match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        Ok(IpAddr::V6(v6)) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80,
        Err(_) => host.ends_with(".local") || (!host.contains('.') && !host.is_empty()),
    };
    if !local {
        return None;
    }
    let port = u.port().unwrap_or(17_899);
    let h = if host.contains(':') { format!("[{host}]") } else { host };
    Some(format!("http://{h}:{port}"))
}

/// Stable id for a target (FNV-1a 64, hex): the same server keeps the same proxy URL across launches.
pub fn target_id(target: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in target.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// `/s/<id>/rest/x?y` → (`id`, `/rest/x?y`).
pub fn split_proxy_path(url: &str) -> Option<(&str, String)> {
    let rest = url.strip_prefix("/s/")?;
    let (id, tail) = match rest.find(['/', '?']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let tail = if tail.is_empty() { "/".to_string() } else if tail.starts_with('?') { format!("/{tail}") } else { tail.to_string() };
    Some((id, tail))
}

fn load_targets(file: &Option<PathBuf>) -> HashMap<String, String> {
    let Some(f) = file else { return HashMap::new() };
    let Ok(s) = std::fs::read_to_string(f) else { return HashMap::new() };
    let map: HashMap<String, String> = serde_json::from_str(&s).unwrap_or_default();
    // Re-validate: never trust the file more than the command.
    map.into_iter().filter(|(id, t)| normalize_target(t).as_deref() == Some(t.as_str()) && target_id(t) == *id).collect()
}

pub fn start<R: Runtime>(app: &AppHandle<R>) -> LanState {
    let file = app.path().app_data_dir().ok().map(|d| d.join("lan-proxy.json"));
    start_on(PREFERRED_PORT, file)
}

fn start_on(preferred: u16, file: Option<PathBuf>) -> LanState {
    let targets = Arc::new(Mutex::new(load_targets(&file)));
    let server = Server::http(SocketAddr::from((Ipv4Addr::LOCALHOST, preferred)))
        .or_else(|_| Server::http(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))));
    let Ok(server) = server else {
        return LanState { port: 0, targets, file };
    };
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    let map = targets.clone();
    std::thread::Builder::new()
        .name("lan-proxy".into())
        .spawn(move || {
            let agent: ureq::Agent = ureq::Agent::config_builder()
                .http_status_as_error(false)
                .max_redirects(0)
                .timeout_connect(Some(Duration::from_secs(5)))
                .build()
                .into();
            for req in server.incoming_requests() {
                let agent = agent.clone();
                let map = map.clone();
                std::thread::spawn(move || handle(req, &agent, &map));
            }
        })
        .ok();
    LanState { port, targets, file }
}

fn cors_headers(origin: Option<&str>) -> Vec<Header> {
    let mut v = Vec::new();
    if let Some(o) = origin.filter(|o| ALLOWED_ORIGINS.contains(o)) {
        let mut push = |k: &str, val: &str| {
            if let Ok(h) = Header::from_bytes(k.as_bytes(), val.as_bytes()) {
                v.push(h);
            }
        };
        push("Access-Control-Allow-Origin", o);
        push("Vary", "Origin");
        push("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
        push("Access-Control-Allow-Headers", "content-type, range, x-device-token, x-user-id, x-profile-token, authorization");
        push("Access-Control-Expose-Headers", "content-range, content-length, accept-ranges, etag, content-type");
        push("Access-Control-Allow-Private-Network", "true");
        push("Access-Control-Max-Age", "600");
    }
    v
}

fn handle(mut req: tiny_http::Request, agent: &ureq::Agent, map: &Arc<Mutex<HashMap<String, String>>>) {
    let origin = req.headers().iter().find(|h| h.field.equiv("origin")).map(|h| h.value.as_str().to_string());
    let cors = cors_headers(origin.as_deref());
    if *req.method() == Method::Options {
        let _ = req.respond(cors.into_iter().fold(Response::empty(StatusCode(204)), |r, h| r.with_header(h)));
        return;
    }
    let Some((id, tail)) = split_proxy_path(req.url()).map(|(i, t)| (i.to_string(), t)) else {
        let _ = req.respond(Response::empty(StatusCode(404)));
        return;
    };
    let Some(target) = map.lock().ok().and_then(|m| m.get(&id).cloned()) else {
        let _ = req.respond(cors.into_iter().fold(Response::empty(StatusCode(404)), |r, h| r.with_header(h)));
        return;
    };
    let mut builder = ureq::http::Request::builder().method(req.method().as_str()).uri(format!("{target}{tail}"));
    for h in req.headers() {
        let k = h.field.as_str().as_str().to_ascii_lowercase();
        if HOP_BY_HOP.contains(&k.as_str()) || k == "origin" || k == "referer" {
            continue;
        }
        builder = builder.header(h.field.as_str().as_str(), h.value.as_str());
    }
    let mut body = Vec::new();
    let _ = req.as_reader().take(16 * 1024 * 1024).read_to_end(&mut body);
    let sent = if body.is_empty() { builder.body(()).map(|r| agent.run(r)) } else { builder.body(body).map(|r| agent.run(r)) };
    let resp = match sent {
        Ok(Ok(r)) => r,
        _ => {
            let _ = req.respond(cors.into_iter().fold(Response::empty(StatusCode(502)), |r, h| r.with_header(h)));
            return;
        }
    };
    let status = resp.status().as_u16();
    let len = resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok());
    let mut headers: Vec<Header> = resp
        .headers()
        .iter()
        .filter(|(k, _)| {
            let k = k.as_str();
            !HOP_BY_HOP.contains(&k) && !k.starts_with("access-control-")
        })
        .filter_map(|(k, v)| Header::from_bytes(k.as_str().as_bytes(), v.as_bytes()).ok())
        .collect();
    headers.extend(cors);
    let reader = resp.into_body().into_reader();
    let _ = req.respond(Response::new(StatusCode(status), headers, reader, len, None));
}

/// Registers an http LAN server and returns the loopback URL the page should use for it.
#[tauri::command]
pub fn desktop_lan_proxy(state: tauri::State<'_, LanState>, target: String) -> Result<String, String> {
    if state.port == 0 {
        return Err("proxy unavailable".into());
    }
    let t = normalize_target(&target).ok_or("only http servers on the local network")?;
    let id = target_id(&t);
    let mut map = state.targets.lock().map_err(|e| e.to_string())?;
    if map.get(&id) != Some(&t) {
        map.insert(id.clone(), t);
        if let Some(f) = &state.file {
            if let Some(dir) = f.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(f, serde_json::to_string(&*map).unwrap_or_default());
        }
    }
    Ok(format!("http://127.0.0.1:{}/s/{id}", state.port))
}

/// MMO Servers announced on the local network (mDNS `_mmo-companion._tcp`), browsed for ~2.5 s.
#[tauri::command]
pub async fn desktop_lan_servers() -> Vec<LanServer> {
    tauri::async_runtime::spawn_blocking(|| browse(Duration::from_millis(2500))).await.unwrap_or_default()
}

fn browse(window: Duration) -> Vec<LanServer> {
    let Ok(mdns) = mdns_sd::ServiceDaemon::new() else { return Vec::new() };
    let Ok(rx) = mdns.browse("_mmo-companion._tcp.local.") else { return Vec::new() };
    let deadline = Instant::now() + window;
    let mut out: Vec<LanServer> = Vec::new();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        let Ok(ev) = rx.recv_timeout(left) else { break };
        if let mdns_sd::ServiceEvent::ServiceResolved(info) = ev {
            let port = info.get_port();
            let Some(ip) = info.get_addresses_v4().into_iter().find(|a| a.is_private()) else { continue };
            let url = format!("http://{ip}:{port}");
            let name = info
                .get_property_val_str("name")
                .map(str::to_string)
                .unwrap_or_else(|| info.get_fullname().split('.').next().unwrap_or("MMO Server").to_string());
            if !out.iter().any(|s| s.url == url) {
                out.push(LanServer { name, url });
            }
        }
    }
    let _ = mdns.shutdown();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_local_http_targets() {
        assert_eq!(normalize_target("http://192.168.1.10:17899/x?y").as_deref(), Some("http://192.168.1.10:17899"));
        assert_eq!(normalize_target("http://10.0.0.5").as_deref(), Some("http://10.0.0.5:17899"));
        assert_eq!(normalize_target("http://nas.local:18000").as_deref(), Some("http://nas.local:18000"));
        assert_eq!(normalize_target("http://[fd00::1]:17899").as_deref(), Some("http://[fd00::1]:17899"));
        assert_eq!(normalize_target("https://192.168.1.10"), None);
        assert_eq!(normalize_target("http://8.8.8.8:17899"), None);
        assert_eq!(normalize_target("http://example.com"), None);
        assert_eq!(normalize_target("http://u:p@192.168.1.10"), None);
        assert_eq!(normalize_target("file:///etc/passwd"), None);
    }

    #[test]
    fn ids_are_stable_hex() {
        let a = target_id("http://192.168.1.10:17899");
        assert_eq!(a, target_id("http://192.168.1.10:17899"));
        assert_ne!(a, target_id("http://192.168.1.11:17899"));
        assert_eq!(a.len(), 16);
        assert!(a.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn splits_proxy_paths() {
        assert_eq!(split_proxy_path("/s/abc123/rest/stream.view?id=1"), Some(("abc123", "/rest/stream.view?id=1".to_string())));
        assert_eq!(split_proxy_path("/s/abc123?x=1"), Some(("abc123", "/?x=1".to_string())));
        assert_eq!(split_proxy_path("/s/abc123"), Some(("abc123", "/".to_string())));
        assert_eq!(split_proxy_path("/s/zz/x"), None);
        assert_eq!(split_proxy_path("/x/abc"), None);
    }

    #[test]
    fn cors_only_for_mixai_origins() {
        assert!(cors_headers(Some("https://music.mixai.ro")).iter().any(|h| h.field.equiv("access-control-allow-origin")));
        assert!(cors_headers(Some("https://evil.example")).is_empty());
        assert!(cors_headers(None).is_empty());
    }

    #[test]
    fn proxies_requests_with_headers_status_and_cors() {
        // Upstream: echoes the token header and path, answers 206 with a Range-style header.
        let up = Server::http("127.0.0.1:0").expect("upstream");
        let up_port = up.server_addr().to_ip().expect("ip").port();
        std::thread::spawn(move || {
            for req in up.incoming_requests().take(2) {
                let tok = req.headers().iter().find(|h| h.field.equiv("x-device-token")).map(|h| h.value.to_string()).unwrap_or_default();
                let body = format!("{} {}", req.url(), tok);
                let r = Response::from_string(body)
                    .with_status_code(206)
                    .with_header(Header::from_bytes("Content-Range", "bytes 0-3/10").expect("h"));
                let _ = req.respond(r);
            }
        });
        let st = start_on(0, None);
        let target = format!("http://127.0.0.1:{up_port}");
        let id = target_id(&target);
        st.targets.lock().expect("lock").insert(id.clone(), target);
        let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
        let mut r = agent
            .get(format!("http://127.0.0.1:{}/s/{id}/rest/stream.view?id=7", st.port))
            .header("x-device-token", "secret-token")
            .header("origin", "https://music.mixai.ro")
            .call()
            .expect("proxy call");
        assert_eq!(r.status().as_u16(), 206);
        assert_eq!(r.headers().get("content-range").and_then(|v| v.to_str().ok()), Some("bytes 0-3/10"));
        assert_eq!(r.headers().get("access-control-allow-origin").and_then(|v| v.to_str().ok()), Some("https://music.mixai.ro"));
        assert_eq!(r.body_mut().read_to_string().expect("body"), "/rest/stream.view?id=7 secret-token");
        // Unknown id → 404, never forwarded.
        let r2 = agent.get(format!("http://127.0.0.1:{}/s/deadbeef/x", st.port)).call().expect("404 call");
        assert_eq!(r2.status().as_u16(), 404);
    }

    /// Live check against a real MMO Server on the LAN: `MX_LAN_TARGET=http://192.168.x.y:17899 cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn live_lan_pair_info() {
        let target = normalize_target(&std::env::var("MX_LAN_TARGET").expect("MX_LAN_TARGET")).expect("local target");
        let st = start_on(0, None);
        let id = target_id(&target);
        st.targets.lock().expect("lock").insert(id.clone(), target);
        let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
        let mut r = agent.get(format!("http://127.0.0.1:{}/s/{id}/pair/info", st.port)).header("origin", "https://music.mixai.ro").call().expect("call");
        let body = r.body_mut().read_to_string().expect("body");
        println!("LIVE {} {}", r.status(), body);
        assert_eq!(r.status().as_u16(), 200);
        assert!(body.contains("pairingSupported"));
        let servers = browse(Duration::from_millis(3000));
        println!("MDNS {servers:?}");
    }
}
