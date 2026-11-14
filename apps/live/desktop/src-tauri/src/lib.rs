//! MixAI Live desktop shell (WP21-07, ADR-0015).
//!
//! The audio engine runs as a separate process (`mixai-live-engine serve`, bundled as a sidecar).
//! This crate only starts/stops it, lists devices, measures latency, renders pairing QR codes and
//! persists the device configuration. The UI talks to the engine over protocol v1 (WebSocket on
//! 127.0.0.1) exactly like the phones do.

mod config;
mod engine;
mod local_http;
mod qr;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_websocket::init())
        .manage(engine::EngineState::default())
        .invoke_handler(tauri::generate_handler![
            engine::list_devices,
            engine::start_engine,
            engine::stop_engine,
            engine::engine_status,
            engine::measure_latency,
            engine::compare_routes,
            engine::fx_catalogue,
            qr::pairing_qr,
            config::load_settings,
            config::save_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building MixAI Live")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                engine::kill_on_exit(app);
            }
        });
}
