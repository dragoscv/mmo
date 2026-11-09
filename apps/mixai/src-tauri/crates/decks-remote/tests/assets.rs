//! The served tokens.css must stay a byte copy of the design-tokens output (no hand-typed
//! colours in the remote pages), and the pages must only use token variables.

use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../..")
}

fn norm(s: &str) -> String {
    s.replace("\r\n", "\n")
}

#[test]
fn tokens_css_matches_design_tokens_output() {
    let src = repo().join("packages/design-tokens/dist/tokens.plain.css");
    let Ok(expected) = std::fs::read_to_string(&src) else {
        // Isolated crate copies (outside the monorepo) cannot see the source; CI runs in-repo.
        eprintln!("skipped: {} not found", src.display());
        return;
    };
    let ours = include_str!("../assets/tokens.css");
    assert!(
        norm(ours) == norm(&expected),
        "assets/tokens.css drifted: copy packages/design-tokens/dist/tokens.plain.css after `pnpm tokens:build`"
    );
}

#[test]
fn pages_use_tokens_not_literal_colours() {
    for (name, page) in [
        ("remote.html", include_str!("../assets/remote.html")),
        ("party.html", include_str!("../assets/party.html")),
    ] {
        let style = page
            .split("<style>")
            .nth(1)
            .and_then(|s| s.split("</style>").next())
            .unwrap_or("");
        for bad in ["#", "rgb(", "hsl(", "oklch("] {
            assert!(
                !style.contains(bad),
                "{name}: literal colour `{bad}` in <style>; use var(--token)"
            );
        }
        assert!(page.contains("href=\"/tokens.css\""), "{name} links tokens");
        assert!(page.contains("lang=\"en\""), "{name} declares a language");
    }
}

#[test]
fn pages_carry_both_locales() {
    for page in [
        include_str!("../assets/remote.html"),
        include_str!("../assets/party.html"),
    ] {
        let ro = page.split("const T = ro ? {").nth(1).unwrap();
        let (ro, en) = ro.split_once("} : {").unwrap();
        let en = en.split("};").next().unwrap();
        let keys = |s: &str| {
            // Every entry is `ident: "value"`; take the identifier before each `: "`.
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
        assert_eq!(
            keys(ro),
            keys(en),
            "RO and EN string tables have the same keys"
        );
    }
}
