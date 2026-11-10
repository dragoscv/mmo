//! `.mixaipack` + layout solver FFI surface (WP19-34).

use decks_ffi::*;

const FESTIVAL: &[u8] = include_bytes!(
    "../../../../../web/src/lib/decks-packs/files/ro.mixai.bundle.festival-pro.mixaipack"
);
const NEON: &[u8] = include_bytes!(
    "../../../../../web/src/lib/decks-packs/files/ro.mixai.skin.neon-club.mixaipack"
);
const SAMPLE: &[u8] = include_bytes!("../../../../sdk/fixtures/sample-signed.mixaipack");

const ALL: [LayoutPanel; 11] = [
    LayoutPanel::DeckA,
    LayoutPanel::DeckB,
    LayoutPanel::DeckC,
    LayoutPanel::DeckD,
    LayoutPanel::Clock,
    LayoutPanel::Mixer,
    LayoutPanel::Crossfader,
    LayoutPanel::Library,
    LayoutPanel::Automix,
    LayoutPanel::Sampler,
    LayoutPanel::Plugins,
];

fn preset(id: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(&layout_presets_json()).unwrap();
    let l = v
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["id"] == id)
        .unwrap_or_else(|| panic!("preset {id}"));
    l.to_string()
}

#[test]
fn official_packs_inspect_as_official() {
    let s = pack_inspect(NEON.to_vec()).unwrap();
    assert_eq!(s.trust, PackTrustLevel::Official);
    assert_eq!(s.kind, "skin");
    assert!(s.installed_at.is_none());
    assert!(!s.colors.is_empty(), "skin resolves colours");
    assert!(s.colors.iter().all(|c| c.rgb <= 0xff_ffff));
    let info: serde_json::Value = serde_json::from_str(&s.info_json).unwrap();
    assert_eq!(info["manifest"]["id"], s.id.as_str());

    let f = pack_inspect(FESTIVAL.to_vec()).unwrap();
    let layouts: serde_json::Value = serde_json::from_str(&f.layouts_json).unwrap();
    let first = layouts
        .as_array()
        .unwrap()
        .first()
        .expect("bundle has layouts");
    let id = first["id"].as_str().unwrap();
    assert!(id.starts_with("ro.mixai.bundle.festival-pro/"), "{id}");
    // Pack layouts solve through the same entry point.
    let sol = layout_solve(first.to_string(), 1920.0, 1080.0, ALL.to_vec()).unwrap();
    assert!(!sol.placements.is_empty());
}

#[test]
fn garbage_is_a_pack_error() {
    match pack_inspect(b"not a zip".to_vec()) {
        Err(DecksError::Pack { reason }) => assert!(reason.contains("zip"), "{reason}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn store_install_list_remove() {
    let tmp = tempfile::tempdir().unwrap();
    let store = PackStore::new(tmp.path().join("packs").to_string_lossy().into_owned());
    assert!(store.list().is_empty());
    let a = store.install(SAMPLE.to_vec()).unwrap();
    assert_eq!(a.trust, PackTrustLevel::Community);
    assert!(a.installed_at.is_some());
    store.install(FESTIVAL.to_vec()).unwrap();
    assert_eq!(store.list().len(), 2);
    let ns: serde_json::Value = serde_json::from_str(&store.layouts_json()).unwrap();
    assert!(!ns.as_array().unwrap().is_empty());
    store.remove(a.id.clone()).unwrap();
    assert_eq!(store.list().len(), 1);
    assert!(matches!(
        store.remove("../x".into()),
        Err(DecksError::Pack { .. })
    ));
}

#[test]
fn solver_docks_what_the_host_cannot_render() {
    let host = vec![
        LayoutPanel::DeckA,
        LayoutPanel::DeckB,
        LayoutPanel::Mixer,
        LayoutPanel::Crossfader,
        LayoutPanel::Library,
    ];
    let s = layout_solve(preset("classic"), 1920.0, 1080.0, host).unwrap();
    assert_eq!(s.docked, [LayoutPanel::Clock, LayoutPanel::Automix]);
    assert!(s.dock.is_some());
    let full = layout_solve(preset("classic"), 1920.0, 1080.0, ALL.to_vec()).unwrap();
    assert!(full.docked.is_empty());
    assert!(
        full.placements
            .iter()
            .any(|p| p.panel == LayoutPanel::DeckA && p.tier == LayoutTier::Full)
    );
    // Too small: essentials drop to icon, never docked.
    let tiny = layout_solve(preset("stage"), 300.0, 200.0, ALL.to_vec()).unwrap();
    assert!(tiny.docked.is_empty());
    assert!(tiny.placements.iter().all(|p| p.tier == LayoutTier::Icon));
}

#[test]
fn validate_minimum_and_bad_input() {
    assert!(layout_validate(preset("four-deck")).is_empty());
    let errs = layout_validate(r#"{"v":1,"id":"x","name":"X","columns":[1],"rows":[1],"areas":[{"panel":"deckA","col":0,"row":0}]}"#.into());
    assert!(
        errs.iter().any(|e| e == "missing essential panel deckB"),
        "{errs:?}"
    );
    assert!(layout_validate("{".into())[0].contains("JSON"));
    let m = layout_minimum_size(preset("classic")).unwrap();
    assert_eq!((m.w, m.h), (674.0, 360.0));
    assert!(matches!(
        layout_solve("{}".into(), 100.0, 100.0, ALL.to_vec()),
        Err(DecksError::Pack { .. })
    ));
    assert!(matches!(
        layout_solve(preset("classic"), f64::NAN, 100.0, ALL.to_vec()),
        Err(DecksError::InvalidArgument { .. })
    ));
}

#[test]
fn colours_resolve_without_oklch_on_the_native_side() {
    let c = pack_resolve_colors(
        r##"{"colors":{"primary":"oklch(1 0 0)","border":"#ffffff80"},"decks":{"a":"#00e5ff"},"color":{"$type":"color","ring":{"$value":"#010203"}}}"##.into(),
    )
    .unwrap();
    let get = |k: &str| c.iter().find(|x| x.key == k).unwrap();
    assert_eq!(get("primary").rgb, 0xffffff);
    assert_eq!(get("deck-a").rgb, 0x00e5ff);
    assert_eq!(get("ring").rgb, 0x010203);
    assert!((get("border").alpha - 128.0 / 255.0).abs() < 1e-6);
    assert!(matches!(
        pack_resolve_colors(r#"{"colors":{"primary":"url(x)"}}"#.into()),
        Err(DecksError::Pack { .. })
    ));
}
