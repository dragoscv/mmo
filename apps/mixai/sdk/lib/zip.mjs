// Minimal, deterministic zip writer + bounded reader (Stored / Deflated only).
// Mirrors the limits of apps/mixai/src-tauri/src/pack.rs (read_archive).
import { deflateRawSync, inflateRawSync } from "node:zlib";

export const LIMITS = Object.freeze({
    MAX_ARCHIVE_BYTES: 25 * 1024 * 1024,
    MAX_ENTRIES: 200,
    MAX_ENTRY_BYTES: 10 * 1024 * 1024,
    MAX_TOTAL_BYTES: 60 * 1024 * 1024,
    MAX_RATIO: 100,
    RATIO_MIN_BYTES: 64 * 1024,
    MAX_LAYOUT_BYTES: 64 * 1024,
    MAX_PREVIEW_BYTES: 512 * 1024,
});

export const ALLOWED_EXT = ["json", "png", "jpg", "jpeg", "webp", "avif", "woff2"];
export const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "avif"];
/** Already-compressed formats are stored, everything else deflated. */
const STORED_EXT = new Set(["png", "jpg", "jpeg", "webp", "avif", "woff2"]);

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

export function extOf(name) {
    const file = name.split("/").pop() ?? "";
    const i = file.lastIndexOf(".");
    return i < 0 ? null : file.slice(i + 1).toLowerCase();
}

export function short(s) {
    return [...String(s)].slice(0, 80).join("");
}

/** Same rules as pack.rs validate_entry_name. Returns an error string or null. */
export function entryNameError(name) {
    const bad = (why) => `invalid entry name '${short(name)}': ${why}`;
    if (!name || Buffer.byteLength(name) > 200) return bad("empty or longer than 200 bytes");
    if (name.startsWith("/")) return bad("absolute path");
    if (name.includes("\\")) return bad("backslash");
    if (name.includes(":")) return bad("drive or stream separator");
    // Rust char::is_control = Unicode Cc (C0, DEL, C1).
    if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return bad("control character");
    const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
    for (const seg of trimmed.split("/")) {
        if (seg === "" || seg === "." || seg === "..") return bad("empty, '.' or '..' segment");
    }
    return null;
}

// DOS date for 1980-01-01 00:00:00 (year 0, month 1, day 1); time 0.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/**
 * Write a deterministic zip: entries sorted by name (byte order), fixed mtime, deflate for
 * JSON, stored for images/fonts. No data descriptors, no zip64, no extra fields.
 * @param {Map<string, Buffer>|Record<string, Buffer>} files
 */
export function writeZip(files) {
    const entries = [...(files instanceof Map ? files.entries() : Object.entries(files))]
        .map(([n, b]) => [n, Buffer.from(b)])
        .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, data] of entries) {
        const err = entryNameError(name);
        if (err) throw new Error(err);
        const nameBuf = Buffer.from(name, "utf8");
        const stored = STORED_EXT.has(extOf(name) ?? "");
        let comp = stored ? data : deflateRawSync(data, { level: 9 });
        let method = stored ? 0 : 8;
        if (!stored && comp.length >= data.length) { comp = data; method = 0; }
        const crc = crc32(data);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4); // version needed
        lh.writeUInt16LE(0x0800, 6); // UTF-8 names
        lh.writeUInt16LE(method, 8);
        lh.writeUInt16LE(DOS_TIME, 10);
        lh.writeUInt16LE(DOS_DATE, 12);
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(comp.length, 18);
        lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(nameBuf.length, 26);
        lh.writeUInt16LE(0, 28);
        locals.push(lh, nameBuf, comp);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt16LE(20, 4); // made by: MS-DOS, spec 2.0 (no unix mode bits -> never a symlink)
        ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(0x0800, 8);
        ch.writeUInt16LE(method, 10);
        ch.writeUInt16LE(DOS_TIME, 12);
        ch.writeUInt16LE(DOS_DATE, 14);
        ch.writeUInt32LE(crc, 16);
        ch.writeUInt32LE(comp.length, 20);
        ch.writeUInt32LE(data.length, 24);
        ch.writeUInt16LE(nameBuf.length, 28);
        ch.writeUInt16LE(0, 30); // extra
        ch.writeUInt16LE(0, 32); // comment
        ch.writeUInt16LE(0, 34); // disk
        ch.writeUInt16LE(0, 36); // internal attrs
        ch.writeUInt32LE(0, 38); // external attrs
        ch.writeUInt32LE(offset, 42);
        centrals.push(ch, nameBuf);
        offset += lh.length + nameBuf.length + comp.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, cd, eocd]);
}

