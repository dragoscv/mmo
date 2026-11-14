//! Engine sidecar lifecycle: `mixai-live-engine` (bundled via `bundle.externalBin`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

const SIDECAR: &str = "mixai-live-engine";
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const LATENCY_TIMEOUT: Duration = Duration::from_secs(25);
/// The routes command reads driver properties; it never waits for audio.
const ROUTES_TIMEOUT: Duration = Duration::from_secs(5);

/// Audio + server settings for `serve` / `latency` (mirrors the CLI flags).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineConfig {
    #[serde(default)]
    pub host: Option<String>,
    pub input: String,
    pub output: String,
    #[serde(default = "default_rate")]
    pub rate: u32,
    #[serde(default = "default_buffer")]
    pub buffer: u32,
    #[serde(default = "default_in_ch")]
    pub input_channels: Vec<u16>,
    #[serde(default = "default_main")]
    pub main: [u16; 2],
    #[serde(default)]
    pub monitor: Option<[u16; 2]>,
    #[serde(default = "default_preset")]
    pub preset: String,
    #[serde(default)]
    pub lan: bool,
    #[serde(default = "default_port")]
    pub port: u16,
}

fn default_rate() -> u32 {
    48_000
}
fn default_buffer() -> u32 {
    128
}
fn default_in_ch() -> Vec<u16> {
    vec![0]
}
fn default_main() -> [u16; 2] {
    [0, 1]
}
fn default_preset() -> String {
    "Natural Vocal".into()
}
fn default_port() -> u16 {
    17920
}

/// Free-text values become CLI arguments: refuse anything clap could read as a flag.
fn safe_value(v: &str, what: &str) -> Result<(), String> {
    if v.is_empty() || v.len() > 200 || v.starts_with('-') || v.chars().any(char::is_control) {
        return Err(format!("invalid {what}"));
    }
    Ok(())
}

fn join(ch: &[u16]) -> String {
    ch.iter().map(u16::to_string).collect::<Vec<_>>().join(",")
}

impl EngineConfig {
    pub fn validate(&self) -> Result<(), String> {
        if let Some(h) = &self.host {
            safe_value(h, "host")?;
        }
        safe_value(&self.input, "input device")?;
        safe_value(&self.output, "output device")?;
        safe_value(&self.preset, "preset")?;
        if !(8_000..=192_000).contains(&self.rate) {
            return Err("invalid sample rate".into());
        }
        if !(16..=4096).contains(&self.buffer) {
            return Err("invalid buffer size".into());
        }
        if self.input_channels.is_empty() || self.input_channels.len() > 2 {
            return Err("pick one or two input channels".into());
        }
        if self.port < 1024 {
            return Err("invalid port".into());
        }
        Ok(())
    }

    /// Device + format flags shared by `serve` and `latency`.
    fn device_args(&self) -> Vec<String> {
        let mut a = vec![
            "--input".into(),
            self.input.clone(),
            "--output".into(),
            self.output.clone(),
            "--rate".into(),
            self.rate.to_string(),
            "--buffer".into(),
            self.buffer.to_string(),
            "--in-ch".into(),
            join(&self.input_channels),
            "--main".into(),
            join(&self.main),
        ];
        if let Some(m) = self.monitor {
            a.extend(["--monitor".into(), join(&m)]);
        }
        if let Some(h) = &self.host {
            a.extend(["--host".into(), h.clone()]);
        }
        a
    }

    pub fn serve_args(&self) -> Vec<String> {
        let mut a = vec!["serve".to_string()];
        a.extend(self.device_args());
        a.extend([
            "--preset".into(),
            self.preset.clone(),
            "--port".into(),
            self.port.to_string(),
            "--name".into(),
            "MixAI Live".into(),
        ]);
        if self.lan {
            a.push("--lan".into());
        }
        a
    }

    pub fn latency_args(&self) -> Vec<String> {
        let mut a = vec!["latency".to_string()];
        a.extend(self.device_args());
        a
    }

    /// What each route on this machine declares (read-only; nothing is opened, no loopback needed).
    pub fn routes_args(&self) -> Vec<String> {
        let mut a = vec!["routes".to_string()];
        a.extend(self.device_args());
        a
    }
}

/// What the UI needs to connect (parsed from the engine's `ready` line).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub port: u16,
    pub osc_port: Option<u16>,
    pub token: String,
    pub controller_url: String,
    pub performer_url: String,
    pub viewer_url: String,
    pub lan: bool,
    pub info: Value,
}

