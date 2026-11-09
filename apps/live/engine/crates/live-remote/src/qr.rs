//! QR code for pairing (module matrix for native drawing, SVG for the desktop UI).

use qrcode::{EcLevel, QrCode};

/// Square module matrix (`true` = dark), row-major, without quiet zone.
pub fn matrix(text: &str) -> Option<(usize, Vec<bool>)> {
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M).ok()?;
    let w = code.width();
    Some((
        w,
        code.to_colors()
            .into_iter()
            .map(|c| c == qrcode::Color::Dark)
            .collect(),
    ))
}

/// Standalone SVG using `currentColor` (the UI tints it with design tokens).
pub fn svg(text: &str) -> Option<String> {
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M).ok()?;
    Some(
        code.render::<qrcode::render::svg::Color>()
            .min_dimensions(200, 200)
            .dark_color(qrcode::render::svg::Color("currentColor"))
            .light_color(qrcode::render::svg::Color("transparent"))
            .build(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_pairing_url() {
        let (w, m) =
            matrix("http://192.168.1.20:17920/?t=0123456789abcdef0123456789abcdef").unwrap();
        assert_eq!(m.len(), w * w);
        assert!(w >= 25);
        assert!(svg("x").unwrap().contains("currentColor"));
    }
}
