//! Desktop sign-in (port of MixAI Studio `apps/native`): Google refuses OAuth inside embedded webviews, so sign-in runs
//! in the SYSTEM browser via `/api/companion-auth`; a loopback-only listener receives the device token and the
//! launcher exchanges it at `/api/auth/desktop-bootstrap` for a web session cookie inside the webview.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tiny_http::{Method, Response, Server};
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::i18n::{self, Lang};

#[derive(Debug, Clone, Serialize)]
pub struct DesktopAuthResult {
    pub token: String,
    pub web_app_url: String,
}

struct PendingAuth {
    state: String,
    sender: oneshot::Sender<DesktopAuthResult>,
}

pub struct AuthState {
    port: u16,
    pending: Mutex<Option<PendingAuth>>,
}

pub fn parse_query(query: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(query.as_bytes()).into_owned().collect()
}

fn page(lang: Lang, ok: bool) -> String {
    let (mark, color, title, body) = if ok {
        ("&#10003;", "#22c55e", i18n::t(lang, "signedIn"), i18n::t(lang, "signedInBody"))
    } else {
        ("&#10007;", "#ef4444", i18n::t(lang, "signInFailed"), i18n::t(lang, "signInFailedBody"))
    };
    format!(
        "<!doctype html><html><head><meta charset=utf-8><title>MixAI Music</title><style>html,body{{margin:0;height:100%;background:#0a0a0a;color:#fafafa;font-family:-apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center}}.box{{max-width:360px;text-align:center;padding:32px}}.m{{color:{color};font-size:48px;line-height:1}}h1{{font-size:20px;margin:14px 0 6px}}p{{color:#a1a1aa;font-size:13px;margin:0}}</style></head><body><div class=box><div class=m>{mark}</div><h1>{title}</h1><p>{body}</p></div></body></html>"
    )
}

pub fn build_state() -> std::io::Result<Arc<AuthState>> {
    // Loopback only: other LAN hosts can never reach the callback.
    let server = Server::http("127.0.0.1:0").map_err(|e| std::io::Error::other(format!("listener bind failed: {e}")))?;
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        #[allow(unreachable_patterns)]
        _ => return Err(std::io::Error::other("unexpected listener address")),
    };
    let state = Arc::new(AuthState { port, pending: Mutex::new(None) });
    let shared = state.clone();
    let lang = i18n::current();
    thread::spawn(move || {
        for request in server.incoming_requests() {
            if request.method() != &Method::Get {
                let _ = request.respond(Response::from_string("method not allowed").with_status_code(405));
                continue;
            }
            let url = request.url().to_string();
            let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
            if path != "/auth/callback" {
                let _ = request.respond(Response::from_string("not found").with_status_code(404));
                continue;
            }
            let params = parse_query(query);
            let arrived = params.get("state").cloned().unwrap_or_default();
            let mut slot = shared.pending.lock().expect("auth mutex poisoned");
            let matched = matches!(slot.as_ref(), Some(p) if !arrived.is_empty() && p.state == arrived);
            let html = if matched {
                let pending = slot.take().expect("matched implies Some");
                drop(slot);
                let _ = pending.sender.send(DesktopAuthResult {
                    token: params.get("token").cloned().unwrap_or_default(),
                    web_app_url: params.get("webAppUrl").cloned().unwrap_or_default(),
                });
                page(lang, true)
            } else {
                page(lang, false)
            };
            let header = "Content-Type: text/html; charset=utf-8".parse::<tiny_http::Header>().expect("static header");
            let _ = request.respond(Response::from_string(html).with_status_code(if matched { 200 } else { 400 }).with_header(header));
        }
    });
    Ok(state)
}

fn host_info() -> (String, &'static str) {
    let hostname = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "desktop".into());
    let os = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    (hostname, os)
}

