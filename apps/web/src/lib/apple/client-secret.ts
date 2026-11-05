import { createPrivateKey, sign } from "node:crypto";

/**
 * Sign in with Apple "client secret": an ES256 JWT signed with the team's SIWA key (.p8).
 * Apple caps its lifetime at 6 months (15 777 000 s). Synchronous (node:crypto) so the
 * Auth.js provider config can build it at module init; `scripts/apple-client-secret.mjs`
 * produces the same token for an `AUTH_APPLE_SECRET` env value.
 */
export const APPLE_SECRET_MAX_TTL_SEC = 15_777_000;

export interface AppleClientSecretInput {
    teamId: string;
    keyId: string;
    /** Services ID (web) or bundle id (native) — must match the `client_id` the token is used with. */
    clientId: string;
    /** PEM (PKCS#8) contents of the .p8 file; literal `\n` sequences are accepted. */
    privateKey: string;
    ttlSec?: number;
    nowSec?: number;
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

export function normalizePem(pem: string): string {
    return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

/** Compact ES256 JWS (raw r||s signature as JOSE requires, not DER). */
export function signEs256Jwt(keyId: string, payload: Record<string, unknown>, privateKeyPem: string): string {
    const header = { alg: "ES256", kid: keyId, typ: "JWT" };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const key = createPrivateKey(normalizePem(privateKeyPem));
    const sig = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
    return `${signingInput}.${b64url(sig)}`;
}

export function makeAppleClientSecret(input: AppleClientSecretInput): string {
    const ttl = Math.min(input.ttlSec ?? APPLE_SECRET_MAX_TTL_SEC, APPLE_SECRET_MAX_TTL_SEC);
    const iat = input.nowSec ?? Math.floor(Date.now() / 1000);
    const payload = { iss: input.teamId, iat, exp: iat + ttl, aud: "https://appleid.apple.com", sub: input.clientId };
    return signEs256Jwt(input.keyId, payload, input.privateKey);
}
