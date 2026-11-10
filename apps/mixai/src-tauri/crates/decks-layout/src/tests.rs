use serde::Deserialize;
use serde_json::Value;

use super::*;

const FIXTURES: &str = include_str!("../../../../../../docs/decks/fixtures/layout-cases.json");

#[derive(Deserialize)]
struct Fixtures {
    layouts: Vec<LayoutDoc>,
    minimum: Vec<MinCase>,
    validation: Vec<ValidationCase>,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct MinCase {
    layout: String,
    size: Size,
}

#[derive(Deserialize)]
struct ValidationCase {
    raw: Value,
    errors: Vec<String>,
}

#[derive(Deserialize)]
struct Case {
    layout: String,
    w: f64,
    h: f64,
    solution: Solution,
}

fn fixtures() -> Fixtures {
    serde_json::from_str(FIXTURES).expect("layout-cases.json parses")
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

fn same_rect(a: &Rect, b: &Rect) -> bool {
    close(a.x, b.x) && close(a.y, b.y) && close(a.w, b.w) && close(a.h, b.h)
}

#[test]
fn fixture_presets_equal_the_rust_presets() {
    let f = fixtures();
    assert_eq!(f.layouts, all_presets());
}

#[test]
fn solver_matches_the_ts_golden_cases() {
    let f = fixtures();
    assert!(f.cases.len() >= 300, "{} cases", f.cases.len());
    let mut bad = Vec::new();
    for c in &f.cases {
        let layout = f.layouts.iter().find(|l| l.id == c.layout).unwrap();
        let got = solve(layout, c.w, c.h);
        let e = &c.solution;
        let ok = got.docked == e.docked
            && got.placements.len() == e.placements.len()
            && got.placements.iter().zip(&e.placements).all(|(g, x)| {
                g.panel == x.panel && g.tier == x.tier && same_rect(&g.rect, &x.rect)
            })
            && match (&got.dock, &e.dock) {
                (None, None) => true,
                (Some(a), Some(b)) => same_rect(a, b),
                _ => false,
            };
        if !ok {
            bad.push(format!("{} {}x{}", c.layout, c.w, c.h));
        }
    }
    assert!(
        bad.is_empty(),
        "{} of {} cases differ from TS, first: {:?}",
        bad.len(),
        f.cases.len(),
        &bad[..bad.len().min(5)]
    );
}

#[test]
fn minimum_size_matches_ts() {
    let f = fixtures();
    for m in &f.minimum {
        let layout = f.layouts.iter().find(|l| l.id == m.layout).unwrap();
        assert_eq!(minimum_size(layout), m.size, "{}", m.layout);
    }
}

#[test]
fn validator_matches_ts_messages() {
    let f = fixtures();
    assert!(f.validation.len() >= 8);
    for v in &f.validation {
        assert_eq!(validate_layout(&v.raw, &PANEL_IDS), v.errors, "{}", v.raw);
    }
}

#[test]
fn tracks_split_by_weight_and_keep_gaps() {
    let t = tracks(1012.0, &[1.0, 1.0], 12.0);
    assert_eq!(
        t,
        [
            Track {
                start: 0.0,
                size: 500.0
            },
            Track {
                start: 512.0,
                size: 500.0
            }
        ]
    );
}

#[test]
fn unavailable_panels_always_go_to_the_dock() {
    let l = classic();
    let host = [
        PanelId::DeckA,
        PanelId::DeckB,
        PanelId::Mixer,
        PanelId::Crossfader,
        PanelId::Library,
    ];
    let s = solve_with(&l, 3440.0, 1440.0, &PANEL_SPECS, &host);
    assert_eq!(s.docked, [PanelId::Clock, PanelId::Automix]);
    assert!(s.placements.iter().all(|p| p.panel != PanelId::Clock));
    // Host = the largest non-essential placed panel (the library).
    let lib = s
        .placements
        .iter()
        .find(|p| p.panel == PanelId::Library)
        .unwrap();
    assert_eq!(s.dock, Some(lib.rect));
    // Every panel available = the plain solver.
    assert_eq!(
        solve_with(&l, 1280.0, 720.0, &PANEL_SPECS, &PANEL_IDS),
        solve(&l, 1280.0, 720.0)
    );
}

#[test]
fn essential_panels_are_never_docked() {
    for l in all_presets() {
        for (w, h) in [(200.0, 200.0), (360.0, 300.0), (1920.0, 1080.0)] {
            let s = solve(&l, w, h);
            for d in &s.docked {
                assert!(!spec_of(&PANEL_SPECS, *d).essential, "{} {d:?}", l.id);
            }
        }
    }
}

#[test]
fn pack_layouts_are_namespaced_and_deduped() {
    let raw = serde_json::to_value(stage()).unwrap();
    let mut broken = raw.clone();
    broken["areas"] = Value::Array(vec![]);
    let layouts = [raw.clone(), raw, broken];
    let a = PackLayoutSource {
        pack_id: "com.example.bundle.x",
        layouts: &layouts,
    };
    let out = pack_layouts(&[a]);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, "com.example.bundle.x/stage");
    assert_eq!(local_layout_id(&out[0].id), "stage");
    let own: std::collections::HashSet<String> = ["classic".to_string()].into();
    assert_eq!(
        remap_legacy_ref("stage", &own, &out),
        "com.example.bundle.x/stage"
    );
    assert_eq!(remap_legacy_ref("classic", &own, &out), "classic");
    assert_eq!(remap_legacy_ref("missing", &own, &out), "missing");
    // A namespaced layout from the list parses again (validated by its local id) …
    let back = parse_layout(&serde_json::to_value(&out[0]).unwrap()).unwrap();
    assert_eq!(back.id, "com.example.bundle.x/stage");
    // … but a bad local part or a bad id is still refused.
    let mut bad = serde_json::to_value(&out[0]).unwrap();
    bad["id"] = Value::String("com.example.bundle.x/Bad Id".into());
    assert!(parse_layout(&bad).is_err());
}

/// P1-11: spans whose sum overflows i64 are "outside the grid" (no debug panic, no accepted
/// area in release). 2^62 + 2^62 overflows; 1e300 saturates to i64::MAX in `non_neg_int`.
#[test]
fn overflowing_spans_are_outside_the_grid() {
    let mut raw = serde_json::to_value(classic()).unwrap();
    let big = 4_611_686_018_427_387_904_i64; // 2^62
    raw["areas"] = serde_json::json!([
        { "panel": "deckA", "col": big, "row": 0, "colSpan": big },
        { "panel": "deckB", "col": 0, "row": 1e300, "rowSpan": 1e300 },
        { "panel": "mixer", "col": 1, "row": 0 },
    ]);
    let errs = validate_layout(&raw, &PANEL_IDS);
    assert!(
        errs.contains(&"areas[0]: deckA outside the grid".to_string()),
        "{errs:?}"
    );
    assert!(
        errs.contains(&"areas[1]: deckB outside the grid".to_string()),
        "{errs:?}"
    );
    // The solver never panics on a document that skipped the validator either: i64::MAX + 2
    // overflows `col + cs - 1` (usize::MAX would wrap to -1 and hide it).
    let mut l = classic();
    let max = i64::MAX as usize;
    l.areas[0].col = max;
    l.areas[0].col_span = Some(2);
    l.areas[1].row = max;
    l.areas[1].row_span = Some(max);
    let s = solve(&l, 1920.0, 1080.0);
    assert!(
        s.placements
            .iter()
            .all(|p| p.panel != l.areas[0].panel && p.panel != l.areas[1].panel),
        "areas outside the grid are ignored: {s:?}"
    );
    l.areas[2].col_span = Some(usize::MAX);
    let _ = minimum_size(&l);
}

/// P1-11: invalid weights skip the per-cell work. 10 000 rows + 10 000 columns and two areas
/// spanning all of them would be ~1e8 cells (and ~1e16 `contains` calls); with the guard the
/// validator returns at once with only the weight errors.
#[test]
fn invalid_weights_skip_the_cell_checks() {
    let mut raw = serde_json::to_value(classic()).unwrap();
    raw["columns"] = Value::Array(vec![Value::from(1.0); 10_000]);
    raw["rows"] = Value::Array(vec![Value::from(1.0); 10_000]);
    raw["areas"] = serde_json::json!([
        { "panel": "deckA", "col": 0, "row": 0, "colSpan": 10_000, "rowSpan": 10_000 },
        { "panel": "deckB", "col": 0, "row": 0, "colSpan": 10_000, "rowSpan": 10_000 },
        { "panel": "mixer", "col": 0, "row": 0 },
    ]);
    let t = std::time::Instant::now();
    let errs = validate_layout(&raw, &PANEL_IDS);
    let took = t.elapsed();
    assert_eq!(
        errs,
        [
            "columns: 1..8 weights in (0, 20]",
            "rows: 1..8 weights in (0, 20]"
        ],
    );
    assert!(took.as_millis() < 500, "validator took {took:?}");
}
