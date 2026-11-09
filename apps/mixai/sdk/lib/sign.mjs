// Ed25519 pack signing / verification, byte-compatible with pack.rs (canonical_digest).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";

export const SIGNATURE_FILE = "signature.json";

/** keyId -> base64 public key. Must mirror OFFICIAL_KEYS / VERIFIED_KEYS in pack.rs. */
export const OFFICIAL_KEYS = Object.freeze({
    "mixai-official-2026": Buffer.from(
        "daaf392eb3c69fb863d832b5ba4eb9c6c324beed98d6ad7741c0816440f7f574",
        "hex",
    ).toString("base64"),
});
export const VERIFIED_KEYS = Object.freeze({});

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const sha256 = (b) => createHash("sha256").update(b).digest();

/** SHA-256 over `<name>\n<sha256 hex>\n` for every file except signature.json, sorted by name bytes. */
export function canonicalDigest(files) {
    const names = [...files.keys()]
        .filter((n) => n !== SIGNATURE_FILE)
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const h = createHash("sha256");
    for (const n of names) {
        h.update(Buffer.from(n, "utf8"));
        h.update("\n");
        h.update(sha256(files.get(n)).toString("hex"));
        h.update("\n");
    }
    return h.digest();
}

export function privateKeyFromSeed(seed) {
    if (seed.length !== 32) throw new Error("signing key must be a 32-byte Ed25519 seed");
    return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}

export function publicKeyFromRaw(raw) {
    if (raw.length !== 32) throw new Error("public key must be 32 bytes");
    return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}

export function rawPublicKey(privateKey) {
    const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    return Buffer.from(der.subarray(der.length - 32));
}

/** Read a base64 seed file. The value is never logged or returned to callers outside this module. */
export function loadSeedFile(path) {
    const text = readFileSync(path, "utf8").trim();
    const seed = Buffer.from(text, "base64");
    if (seed.length !== 32) throw new Error(`key file ${path} must hold a base64 32-byte Ed25519 seed`);
    return seed;
}

export function generateTestSeed() {
    const { privateKey } = generateKeyPairSync("ed25519");
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    return Buffer.from(der.subarray(der.length - 32));
}

/**
 * Returns the signature.json bytes for `files` (signature.json itself is ignored).
 * @param {Map<string, Buffer>} files
 * @param {Buffer} seed 32-byte seed
 */
export function signatureFor(files, seed, keyId, { embedPubkey = true } = {}) {
    if (!keyId || typeof keyId !== "string") throw new Error("--key-id is required to sign");
    const key = privateKeyFromSeed(seed);
    const digest = canonicalDigest(files);
    const sig = sign(null, digest, key);
    const body = { alg: "ed25519", keyId, sig: sig.toString("base64") };
    if (embedPubkey) body.pubkey = rawPublicKey(key).toString("base64");
    return Buffer.from(JSON.stringify(body, null, 2) + "\n", "utf8");
}

/**
 * Same decision table as pack.rs verify_signature. Returns trust or throws.
 * @param {Map<string, Buffer>} files
 */
export function verifyFiles(files, keys = { official: OFFICIAL_KEYS, verified: VERIFIED_KEYS }) {
    const raw = files.get(SIGNATURE_FILE);
    if (!raw) return "unsigned";
    let s;
    try {
        s = JSON.parse(raw.toString("utf8"));
    } catch (e) {
        throw new Error(`signature.json is malformed: ${e.message}`);
    }
    if (!s || typeof s !== "object" || typeof s.alg !== "string" || typeof s.keyId !== "string" || typeof s.sig !== "string") {
        throw new Error("signature.json is malformed: alg, keyId and sig are required strings");
    }
    if (s.alg !== "ed25519") throw new Error(`unsupported signature algorithm '${s.alg.slice(0, 80)}'`);
    let pub;
    let trust;
    if (Object.hasOwn(keys.official, s.keyId)) {
        pub = Buffer.from(keys.official[s.keyId], "base64");
        trust = "official";
    } else if (Object.hasOwn(keys.verified, s.keyId)) {
        pub = Buffer.from(keys.verified[s.keyId], "base64");
        trust = "verified";
    } else if (typeof s.pubkey === "string") {
        pub = Buffer.from(s.pubkey.trim(), "base64");
        if (pub.length !== 32) throw new Error("signature.json: pubkey must be 32 bytes");
        trust = "community";
    } else {
        throw new Error(`unknown signing key '${s.keyId.slice(0, 80)}' and no embedded public key`);
    }
    const sig = Buffer.from(s.sig.trim(), "base64");
    if (sig.length !== 64) throw new Error("signature.json: sig must be 64 bytes");
    const ok = verify(null, canonicalDigest(files), publicKeyFromRaw(pub), sig);
    if (!ok) throw new Error("pack signature is invalid (modified after signing?)");
    return trust;
}

export function sha256Hex(buf) {
    return sha256(buf).toString("hex");
}
