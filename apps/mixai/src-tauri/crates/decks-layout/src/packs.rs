//! Layouts contributed by installed packs, namespaced by pack id (mirror of
//! `apps/mixai/src/packs/pack-layouts.ts`). A pack layout's own id is only unique inside its pack;
//! in the store it becomes `<packId>/<layoutId>`. The `/` never appears in a built-in or user id
//! (the validator accepts only a slug), so a pack cannot shadow a built-in or another pack.

use std::collections::HashSet;

use serde_json::Value;

use crate::solver::validate_layout;
use crate::types::{LayoutDoc, PANEL_IDS};

pub const PACK_LAYOUT_SEP: &str = "/";

/// One installed pack's id plus its raw layout JSON values.
pub struct PackLayoutSource<'a> {
    pub pack_id: &'a str,
    pub layouts: &'a [Value],
}

pub fn pack_layout_id(pack_id: &str, layout_id: &str) -> String {
    format!("{pack_id}{PACK_LAYOUT_SEP}{layout_id}")
}

pub fn is_pack_layout_id(id: &str) -> bool {
    id.contains(PACK_LAYOUT_SEP)
}

/// The pack-local part of a layout id (the id itself for built-in and user layouts).
pub fn local_layout_id(id: &str) -> &str {
    match id.rfind(PACK_LAYOUT_SEP) {
        Some(i) => &id[i + PACK_LAYOUT_SEP.len()..],
        None => id,
    }
}

/// Validate and parse one layout (all panel ids of the format are accepted). A namespaced pack id
/// (`<packId>/<layoutId>`, as returned by [`pack_layouts`]) is validated by its local part, so a
/// layout taken from the pack list can be handed straight back to the solver.
pub fn parse_layout(raw: &Value) -> Result<LayoutDoc, Vec<String>> {
    let local = raw
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_pack_layout_id(id))
        .map(|id| {
            let mut v = raw.clone();
            v["id"] = Value::String(local_layout_id(id).to_owned());
            v
        });
    let errs = validate_layout(local.as_ref().unwrap_or(raw), &PANEL_IDS);
    if !errs.is_empty() {
        return Err(errs);
    }
    serde_json::from_value(raw.clone()).map_err(|e| vec![e.to_string()])
}

/// Valid layouts of every pack, with namespaced ids. Invalid layouts and duplicates are dropped.
pub fn pack_layouts(list: &[PackLayoutSource<'_>]) -> Vec<LayoutDoc> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for p in list {
        for raw in p.layouts {
            let Ok(mut l) = parse_layout(raw) else {
                continue;
            };
            let id = pack_layout_id(p.pack_id, &l.id);
            if !seen.insert(id.clone()) {
                continue;
            }
            l.id = id;
            out.push(l);
        }
    }
    out
}

/// Decks 1.3.0 stored pack layouts by their bare id: map such a reference to the namespaced id
/// when it is not a built-in/user layout and exactly one pack layout carries that local id.
pub fn remap_legacy_ref(ref_id: &str, own_ids: &HashSet<String>, pack: &[LayoutDoc]) -> String {
    if is_pack_layout_id(ref_id) || own_ids.contains(ref_id) {
        return ref_id.to_owned();
    }
    let mut hits = pack.iter().filter(|l| local_layout_id(&l.id) == ref_id);
    match (hits.next(), hits.next()) {
        (Some(one), None) => one.id.clone(),
        _ => ref_id.to_owned(),
    }
}