/// Parse `{"event":"ready",...}`; returns `None` for any other line.
pub fn parse_ready(line: &str, lan: bool) -> Option<StartResult> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("event")?.as_str()? != "ready" {
        return None;
    }
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let controller_url = s("controller_url")?;
    let token = token_of(&controller_url)?;
    Some(StartResult {
        port: u16::try_from(v.get("port")?.as_u64()?).ok()?,
        osc_port: v
            .get("osc_port")
            .and_then(Value::as_u64)
            .and_then(|p| u16::try_from(p).ok()),
        token,
        controller_url,
        performer_url: s("performer_url")?,
        viewer_url: s("viewer_url")?,
        lan,
        info: v.get("info").cloned().unwrap_or(Value::Null),
    })
}

fn token_of(url: &str) -> Option<String> {
    let (_, q) = url.split_once('?')?;
    q.split('&')
        .find_map(|kv| kv.strip_prefix("t="))
        .filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_hexdigit()))
        .map(str::to_string)
}

/// `error: ...` lines from stderr, newest last.
fn error_text(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    lines
        .iter()
        .rev()
        .find_map(|l| l.strip_prefix("error: "))
        .map(str::to_string)
        .or_else(|| lines.last().map(|l| (*l).to_string()))
        .unwrap_or_else(|| "engine exited".into())
}

struct Running {
    child: CommandChild,
    generation: u64,
    result: StartResult,
}

#[derive(Default)]
pub struct EngineState {
    running: Mutex<Option<Running>>,
    last_error: Mutex<Option<String>>,
    generation: AtomicU64,
}

impl EngineState {
    fn take(&self) -> Option<Running> {
        self.running.lock().ok().and_then(|mut g| g.take())
    }
    fn set_error(&self, e: Option<String>) {
        if let Ok(mut g) = self.last_error.lock() {
            *g = e;
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub running: bool,
    pub start: Option<StartResult>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    code: Option<i32>,
    message: String,
}

fn kill(r: Option<Running>) {
    if let Some(r) = r {
        let _ = r.child.kill();
    }
}

pub fn kill_on_exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<EngineState>() {
        kill(state.take());
    }
}

async fn run_once(app: &AppHandle, args: Vec<String>, timeout: Duration) -> Result<String, String> {
    let cmd = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|e| format!("engine binary missing: {e}"))?
        .args(args);
    let out = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| "engine timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(error_text(&String::from_utf8_lossy(&out.stderr)))
    }
}

#[tauri::command]
pub async fn list_devices(app: AppHandle, host: Option<String>) -> Result<Value, String> {
    let mut args = vec!["devices".to_string()];
    if let Some(h) = host.filter(|h| !h.is_empty()) {
        safe_value(&h, "host")?;
        args.extend(["--host".into(), h]);
    }
    let out = run_once(&app, args, Duration::from_secs(15)).await?;
    serde_json::from_str(&out).map_err(|e| format!("bad devices JSON: {e}"))
}

/// What each route on this machine declares, for the setup step's chooser.
///
/// Unlike `measure_latency` this opens nothing and plays nothing, so a running engine is left alone: the
/// numbers are read from the driver's period limits and from Voicemeeter's configuration.
#[tauri::command]
pub async fn compare_routes(
    app: AppHandle,
    _state: State<'_, EngineState>,
    config: EngineConfig,
) -> Result<Value, String> {
    config.validate()?;
    let out = run_once(&app, config.routes_args(), ROUTES_TIMEOUT).await?;
    serde_json::from_str(&out).map_err(|e| format!("bad routes JSON: {e}"))
}

#[tauri::command]
pub async fn measure_latency(
    app: AppHandle,
    state: State<'_, EngineState>,
    config: EngineConfig,
) -> Result<Value, String> {
    config.validate()?;
    // One owner per device: the live engine must be stopped while the click train runs.
    kill(state.take());
    let out = run_once(&app, config.latency_args(), LATENCY_TIMEOUT).await?;
    serde_json::from_str(&out).map_err(|e| format!("bad latency JSON: {e}"))
}

