// Pack validation: the rules of apps/mixai/src-tauri/src/pack.rs (manifest, tokens, layouts,
// presets, limits, names) + the TS layout validator + the WCAG contrast gate.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { COLOR_KEYS, contrastProblems, validColor } from "./color.mjs";
import { validateLayout } from "./layout.mjs";
import { SIGNATURE_FILE, verifyFiles } from "./sign.mjs";
import { ALLOWED_EXT, IMAGE_EXT, LIMITS, entryNameError, extOf, readZip, short } from "./zip.mjs";

export const MANIFEST_FILE = "manifest.json";
const KINDS = ["skin", "layout", "bundle", "controller"];
const MANIFEST_KEYS = ["v", "id", "name", "version", "kind", "author", "description", "pro", "tokens", "layouts", "presets", "preview", "fonts"];
const FONT_KEYS = ["family", "file", "weight", "style"];
const TOKEN_KEYS = ["mode", "accent", "surface", "density", "radius", "colors", "decks", "fontHeading", "fontBody", "background", "color"];

export function validPackId(id) {
    return typeof id === "string" && id.length <= 100 && /^[a-z0-9]+(\.[a-z0-9-]+){1,6}$/.test(id);
}
const validVersion = (v) => typeof v === "string" && /^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$/.test(v);
export const validFontFamily = (f) => typeof f === "string" && /^[A-Za-z0-9 -]{1,40}$/.test(f);
const charLen = (s) => [...s].length;

/** Files a source directory may hold that are not packed (docs, dotfiles). */
export function isIgnoredSource(rel) {
    const base = rel.split("/").pop();
    return base.startsWith(".") || /\.md$/i.test(base) || rel.split("/").some((s) => s.startsWith("."));
}

/** Read a pack source dir into Map<name, Buffer>; returns { files, ignored }. */
export function readPackDir(dir) {
    const files = new Map();
    const ignored = [];
    const walk = (d) => {
        for (const it of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, it.name);
            const rel = relative(dir, p).split(sep).join("/");
            if (it.isDirectory()) {
                if (!it.name.startsWith(".")) walk(p);
                continue;
            }
            if (isIgnoredSource(rel)) { ignored.push(rel); continue; }
            if (it.isSymbolicLink()) throw new Error(`symlinks are not allowed ('${rel}')`);
            files.set(rel, readFileSync(p));
        }
    };
    walk(dir);
    return { files: new Map([...files].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))), ignored };
}

/** Checks the zip-level rules for a dir source (names, extensions, sizes, counts). */
function checkSourceLimits(files, errors) {
    if (files.size > LIMITS.MAX_ENTRIES) errors.push(`pack has too many entries (${files.size}, limit ${LIMITS.MAX_ENTRIES})`);
    let total = 0;
    for (const [name, buf] of files) {
        const e = entryNameError(name);
        if (e) { errors.push(e); continue; }
        const ext = extOf(name);
        if (!ext || !ALLOWED_EXT.includes(ext)) errors.push(`file type not allowed: '${short(name)}' (allowed: ${ALLOWED_EXT.join(", ")})`);
        if (buf.length > LIMITS.MAX_ENTRY_BYTES) errors.push(`entry '${short(name)}' is too large (${buf.length} bytes, limit ${LIMITS.MAX_ENTRY_BYTES})`);
        total += buf.length;
    }
    if (total > LIMITS.MAX_TOTAL_BYTES) errors.push(`pack uncompressed size exceeds ${LIMITS.MAX_TOTAL_BYTES} bytes`);
}

function parseJson(files, path, errors, what) {
    try {
        return JSON.parse(files.get(path).toString("utf8"));
    } catch (e) {
        errors.push(`${what} is not valid JSON: ${e.message}`);
        return undefined;
    }
}

function requireFile(files, field, path, exts, errors) {
    if (typeof path !== "string") { errors.push(`${field} must be a string`); return false; }
    const ne = entryNameError(path);
    if (ne) { errors.push(ne); return false; }
    const e = extOf(path);
    if (!e || !exts.includes(e)) { errors.push(`${field} '${short(path)}' must be one of: ${exts.join(", ")}`); return false; }
    if (!files.has(path)) { errors.push(`${field} '${short(path)}' is missing from the pack`); return false; }
    return true;
}

