//! Zero-scroll layout solver: exact port of `apps/mixai/src/layout/solver.ts` (golden fixtures in
//! docs/decks/fixtures/layout-cases.json keep the two in lockstep).
//!
//! 1. Split the container into weighted columns/rows (fr semantics, fixed gap).
//! 2. Each area gets the union rect of its cells.
//! 3. Per panel, pick the richest tier whose minimum size fits that rect.
//! 4. A panel that fits no tier is docked: it becomes a tab in the dock host, the largest
//!    non-essential placed panel. Essential panels are never docked; they fall back to `icon`.
//!
//! Native extension ([`solve_with`]): panels the host app does not render are "unavailable" and
//! always go to the dock, whatever their size.

use serde_json::Value;

use crate::presets::{ESSENTIAL_REQUIRED, PANEL_SPECS, spec_of};
use crate::types::{
    LayoutDoc, PANEL_IDS, PanelId, PanelSpec, Placement, Rect, Size, Solution, TIERS, Tier,
};

pub const DEFAULT_GAP: f64 = 12.0;
/// fr math produces fractional sizes: a rect within half a pixel of a minimum still fits.
pub const FIT_TOLERANCE: f64 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Track {
    pub start: f64,
    pub size: f64,
}

/// Split `total` px into weighted tracks with `gap` px between them.
pub fn tracks(total: f64, weights: &[f64], gap: f64) -> Vec<Track> {
    let n = weights.len();
    if n == 0 {
        return Vec::new();
    }
    let mut sum = weights.iter().fold(0.0, |a, b| a + b.max(0.0));
    if sum == 0.0 {
        sum = n as f64;
    }
    let free = (total - gap * (n as f64 - 1.0)).max(0.0);
    let mut out = Vec::with_capacity(n);
    let mut at = 0.0;
    for w in weights {
        let size = (free * w.max(0.0)) / sum;
        out.push(Track { start: at, size });
        at += size + gap;
    }
    out
}

pub fn fits(rect: &Rect, min: Size) -> bool {
    rect.w + FIT_TOLERANCE >= min.w && rect.h + FIT_TOLERANCE >= min.h
}

pub fn pick_tier(rect: &Rect, spec: &PanelSpec) -> Option<Tier> {
    TIERS.into_iter().find(|t| fits(rect, spec.min(*t)))
}

fn track_at(tracks: &[Track], i: i64) -> Option<Track> {
    if i < 0 {
        return None;
    }
    tracks.get(i as usize).copied()
}

/// Solve with the built-in [`PANEL_SPECS`]; every panel is available.
pub fn solve(layout: &LayoutDoc, w: f64, h: f64) -> Solution {
    solve_with(layout, w, h, &PANEL_SPECS, &PANEL_IDS)
}

/// Solve with custom specs; panels not in `available` go straight to the dock.
pub fn solve_with(
    layout: &LayoutDoc,
    w: f64,
    h: f64,
    specs: &[PanelSpec],
    available: &[PanelId],
) -> Solution {
    let gap = layout.gap.unwrap_or(DEFAULT_GAP);
    let cols = tracks(w, &layout.columns, gap);
    let rows = tracks(h, &layout.rows, gap);
    let mut placements: Vec<Placement> = Vec::new();
    let mut docked: Vec<PanelId> = Vec::new();

    for a in &layout.areas {
        let col = a.col as i64;
        let row = a.row as i64;
        let cs = a.col_span.unwrap_or(1) as i64;
        let rs = a.row_span.unwrap_or(1) as i64;
        let c0 = track_at(&cols, col);
        let r0 = track_at(&rows, row);
        // Checked: col/colSpan come from untrusted pack JSON, and `col + cs - 1` on huge numbers
        // panics in debug across the FFI boundary (WP19-37 P1-11). An overflowing span reaches
        // past the last track, so clamp to it (c0 / r0 still reject an out-of-range start).
        let last = |start: i64, span: i64| {
            start
                .checked_add(span)
                .and_then(|e| e.checked_sub(1))
                .unwrap_or(i64::MAX)
        };
        let c1 = track_at(&cols, (cols.len() as i64 - 1).min(last(col, cs)));
        let r1 = track_at(&rows, (rows.len() as i64 - 1).min(last(row, rs)));
        let (Some(c0), Some(r0), Some(c1), Some(r1)) = (c0, r0, c1, r1) else {
            continue; // area outside the grid: ignored (the validator rejects it)
        };
        if !available.contains(&a.panel) {
            docked.push(a.panel);
            continue;
        }
        let rect = Rect {
            x: c0.start,
            y: r0.start,
            w: c1.start + c1.size - c0.start,
            h: r1.start + r1.size - r0.start,
        };
        let spec = spec_of(specs, a.panel);
        match pick_tier(&rect, &spec) {
            Some(tier) => placements.push(Placement {
                panel: a.panel,
                rect,
                tier,
            }),
            None if spec.essential => placements.push(Placement {
                panel: a.panel,
                rect,
                tier: Tier::Icon,
            }),
            None => docked.push(a.panel),
        }
    }

    let mut dock = None;
    if !docked.is_empty() {
        // Largest first; the earliest wins a tie (same as a stable descending sort in TS).
        let largest = |essential_ok: bool| {
            let mut best: Option<&Placement> = None;
            for p in &placements {
                if !essential_ok && spec_of(specs, p.panel).essential {
                    continue;
                }
                if best.is_none_or(|b| p.rect.area() > b.rect.area()) {
                    best = Some(p);
                }
            }
            best
        };
        // Prefer a non-essential host; else share the largest slot so a docked panel never
        // disappears.
        dock = largest(false).or_else(|| largest(true)).map(|p| p.rect);
    }
    Solution {
        placements,
        docked,
        dock,
    }
}

