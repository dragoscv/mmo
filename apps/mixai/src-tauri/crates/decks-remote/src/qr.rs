//! QR codes for pairing URLs. The native UIs draw the module matrix with their own colours
//! (design tokens), so no colour is decided here; `qr_svg` is for docs / the desktop share sheet
//! and uses `currentColor`.

use qrcode::{EcLevel, QrCode};

/// Square module matrix, row-major, `true` = dark module. No quiet zone included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QrMatrix {
    pub width: u32,
    pub modules: Vec<bool>,
}

/// Encode `text` (medium error correction).
pub fn qr_matrix(text: &str) -> Result<QrMatrix, String> {
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M)
        .map_err(|e| e.to_string())?;
    let width = code.width() as u32;
    let modules = code
        .to_colors()
        .into_iter()
        .map(|c| c == qrcode::Color::Dark)
        .collect();
    Ok(QrMatrix { width, modules })
}

/// SVG with a 4-module quiet zone, dark modules in `currentColor` (inherits the page text colour).
pub fn qr_svg(text: &str) -> Result<String, String> {
    let m = qr_matrix(text)?;
    let size = m.width + 8;
    let mut path = String::new();
    for y in 0..m.width {
        for x in 0..m.width {
            if m.modules[(y * m.width + x) as usize] {
                path.push_str(&format!("M{} {}h1v1h-1z", x + 4, y + 4));
            }
        }
    }
    Ok(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\" shape-rendering=\"crispEdges\"><path fill=\"currentColor\" d=\"{path}\"/></svg>"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_url_encodes_to_a_square_matrix_with_finder_patterns() {
        let m = qr_matrix("http://192.168.1.20:47321/party?t=0123456789abcdef0123456789abcdef")
            .unwrap();
        assert!(
            m.width >= 21 && (m.width - 17).is_multiple_of(4),
            "valid QR size"
        );
        assert_eq!(m.modules.len(), (m.width * m.width) as usize);
        // Top-left finder: dark 7x7 outer ring, light ring inside.
        let at = |x: u32, y: u32| m.modules[(y * m.width + x) as usize];
        assert!(at(0, 0) && at(6, 0) && at(0, 6) && at(6, 6));
        assert!(!at(1, 1) && !at(5, 5));
        assert!(at(3, 3));
    }

    #[test]
    fn svg_uses_current_color_and_quiet_zone() {
        let s = qr_svg("hello").unwrap();
        assert!(s.starts_with("<svg"));
        assert!(s.contains("currentColor"));
        assert!(
            s.contains("M4 4h1v1h-1z"),
            "first finder module offset by the quiet zone"
        );
    }
}
