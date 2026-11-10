//! `.mixaipack` packs + zero-scroll layout solver over FFI (`decks-packs`, `decks-layout`,
//! WP19-34). Archive guards, Ed25519 trust and the solver live once in Rust for Kotlin and Swift;
//! the Tauri renderer keeps its TS solver, held in lockstep by docs/decks/fixtures/layout-cases.json.
//!
//! * `pack_inspect(bytes)` -> [`PackSummary`] (records + the full `info_json`, the TS `PackInfo`).
//! * [`PackStore`] object: `new(dir)`, `install`, `list`, `remove`.
//! * `layout_solve(layout_json, w, h, available)` -> [`LayoutSolution`]; panels the host app does
//!   not render (not in `available`) always go to the dock. Sizes are dp / pt.
//! * `layout_validate`, `layout_minimum_size`, `layout_presets_json`, `pack_layouts_json`.
//! * `pack_resolve_colors(tokens_json)` -> `[(key, 0xRRGGBB, alpha)]`, so native code never parses
//!   `oklch(...)`.

use decks_layout as dl;
use decks_packs as dp;
use serde_json::Value;

use crate::DecksError;

fn pack_err(reason: impl Into<String>) -> DecksError {
    DecksError::Pack {
        reason: reason.into(),
    }
}

// ---- packs --------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum PackTrustLevel {
    Official,
    Verified,
    Community,
    Unsigned,
}

impl From<dp::PackTrust> for PackTrustLevel {
    fn from(t: dp::PackTrust) -> Self {
        match t {
            dp::PackTrust::Official => Self::Official,
            dp::PackTrust::Verified => Self::Verified,
            dp::PackTrust::Community => Self::Community,
            dp::PackTrust::Unsigned => Self::Unsigned,
        }
    }
}

/// One resolved pack colour (`rgb` = `0xRRGGBB`).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PackColor {
    /// Token key (`primary`, `background`, `deck-a`, `accent`, ...; docs/decks/packs.md).
    pub key: String,
    pub rgb: u32,
    #[uniffi(default = 1.0)]
    pub alpha: f32,
}

/// A verified pack, flattened for native UIs. `info_json` carries everything else (the camelCase
/// `PackInfo` of the TS contract, including preview / asset data URLs).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PackSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    /// `skin`, `layout`, `bundle` or `controller`.
    pub kind: String,
    pub author: String,
    pub description: String,
    pub pro: bool,
    pub trust: PackTrustLevel,
    pub sha256: String,
    pub size: u64,
    /// Epoch ms; `None` for `pack_inspect` (not installed).
    #[uniffi(default = None)]
    pub installed_at: Option<u64>,
    /// `dark` / `light` when the pack sets a mode.
    #[uniffi(default = None)]
    pub mode: Option<String>,
    /// Named accent (`violet`) or a colour string.
    #[uniffi(default = None)]
    pub accent: Option<String>,
    /// Resolved colour overrides (empty when the pack sets none).
    pub colors: Vec<PackColor>,
    /// Valid layouts of the pack as a JSON array, ids namespaced `<packId>/<layoutId>`.
    pub layouts_json: String,
    /// Full `PackInfo` JSON (camelCase, same shape as the Tauri `pack_inspect` command).
    pub info_json: String,
}

fn colors_out(t: &dp::PackTokens) -> Vec<PackColor> {
    dp::resolve_colors(t)
        .into_iter()
        .map(|c| PackColor {
            key: c.key,
            rgb: c.rgb,
            alpha: c.alpha,
        })
        .collect()
}

