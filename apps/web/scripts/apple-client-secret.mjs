#!/usr/bin/env node
/**
 * Build the Sign in with Apple client secret (ES256 JWT, max 6 months) from a .p8 key.
 *
 *   node scripts/apple-client-secret.mjs --key D:\Downloads\AuthKey_XXXX.p8 --key-id XXXX \
 *        [--team S6D533QSV2] [--client-id ro.mixai.web] [--days 180] [--out file]
 *
 * Prints the JWT to stdout (or writes it to --out, e.g. a temp file for
 * `gcloud secrets versions add mixai-web-auth-apple-secret --data-file`). The web app does not
 * need it when APPLE_KEY_ID + APPLE_PRIVATE_KEY are deployed (it mints the JWT at boot);
 * use it for AUTH_APPLE_SECRET-only setups. Never paste the output into chat or commits.
 */
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const MAX_TTL = 15_777_000; // Apple's documented maximum (~6 months)
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);

const keyPath = args.get("key");
const keyId = args.get("key-id");
const teamId = args.get("team") ?? "S6D533QSV2";
const clientId = args.get("client-id") ?? "ro.mixai.web";
const days = Number(args.get("days") ?? 180);
if (!keyPath || !keyId) {
    console.error("usage: apple-client-secret.mjs --key <AuthKey.p8> --key-id <KEYID> [--team] [--client-id] [--days] [--out]");
    process.exit(2);
}
const ttl = Math.min(Math.round(days * 86400), MAX_TTL);
const iat = Math.floor(Date.now() / 1000);
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const input = `${b64({ alg: "ES256", kid: keyId, typ: "JWT" })}.${b64({ iss: teamId, iat, exp: iat + ttl, aud: "https://appleid.apple.com", sub: clientId })}`;
const sig = sign("sha256", Buffer.from(input), { key: createPrivateKey(readFileSync(keyPath, "utf8")), dsaEncoding: "ieee-p1363" });
const jwt = `${input}.${sig.toString("base64url")}`;
const out = args.get("out");
if (out) {
    writeFileSync(out, jwt);
    console.error(`wrote client secret for ${clientId} (expires ${new Date((iat + ttl) * 1000).toISOString()}) to ${out}`);
} else {
    process.stdout.write(jwt);
}
