/**
 * Quick content fingerprint for a track — the cross-device identity key of
 * the crate / cue sync (docs/decks/crate-sync-design.md, decision D2).
 *
 * Definition (must match `crates/decks-library/src/util.rs#quick_hash` byte
 * for byte, so a file on a phone finds the same cues as the server's copy):
 *
 *   SHA-256 over
 *     - the file size as an unsigned 64-bit little-endian number (8 bytes)
 *     - the first 256 KiB of the file
 *     - the last 256 KiB of the file, only when the file is larger than 512 KiB
 *   …of which the first 16 bytes are rendered as 32 lowercase hex characters.
 *
 * Two short reads, no audio decode — cheap enough to run for every file at
 * scan time. Not a tamper-proof hash; good enough to re-find a moved file.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";

export const QUICK_HASH_CHUNK = 256 * 1024;

/** Read until `buf` is full or EOF (mirrors Rust `read_up_to`). */
function readUpTo(fd: number, buf: Buffer, position: number): number {
    let n = 0;
    while (n < buf.length) {
        const r = fs.readSync(fd, buf, n, buf.length - n, position + n);
        if (r === 0) break;
        n += r;
    }
    return n;
}

/**
 * Compute the quick hash of a file. Throws only when the file cannot be
 * opened or stat'ed — callers that must not fail use {@link quickHashOrNull}.
 */
export function quickHash(filepath: string): string {
    const fd = fs.openSync(filepath, "r");
    try {
        const len = fs.fstatSync(fd).size;
        const h = createHash("sha256");
        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeBigUInt64LE(BigInt(len));
        h.update(sizeBuf);
        const buf = Buffer.alloc(QUICK_HASH_CHUNK);
        const n = readUpTo(fd, buf, 0);
        h.update(buf.subarray(0, n));
        if (len > 2 * QUICK_HASH_CHUNK) {
            const n2 = readUpTo(fd, buf, len - QUICK_HASH_CHUNK);
            h.update(buf.subarray(0, n2));
        }
        return h.digest("hex").slice(0, 32);
    } finally {
        fs.closeSync(fd);
    }
}

/** {@link quickHash} that returns null instead of throwing (missing file,
 *  permissions, I/O error). Used on the scan / ingest / backfill paths where
 *  a hash failure must not abort the whole batch. */
export function quickHashOrNull(filepath: string): string | null {
    try {
        return quickHash(filepath);
    } catch {
        return null;
    }
}

/** True for a well-formed quick hash (32 lowercase hex characters). */
export function isQuickHash(v: unknown): v is string {
    return typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
}
