/**
 * Device bearer-token at-rest crypto.
 *
 * Threat model: a read-only DB compromise (backup leak, replica access,
 * future SQLi elsewhere) must not yield a working bearer credential for
 * any companion. We split the storage in two:
 *
 *   - `tokenHash` (HMAC-SHA256 hex) is the **lookup** key. Used by
 *     inbound auth routes (heartbeat, validate, sync) to resolve a
 *     presented bearer to a device row in O(log n) without ever storing
 *     the plaintext-equality column. The HMAC key is derived from
 *     AUTH_SECRET (env var, not in the DB).
 *
 *   - `tokenEncrypted` ("v1:b64(nonce):b64(ciphertext+tag)") is the
 *     **retrieval** envelope. AES-256-GCM with a fresh 12-byte nonce per
 *     row. The web server decrypts when it needs to forward the bearer to
 *     a companion (`X-Device-Token` header). Key is derived from
 *     AUTH_SECRET via a separate HKDF info string so it can never collide
 *     with the HMAC key.
 *
 * Without AUTH_SECRET an attacker holding a full row dump cannot recover
 * either lookup capability or the plaintext bearer.
 *
 * Migration history: 0006 added the new columns and lazy-backfilled
 * legacy plaintext rows on first use; 0007 dropped the plaintext column
 * once the backfill window had elapsed. Operators upgrading from
 * pre-0006 must apply 0006 + bring up the new code BEFORE applying 0007
 * so existing rows have a chance to migrate.
 */

import "server-only";
import crypto from "node:crypto";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { eq } from "drizzle-orm";

const SECRET = process.env.AUTH_SECRET;

// Lazy-derived so that test runs / build steps that legitimately don't
// touch device tokens don't crash on import. The throw triggers the first
// time any caller actually needs HMAC or AES-GCM (production routes do).
let cachedKeys: { hmac: Buffer; enc: Buffer } | null = null;
function keys(): { hmac: Buffer; enc: Buffer } {
    if (cachedKeys) return cachedKeys;
    if (!SECRET || SECRET.length < 16) {
        throw new Error(
            "AUTH_SECRET is missing or too short (need >=16 chars). Refusing to operate on device tokens.",
        );
    }
    const hmac = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(SECRET, "utf8"), Buffer.alloc(0), Buffer.from("mmo:device-token:hmac:v1", "utf8"), 32));
    const enc = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(SECRET, "utf8"), Buffer.alloc(0), Buffer.from("mmo:device-token:aesgcm:v1", "utf8"), 32));
    cachedKeys = { hmac, enc };
    return cachedKeys;
}

// ─── Issuance ────────────────────────────────────────────────────────────

export interface IssuedDeviceToken {
    /** The plaintext bearer to return to the caller (companion). Never
     *  persisted in this shape — the caller stores it locally; the DB
     *  only retains hash + ciphertext. */
    plaintext: string;
    /** Insert into `devices.token_hash`. */
    hash: string;
    /** Insert into `devices.token_encrypted`. */
    encrypted: string;
}

/** Generate a fresh bearer + the two derived columns. The plaintext is
 *  64 chars of base64url-encoded entropy (~48 bytes / 384 bits). */
export function issueDeviceToken(): IssuedDeviceToken {
    const plaintext = crypto.randomBytes(48).toString("base64url");
    return {
        plaintext,
        hash: hashDeviceToken(plaintext),
        encrypted: encryptDeviceToken(plaintext),
    };
}

export function hashDeviceToken(plaintext: string): string {
    return crypto.createHmac("sha256", keys().hmac).update(plaintext, "utf8").digest("hex");
}

export function encryptDeviceToken(plaintext: string): string {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", keys().enc, nonce);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${nonce.toString("base64url")}:${Buffer.concat([ct, tag]).toString("base64url")}`;
}

export function decryptDeviceToken(blob: string): string {
    const parts = blob.split(":");
    if (parts.length !== 3 || parts[0] !== "v1") {
        throw new Error("Unsupported token envelope version");
    }
    const nonce = Buffer.from(parts[1], "base64url");
    const ctTag = Buffer.from(parts[2], "base64url");
    if (nonce.length !== 12 || ctTag.length < 17) {
        throw new Error("Malformed token envelope");
    }
    const ct = ctTag.subarray(0, ctTag.length - 16);
    const tag = ctTag.subarray(ctTag.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", keys().enc, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// ─── Lookup-by-bearer (inbound auth) ─────────────────────────────────────

/** Resolve an incoming bearer to its device row via the indexed HMAC
 *  column. Returns the row, or null if the token doesn't match.
 *
 *  The legacy plaintext-column fallback was removed alongside migration
 *  0007 (drop devices.token). Operators upgrading from a pre-0006 schema
 *  must run 0006 + bring up the new code before applying 0007 so the
 *  lazy backfill has time to migrate every row. */
export async function findDeviceByToken(plaintext: string) {
    const hash = hashDeviceToken(plaintext);
    const byHash = await db.select().from(devices)
        .where(eq(devices.tokenHash, hash)).limit(1);
    return byHash[0] ?? null;
}

// ─── Outbound use (web -> companion) ─────────────────────────────────────

interface MinTokenColumns {
    id: string;
    tokenEncrypted: string | null;
}

/** Return the plaintext bearer for forwarding to a companion. Decrypts
 *  the AES-GCM envelope. Returns null if the column is unset (row was
 *  inserted before 0006) or the envelope is corrupted. */
export async function materializeDeviceToken(row: MinTokenColumns): Promise<string | null> {
    if (!row.tokenEncrypted) return null;
    try { return decryptDeviceToken(row.tokenEncrypted); }
    catch { return null; }
}
