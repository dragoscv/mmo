//! Tray / menu-bar icon (open, play/pause, next, previous, mini player, quit), the always-on-top mini player window
//! and global shortcuts (Ctrl+Alt+Space / Right / Left / M). Closing the main window while music plays hides it to
//! the tray instead of quitting.

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::i18n::{self, Lang};
use crate::media::{self, Command, NowPlaying};

pub const TRAY_ID: &str = "mixai-music";

pub fn build<R: Runtime>(app: &AppHandle<R>, lang: Lang) -> tauri::Result<()> {
    let item = |id: &str| MenuItemBuilder::with_id(id, i18n::t(lang, id)).build(app);
    let menu = MenuBuilder::new(app)
        .items(&[&item("show")?, &item("toggle")?, &item("next")?, &item("previous")?, &item("mini")?])
        .separator()
        .item(&item("quit")?)
        .build()?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(i18n::t(lang, "tooltip"))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, e| match e.id().as_ref() {
            "show" => media::show_main(app),
            "toggle" => media::send(app, &Command::Toggle),
            "next" => media::send(app, &Command::Next),
            "previous" => media::send(app, &Command::Previous),
            "mini" => toggle_mini(app, lang),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                media::show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn refresh<R: Runtime>(app: &AppHandle<R>, np: &NowPlaying) {
    if let Some(t) = app.tray_by_id(TRAY_ID) {
        let _ = t.set_tooltip(Some(np.tooltip()));
    }
}

/// Opens (or closes) the 360x112 always-on-top mini player (local page `mini.html`).
pub fn toggle_mini<R: Runtime>(app: &AppHandle<R>, lang: Lang) {
    if let Some(w) = app.get_webview_window("mini") {
        let _ = w.close();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "mini", WebviewUrl::App("mini.html".into()))
        .title(format!("MixAI Music — {}", i18n::t(lang, "mini")))
        .inner_size(360.0, 112.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build();
}

pub fn shortcuts() -> [(Shortcut, &'static str); 4] {
    let m = Some(Modifiers::CONTROL | Modifiers::ALT);
    [
        (Shortcut::new(m, Code::Space), "toggle"),
        (Shortcut::new(m, Code::ArrowRight), "next"),
        (Shortcut::new(m, Code::ArrowLeft), "previous"),
        (Shortcut::new(m, Code::KeyM), "mini"),
    ]
}

pub fn shortcut_plugin<R: Runtime>(lang: Lang) -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let Some((_, action)) = shortcuts().into_iter().find(|(s, _)| s == shortcut) else { return };
            match action {
                "mini" => toggle_mini(app, lang),
                name => {
                    if let Some(cmd) = Command::parse(name, None) {
                        media::send(app, &cmd);
                    }
                }
            }
        })
        .build()
}

/// Registers the global shortcuts; a combination another app already owns is skipped, never fatal.
pub fn register_shortcuts<R: Runtime>(app: &AppHandle<R>) {
    for (s, _) in shortcuts() {
        let _ = app.global_shortcut().register(s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcuts_map_to_known_commands() {
        for (_, action) in shortcuts() {
            assert!(action == "mini" || Command::parse(action, None).is_some(), "{action}");
        }
    }
}
