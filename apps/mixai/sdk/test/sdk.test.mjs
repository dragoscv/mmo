import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { contrastProblems, normalizeColor, validColor } from "../lib/color.mjs";
import { importDtcg, mapTokenName } from "../lib/dtcg.mjs";
import { BUILTIN_LAYOUT_IDS, PANEL_IDS, validateLayout } from "../lib/layout.mjs";
import { buildCatalog, buildPack } from "../lib/pack.mjs";
import { canonicalDigest, generateTestSeed, signatureFor, verifyFiles } from "../lib/sign.mjs";
import { STYLE_COLOR_KEYS, STYLE_KEYS, STYLE_LOOKS, STYLE_SIZES, STYLE_WAVES, validateFiles, validatePath, validateStyle } from "../lib/validate.mjs";
import { readZip, writeZip, entryNameError } from "../lib/zip.mjs";
import { main } from "../mixaipack.mjs";
import { SAMPLE_STYLE, TEST_SEED, TEST_KEY_ID, sampleFiles, styleSampleFiles } from "../tools/fixture.mjs";

const quiet = () => {};
const json = (v) => Buffer.from(JSON.stringify(v));
/** A text file next to the SDK, with LF line ends whatever the checkout (core.autocrlf) made of it. */
const text = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
/** Entries of a pack as [name, base64] pairs (compares content, not the deflate stream). */
const entries = (bytes) => [...readZip(bytes)].map(([n, b]) => [n, b.toString("base64")]);

/** sampleFiles() with the manifest at version `v` and `style` added to the tokens. */
function styledFiles(v, style) {
    const f = sampleFiles();
    f.set("manifest.json", json({ ...JSON.parse(f.get("manifest.json")), v }));
    f.set("tokens.json", json({ ...JSON.parse(f.get("tokens.json")), style }));
    return f;
}

describe("zip", () => {
    it("round-trips deterministically with sorted entries", () => {
        const files = new Map([["b.json", Buffer.from("{}")], ["a.json", Buffer.from('{"x":1}')], ["assets/p.png", Buffer.from([1, 2, 3])]]);
        const z1 = writeZip(files);
        const z2 = writeZip(new Map([...files].reverse()));
        assert.deepEqual(z1, z2);
        const back = readZip(z1);
        assert.deepEqual([...back.keys()], ["a.json", "assets/p.png", "b.json"]);
        assert.equal(back.get("a.json").toString(), '{"x":1}');
    });
    it("rejects bad entry names", () => {
        for (const n of ["../x.json", "/abs.json", "a\\b.json", "c:x.json", "a//b.json", "./a.json", "a\u0001.json"]) {
            assert.ok(entryNameError(n), n);
        }
        assert.equal(entryNameError("layouts/main.json"), null);
        assert.throws(() => writeZip(new Map([["../evil.json", Buffer.from("{}")]])), /invalid entry name/);
    });
    it("refuses disallowed extensions when reading", () => {
        // Hand-craft a zip containing a .js entry by writing an allowed one and patching the name.
        const z = writeZip(new Map([["evil.jsn", Buffer.from("x")]]).set("ok.json", Buffer.from("{}")));
        assert.throws(() => readZip(z), /file type not allowed/);
    });
});

