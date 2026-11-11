#!/usr/bin/env node
// MixAI Decks Skin SDK — `.mixaipack` CLI. Zero dependencies (Node 24+).
// Format: docs/decks/packs.md · Rust verifier: apps/mixai/src-tauri/src/pack.rs.
//
//   node apps/mixai/sdk/mixaipack.mjs init <dir> --kind skin|layout|bundle --id <id> --name <name> [--style]
//   node apps/mixai/sdk/mixaipack.mjs validate <dir|file.mixaipack> [--allow-low-contrast]
//   node apps/mixai/sdk/mixaipack.mjs import-dtcg <tokens.json> <dir>
//   node apps/mixai/sdk/mixaipack.mjs preview <dir>
//   node apps/mixai/sdk/mixaipack.mjs pack <dir> -o out.mixaipack [--sign <keyfile> --key-id <id>] [--embed-pubkey]
//   node apps/mixai/sdk/mixaipack.mjs catalog <dir-of-packs> -o catalog.json [--base-url /api/decks/packs] [--previews <dir>] [--date <iso>] [--tags tags.json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importDtcg } from "./lib/dtcg.mjs";
import { buildCatalog, buildPack } from "./lib/pack.mjs";
import { renderPreview } from "./lib/png.mjs";
import { loadSeedFile, sha256Hex } from "./lib/sign.mjs";
import { readPackDir, validPackId, validatePath } from "./lib/validate.mjs";
import { IMAGE_EXT, entryNameError, extOf } from "./lib/zip.mjs";

const USAGE = `mixaipack — MixAI Decks Skin SDK

Commands:
    init <dir> --kind skin|layout|bundle --id <id> --name <name> [--author <a>] [--style]
                                                                            --style: manifest v2 with a starter "style" block (needs Decks 1.5+)
  validate <dir|file.mixaipack> [--allow-low-contrast]
  import-dtcg <figma-tokens.json> <dir>
  preview <dir>                       (re)generate assets/preview.png from the palette/layout
  pack <dir> -o <out.mixaipack> [--sign <keyfile> --key-id <id>] [--embed-pubkey] [--allow-low-contrast]
  catalog <dir-of-packs> -o <catalog.json> [--base-url /api/decks/packs] [--previews <dir>] [--date <iso>] [--tags <tags.json>]
`;

export function parseArgs(argv) {
    const pos = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "-o") flags.o = argv[++i];
        else if (a.startsWith("--")) {
            const k = a.slice(2);
            const next = argv[i + 1];
            if (["allow-low-contrast", "embed-pubkey", "help", "style"].includes(k)) flags[k] = true;
            else { flags[k] = next; i++; }
        } else pos.push(a);
    }
    return { pos, flags };
}

const writeJson = (p, v) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
};

function printResult(res, label, log) {
    for (const w of res.warnings) log(`  warning: ${w}`);
    for (const e of res.errors) log(`  error: ${e}`);
    if (res.ignored?.length) log(`  note: not packed (docs/dotfiles): ${res.ignored.join(", ")}`);
    if (res.ok) log(`OK ${label}: ${res.manifest.id} ${res.manifest.version} (${res.manifest.kind}${res.manifest.pro ? ", pro" : ""}, ${res.trust})`);
    else log(`FAILED ${label}: ${res.errors.length} error(s)`);
}

