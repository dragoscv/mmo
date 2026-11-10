//! Layout model (mirror of `apps/mixai/src/layout/types.ts`).

use serde::{Deserialize, Serialize};

/// Every panel a layout may name. Order = `PANEL_IDS` in types.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PanelId {
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

pub const PANEL_IDS: [PanelId; 11] = [
    PanelId::DeckA,
    PanelId::DeckB,
    PanelId::DeckC,
    PanelId::DeckD,
    PanelId::Clock,
    PanelId::Mixer,
    PanelId::Crossfader,
    PanelId::Library,
    PanelId::Automix,
    PanelId::Sampler,
    PanelId::Plugins,
];

impl PanelId {
    /// Wire name (`deckA`, `crossfader`, ...).
    pub fn as_str(self) -> &'static str {
        match self {
            PanelId::DeckA => "deckA",
            PanelId::DeckB => "deckB",
            PanelId::DeckC => "deckC",
            PanelId::DeckD => "deckD",
            PanelId::Clock => "clock",
            PanelId::Mixer => "mixer",
            PanelId::Crossfader => "crossfader",
            PanelId::Library => "library",
            PanelId::Automix => "automix",
            PanelId::Sampler => "sampler",
            PanelId::Plugins => "plugins",
        }
    }

    pub fn parse(s: &str) -> Option<PanelId> {
        PANEL_IDS.iter().copied().find(|p| p.as_str() == s)
    }
}

/// Richest first (the solver tries them in this order).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Full,
    Compact,
    Icon,
}

pub const TIERS: [Tier; 3] = [Tier::Full, Tier::Compact, Tier::Icon];

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Full => "full",
            Tier::Compact => "compact",
            Tier::Icon => "icon",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Size {
    pub w: f64,
    pub h: f64,
}

/// Minimum size (px = dp = pt) a panel needs to render a tier without overflow.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PanelSpec {
    pub id: PanelId,
    pub full: Size,
    pub compact: Size,
    pub icon: Size,
    /// Transport-critical panels are never docked.
    pub essential: bool,
}

impl PanelSpec {
    pub fn min(&self, tier: Tier) -> Size {
        match tier {
            Tier::Full => self.full,
            Tier::Compact => self.compact,
            Tier::Icon => self.icon,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutArea {
    pub panel: PanelId,
    pub col: usize,
    pub row: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub col_span: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_span: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayoutDoc {
    /// Schema version (1).
    pub v: u32,
    pub id: String,
    pub name: String,
    /// Column weights (fr).
    pub columns: Vec<f64>,
    /// Row weights (fr).
    pub rows: Vec<f64>,
    pub areas: Vec<LayoutArea>,
    /// Gap between cells in px (default 12).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn area(&self) -> f64 {
        self.w * self.h
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    pub panel: PanelId,
    pub rect: Rect,
    pub tier: Tier,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Solution {
    pub placements: Vec<Placement>,
    /// Panels that did not fit (or the host cannot render): tabs in the dock slot.
    pub docked: Vec<PanelId>,
    /// Rect of the dock slot, if any.
    pub dock: Option<Rect>,
}
