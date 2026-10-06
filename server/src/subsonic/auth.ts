/**
 * Subsonic authentication (ADR-0005).
 *
 *   (a) apiKey=<deviceToken>                       OpenSubsonic apiKeyAuthentication
 *   (b) u + t + s   where t = md5(password + s)    Subsonic ≥1.13 token auth
 *   (c) u + p       plain or `enc:<hex>`           legacy
 *
 * The "password" is the device token. Username is informational (any
 * value) — the device token is the single secret. All comparisons are
 * constant-time.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { ERR, SubsonicError } from "./response";

export interface AuthParams {
    u?: string; p?: string; t?: string; s?: string; apiKey?: string;
}

export function md5Hex(s: string): string {
    return createHash("md5").update(s, "utf8").digest("hex");
}

export function subsonicToken(password: string, salt: string): string {
    return md5Hex(password + salt);
}

export function decodePassword(p: string): string {
    if (p.startsWith("enc:")) {
        const hex = p.slice(4);
        if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return "";
        return Buffer.from(hex, "hex").toString("utf8");
    }
    return p;
}

function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}

/**
 * Returns the effective username on success; throws SubsonicError otherwise.
 * `secret` is the stored device token (empty ⇒ nothing can authenticate).
 */
export function authenticate(params: AuthParams, secret: string): string {
    const { u, p, t, s, apiKey } = params;
    if (apiKey !== undefined) {
        if (u !== undefined) throw new SubsonicError(ERR.MULTIPLE_AUTH_MECHANISMS, "Multiple conflicting authentication mechanisms provided");
        if (!secret || !safeEqual(apiKey, secret)) throw new SubsonicError(ERR.INVALID_API_KEY, "Invalid API key");
        return "mmo";
    }
    if (u === undefined) throw new SubsonicError(ERR.MISSING_PARAM, "Required parameter is missing: u or apiKey");
    if (!secret) throw new SubsonicError(ERR.WRONG_CREDENTIALS, "Wrong username or password");
    if (t !== undefined || s !== undefined) {
        if (t === undefined || s === undefined) throw new SubsonicError(ERR.MISSING_PARAM, "Required parameter is missing: t and s");
        if (p !== undefined) throw new SubsonicError(ERR.MULTIPLE_AUTH_MECHANISMS, "Multiple conflicting authentication mechanisms provided");
        if (!safeEqual(t.toLowerCase(), subsonicToken(secret, s))) throw new SubsonicError(ERR.WRONG_CREDENTIALS, "Wrong username or password");
        return u;
    }
    if (p !== undefined) {
        if (!safeEqual(decodePassword(p), secret)) throw new SubsonicError(ERR.WRONG_CREDENTIALS, "Wrong username or password");
        return u;
    }
    throw new SubsonicError(ERR.MISSING_PARAM, "Required parameter is missing: p or t+s");
}
