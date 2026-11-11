use serde::Deserialize;
use serde_json::Value;

use super::*;

const FIXTURES: &str = include_str!("../../../../../../docs/decks/fixtures/layout-cases.json");
const PRESETS_TS: &str = include_str!("../../../../src/layout/presets.ts");

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

/// presets.ts without comments and whitespace (so the line ends of the checkout do not matter).
fn presets_ts_compact() -> String {
    PRESETS_TS
        .lines()
        .map(str::trim)
        .filter(|l| !l.starts_with("//") && !l.starts_with("/*") && !l.starts_with('*'))
        .flat_map(str::chars)
        .filter(|c| !c.is_whitespace())
        .collect()
}

/// The part of `s` after `from` and before the next `to`.
fn between<'a>(s: &'a str, from: &str, to: &str) -> &'a str {
    let start = s
        .find(from)
        .unwrap_or_else(|| panic!("'{from}' not found in presets.ts"))
        + from.len();
    let end = s[start..]
        .find(to)
        .unwrap_or_else(|| panic!("'{to}' not found after '{from}' in presets.ts"));
    &s[start..start + end]
}

/// Every number in `s`, in order.
fn numbers(s: &str) -> Vec<f64> {
    s.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .filter(|t| !t.is_empty())
        .map(|t| t.parse().unwrap_or_else(|_| panic!("number '{t}'")))
        .collect()
}

/// The golden cases use a coarse grid of window sizes, so a minimum that is off by one pixel can
/// pass all of them (a mutation run showed it for the deck's full height and the mixer's compact
/// height). This reads the table straight from presets.ts: every tier of every panel, the order
/// of the panels and which ones are essential.
#[test]
fn panel_specs_equal_presets_ts() {
    let ts = presets_ts_compact();
    let deck = numbers(between(&ts, "constdeck:PanelSpec[\"min\"]={", "};"));
    assert_eq!(deck.len(), 6, "{deck:?}");
    let table = between(
        &ts,
        "exportconstPANEL_SPECS:Record<PanelId,PanelSpec>={",
        "};",
    );
    let entries: Vec<&str> = table.split("{id:\"").skip(1).collect();
    assert_eq!(entries.len(), PANEL_SPECS.len(), "{table}");
    for (entry, spec) in entries.iter().zip(PANEL_SPECS.iter()) {
        let id = spec.id.as_str();
        assert!(entry.starts_with(&format!("{id}\",")), "{id}: {entry}");
        let min = if entry.contains("min:deck") {
            deck.clone()
        } else {
            let at = entry
                .find("min:{")
                .unwrap_or_else(|| panic!("{id} has no min in presets.ts"));
            numbers(&entry[at..])
        };
        let rust = [
            spec.full.w,
            spec.full.h,
            spec.compact.w,
            spec.compact.h,
            spec.icon.w,
            spec.icon.h,
        ];
        assert_eq!(min, rust, "{id}: full, compact, icon as w, h");
        assert_eq!(entry.contains("essential:true"), spec.essential, "{id}");
    }
}

#[test]
fn fixture_presets_equal_the_rust_presets() {
    let f = fixtures();
    assert_eq!(f.layouts, all_presets());
}

/// Count, order and default of the presets follow `BUILTIN_LAYOUTS` / `DEFAULT_LAYOUT` in
/// presets.ts (the native layout pickers list them in this order).
#[test]
fn builtin_presets_follow_the_ts_order() {
    let ids: Vec<String> = builtin_layouts().into_iter().map(|l| l.id).collect();
    assert_eq!(
        ids,
        [
            "pro",
            "pro-vertical",
            "classic",
            "performance",
            "library",
            "four-deck",
            "ultrawide"
        ]
    );
    assert_eq!(all_presets().len(), 8);
    assert_eq!(all_presets().last().unwrap().id, "stage");
    assert_eq!(default_layout().id, "pro");
    for l in all_presets() {
        let raw = serde_json::to_value(&l).unwrap();
        assert_eq!(
            validate_layout(&raw, &PANEL_IDS),
            [] as [&str; 0],
            "{}",
            l.id
        );
    }
}

/// `waves` is a panel of the format (12 ids, specs in the same order) and is not essential:
/// too small for its icon tier it is docked, never squeezed.
#[test]
fn waves_is_a_regular_dockable_panel() {
    assert_eq!(PANEL_IDS.len(), 12);
    assert_eq!(PanelId::parse("waves"), Some(PanelId::Waves));
    assert_eq!(
        serde_json::to_value(PanelId::Waves).unwrap(),
        Value::String("waves".into())
    );
    for (id, spec) in PANEL_IDS.iter().zip(PANEL_SPECS.iter()) {
        assert_eq!(*id, spec.id);
        assert_eq!(PanelId::parse(id.as_str()), Some(*id));
    }
    let waves = spec_of(&PANEL_SPECS, PanelId::Waves);
    assert!(!waves.essential);
    assert_eq!((waves.full.w, waves.full.h), (480.0, 110.0));
    assert_eq!((waves.compact.w, waves.compact.h), (320.0, 64.0));
    assert_eq!((waves.icon.w, waves.icon.h), (200.0, 36.0));
    // 1500 x 969 (the size the Pro rows were tuned for): the band is full, nothing is docked.
    let s = solve(&pro(), 1500.0, 969.0);
    assert!(s.docked.is_empty(), "{:?}", s.docked);
    let band = s
        .placements
        .iter()
        .find(|p| p.panel == PanelId::Waves)
        .unwrap();
    assert_eq!(band.tier, Tier::Full);
    // Vertical waves at 360 px wide: the lane is 58 px wide (< 200), so it becomes a dock tab
    // while the essential panels stay placed as icons.
    let small = solve(&pro_vertical(), 360.0, 300.0);
    assert_eq!(small.docked, [PanelId::Waves], "{small:?}");
    assert!(small.placements.iter().all(|p| p.tier == Tier::Icon));
    assert!(small.dock.is_some());
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
