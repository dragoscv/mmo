// Run: node --test apps/mixai/src/packs/apply-tokens.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { contrastProblems, contrastRatio, isSafeColor, tokensToCss } from "./apply-tokens.ts";
import { BUILTIN_SKINS } from "./builtin-skins.ts";
import { isStyleColor } from "../look/style-vars.ts";
import { formatOklch, fromPicker, isColorText, normalizeColorText, parseColor, toHex, toOklchText } from "../settings/skin-editor/color.ts";

test("every built-in skin passes the contrast gate and renders CSS", () => {
    for (const s of BUILTIN_SKINS) {
        assert.deepEqual(contrastProblems(s.tokens!), [], s.manifest.id);
        const { css, prefs } = tokensToCss(s.tokens!);
        assert.ok(css.length > 0 || Object.keys(prefs).length > 0, s.manifest.id);
    }
});

test("only safe colour syntaxes pass", () => {
    for (const ok of ["#112233", "#11223344", "oklch(0.6 0.2 285)", "oklch(60% 0.2 285 / 0.5)"]) assert.ok(isSafeColor(ok), ok);
    for (const bad of ["red", "#fff", "url(x)", "var(--a)", "oklch(0.6 0.2 285); } body{", "expression(1)", "oklch(0.6 0.2 285.)", "oklch(0.6. 0.2 285)", "oklch(0.6 0..2 285)", "oklch(0.6 . 285)"]) assert.ok(!isSafeColor(bad), bad);
    assert.ok(isSafeColor("oklch(.6 .2 285)"), "a leading dot is a number");
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

// ── skin editor colour conversion (settings/skin-editor/color.ts). The hex inputs live here: this
//    file is the one the hex gate exempts for colour-parser tests. ──

test("editor colour text: both grammars parse, anything else is refused", () => {
    for (const ok of ["#112233", "#11223380", "oklch(0.6 0.2 285)", "oklch(60% 0.2 285 / 0.5)", "  #AABBCC "]) assert.ok(isColorText(ok), ok);
    for (const bad of ["", "red", "#fff", "rgb(1 2 3)", "var(--x)", "oklch(0.6 0.2)", "oklch(2 0.2 20)", "oklch(0.6 0.9 20)", "oklch(0.6 0.2 285); }"]) assert.ok(!isColorText(bad), bad);
});

test("editor hex → oklch → hex is exact for 8-bit colours, and the oklch text passes both validators", () => {
    const samples = ["#000000", "#ffffff", "#1470e6", "#2e2f34", "#f76b7a", "#0a7ac6", "#ffbb00", "#17181b", "#808080", "#00ae00", "#010203", "#fefdfc"];
    // A deterministic sweep on top of the hand-picked ones (every 37th step of each channel).
    for (let i = 0; i < 400; i++) samples.push(`#${[(i * 37) % 256, (i * 91 + 13) % 256, (i * 151 + 7) % 256].map((n) => n.toString(16).padStart(2, "0")).join("")}`);
    for (const hex of samples) {
        const ok = toOklchText(hex)!;
        assert.ok(isSafeColor(ok) && isStyleColor(ok), `${hex} -> ${ok}`);
        assert.equal(toHex(ok), hex, `${hex} -> ${ok}`);
    }
    assert.equal(toHex("not a colour", "#123456"), "#123456");
    assert.equal(toHex("nope"), "#000000");
});

test("a near-grey hex keeps its hue as oklch text (why the editor writes oklch)", () => {
    const c = parseColor("#2e2f34")!;
    assert.ok(c.c > 0.005 && c.h > 260 && c.h < 290, JSON.stringify(c));
    assert.equal(parseColor("#808080")!.h, 0);
});

test("the editor's picker writes oklch and keeps the alpha of the value it replaces", () => {
    assert.match(fromPicker("#1470e6")!, /^oklch\([0-9.]+ [0-9.]+ [0-9.]+\)$/);
    assert.match(fromPicker("#1470e6", "oklch(0.5 0.1 20 / 0.5)")!, / \/ 0\.5\)$/);
    assert.match(fromPicker("#1470e6", "#11223380")!, / \/ 0\.5\)$/);
    assert.equal(fromPicker("blue"), null);
    assert.equal(formatOklch({ l: 0.5, c: 0.1, h: 400, a: 1 }), "oklch(0.5 0.1 40)");
});

test("the editor stores a grey with no visible tint as hex and a tinted colour as oklch", () => {
    // No tint: hueless hex, so a mix with a saturated colour takes that colour's hue.
    assert.equal(fromPicker("#808080"), "#808080");
    assert.equal(fromPicker("#2a2928"), "#2a2928");
    assert.equal(fromPicker("#808080", "#11223380"), "#80808080");
    assert.equal(normalizeColorText("#FFFFFF"), "#ffffff");
    // Visible tint (a blue-grey panel): oklch keeps the hue in grey + grey mixes.
    assert.match(fromPicker("#2e2f34")!, /^oklch\(/);
    assert.match(normalizeColorText("#402020")!, /^oklch\(/);
    assert.equal(normalizeColorText("nope"), null);
    for (const v of [fromPicker("#2a2928")!, fromPicker("#2e2f34")!, fromPicker("#808080", "#11223380")!]) assert.ok(isSafeColor(v) && isStyleColor(v), v);
});
