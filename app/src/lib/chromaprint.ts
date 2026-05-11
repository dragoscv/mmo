/**
 * Pure-JS Chromaprint fingerprint decoder + similarity helpers.
 *
 * The companion stores `acoustidFingerprint` as the standard
 * Chromaprint-compressed, URL-safe base64 string returned by `fpcalc`
 * / `pyacoustid`. Internally that string IS the raw fingerprint bytes —
 * just packed using the algorithm in
 *   chromaprint/src/fingerprint_compressor.cpp
 * Decoding gives us back a `Uint32Array` of 32-bit subfingerprint
 * "items" (one per ~0.124 s of audio) on which we can compute the real
 * Hamming distance — the metric Chromaprint was designed for and the
 * one AcoustID itself uses.
 *
 * Why this matters for `findAudioDuplicates`:
 *   The previous heuristic bucketed by the first 24 *base64 characters*
 *   of the compressed string. Two identical-sounding files re-encoded
 *   at different bitrates often differ in the first byte already, so
 *   they ended up in different buckets and were never compared. With
 *   Hamming distance on the unpacked bits, identical recordings score
 *   ~98 % similarity even after re-encoding, while unrelated tracks
 *   stay below 60 %.
 */

// ─── URL-safe base64 → Uint8Array ────────────────────────────────────────────

function base64UrlToBytes(s: string): Uint8Array | null {
    // Chromaprint uses URL-safe alphabet (`-_`) with no padding.
    let normalised = s.replace(/-/g, "+").replace(/_/g, "/");
    while (normalised.length % 4 !== 0) normalised += "=";
    try {
        if (typeof atob === "function") {
            const bin = atob(normalised);
            const out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        }
        // Node fallback (server actions / vitest).
        return new Uint8Array(Buffer.from(normalised, "base64"));
    } catch {
        return null;
    }
}

// ─── 3-bit / 5-bit reader over a packed byte stream ──────────────────────────

class BitReader {
    private bytes: Uint8Array;
    private bitPos = 0;
    constructor(bytes: Uint8Array) {
        this.bytes = bytes;
    }
    /** Returns the next `n` bits (LSB-first within each byte) or null at EOF. */
    read(n: number): number | null {
        let result = 0;
        let written = 0;
        while (written < n) {
            const bytePos = this.bitPos >> 3;
            if (bytePos >= this.bytes.length) return null;
            const bitInByte = this.bitPos & 7;
            const remainingInByte = 8 - bitInByte;
            const take = Math.min(remainingInByte, n - written);
            const mask = (1 << take) - 1;
            const chunk = (this.bytes[bytePos] >> bitInByte) & mask;
            result |= chunk << written;
            written += take;
            this.bitPos += take;
        }
        return result >>> 0;
    }
}

// ─── Decode ──────────────────────────────────────────────────────────────────

const NORMAL_BITS = 3;
const EXCEPTION_BITS = 5;
const MAX_NORMAL_VALUE = (1 << NORMAL_BITS) - 1; // 7

export interface DecodedFingerprint {
    algorithm: number;
    /** XOR-delta-reconstructed subfingerprint values, one per ~124 ms. */
    data: Uint32Array;
}

/**
 * Decode a Chromaprint-compressed fingerprint string. Returns null on
 * any malformation rather than throwing — callers iterate over user
 * data and a single bad fingerprint must not abort the whole batch.
 */
export function decodeFingerprint(s: string | null | undefined): DecodedFingerprint | null {
    if (!s || typeof s !== "string") return null;
    const bytes = base64UrlToBytes(s);
    if (!bytes || bytes.length < 4) return null;
    const algorithm = bytes[0];
    const numItems = (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    if (numItems <= 0 || numItems > 100_000) return null; // sanity cap

    const reader = new BitReader(bytes.subarray(4));
    const collected: number[] = [];

    // Read 3-bit values until we've seen `numItems` zero terminators
    // (one zero per item ends the run of bit positions for that item).
    let zeros = 0;
    while (zeros < numItems) {
        const v = reader.read(NORMAL_BITS);
        if (v === null) break;
        collected.push(v);
        if (v === 0) zeros++;
    }

    // For each value of MAX_NORMAL_VALUE (7), read an extra 5-bit
    // exception that is *added* to the original 7.
    for (let i = 0; i < collected.length; i++) {
        if (collected[i] === MAX_NORMAL_VALUE) {
            const ext = reader.read(EXCEPTION_BITS);
            if (ext === null) break;
            collected[i] += ext;
        }
    }

    // Unpack: 0 advances to next item, non-zero accumulates `last_bit`
    // and sets bit (last_bit - 1) in the current item's 32-bit word.
    const result = new Uint32Array(numItems);
    let i = 0;
    let lastBit = 0;
    for (const bit of collected) {
        if (i >= numItems) break;
        if (bit === 0) {
            i++;
            lastBit = 0;
            continue;
        }
        lastBit += bit;
        if (lastBit > 0 && lastBit <= 32) {
            result[i] = (result[i] | (1 << (lastBit - 1))) >>> 0;
        }
    }

    // The encoder stores XOR deltas between consecutive items so the
    // bit values stay small (close to 0). Reconstruct the actual
    // subfingerprint values with a cumulative prefix XOR.
    for (let k = 1; k < result.length; k++) {
        result[k] = (result[k] ^ result[k - 1]) >>> 0;
    }
    return { algorithm, data: result };
}

// ─── Hamming distance + similarity ───────────────────────────────────────────

/** Population count (set-bit count) for a 32-bit unsigned int. */
function popcount32(x: number): number {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    return (Math.imul(x, 0x01010101) >>> 24) & 0xff;
}

/**
 * Bit-level Hamming distance between two fingerprints. Compares the
 * overlapping prefix (min length) — Chromaprint subfingerprints are
 * positional, so comparing aligned items is meaningful even when the
 * recordings have different total lengths.
 */
export function hammingDistance(a: Uint32Array, b: Uint32Array): number {
    const len = Math.min(a.length, b.length);
    let diff = 0;
    for (let i = 0; i < len; i++) {
        diff += popcount32((a[i] ^ b[i]) >>> 0);
    }
    return diff;
}

/**
 * Similarity in the closed interval [0, 1]. 1 = identical bits across
 * the overlap, 0 = all 32 × len bits differ. Two distinct recordings
 * of the same song typically score in the 0.85–0.99 range; unrelated
 * tracks sit below 0.55. Returns 0 when either side has no overlap.
 */
export function fingerprintSimilarity(a: Uint32Array, b: Uint32Array): number {
    const len = Math.min(a.length, b.length);
    if (len === 0) return 0;
    const totalBits = len * 32;
    return 1 - hammingDistance(a, b) / totalBits;
}
