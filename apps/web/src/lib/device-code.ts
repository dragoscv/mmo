/**
 * Device-code login — pure helpers (no DB, no framework).
 *
 * Flow (RFC 8628 shape, Plex/Netflix UX):
 *   TV    POST /api/device/code  → { device_code, user_code "ABCD-1234", … }
 *   phone /activate?code=ABCD1234 → approveDeviceCode / denyDeviceCode
 *   TV    POST /api/device/token { device_code } → session_token
 *
 * Everything that needs a DB lives in the route handlers / server actions;
 * this module is what `device-code.test.ts` covers.
 */

import { createHash, randomBytes, randomInt } from "node:crypto";

/** Human-friendly alphabet: no 0/O, no 1/I. 32 symbols → 8 chars = 40 bits. */
export const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const USER_CODE_LENGTH = 8;
/** Lifetime of a pending code (seconds). */
export const DEVICE_CODE_TTL_SEC = 900;
/** Minimum polling interval the TV must respect (seconds). */
export const DEVICE_CODE_POLL_INTERVAL_SEC = 5;

export type DeviceCodeStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

export function generateUserCode(): string {
    let out = "";
    for (let i = 0; i < USER_CODE_LENGTH; i++) {
        out += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
    }
    return out;
}

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

/** Opaque 32-byte device_code (base64url) that the TV polls with. */
export function generateDeviceCode(): string {
    return randomBytes(32).toString("base64url");
}

export function hashDeviceCode(deviceCode: string): string {
    return createHash("sha256").update(deviceCode, "utf8").digest("hex");
}

// ─── State machine ───────────────────────────────────────────────────────────

export interface DeviceCodeRowLike {
    status: DeviceCodeStatus | string;
    expiresAt: Date;
    lastPolledAt: Date | null;
}

/** Effective status once expiry is taken into account. */
export function effectiveStatus(row: DeviceCodeRowLike, now = new Date()): DeviceCodeStatus {
    if (row.status === "pending" && row.expiresAt.getTime() <= now.getTime()) return "expired";
    return row.status as DeviceCodeStatus;
}

/** Can a user still approve/deny this code? */
export function canDecide(row: DeviceCodeRowLike, now = new Date()): boolean {
    return effectiveStatus(row, now) === "pending";
}

export type TokenPollOutcome =
    | { kind: "authorization_pending"; httpStatus: 428 }
    | { kind: "slow_down"; httpStatus: 403 }
    | { kind: "access_denied"; httpStatus: 403 }
    | { kind: "expired_token"; httpStatus: 410 }
    | { kind: "approved"; httpStatus: 200 };

/**
 * Decide the response to POST /api/device/token for a row.
 * `slow_down` wins when the previous poll was < interval-1s ago (tolerates
 * client-side jitter), regardless of status, except for terminal states
 * that should be reported at once (denied / expired / consumed).
 */
export function evaluateTokenPoll(
    row: DeviceCodeRowLike,
    now = new Date(),
    intervalSec = DEVICE_CODE_POLL_INTERVAL_SEC,
): TokenPollOutcome {
    const status = effectiveStatus(row, now);
    if (status === "expired" || status === "consumed") return { kind: "expired_token", httpStatus: 410 };
    if (status === "denied") return { kind: "access_denied", httpStatus: 403 };
    if (row.lastPolledAt) {
        const elapsedMs = now.getTime() - row.lastPolledAt.getTime();
        if (elapsedMs < (intervalSec - 1) * 1000) return { kind: "slow_down", httpStatus: 403 };
    }
    if (status === "approved") return { kind: "approved", httpStatus: 200 };
    return { kind: "authorization_pending", httpStatus: 428 };
}
