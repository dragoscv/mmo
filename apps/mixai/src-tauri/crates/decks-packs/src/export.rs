//! Build an unsigned skin `.mixaipack` from what a skin editor produced (Decks 1.5): the Tauri
//! commands `pack_build` / `pack_export` (`src-tauri/src/pack.rs`) are thin wrappers over
//! [`build_skin_pack`]. TS contract: `PackExportRequest` in `src/bridge/packs.ts`.
//!
//! The archive holds `manifest.json` (`v: 2`, `kind: "skin"`, `pro: false`,
//! `tokens: "tokens.json"`) and `tokens.json`, and no `signature.json`, so it inspects as
//! [`PackTrust::Unsigned`](crate::PackTrust). Before the bytes are returned they go through
//! [`inspect`], the validation every install runs, so a pack that was built is a pack that
//! inspects (ids, text lengths, version, every token and the `style` block).

use std::io::{Cursor, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{MANIFEST_FILE, PackInfo, PackKind, PackManifest, STYLE_MANIFEST_VERSION, inspect};

/// Name of the tokens file inside a built skin pack.
pub const EXPORT_TOKENS_FILE: &str = "tokens.json";
/// File extension of a pack (without the dot).
pub const PACK_EXTENSION: &str = "mixaipack";

/// Input of [`build_skin_pack`] (camelCase JSON, unknown fields refused).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackExportRequest {
    /// Reverse-DNS-ish id, e.g. `user.skin.my-booth` (`ro.mixai.*` is reserved for official packs).
    pub id: String,
    pub name: String,
    pub author: String,
    #[serde(default)]
    pub description: String,
    /// `MAJOR.MINOR.PATCH`.
    pub version: String,
    /// The `tokens.json` content: the flat `PackTokens` shape, optionally with a `style` block.
    pub tokens: Value,
}

/// Default file name for a pack with this id: `<id>.mixaipack`.
pub fn export_file_name(id: &str) -> String {
    format!("{id}.{PACK_EXTENSION}")
}

/// Pretty JSON with a trailing newline (the form the Skin SDK writes).
fn pretty<T: Serialize>(v: &T) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Build the archive and return it together with what [`inspect`] reads back from it.
///
/// Deterministic: the same request gives the same bytes (fixed entry order and timestamps), so
/// the pack's SHA-256 only changes when its content does.
pub fn build_skin_pack_info(req: &PackExportRequest) -> Result<(Vec<u8>, PackInfo), String> {
    let manifest = PackManifest {
        v: STYLE_MANIFEST_VERSION,
        id: req.id.clone(),
        name: req.name.clone(),
        version: req.version.clone(),
        kind: PackKind::Skin,
        author: req.author.clone(),
        description: req.description.clone(),
        pro: false,
        tokens: Some(EXPORT_TOKENS_FILE.to_owned()),
        layouts: None,
        presets: None,
        preview: None,
        fonts: None,
    };
    let manifest_json = pretty(&manifest)?;
    let tokens_json = pretty(&req.tokens)?;
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .last_modified_time(zip::DateTime::DEFAULT);
    for (name, bytes) in [
        (MANIFEST_FILE, manifest_json.as_slice()),
        (EXPORT_TOKENS_FILE, tokens_json.as_slice()),
    ] {
        w.start_file(name, opts).map_err(|e| e.to_string())?;
        w.write_all(bytes).map_err(|e| e.to_string())?;
    }
    let bytes = w.finish().map_err(|e| e.to_string())?.into_inner();
    let info = inspect(&bytes)?;
    Ok((bytes, info))
}

