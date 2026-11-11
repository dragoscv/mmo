//! Custom window chrome helpers for the HTML title bar (own code, no tauri-plugin-decorum).
//!
//! Decorations strategy (Tauri 2.12): `decorations: false` in `tauri.conf.json` would make the
//! window borderless on macOS too, which removes the native traffic lights. So the config keeps
//! `decorations: true` plus the macOS-only `titleBarStyle: "Overlay"` + `hiddenTitle: true`
//! (traffic lights float over our web content), and `lib.rs` drops the native frame at runtime
//! on Windows/Linux with `set_decorations(false)`. Pop-out windows follow the same rule.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Panels that may be popped out into their own window (mirrors `PANEL_IDS` in src/layout/types.ts).
pub const POPOUT_PANELS: &[&str] = &[
    "library",
    "deckA",
    "deckB",
    "deckC",
    "deckD",
    "waves",
    "mixer",
    "crossfader",
    "clock",
    "automix",
    "sampler",
    "plugins",
];

/// Validate a pop-out panel id against the allow-list.
pub fn validate_panel(panel: &str) -> Result<&'static str, String> {
    POPOUT_PANELS
        .iter()
        .copied()
        .find(|p| *p == panel)
        .ok_or_else(|| {
            let shown: String = panel.chars().take(40).collect();
            format!("unknown panel '{shown}'")
        })
}

/// Window label for a pop-out panel (matches the `popout-*` capability pattern).
pub fn popout_label(panel: &str) -> String {
    format!("popout-{panel}")
}

/// Open the Windows 11 Snap Layouts flyout for this window (hover on our HTML maximise button).
/// Same approach as tauri-plugin-decorum: focus the window, synthesise Win+Z, then tap Alt to
/// hide the keyboard-accelerator numbers. No-op on other platforms.
#[tauri::command]
pub async fn window_show_snap_overlay(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        window.set_focus().map_err(|e| e.to_string())?;
        win::show_snap_overlay()?;
    }
    #[cfg(not(windows))]
    let _ = window;
    Ok(())
}

/// Open (or focus, if already open) a pop-out window for `panel`, loading the same frontend
/// with `index.html?popout=<panel>`. Async: creating a window from a sync command deadlocks on
/// Windows.
#[tauri::command]
pub async fn window_pop_out(app: AppHandle, panel: String) -> Result<(), String> {
    let panel = validate_panel(&panel)?;
    let label = popout_label(panel);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        return existing.set_focus().map_err(|e| e.to_string());
    }
    let url = WebviewUrl::App(format!("index.html?popout={panel}").into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(format!("MixAI Decks — {panel}"))
        .inner_size(900.0, 600.0)
        .min_inner_size(480.0, 320.0)
        .resizable(true);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(windows)]
mod win {
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY,
        VK_LWIN, VK_MENU,
    };

    const VK_Z: VIRTUAL_KEY = 0x5A;

    fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn send(inputs: &[INPUT]) -> Result<(), String> {
        // SAFETY: `inputs` is a valid, initialised slice of INPUT structs that outlives the call,
        // and cbSize is the size of one INPUT as SendInput requires.
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                size_of::<INPUT>() as i32,
            )
        };
        if sent as usize == inputs.len() {
            Ok(())
        } else {
            Err("SendInput was blocked (another app may hold the input desktop)".into())
        }
    }

    pub fn show_snap_overlay() -> Result<(), String> {
        send(&[
            key(VK_LWIN, false),
            key(VK_Z, false),
            key(VK_Z, true),
            key(VK_LWIN, true),
        ])?;
        std::thread::sleep(std::time::Duration::from_millis(50));
        send(&[key(VK_MENU, false), key(VK_MENU, true)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_every_allow_listed_panel() {
        for p in POPOUT_PANELS {
            assert_eq!(validate_panel(p), Ok(*p));
        }
    }

    #[test]
    fn rejects_unknown_or_malformed_panels() {
        for p in [
            "",
            "Library",
            "deckE",
            "../main",
            "mixer?x=1",
            "library ",
            "main",
        ] {
            assert!(validate_panel(p).is_err(), "{p:?} must be rejected");
        }
    }

    #[test]
    fn labels_match_the_capability_pattern() {
        assert_eq!(popout_label("deckA"), "popout-deckA");
        for p in POPOUT_PANELS {
            let l = popout_label(p);
            assert!(
                l.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            );
        }
    }
}
