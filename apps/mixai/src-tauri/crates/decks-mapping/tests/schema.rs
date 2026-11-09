//! The JSON Schema embedded in `docs/decks/mapping-format.md` must equal the one generated from
//! the Rust types. Regenerate with:
//!
//! ```text
//! $env:DECKS_MAPPING_BLESS='1'; cargo test -p decks-mapping --test schema
//! ```

use std::path::PathBuf;

const BEGIN: &str = "<!-- BEGIN GENERATED SCHEMA (cargo test -p decks-mapping --test schema) -->";
const END: &str = "<!-- END GENERATED SCHEMA -->";

fn doc_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../../docs/decks/mapping-format.md")
}

fn block(schema: &str) -> String {
    format!("{BEGIN}\n\n```json\n{schema}```\n\n{END}")
}

#[test]
fn schema_in_docs_is_up_to_date() {
    let schema = decks_mapping::json_schema_string();
    let path = doc_path();
    let doc = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
        .replace("\r\n", "\n");
    let start = doc.find(BEGIN).expect("BEGIN marker in mapping-format.md");
    let end = doc.find(END).expect("END marker in mapping-format.md") + END.len();
    let current = &doc[start..end];
    let expected = block(&schema);
    if current == expected {
        return;
    }
    if std::env::var_os("DECKS_MAPPING_BLESS").is_some() {
        let updated = format!("{}{}{}", &doc[..start], expected, &doc[end..]);
        std::fs::write(&path, updated).expect("write mapping-format.md");
        return;
    }
    panic!(
        "docs/decks/mapping-format.md schema is stale; run with DECKS_MAPPING_BLESS=1 to update"
    );
}

#[test]
fn schema_validates_shape_of_builtin_profiles() {
    // Minimal structural check without a validator crate: every top-level required property
    // of the schema is present in each serialised profile.
    let schema: serde_json::Value =
        serde_json::from_str(&decks_mapping::json_schema_string()).unwrap();
    let required: Vec<String> = schema["required"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert!(required.contains(&"id".to_string()));
    for m in decks_mapping::profiles::builtin() {
        let v = serde_json::to_value(&m).unwrap();
        for r in &required {
            assert!(v.get(r).is_some(), "{} misses {r}", m.id);
        }
    }
}
