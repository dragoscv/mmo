// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod render_jobs;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tiny_http::{Method, Response, Server};
use tokio::sync::oneshot;
use tokio::time::timeout;

/// Result delivered by the local HTTP listener back to the awaiting
/// IPC command after the user finishes signing in via the system
/// browser. Mirrors the payload the Electron companion's
/// `/auth/callback` endpoint receives from `/api/companion-auth`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopAuthResult {
    pub token: String,
    pub device_id: String,
    pub user_name: String,
    pub user_email: String,
    pub user_image: String,
    pub web_app_url: String,
}

struct PendingAuth {
    state: String,
    sender: oneshot::Sender<DesktopAuthResult>,
}

pub struct AuthState {
    pub port: u16,
    pending: Mutex<Option<PendingAuth>>,
}

fn parse_query(query: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in query.split('&').filter(|s| !s.is_empty()) {
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("");
        let v = it.next().unwrap_or("");
        out.insert(percent_decode(k), percent_decode(v));
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

const CALLBACK_HTML_SUCCESS: &str = r#"<!doctype html><html><head><meta charset=utf-8><title>MMO</title>
<style>html,body{margin:0;height:100%;background:#0a0a0a;color:#fafafa;font-family:-apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center}
.box{max-width:340px;text-align:center;padding:32px}.ok{color:#22c55e;font-size:48px;line-height:1}h1{font-size:20px;margin:14px 0 6px}p{color:#a1a1aa;font-size:13px;margin:0}</style></head>
<body><div class=box><div class=ok>&#10003;</div><h1>You're signed in</h1><p>Return to the MMO app — you can close this tab.</p></div></body></html>"#;

const CALLBACK_HTML_ERROR: &str = r#"<!doctype html><html><head><meta charset=utf-8><title>MMO</title>
<style>html,body{margin:0;height:100%;background:#0a0a0a;color:#fafafa;font-family:-apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center}
.box{max-width:340px;text-align:center;padding:32px}.err{color:#ef4444;font-size:48px;line-height:1}h1{font-size:20px;margin:14px 0 6px}p{color:#a1a1aa;font-size:13px;margin:0}</style></head>
<body><div class=box><div class=err>&#10007;</div><h1>Sign-in failed</h1><p>The state didn't match an in-flight request. Try again from the app.</p></div></body></html>"#;

fn build_state() -> std::io::Result<Arc<AuthState>> {
    // Loopback-only: bind to 127.0.0.1 so other hosts on the LAN can
    // never hit our callback even by guessing the port.
    let server = Server::http("127.0.0.1:0")
        .map_err(|e| std::io::Error::other(format!("listener bind failed: {e}")))?;
    let tiny_http::ListenAddr::IP(addr) = server.server_addr();
    let port = addr.port();
    let state = Arc::new(AuthState {
        port,
        pending: Mutex::new(None),
    });
    let state_for_thread = state.clone();
    thread::spawn(move || {
        for request in server.incoming_requests() {
            if request.method() != &Method::Get {
                let _ = request.respond(
                    Response::from_string("method not allowed").with_status_code(405),
                );
                continue;
            }
            let url = request.url().to_string();
            let (path, query) = match url.split_once('?') {
                Some((p, q)) => (p.to_string(), q.to_string()),
                None => (url.clone(), String::new()),
            };
            if path != "/auth/callback" {
                let _ = request.respond(Response::from_string("not found").with_status_code(404));
                continue;
            }

            let params = parse_query(&query);
            let arrived_state = params.get("state").cloned().unwrap_or_default();
            let mut slot = state_for_thread.pending.lock().expect("auth state mutex poisoned");
            let matched = matches!(
                slot.as_ref(),
                Some(p) if p.state == arrived_state && !arrived_state.is_empty()
            );

            if matched {
                let pending = slot.take().expect("matched implies Some");
                drop(slot);
                let payload = DesktopAuthResult {
                    token: params.get("token").cloned().unwrap_or_default(),
                    device_id: params.get("deviceId").cloned().unwrap_or_default(),
                    user_name: params.get("userName").cloned().unwrap_or_default(),
                    user_email: params.get("userEmail").cloned().unwrap_or_default(),
                    user_image: params.get("userImage").cloned().unwrap_or_default(),
                    web_app_url: params.get("webAppUrl").cloned().unwrap_or_default(),
                };
                let _ = pending.sender.send(payload);
                let resp = Response::from_string(CALLBACK_HTML_SUCCESS).with_header(
                    "Content-Type: text/html; charset=utf-8"
                        .parse::<tiny_http::Header>()
                        .unwrap(),
                );
                let _ = request.respond(resp);
            } else {
                let resp = Response::from_string(CALLBACK_HTML_ERROR)
                    .with_status_code(400)
                    .with_header(
                        "Content-Type: text/html; charset=utf-8"
                            .parse::<tiny_http::Header>()
                            .unwrap(),
                    );
                let _ = request.respond(resp);
            }
        }
    });
    Ok(state)
}

#[tauri::command]
async fn desktop_auth(
    web_app_url: String,
    state: State<'_, Arc<AuthState>>,
) -> Result<DesktopAuthResult, String> {
    let state = state.inner().clone();
    let auth_state = uuid::Uuid::new_v4().to_string();

    let host = sys_host_info();
    let api_url = format!("http://127.0.0.1:{}", state.port);
    let callback_url = format!("http://127.0.0.1:{}/auth/callback", state.port);

    let base = web_app_url.trim_end_matches('/');
    let enc = |s: &str| {
        url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>()
    };
    let url = format!(
        "{base}/api/companion-auth?hostname={hostname}&os={os}&port={port}&apiUrl={api}&state={st}&callbackUrl={cb}",
        hostname = enc(&host.hostname),
        os = enc(&host.os),
        port = state.port,
        api = enc(&api_url),
        st = enc(&auth_state),
        cb = enc(&callback_url),
    );

    let (tx, rx) = oneshot::channel();
    {
        let mut slot = state.pending.lock().map_err(|e| e.to_string())?;
        *slot = Some(PendingAuth {
            state: auth_state.clone(),
            sender: tx,
        });
    }

    // Open in the system browser. We intentionally do NOT navigate
    // the Tauri WebView — the whole point is to keep sign-in out of
    // the embedded webview (mirrors the Electron companion behaviour).
    open::that_detached(&url).map_err(|e| format!("failed to open browser: {e}"))?;

    match timeout(Duration::from_secs(300), rx).await {
        Ok(Ok(result)) => Ok(result),
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
fn desktop_auth_cancel(state: State<'_, Arc<AuthState>>) -> Result<(), String> {
    let mut slot = state.pending.lock().map_err(|e| e.to_string())?;
    slot.take();
    Ok(())
}

/// Resolve the web app's base URL the launcher should target.
///
/// Precedence:
///   1. `MMO_WEB_APP_URL` env var (lets the dev task override at will).
///   2. `http://localhost:13789` in debug builds (matches `pnpm dev`).
///   3. `https://muzicai.ro` in release builds.
#[tauri::command]
fn get_web_app_url() -> String {
    if let Ok(v) = std::env::var("MMO_WEB_APP_URL") {
        let trimmed = v.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    if cfg!(debug_assertions) {
        "http://localhost:13789".to_string()
    } else {
        "https://muzicai.ro".to_string()
    }
}

struct HostInfo {
    hostname: String,
    os: String,
}

fn sys_host_info() -> HostInfo {
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "desktop".to_string());
    let os = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
    .to_string();
    HostInfo { hostname, os }
}

pub fn run() {
    let auth_state = build_state().expect("failed to start desktop auth listener");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(auth_state)
        .invoke_handler(tauri::generate_handler![
            desktop_auth,
            desktop_auth_cancel,
            get_web_app_url,
            render_jobs::enqueue_render,
            render_jobs::list_render_jobs,
            render_jobs::get_render_job,
            render_jobs::update_render_job,
            render_jobs::remove_render_job,
            render_jobs::clear_render_jobs,
            render_jobs::retry_render_job,
            render_jobs::open_render_output,
        ])
        .setup(|app| {
            let handle = app.handle();
            let jobs = render_jobs::init(handle)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            app.manage(jobs);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running MMO native shell");
}
