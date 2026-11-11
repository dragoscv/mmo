// Run: node --test apps/mixai/src/packs/builtin-skins.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_SKINS, SKIN_CRATE, SKIN_GLASS_CLASSIC, SKIN_MAINROOM, SKIN_PILOT } from "./builtin-skins.ts";
import { COLOR_KEYS, contrastProblems, contrastRatio, isSafeColor, tokensToCss } from "./apply-tokens.ts";
import { packLayoutId, packLayouts } from "./pack-layouts.ts";
import { BUILTIN_LAYOUTS } from "../layout/presets.ts";
import { STYLE_COLORS, styleLayout, validateStyle } from "../look/style-vars.ts";

const byId = (id: string) => {
    const s = BUILTIN_SKINS.find((p) => p.manifest.id === id);
    assert.ok(s, `missing built-in skin ${id}`);
    return s;
};

/** Same resolution as `skinLayoutId` in pack-store.ts (that module needs the browser + Tauri). */
function resolveLayout(id: string): string | null {
    const s = byId(id);
    const known = [...BUILTIN_LAYOUTS.map((l) => l.id), ...packLayouts(BUILTIN_SKINS).map((l) => l.id)];
    const want = styleLayout(s.tokens?.style);
    if (!want) return null;
    const own = packLayoutId(s.manifest.id, want);
    if (known.includes(own)) return own;
    return known.includes(want) ? want : null;
}

test("built-in skin ids are unique, namespaced and include the four 1.5 skins", () => {
    const ids = BUILTIN_SKINS.map((s) => s.manifest.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^ro\.mixai\.skin\.[a-z0-9-]+$/);
    for (const id of [SKIN_GLASS_CLASSIC, SKIN_MAINROOM, SKIN_CRATE, SKIN_PILOT]) assert.ok(ids.includes(id), id);
    const names = BUILTIN_SKINS.map((s) => s.manifest.name);
    assert.equal(new Set(names).size, names.length);
});

test("every built-in validates: style block, colour grammar, allow-listed keys, manifest version", () => {
    for (const s of BUILTIN_SKINS) {
        const id = s.manifest.id;
        const tk = s.tokens!;
        assert.deepEqual(validateStyle(tk.style), [], id);
        assert.equal(s.manifest.v, tk.style ? 2 : 1, `${id}: a style block needs manifest v2`);
        assert.equal(s.manifest.kind, "skin");
        assert.equal(s.trust, "official");
        for (const [k, v] of Object.entries(tk.colors ?? {})) {
            assert.ok((COLOR_KEYS as readonly string[]).includes(k), `${id}: colour key ${k}`);
            assert.ok(isSafeColor(v), `${id}: colors.${k} = ${v}`);
        }
        for (const [k, v] of Object.entries(tk.decks ?? {})) {
            assert.ok(["a", "b", "c", "d"].includes(k), `${id}: deck ${k}`);
            assert.ok(isSafeColor(v), `${id}: decks.${k} = ${v}`);
        }
        // Nothing is silently dropped by the applier: every declared value reaches the CSS.
        const { css } = tokensToCss(tk);
        for (const [k, v] of Object.entries(tk.colors ?? {})) assert.ok(css.includes(`--${k}: ${v};`), `${id}: --${k} not rendered`);
        for (const [k, v] of Object.entries(tk.style?.colors ?? {})) {
            const prop = (STYLE_COLORS as Record<string, string>)[k]!;
            assert.ok(css.includes(`${prop}: ${v};`), `${id}: ${prop} not rendered`);
        }
    }
});

test("the layout a built-in skin selects exists", () => {
    assert.equal(resolveLayout(SKIN_GLASS_CLASSIC), "classic");
    assert.equal(resolveLayout(SKIN_MAINROOM), "pro");
    assert.equal(resolveLayout(SKIN_CRATE), "pro-vertical");
    assert.equal(resolveLayout(SKIN_PILOT), "pro");
    for (const s of BUILTIN_SKINS) {
        if (styleLayout(s.tokens?.style)) assert.ok(resolveLayout(s.manifest.id), `${s.manifest.id}: layout does not resolve`);
    }
});

test("the four 1.5 skins ask for the look, waves and platter of their brief", () => {
    const pick = (id: string) => {
        const r = tokensToCss(byId(id).tokens!);
        return { look: r.look, waves: r.waves, platter: r.platter, layout: r.layout, prefs: r.prefs };
    };
    assert.deepEqual(pick(SKIN_GLASS_CLASSIC), {
        look: "classic",
        waves: "stacked",
        platter: false,
        layout: "classic",
        prefs: { mode: "dark", surface: "glass", density: "comfortable", radius: "lg", accent: "violet" },
    });
    assert.deepEqual(pick(SKIN_MAINROOM), { look: "signature", waves: "stacked", platter: false, layout: "pro", prefs: { mode: "dark", surface: "flat", density: "compact", radius: "sm" } });
    assert.deepEqual(pick(SKIN_CRATE), { look: "signature", waves: "stacked", platter: true, layout: "pro-vertical", prefs: { mode: "dark", surface: "flat", density: "compact", radius: "sm" } });
    assert.deepEqual(pick(SKIN_PILOT), { look: "signature", waves: "overlay", platter: true, layout: "pro", prefs: { mode: "dark", surface: "flat", density: "compact", radius: "sm" } });
});