fn summary(info: dp::PackInfo) -> Result<PackSummary, DecksError> {
    let info_json = serde_json::to_string(&info).map_err(|e| pack_err(e.to_string()))?;
    let layouts = info.layouts.as_deref().unwrap_or(&[]);
    let ns = dl::pack_layouts(&[dl::PackLayoutSource {
        pack_id: &info.manifest.id,
        layouts,
    }]);
    let layouts_json = serde_json::to_string(&ns).map_err(|e| pack_err(e.to_string()))?;
    let kind = serde_json::to_value(info.manifest.kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    let tokens = info.tokens.clone().unwrap_or_default();
    Ok(PackSummary {
        id: info.manifest.id,
        name: info.manifest.name,
        version: info.manifest.version,
        kind,
        author: info.manifest.author,
        description: info.manifest.description,
        pro: info.manifest.pro,
        trust: info.trust.into(),
        sha256: info.sha256,
        size: info.size,
        installed_at: info.installed_at,
        mode: tokens.mode.clone(),
        accent: tokens.accent.clone(),
        colors: colors_out(&tokens),
        layouts_json,
        info_json,
    })
}

/// Validate + verify a `.mixaipack` (archive guards, signature, manifest, tokens, layouts).
/// Pure: nothing is written.
#[uniffi::export]
pub fn pack_inspect(bytes: Vec<u8>) -> Result<PackSummary, DecksError> {
    summary(dp::inspect(&bytes).map_err(pack_err)?)
}

/// Resolve a pack `tokens.json` (flat or DTCG) or a `PackInfo.tokens` JSON object to sRGB.
/// Invalid colours are refused by validation, never silently dropped.
#[uniffi::export]
pub fn pack_resolve_colors(tokens_json: String) -> Result<Vec<PackColor>, DecksError> {
    let v: Value = serde_json::from_str(&tokens_json).map_err(|e| pack_err(e.to_string()))?;
    let obj = v
        .as_object()
        .ok_or_else(|| pack_err("tokens must be an object"))?;
    let mut t = dp::PackTokens::default();
    let colors =
        |key: &str| -> Result<Option<std::collections::BTreeMap<String, String>>, DecksError> {
            match obj.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::Object(m)) => m
                    .iter()
                    .filter(|(k, _)| !k.starts_with('$'))
                    .map(|(k, v)| {
                        let s = v
                            .as_str()
                            .or_else(|| v.get("$value").and_then(Value::as_str))
                            .ok_or_else(|| pack_err(format!("colour '{k}' must be a string")))?;
                        if !dp::valid_color(s) {
                            return Err(pack_err(format!("colour '{k}' is not a valid colour")));
                        }
                        Ok((k.clone(), s.to_owned()))
                    })
                    .collect::<Result<_, _>>()
                    .map(Some),
                Some(_) => Err(pack_err(format!("tokens.{key} must be an object"))),
            }
        };
    let mut merged = colors("color")?.unwrap_or_default();
    merged.extend(colors("colors")?.unwrap_or_default());
    t.colors = (!merged.is_empty()).then_some(merged);
    t.decks = colors("decks")?;
    t.accent = obj.get("accent").and_then(Value::as_str).map(str::to_owned);
    Ok(colors_out(&t))
}

/// Installed packs under one directory (`<dir>/<id>.mixaipack` + `index.json`); every archive
/// is re-verified on `list`.
#[derive(uniffi::Object)]
pub struct PackStore {
    inner: dp::PackStore,
}

#[uniffi::export]
impl PackStore {
    /// Store in `dir` (created on the first install).
    #[uniffi::constructor]
    pub fn new(dir: String) -> Self {
        Self {
            inner: dp::PackStore::new(dir),
        }
    }

    pub fn dir(&self) -> String {
        self.inner.dir().to_string_lossy().into_owned()
    }

    /// Validate, verify and store; a less trusted pack never replaces one with the same id.
    pub fn install(&self, bytes: Vec<u8>) -> Result<PackSummary, DecksError> {
        summary(self.inner.install(&bytes).map_err(pack_err)?)
    }

    /// Installed packs that still verify (tampered or invalid archives are skipped).
    pub fn list(&self) -> Vec<PackSummary> {
        self.inner
            .list()
            .into_iter()
            .filter_map(|p| summary(p).ok())
            .collect()
    }

    /// Delete a pack (no error when it is not installed).
    pub fn remove(&self, id: String) -> Result<(), DecksError> {
        self.inner.remove(&id).map_err(pack_err)
    }

    /// Valid layouts of every installed pack, namespaced `<packId>/<layoutId>`, as a JSON array.
    pub fn layouts_json(&self) -> String {
        let infos = self.inner.list();
        let sources: Vec<dl::PackLayoutSource<'_>> = infos
            .iter()
            .map(|i| dl::PackLayoutSource {
                pack_id: &i.manifest.id,
                layouts: i.layouts.as_deref().unwrap_or(&[]),
            })
            .collect();
        serde_json::to_string(&dl::pack_layouts(&sources)).unwrap_or_else(|_| "[]".into())
    }
}

// ---- layout -------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LayoutPanel {
    DeckA,
    DeckB,
    DeckC,
    DeckD,
    Clock,
    Mixer,
    Crossfader,
    Library,
    Automix,
    Sampler,
    Plugins,
}

impl From<dl::PanelId> for LayoutPanel {
    fn from(p: dl::PanelId) -> Self {
        match p {
            dl::PanelId::DeckA => Self::DeckA,
            dl::PanelId::DeckB => Self::DeckB,
            dl::PanelId::DeckC => Self::DeckC,
            dl::PanelId::DeckD => Self::DeckD,
            dl::PanelId::Clock => Self::Clock,
            dl::PanelId::Mixer => Self::Mixer,
            dl::PanelId::Crossfader => Self::Crossfader,
            dl::PanelId::Library => Self::Library,
            dl::PanelId::Automix => Self::Automix,
            dl::PanelId::Sampler => Self::Sampler,
            dl::PanelId::Plugins => Self::Plugins,
        }
    }
}

