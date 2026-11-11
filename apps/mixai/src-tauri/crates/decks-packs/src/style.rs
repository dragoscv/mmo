//! The `style` block of a skin (manifest v2, `tokens.json` -> `style`): what a skin may change
//! beyond the theme colours. Mirror of `apps/mixai/src/look/style-vars.ts` and of the SDK
//! validator (`apps/mixai/sdk/lib/validate.mjs`), key for key: change all three together (the
//! test `lists_match_style_vars_ts` reads the TS file and fails on drift).
//!
//! Everything is declarative data: a colour, a bounded number or an enum. No CSS, no selectors,
//! no URLs.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::{short, valid_color};

/// First manifest version whose tokens may carry a `style` block (needs Decks >= 1.5).
pub const STYLE_MANIFEST_VERSION: u32 = 2;

/// Keys a `style` object may have.
pub const STYLE_KEYS: &[&str] = &["look", "platter", "layout", "waves", "colors", "sizes"];

/// `style.colors` keys (`STYLE_COLORS` in style-vars.ts).
pub const STYLE_COLOR_KEYS: &[&str] = &[
    "well",
    "waveBg",
    "line",
    "faint",
    "on",
    "onFg",
    "play",
    "playFg",
    "cue",
    "alert",
    "waveLow",
    "waveMid",
    "waveHigh",
    "waveGrid",
    "waveDownbeat",
    "wavePlayhead",
    "wavePlayheadCap",
    "cue1",
    "cue2",
    "cue3",
    "cue4",
    "cue5",
    "cue6",
    "cue7",
    "cue8",
];

/// One `style.sizes` key with its inclusive range (`STYLE_SIZES` in style-vars.ts).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StyleSize {
    pub key: &'static str,
    pub min: f64,
    pub max: f64,
}

const fn size(key: &'static str, min: f64, max: f64) -> StyleSize {
    StyleSize { key, min, max }
}

pub const STYLE_SIZES: &[StyleSize] = &[
    size("panelGap", 0.0, 16.0),
    size("panelRadius", 0.0, 16.0),
    size("panelPad", 4.0, 16.0),
    size("controlRadius", 0.0, 12.0),
    size("padRadius", 0.0, 12.0),
    size("controlHeight", 20.0, 32.0),
    size("titlebarHeight", 28.0, 48.0),
    size("wavePlayedAlpha", 0.2, 1.0),
];

/// Base look a skin builds on (`STYLE_LOOKS`).
pub const STYLE_LOOKS: &[&str] = &["signature", "classic"];
/// How the waves panel arranges the decks (`STYLE_WAVES`).
pub const STYLE_WAVES: &[&str] = &["stacked", "overlay"];

/// A validated `style` block. Serialises with the exact keys of the TS `PackStyle`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackStyle {
    /// `signature` (default) or `classic`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub look: Option<String>,
    /// Show the virtual platter in the decks while the skin is active.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platter: Option<bool>,
    /// Layout to switch to with the skin: a built-in id or one bundled in the same pack.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
    /// `stacked` (default) or `overlay`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waves: Option<String>,
    /// [`STYLE_COLOR_KEYS`] key -> colour (the grammar of [`valid_color`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colors: Option<BTreeMap<String, String>>,
    /// [`STYLE_SIZES`] key -> number inside its range.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sizes: Option<BTreeMap<String, f64>>,
}

/// `^[a-z0-9][a-z0-9._-]{0,47}$` (`LAYOUT_ID_RE` in style-vars.ts).
pub fn valid_style_layout_id(id: &str) -> bool {
    let b = id.as_bytes();
    (1..=48).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..].iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

/// A `style.colors` value: the bounded grammar of every other pack colour ([`valid_color`])
/// minus the two forms the renderer's own check in style-vars.ts (`isStyleColor`) does not
/// take: signed numbers (`oklch(-0 0 0)`) and non-ASCII whitespace between the numbers. So a
/// colour accepted here is always applied by the UI.
pub fn valid_style_color(c: &str) -> bool {
    c.is_ascii() && !c.contains('-') && valid_color(c)
}

