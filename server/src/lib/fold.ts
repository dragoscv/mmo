/**
 * Accent-insensitive folding for search + filtering (RO first: ș ş ț ţ ă â î).
 * NFD + strip combining marks covers ă/â/î/é/ü…; the cedilla forms ş/ţ (U+015F/U+0163) and the
 * comma-below forms ș/ț (U+0219/U+021B) both decompose to s/t + a combining mark, but are mapped
 * explicitly too so behaviour never depends on the ICU build.
 */

const EXTRA: Record<string, string> = { "ș": "s", "ş": "s", "ț": "t", "ţ": "t", "Ș": "s", "Ş": "s", "Ț": "t", "Ţ": "t", "ß": "ss", "ø": "o", "ł": "l", "đ": "d" };

export function foldText(s: string): string {
    return s
        .replace(/[șşțţȘŞȚŢßøłđ]/g, (c) => EXTRA[c] ?? c)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}
