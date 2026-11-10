//! Pack colours resolved to sRGB, so native code never parses `oklch(...)` itself.

use std::collections::BTreeMap;

use crate::{PackTokens, parse_num, parse_num_pct, valid_color};

/// One resolved colour: `rgb` = `0xRRGGBB`, `alpha` 0..1.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedColor {
    pub key: String,
    pub rgb: u32,
    pub alpha: f32,
}

fn gamma(x: f64) -> f64 {
    if x <= 0.003_130_8 {
        12.92 * x
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

fn channel(x: f64) -> u32 {
    (gamma(x).clamp(0.0, 1.0) * 255.0).round() as u32
}

/// OKLCH (L 0..1, C, H degrees) -> packed sRGB, clamped to the gamut.
pub fn oklch_to_rgb(l: f64, c: f64, h: f64) -> u32 {
    let (a, b) = (c * h.to_radians().cos(), c * h.to_radians().sin());
    let l_ = (l + 0.396_337_777_4 * a + 0.215_803_757_3 * b).powi(3);
    let m_ = (l - 0.105_561_345_8 * a - 0.063_854_172_8 * b).powi(3);
    let s_ = (l - 0.089_484_177_5 * a - 1.291_485_548 * b).powi(3);
    let r = 4.076_741_662_1 * l_ - 3.307_711_591_3 * m_ + 0.230_969_929_2 * s_;
    let g = -1.268_438_004_6 * l_ + 2.609_757_401_1 * m_ - 0.341_319_396_5 * s_;
    let bl = -0.004_196_086_3 * l_ - 0.703_418_614_7 * m_ + 1.707_614_701 * s_;
    (channel(r) << 16) | (channel(g) << 8) | channel(bl)
}

/// `#rrggbb`, `#rrggbbaa` or `oklch(L C H [/ A])` (the same grammar [`valid_color`] accepts).
pub fn resolve_color(c: &str) -> Option<(u32, f32)> {
    if !valid_color(c) {
        return None;
    }
    if let Some(h) = c.strip_prefix('#') {
        let rgb = u32::from_str_radix(&h[..6], 16).ok()?;
        let alpha = match h.get(6..8) {
            Some(a) => u8::from_str_radix(a, 16).ok()? as f32 / 255.0,
            None => 1.0,
        };
        return Some((rgb, alpha));
    }
    let inner = c.strip_prefix("oklch(")?.strip_suffix(')')?;
    let (lch, alpha) = match inner.split_once('/') {
        Some((a, b)) => (a, parse_num_pct(b.trim(), 1.0)?),
        None => (inner, 1.0),
    };
    let p: Vec<&str> = lch.split_whitespace().collect();
    let l = parse_num_pct(p[0], 1.0)?;
    let rgb = oklch_to_rgb(l, parse_num(p[1])?, parse_num(p[2])?);
    Some((rgb, alpha as f32))
}

/// Every colour of a pack: `colors` keys as-is, `decks.a..d` as `deck-a..deck-d` (an explicit
/// `colors["deck-a"]` wins), plus `accent` when the accent token is a colour and `colors` has none.
pub fn resolve_colors(t: &PackTokens) -> Vec<ResolvedColor> {
    let mut all: BTreeMap<String, String> = BTreeMap::new();
    if let Some(a) = t.accent.as_deref().filter(|a| valid_color(a)) {
        all.insert("accent".into(), a.to_owned());
    }
    for (k, v) in t.decks.iter().flatten() {
        all.insert(format!("deck-{k}"), v.clone());
    }
    for (k, v) in t.colors.iter().flatten() {
        all.insert(k.clone(), v.clone());
    }
    all.into_iter()
        .filter_map(|(key, v)| {
            resolve_color(&v).map(|(rgb, alpha)| ResolvedColor { key, rgb, alpha })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_and_oklch_resolve() {
        assert_eq!(resolve_color("#00e5ff"), Some((0x00e5ff, 1.0)));
        let (rgb, a) = resolve_color("#ffffff80").unwrap();
        assert_eq!(rgb, 0xffffff);
        assert!((a - 128.0 / 255.0).abs() < 1e-6);
        assert_eq!(resolve_color("oklch(1 0 0)"), Some((0xffffff, 1.0)));
        assert_eq!(resolve_color("oklch(0 0 0)"), Some((0x000000, 1.0)));
        // oklch(0.628 0.2577 29.23) is CSS red.
        let (red, _) = resolve_color("oklch(62.8% 0.2577 29.23 / 50%)").unwrap();
        assert!(
            red >> 16 >= 0xfd && (red >> 8) & 0xff <= 2 && red & 0xff <= 2,
            "{red:06x}"
        );
        assert_eq!(resolve_color("oklch(0.5 0.1 30 / 0.25)").unwrap().1, 0.25);
        assert_eq!(resolve_color("red"), None);
        assert_eq!(resolve_color("url(x)"), None);
    }

    #[test]
    fn tokens_merge_decks_accent_and_colors() {
        let t = PackTokens {
            accent: Some("#112233".into()),
            colors: Some([("deck-a".to_string(), "#010203".to_string())].into()),
            decks: Some(
                [
                    ("a".to_string(), "#ffffff".to_string()),
                    ("b".to_string(), "#000000".to_string()),
                ]
                .into(),
            ),
            ..PackTokens::default()
        };
        let got: Vec<(String, u32)> = resolve_colors(&t)
            .into_iter()
            .map(|c| (c.key, c.rgb))
            .collect();
        assert_eq!(
            got,
            [
                ("accent".to_string(), 0x112233),
                ("deck-a".to_string(), 0x010203),
                ("deck-b".to_string(), 0x000000),
            ]
        );
        let named = PackTokens {
            accent: Some("violet".into()),
            ..PackTokens::default()
        };
        assert!(resolve_colors(&named).is_empty());
    }
}
