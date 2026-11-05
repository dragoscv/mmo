/**
 * HTTP Range math for the offline service-worker route (`<video>` seeking needs 206 responses).
 * Pure: parse one `Range` header against a known size and map the byte window onto stored parts.
 */

export interface ByteRange {
    /** Inclusive. */
    start: number;
    /** Inclusive. */
    end: number;
}

/**
 * - `null` → no usable Range (absent, not `bytes=`, or multi-range, which we answer with the full body)
 * - `"unsatisfiable"` → 416
 * - otherwise the clamped inclusive window.
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | null | "unsatisfiable" {
    if (!header) return null;
    const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
    if (!m) return null;
    const [, a = "", b = ""] = m;
    if (a === "" && b === "") return null;
    if (size <= 0) return "unsatisfiable";
    if (a === "") {
        // Suffix range: last N bytes.
        const n = Number(b);
        if (n <= 0) return "unsatisfiable";
        return { start: Math.max(0, size - n), end: size - 1 };
    }
    const start = Number(a);
    const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
    if (start >= size || start > end) return "unsatisfiable";
    return { start, end };
}

export interface PartSlice {
    /** Part index. */
    index: number;
    /** Inclusive offset inside the part. */
    from: number;
    /** Inclusive offset inside the part. */
    to: number;
}

/** Which parts (and which bytes inside each) cover `[start, end]` (inclusive). */
export function planSlices(parts: readonly number[], start: number, end: number): PartSlice[] {
    const out: PartSlice[] = [];
    let offset = 0;
    for (let i = 0; i < parts.length; i++) {
        const len = parts[i] ?? 0;
        const pStart = offset;
        const pEnd = offset + len - 1;
        offset += len;
        if (len <= 0 || pEnd < start) continue;
        if (pStart > end) break;
        out.push({ index: i, from: Math.max(start, pStart) - pStart, to: Math.min(end, pEnd) - pStart });
    }
    return out;
}

export function contentRange(r: ByteRange, size: number): string {
    return `bytes ${r.start}-${r.end}/${size}`;
}
