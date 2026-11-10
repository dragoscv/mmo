//! Panel minimum sizes per tier and the built-in presets (mirror of
//! `apps/mixai/src/layout/presets.ts`). Sizes are CSS px = dp = pt.

use crate::types::{LayoutArea, LayoutDoc, PanelId, PanelSpec, Size};

const fn sz(w: f64, h: f64) -> Size {
    Size { w, h }
}

const fn deck(id: PanelId) -> PanelSpec {
    PanelSpec {
        id,
        full: sz(460.0, 560.0),
        compact: sz(340.0, 330.0),
        icon: sz(220.0, 150.0),
        essential: true,
    }
}

const fn spec(id: PanelId, full: Size, compact: Size, icon: Size, essential: bool) -> PanelSpec {
    PanelSpec {
        id,
        full,
        compact,
        icon,
        essential,
    }
}

/// Same order as `PANEL_IDS`.
pub const PANEL_SPECS: [PanelSpec; 11] = [
    deck(PanelId::DeckA),
    deck(PanelId::DeckB),
    deck(PanelId::DeckC),
    deck(PanelId::DeckD),
    spec(
        PanelId::Clock,
        sz(220.0, 72.0),
        sz(160.0, 40.0),
        sz(90.0, 28.0),
        false,
    ),
    spec(
        PanelId::Mixer,
        sz(240.0, 440.0),
        sz(200.0, 260.0),
        sz(150.0, 150.0),
        true,
    ),
    spec(
        PanelId::Crossfader,
        sz(220.0, 100.0),
        sz(180.0, 56.0),
        sz(140.0, 36.0),
        true,
    ),
    spec(
        PanelId::Library,
        sz(520.0, 240.0),
        sz(320.0, 160.0),
        sz(200.0, 96.0),
        false,
    ),
    spec(
        PanelId::Automix,
        sz(230.0, 230.0),
        sz(190.0, 130.0),
        sz(120.0, 56.0),
        false,
    ),
    spec(
        PanelId::Sampler,
        sz(270.0, 250.0),
        sz(200.0, 140.0),
        sz(120.0, 56.0),
        false,
    ),
    spec(
        PanelId::Plugins,
        sz(220.0, 160.0),
        sz(160.0, 96.0),
        sz(96.0, 48.0),
        false,
    ),
];

/// Panels every layout must contain (`validateLayout`).
pub const ESSENTIAL_REQUIRED: [PanelId; 3] = [PanelId::DeckA, PanelId::DeckB, PanelId::Mixer];

/// Spec of `id` in `specs`, falling back to the built-in table.
pub fn spec_of(specs: &[PanelSpec], id: PanelId) -> PanelSpec {
    specs
        .iter()
        .chain(PANEL_SPECS.iter())
        .find(|s| s.id == id)
        .copied()
        .unwrap_or(PANEL_SPECS[0])
}

fn area(panel: PanelId, col: usize, row: usize, col_span: usize, row_span: usize) -> LayoutArea {
    LayoutArea {
        panel,
        col,
        row,
        col_span: (col_span != 1).then_some(col_span),
        row_span: (row_span != 1).then_some(row_span),
    }
}

fn doc(id: &str, name: &str, columns: &[f64], rows: &[f64], areas: Vec<LayoutArea>) -> LayoutDoc {
    LayoutDoc {
        v: 1,
        id: id.into(),
        name: name.into(),
        columns: columns.to_vec(),
        rows: rows.to_vec(),
        areas,
        gap: None,
    }
}

use PanelId::*;

/// Classic: decks left/right, mixer centre, utility band below.
pub fn classic() -> LayoutDoc {
    doc(
        "classic",
        "Classic",
        &[5.0, 3.0, 5.0],
        &[1.0, 9.0, 2.0, 6.0],
        vec![
            area(DeckA, 0, 0, 1, 3),
            area(Clock, 1, 0, 1, 1),
            area(Mixer, 1, 1, 1, 1),
            area(Crossfader, 1, 2, 1, 1),
            area(DeckB, 2, 0, 1, 3),
            area(Library, 0, 3, 2, 1),
            area(Automix, 2, 3, 1, 1),
        ],
    )
}