describe("sign / verify", () => {
    it("round-trips pack -> verify as community with an embedded key", () => {
        const { bytes } = buildPack(sampleFiles(), { seed: TEST_SEED, keyId: TEST_KEY_ID, embedPubkey: true });
        const files = readZip(bytes);
        assert.equal(verifyFiles(files), "community");
        const res = validateFiles(files, { fromZip: true });
        assert.ok(res.ok, res.errors.join("; "));
        assert.equal(res.trust, "community");
    });
    it("detects tampering, added files and removed files", () => {
        const { bytes } = buildPack(sampleFiles(), { seed: TEST_SEED, keyId: TEST_KEY_ID, embedPubkey: true });
        const files = readZip(bytes);
        const tampered = new Map(files);
        tampered.set("tokens.json", Buffer.from(files.get("tokens.json").toString().replace("dark", "light")));
        assert.throws(() => verifyFiles(tampered), /signature is invalid/);
        const added = new Map(files).set("presets/x.json", Buffer.from("{}"));
        assert.throws(() => verifyFiles(added), /signature is invalid/);
        const removed = new Map(files);
        removed.delete("assets/preview.png");
        assert.throws(() => verifyFiles(removed), /signature is invalid/);
    });
    it("a pack claiming the official key id is checked against the table key", () => {
        const f = sampleFiles();
        f.set("signature.json", signatureFor(f, TEST_SEED, "mixai-official-2026", { embedPubkey: true }));
        assert.throws(() => verifyFiles(readZip(writeZip(f))), /signature is invalid/);
        // buildPack refuses to emit a pack Rust would reject (wrong key for an official id).
        assert.throws(() => buildPack(sampleFiles(), { seed: TEST_SEED, keyId: "mixai-official-2026" }), /does not re-validate/);
    });
    it("unknown key without pubkey is refused; no signature = unsigned", () => {
        const f = sampleFiles();
        f.set("signature.json", signatureFor(f, TEST_SEED, "someone", { embedPubkey: false }));
        assert.throws(() => verifyFiles(readZip(writeZip(f))), /unknown signing key/);
        assert.equal(verifyFiles(readZip(buildPack(sampleFiles()).bytes)), "unsigned");
    });
    it("canonical digest ignores signature.json and is order-independent", () => {
        const a = sampleFiles();
        const b = new Map([...a].reverse()).set("signature.json", Buffer.from("{}"));
        assert.deepEqual(canonicalDigest(a), canonicalDigest(b));
    });
    it("different random keys produce different signatures", () => {
        const s1 = buildPack(sampleFiles(), { seed: generateTestSeed(), keyId: "k", embedPubkey: true }).bytes;
        const s2 = buildPack(sampleFiles(), { seed: generateTestSeed(), keyId: "k", embedPubkey: true }).bytes;
        assert.notDeepEqual(s1, s2);
    });
});