function cmdInit({ pos, flags }, log) {
    const dir = pos[0];
    const kind = flags.kind;
    if (!dir || !["skin", "layout", "bundle"].includes(kind) || !flags.id || !flags.name) throw new Error("usage: init <dir> --kind skin|layout|bundle --id <id> --name <name> [--style]");
    if (!validPackId(flags.id)) throw new Error(`--id '${flags.id}' must look like 'com.you.skin.name' (lowercase, dots)`);
    if (flags.style && kind === "layout") throw new Error("--style needs tokens: use --kind skin or --kind bundle");
    if (existsSync(join(dir, "manifest.json"))) throw new Error(`${dir} already has a manifest.json`);
    const manifest = {
        // v2 only when the pack uses a style block: a v1 pack installs on every Decks version.
        v: flags.style ? 2 : 1,
        id: flags.id,
        name: flags.name,
        version: "1.0.0",
        kind,
        author: flags.author ?? "Your name",
        description: "",
        pro: false,
    };
    const colors = {
        background: "oklch(0.16 0.02 270)",
        foreground: "oklch(0.96 0.01 270)",
        card: "oklch(0.21 0.025 270)",
        "card-foreground": "oklch(0.96 0.01 270)",
        primary: "oklch(0.72 0.18 300)",
        "primary-foreground": "oklch(0.15 0.02 300)",
        "muted-foreground": "oklch(0.72 0.02 270)",
        border: "oklch(0.32 0.03 270)",
        ring: "oklch(0.72 0.18 300)",
    };
    if (kind !== "layout") {
        manifest.tokens = "tokens.json";
        const tokens = { mode: "dark", surface: "glass", radius: "md", colors };
        if (flags.style) {
            tokens.style = {
                look: "signature",
                waves: "stacked",
                colors: { on: "oklch(0.8 0.2 150)", waveLow: "oklch(0.6 0.2 250)", waveMid: "oklch(0.75 0.17 160)", waveHigh: "oklch(0.95 0.02 270)" },
                sizes: { panelGap: 6, panelRadius: 8, controlRadius: 6 },
            };
        }
        writeJson(join(dir, "tokens.json"), tokens);
    }
    let layout = null;
    if (kind !== "skin") {
        layout = {
            v: 1,
            id: "example",
            name: "Example",
            columns: [5, 3, 5],
            rows: [1, 9, 2, 6],
            areas: [
                { panel: "deckA", col: 0, row: 0, rowSpan: 3 },
                { panel: "clock", col: 1, row: 0 },
                { panel: "mixer", col: 1, row: 1 },
                { panel: "crossfader", col: 1, row: 2 },
                { panel: "deckB", col: 2, row: 0, rowSpan: 3 },
                { panel: "library", col: 0, row: 3, colSpan: 2 },
                { panel: "automix", col: 2, row: 3 },
            ],
        };
        manifest.layouts = ["layouts/example.json"];
        writeJson(join(dir, "layouts/example.json"), layout);
    }
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets/preview.png"), renderPreview(colors, layout));
    manifest.preview = "assets/preview.png";
    writeJson(join(dir, "manifest.json"), manifest);
    writeFileSync(join(dir, "README.md"), `# ${flags.name}\n\nMixAI Decks ${kind} pack \`${flags.id}\`.\n\n1. Edit ${kind !== "layout" ? "`tokens.json` (colours: #rrggbb, #rrggbbaa or oklch())" : "the layouts"}${kind === "bundle" ? " and the layouts" : ""}.\n2. \`node apps/mixai/sdk/mixaipack.mjs preview ${dir}\` to refresh the preview.\n3. \`node apps/mixai/sdk/mixaipack.mjs validate ${dir}\`\n4. \`node apps/mixai/sdk/mixaipack.mjs pack ${dir} -o ${flags.id}.mixaipack\`\n\nThis README is not packed.\n`);
    log(`created ${kind} pack ${flags.id} in ${dir}`);
    return 0;
}

function cmdValidate({ pos, flags }, log) {
    if (!pos[0]) throw new Error("usage: validate <dir|file.mixaipack>");
    const res = validatePath(pos[0], { allowLowContrast: !!flags["allow-low-contrast"] });
    printResult(res, pos[0], log);
    return res.ok ? 0 : 1;
}

function cmdImport({ pos }, log) {
    const [src, dir] = pos;
    if (!src || !dir) throw new Error("usage: import-dtcg <figma-tokens.json> <dir>");
    const json = JSON.parse(readFileSync(src, "utf8"));
    const target = join(dir, "tokens.json");
    const base = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : { mode: "dark" };
    const { tokens, mapped, unmapped, problems } = importDtcg(json, base);
    writeJson(target, tokens);
    for (const m of mapped) log(`  ${m.from} -> ${m.to} = ${m.value}`);
    if (unmapped.length) log(`  unmapped (${unmapped.length}): ${unmapped.slice(0, 40).join(", ")}${unmapped.length > 40 ? ", …" : ""}`);
    for (const p of problems) log(`  problem: ${p}`);
    log(`wrote ${target}: ${mapped.length} colour(s) mapped`);
    const mf = join(dir, "manifest.json");
    if (existsSync(mf)) {
        const m = JSON.parse(readFileSync(mf, "utf8"));
        if (!m.tokens) {
            m.tokens = "tokens.json";
            writeJson(mf, m);
            log(`  manifest.tokens set to tokens.json`);
        }
    }
    return problems.length ? 1 : 0;
}