/// Problems of a `style` block; empty = valid. Same checks, messages and order as `validateStyle`
/// in style-vars.ts, with two deliberate differences: colours go through [`valid_style_color`]
/// (the bounded grammar of every other pack colour: stricter than the TS regex, which also takes
/// surrounding spaces and out-of-range L / C / H), and several bad entries of one object may be
/// reported in key order instead of file order (a JSON object has no order here).
pub fn validate_style(raw: &Value) -> Vec<String> {
    let s = match raw {
        Value::Null => return Vec::new(),
        Value::Object(m) => m,
        _ => return vec!["style must be an object".into()],
    };
    let mut errs = Vec::new();
    for k in s.keys() {
        if !STYLE_KEYS.contains(&k.as_str()) {
            errs.push(format!("unknown style key '{}'", short(k)));
        }
    }
    let one_of = |key: &str, allowed: &[&str]| {
        s.get(key)
            .is_none_or(|v| v.as_str().is_some_and(|x| allowed.contains(&x)))
    };
    if !one_of("look", STYLE_LOOKS) {
        errs.push("style.look must be signature or classic".into());
    }
    if s.get("platter").is_some_and(|v| !v.is_boolean()) {
        errs.push("style.platter must be true or false".into());
    }
    if s.get("layout")
        .is_some_and(|v| !v.as_str().is_some_and(valid_style_layout_id))
    {
        errs.push("style.layout must be a layout id (a-z, 0-9, '.', '_', '-'; max 48)".into());
    }
    if !one_of("waves", STYLE_WAVES) {
        errs.push("style.waves must be stacked or overlay".into());
    }
    match s.get("colors") {
        None => {}
        Some(Value::Object(m)) => {
            for (k, v) in m {
                if !STYLE_COLOR_KEYS.contains(&k.as_str()) {
                    errs.push(format!("unknown style colour '{}'", short(k)));
                } else if !v.as_str().is_some_and(valid_style_color) {
                    errs.push(format!("style.colors.{k} must be a valid colour"));
                }
            }
        }
        Some(_) => errs.push("style.colors must be an object".into()),
    }
    match s.get("sizes") {
        None => {}
        Some(Value::Object(m)) => {
            for (k, v) in m {
                let Some(spec) = STYLE_SIZES.iter().find(|x| x.key == k) else {
                    errs.push(format!("unknown style size '{}'", short(k)));
                    continue;
                };
                let ok = v
                    .as_f64()
                    .is_some_and(|n| (spec.min..=spec.max).contains(&n));
                if !ok {
                    errs.push(format!(
                        "style.sizes.{k} must be a number in {}..{}",
                        spec.min, spec.max
                    ));
                }
            }
        }
        Some(_) => errs.push("style.sizes must be an object".into()),
    }
    errs
}

