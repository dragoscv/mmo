//! `.mixaipack` + layout solver FFI surface (WP19-34).

use decks_ffi::*;

const FESTIVAL: &[u8] = include_bytes!(
    "../../../../../web/src/lib/decks-packs/files/ro.mixai.bundle.festival-pro.mixaipack"
);
const NEON: &[u8] = include_bytes!(
    "../../../../../web/src/lib/decks-packs/files/ro.mixai.skin.neon-club.mixaipack"
);
const SAMPLE: &[u8] = include_bytes!("../../../../sdk/fixtures/sample-signed.mixaipack");
const STYLED: &[u8] = include_bytes!("../../../../sdk/fixtures/sample-style.mixaipack");

const ALL: [LayoutPanel; 12] = [
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
    LayoutPanel::Waves,
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
    // Catalogue packs are manifest v1: no style block.
    assert_eq!(s.manifest_v, 1);
    assert!(s.style.is_none());

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
    assert_eq!((m.w, m.h), (674.0, 288.0));
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

#[test]
fn presets_start_with_pro_and_know_the_waves_panel() {
    let v: serde_json::Value = serde_json::from_str(&layout_presets_json()).unwrap();
    let ids: Vec<&str> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        [
            "pro",
            "pro-vertical",
            "classic",
            "performance",
            "library",
            "four-deck",
            "ultrawide",
            "stage"
        ]
    );
    // The default layout is one of the presets.
    assert_eq!(layout_default_id(), "pro");
    assert!(ids.contains(&layout_default_id().as_str()));
    assert!(layout_validate(preset("pro")).is_empty());
    // A host that renders the waves panel places it; one that does not docks it.
    let s = layout_solve(preset("pro"), 1920.0, 1080.0, ALL.to_vec()).unwrap();
    assert!(
        s.placements
            .iter()
            .any(|p| p.panel == LayoutPanel::Waves && p.tier == LayoutTier::Full),
        "{s:?}"
    );
    let host = vec![
        LayoutPanel::DeckA,
        LayoutPanel::DeckB,
        LayoutPanel::Mixer,
        LayoutPanel::Crossfader,
        LayoutPanel::Library,
    ];
    let d = layout_solve(preset("pro"), 1920.0, 1080.0, host).unwrap();
    assert_eq!(d.docked, [LayoutPanel::Waves]);
    // `waves` is a known panel of the format.
    let errs = layout_validate(
        r#"{"v":1,"id":"x","name":"X","columns":[1,1,1],"rows":[1,1],"areas":[{"panel":"waves","col":0,"row":0,"colSpan":3},{"panel":"deckA","col":0,"row":1},{"panel":"mixer","col":1,"row":1},{"panel":"deckB","col":2,"row":1}]}"#.into(),
    );
    assert!(errs.is_empty(), "{errs:?}");
}

#[test]
fn skin_editor_export_round_trips_with_style() {
    let req = serde_json::json!({
        "id": "user.skin.ffi-test",
        "name": "FFI test",
        "author": "Tests",
        "description": "",
        "version": "1.0.0",
        "tokens": {
            "mode": "dark",
            "colors": { "primary": "#00d37f" },
            "style": {
                "look": "classic",
                "platter": true,
                "layout": "pro-vertical",
                "waves": "overlay",
                "colors": { "well": "#0b0d0f", "waveLow": "oklch(1 0 0 / 0.5)" },
                "sizes": { "panelGap": 6, "wavePlayedAlpha": 0.45 }
            }
        }
    });
    let bytes = pack_build_skin(req.to_string()).unwrap();
    let s = pack_inspect(bytes.clone()).unwrap();
    assert_eq!(s.trust, PackTrustLevel::Unsigned);
    assert_eq!(s.manifest_v, 2);
    assert_eq!(s.kind, "skin");
    let style = s.style.expect("style block");
    assert_eq!(style.look.as_deref(), Some("classic"));
    assert_eq!(style.platter, Some(true));
    assert_eq!(style.layout.as_deref(), Some("pro-vertical"));
    assert_eq!(style.waves.as_deref(), Some("overlay"));
    let well = style.colors.iter().find(|c| c.key == "well").unwrap();
    assert_eq!((well.rgb, well.alpha), (0x0b0d0f, 1.0));
    let low = style.colors.iter().find(|c| c.key == "waveLow").unwrap();
    assert_eq!((low.rgb, low.alpha), (0xffffff, 0.5));
    let gap = style.sizes.iter().find(|x| x.key == "panelGap").unwrap();
    assert_eq!(gap.value, 6.0);
    // The full TS-shaped JSON carries the style block under tokens.style, camelCase.
    let info: serde_json::Value = serde_json::from_str(&s.info_json).unwrap();
    assert_eq!(info["tokens"]["style"]["sizes"]["wavePlayedAlpha"], 0.45);
    // It installs like any other pack.
    let tmp = tempfile::tempdir().unwrap();
    let store = PackStore::new(tmp.path().join("packs").to_string_lossy().into_owned());
    let installed = store.install(bytes).unwrap();
    assert!(installed.style.is_some());
    // Invalid style = refused with the readable reason; a v1 shape with style is impossible to
    // build (the builder always writes v2), so the only refusals are validation ones.
    let mut bad = req.clone();
    bad["tokens"]["style"]["sizes"]["panelGap"] = serde_json::json!(17);
    match pack_build_skin(bad.to_string()) {
        Err(DecksError::Pack { reason }) => {
            assert!(reason.contains("style.sizes.panelGap"), "{reason}")
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        pack_build_skin("{".into()),
        Err(DecksError::Pack { .. })
    ));
}

#[test]
fn sdk_built_v2_skin_exposes_its_style() {
    let s = pack_inspect(STYLED.to_vec()).unwrap();
    assert_eq!(s.trust, PackTrustLevel::Community);
    assert_eq!(s.manifest_v, 2);
    let style = s.style.expect("style block");
    assert_eq!(style.look.as_deref(), Some("classic"));
    assert_eq!(style.layout.as_deref(), Some("pro-vertical"));
    // 25 colour keys and 8 size keys, every colour resolved to sRGB.
    assert_eq!(style.colors.len(), 25);
    assert_eq!(style.sizes.len(), 8);
    let cap = style
        .colors
        .iter()
        .find(|c| c.key == "wavePlayheadCap")
        .unwrap();
    assert_eq!(cap.rgb, 0xff0000);
    // The v1 sample of the same SDK has no style and reports version 1.
    let v1 = pack_inspect(SAMPLE.to_vec()).unwrap();
    assert_eq!(v1.manifest_v, 1);
    assert!(v1.style.is_none());
}
