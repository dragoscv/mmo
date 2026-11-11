// Run: cd apps/mixai; node --test "src/**/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { STYLE_COLORS, STYLE_SIZES, styleDecls, styleLayout, styleLook, styleWaves, validateStyle, type PackStyle } from "./style-vars.ts";

// Colours as oklch(): the repo hex gate also scans test files.
const GREEN = "oklch(0.8 0.2 150)";
const RED = "oklch(0.6 0.25 25)";
const NAVY = "oklch(0.25 0.05 260)";
const WHITE = "oklch(1 0 0)";

test("a full, valid style block validates and renders one declaration per entry", () => {
    const style: PackStyle = {
        look: "signature",
        platter: true,
        layout: "pro-vertical",
        waves: "overlay",
        colors: { on: GREEN, waveLow: "oklch(0.5 0.2 30)", cue1: RED },
        sizes: { panelGap: 4, controlRadius: 0, wavePlayedAlpha: 0.5, controlHeight: 28 },
    };
    assert.deepEqual(validateStyle(style), []);
    assert.deepEqual(styleDecls(style), [
        `--on: ${GREEN};`,
        "--skin-wave-low: oklch(0.5 0.2 30);",
        `--cue-1: ${RED};`,
        "--panel-gap: 4;",
        "--ctl-radius: 0px;",
        "--wave-played-alpha: 0.5;",
        "--ctl-h: 28px;",
    ]);
    assert.equal(styleLook(style), "signature");
    assert.equal(styleLayout(style), "pro-vertical");
    assert.equal(styleWaves(style), "overlay");
});

test("names from Object.prototype are not style keys (never validated, never emitted)", () => {
    for (const key of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
        // JSON.parse creates `__proto__` as an own key, like a pack's tokens.json would.
        const colors = JSON.parse(`{ "${key}": "${WHITE}" }`) as Record<string, string>;
        const sizes = JSON.parse(`{ "${key}": 4 }`) as Record<string, number>;
        assert.deepEqual(validateStyle({ colors }), [`unknown style colour '${key}'`], key);
        assert.deepEqual(validateStyle({ sizes }), [`unknown style size '${key}'`], key);
        assert.deepEqual(styleDecls({ colors, sizes } as PackStyle), [], key);
    }
});

test("every rejection has its message; bad entries are dropped one by one, good ones kept", () => {
    assert.deepEqual(validateStyle("x"), ["style must be an object"]);
    assert.deepEqual(validateStyle({ nope: 1 }), ["unknown style key 'nope'"]);
    assert.deepEqual(validateStyle({ look: "glass" }), ["style.look must be signature or classic"]);
    assert.deepEqual(validateStyle({ platter: "yes" }), ["style.platter must be true or false"]);
    assert.deepEqual(validateStyle({ waves: "split" }), ["style.waves must be stacked or overlay"]);
    for (const layout of ["Pro", "a/b", "", "x".repeat(49), 5]) assert.equal(validateStyle({ layout }).length, 1, String(layout));
    assert.deepEqual(validateStyle({ colors: { on: "red; } body {" } }), ["style.colors.on must be a valid colour"]);
    assert.deepEqual(validateStyle({ sizes: { panelGap: 17 } }), ["style.sizes.panelGap must be a number in 0..16"]);
    assert.deepEqual(validateStyle({ sizes: { panelGap: "4" } }), ["style.sizes.panelGap must be a number in 0..16"]);
    assert.deepEqual(validateStyle({ sizes: { panelGap: Number.NaN } }), ["style.sizes.panelGap must be a number in 0..16"]);
    const decls = styleDecls({ colors: { on: "url(x)", play: NAVY }, sizes: { panelGap: 99, padRadius: 2 } } as PackStyle);
    assert.deepEqual(decls, [`--skin-play: ${NAVY};`, "--pad-radius: 2px;"]);
    // Invalid look / layout / waves fall back instead of leaking through.
    assert.equal(styleLook({ look: "glass" } as unknown as PackStyle), "signature");
    assert.equal(styleLayout({ layout: "A B" } as PackStyle), null);
    assert.equal(styleWaves({ waves: "split" } as unknown as PackStyle), "stacked");
});

test("the allow-lists only name custom properties and sane ranges", () => {
    for (const prop of Object.values(STYLE_COLORS)) assert.match(prop, /^--[a-z0-9-]+$/);
    for (const s of Object.values(STYLE_SIZES)) {
        assert.match(s.prop, /^--[a-z0-9-]+$/);
        assert.ok(s.min < s.max);
        assert.ok(["", "px"].includes(s.unit));
    }
});