impl From<LayoutPanel> for dl::PanelId {
    fn from(p: LayoutPanel) -> Self {
        match p {
            LayoutPanel::DeckA => Self::DeckA,
            LayoutPanel::DeckB => Self::DeckB,
            LayoutPanel::DeckC => Self::DeckC,
            LayoutPanel::DeckD => Self::DeckD,
            LayoutPanel::Clock => Self::Clock,
            LayoutPanel::Mixer => Self::Mixer,
            LayoutPanel::Crossfader => Self::Crossfader,
            LayoutPanel::Library => Self::Library,
            LayoutPanel::Automix => Self::Automix,
            LayoutPanel::Sampler => Self::Sampler,
            LayoutPanel::Plugins => Self::Plugins,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LayoutTier {
    Full,
    Compact,
    Icon,
}

impl From<dl::Tier> for LayoutTier {
    fn from(t: dl::Tier) -> Self {
        match t {
            dl::Tier::Full => Self::Full,
            dl::Tier::Compact => Self::Compact,
            dl::Tier::Icon => Self::Icon,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct LayoutRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl From<dl::Rect> for LayoutRect {
    fn from(r: dl::Rect) -> Self {
        Self {
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
        }
    }
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LayoutPlacement {
    pub panel: LayoutPanel,
    pub rect: LayoutRect,
    pub tier: LayoutTier,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LayoutSolution {
    pub placements: Vec<LayoutPlacement>,
    /// Panels that did not fit or that the host does not render: tabs in the dock slot.
    pub docked: Vec<LayoutPanel>,
    #[uniffi(default = None)]
    pub dock: Option<LayoutRect>,
}

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct LayoutSize {
    pub w: f64,
    pub h: f64,
}

fn parse_layout(layout_json: &str) -> Result<dl::LayoutDoc, DecksError> {
    let raw: Value = serde_json::from_str(layout_json)
        .map_err(|e| pack_err(format!("layout is not valid JSON: {e}")))?;
    dl::parse_layout(&raw).map_err(|errs| pack_err(format!("invalid layout: {}", errs.join("; "))))
}

/// Solve a layout (LayoutDoc JSON) for a `w` x `h` container (dp / pt). Panels missing from
/// `available` (the ones the host app does not render) always go to the dock.
#[uniffi::export]
pub fn layout_solve(
    layout_json: String,
    w: f64,
    h: f64,
    available: Vec<LayoutPanel>,
) -> Result<LayoutSolution, DecksError> {
    if !(w.is_finite() && h.is_finite()) || w < 0.0 || h < 0.0 {
        return Err(DecksError::invalid("layout size must be finite and >= 0"));
    }
    let layout = parse_layout(&layout_json)?;
    let avail: Vec<dl::PanelId> = available.into_iter().map(Into::into).collect();
    let s = dl::solve_with(&layout, w, h, &dl::PANEL_SPECS, &avail);
    Ok(LayoutSolution {
        placements: s
            .placements
            .into_iter()
            .map(|p| LayoutPlacement {
                panel: p.panel.into(),
                rect: p.rect.into(),
                tier: p.tier.into(),
            })
            .collect(),
        docked: s.docked.into_iter().map(Into::into).collect(),
        dock: s.dock.map(Into::into),
    })
}

/// Validation errors (English, same messages as the desktop editor); empty = valid.
#[uniffi::export]
pub fn layout_validate(layout_json: String) -> Vec<String> {
    match serde_json::from_str::<Value>(&layout_json) {
        Ok(v) => dl::validate_layout(&v, &dl::PANEL_IDS),
        Err(e) => vec![format!("not valid JSON: {e}")],
    }
}

/// Smallest container at which every essential panel fits its icon tier (window minimum).
#[uniffi::export]
pub fn layout_minimum_size(layout_json: String) -> Result<LayoutSize, DecksError> {
    let s = dl::minimum_size(&parse_layout(&layout_json)?);
    Ok(LayoutSize { w: s.w, h: s.h })
}

/// Built-in presets (classic, performance, library, four-deck, ultrawide, stage) as a JSON array.
#[uniffi::export]
pub fn layout_presets_json() -> String {
    serde_json::to_string(&dl::all_presets()).unwrap_or_else(|_| "[]".into())
}