function optStrArray(m, key, errors) {
    const v = m[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) { errors.push(`manifest.${key} must be an array of strings`); return []; }
    return v;
}

export function validateManifest(files, errors) {
    if (!files.has(MANIFEST_FILE)) { errors.push("manifest.json is missing"); return null; }
    const m = parseJson(files, MANIFEST_FILE, errors, "manifest.json");
    if (m === undefined) return null;
    if (!m || typeof m !== "object" || Array.isArray(m)) { errors.push("manifest.json is invalid: expected an object"); return null; }
    const before = errors.length;
    for (const k of Object.keys(m)) if (!MANIFEST_KEYS.includes(k)) errors.push(`manifest.json is invalid: unknown field \`${k}\``);
    for (const k of ["id", "name", "version", "kind", "author"]) if (typeof m[k] !== "string") errors.push(`manifest.json is invalid: \`${k}\` must be a string`);
    if (!Number.isInteger(m.v) || m.v < 0) errors.push("manifest.json is invalid: `v` must be an unsigned integer");
    else if (m.v !== 1) errors.push(`unsupported manifest version ${m.v} (expected 1)`);
    if (m.description !== undefined && typeof m.description !== "string") errors.push("manifest.json is invalid: `description` must be a string");
    if (m.pro !== undefined && typeof m.pro !== "boolean") errors.push("manifest.json is invalid: `pro` must be a boolean");
    if (typeof m.kind === "string" && !KINDS.includes(m.kind)) errors.push(`manifest.json is invalid: kind '${short(m.kind)}' must be one of ${KINDS.join(", ")}`);
    if (typeof m.id === "string" && !validPackId(m.id)) errors.push(`manifest.id '${short(m.id)}' must look like 'ro.mixai.skin.neon' (lowercase, dots, max 100)`);
    const len = (field, min, max) => {
        const v = m[field] ?? "";
        if (typeof v !== "string") return;
        const n = charLen(v);
        if (n < min || n > max) errors.push(`manifest.${field} must be ${min}..${max} characters (got ${n})`);
    };
    len("name", 1, 60);
    len("author", 1, 60);
    len("description", 0, 500);
    if (typeof m.version === "string" && !validVersion(m.version)) errors.push(`manifest.version '${short(m.version)}' must be MAJOR.MINOR.PATCH`);
    if (m.tokens !== undefined && m.tokens !== null) requireFile(files, "manifest.tokens", m.tokens, ["json"], errors);
    for (const l of optStrArray(m, "layouts", errors)) requireFile(files, "manifest.layouts", l, ["json"], errors);
    for (const p of optStrArray(m, "presets", errors)) requireFile(files, "manifest.presets", p, ["json"], errors);
    if (m.preview !== undefined && m.preview !== null) requireFile(files, "manifest.preview", m.preview, IMAGE_EXT, errors);
    if (m.fonts !== undefined && m.fonts !== null) {
        if (!Array.isArray(m.fonts)) errors.push("manifest.fonts must be an array");
        else for (const f of m.fonts) {
            if (!f || typeof f !== "object") { errors.push("manifest.fonts entries must be objects"); continue; }
            for (const k of Object.keys(f)) if (!FONT_KEYS.includes(k)) errors.push(`manifest.json is invalid: unknown font field \`${k}\``);
            if (!validFontFamily(f.family)) errors.push(`font family '${short(f.family)}' is not allowed`);
            requireFile(files, "font file", f.file, ["woff2"], errors);
            if (f.weight !== undefined && f.weight !== null && (!Number.isInteger(f.weight) || f.weight < 100 || f.weight > 900)) errors.push(`font weight ${f.weight} must be 100..900`);
            if (f.style !== undefined && f.style !== null && f.style !== "normal" && f.style !== "italic") errors.push("font style must be normal or italic");
        }
    }
    return errors.length === before ? m : null;
}

