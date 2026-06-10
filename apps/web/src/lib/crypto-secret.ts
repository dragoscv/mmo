/**
 * Server-side AES-256-GCM helper for sensitive at-rest values.
 *
 * Used for BYO API keys (OpenAI / Anthropic / etc.) so the user's keys
 * never sit in the database in plaintext. The master key comes from the
 * `MMO_SECRET_KEY` env var (32 random bytes, base64 or hex). On a
 * deployment without it set, the helpers refuse to run rather than
 * silently store plaintext — that prevents an admin error from making
 * keys recoverable from a stolen DB dump.
 *
 * Format on disk:  v1:<iv-base64>:<ciphertext-base64>:<tag-base64>
 *
 * GCM gives authenticated encryption — `decrypt()` throws if the
 * ciphertext was tampered with, which means the cipher metadata can be
 * stored alongside the value safely.
 */

import "server-only";
import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12; // GCM standard
const VERSION_TAG = "v1";

function loadKey(): Buffer {
    const raw = process.env.MMO_SECRET_KEY;
    if (!raw) {
        throw new Error(
            "MMO_SECRET_KEY is not set. Generate one with `openssl rand -base64 32` and add it to .env.local — required for storing user-supplied API keys.",
        );
    }
    // Accept base64 (preferred) or hex.
    const buf = /^[a-fA-F0-9]+$/.test(raw) && raw.length === KEY_LEN * 2
        ? Buffer.from(raw, "hex")
        : Buffer.from(raw, "base64");
    if (buf.length !== KEY_LEN) {
        throw new Error(`MMO_SECRET_KEY must decode to ${KEY_LEN} bytes; got ${buf.length}.`);
    }
    return buf;
}

export function encryptSecret(plaintext: string): string {
    const key = loadKey();
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION_TAG}:${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
}

export function decryptSecret(blob: string): string {
    const parts = blob.split(":");
    if (parts.length !== 4 || parts[0] !== VERSION_TAG) {
        throw new Error("Malformed ciphertext (expected v1:iv:ct:tag).");
    }
    const key = loadKey();
    const iv = Buffer.from(parts[1], "base64");
    const ct = Buffer.from(parts[2], "base64");
    const tag = Buffer.from(parts[3], "base64");
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Display helper — returns `sk-…cdef` for showing the user which key is set. */
export function maskSecret(plaintext: string, visible = 4): string {
    if (!plaintext) return "";
    if (plaintext.length <= visible * 2) return "•".repeat(plaintext.length);
    return `${plaintext.slice(0, visible)}…${plaintext.slice(-visible)}`;
}