/// Validate a `style` value and turn it into a [`PackStyle`]. `null` = no style block. Every
/// problem is reported at once, joined with `; `.
pub fn parse_style(raw: &Value) -> Result<Option<PackStyle>, String> {
    let errs = validate_style(raw);
    if !errs.is_empty() {
        return Err(errs.join("; "));
    }
    let Some(s) = raw.as_object() else {
        return Ok(None);
    };
    let text = |k: &str| s.get(k).and_then(Value::as_str).map(str::to_owned);
    let colors: BTreeMap<String, String> = s
        .get("colors")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
        .collect();
    let sizes: BTreeMap<String, f64> = s
        .get("sizes")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| Some((k.clone(), v.as_f64()?)))
        .collect();
    Ok(Some(PackStyle {
        look: text("look"),
        platter: s.get("platter").and_then(Value::as_bool),
        layout: text("layout"),
        waves: text("waves"),
        colors: (!colors.is_empty()).then_some(colors),
        sizes: (!sizes.is_empty()).then_some(sizes),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const STYLE_VARS_TS: &str = include_str!("../../../../src/look/style-vars.ts");

    /// The body of `export const <name> = { ... } as const;` in style-vars.ts, one entry per line.
    fn ts_block(name: &str) -> Vec<&'static str> {
        let head = format!("export const {name} = {{");
        let start = STYLE_VARS_TS
            .find(&head)
            .unwrap_or_else(|| panic!("{name} not found in style-vars.ts"))
            + head.len();
        let end = STYLE_VARS_TS[start..]
            .find("} as const;")
            .unwrap_or_else(|| panic!("{name} has no end"));
        STYLE_VARS_TS[start..start + end]
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("//"))
            .collect()
    }

    /// The Rust tables are the TS tables: same keys in the same order, same ranges.
    #[test]
    fn lists_match_style_vars_ts() {
        let colors: Vec<&str> = ts_block("STYLE_COLORS")
            .into_iter()
            .map(|l| l.split(':').next().unwrap().trim())
            .collect();
        assert_eq!(colors, STYLE_COLOR_KEYS);
        let sizes = ts_block("STYLE_SIZES");
        assert_eq!(sizes.len(), STYLE_SIZES.len(), "{sizes:?}");
        for (line, spec) in sizes.iter().zip(STYLE_SIZES) {
            assert!(line.starts_with(&format!("{}: {{", spec.key)), "{line}");
            let range = format!("min: {}, max: {},", spec.min, spec.max);
            assert!(line.contains(&range), "{line} should have {range}");
        }
        for (list, name) in [(STYLE_LOOKS, "STYLE_LOOKS"), (STYLE_WAVES, "STYLE_WAVES")] {
            let quoted: Vec<String> = list.iter().map(|x| format!("\"{x}\"")).collect();
            let decl = format!("export const {name} = [{}] as const;", quoted.join(", "));
            assert!(STYLE_VARS_TS.contains(&decl), "{decl}");
        }
        assert!(STYLE_VARS_TS.contains("/^[a-z0-9][a-z0-9._-]{0,47}$/"));
        let keys: Vec<String> = STYLE_KEYS.iter().map(|x| format!("\"{x}\"")).collect();
        assert!(STYLE_VARS_TS.contains(&format!("[{}].includes(k)", keys.join(", "))));
    }

    #[test]
    fn absent_and_empty_styles_are_valid() {
        assert_eq!(validate_style(&Value::Null), [] as [&str; 0]);
        assert_eq!(parse_style(&Value::Null), Ok(None));
        assert_eq!(parse_style(&json!({})), Ok(Some(PackStyle::default())));
        // Empty maps carry nothing: they are not echoed back.
        let s = parse_style(&json!({ "colors": {}, "sizes": {} })).unwrap();
        assert_eq!(s, Some(PackStyle::default()));
    }

    #[test]
    fn every_rejection_uses_the_ts_message() {
        let long = "a".repeat(49);
        let cases = [
            (json!([]), "style must be an object"),
            (json!("classic"), "style must be an object"),
            (json!({ "glow": 1 }), "unknown style key 'glow'"),
            (
                json!({ "look": "neon" }),
                "style.look must be signature or classic",
            ),
            (
                json!({ "look": null }),
                "style.look must be signature or classic",
            ),
            (
                json!({ "platter": "yes" }),
                "style.platter must be true or false",
            ),
            (
                json!({ "layout": "Pro Vertical" }),
                "style.layout must be a layout id (a-z, 0-9, '.', '_', '-'; max 48)",
            ),
            (
                json!({ "layout": long }),
                "style.layout must be a layout id (a-z, 0-9, '.', '_', '-'; max 48)",
            ),
            (
                json!({ "layout": "_pro" }),
                "style.layout must be a layout id (a-z, 0-9, '.', '_', '-'; max 48)",
            ),
            (
                json!({ "layout": 7 }),
                "style.layout must be a layout id (a-z, 0-9, '.', '_', '-'; max 48)",
            ),
            (
                json!({ "waves": "mirror" }),
                "style.waves must be stacked or overlay",
            ),
            (json!({ "colors": [] }), "style.colors must be an object"),
            (json!({ "colors": null }), "style.colors must be an object"),
            (
                json!({ "colors": { "sparkle": "#ffffff" } }),
                "unknown style colour 'sparkle'",
            ),
            (
                json!({ "colors": { "toString": "#ffffff" } }),
                "unknown style colour 'toString'",
            ),
            (
                json!({ "colors": { "well": "red" } }),
                "style.colors.well must be a valid colour",
            ),
            (
                json!({ "colors": { "well": "url(https://x/y.png)" } }),
                "style.colors.well must be a valid colour",
            ),
            (
                json!({ "colors": { "waveBg": "oklch(2 0.1 30)" } }),
                "style.colors.waveBg must be a valid colour",
            ),
            (
                json!({ "colors": { "waveBg": "oklch(-0 0 0)" } }),
                "style.colors.waveBg must be a valid colour",
            ),
            (
                json!({ "colors": { "waveBg": " #ffffff" } }),
                "style.colors.waveBg must be a valid colour",
            ),
            (
                json!({ "colors": { "waveBg": "oklch(0.5\u{85}0.1 30)" } }),
                "style.colors.waveBg must be a valid colour",
            ),
            (
                json!({ "colors": { "waveBg": "oklch(0.5\u{a0}0.1 30)" } }),
                "style.colors.waveBg must be a valid colour",
            ),
            (
                json!({ "colors": { "cue1": 16711680 } }),
                "style.colors.cue1 must be a valid colour",
            ),
            (json!({ "sizes": "big" }), "style.sizes must be an object"),
            (
                json!({ "sizes": { "zoom": 2 } }),
                "unknown style size 'zoom'",
            ),
            (
                json!({ "sizes": { "panelGap": 17 } }),
                "style.sizes.panelGap must be a number in 0..16",
            ),
            (
                json!({ "sizes": { "panelGap": -1 } }),
                "style.sizes.panelGap must be a number in 0..16",
            ),
            (
                json!({ "sizes": { "panelPad": "8" } }),
                "style.sizes.panelPad must be a number in 4..16",
            ),
            (
                json!({ "sizes": { "controlHeight": 19.9 } }),
                "style.sizes.controlHeight must be a number in 20..32",
            ),
            (
                json!({ "sizes": { "titlebarHeight": 49 } }),
                "style.sizes.titlebarHeight must be a number in 28..48",
            ),
            (
                json!({ "sizes": { "wavePlayedAlpha": 0.1 } }),
                "style.sizes.wavePlayedAlpha must be a number in 0.2..1",
            ),
        ];
        for (raw, want) in cases {
            assert_eq!(validate_style(&raw), [want], "{raw}");
            assert_eq!(parse_style(&raw), Err(want.to_string()), "{raw}");
        }
    }

    #[test]
    fn problems_come_in_the_ts_order() {
        let raw = json!({
            "zzz": 1,
            "sizes": { "panelGap": -1 },
            "colors": { "well": "red" },
            "waves": "x",
            "layout": "",
            "platter": 1,
            "look": "x",
        });
        let want = [
            "unknown style key 'zzz'",
            "style.look must be signature or classic",
            "style.platter must be true or false",
            "style.layout must be a layout id (a-z, 0-9, '.', '_', '-'; max 48)",
            "style.waves must be stacked or overlay",
            "style.colors.well must be a valid colour",
            "style.sizes.panelGap must be a number in 0..16",
        ];
        assert_eq!(validate_style(&raw), want);
        assert_eq!(parse_style(&raw), Err(want.join("; ")));
    }

    #[test]
    fn range_ends_and_every_key_are_accepted() {
        for spec in STYLE_SIZES {
            for v in [spec.min, spec.max] {
                let raw = json!({ "sizes": { (spec.key): v } });
                assert_eq!(validate_style(&raw), [] as [&str; 0], "{raw}");
            }
            let step = (spec.max - spec.min) / 1000.0;
            for v in [spec.min - step, spec.max + step] {
                let raw = json!({ "sizes": { (spec.key): v } });
                assert_eq!(validate_style(&raw).len(), 1, "{raw}");
            }
        }
        for key in STYLE_COLOR_KEYS {
            let raw = json!({ "colors": { (*key): "oklch(0.7 0.2 30 / 0.5)" } });
            assert_eq!(validate_style(&raw), [] as [&str; 0], "{raw}");
        }
        let longest = "a".repeat(48);
        for id in ["pro", "pro-vertical", "a", "0.x_y-z", longest.as_str()] {
            assert!(valid_style_layout_id(id), "{id}");
        }
        for id in ["", "Pro", "-pro", ".pro", "pro vertical", "pack/main", "é"] {
            assert!(!valid_style_layout_id(id), "{id}");
        }
    }

    #[test]
    fn parsed_style_serialises_like_the_ts_type() {
        let raw = json!({
            "look": "classic",
            "platter": true,
            "layout": "pro-vertical",
            "waves": "overlay",
            "colors": { "wavePlayheadCap": "#ff0000", "onFg": "#001b08" },
            "sizes": { "wavePlayedAlpha": 0.45, "panelGap": 8.0 },
        });
        let style = parse_style(&raw).unwrap().unwrap();
        assert_eq!(style.look.as_deref(), Some("classic"));
        assert_eq!(style.platter, Some(true));
        assert_eq!(style.sizes.as_ref().unwrap()["panelGap"], 8.0);
        assert_eq!(serde_json::to_value(&style).unwrap(), raw);
        // Absent fields are left out, never `null`.
        let only = parse_style(&json!({ "platter": false })).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&only).unwrap(),
            json!({ "platter": false })
        );
    }
}