/** Returns the merged PackTokens (like Rust) or null on error. */
export function validateTokens(files, path, errors) {
    const v = parseJson(files, path, errors, path);
    if (v === undefined) return null;
    if (!v || typeof v !== "object" || Array.isArray(v)) { errors.push(`${path} must be a JSON object`); return null; }
    const before = errors.length;
    for (const k of Object.keys(v)) if (!k.startsWith("$") && !TOKEN_KEYS.includes(k)) errors.push(`unknown token '${short(k)}' in ${path}`);
    const t = {};
    const str = (k) => {
        const x = v[k];
        if (x === undefined || x === null) return undefined;
        if (typeof x !== "string") { errors.push(`tokens.${k} must be a string`); return undefined; }
        return x;
    };
    const oneOf = (k, allowed) => {
        const x = str(k);
        if (x !== undefined && !allowed.includes(x)) errors.push(`tokens.${k} '${short(x)}' must be one of: ${allowed.join(", ")}`);
        else if (x !== undefined) t[k] = x;
    };
    oneOf("mode", ["dark", "light"]);
    oneOf("surface", ["glass", "solid", "flat"]);
    oneOf("density", ["comfortable", "compact"]);
    oneOf("radius", ["sm", "md", "lg"]);
    const accent = str("accent");
    if (accent !== undefined) {
        const slug = accent.length >= 1 && accent.length <= 24 && /^[a-z-]+$/.test(accent);
        if (!slug && !validColor(accent)) errors.push(`tokens.accent '${short(accent)}' must be a colour or an accent name`);
        else t.accent = accent;
    }
    const colors = {};
    const put = (k, val) => {
        if (!COLOR_KEYS.includes(k)) { errors.push(`colour token '${short(k)}' is not allowed`); return; }
        if (!validColor(val)) { errors.push(`colour '${short(val)}' for '${k}' must be #rrggbb, #rrggbbaa or oklch(L C H [/ A])`); return; }
        colors[k] = val;
    };
    if (v.colors !== undefined && v.colors !== null) {
        if (typeof v.colors !== "object" || Array.isArray(v.colors)) errors.push("tokens.colors must be an object");
        else for (const [k, x] of Object.entries(v.colors)) {
            if (typeof x !== "string") errors.push(`colour '${short(k)}' must be a string`);
            else put(k, x);
        }
    }
    if (v.color !== undefined && v.color !== null) {
        if (typeof v.color !== "object" || Array.isArray(v.color)) errors.push("tokens.color must be a DTCG group object");
        else for (const [k, x] of Object.entries(v.color)) {
            if (k.startsWith("$")) continue;
            if (!x || typeof x.$value !== "string") errors.push(`DTCG colour '${short(k)}' needs a string $value`);
            else put(k, x.$value);
        }
    }
    if (Object.keys(colors).length) t.colors = Object.fromEntries(Object.entries(colors).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    if (v.decks !== undefined && v.decks !== null) {
        if (typeof v.decks !== "object" || Array.isArray(v.decks)) errors.push("tokens.decks must be an object");
        else {
            const decks = {};
            for (const [k, x] of Object.entries(v.decks)) {
                if (!["a", "b", "c", "d"].includes(k)) { errors.push(`tokens.decks key '${short(k)}' must be a..d`); continue; }
                if (typeof x !== "string" || !validColor(x)) { errors.push(`tokens.decks.${k} must be a valid colour`); continue; }
                decks[k] = x;
            }
            if (Object.keys(decks).length) t.decks = decks;
        }
    }
    for (const k of ["fontHeading", "fontBody"]) {
        const f = str(k);
        if (f === undefined) continue;
        if (!validFontFamily(f)) errors.push(`tokens.${k} '${short(f)}' is not allowed`);
        else t[k] = f;
    }
    const bg = str("background");
    if (bg !== undefined && requireFile(files, "tokens.background", bg, IMAGE_EXT, errors)) t.background = bg;
    return errors.length === before ? t : null;
}

/**
 * Validate a Map of pack files. Returns { ok, errors, warnings, manifest, tokens, layouts, trust }.
 * @param {Map<string, Buffer>} files
 * @param {{ allowLowContrast?: boolean, fromZip?: boolean, keys?: object }} [opts]
 */
export function validateFiles(files, opts = {}) {
    const errors = [];
    const warnings = [];
    if (!opts.fromZip) checkSourceLimits(files, errors);
    const manifest = validateManifest(files, errors);
    let trust = "unsigned";
    try {
        trust = verifyFiles(files, opts.keys);
    } catch (e) {
        errors.push(e.message);
    }
    let tokens = null;
    const layouts = [];
    if (manifest) {
        // Same as pack.rs: the ro.mixai. prefix and the author "MixAI" are reserved for official packs.
        const reserved = (typeof manifest.id === "string" && manifest.id.startsWith("ro.mixai.")) || String(manifest.author ?? "").trim().toLowerCase() === "mixai";
        if (reserved && trust !== "official") {
            const msg = "ids starting with 'ro.mixai.' and the author 'MixAI' are reserved for official packs";
            (opts.fromZip ? errors : warnings).push(opts.fromZip ? msg : `${msg} (sign with the official key)`);
        }
        if ((manifest.fonts ?? []).length > 8) errors.push("at most 8 fonts per pack");
        if (manifest.tokens) tokens = validateTokens(files, manifest.tokens, errors);
        else if (manifest.kind === "skin") warnings.push("skin packs normally declare manifest.tokens");
        for (const l of manifest.layouts ?? []) {
            const raw = files.get(l);
            if (raw.length > LIMITS.MAX_LAYOUT_BYTES) { errors.push(`layout '${short(l)}' is larger than ${LIMITS.MAX_LAYOUT_BYTES} bytes`); continue; }
            const doc = parseJson(files, l, errors, `layout '${short(l)}'`);
            if (doc === undefined) continue;
            if (!doc || typeof doc !== "object" || Array.isArray(doc)) { errors.push(`layout '${short(l)}' must be a JSON object`); continue; }
            for (const e of validateLayout(doc)) errors.push(`layout '${short(l)}': ${e}`);
            layouts.push(doc);
        }
        for (const p of manifest.presets ?? []) parseJson(files, p, errors, `preset '${short(p)}'`);
        if ((manifest.kind === "layout" || manifest.kind === "bundle") && !(manifest.layouts ?? []).length) warnings.push(`${manifest.kind} packs normally declare manifest.layouts`);
        if (manifest.preview && files.get(manifest.preview).length > LIMITS.MAX_PREVIEW_BYTES) warnings.push(`preview is larger than ${LIMITS.MAX_PREVIEW_BYTES} bytes and will not be shown in the app`);
        const declared = new Set([MANIFEST_FILE, SIGNATURE_FILE, manifest.tokens, manifest.preview, tokens?.background, ...(manifest.layouts ?? []), ...(manifest.presets ?? []), ...(manifest.fonts ?? []).map((f) => f.file)]);
        for (const name of files.keys()) if (!declared.has(name)) warnings.push(`'${short(name)}' is not referenced by the manifest or tokens`);
        const inline = [tokens?.background, ...(manifest.fonts ?? []).map((f) => f.file)].filter((n) => n && files.has(n)).reduce((s, n) => s + files.get(n).length, 0);
        if (inline > 2 * 1024 * 1024) errors.push(`fonts + background are ${Math.round(inline / 1024)} KB; the limit is 2048 KB`);
    }
    if (tokens?.colors) {
        for (const p of contrastProblems(tokens.colors)) {
            const msg = `low contrast: ${p.fg} on ${p.bg} is ${p.ratio}:1 (WCAG AA needs ${p.need}:1)`;
            (opts.allowLowContrast ? warnings : errors).push(msg);
        }
    }
    return { ok: errors.length === 0, errors, warnings, manifest, tokens, layouts, trust };
}

/** Validate a source directory or a .mixaipack file path. */
export function validatePath(path, opts = {}) {
    if (statSync(path).isDirectory()) {
        const { files, ignored } = readPackDir(path);
        const res = validateFiles(files, opts);
        return { ...res, files, ignored };
    }
    let files;
    try {
        files = readZip(readFileSync(path));
    } catch (e) {
        return { ok: false, errors: [e.message], warnings: [], manifest: null, tokens: null, layouts: [], trust: "unsigned", files: new Map(), ignored: [] };
    }
    return { ...validateFiles(files, { ...opts, fromZip: true }), files, ignored: [] };
}
