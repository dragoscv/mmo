// Run: node --test apps/mixai/src/settings/skin-editor/model.test.ts
// Colour values here are oklch() text; the hex ↔ oklch conversion tests (hex inputs) are in
// packs/apply-tokens.test.ts, the file the hex gate exempts for colour-parser tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COLOR_KEYS, contrastRatio, tokensToCss } from "../../packs/apply-tokens.ts";
import { BUILTIN_SKINS } from "../../packs/builtin-skins.ts";
import { STYLE_COLORS, STYLE_SIZES, validateStyle, type StyleColorKey, type StyleSizeKey } from "../../look/style-vars.ts";
import { skinsMessages } from "../../i18n/messages-skins.ts";
import {
    COLOR_SECTIONS,
    CUE_COLORS,
    DECK_IDS,
    GROUPS,
    SHAPE_SIZES,
    THEME_COLOR_KEYS,
    WAVE_COLORS,
    WAVE_SIZES,
    buildRequest,
    clampSize,
    cleanTokens,
    draftProblems,
    nextVersion,
    setBase,
    setDeckColor,
    setStyleColor,
    setStyleOption,
    setStyleSize,
    setThemeColor,
    skinId,
    slugify,
} from "./model.ts";

const sorted = (a: readonly string[]) => [...a].sort();
const PANEL = "oklch(0.24 0 0)";
const BLUE = "oklch(0.565 0.196 258)";
const CYAN = "oklch(0.7 0.12 225)";
const BLACK = "oklch(0 0 0)";

test("the editor shows every colour and size a skin may set, each exactly once", () => {
    const theme = COLOR_SECTIONS.flatMap((s) => s.theme);
    assert.deepEqual(sorted(theme), sorted(THEME_COLOR_KEYS));
    assert.deepEqual(sorted([...theme, ...DECK_IDS.map((d) => `deck-${d}`)]), sorted(COLOR_KEYS));
    const style = [...COLOR_SECTIONS.flatMap((s) => s.style), ...WAVE_COLORS, ...CUE_COLORS];
    assert.deepEqual(sorted(style), sorted(Object.keys(STYLE_COLORS)));
    assert.equal(new Set(style).size, style.length);
    assert.deepEqual(sorted([...SHAPE_SIZES, ...WAVE_SIZES]), sorted(Object.keys(STYLE_SIZES)));
});

test("every field and group has a label in en and ro", () => {
    for (const loc of ["en", "ro"] as const) {
        const m = skinsMessages[loc] as Record<string, string>;
        for (const k of THEME_COLOR_KEYS) assert.ok(m[`skins.c.${k}`], `${loc} skins.c.${k}`);
        for (const k of Object.keys(STYLE_COLORS)) if (!/^cue\d$/.test(k)) assert.ok(m[`skins.s.${k}`], `${loc} skins.s.${k}`);
        for (const k of Object.keys(STYLE_SIZES)) assert.ok(m[`skins.z.${k}`], `${loc} skins.z.${k}`);
        for (const g of GROUPS) assert.ok(m[`skins.g.${g}`], `${loc} skins.g.${g}`);
    }
});

test("built-in skin descriptions: same legal wording in en (manifest) and a ro text for each", () => {
    for (const s of BUILTIN_SKINS) {
        const slug = s.manifest.id.replace("ro.mixai.skin.", "");
        const en = (skinsMessages.en as Record<string, string>)[`skins.b.${slug}.desc`];
        if (en === undefined) continue;
        assert.equal(en, s.manifest.description, slug);
        const ro = (skinsMessages.ro as Record<string, string>)[`skins.b.${slug}.desc`]!;
        if (/not affiliated/.test(en)) assert.match(ro, /fără nicio afiliere cu .+ și fără aprobarea acesteia/, slug);
    }
    for (const slug of ["mainroom", "crate", "pilot", "glass-classic"]) assert.ok((skinsMessages.en as Record<string, string>)[`skins.b.${slug}.desc`], slug);
});

test("editing a draft adds and removes entries without leaving empty objects", () => {
    let t = setThemeColor({}, "card", PANEL);
    t = setStyleColor(t, "on", BLUE);
    t = setStyleSize(t, "panelGap", 99);
    t = setDeckColor(t, "a", CYAN);
    t = setStyleOption(t, { waves: "overlay", platter: true });
    t = setBase(t, { mode: "dark" });
    assert.deepEqual(t, { mode: "dark", colors: { card: PANEL }, decks: { a: CYAN }, style: { waves: "overlay", platter: true, colors: { on: BLUE }, sizes: { panelGap: 16 } } });
    t = setThemeColor(t, "card", null);
    t = setStyleColor(t, "on", null);
    t = setStyleSize(t, "panelGap", null);
    t = setDeckColor(t, "a", null);
    t = setStyleOption(t, { waves: undefined, platter: undefined });
    t = setBase(t, { mode: undefined });
    assert.deepEqual(t, {});
    assert.deepEqual(setThemeColor({}, "deck-a", CYAN), {}, "deck colours go through `decks`");
    assert.deepEqual(setThemeColor({}, "evil", CYAN), {});
});

test("sizes are clamped to the validator's range and stepped", () => {
    for (const k of Object.keys(STYLE_SIZES) as StyleSizeKey[]) {
        const { min, max } = STYLE_SIZES[k];
        assert.equal(clampSize(k, -1000), min);
        assert.equal(clampSize(k, 1000), max);
        assert.deepEqual(validateStyle({ sizes: { [k]: clampSize(k, (min + max) / 2) } }), []);
    }
    assert.equal(clampSize("wavePlayedAlpha", 0.437), 0.45);
    assert.equal(clampSize("panelRadius", 3.4), 3);
});

