/**
 * Device bearer-token at-rest crypto — ported verbatim from
 * apps/web/src/lib/device-token.ts (minus the Next `server-only` import).
 *
 * MUST stay algorithm-compatible with the web app: same HKDF info strings,
 * same HMAC lookup, same AES-256-GCM envelope, same AUTH_SECRET. Tokens
 * issued by either side resolve on both.
 */

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { devices } from "../db/schema.js";

const SECRET = process.env.AUTH_SECRET;

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
    const nonce = Buffer.from(parts[1]!, "base64url");
    const ctTag = Buffer.from(parts[2]!, "base64url");
    if (nonce.length !== 12 || ctTag.length < 17) {
        throw new Error("Malformed token envelope");
    }
    const ct = ctTag.subarray(0, ctTag.length - 16);
    const tag = ctTag.subarray(ctTag.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", keys().enc, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Resolve an incoming bearer to its device row via the indexed HMAC column. */
export async function findDeviceByToken(plaintext: string) {
    const hash = hashDeviceToken(plaintext);
    const byHash = await db.select().from(devices)
        .where(eq(devices.tokenHash, hash)).limit(1);
    return byHash[0] ?? null;
}

interface MinTokenColumns {
    id: string;
    tokenEncrypted: string | null;
}

/** Return the plaintext bearer for forwarding to a companion. */
export async function materializeDeviceToken(row: MinTokenColumns): Promise<string | null> {
    if (!row.tokenEncrypted) return null;
    try { return decryptDeviceToken(row.tokenEncrypted); }
    catch { return null; }
}
