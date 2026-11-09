// Build (validate -> deterministic zip -> optional signature) and catalogue packs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SIGNATURE_FILE, sha256Hex, signatureFor } from "./sign.mjs";
import { validateFiles } from "./validate.mjs";
import { readZip, writeZip } from "./zip.mjs";

/**
 * @param {Map<string, Buffer>} files source files (signature.json is dropped)
 * @param {{ seed?: Buffer, keyId?: string, embedPubkey?: boolean, allowLowContrast?: boolean }} opts
 * @returns {{ bytes: Buffer, result: ReturnType<typeof validateFiles> }}
 */
export function buildPack(files, opts = {}) {
    const src = new Map([...files].filter(([n]) => n !== SIGNATURE_FILE));
    const result = validateFiles(src, { allowLowContrast: opts.allowLowContrast });
    if (!result.ok) {
        const err = new Error(`pack is invalid:\n  - ${result.errors.join("\n  - ")}`);
        err.result = result;
        throw err;
    }
    if (opts.seed) {
        src.set(SIGNATURE_FILE, signatureFor(src, opts.seed, opts.keyId, { embedPubkey: opts.embedPubkey ?? false }));
    }
    const bytes = writeZip(src);
    // Self-check: what we wrote must read back and verify with the same rules as Rust.
    const back = validateFiles(readZip(bytes), { allowLowContrast: opts.allowLowContrast, fromZip: true });
    if (!back.ok) throw new Error(`internal: written pack does not re-validate: ${back.errors.join("; ")}`);
    return { bytes, result: back };
}

/**
 * Build a MarketCatalog (apps/mixai/src/bridge/marketplace.ts) from a directory of .mixaipack.
 * Returns { catalog, previews: Map<id, {name, bytes}> }.
 */
export function buildCatalog(dir, { baseUrl = "/api/decks/packs", date, tags = {} } = {}) {
    const now = date ?? new Date().toISOString();
    const packs = [];
    const previews = new Map();
    const names = readdirSync(dir).filter((n) => n.endsWith(".mixaipack")).sort();
    for (const n of names) {
        const bytes = readFileSync(join(dir, n));
        const files = readZip(bytes);
        const res = validateFiles(files, { fromZip: true });
        if (!res.ok) throw new Error(`${n}: ${res.errors.join("; ")}`);
        const m = res.manifest;
        if (n !== `${m.id}.mixaipack`) throw new Error(`${n}: file name must be <manifest.id>.mixaipack (${m.id}.mixaipack)`);
        if (packs.some((p) => p.id === m.id)) throw new Error(`duplicate pack id ${m.id}`);
        let previewUrl = null;
        if (m.preview) {
            previews.set(m.id, { name: m.preview, bytes: files.get(m.preview) });
            previewUrl = `${baseUrl}/${encodeURIComponent(m.id)}/preview`;
        }
        packs.push({
            id: m.id,
            name: m.name,
            version: m.version,
            kind: m.kind,
            author: m.author,
            description: m.description ?? "",
            pro: m.pro === true,
            trust: res.trust,
            size: bytes.length,
            sha256: sha256Hex(bytes),
            previewUrl,
            tags: tags[m.id] ?? [m.kind],
            updatedAt: now,
        });
    }
    return { catalog: { v: 1, generatedAt: now, packs }, previews };
}
