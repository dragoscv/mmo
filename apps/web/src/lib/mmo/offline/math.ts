/** Pure helpers for the download manager + UI: progress, quota decision, size formatting. */

/** Bytes per stored part (one Cache Storage entry). Resume restarts at the last completed part. */
export const PART_SIZE = 32 * 1024 * 1024;
/** Always leave this much of the origin quota free. */
export const QUOTA_RESERVE = 256 * 1024 * 1024;

export function sum(values: readonly number[]): number {
    let s = 0;
    for (const v of values) s += v;
    return s;
}

/** Whole percent 0–100, or null when the total is unknown. */
export function percent(bytes: number, total: number | null | undefined): number | null {
    if (!total || total <= 0) return null;
    return Math.max(0, Math.min(100, Math.floor((bytes / total) * 100)));
}

export type QuotaDecision =
    | { ok: true; free: number | null }
    | { ok: false; free: number; needed: number };

/**
 * Can we store `needed` more bytes? `usage`/`quota` come from `navigator.storage.estimate()`.
 * Unknown quota → allow (the write itself will fail with QuotaExceededError if not). Unknown size →
 * allow while more than the reserve is free.
 */
export function quotaDecision(input: { usage?: number | null; quota?: number | null; needed: number | null }): QuotaDecision {
    const { usage, quota, needed } = input;
    if (!quota || quota <= 0) return { ok: true, free: null };
    const free = Math.max(0, quota - (usage ?? 0));
    const want = (needed ?? 0) + QUOTA_RESERVE;
    if (want <= free) return { ok: true, free };
    return { ok: false, free, needed: needed ?? QUOTA_RESERVE };
}

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

/** Localised decimal size (`1,2 GB` in RO, `1.2 GB` in EN). */
export function formatBytes(bytes: number, locale: string): string {
    let v = Math.max(0, bytes);
    let i = 0;
    while (v >= 1000 && i < UNITS.length - 1) { v /= 1000; i++; }
    const digits = i === 0 ? 0 : v < 10 ? 1 : 0;
    return new Intl.NumberFormat(locale, { style: "unit", unit: UNITS[i], unitDisplay: "short", maximumFractionDigits: digits }).format(v);
}