/// Performance: decks take the height; library becomes a strip.
pub fn performance() -> LayoutDoc {
    doc(
        "performance",
        "Performance",
        &[5.0, 3.0, 5.0],
        &[1.0, 9.0, 2.0, 3.0],
        vec![
            area(DeckA, 0, 0, 1, 4),
            area(Clock, 1, 0, 1, 1),
            area(Mixer, 1, 1, 1, 1),
            area(Crossfader, 1, 2, 1, 1),
            area(Sampler, 1, 3, 1, 1),
            area(DeckB, 2, 0, 1, 4),
        ],
    )
}

/// Library: browsing first, decks condensed above.
pub fn library() -> LayoutDoc {
    doc(
        "library",
        "Library",
        &[5.0, 3.0, 5.0],
        &[6.0, 2.0, 9.0],
        vec![
            area(DeckA, 0, 0, 1, 2),
            area(Mixer, 1, 0, 1, 1),
            area(Crossfader, 1, 1, 1, 1),
            area(DeckB, 2, 0, 1, 2),
            area(Library, 0, 2, 2, 1),
            area(Automix, 2, 2, 1, 1),
        ],
    )
}

/// Four decks (wide windows).
pub fn four_deck() -> LayoutDoc {
    doc(
        "four-deck",
        "4 decks",
        &[4.0, 4.0, 3.0, 4.0, 4.0],
        &[1.0, 9.0, 2.0, 5.0],
        vec![
            area(DeckC, 0, 0, 1, 3),
            area(DeckA, 1, 0, 1, 3),
            area(Clock, 2, 0, 1, 1),
            area(Mixer, 2, 1, 1, 1),
            area(Crossfader, 2, 2, 1, 1),
            area(DeckB, 3, 0, 1, 3),
            area(DeckD, 4, 0, 1, 3),
            area(Library, 0, 3, 3, 1),
            area(Automix, 3, 3, 1, 1),
            area(Sampler, 4, 3, 1, 1),
        ],
    )
}

/// Ultra-wide: library + utilities in side columns.
pub fn ultrawide() -> LayoutDoc {
    doc(
        "ultrawide",
        "Ultra-wide",
        &[4.0, 5.0, 3.0, 5.0, 3.0],
        &[1.0, 9.0, 2.0, 4.0],
        vec![
            area(Library, 0, 0, 1, 4),
            area(DeckA, 1, 0, 1, 4),
            area(Clock, 2, 0, 1, 1),
            area(Mixer, 2, 1, 1, 1),
            area(Crossfader, 2, 2, 1, 1),
            area(Plugins, 2, 3, 1, 1),
            area(DeckB, 3, 0, 1, 4),
            area(Automix, 4, 0, 1, 2),
            area(Sampler, 4, 2, 1, 2),
        ],
    )
}

/// Stage mode: only the decks, mixer and crossfader.
pub fn stage() -> LayoutDoc {
    doc(
        "stage",
        "Stage",
        &[5.0, 2.0, 5.0],
        &[9.0, 2.0],
        vec![
            area(DeckA, 0, 0, 1, 2),
            area(Mixer, 1, 0, 1, 1),
            area(Crossfader, 1, 1, 1, 1),
            area(DeckB, 2, 0, 1, 2),
        ],
    )
}

/// `BUILTIN_LAYOUTS` of presets.ts (Stage is separate there too).
pub fn builtin_layouts() -> Vec<LayoutDoc> {
    vec![
        classic(),
        performance(),
        library(),
        four_deck(),
        ultrawide(),
    ]
}

/// Every preset the native apps offer: the built-ins plus Stage.
pub fn all_presets() -> Vec<LayoutDoc> {
    let mut v = builtin_layouts();
    v.push(stage());
    v
}
