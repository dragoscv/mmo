//! MixAI TV desktop shell (WP17-25). The UI is the shared TV web app; Rust only provides:
//!  - `platform_info`: OS, host name and the primary LAN IPv4 (for the /24 MixAI Server sweep);
//!  - `tauri-plugin-http`: the HTTP client the UI's `fetch` is routed through (LAN http, no CORS).

use serde::Serialize;
use std::net::IpAddr;

#[derive(Serialize)]
struct PlatformInfo {
    os: &'static str,
    host: String,
    ip: Option<String>,
    netmask: Option<String>,
}

fn os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Primary private IPv4 (the interface with the default route); `None` when offline or IPv6-only.
fn lan_ipv4() -> Option<String> {
    match local_ip_address::local_ip() {
        Ok(IpAddr::V4(v4)) if v4.is_private() => Some(v4.to_string()),
        _ => None,
    }
}

#[tauri::command]
fn platform_info() -> PlatformInfo {
    let host = gethostname::gethostname().to_string_lossy().trim().to_string();
    let ip = lan_ipv4();
    PlatformInfo { os: os_name(), host, netmask: ip.as_ref().map(|_| "255.255.255.0".to_string()), ip }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![platform_info])
        .run(tauri::generate_context!())
        .expect("error while running MixAI TV");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_info_is_well_formed() {
        let p = platform_info();
        assert!(["windows", "macos", "linux"].contains(&p.os));
        if let Some(ip) = &p.ip {
            assert!(ip.parse::<std::net::Ipv4Addr>().is_ok());
            assert_eq!(p.netmask.as_deref(), Some("255.255.255.0"));
        }
    }
}
