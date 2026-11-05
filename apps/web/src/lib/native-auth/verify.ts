import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/**
 * ID-token verification for native sign-in (WP16-51): Sign in with Apple on iOS and
 * Google (Credential Manager) on Android. Both are OIDC JWTs signed with the issuer's
 * rotating keys; `createRemoteJWKSet` caches the JWKS and refetches on an unknown `kid`.
 */

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

let appleJwks: JWTVerifyGetKey | null = null;
let googleJwks: JWTVerifyGetKey | null = null;
const appleKeys = () => (appleJwks ??= createRemoteJWKSet(new URL(APPLE_JWKS_URL), { timeoutDuration: 5000 }));
const googleKeys = () => (googleJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), { timeoutDuration: 5000 }));

export interface VerifiedIdentity {
    provider: "apple" | "google";
    sub: string;
    email: string | null;
    emailVerified: boolean;
    name: string | null;
    picture: string | null;
}

export class IdTokenError extends Error {
    constructor(public readonly code: "invalid_token" | "nonce_mismatch" | "misconfigured") {
        super(code);
    }
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** Apple sends `email_verified` as boolean or as the string "true". */
const truthy = (v: unknown) => v === true || v === "true";

export function splitList(v: string | undefined): string[] {
    return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Apple identity token. The iOS app passes `SHA256(rawNonce)` to ASAuthorizationAppleIDRequest
 * and sends the RAW nonce here; the token carries the hashed one.
 */
export async function verifyAppleIdentityToken(
    identityToken: string,
    opts: { audiences: string[]; rawNonce: string; keys?: JWTVerifyGetKey },
): Promise<VerifiedIdentity> {
    if (opts.audiences.length === 0) throw new IdTokenError("misconfigured");
    let payload: JWTPayload;
    try {
        ({ payload } = await jwtVerify(identityToken, opts.keys ?? appleKeys(), {
            issuer: APPLE_ISSUER,
            audience: opts.audiences,
            algorithms: ["RS256"],
            clockTolerance: 60,
        }));
    } catch {
        throw new IdTokenError("invalid_token");
    }
    const nonce = typeof payload.nonce === "string" ? payload.nonce : "";
    // Accept the hashed form (recommended flow) or a raw nonce echoed verbatim (older SDKs).
    if (!nonce || (nonce !== sha256Hex(opts.rawNonce) && nonce !== opts.rawNonce)) {
        throw new IdTokenError("nonce_mismatch");
    }
    if (!payload.sub) throw new IdTokenError("invalid_token");
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
    return { provider: "apple", sub: payload.sub, email, emailVerified: truthy(payload.email_verified), name: null, picture: null };
}

/** Google ID token from Credential Manager (aud = the web client id the app requested it for). */
export async function verifyGoogleIdToken(
    idToken: string,
    opts: { audiences: string[]; nonce?: string; keys?: JWTVerifyGetKey },
): Promise<VerifiedIdentity> {
    if (opts.audiences.length === 0) throw new IdTokenError("misconfigured");
    let payload: JWTPayload;
    try {
        ({ payload } = await jwtVerify(idToken, opts.keys ?? googleKeys(), {
            issuer: GOOGLE_ISSUERS,
            audience: opts.audiences,
            algorithms: ["RS256"],
            clockTolerance: 60,
        }));
    } catch {
        throw new IdTokenError("invalid_token");
    }
    if (opts.nonce && payload.nonce !== opts.nonce) throw new IdTokenError("nonce_mismatch");
    if (!payload.sub) throw new IdTokenError("invalid_token");
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
    return {
        provider: "google",
        sub: payload.sub,
        email,
        emailVerified: truthy(payload.email_verified),
        name: typeof payload.name === "string" ? payload.name : null,
        picture: typeof payload.picture === "string" ? payload.picture : null,
    };
}

/** Audiences accepted for native Apple tokens: the app bundle id (+ Services ID for web-view flows). */
export function appleAudiences(): string[] {
    const list = splitList(process.env.APPLE_NATIVE_AUDIENCES);
    return list.length ? list : ["ro.mixai.app"];
}

/** Audiences accepted for native Google tokens: the web client id + any Android client ids. */
export function googleAudiences(): string[] {
    return [...new Set([...splitList(process.env.AUTH_GOOGLE_ID), ...splitList(process.env.GOOGLE_NATIVE_CLIENT_IDS)])];
}
