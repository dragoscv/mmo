import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { contrastProblems, normalizeColor, validColor } from "../lib/color.mjs";
import { importDtcg, mapTokenName } from "../lib/dtcg.mjs";
import { validateLayout } from "../lib/layout.mjs";
import { buildCatalog, buildPack } from "../lib/pack.mjs";
import { canonicalDigest, generateTestSeed, signatureFor, verifyFiles } from "../lib/sign.mjs";
import { validateFiles, validatePath } from "../lib/validate.mjs";
import { readZip, writeZip, entryNameError } from "../lib/zip.mjs";
import { main } from "../mixaipack.mjs";
import { TEST_SEED, TEST_KEY_ID, sampleFiles } from "../tools/fixture.mjs";

const quiet = () => {};

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

describe("colour helpers", () => {
    it("valid_color port matches the Rust bounds", () => {
        for (const c of ["#abcdef", "#abcdef80", "oklch(0.7 0.2 300)", "oklch(70% 0.2 30 / 0.9)", "oklch(0.5 0 0 / 50%)"]) assert.ok(validColor(c), c);
        for (const c of ["#abc", "red", "oklch(1.2 0.2 30)", "oklch(0.5 0.6 30)", "oklch(0.5 0.2 400)", "oklch(0.5 0.2)", "oklch(1e-1 0.2 30)", "rgb(1,2,3)"]) assert.ok(!validColor(c), c);
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
    it("checked-in fixture verifies as community and matches the test key", () => {
        const p = new URL("../fixtures/sample-signed.mixaipack", import.meta.url);
        const res = validatePath(p);
        assert.ok(res.ok, res.errors.join("; "));
        assert.equal(res.trust, "community");
        const sig = JSON.parse(res.files.get("signature.json"));
        assert.equal(sig.keyId, TEST_KEY_ID);
    });
});