fn is_slug_id(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'.' || *c == b'-')
}

fn ok_weights(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Array(a)) => {
            (1..=8).contains(&a.len())
                && a.iter()
                    .all(|x| x.as_f64().is_some_and(|n| n > 0.0 && n <= 20.0))
        }
        _ => false,
    }
}

/// `Number.isInteger(n) && n >= 0`.
fn non_neg_int(v: Option<&Value>) -> Option<i64> {
    let n = v?.as_f64()?;
    (n.fract() == 0.0 && n >= 0.0 && n.is_finite()).then_some(n as i64)
}

/// Span (`?? 1`): missing or null means 1.
fn span(v: Option<&Value>) -> Option<i64> {
    match v {
        None | Some(Value::Null) => Some(1),
        some => non_neg_int(some),
    }
}

/// Validation errors for a (user, pack or marketplace) layout; empty = valid. Same messages and
/// order as `validateLayout` in solver.ts. `known` = the panel ids the format accepts (native
/// hosts pass [`PANEL_IDS`] and mark what they cannot render as unavailable in [`solve_with`]).
///
/// Runs on untrusted input (`pack_inspect`, `install` and every `list()`, including unsigned
/// community packs), so it must stay cheap: when the column / row weights are not 1..8 the grid
/// geometry is meaningless and the per-cell checks are skipped entirely — otherwise 10 000
/// declared rows plus one spanning area cost ~1e8 `contains` calls (WP19-37 P1-11).
pub fn validate_layout(raw: &Value, known: &[PanelId]) -> Vec<String> {
    let mut errs = Vec::new();
    let empty = serde_json::Map::new();
    let l = match raw {
        Value::Object(m) => m,
        Value::Array(_) => &empty,
        _ => return vec!["not an object".into()],
    };
    if l.get("v").and_then(Value::as_f64) != Some(1.0) {
        errs.push("v must be 1".into());
    }
    if !l.get("id").and_then(Value::as_str).is_some_and(is_slug_id) {
        errs.push("id must be a lowercase slug".into());
    }
    let name_ok = l
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(|n| (1..=60).contains(&n.encode_utf16().count()));
    if !name_ok {
        errs.push("name 1..60 chars".into());
    }
    let columns_ok = ok_weights(l.get("columns"));
    if !columns_ok {
        errs.push("columns: 1..8 weights in (0, 20]".into());
    }
    let rows_ok = ok_weights(l.get("rows"));
    if !rows_ok {
        errs.push("rows: 1..8 weights in (0, 20]".into());
    }
    let grid_ok = columns_ok && rows_ok;
    let gap_ok = l
        .get("gap")
        .is_none_or(|g| g.as_f64().is_some_and(|g| (0.0..=32.0).contains(&g)));
    if !gap_ok {
        errs.push("gap 0..32".into());
    }
    let areas = match l.get("areas") {
        Some(Value::Array(a)) if !a.is_empty() => a,
        _ => {
            errs.push("areas required".into());
            return errs;
        }
    };
    let len_of = |k: &str| l.get(k).and_then(Value::as_array).map_or(0, Vec::len) as i64;
    let nc = len_of("columns");
    let nr = len_of("rows");
    let mut seen: Vec<PanelId> = Vec::new();
    // The per-cell checks only run with valid weights, so the grid is at most 8 x 8: a fixed
    // bitmap keeps every lookup O(1) however many (duplicate) areas a pack declares.
    let mut occupied = [[false; 8]; 8];
    for (i, a) in areas.iter().enumerate() {
        let panel = a
            .get("panel")
            .and_then(Value::as_str)
            .and_then(PanelId::parse)
            .filter(|p| known.contains(p));
        let Some(panel) = panel else {
            errs.push(format!("areas[{i}]: unknown panel"));
            continue;
        };
        let name = panel.as_str();
        if seen.contains(&panel) {
            errs.push(format!("areas[{i}]: {name} used twice"));
        } else {
            seen.push(panel); // at most PANEL_IDS.len() entries
        }
        if !grid_ok {
            // No usable grid to place this area in; the weights error already says why.
            continue;
        }
        let col = non_neg_int(a.get("col"));
        let row = non_neg_int(a.get("row"));
        let cs = span(a.get("colSpan"));
        let rs = span(a.get("rowSpan"));
        let (Some(col), Some(row), Some(cs), Some(rs)) = (col, row, cs, rs) else {
            errs.push(format!("areas[{i}]: {name} outside the grid"));
            continue;
        };
        // `checked_add`: huge JSON numbers saturate to i64::MAX in `non_neg_int`, and the sum
        // then overflows (debug: panic across the FFI; release: the area is accepted).
        let (Some(c_end), Some(r_end)) = (col.checked_add(cs), row.checked_add(rs)) else {
            errs.push(format!("areas[{i}]: {name} outside the grid"));
            continue;
        };
        if cs < 1 || rs < 1 || c_end > nc || r_end > nr {
            errs.push(format!("areas[{i}]: {name} outside the grid"));
            continue;
        }
        for c in col..c_end {
            for r in row..r_end {
                let cell = &mut occupied[c as usize][r as usize];
                if *cell {
                    errs.push(format!("areas[{i}]: {name} overlaps cell {c},{r}"));
                }
                *cell = true;
            }
        }
    }
    for p in ESSENTIAL_REQUIRED {
        if !seen.contains(&p) {
            errs.push(format!("missing essential panel {}", p.as_str()));
        }
    }
    errs
}

