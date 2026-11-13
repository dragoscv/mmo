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
        ("now.html", include_str!("../assets/now.html")),
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
        include_str!("../assets/now.html"),
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
        assert!(!keys(en).is_empty(), "the string table was found");
        assert_eq!(
            keys(ro),
            keys(en),
            "RO and EN string tables have the same keys"
        );
    }
}

/// The stream overlay shows text that comes from file tags: it must never be parsed as
/// markup, the page must stay see-through for OBS, and its fades must follow the motion tokens
/// (which the tokens sheet zeroes for `prefers-reduced-motion`).
#[test]
fn the_overlay_page_inserts_text_only_stays_transparent_and_follows_the_motion_tokens() {
    let page = include_str!("../assets/now.html");
    for markup_sink in [
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "eval(",
        "new Function",
    ] {
        assert!(!page.contains(markup_sink), "now.html uses {markup_sink}");
    }
    assert!(page.contains(".textContent = want.title"));
    assert!(page.contains(".textContent = want.artist"));
    // An empty inline icon: without it a browser asks the server for /favicon.ico, gets a 404
    // and logs an error into the streaming tool's console on every load.
    assert!(page.contains(r#"<link rel="icon" href="data:,">"#));
    assert_eq!(page.matches("href=").count(), 2, "the icon and the tokens");
    assert_eq!(page.matches("src=").count(), 0, "nothing else is fetched");
    let style = page
        .split("<style>")
        .nth(1)
        .and_then(|s| s.split("</style>").next())
        .unwrap();
    assert!(style.contains(
        "html, body { height: 100%; margin: 0; overflow: hidden; background: transparent; }"
    ));
    // The only solid backgrounds are the two plate options.
    let solid: Vec<&str> = style
        .lines()
        .filter(|l| l.contains("background: var(--background)"))
        .map(|l| l.trim().split('{').next().unwrap().trim())
        .collect();
    assert_eq!(
        solid,
        [
            "html[data-plate=\"full\"] body",
            "html[data-plate=\"box\"] .box",
            ".msg"
        ]
    );
    assert!(style.contains("transition: opacity var(--dur-slow) var(--ease-out)"));
    // The page ships no font file: after the token families it names fonts every system has
    // (the computer that runs OBS decides the face), ending in the generic sans-serif.
    assert!(!page.contains("@font-face"));
    assert!(style.contains(
        r#"--fallback: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;"#
    ));
    assert!(style.contains("font-family: var(--font-sans), var(--fallback);"));
    assert!(style.contains("font-family: var(--font-heading), var(--fallback);"));
    assert_eq!(style.matches("font-family:").count(), 2);
    // The sizes the documentation gives are computed from these two lines.
    assert!(style.contains("--t: min(20vh, calc(5vw * var(--scale)));"));
    assert!(
        style.contains(r#"html[data-plate="box"] { --t: min(18vh, calc(5vw * var(--scale))); }"#)
    );
    let tokens = include_str!("../assets/tokens.css").replace("\r\n", "\n");
    let reduced = tokens
        .split("@media (prefers-reduced-motion: reduce)")
        .nth(1)
        .expect("tokens.css has a reduced-motion block");
    assert!(reduced.contains("--dur-slow: 0ms;"));
    // The documented options and the documented keep-last time (docs/decks/remote.md).
    for option in [
        r#"pick("align", ["left", "center", "right"])"#,
        r#"pick("plate", ["1", "full"])"#,
        r#"pick("label", ["1"])"#,
        r#"pick("lang", ["en", "ro"])"#,
        "Number(s) >= 0.5 && Number(s) <= 3",
        "const KEEP_MS = 5000;",
    ] {
        assert!(page.contains(option), "now.html lost `{option}`");
    }
}
