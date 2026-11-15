/**
 * Tests for the quick content hash — the cross-device identity key.
 *
 * The definition is pinned to `crates/decks-library/src/util.rs#quick_hash`
 * (SHA-256 over size-as-u64-LE ‖ first 256 KiB ‖ last 256 KiB when the file
 * is > 512 KiB, first 16 bytes as hex). These tests do NOT run the Rust side
 * (Rust is untouched this round); instead they pin the byte stream with an
 * independent construction and with discriminating boundary cases, so a
 * regression in the read offsets or the size encoding fails loudly.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { quickHash, quickHashOrNull, isQuickHash, QUICK_HASH_CHUNK } from "./quick-hash";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mixai-qh-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function write(bytes: Buffer): string {
    const p = path.join(tmp, `f${seq++}.bin`);
    fs.writeFileSync(p, bytes);
    return p;
}

/** Independent construction of the same definition, over whole buffers. */
function reference(filepath: string): string {
    const all = fs.readFileSync(filepath);
    const parts: Buffer[] = [];
    const size = Buffer.alloc(8);
    size.writeBigUInt64LE(BigInt(all.length));
    parts.push(size, all.subarray(0, QUICK_HASH_CHUNK));
    if (all.length > 2 * QUICK_HASH_CHUNK) parts.push(all.subarray(all.length - QUICK_HASH_CHUNK));
    return createHash("sha256").update(Buffer.concat(parts)).digest("hex").slice(0, 32);
}

const mk = (size: number, fill = 0x41) => {
    const b = Buffer.alloc(size, fill);
    for (let i = 0; i < size; i++) b[i] = (i * 31 + fill) & 0xff;
    return b;
};

describe("quickHash", () => {
    it("is 32 lowercase hex and matches an independent construction", () => {
        for (const size of [0, 1, 1000, QUICK_HASH_CHUNK, QUICK_HASH_CHUNK + 7, 2 * QUICK_HASH_CHUNK + 123]) {
            const p = write(mk(size));
            const h = quickHash(p);
            expect(isQuickHash(h)).toBe(true);
            expect(h).toBe(reference(p));
        }
    });

    it("hashes the whole file when it is <= 256 KiB", () => {
        const a = write(mk(1000, 1));
        const b = write(mk(1000, 2));
        expect(quickHash(a)).not.toBe(quickHash(b));
    });

    it("ignores the tail beyond the first 256 KiB for a file 256 KiB..512 KiB", () => {
        // Two files identical in their first 256 KiB and size-equal, but with
        // a different tail. The definition reads only the first chunk here.
        const base = mk(QUICK_HASH_CHUNK + 1000, 5);
        const p1 = write(base);
        const tweaked = Buffer.from(base);
        tweaked[QUICK_HASH_CHUNK + 500] ^= 0xff; // beyond the first chunk
        const p2 = write(tweaked);
        expect(quickHash(p1)).toBe(quickHash(p2));
    });

    it("changes when the first 256 KiB change", () => {
        const p1 = write(mk(QUICK_HASH_CHUNK + 1000, 5));
        const tweaked = mk(QUICK_HASH_CHUNK + 1000, 5);
        tweaked[10] ^= 0xff;
        const p2 = write(tweaked);
        expect(quickHash(p1)).not.toBe(quickHash(p2));
    });

    it("reads the LAST 256 KiB for a file larger than 512 KiB", () => {
        const size = 2 * QUICK_HASH_CHUNK + 5000;
        const base = mk(size, 9);
        const p1 = write(base);
        const tweaked = Buffer.from(base);
        tweaked[size - 10] ^= 0xff; // inside the last chunk
        const p2 = write(tweaked);
        expect(quickHash(p1)).not.toBe(quickHash(p2));
    });

    it("ignores the middle for a file larger than 512 KiB", () => {
        const size = 3 * QUICK_HASH_CHUNK;
        const base = mk(size, 9);
        const p1 = write(base);
        const tweaked = Buffer.from(base);
        tweaked[QUICK_HASH_CHUNK + 1000] ^= 0xff; // between the two chunks
        const p2 = write(tweaked);
        expect(quickHash(p1)).toBe(quickHash(p2));
    });

    it("includes the file size (two zero files of different length differ)", () => {
        const p1 = write(Buffer.alloc(QUICK_HASH_CHUNK, 0));
        const p2 = write(Buffer.alloc(QUICK_HASH_CHUNK + 500, 0));
        expect(quickHash(p1)).not.toBe(quickHash(p2));
    });

    it("quickHashOrNull returns null for a missing file", () => {
        expect(quickHashOrNull(path.join(tmp, "nope.bin"))).toBeNull();
    });

    it("rejects malformed hashes", () => {
        expect(isQuickHash("A".repeat(32))).toBe(false);
        expect(isQuickHash("a".repeat(31))).toBe(false);
        expect(isQuickHash(null)).toBe(false);
    });
});