function cmdPreview({ pos }, log) {
    const dir = pos[0];
    if (!dir) throw new Error("usage: preview <dir>");
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const tokens = m.tokens ? JSON.parse(readFileSync(join(dir, m.tokens), "utf8")) : {};
    const colors = { ...(tokens.colors ?? {}) };
    for (const [k, v] of Object.entries(tokens.color ?? {})) if (!k.startsWith("$") && v?.$value) colors[k] = v.$value;
    for (const [k, v] of Object.entries(tokens.decks ?? {})) colors[`deck-${k}`] = v;
    const layout = m.layouts?.[0] ? JSON.parse(readFileSync(join(dir, m.layouts[0]), "utf8")) : null;
    const out = m.preview ?? "assets/preview.png";
    // `preview` comes from the folder's manifest: it must be a pack entry name (no '..', no absolute path, no
    // drive), or this command would write a PNG outside the folder.
    const bad = typeof out !== "string" ? "manifest.preview must be a string" : entryNameError(out);
    if (bad) throw new Error(bad);
    if (!IMAGE_EXT.includes(extOf(out))) throw new Error(`manifest.preview '${out}' must be one of: ${IMAGE_EXT.join(", ")}`);
    mkdirSync(dirname(join(dir, out)), { recursive: true });
    writeFileSync(join(dir, out), renderPreview(colors, layout));
    if (!m.preview) { m.preview = out; writeJson(join(dir, "manifest.json"), m); }
    log(`wrote ${join(dir, out)}`);
    return 0;
}

function cmdPack({ pos, flags }, log) {
    const dir = pos[0];
    if (!dir || !flags.o) throw new Error("usage: pack <dir> -o <out.mixaipack> [--sign <keyfile> --key-id <id>] [--embed-pubkey]");
    if (flags.sign && !flags["key-id"]) throw new Error("--sign needs --key-id");
    const { files, ignored } = readPackDir(dir);
    const seed = flags.sign ? loadSeedFile(flags.sign) : undefined;
    const { bytes, result } = buildPack(files, { seed, keyId: flags["key-id"], embedPubkey: !!flags["embed-pubkey"], allowLowContrast: !!flags["allow-low-contrast"] });
    seed?.fill(0);
    mkdirSync(dirname(resolve(flags.o)), { recursive: true });
    writeFileSync(flags.o, bytes);
    for (const w of result.warnings) log(`  warning: ${w}`);
    if (ignored.length) log(`  note: not packed: ${ignored.join(", ")}`);
    log(`packed ${result.manifest.id} -> ${flags.o} (${bytes.length} bytes, ${result.trust}${result.trust === "unsigned" ? "" : ` as ${flags["key-id"]}`}, sha256 ${sha256Hex(bytes)})`);
    return 0;
}

function cmdCatalog({ pos, flags }, log) {
    const dir = pos[0];
    if (!dir || !flags.o) throw new Error("usage: catalog <dir-of-packs> -o <catalog.json> [--base-url ...] [--previews <dir>]");
    const tags = flags.tags ? JSON.parse(readFileSync(flags.tags, "utf8")) : {};
    const { catalog, previews } = buildCatalog(dir, { baseUrl: flags["base-url"] ?? "/api/decks/packs", date: flags.date, tags });
    writeJson(flags.o, catalog);
    if (flags.previews) {
        mkdirSync(flags.previews, { recursive: true });
        for (const [id, p] of previews) {
            const ext = p.name.split(".").pop().toLowerCase();
            writeFileSync(join(flags.previews, `${id}.${ext === "jpeg" ? "jpg" : ext}`), p.bytes);
        }
    }
    for (const p of catalog.packs) log(`  ${p.id} ${p.version} ${p.kind} trust=${p.trust} pro=${p.pro} ${p.size} B`);
    log(`wrote ${flags.o} (${catalog.packs.length} pack(s))`);
    return 0;
}

export function main(argv, log = (s) => console.log(s)) {
    const [cmd, ...rest] = argv;
    const args = parseArgs(rest);
    if (!cmd || cmd === "help" || args.flags.help) { log(USAGE); return cmd ? 0 : 1; }
    const table = { init: cmdInit, validate: cmdValidate, "import-dtcg": cmdImport, preview: cmdPreview, pack: cmdPack, catalog: cmdCatalog };
    const fn = table[cmd];
    if (!fn) { log(`unknown command '${cmd}'\n\n${USAGE}`); return 1; }
    try {
        return fn(args, log);
    } catch (e) {
        log(`error: ${e.message}`);
        return 1;
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    process.exitCode = main(process.argv.slice(2));
}
export const SDK_DIR = dirname(fileURLToPath(import.meta.url));
