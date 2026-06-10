/**
 * Pure helpers for the duplicates pipeline. Lives outside `actions/`
 * because Next.js' "use server" boundary only allows async exports
 * — these are sync.
 */

export interface DuplicateTrackBasic {
    bitrate: number | null;
    format: string | null;
    rating: number | null;
    addedAt: string | null;
}

/** Score a candidate so the "best" copy floats to the top of a group.
 *  Higher bitrate + lossless format + higher rating + more recent. */
export function quality(t: DuplicateTrackBasic): number {
    let s = 0;
    s += t.bitrate ?? 0;
    if (t.format && /flac|alac|wav|aiff/i.test(t.format)) s += 5000;
    s += (t.rating ?? 0) * 100;
    if (t.addedAt) s += Math.min(1000, Math.floor(Date.parse(t.addedAt) / 1e10));
    return s;
}

/** Lowercase, strip diacritics, drop bracketed annotations, drop
 *  dash-suffix variants, collapse to single-spaced alphanumerics. */
export function normaliseString(s: string | null | undefined): string {
    if (!s) return "";
    return s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\(\[].*?[\)\]]/g, " ")
        .replace(/\s-\s.*$/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

/** Round to nearest 5-second bucket so 03:21 ≈ 03:23. */
export function durationBucket(seconds: number | null): string {
    if (!seconds || seconds <= 0) return "0";
    return String(Math.round(seconds / 5));
}