#[tauri::command]
pub async fn start_engine(
    app: AppHandle,
    state: State<'_, EngineState>,
    config: EngineConfig,
) -> Result<StartResult, String> {
    config.validate()?;
    kill(state.take());
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let (mut rx, child) = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|e| format!("engine binary missing: {e}"))?
        .args(config.serve_args())
        .spawn()
        .map_err(|e| format!("could not start the engine: {e}"))?;

    let mut stderr = String::new();
    let ready = tokio::time::timeout(READY_TIMEOUT, async {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(line) => {
                    if let Some(r) = parse_ready(&String::from_utf8_lossy(&line), config.lan) {
                        return Ok(r);
                    }
                }
                CommandEvent::Stderr(line) => {
                    stderr.push_str(&String::from_utf8_lossy(&line));
                    stderr.push('\n');
                }
                CommandEvent::Error(e) => return Err(e),
                CommandEvent::Terminated(_) => return Err(error_text(&stderr)),
                _ => {}
            }
        }
        Err(error_text(&stderr))
    })
    .await;

    let result = match ready {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            let _ = child.kill();
            state.set_error(Some(e.clone()));
            return Err(e);
        }
        Err(_) => {
            let _ = child.kill();
            let e = "the engine did not report ready in 20 s".to_string();
            state.set_error(Some(e.clone()));
            return Err(e);
        }
    };

    state.set_error(None);
    if let Ok(mut g) = state.running.lock() {
        *g = Some(Running {
            child,
            generation,
            result: result.clone(),
        });
    }

    // Watch the process: a crash or driver loss clears the state and tells the UI.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tail = String::new();
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stderr(line) => {
                    let l = String::from_utf8_lossy(&line);
                    log::warn!("engine: {}", l.trim_end());
                    tail.push_str(&l);
                    tail.push('\n');
                    if tail.len() > 8192 {
                        tail.drain(..tail.len() - 4096);
                    }
                }
                CommandEvent::Terminated(p) => {
                    let st = app2.state::<EngineState>();
                    let mine = st
                        .running
                        .lock()
                        .map(|g| g.as_ref().is_some_and(|r| r.generation == generation))
                        .unwrap_or(false);
                    if mine {
                        if let Ok(mut g) = st.running.lock() {
                            *g = None;
                        }
                        let message = error_text(&tail);
                        st.set_error(Some(message.clone()));
                        let _ = app2.emit(
                            "engine://exit",
                            ExitEvent {
                                code: p.code,
                                message,
                            },
                        );
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(result)
}

#[tauri::command]
pub fn stop_engine(state: State<'_, EngineState>) {
    kill(state.take());
}

#[tauri::command]
pub fn engine_status(state: State<'_, EngineState>) -> EngineStatus {
    let start = state
        .running
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|r| r.result.clone()));
    EngineStatus {
        running: start.is_some(),
        start,
        last_error: state.last_error.lock().ok().and_then(|g| g.clone()),
    }
}

/// `/api/fx` through Rust (the engine sends no CORS headers for the webview origin).
#[tauri::command]
pub async fn fx_catalogue(state: State<'_, EngineState>) -> Result<Value, String> {
    let port = state
        .running
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|r| r.result.port))
        .ok_or("engine not running")?;
    let body =
        tauri::async_runtime::spawn_blocking(move || crate::local_http::get(port, "/api/fx"))
            .await
            .map_err(|e| e.to_string())??;
    serde_json::from_str(&body).map_err(|e| format!("bad catalogue JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> EngineConfig {
        serde_json::from_str(
            r#"{"input":"Focusrite USB","output":"Voicemeeter In 5","monitor":[2,3]}"#,
        )
        .unwrap()
    }

    #[test]
    fn builds_serve_args() {
        let mut c = cfg();
        c.lan = true;
        let a = c.serve_args().join(" ");
        assert!(a.starts_with("serve --input Focusrite USB --output Voicemeeter In 5"));
        assert!(a.contains("--buffer 128") && a.contains("--in-ch 0") && a.contains("--main 0,1"));
        assert!(a.contains("--monitor 2,3") && a.ends_with("--lan"));
        assert!(c.latency_args()[0] == "latency" && !c.latency_args().contains(&"--preset".into()));
    }

    #[test]
    fn rejects_flag_injection() {
        let mut c = cfg();
        c.input = "--lan".into();
        assert!(c.validate().is_err());
        let mut c = cfg();
        c.buffer = 1;
        assert!(c.validate().is_err());
        assert!(cfg().validate().is_ok());
    }

    #[test]
    fn parses_ready_line() {
        let line = r#"{"event":"ready","port":17920,"osc_port":17921,"controller_url":"http://127.0.0.1:17920/?t=ab12","performer_url":"http://127.0.0.1:17920/?t=cd","viewer_url":"http://127.0.0.1:17920/?t=ef","info":{"nominal_latency_ms":5.3}}"#;
        let r = parse_ready(line, false).unwrap();
        assert_eq!(
            (r.port, r.osc_port, r.token.as_str()),
            (17920, Some(17921), "ab12")
        );
        assert!(parse_ready(r#"{"event":"other"}"#, false).is_none());
        assert!(parse_ready("not json", false).is_none());
    }

    #[test]
    fn extracts_error_line() {
        assert_eq!(
            error_text("warn x\nerror: no such device `X`\n"),
            "no such device `X`"
        );
        assert_eq!(error_text(""), "engine exited");
    }
}
