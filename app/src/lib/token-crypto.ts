/**
 * AES-GCM token encryption for OAuth refresh/access tokens at rest.
 *
 * Key source: env var `AUTH_TOKEN_ENC_KEY` (base64-encoded 32 bytes).
 * Falls back to a session-only random key in dev so the server still
 * boots, but tokens encrypted with that fallback are unreadable across
 * restarts — set the env var in any environment that persists tokens.
 *
 * Output format: `v1:<base64 iv>:<base64 ciphertext>` so we can
 * version the scheme cleanly later.
 */

import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;
const SCHEME = "v1";

let _key: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
    if (_key) return _key;
    const raw = process.env.AUTH_TOKEN_ENC_KEY;
    let bytes: Uint8Array;
    if (raw) {
        try {
            bytes = Uint8Array.from(Buffer.from(raw, "base64"));
            if (bytes.length !== 32) throw new Error(`expected 32 bytes, got ${bytes.length}`);
        } catch (e) {
            throw new Error(`AUTH_TOKEN_ENC_KEY invalid: ${e instanceof Error ? e.message : String(e)}`);
        }
    } else {
        // Dev fallback — random per-process key. Encrypted tokens
        // become unrecoverable on restart; sufficient for `pnpm dev`.
        bytes = webcrypto.getRandomValues(new Uint8Array(32));
        if (process.env.NODE_ENV !== "test") {
            console.warn("[token-crypto] AUTH_TOKEN_ENC_KEY not set; using ephemeral key (dev only).");
        }
    }
    _key = await subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return _key;
}

export async function encryptToken(plaintext: string): Promise<string> {
    const key = await getKey();
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
    return `${SCHEME}:${Buffer.from(iv).toString("base64")}:${Buffer.from(ct).toString("base64")}`;
}

export async function decryptToken(envelope: string): Promise<string> {
    const [scheme, ivB64, ctB64] = envelope.split(":");
    if (scheme !== SCHEME) throw new Error(`unknown scheme: ${scheme}`);
    const key = await getKey();
    const iv = Uint8Array.from(Buffer.from(ivB64, "base64"));
    const ct = Uint8Array.from(Buffer.from(ctB64, "base64"));
    const pt = await subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
}