/// Build an unsigned skin `.mixaipack` in memory. Refused (readable English reason) when the
/// request would not pass [`inspect`].
pub fn build_skin_pack(req: &PackExportRequest) -> Result<Vec<u8>, String> {
    build_skin_pack_info(req).map(|(bytes, _)| bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PackStore, PackTrust};
    use serde_json::json;

    fn tokens() -> Value {
        json!({
            "mode": "dark",
            "surface": "solid",
            "density": "compact",
            "radius": "sm",
            "accent": "#00d37f",
            "colors": { "background": "#050607", "primary": "oklch(0.8 0.2 150)" },
            "decks": { "a": "#00e5ff", "b": "#ff2bd6" },
            "fontHeading": "Inter",
            "fontBody": "Inter",
            "style": {
                "look": "classic",
                "platter": true,
                "layout": "pro-vertical",
                "waves": "overlay",
                "colors": {
                    "well": "#0b0d0f",
                    "waveLow": "oklch(0.6 0.2 250)",
                    "waveMid": "#33cc88",
                    "waveHigh": "#ffffffcc",
                    "cue1": "#ff0000",
                    "cue8": "#00ff00"
                },
                "sizes": {
                    "panelGap": 6.5,
                    "panelRadius": 0.0,
                    "panelPad": 16.0,
                    "controlRadius": 2.5,
                    "padRadius": 12.0,
                    "controlHeight": 24.5,
                    "titlebarHeight": 28.0,
                    "wavePlayedAlpha": 0.45
                }
            }
        })
    }

    fn request() -> PackExportRequest {
        PackExportRequest {
            id: "user.skin.my-booth".into(),
            name: "My booth".into(),
            author: "Someone".into(),
            description: "Made in the skin editor".into(),
            version: "1.2.3".into(),
            tokens: tokens(),
        }
    }

    fn with_tokens(tokens: Value) -> PackExportRequest {
        PackExportRequest {
            tokens,
            ..request()
        }
    }

    #[test]
    fn built_skin_inspects_with_the_same_tokens() {
        let (bytes, info) = build_skin_pack_info(&request()).unwrap();
        assert_eq!(info.trust, PackTrust::Unsigned);
        let m = &info.manifest;
        assert_eq!(m.v, 2);
        assert_eq!(m.kind, PackKind::Skin);
        assert!(!m.pro);
        assert_eq!(m.id, "user.skin.my-booth");
        assert_eq!(m.name, "My booth");
        assert_eq!(m.author, "Someone");
        assert_eq!(m.description, "Made in the skin editor");
        assert_eq!(m.version, "1.2.3");
        assert_eq!(m.tokens.as_deref(), Some("tokens.json"));
        assert!(m.layouts.is_none() && m.preview.is_none() && m.fonts.is_none());
        // What the UI gets back is what the editor sent, style block included.
        assert_eq!(serde_json::to_value(&info.tokens).unwrap(), tokens());
        // The plain inspect path (what install runs) agrees.
        assert_eq!(inspect(&bytes).unwrap(), info);
        assert_eq!(build_skin_pack(&request()).unwrap(), bytes);
    }

    #[test]
    fn archive_holds_exactly_manifest_and_tokens() {
        let bytes = build_skin_pack(&request()).unwrap();
        let mut z = zip::ZipArchive::new(Cursor::new(bytes.as_slice())).unwrap();
        let names: Vec<String> = (0..z.len())
            .map(|i| z.by_index(i).unwrap().name().unwrap().into_owned())
            .collect();
        assert_eq!(names, ["manifest.json", "tokens.json"]);
        let manifest: Value = serde_json::from_reader(z.by_name("manifest.json").unwrap()).unwrap();
        assert_eq!(
            manifest,
            json!({
                "v": 2,
                "id": "user.skin.my-booth",
                "name": "My booth",
                "version": "1.2.3",
                "kind": "skin",
                "author": "Someone",
                "description": "Made in the skin editor",
                "pro": false,
                "tokens": "tokens.json"
            })
        );
        let written: Value = serde_json::from_reader(z.by_name("tokens.json").unwrap()).unwrap();
        assert_eq!(written, tokens());
    }

    #[test]
    fn same_request_gives_the_same_bytes() {
        let a = build_skin_pack(&request()).unwrap();
        assert_eq!(a, build_skin_pack(&request()).unwrap());
        // Two builds in a row prove nothing about the clock (a zip entry time has a 2 s
        // resolution): what makes the bytes repeatable is the fixed time stored in every entry.
        let mut z = zip::ZipArchive::new(Cursor::new(a.as_slice())).unwrap();
        for i in 0..z.len() {
            let entry = z.by_index(i).unwrap();
            assert_eq!(
                entry.last_modified(),
                Some(zip::DateTime::DEFAULT),
                "{:?}",
                entry.name()
            );
        }
        let mut other = request();
        other.name = "Other".into();
        assert_ne!(a, build_skin_pack(&other).unwrap());
    }

    #[test]
    fn built_skin_installs() {
        let tmp = tempfile::tempdir().unwrap();
        let store = PackStore::new(tmp.path().join("packs"));
        let info = store
            .install(&build_skin_pack(&request()).unwrap())
            .unwrap();
        assert!(info.installed_at.is_some());
        let listed = store.list();
        assert_eq!(listed.len(), 1);
        let style = listed[0].tokens.as_ref().unwrap().style.as_ref().unwrap();
        assert_eq!(style.layout.as_deref(), Some("pro-vertical"));
        assert_eq!(style.sizes.as_ref().unwrap()["wavePlayedAlpha"], 0.45);
    }

    #[test]
    fn a_skin_without_a_style_block_builds_too() {
        let (_, info) = build_skin_pack_info(&with_tokens(json!({ "mode": "light" }))).unwrap();
        let t = info.tokens.unwrap();
        assert_eq!(t.mode.as_deref(), Some("light"));
        assert!(t.style.is_none());
        // `null` = absent, like every other optional token.
        let (_, info) = build_skin_pack_info(&with_tokens(json!({ "style": null }))).unwrap();
        assert!(info.tokens.unwrap().style.is_none());
    }

    #[test]
    fn invalid_tokens_are_refused() {
        let cases = [
            (json!("dark"), "tokens.json must be a JSON object"),
            (json!({ "glow": true }), "unknown token 'glow'"),
            (json!({ "mode": "sepia" }), "tokens.mode 'sepia'"),
            (
                json!({ "colors": { "primary": "url(https://x/y.png)" } }),
                "must be #rrggbb",
            ),
            (
                json!({ "colors": { "sparkle": "#ffffff" } }),
                "colour token 'sparkle' is not allowed",
            ),
            (
                json!({ "background": "assets/bg.webp" }),
                "tokens.background 'assets/bg.webp' is missing from the pack",
            ),
            (
                json!({ "style": { "sizes": { "panelGap": 17 } } }),
                "style.sizes.panelGap must be a number in 0..16",
            ),
            (
                json!({ "style": { "colors": { "well": "red" } } }),
                "style.colors.well must be a valid colour",
            ),
            (
                json!({ "style": { "layout": "Pro Vertical" } }),
                "style.layout must be a layout id",
            ),
            (
                json!({ "style": { "look": "neon" } }),
                "style.look must be signature or classic",
            ),
            (
                json!({ "style": { "glow": 1 } }),
                "unknown style key 'glow'",
            ),
        ];
        for (tokens, want) in cases {
            let err = build_skin_pack(&with_tokens(tokens.clone())).unwrap_err();
            assert!(err.contains(want), "{tokens}: {err}");
        }
    }

    #[test]
    fn invalid_identity_is_refused() {
        let mut bad_id = request();
        bad_id.id = "My Skin".into();
        assert!(
            build_skin_pack(&bad_id)
                .unwrap_err()
                .contains("manifest.id 'My Skin'")
        );
        let mut reserved = request();
        reserved.id = "ro.mixai.skin.fake".into();
        assert!(build_skin_pack(&reserved).unwrap_err().contains("reserved"));
        let mut author = request();
        author.author = "MixAI".into();
        assert!(build_skin_pack(&author).unwrap_err().contains("reserved"));
        let mut version = request();
        version.version = "1.0".into();
        assert!(
            build_skin_pack(&version)
                .unwrap_err()
                .contains("must be MAJOR.MINOR.PATCH")
        );
        let mut name = request();
        name.name = String::new();
        assert!(
            build_skin_pack(&name)
                .unwrap_err()
                .contains("manifest.name must be 1..60 characters")
        );
        let mut long = request();
        long.description = "x".repeat(501);
        assert!(
            build_skin_pack(&long)
                .unwrap_err()
                .contains("manifest.description must be 0..500 characters")
        );
    }

    #[test]
    fn request_json_is_camel_case_and_strict() {
        let req: PackExportRequest = serde_json::from_value(json!({
            "id": "user.skin.x",
            "name": "X",
            "author": "Me",
            "description": "",
            "version": "1.0.0",
            "tokens": { "mode": "dark" }
        }))
        .unwrap();
        assert_eq!(req.tokens, json!({ "mode": "dark" }));
        // `description` may be left out; anything unknown is refused.
        let short: Result<PackExportRequest, _> = serde_json::from_value(json!({
            "id": "user.skin.x", "name": "X", "author": "Me", "version": "1.0.0", "tokens": {}
        }));
        assert_eq!(short.unwrap().description, "");
        let extra: Result<PackExportRequest, _> = serde_json::from_value(json!({
            "id": "user.skin.x", "name": "X", "author": "Me", "version": "1.0.0", "tokens": {},
            "pro": true
        }));
        assert!(extra.unwrap_err().to_string().contains("unknown field"));
        assert_eq!(export_file_name("user.skin.x"), "user.skin.x.mixaipack");
    }
}
