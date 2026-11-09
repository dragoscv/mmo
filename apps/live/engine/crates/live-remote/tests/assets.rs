//! The served tokens.css must stay a byte copy of the design-tokens output, the page must use only
//! token variables, and both locales must carry the same keys.

use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../..")
}

fn norm(s: &str) -> String {
    s.replace("\r\n", "\n")
}

const PAGE: &str = include_str!("../assets/remote.html");

#[test]
fn tokens_css_matches_design_tokens_output() {
    let src = repo().join("packages/design-tokens/dist/tokens.plain.css");
    let Ok(expected) = std::fs::read_to_string(&src) else {
        eprintln!("skipped: {} not found", src.display());
        return;
    };
    assert!(
        norm(include_str!("../assets/tokens.css")) == norm(&expected),
        "assets/tokens.css drifted: copy packages/design-tokens/dist/tokens.plain.css after `pnpm tokens:build`"
    );
}

#[test]
fn page_uses_tokens_not_literal_colours() {
    let style = PAGE
        .split("<style>")
        .nth(1)
        .and_then(|s| s.split("</style>").next())
        .unwrap_or("");
    assert!(!style.is_empty(), "page has a <style> block");
    for bad in ["#", "rgb(", "hsl(", "oklch("] {
        assert!(
            !style.contains(bad),
            "literal colour `{bad}` in <style>; use var(--token)"
        );
    }
    assert!(PAGE.contains("href=\"/tokens.css\""));
    assert!(PAGE.contains("lang=\"en\""));
    assert!(
        !PAGE.contains("http://") || !PAGE.contains("src=\"http"),
        "no external resources"
    );
}

#[test]
fn page_carries_both_locales() {
    let ro = PAGE.split("const T = ro ? {").nth(1).expect("string table");
    let (ro, en) = ro.split_once("} : {").unwrap();
    let en = en.split("};").next().unwrap();
    let keys = |s: &str| {
        let mut k: Vec<String> = s
            .match_indices(": \"")
            .map(|(i, _)| {
                s[..i]
                    .chars()
                    .rev()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            })
            .filter(|k| !k.is_empty())
            .collect();
        k.sort();
        k
    };
    let (kr, ke) = (keys(ro), keys(en));
    assert!(kr.len() > 20);
    assert_eq!(kr, ke, "RO and EN string tables have the same keys");
}
