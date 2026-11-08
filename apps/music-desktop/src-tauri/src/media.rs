//! Native Now Playing. The web player on music.mixai.ro stays the only source of truth: it pushes its state through
//! `desktop_media_update`; this module mirrors it to the OS media controls (souvlaki: Windows SMTC, macOS Now Playing,
//! Linux MPRIS), the tray tooltip and the mini-player, and turns OS / tray / mini / hotkey actions back into
//! `window.__mixaiDesktop.command(..)` calls on the page (fixed command set, numeric args only).

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig, SeekDirection};
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub art_url: Option<String>,
    pub playing: bool,
    pub position_sec: f64,
    pub duration_sec: f64,
}

impl NowPlaying {
    pub fn is_empty(&self) -> bool {
        self.title.as_deref().is_none_or(str::is_empty)
    }

    /// Tray tooltip: "Title — Artist" (bounded: Windows truncates tooltips at 127 chars).
    pub fn tooltip(&self) -> String {
        if self.is_empty() {
            return "MixAI Music".into();
        }
        let mut s = self.title.clone().unwrap_or_default();
        if let Some(a) = self.artist.as_deref().filter(|a| !a.is_empty()) {
            s.push_str(" — ");
            s.push_str(a);
        }
        s.chars().take(120).collect()
    }
}

/// Commands the page accepts (mirrors `desktop-bridge.ts`).
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Toggle,
    Play,
    Pause,
    Next,
    Previous,
    Stop,
    SeekTo(f64),
    SeekBy(f64),
    Volume(f64),
}

impl Command {
    pub fn parse(name: &str, arg: Option<f64>) -> Option<Command> {
        let finite = arg.filter(|v| v.is_finite());
        Some(match name {
            "toggle" => Command::Toggle,
            "play" => Command::Play,
            "pause" => Command::Pause,
            "next" => Command::Next,
            "previous" => Command::Previous,
            "stop" => Command::Stop,
            "seekTo" => Command::SeekTo(finite?.max(0.0)),
            "seekBy" => Command::SeekBy(finite?.clamp(-600.0, 600.0)),
            "volume" => Command::Volume(finite?.clamp(0.0, 1.0)),
            _ => return None,
        })
    }

    /// JS run on the page. Only static names and finite numbers are ever interpolated.
    pub fn script(&self) -> String {
        let (name, arg) = match self {
            Command::Toggle => ("toggle", None),
            Command::Play => ("play", None),
            Command::Pause => ("pause", None),
            Command::Next => ("next", None),
            Command::Previous => ("previous", None),
            Command::Stop => ("stop", None),
            Command::SeekTo(v) => ("seekTo", Some(*v)),
            Command::SeekBy(v) => ("seekBy", Some(*v)),
            Command::Volume(v) => ("volume", Some(*v)),
        };
        let a = arg.map(|v| format!(",{v}")).unwrap_or_default();
        format!("window.__mixaiDesktop&&window.__mixaiDesktop.command(\"{name}\"{a})")
    }

    pub fn from_os(e: &MediaControlEvent) -> Option<Command> {
        Some(match e {
            MediaControlEvent::Play => Command::Play,
            MediaControlEvent::Pause => Command::Pause,
            MediaControlEvent::Toggle => Command::Toggle,
            MediaControlEvent::Next => Command::Next,
            MediaControlEvent::Previous => Command::Previous,
            MediaControlEvent::Stop => Command::Stop,
            MediaControlEvent::Seek(SeekDirection::Forward) => Command::SeekBy(10.0),
            MediaControlEvent::Seek(SeekDirection::Backward) => Command::SeekBy(-10.0),
            MediaControlEvent::SeekBy(SeekDirection::Forward, d) => Command::SeekBy(d.as_secs_f64()),
            MediaControlEvent::SeekBy(SeekDirection::Backward, d) => Command::SeekBy(-d.as_secs_f64()),
            MediaControlEvent::SetPosition(MediaPosition(d)) => Command::SeekTo(d.as_secs_f64()),
            MediaControlEvent::SetVolume(v) => Command::Volume(v.clamp(0.0, 1.0)),
            _ => return None,
        })
    }
}

#[derive(Default)]
pub struct MediaState {
    pub now: Mutex<NowPlaying>,
    controls: Mutex<Option<MediaControls>>,
}

/// Sends a command to the page in the main window (no-op while the launcher is shown: nothing is playing there).
pub fn send<R: Runtime>(app: &AppHandle<R>, cmd: &Command) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(cmd.script());
    }
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Creates the OS media controls bound to the main window (HWND on Windows). Failure only disables the feature.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "windows")]
    let hwnd = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0);
    #[cfg(not(target_os = "windows"))]
    let hwnd = None;
    let config = PlatformConfig { dbus_name: "ro.mixai.music.desktop", display_name: "MixAI Music", hwnd };
    let Ok(mut controls) = MediaControls::new(config) else { return };
    let handle = app.clone();
    let attached = controls.attach(move |e: MediaControlEvent| match e {
        MediaControlEvent::Raise => show_main(&handle),
        MediaControlEvent::Quit => handle.exit(0),
        other => {
            if let Some(cmd) = Command::from_os(&other) {
                send(&handle, &cmd);
            }
        }
    });
    if attached.is_ok() {
        *app.state::<MediaState>().controls.lock().expect("media mutex") = Some(controls);
    }
}

