/**
 * Serato Sub-files V2 binary `.crate` writer.
 *
 * Format reference (reverse-engineered, public domain knowledge):
 *   - Tag: 4 ASCII bytes
 *   - Length: 4-byte big-endian uint32 (payload bytes)
 *   - Payload: either UTF-16BE string or nested tags (no terminator)
 *
 * A minimal compatible crate contains:
 *   vrsn = "1.0/Serato ScratchLive Crate"     (UTF-16BE)
 *   osrt = container { tvcn="song", brev=0x00 }   (sort order)
 *   ovct = container { tvcn=<col>, tvcw=<width> } (one per visible column)
 *   otrk = container { ptrk=<relative path> }     (one per track)
 *
 * `ptrk` paths are relative to the drive root, with forward slashes,
 * no leading slash. Example: "Music/My Track.mp3".
 *
 * The output buffer is a complete `.crate` file ready to be written to
 * `<drive>/_Serato_/Subcrates/<name>.crate`.
 */

const VERSION_STRING = "1.0/Serato ScratchLive Crate";

const DEFAULT_COLUMNS: ReadonlyArray<{ name: string; width: string }> = [
    { name: "song", width: "551" },
    { name: "artist", width: "343" },
    { name: "bpm", width: "50" },
    { name: "key", width: "50" },
    { name: "album", width: "0" },
    { name: "length", width: "50" },
];

export interface SeratoCrateTrack {
    /** Path relative to the drive/volume root, e.g. "Music/Artist - Title.mp3".
     *  Backslashes and leading slashes are normalised. */
    relativePath: string;
}

export interface BuildCrateOptions {
    tracks: ReadonlyArray<SeratoCrateTrack>;
    /** Override visible columns. Defaults to a sensible DJ set. */
    columns?: ReadonlyArray<{ name: string; width: string }>;
    /** Sort column. Defaults to "song". */
    sortColumn?: string;
}

/** UTF-16BE encode a string (no BOM, no terminator). */
function encodeUtf16BE(s: string): Buffer {
    const buf = Buffer.alloc(s.length * 2);
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        // Crate files are produced/consumed by Serato and confined to
        // BMP code points in practice; surrogate pairs would round-trip
        // as two 16-bit units anyway, so no special handling needed.
        buf.writeUInt16BE(code, i * 2);
    }
    return buf;
}

function tag(name: string, payload: Buffer): Buffer {
    if (name.length !== 4) {
        throw new Error(`serato tag must be exactly 4 ASCII chars, got "${name}"`);
    }
    const header = Buffer.alloc(8);
    header.write(name, 0, 4, "ascii");
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
}

function stringTag(name: string, value: string): Buffer {
    return tag(name, encodeUtf16BE(value));
}

function normalisePath(p: string): string {
    return p
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        // Collapse repeated slashes — Serato is intolerant of "//".
        .replace(/\/{2,}/g, "/");
}

/** Build the full `.crate` file as a Buffer. Pure, no I/O. */
export function buildSeratoCrate(opts: BuildCrateOptions): Buffer {
    const columns = opts.columns ?? DEFAULT_COLUMNS;
    const sortColumn = opts.sortColumn ?? "song";

    const parts: Buffer[] = [];

    // Version (must come first).
    parts.push(stringTag("vrsn", VERSION_STRING));

    // Sort order: tvcn=<col> + brev=0x00 (ascending).
    const osrtPayload = Buffer.concat([
        stringTag("tvcn", sortColumn),
        tag("brev", Buffer.from([0x00])),
    ]);
    parts.push(tag("osrt", osrtPayload));

    // Visible columns.
    for (const col of columns) {
        const ovctPayload = Buffer.concat([
            stringTag("tvcn", col.name),
            stringTag("tvcw", col.width),
        ]);
        parts.push(tag("ovct", ovctPayload));
    }

    // Tracks.
    for (const t of opts.tracks) {
        const rel = normalisePath(t.relativePath);
        if (!rel) continue;
        const otrkPayload = stringTag("ptrk", rel);
        parts.push(tag("otrk", otrkPayload));
    }

    return Buffer.concat(parts);
}

/** Sanitise a name for use as a Serato subcrate filename. Serato itself
 *  uses `%%` as a folder separator inside the filename for nested
 *  subcrates; we just strip path-hostile chars for now. */
export function sanitizeCrateName(name: string): string {
    return name
        .replace(/[\\/:*?"<>|]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200) || "playlist";
}

/** Convenience parser for tests / round-trip checks. Returns the flat
 *  list of top-level tags with raw payloads. Does NOT recurse into
 *  containers — callers slice the payload again with `parseCrate`. */
export function parseCrate(buf: Buffer): Array<{ name: string; payload: Buffer }> {
    const out: Array<{ name: string; payload: Buffer }> = [];
    let i = 0;
    while (i < buf.length) {
        if (i + 8 > buf.length) {
            throw new Error("truncated crate: header beyond buffer end");
        }
        const name = buf.subarray(i, i + 4).toString("ascii");
        const len = buf.readUInt32BE(i + 4);
        if (i + 8 + len > buf.length) {
            throw new Error(`truncated crate: tag ${name} len ${len} beyond buffer`);
        }
        out.push({ name, payload: buf.subarray(i + 8, i + 8 + len) });
        i += 8 + len;
    }
    return out;
}

/** Decode a UTF-16BE string payload. */
export function decodeUtf16BE(buf: Buffer): string {
    let s = "";
    for (let i = 0; i + 1 < buf.length; i += 2) {
        s += String.fromCharCode(buf.readUInt16BE(i));
    }
    return s;
}
