/**
 * Device-code login — client-safe user-code helpers (no `node:crypto`).
 * Imported by the `/activate` client component; `device-code.ts` re-exports
 * these for server code and adds the crypto/state-machine parts.
 */

/** Human-friendly alphabet: no 0/O, no 1/I. 32 symbols → 8 chars = 40 bits. */
export const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const USER_CODE_LENGTH = 8;

/** "ABCD1234" → "ABCD-1234" (display form). */
export function formatUserCode(code: string): string {
    const c = normalizeUserCode(code);
    return `${c.slice(0, 4)}-${c.slice(4)}`;
}

/** Accepts "abcd-1234", "ABCD 1234", "ABCD1234" → "ABCD1234". Does NOT validate. */
export function normalizeUserCode(input: string): string {
    return input.toUpperCase().replace(/[^A-Z2-9]/g, "");
}

export const USER_CODE_RE = new RegExp(`^[${USER_CODE_ALPHABET}]{${USER_CODE_LENGTH}}$`);

export function isValidUserCode(normalized: string): boolean {
    return USER_CODE_RE.test(normalized);
}
