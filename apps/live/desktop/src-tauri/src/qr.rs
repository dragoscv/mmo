//! Pairing QR codes as SVG (`currentColor`, tinted by design tokens in the UI).

use qrcode::{EcLevel, QrCode};

/// Accepts only the pairing URL shapes the engine prints (`http://<ip>:<port>/?t=…`) or the
/// `mixai-live://pair?...` deep link; anything else is refused.
pub fn valid_pairing_url(url: &str) -> bool {
    (url.starts_with("http://") || url.starts_with("mixai-live://"))
        && url.len() <= 512
        && url.chars().all(|c| c.is_ascii_graphic())
}

pub fn svg(text: &str) -> Option<String> {
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M).ok()?;
    Some(
        code.render::<qrcode::render::svg::Color>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .dark_color(qrcode::render::svg::Color("currentColor"))
            .light_color(qrcode::render::svg::Color("transparent"))
            .build(),
    )
}

#[tauri::command]
pub fn pairing_qr(url: String) -> Result<String, String> {
    if !valid_pairing_url(&url) {
        return Err("invalid pairing URL".into());
    }
    svg(&url).ok_or_else(|| "QR encoding failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_engine_urls_only() {
        let url = "http://192.168.1.20:17920/?t=0123456789abcdef0123456789abcdef";
        assert!(valid_pairing_url(url));
        assert!(svg(url).unwrap().contains("currentColor"));
        assert!(!valid_pairing_url("javascript:alert(1)"));
        assert!(!valid_pairing_url("http://a b"));
        assert!(!valid_pairing_url(&format!("http://{}", "a".repeat(600))));
    }
}
