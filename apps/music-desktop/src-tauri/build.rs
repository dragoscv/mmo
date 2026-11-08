fn main() {
    // Every app command is listed so capabilities grant them explicitly: the local launcher + mini-player get the
    // sign-in / mini commands, the remote music.mixai.ro page only the two bridge commands (capabilities/*.json).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "desktop_auth",
        "desktop_auth_cancel",
        "get_web_app_url",
        "web_reachable",
        "take_pending_path",
        "mini_command",
        "mini_state",
        "desktop_media_update",
        "desktop_open_signin",
    ])))
    .expect("tauri build");
}