test("cleanTokens keeps exactly what the validators accept", () => {
    const dirty = {
        mode: "dark",
        accent: "chartreuse",
        surface: "flat",
        fontBody: "Inter",
        background: "assets/bg.png",
        colors: { card: PANEL, evil: BLACK, background: "red" },
        decks: { a: CYAN, z: CYAN },
        style: { look: "classic", waves: "sideways", platter: "yes", layout: "Not A Layout", colors: { on: BLUE, toString: BLACK, play: "url(x)" }, sizes: { panelGap: 4, panelPad: 99, constructor: 3 } },
    } as unknown as Parameters<typeof cleanTokens>[0];
    const clean = cleanTokens(dirty);
    assert.deepEqual(clean, { mode: "dark", surface: "flat", colors: { card: PANEL }, decks: { a: CYAN }, style: { look: "classic", colors: { on: BLUE }, sizes: { panelGap: 4 } } });
    assert.deepEqual(validateStyle(clean.style), []);
    assert.deepEqual(cleanTokens({}), {});
    // Built-in skins survive unchanged (the editor starts from them).
    for (const s of BUILTIN_SKINS) assert.deepEqual(cleanTokens(s.tokens!), s.tokens, s.manifest.id);
});

test("a cleaned draft renders through the same path as a skin", () => {
    const t = cleanTokens(setStyleSize(setStyleColor(setThemeColor({}, "card", "oklch(0.3 0.01 270)"), "waveLow", "oklch(0.6 0.2 25)"), "controlHeight", 28));
    const { css } = tokensToCss(t);
    assert.equal(css, ":root[data-skin] { --card: oklch(0.3 0.01 270); --skin-wave-low: oklch(0.6 0.2 25); --ctl-h: 28px; }");
});

test("skin ids: user.skin.<slug>, accepted by the pack id rule", () => {
    assert.equal(slugify("  Țara Mea — Booth #2  "), "tara-mea-booth-2");
    assert.equal(skinId("My Booth"), "user.skin.my-booth");
    assert.equal(skinId("ȘȚ ăâî"), "user.skin.st-aai");
    assert.equal(skinId("  ---  "), null);
    assert.equal(skinId("日本"), null);
    const packId = /^[a-z0-9]+(\.[a-z0-9-]+){1,6}$/;
    for (const n of ["My Booth", "a", "x".repeat(200), "Neon.2026 / v2"]) {
        const id = skinId(n)!;
        assert.match(id, packId);
        assert.ok(id.length <= 100 && !id.endsWith("-"), id);
        assert.ok(!id.startsWith("ro.mixai."), "reserved prefix");
    }
});

test("versions: first save 1.0.0, saving again bumps the patch", () => {
    assert.equal(nextVersion(), "1.0.0");
    assert.equal(nextVersion("1.0.0"), "1.0.1");
    assert.equal(nextVersion("2.3.9"), "2.3.10");
    assert.equal(nextVersion("garbage"), "1.0.0");
});

test("buildRequest: complete request, or null without a usable name", () => {
    assert.equal(buildRequest({}, { name: " ", author: "Me", version: "1.0.0" }), null);
    const req = buildRequest({ colors: { card: PANEL, evil: BLACK } }, { name: "  My Booth ", author: " ", description: "x".repeat(900), version: "1.0.0" })!;
    assert.deepEqual({ ...req, description: req.description.length }, { id: "user.skin.my-booth", name: "My Booth", author: "DJ", description: 500, version: "1.0.0", tokens: { colors: { card: PANEL } } });
    assert.ok(buildRequest({}, { name: "n".repeat(100), author: "Me", version: "1.0.0" })!.name.length <= 60);
});

test("contrast problems compare a set colour with the running app's colour for the other side", () => {
    const app: Record<string, string> = {
        "--background": "oklch(0.17 0 0)",
        "--card": PANEL,
        "--foreground": "oklch(0.97 0 0)",
        "--secondary": "oklch(0.28 0 0)",
        "--well": "oklch(0.14 0 0)",
        "--on": "oklch(0.75 0.19 150)",
        "--on-fg": "oklch(0.17 0.03 150)",
    };
    const eff = (p: string) => app[p] ?? null;
    assert.deepEqual(draftProblems({}, eff), [], "an empty draft reports nothing");
    const grey = draftProblems(setThemeColor({}, "foreground", "oklch(0.35 0 0)"), eff);
    assert.deepEqual(
        grey.map((p) => `${p.fg.key}/${p.bg.key}`),
        ["foreground/background", "foreground/card", "foreground/secondary", "foreground/well"],
    );
    for (const p of grey) assert.ok(p.ratio < p.need && p.need === 4.5);
    const on = draftProblems(setStyleColor({}, "onFg", "oklch(0.75 0.19 150)"), eff);
    assert.deepEqual(on.map((p) => `${p.fg.key}/${p.bg.key}`), ["onFg/on"]);
    assert.equal(on[0]!.ratio, 1);
    // Unknown other side: not reported (no guess).
    assert.deepEqual(draftProblems(setStyleColor({}, "faint", BLACK), () => null), []);
    assert.ok(contrastRatio(app["--foreground"]!, app["--background"]!)! > 4.5);
});

test("style colour keys used by the groups exist", () => {
    for (const k of [...WAVE_COLORS, ...CUE_COLORS] as StyleColorKey[]) assert.ok(Object.hasOwn(STYLE_COLORS, k), k);
});