/// Smallest window at which every essential panel fits at least its icon tier. The native
/// shells use it as the window minimum.
pub fn minimum_size(layout: &LayoutDoc) -> Size {
    minimum_size_with(layout, &PANEL_SPECS)
}

pub fn minimum_size_with(layout: &LayoutDoc, specs: &[PanelSpec]) -> Size {
    let gap = layout.gap.unwrap_or(DEFAULT_GAP);
    let need = |weights: &[f64], horizontal: bool| {
        let sum = weights.iter().fold(0.0, |a, b| a + b);
        let mut best: f64 = 0.0;
        for a in &layout.areas {
            let spec = spec_of(specs, a.panel);
            if !spec.essential {
                continue;
            }
            let (start, s) = if horizontal {
                (a.col, a.col_span.unwrap_or(1))
            } else {
                (a.row, a.row_span.unwrap_or(1))
            };
            // saturating: a pack can declare usize::MAX spans (P1-11).
            let end = start.saturating_add(s).min(weights.len());
            let part = weights
                .get(start.min(end)..end)
                .unwrap_or(&[])
                .iter()
                .fold(0.0, |x, y| x + y);
            let share = part / sum;
            let own_gaps = gap * (s as f64 - 1.0);
            let min = if horizontal { spec.icon.w } else { spec.icon.h };
            let total = (min - own_gaps) / share + gap * (weights.len() as f64 - 1.0);
            best = best.max(total);
        }
        best.ceil()
    };
    Size {
        w: need(&layout.columns, true),
        h: need(&layout.rows, false),
    }
}
