// Run: node --test apps/mixai/src/packs/apply-tokens.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { contrastProblems, contrastRatio, isSafeColor, tokensToCss } from "./apply-tokens.ts";
import { BUILTIN_SKINS } from "./builtin-skins.ts";

test("every built-in skin passes the contrast gate and renders CSS", () => {
    for (const s of BUILTIN_SKINS) {
        assert.deepEqual(contrastProblems(s.tokens!), [], s.manifest.id);
        const { css, prefs } = tokensToCss(s.tokens!);
        assert.ok(css.length > 0 || Object.keys(prefs).length > 0, s.manifest.id);
    }
});

test("only safe colour syntaxes pass", () => {
    for (const ok of ["#112233", "#11223344", "oklch(0.6 0.2 285)", "oklch(60% 0.2 285 / 0.5)"]) assert.ok(isSafeColor(ok), ok);
    for (const bad of ["red", "#fff", "url(x)", "var(--a)", "oklch(0.6 0.2 285); } body{", "expression(1)"]) assert.ok(!isSafeColor(bad), bad);
});

test("tokensToCss keeps allow-listed keys and drops injected values", () => {
    const { css, prefs } = tokensToCss({
        mode: "light",
        surface: "flat",
        colors: { primary: "oklch(0.6 0.2 285)", evil: "#000000", background: "red; } * { display:none" },
        decks: { a: "#00ff88" },
        fontBody: "Inter",
    });
    assert.match(css, /--primary: oklch\(0.6 0.2 285\);/);
    assert.match(css, /--deck-a: #00ff88;/);
    assert.match(css, /--font-sans: "Inter"/);
    assert.doesNotMatch(css, /evil|display:none/);
    assert.deepEqual(prefs, { mode: "light", surface: "flat" });
});

test("fonts and backgrounds require data URLs of allowed types", () => {
    const font = "data:font/woff2;base64,AAAA";
    const img = "data:image/png;base64,AAAA";
    const { css } = tokensToCss({ background: "assets/bg.png" }, { "assets/bg.png": img, "fonts/x.woff2": font }, [{ family: "Neo", file: "fonts/x.woff2" }]);
    assert.match(css, /@font-face \{ font-family: "Neo"/);
    assert.match(css, /url\("data:image\/png/);
    const bad = tokensToCss({ background: "a.png" }, { "a.png": "javascript:alert(1)" });
    assert.equal(bad.css, "");
});

test("contrast: black on white is 21:1 and low-contrast skins are reported", () => {
    assert.equal(Math.round(contrastRatio("#000000", "#ffffff")! * 10) / 10, 21);
    const probs = contrastProblems({ colors: { foreground: "#777777", background: "#888888", primary: "oklch(0.9 0.05 100)", "primary-foreground": "#ffffff" } });
    assert.ok(probs.some((p) => p.fg === "foreground"));
    assert.ok(probs.some((p) => p.fg === "primary-foreground"));
    assert.deepEqual(contrastProblems({ colors: { foreground: "#f5f5f5", background: "#0a0a12" } }), []);
});