describe("validation", () => {
    it("rejects unknown manifest fields, bad ids, missing files", () => {
        const f = sampleFiles();
        const m = JSON.parse(f.get("manifest.json"));
        f.set("manifest.json", Buffer.from(JSON.stringify({ ...m, id: "Bad Id", extra: 1, preview: "assets/nope.png" })));
        const res = validateFiles(f);
        assert.equal(res.ok, false);
        const all = res.errors.join("\n");
        assert.match(all, /unknown field `extra`/);
        assert.match(all, /manifest\.id 'Bad Id'/);
    });
    it("refuses what the app refuses: a fractional manifest version and non-White_Space separators", () => {
        // serde reads `v` as u32: `2.0` / `2e0` are refused there, while JSON.parse makes them the integer 2.
        const base = sampleFiles().get("manifest.json").toString();
        const withV = (v) => base.replace(/"v"\s*:\s*1/, `"v": ${v}`);
        assert.notEqual(withV("2.0"), base, "the fixture manifest carries \"v\": 1");
        for (const v of ["2.0", "2e0", "1.0"]) {
            const f = sampleFiles();
            f.set("manifest.json", Buffer.from(withV(v)));
            assert.match(validateFiles(f).errors.join("\n"), /`v` must be written as an integer/, v);
        }
        for (const v of ["1", "2"]) {
            const f = sampleFiles();
            f.set("manifest.json", Buffer.from(withV(v)));
            const res = validateFiles(f);
            assert.ok(res.ok, `${v}: ${res.errors.join("; ")}`);
        }
        // Rust splits on Unicode White_Space: U+FEFF is not in it (JS \s has it), U+0085 is (JS \s lacks it).
        assert.equal(validColor("oklch(0.5\ufeff0.1 20)"), false);
        assert.equal(validColor("oklch(0.5 0.1 20 /\ufeff0.5)"), false);
        assert.equal(validColor("oklch(0.5\u00850.1 20)"), true);
        assert.equal(validColor("oklch(0.5\u00a00.1\t20 / 0.5 )"), true);
        assert.equal(validColor("oklch(0.5 0.1 20)"), true);
    });
    it("preview refuses a manifest preview path outside the folder", () => {
        const tmp = mkdtempSync(join(tmpdir(), "mixaipack-prev-"));
        try {
            const dir = join(tmp, "pack");
            assert.equal(main(["init", dir, "--kind", "skin", "--id", "com.test.skin.prev", "--name", "Prev"], quiet), 0);
            const mf = join(dir, "manifest.json");
            const m = JSON.parse(readFileSync(mf, "utf8"));
            for (const bad of ["../../escaped.png", "/abs.png", "c:evil.png", "assets/x.json"]) {
                writeFileSync(mf, JSON.stringify({ ...m, preview: bad }));
                const out = [];
                assert.equal(main(["preview", dir], (s) => out.push(s)), 1, bad);
                assert.match(out.join("\n"), /invalid entry name|must be one of/, bad);
            }
            assert.equal(existsSync(join(tmp, "escaped.png")), false, "nothing written outside the pack folder");
            writeFileSync(mf, JSON.stringify(m));
            assert.equal(main(["preview", dir], quiet), 0);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
    it("rejects bad colours and unknown colour keys", () => {
        const f = sampleFiles();
        f.set("tokens.json", Buffer.from(JSON.stringify({ colors: { background: "red", sparkle: "#ffffff", foreground: "url(x)" } })));
        const res = validateFiles(f);
        const all = res.errors.join("\n");
        assert.match(all, /colour 'red' for 'background'/);
        assert.match(all, /colour token 'sparkle' is not allowed/);
    });
    it("accepts the DTCG colour group in tokens.json", () => {
        const f = sampleFiles();
        f.set("tokens.json", Buffer.from(JSON.stringify({ mode: "dark", color: { $type: "color", "deck-a": { $value: "#00e5ff" } } })));
        const res = validateFiles(f);
        assert.ok(res.ok, res.errors.join("; "));
        assert.equal(res.tokens.colors["deck-a"], "#00e5ff");
    });
    it("contrast failures are errors unless allowed", () => {
        const f = sampleFiles();
        f.set("tokens.json", Buffer.from(JSON.stringify({ colors: { background: "#ffffff", foreground: "#eeeeee" } })));
        const strict = validateFiles(f);
        assert.equal(strict.ok, false);
        assert.match(strict.errors.join("\n"), /low contrast: foreground on background/);
        const lax = validateFiles(f, { allowLowContrast: true });
        assert.ok(lax.ok, lax.errors.join("; "));
        assert.match(lax.warnings.join("\n"), /low contrast/);
    });
    it("validates layout files with the solver rules", () => {
        assert.deepEqual(validateLayout({ v: 1, id: "x", name: "X", columns: [1], rows: [1], areas: [{ panel: "deckA", col: 0, row: 0 }] }), ["missing essential panel deckB", "missing essential panel mixer"]);
        const errs = validateLayout({ v: 1, id: "x", name: "X", columns: [1, 1], rows: [1], areas: [{ panel: "deckA", col: 0, row: 0, colSpan: 2 }, { panel: "deckB", col: 1, row: 0 }, { panel: "mixer", col: 2, row: 0 }, { panel: "nope", col: 0, row: 0 }] });
        assert.ok(errs.includes("areas[1]: deckB overlaps cell 1,0"));
        assert.ok(errs.includes("areas[2]: mixer outside the grid"));
        assert.ok(errs.includes("areas[3]: unknown panel"));
        const f = sampleFiles();
        f.set("layouts/main.json", Buffer.from(JSON.stringify({ v: 1, id: "Main", name: "", columns: [], rows: [1], areas: [] })));
        const res = validateFiles(f);
        assert.match(res.errors.join("\n"), /layout 'layouts\/main.json': id must be a lowercase slug/);
    });
    it("refuses source files with disallowed extensions", () => {
        const f = sampleFiles().set("assets/x.svg", Buffer.from("<svg/>"));
        assert.match(validateFiles(f).errors.join("\n"), /file type not allowed: 'assets\/x.svg'/);
    });
});

describe("manifest v2 + style block", () => {
    it("accepts manifest v1 and v2; newer versions ask for a newer Decks", () => {
        for (const v of [1, 2]) {
            const f = sampleFiles();
            f.set("manifest.json", json({ ...JSON.parse(f.get("manifest.json")), v }));
            const res = validateFiles(f);
            assert.ok(res.ok, `v${v}: ${res.errors.join("; ")}`);
            assert.equal(res.manifest.v, v);
        }
        for (const v of [3, 7]) {
            const f = sampleFiles();
            f.set("manifest.json", json({ ...JSON.parse(f.get("manifest.json")), v }));
            assert.deepEqual(validateFiles(f).errors, [`manifest version ${v} is not supported: this pack needs a newer MixAI Decks (this version reads 1 and 2)`]);
        }
        const zero = sampleFiles();
        zero.set("manifest.json", json({ ...JSON.parse(zero.get("manifest.json")), v: 0 }));
        assert.deepEqual(validateFiles(zero).errors, ["unsupported manifest version 0 (expected 1 or 2)"]);
    });
    it("accepts a v2 skin with every style field and returns it in the tokens", () => {
        const res = validateFiles(styledFiles(2, SAMPLE_STYLE));
        assert.ok(res.ok, res.errors.join("; "));
        assert.deepEqual(res.warnings, []);
        assert.deepEqual(res.tokens.style, SAMPLE_STYLE);
        // The other tokens are untouched by the style block.
        assert.equal(res.tokens.colors["deck-a"], "#00e5ff");
        assert.deepEqual(Object.keys(SAMPLE_STYLE.colors), STYLE_COLOR_KEYS);
        assert.deepEqual(Object.keys(SAMPLE_STYLE.sizes), Object.keys(STYLE_SIZES));
        // null = no style block, in either version.
        for (const v of [1, 2]) {
            const none = validateFiles(styledFiles(v, null));
            assert.ok(none.ok, none.errors.join("; "));
            assert.equal(none.tokens.style, undefined);
        }
    });
    it("refuses a style block in a v1 pack", () => {
        const res = validateFiles(styledFiles(1, SAMPLE_STYLE));
        assert.deepEqual(res.errors, ['tokens.style needs manifest version 2 (this pack declares "v": 1)']);
        assert.equal(res.tokens, null);
        assert.match(validateFiles(styledFiles(1, {})).errors.join("\n"), /needs manifest version 2/);
        // buildPack refuses to write such a pack at all.
        assert.throws(() => buildPack(styledFiles(1, SAMPLE_STYLE)), /tokens\.style needs manifest version 2/);
    });
    it("rejects every bad style entry with the app's message", () => {
        const cases = [
            [[], "style must be an object"],
            ["classic", "style must be an object"],
            [{ glow: 1 }, "unknown style key 'glow'"],
            [{ look: "neon" }, "style.look must be signature or classic"],
            [{ look: null }, "style.look must be signature or classic"],
            [{ platter: "yes" }, "style.platter must be true or false"],
            [{ layout: "Pro Vertical" }, "style.layout must be a layout id (a-z, 0-9, '.', '_', '-'; max 48)"],
            [{ layout: "a".repeat(49) }, "style.layout must be a layout id (a-z, 0-9, '.', '_', '-'; max 48)"],
            [{ layout: 7 }, "style.layout must be a layout id (a-z, 0-9, '.', '_', '-'; max 48)"],
            [{ waves: "mirror" }, "style.waves must be stacked or overlay"],
            [{ colors: [] }, "style.colors must be an object"],
            [{ colors: null }, "style.colors must be an object"],
            [{ colors: { sparkle: "#ffffff" } }, "unknown style colour 'sparkle'"],
            [{ colors: { toString: "#ffffff" } }, "unknown style colour 'toString'"],
            [{ colors: { well: "red" } }, "style.colors.well must be a valid colour"],
            [{ colors: { well: "url(https://x/y.png)" } }, "style.colors.well must be a valid colour"],
            [{ colors: { waveBg: "oklch(2 0.1 30)" } }, "style.colors.waveBg must be a valid colour"],
            [{ colors: { waveBg: "oklch(-0 0 0)" } }, "style.colors.waveBg must be a valid colour"],
            [{ colors: { waveBg: " #ffffff" } }, "style.colors.waveBg must be a valid colour"],
            [{ colors: { waveBg: "oklch(0.5\u00850.1 30)" } }, "style.colors.waveBg must be a valid colour"],
            [{ colors: { waveBg: "oklch(0.5\u00a00.1 30)" } }, "style.colors.waveBg must be a valid colour"],
            [{ colors: { cue1: 16711680 } }, "style.colors.cue1 must be a valid colour"],
            [{ sizes: "big" }, "style.sizes must be an object"],
            [{ sizes: { zoom: 2 } }, "unknown style size 'zoom'"],
            [{ sizes: { constructor: 2 } }, "unknown style size 'constructor'"],
            [{ sizes: { panelGap: 17 } }, "style.sizes.panelGap must be a number in 0..16"],
            [{ sizes: { panelGap: -1 } }, "style.sizes.panelGap must be a number in 0..16"],
            [{ sizes: { panelPad: "8" } }, "style.sizes.panelPad must be a number in 4..16"],
            [{ sizes: { controlHeight: 19.9 } }, "style.sizes.controlHeight must be a number in 20..32"],
            [{ sizes: { titlebarHeight: 49 } }, "style.sizes.titlebarHeight must be a number in 28..48"],
            [{ sizes: { wavePlayedAlpha: 0.1 } }, "style.sizes.wavePlayedAlpha must be a number in 0.2..1"],
        ];
        for (const [style, want] of cases) {
            assert.deepEqual(validateStyle(style), [want], JSON.stringify(style));
            const res = validateFiles(styledFiles(2, style));
            assert.deepEqual(res.errors, [want], JSON.stringify(style));
        }
        // Problems come in the app's order, all at once.
        assert.deepEqual(validateStyle({ zzz: 1, sizes: { panelGap: -1 }, colors: { well: "red" }, waves: "x", layout: "", platter: 1, look: "x" }), [
            "unknown style key 'zzz'",
            "style.look must be signature or classic",
            "style.platter must be true or false",
            "style.layout must be a layout id (a-z, 0-9, '.', '_', '-'; max 48)",
            "style.waves must be stacked or overlay",
            "style.colors.well must be a valid colour",
            "style.sizes.panelGap must be a number in 0..16",
        ]);
    });
    it("accepts both ends of every size range and nothing outside", () => {
        for (const [key, [min, max]] of Object.entries(STYLE_SIZES)) {
            const step = (max - min) / 1000;
            for (const v of [min, max]) assert.deepEqual(validateStyle({ sizes: { [key]: v } }), [], `${key}=${v}`);
            for (const v of [min - step, max + step, NaN, Infinity]) assert.equal(validateStyle({ sizes: { [key]: v } }).length, 1, `${key}=${v}`);
        }
        for (const key of STYLE_COLOR_KEYS) assert.deepEqual(validateStyle({ colors: { [key]: "oklch(0.7 0.2 30 / 0.5)" } }), []);
    });
    it("warns when style.layout names no built-in layout and no layout of the pack", () => {
        const own = validateFiles(styledFiles(2, { layout: "main" }));
        assert.ok(own.ok, own.errors.join("; "));
        assert.deepEqual(own.warnings, []);
        for (const id of BUILTIN_LAYOUT_IDS) assert.deepEqual(validateFiles(styledFiles(2, { layout: id })).warnings, [], id);
        const unknown = validateFiles(styledFiles(2, { layout: "nowhere" }));
        assert.ok(unknown.ok, unknown.errors.join("; "));
        assert.match(unknown.warnings.join("\n"), /style\.layout 'nowhere' is not a built-in layout/);
    });
    it("layouts may place the waves panel", () => {
        assert.equal(PANEL_IDS.length, 12);
        const pro = {
            v: 1, id: "pro-like", name: "Pro like", columns: [16, 7, 16], rows: [7, 12, 2, 19],
            areas: [
                { panel: "waves", col: 0, row: 0, colSpan: 3 },
                { panel: "deckA", col: 0, row: 1, rowSpan: 2 },
                { panel: "mixer", col: 1, row: 1 },
                { panel: "crossfader", col: 1, row: 2 },
                { panel: "deckB", col: 2, row: 1, rowSpan: 2 },
                { panel: "library", col: 0, row: 3, colSpan: 3 },
            ],
        };
        assert.deepEqual(validateLayout(pro), []);
        const f = sampleFiles();
        f.set("layouts/main.json", json({ ...pro, id: "main" }));
        const res = validateFiles(f);
        assert.ok(res.ok, res.errors.join("; "));
        // A v1 manifest with a `waves` layout installs on 1.5 but is rejected by Decks <= 1.4: warn, do not fail.
        assert.match(res.warnings.join("\n"), /layout 'main' places the 'waves' panel.*declare "v": 2/);
        f.set("manifest.json", json({ ...JSON.parse(f.get("manifest.json")), v: 2 }));
        const v2 = validateFiles(f);
        assert.ok(v2.ok, v2.errors.join("; "));
        assert.doesNotMatch(v2.warnings.join("\n"), /waves/);
        assert.doesNotMatch(validateFiles(sampleFiles()).warnings.join("\n"), /waves/, "no warning without the panel");
        assert.deepEqual(validateLayout({ ...pro, areas: [...pro.areas, { panel: "waves", col: 0, row: 3 }] }).slice(0, 1), ["areas[6]: waves used twice"]);
    });
    it("layout validator reproduces the golden fixtures of the app's validator", () => {
        // docs/decks/fixtures/layout-cases.json is generated from src/layout/solver.ts (the
        // reference) and asserted by the Rust port too: same input, same messages, same order.
        const fx = JSON.parse(readFileSync(new URL("../../../../docs/decks/fixtures/layout-cases.json", import.meta.url), "utf8"));
        assert.ok(fx.validation.length >= 13, `${fx.validation.length} validation cases`);
        for (const v of fx.validation) assert.deepEqual(validateLayout(v.raw), v.errors, JSON.stringify(v.raw));
        assert.deepEqual(fx.layouts.map((l) => l.id), [...BUILTIN_LAYOUT_IDS, "stage"]);
        for (const l of fx.layouts) assert.deepEqual(validateLayout(l), [], l.id);
    });
    it("style tables and panel ids match the app sources", () => {
        const src = text("../../src/look/style-vars.ts");
        const block = (name) => {
            const head = `export const ${name} = {`;
            const start = src.indexOf(head);
            assert.ok(start >= 0, name);
            const body = src.slice(start + head.length, src.indexOf("} as const;", start));
            return body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
        };
        assert.deepEqual(block("STYLE_COLORS").map((l) => l.split(":")[0].trim()), STYLE_COLOR_KEYS);
        const sizes = Object.fromEntries(block("STYLE_SIZES").map((l) => {
            const m = /^(\w+): \{ prop: "[^"]+", min: ([0-9.]+), max: ([0-9.]+),/.exec(l);
            assert.ok(m, l);
            return [m[1], [Number(m[2]), Number(m[3])]];
        }));
        assert.deepEqual(sizes, STYLE_SIZES);
        const list = (name) => JSON.parse(new RegExp(`export const ${name} = (\\[[^\\]]*\\]) as const;`).exec(src)[1]);
        assert.deepEqual(list("STYLE_LOOKS"), STYLE_LOOKS);
        assert.deepEqual(list("STYLE_WAVES"), STYLE_WAVES);
        assert.ok(src.includes(`[${STYLE_KEYS.map((k) => `"${k}"`).join(", ")}].includes(k)`));
        assert.ok(src.includes("/^[a-z0-9][a-z0-9._-]{0,47}$/"));
        const types = text("../../src/layout/types.ts");
        const ids = /export const PANEL_IDS = \[([^\]]*)\]/.exec(types)[1].split(",").map((s) => s.trim().replaceAll('"', "")).filter(Boolean);
        assert.deepEqual(ids, PANEL_IDS);
        const presets = text("../../src/layout/presets.ts");
        const names = /export const BUILTIN_LAYOUTS: LayoutDoc\[\] = \[([^\]]*)\]/.exec(presets)[1].split(",").map((s) => s.trim());
        const builtinIds = names.map((n) => new RegExp(`export const ${n}: LayoutDoc = \\{\\s*v: 1,\\s*id: "([^"]+)"`).exec(presets)[1]);
        assert.deepEqual(builtinIds, BUILTIN_LAYOUT_IDS);
    });
    it("README lists the app's panels, minimum sizes, style keys and built-in layouts", async () => {
        const readme = text("../README.md");
        // Node strips the types of the app source (same as scripts/gen-layout-fixtures.mjs).
        const { PANEL_SPECS } = await import("../../src/layout/presets.ts");
        const rows = new Map();
        for (const m of readme.matchAll(/^\| (\w+)(?: … \w+)? \| (\d+) × (\d+) \| (\d+) × (\d+) \| (\d+) × (\d+) \|$/gm)) rows.set(m[1], m.slice(2).map(Number));
        for (const id of PANEL_IDS) {
            const min = PANEL_SPECS[id].min;
            const want = [min.full.w, min.full.h, min.compact.w, min.compact.h, min.icon.w, min.icon.h];
            // The four decks share one row ("deckA … deckD").
            assert.deepEqual(rows.get(id.startsWith("deck") ? "deckA" : id), want, id);
        }
        assert.equal(rows.size, PANEL_IDS.length - 3);
        assert.ok(readme.includes(`Panels: ${PANEL_IDS.slice(0, 4).join(", ")},\n${PANEL_IDS.slice(4).join(", ")}.`));
        for (const k of STYLE_COLOR_KEYS.filter((c) => !/^cue[2-7]$/.test(c))) assert.ok(readme.includes(`\`${k}\``), k);
        for (const [k, [min, max]] of Object.entries(STYLE_SIZES)) assert.ok(readme.includes(`\`${k}\` ${min}–${max}`), k);
        assert.ok(readme.includes(BUILTIN_LAYOUT_IDS.map((id) => `\`${id}\``).join(", ")));
    });
});

describe("colour helpers", () => {
    it("valid_color port matches the Rust bounds", () => {
        for (const c of ["#abcdef", "#abcdef80", "oklch(0.7 0.2 300)", "oklch(70% 0.2 30 / 0.9)", "oklch(0.5 0 0 / 50%)"]) assert.ok(validColor(c), c);
        for (const c of ["#abc", "red", "oklch(1.2 0.2 30)", "oklch(0.5 0.6 30)", "oklch(0.5 0.2 400)", "oklch(0.5 0.2)", "oklch(1e-1 0.2 30)", "rgb(1,2,3)", "oklch(0.5 0.2 30.)", "oklch(0.5. 0.2 30)"]) assert.ok(!validColor(c), c);
    });
    it("normalises design-tool colours", () => {
        assert.equal(normalizeColor("#ABC"), "#aabbcc");
        assert.equal(normalizeColor("rgb(255, 0, 128)"), "#ff0080");
        assert.equal(normalizeColor("rgba(0 0 0 / 50%)"), "#00000080");
        assert.equal(normalizeColor("hsl(120, 100%, 50%)"), "#00ff00");
        assert.equal(normalizeColor("oklch(0.7  0.2 300)"), "oklch(0.7 0.2 300)");
        assert.equal(normalizeColor("tomato"), null);
    });
    it("contrast check handles oklch", () => {
        assert.deepEqual(contrastProblems({ foreground: "oklch(0.98 0 0)", background: "oklch(0.15 0 0)" }), []);
        assert.equal(contrastProblems({ foreground: "oklch(0.5 0 0)", background: "oklch(0.45 0 0)" }).length, 1);
    });
});

describe("DTCG import", () => {
    it("resolves aliases (chained), maps names and reports unmapped", () => {
        const json = {
            core: { $type: "color", violet: { $value: "#7c3aed" }, ink: { $value: "rgb(10, 10, 12)" }, paper: { $value: "#fafafa" } },
            semantic: {
                bg: { $value: "{core.ink}", $type: "color" },
                text: { $value: "{core.paper}", $type: "color" },
                brand: { $value: "{semantic.accentAlias}", $type: "color" },
                accentAlias: { $value: "{core.violet}", $type: "color" },
                deck: { a: { $value: "hsl(190, 100%, 50%)", $type: "color" } },
            },
            color: { "primary-foreground": { $value: "#ffffff", $type: "color" } },
            spacing: { sm: { $value: "4px", $type: "dimension" } },
        };
        const { tokens, unmapped, problems } = importDtcg(json);
        assert.deepEqual(problems, []);
        assert.equal(tokens.colors.background, "#0a0a0c");
        assert.equal(tokens.colors.foreground, "#fafafa");
        assert.equal(tokens.colors.primary, "#7c3aed");
        assert.equal(tokens.colors["deck-a"], "#00d5ff");
        assert.equal(tokens.colors["primary-foreground"], "#ffffff");
        assert.ok(unmapped.includes("spacing.sm"));
        assert.ok(unmapped.includes("core.violet"));
    });
    it("reports unresolved aliases and cycles", () => {
        const { problems } = importDtcg({ a: { $type: "color", $value: "{b}" }, b: { $type: "color", $value: "{a}" }, c: { $type: "color", $value: "{zzz}" } });
        assert.ok(problems.some((p) => /cycle/.test(p)));
        assert.ok(problems.some((p) => /unresolved alias \{zzz\}/.test(p)));
    });
    it("maps common names", () => {
        assert.equal(mapTokenName(["color", "background"]), "background");
        assert.equal(mapTokenName(["colors", "textMuted"]), "muted-foreground");
        assert.equal(mapTokenName(["primary", "foreground"]), "primary-foreground");
        assert.equal(mapTokenName(["primary", "default"]), "primary");
        assert.equal(mapTokenName(["fun"]), null);
    });
});

describe("CLI", () => {
    it("init -> validate -> pack -> validate packed -> catalog", () => {
        const tmp = mkdtempSync(join(tmpdir(), "mixaipack-"));
        try {
            const dir = join(tmp, "skin");
            assert.equal(main(["init", dir, "--kind", "bundle", "--id", "com.test.bundle.demo", "--name", "Demo"], quiet), 0);
            assert.equal(main(["validate", dir], quiet), 0);
            const keyFile = join(tmp, "key.txt");
            writeFileSync(keyFile, TEST_SEED.toString("base64"));
            const out = join(tmp, "packs", "com.test.bundle.demo.mixaipack");
            assert.equal(main(["pack", dir, "-o", out, "--sign", keyFile, "--key-id", TEST_KEY_ID, "--embed-pubkey"], quiet), 0);
            const res = validatePath(out);
            assert.ok(res.ok, res.errors.join("; "));
            assert.equal(res.trust, "community");
            assert.ok(!res.files.has("README.md"));
            const cat = join(tmp, "catalog.json");
            assert.equal(main(["catalog", join(tmp, "packs"), "-o", cat, "--previews", join(tmp, "prev"), "--date", "2026-11-09T00:00:00.000Z"], quiet), 0);
            const c = JSON.parse(readFileSync(cat, "utf8"));
            assert.equal(c.v, 1);
            assert.equal(c.packs[0].id, "com.test.bundle.demo");
            assert.equal(c.packs[0].previewUrl, "/api/decks/packs/com.test.bundle.demo/preview");
            assert.equal(c.packs[0].size, readFileSync(out).length);
            assert.ok(existsSync(join(tmp, "prev", "com.test.bundle.demo.png")));
            // Determinism: same inputs -> same catalogue via the library.
            assert.deepEqual(buildCatalog(join(tmp, "packs"), { date: "2026-11-09T00:00:00.000Z" }).catalog, c);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
    it("validate exits 1 on an invalid pack", () => {
        const tmp = mkdtempSync(join(tmpdir(), "mixaipack-"));
        try {
            writeFileSync(join(tmp, "manifest.json"), JSON.stringify({ v: 2 }));
            const lines = [];
            assert.equal(main(["validate", tmp], (s) => lines.push(s)), 1);
            assert.match(lines.join("\n"), /FAILED/);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
    it("init --style scaffolds a manifest v2 skin that validates and packs", () => {
        const tmp = mkdtempSync(join(tmpdir(), "mixaipack-"));
        try {
            const dir = join(tmp, "skin");
            assert.equal(main(["init", dir, "--kind", "skin", "--id", "com.test.skin.styled", "--name", "Styled", "--style"], quiet), 0);
            assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).v, 2);
            const tokens = JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8"));
            assert.deepEqual(validateStyle(tokens.style), []);
            assert.equal(main(["validate", dir], quiet), 0);
            const out = join(tmp, "styled.mixaipack");
            assert.equal(main(["pack", dir, "-o", out], quiet), 0);
            const res = validatePath(out);
            assert.ok(res.ok, res.errors.join("; "));
            assert.deepEqual(res.tokens.style, tokens.style);
            // Without the flag a skin stays manifest v1 (installs on every Decks version).
            const plain = join(tmp, "plain");
            assert.equal(main(["init", plain, "--kind", "skin", "--id", "com.test.skin.plain", "--name", "Plain"], quiet), 0);
            assert.equal(JSON.parse(readFileSync(join(plain, "manifest.json"), "utf8")).v, 1);
            assert.equal(JSON.parse(readFileSync(join(plain, "tokens.json"), "utf8")).style, undefined);
            // A layout pack has no tokens, so --style is refused there.
            assert.equal(main(["init", join(tmp, "l"), "--kind", "layout", "--id", "com.test.layout.x", "--name", "L", "--style"], quiet), 1);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
    it("checked-in fixture verifies as community and matches the test key", () => {
        const p = new URL("../fixtures/sample-signed.mixaipack", import.meta.url);
        const res = validatePath(p);
        assert.ok(res.ok, res.errors.join("; "));
        assert.equal(res.trust, "community");
        const sig = JSON.parse(res.files.get("signature.json"));
        assert.equal(sig.keyId, TEST_KEY_ID);
        // The fixture is what tools/make-fixture.mjs builds today (same files, same signature).
        assert.deepEqual(entries(buildPack(sampleFiles(), { seed: TEST_SEED, keyId: TEST_KEY_ID, embedPubkey: true }).bytes), entries(readFileSync(p)));
    });
    it("checked-in v2 fixture carries the full style block", () => {
        const p = new URL("../fixtures/sample-style.mixaipack", import.meta.url);
        const res = validatePath(p);
        assert.ok(res.ok, res.errors.join("; "));
        assert.equal(res.trust, "community");
        assert.equal(res.manifest.v, 2);
        assert.equal(res.manifest.id, "com.example.test.style");
        assert.deepEqual(res.tokens.style, SAMPLE_STYLE);
        assert.deepEqual(entries(buildPack(styleSampleFiles(), { seed: TEST_SEED, keyId: TEST_KEY_ID, embedPubkey: true }).bytes), entries(readFileSync(p)));
    });
});