/**
 * Read a zip with the pack.rs guards. Returns Map<name, Buffer> sorted by name (dirs skipped).
 * Throws Error with a readable message on any violation.
 */
export function readZip(bytes) {
    const buf = Buffer.from(bytes);
    if (buf.length > LIMITS.MAX_ARCHIVE_BYTES) {
        throw new Error(`pack is too large (${buf.length} bytes, limit ${LIMITS.MAX_ARCHIVE_BYTES})`);
    }
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a valid zip: end of central directory not found");
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOff = buf.readUInt32LE(eocd + 16);
    if (cdOff + cdSize > eocd) throw new Error("not a valid zip: bad central directory offset");
    if (count > LIMITS.MAX_ENTRIES) throw new Error(`pack has too many entries (${count}, limit ${LIMITS.MAX_ENTRIES})`);
    const out = new Map();
    let p = cdOff;
    let total = 0;
    for (let i = 0; i < count; i++) {
        if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`cannot read zip entry ${i}: bad central header`);
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const csize = buf.readUInt32LE(p + 20);
        const usize = buf.readUInt32LE(p + 24);
        const nlen = buf.readUInt16LE(p + 28);
        const xlen = buf.readUInt16LE(p + 30);
        const clen = buf.readUInt16LE(p + 32);
        const madeBy = buf.readUInt16LE(p + 4) >> 8;
        const ext = buf.readUInt32LE(p + 38);
        const lho = buf.readUInt32LE(p + 42);
        const nameRaw = buf.subarray(p + 46, p + 46 + nlen);
        const name = new TextDecoder("utf-8", { fatal: true }).decode(nameRaw);
        p += 46 + nlen + xlen + clen;
        const nameErr = entryNameError(name);
        if (nameErr) throw new Error(nameErr);
        if (out.has(name)) throw new Error(`duplicate entry '${short(name)}'`);
        if (madeBy === 3 && ((ext >>> 16) & 0o170000) === 0o120000) throw new Error(`symlinks are not allowed ('${short(name)}')`);
        if (flags & 1) throw new Error(`encrypted entries are not allowed ('${short(name)}')`);
        if (name.endsWith("/")) { out.set(name, null); continue; }
        const e = extOf(name);
        if (!e || !ALLOWED_EXT.includes(e)) {
            throw new Error(`file type not allowed: '${short(name)}' (allowed: ${ALLOWED_EXT.join(", ")})`);
        }
        if (method !== 0 && method !== 8) throw new Error(`unsupported compression for '${short(name)}' (use deflate or store)`);
        if (usize > LIMITS.MAX_ENTRY_BYTES) {
            throw new Error(`entry '${short(name)}' is too large (${usize} bytes, limit ${LIMITS.MAX_ENTRY_BYTES})`);
        }
        const comp = Math.max(csize, 1);
        if (usize >= LIMITS.RATIO_MIN_BYTES && Math.floor(usize / comp) > LIMITS.MAX_RATIO) {
            throw new Error(`entry '${short(name)}' compression ratio ${Math.floor(usize / comp)} exceeds ${LIMITS.MAX_RATIO} (zip bomb guard)`);
        }
        total += usize;
        if (total > LIMITS.MAX_TOTAL_BYTES) throw new Error(`pack uncompressed size exceeds ${LIMITS.MAX_TOTAL_BYTES} bytes`);
        if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`cannot read zip entry ${i}: bad local header`);
        const dataOff = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
        if (dataOff + csize > buf.length) throw new Error(`cannot read zip entry ${i}: truncated`);
        const raw = buf.subarray(dataOff, dataOff + csize);
        let data;
        try {
            data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: LIMITS.MAX_ENTRY_BYTES + 1 });
        } catch (err) {
            throw new Error(`cannot decompress '${short(name)}': ${err.message}`);
        }
        if (data.length !== usize) throw new Error(`entry '${short(name)}' size mismatch`);
        if (crc32(data) !== crc) throw new Error(`cannot decompress '${short(name)}': CRC mismatch`);
        out.set(name, data);
    }
    const files = new Map();
    for (const k of [...out.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
        if (out.get(k)) files.set(k, out.get(k));
    }
    return files;
}