#[tauri::command]
pub async fn desktop_auth(web_app_url: String, state: State<'_, Arc<AuthState>>) -> Result<DesktopAuthResult, String> {
    let state = state.inner().clone();
    let nonce = uuid::Uuid::new_v4().to_string();
    let (hostname, os) = host_info();
    let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    let api = format!("http://127.0.0.1:{}", state.port);
    let cb = format!("http://127.0.0.1:{}/auth/callback", state.port);
    let base = web_app_url.trim_end_matches('/');
    if !(base.starts_with("https://") || base.starts_with("http://localhost:") || base.starts_with("http://127.0.0.1:")) {
        return Err("unsupported web app url".into());
    }
    let url = format!(
        "{base}/api/companion-auth?hostname={}&os={}&port={}&apiUrl={}&state={}&callbackUrl={}",
        enc(&format!("{hostname} (MixAI Music)")),
        enc(os),
        state.port,
        enc(&api),
        enc(&nonce),
        enc(&cb),
    );
    let (tx, rx) = oneshot::channel();
    *state.pending.lock().map_err(|e| e.to_string())? = Some(PendingAuth { state: nonce, sender: tx });
    open::that_detached(&url).map_err(|e| format!("failed to open browser: {e}"))?;
    match timeout(Duration::from_secs(300), rx).await {
        Ok(Ok(r)) => Ok(r),
        Ok(Err(_)) => Err("auth listener dropped".into()),
        Err(_) => {
            if let Ok(mut slot) = state.pending.lock() {
                slot.take();
            }
            Err("timed out waiting for sign-in".into())
        }
    }
}

#[tauri::command]
pub fn desktop_auth_cancel(state: State<'_, Arc<AuthState>>) -> Result<(), String> {
    state.pending.lock().map_err(|e| e.to_string())?.take();
    Ok(())
}

/// Base URL of the web UI: `MMO_WEB_APP_URL` env, `http://localhost:13789` in debug builds, else music.mixai.ro.
pub fn web_app_url() -> String {
    if let Ok(v) = std::env::var("MMO_WEB_APP_URL") {
        let v = v.trim().trim_end_matches('/').to_string();
        if !v.is_empty() {
            return v;
        }
    }
    if cfg!(debug_assertions) { "http://localhost:13789".into() } else { "https://music.mixai.ro".into() }
}

#[tauri::command]
pub fn get_web_app_url() -> String {
    web_app_url()
}

/// `host:port` of a web app URL (default port by scheme), `None` for anything else.
pub fn host_port(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    let host = u.host_str()?;
    let port = u.port_or_known_default()?;
    Some(format!("{host}:{port}"))
}

/// Offline check for the launcher: DNS + TCP connect to the web host within 5 s. A fetch from the launcher origin
/// cannot do this (the web app sends `Cross-Origin-Resource-Policy: same-site`, blocked even in no-cors mode).
#[tauri::command]
pub async fn web_reachable() -> bool {
    let Some(target) = host_port(&web_app_url()) else { return false };
    tauri::async_runtime::spawn_blocking(move || {
        use std::net::{TcpStream, ToSocketAddrs};
        let Ok(addrs) = target.to_socket_addrs() else { return false };
        addrs.take(4).any(|a| TcpStream::connect_timeout(&a, Duration::from_secs(5)).is_ok())
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_decodes_the_callback_query() {
        let q = parse_query("state=a%20b&token=t%2B1&webAppUrl=https%3A%2F%2Fmusic.mixai.ro&x");
        assert_eq!(q.get("state").map(String::as_str), Some("a b"));
        assert_eq!(q.get("token").map(String::as_str), Some("t+1"));
        assert_eq!(q.get("webAppUrl").map(String::as_str), Some("https://music.mixai.ro"));
    }

    #[test]
    fn callback_pages_are_localised() {
        assert!(page(Lang::Ro, true).contains("Te-ai autentificat"));
        assert!(page(Lang::En, false).contains("Sign-in failed"));
    }

    #[test]
    fn host_port_uses_the_scheme_default() {
        assert_eq!(host_port("https://music.mixai.ro").as_deref(), Some("music.mixai.ro:443"));
        assert_eq!(host_port("http://localhost:13789").as_deref(), Some("localhost:13789"));
        assert_eq!(host_port("not a url"), None);
    }
}