/*
 * `contrastProblems` only knows the five theme pairs. A full skin also sets the surfaces and
 * text levels of the Decks look, so check the pairs the components really draw:
 * text on panel / raised control / well, the dimmest text level (micro labels), the ON fill,
 * PLAY, CUE, and the data colours (deck readouts, waveform, playhead) on their backdrop.
 */
test("full skins keep every text level and state readable (WCAG AA)", () => {
    for (const id of [SKIN_MAINROOM, SKIN_CRATE, SKIN_PILOT]) {
        const tk = byId(id).tokens!;
        const c = tk.colors!;
        const s = tk.style!.colors!;
        const need = (fg: string | undefined, bg: string | undefined, min: number, what: string) => {
            assert.ok(fg && bg, `${id}: ${what} is not set`);
            const r = contrastRatio(fg, bg)!;
            assert.ok(r >= min, `${id}: ${what} ${fg} on ${bg} = ${r.toFixed(2)}:1, needs ${min}:1`);
        };
        assert.deepEqual(contrastProblems(tk), [], id);
        for (const bg of ["card", "secondary", "popover", "background"] as const) {
            need(c.foreground, c[bg], 4.5, `foreground on ${bg}`);
            need(c["muted-foreground"], c[bg], 4.5, `muted-foreground on ${bg}`);
            need(s.faint, c[bg], 4.5, `faint text on ${bg}`);
        }
        need(c.foreground, s.well, 4.5, "foreground on well");
        need(c["muted-foreground"], s.well, 4.5, "muted-foreground on well");
        need(s.faint, s.well, 4.5, "faint text on well");
        need(s.onFg, s.on, 4.5, "ON text on ON fill");
        need(c["accent-foreground"], c.accent, 4.5, "accent-foreground on accent");
        // ON fill, focus ring and control outline must be visible against the panel (3:1 = UI components).
        need(s.on, c.card, 3, "ON fill on panel");
        need(c.ring, c.card, 3, "focus ring on panel");
        need(c.ring, c.background, 3, "focus ring on window");
        need(s.cue, c.secondary, 4.5, "CUE label on control");
        need(s.alert, c.card, 3, "alert on panel");
        // Deck colours are text (BPM digits) and PLAY fills.
        for (const d of ["a", "b", "c", "d"] as const) {
            need(tk.decks?.[d], c.card, 4.5, `deck ${d} readout on panel`);
            need(s.playFg, s.play ?? tk.decks?.[d], 4.5, `PLAY label on deck ${d} PLAY fill`);
        }
        need(s.wavePlayhead, s.waveBg, 7, "playhead on waveform backdrop");
        need(s.waveGrid, s.waveBg, 3, "beat grid on waveform backdrop");
        for (const k of ["waveLow", "waveMid", "waveHigh"] as const) if (s[k]) need(s[k], s.waveBg, 2.4, `${k} on waveform backdrop`);
        for (let i = 1; i <= 8; i++) need(s[`cue${i}` as "cue1"], s.well, 2.4, `hot cue ${i} on well`);
    }
});

test("hot cue colours of a skin are eight different colours", () => {
    for (const id of [SKIN_MAINROOM, SKIN_CRATE, SKIN_PILOT]) {
        const s = byId(id).tokens!.style!.colors!;
        const cues = Array.from({ length: 8 }, (_, i) => s[`cue${i + 1}` as "cue1"]);
        assert.equal(new Set(cues).size, 8, id);
    }
});

test("descriptions name another product only with the non-affiliation wording; names stay neutral", () => {
    const products = /rekordbox|serato|virtualdj|virtual dj|traktor|pioneer|alphatheta|atomix|native instruments|algoriddim|djay|engine dj|denon/i;
    for (const s of BUILTIN_SKINS) {
        assert.ok(!products.test(s.manifest.name), `${s.manifest.id}: product name in the skin name`);
        assert.ok(!products.test(s.manifest.id), `${s.manifest.id}: product name in the skin id`);
        if (products.test(s.manifest.description)) {
            assert.match(s.manifest.description, /[Ff]amiliar to \S+ users; not affiliated with or endorsed by [^.]+\./, s.manifest.id);
        }
        assert.ok(s.manifest.description.length <= 140, `${s.manifest.id}: description too long for the card`);
    }
});