fn push_os(controls: &mut MediaControls, np: &NowPlaying, track_changed: bool) {
    if np.is_empty() {
        let _ = controls.set_playback(MediaPlayback::Stopped);
        return;
    }
    if track_changed {
        let art = np.art_url.as_deref().filter(|u| u.starts_with("https://") || u.starts_with("http://"));
        let _ = controls.set_metadata(MediaMetadata {
            title: np.title.as_deref(),
            artist: np.artist.as_deref(),
            album: np.album.as_deref(),
            cover_url: art,
            duration: (np.duration_sec > 0.0).then(|| Duration::from_secs_f64(np.duration_sec)),
        });
    }
    let progress = Some(MediaPosition(Duration::from_secs_f64(np.position_sec.max(0.0))));
    let _ = controls.set_playback(if np.playing { MediaPlayback::Playing { progress } } else { MediaPlayback::Paused { progress } });
}

/// Called by the page (remote capability) whenever its player state changes, and every few seconds while playing.
#[tauri::command]
pub fn desktop_media_update<R: Runtime>(app: AppHandle<R>, state: NowPlaying) -> Result<(), String> {
    let media = app.state::<MediaState>();
    let track_changed = {
        let mut now = media.now.lock().map_err(|e| e.to_string())?;
        let changed = now.title != state.title || now.artist != state.artist || now.album != state.album || now.art_url != state.art_url;
        *now = state.clone();
        changed
    };
    if let Some(c) = media.controls.lock().map_err(|e| e.to_string())?.as_mut() {
        push_os(c, &state, track_changed);
    }
    crate::tray::refresh(&app, &state);
    let _ = app.emit_to("mini", "np", &state);
    Ok(())
}

/// Mini-player (local page): current state on open.
#[tauri::command]
pub fn mini_state<R: Runtime>(app: AppHandle<R>) -> NowPlaying {
    app.state::<MediaState>().now.lock().map(|n| n.clone()).unwrap_or_default()
}

/// Mini-player buttons + "open" (raise the main window).
#[tauri::command]
pub fn mini_command<R: Runtime>(app: AppHandle<R>, name: String, arg: Option<f64>) -> Result<(), String> {
    if name == "open" {
        show_main(&app);
        return Ok(());
    }
    let cmd = Command::parse(&name, arg).ok_or("unknown command")?;
    send(&app, &cmd);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_known_commands_with_safe_args() {
        assert_eq!(Command::parse("next", None), Some(Command::Next));
        assert_eq!(Command::parse("seekTo", Some(-5.0)), Some(Command::SeekTo(0.0)));
        assert_eq!(Command::parse("seekBy", Some(9999.0)), Some(Command::SeekBy(600.0)));
        assert_eq!(Command::parse("volume", Some(3.0)), Some(Command::Volume(1.0)));
        assert_eq!(Command::parse("seekTo", None), None);
        assert_eq!(Command::parse("seekTo", Some(f64::NAN)), None);
        assert_eq!(Command::parse("alert(1)", None), None);
    }

    #[test]
    fn scripts_interpolate_only_names_and_numbers() {
        assert_eq!(Command::Toggle.script(), "window.__mixaiDesktop&&window.__mixaiDesktop.command(\"toggle\")");
        assert_eq!(Command::SeekTo(42.5).script(), "window.__mixaiDesktop&&window.__mixaiDesktop.command(\"seekTo\",42.5)");
    }

    #[test]
    fn maps_os_events() {
        assert_eq!(Command::from_os(&MediaControlEvent::Toggle), Some(Command::Toggle));
        assert_eq!(Command::from_os(&MediaControlEvent::Seek(SeekDirection::Backward)), Some(Command::SeekBy(-10.0)));
        assert_eq!(
            Command::from_os(&MediaControlEvent::SetPosition(MediaPosition(Duration::from_secs(30)))),
            Some(Command::SeekTo(30.0))
        );
        assert_eq!(Command::from_os(&MediaControlEvent::Raise), None);
    }

    #[test]
    fn tooltip_is_bounded() {
        let np = NowPlaying { title: Some("x".repeat(300)), artist: Some("A".into()), ..Default::default() };
        assert_eq!(np.tooltip().chars().count(), 120);
        assert_eq!(NowPlaying::default().tooltip(), "MixAI Music");
        let np = NowPlaying { title: Some("Song".into()), artist: Some("Band".into()), ..Default::default() };
        assert_eq!(np.tooltip(), "Song — Band");
    }

    #[test]
    fn deserialises_the_page_payload() {
        let np: NowPlaying = serde_json::from_str(
            r#"{"title":"T","artist":null,"album":"A","artUrl":"https://x/c.jpg","playing":true,"positionSec":3.5,"durationSec":200}"#,
        )
        .expect("payload");
        assert!(np.playing);
        assert_eq!(np.art_url.as_deref(), Some("https://x/c.jpg"));
        assert_eq!(np.duration_sec, 200.0);
    }
}
