// Run: cd apps/mixai; node --test "src/**/*.test.ts"
//
// Source guard for WP19-37 review P1-15: the grid surfaces must take every colour from the
// design tokens and every word from the catalogue. The repo hex-gate only matches `#rrggbb`,
// so the `rgba(...)` literals the canvas used slipped through CI — this catches both forms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deckMessages } from "../i18n/messages-deck.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** Source without comments: a guard must assert on code, not on prose that quotes the bug. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const SURFACES = ["../components/Waveform.tsx", "../components/GridEditor.tsx"] as const;

test("the grid surfaces hard-code no colour literal", () => {
    for (const file of SURFACES) {
        const src = code(file);
        assert.equal(/rgba?\(/.test(src), false, `${file}: rgb()/rgba() literal`);
        assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(src), false, `${file}: hex literal`);
        assert.equal(/\btext-(black|white)\b|\bbg-(black|white)\b/.test(src), false, `${file}: Tailwind black/white`);
        assert.equal(/hsl\(|\boklch\(\s*\d/.test(src), false, `${file}: raw colour function`);
        // Every colour that is there comes from a CSS variable.
        assert.match(src, /var\(--/, `${file}: expected token variables`);
    }
});

test("the waveform canvas draws no English literal: the badge comes from the catalogue", () => {
    const src = code("../components/Waveform.tsx");
    assert.equal(/fillText\(\s*"/.test(src), false, "no string literal painted on the canvas");
    // The badge must be the translated word, and no literal may stand in for it.
    assert.match(src, /badge\s*=\s*fixedLabel\s*\?\?\s*t\("grid\.fixed"\)/, "the badge text is translated");
    assert.equal(/"FIXED"|"FIX[ĂA]"/.test(src), false, "no hard-coded badge word");
    assert.ok(deckMessages.en["grid.fixed"] && deckMessages.ro["grid.fixed"], "grid.fixed exists in both locales");
    assert.notEqual(deckMessages.ro["grid.fixed"], deckMessages.en["grid.fixed"], "and is actually translated");
});

test("every grid string the editor renders exists in both locales, with real Romanian diacritics", () => {
    const src = code("../components/GridEditor.tsx");
    const used = [...src.matchAll(/t\("(grid\.[a-zA-Z]+)"/g)].map((m) => m[1]!);
    assert.ok(used.length >= 10, `expected the editor to use the catalogue, found ${used.length}`);
    for (const key of new Set(used)) {
        assert.ok(key in deckMessages.en, `${key} missing in en`);
        assert.ok(key in deckMessages.ro, `${key} missing in ro`);
    }
    // Cedilla ş/ţ (U+015F / U+0163) are the wrong characters; Romanian uses comma-below ș/ț.
    for (const [k, v] of Object.entries(deckMessages.ro)) {
        if (!k.startsWith("grid.")) continue;
        assert.equal(/[\u015F\u0163]/.test(v), false, `${k} uses cedilla instead of comma-below`);
    }
});
