//! MixAI Music desktop (WP17-43, D55/D56): Tauri 2 shell around music.mixai.ro.
//!
//! - `web/index.html` (local launcher): offline check, system-browser sign-in (`auth`), then navigates to the web UI.
//! - The web UI (remote capability) pushes its player state through `desktop_media_update` → OS media controls,
//!   tray tooltip and the mini player (`media`, `tray`); OS / tray / hotkeys call back into the page.
//! - `mixai-music://` links (`links`) open the matching page, also when the app is already running (single instance).

mod auth;
mod i18n;
mod links;
mod media;
mod tray;

use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, Url, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

/// Deep link received before the launcher finished (cold start); the launcher takes it once.
#[derive(Default)]
struct Pending(Mutex<Option<String>>);

/// URL of the local launcher (to come back for sign-in from the remote page).
struct LauncherUrl(Mutex<Option<Url>>);

#[tauri::command]
fn take_pending_path(state: tauri::State<'_, Pending>) -> Option<String> {
    state.0.lock().ok().and_then(|mut p| p.take())
}

/// Called by the web login page inside the shell: Google blocks OAuth in embedded webviews, so go back to the
/// launcher, which signs in through the system browser.
#[tauri::command]
fn desktop_open_signin<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let launcher = app.state::<LauncherUrl>().0.lock().map_err(|e| e.to_string())?.clone().ok_or("no launcher")?;
    let mut url = launcher;
    url.set_query(Some("signin=1"));
    app.get_webview_window("main").ok_or("no window")?.navigate(url).map_err(|e| e.to_string())
}

/// Opens a `mixai-music://` link: navigates the main window when it already shows the web UI, otherwise parks the
/// path for the launcher.
fn open_link<R: Runtime>(app: &AppHandle<R>, path: String) {
    let Some(w) = app.get_webview_window("main") else { return };
    let base = auth::web_app_url();
    let on_web = w.url().map(|u| u.as_str().starts_with(&base)).unwrap_or(false);
    if on_web && let Ok(target) = Url::parse(&format!("{base}{path}")) {
        let _ = w.navigate(target);
    } else if let Ok(mut p) = app.state::<Pending>().0.lock() {
        *p = Some(path);
    }
    media::show_main(app);
}

pub fn run() {
    let lang = i18n::current();
    let auth_state = auth::build_state().expect("failed to start the desktop sign-in listener");

    tauri::Builder::default()
        // Must be first: a second launch (or a mixai-music:// link on Windows/Linux) lands here.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            match links::from_args(argv) {
                Some(path) => open_link(app, path),
                None => media::show_main(app),
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().with_denylist(&["mini"]).build())
        .plugin(tray::shortcut_plugin(lang))
        .manage(auth_state)
        .manage(media::MediaState::default())
        .manage(Pending::default())
        .manage(LauncherUrl(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            auth::desktop_auth,
            auth::desktop_auth_cancel,
            auth::get_web_app_url,
            auth::web_reachable,
            take_pending_path,
            desktop_open_signin,
            media::desktop_media_update,
            media::mini_state,
            media::mini_command,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            if let Some(w) = app.get_webview_window("main") {
                *app.state::<LauncherUrl>().0.lock().expect("launcher mutex") = w.url().ok();
                let h = handle.clone();
                w.on_window_event(move |e| {
                    // Closing while music plays keeps it playing in the tray; otherwise quit.
                    if let WindowEvent::CloseRequested { api, .. } = e {
                        let playing = h.state::<media::MediaState>().now.lock().map(|n| n.playing).unwrap_or(false);
                        if playing && let Some(w) = h.get_webview_window("main") {
                            api.prevent_close();
                            let _ = w.hide();
                        } else {
                            h.exit(0);
                        }
                    }
                });
            }
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            let _ = app.deep_link().register_all();
            if let Ok(Some(urls)) = app.deep_link().get_current()
                && let Some(path) = links::from_args(urls.iter().map(|u| u.to_string()))
            {
                *app.state::<Pending>().0.lock().expect("pending mutex") = Some(path);
            }
            let h = handle.clone();
            app.deep_link().on_open_url(move |e| {
                if let Some(path) = links::from_args(e.urls().iter().map(|u| u.to_string())) {
                    open_link(&h, path);
                }
            });
            media::init(&handle);
            tray::build(&handle, lang)?;
            tray::register_shortcuts(&handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running MixAI Music");
}
