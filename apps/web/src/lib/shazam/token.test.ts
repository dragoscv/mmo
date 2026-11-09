import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn(async () => null) }));

import { GET } from "@/app/api/shazam/token/route";

import {
    SHAZAM_TOKEN_TTL_SEC,
    __resetShazamTokenCache,
    currentShazamToken,
    makeShazamToken,
    shazamKeyConfig,
} from "./token";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const cfg = { teamId: "TEAM123456", keyId: "KEY1234567", privateKey: pem };

function decode(token: string) {
    const [h, p, s] = token.split(".");
    return {
        header: JSON.parse(Buffer.from(h!, "base64url").toString()),
        payload: JSON.parse(Buffer.from(p!, "base64url").toString()),
        ok: verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url")),
    };
}

let ip = 1;
function req(app?: string) {
    const headers: Record<string, string> = { "x-real-ip": `10.9.0.${ip++}` };
    if (app) headers["x-mixai-app"] = app;
    return new Request("http://localhost/api/shazam/token", { headers });
}

describe("shazam developer token", () => {
    beforeEach(() => __resetShazamTokenCache());

    it("signs an ES256 JWT with kid, iss and a 12 h expiry", () => {
        const t = makeShazamToken(cfg, 1_000);
        const d = decode(t.token);
        expect(d.ok).toBe(true);
        expect(d.header).toEqual({ alg: "ES256", kid: "KEY1234567", typ: "JWT" });
        expect(d.payload).toEqual({ iss: "TEAM123456", iat: 1_000, exp: 1_000 + SHAZAM_TOKEN_TTL_SEC });
        expect(t.expiresAt).toBe(1_000 + SHAZAM_TOKEN_TTL_SEC);
    });

    it("reuses the cached token until less than an hour is left", () => {
        const a = currentShazamToken(cfg, 0);
        expect(currentShazamToken(cfg, SHAZAM_TOKEN_TTL_SEC - 3_601).token).toBe(a.token);
        expect(currentShazamToken(cfg, SHAZAM_TOKEN_TTL_SEC - 3_599).token).not.toBe(a.token);
    });

    it("reads config from env and is off without a key", () => {
        expect(shazamKeyConfig({} as NodeJS.ProcessEnv)).toBeNull();
        expect(shazamKeyConfig({ SHAZAM_KEY_ID: "K", SHAZAM_PRIVATE_KEY: "P" } as unknown as NodeJS.ProcessEnv)?.teamId).toBe("S6D533QSV2");
    });
});

describe("GET /api/shazam/token", () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
        __resetShazamTokenCache();
    });

    it("rejects unknown apps", async () => {
        process.env.SHAZAM_KEY_ID = cfg.keyId;
        process.env.SHAZAM_PRIVATE_KEY = pem;
        const res = GET(req("curl"));
        expect(res.status).toBe(400);
        expect(GET(req()).status).toBe(400);
    });

    it("answers 503 when the key is not configured", async () => {
        delete process.env.SHAZAM_KEY_ID;
        delete process.env.SHAZAM_PRIVATE_KEY;
        const res = GET(req("keybpm-android"));
        expect(res.status).toBe(503);
    });

    it("returns a verifiable token, never cached by proxies", async () => {
        process.env.SHAZAM_KEY_ID = cfg.keyId;
        process.env.SHAZAM_PRIVATE_KEY = pem.replace(/\n/g, "\\n");
        const res = GET(req("keybpm-android"));
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const body = (await res.json()) as { token: string; expiresAt: number };
        expect(decode(body.token).ok).toBe(true);
        expect(body.expiresAt).toBeGreaterThan(Date.now() / 1000);
    });

    it("rate limits one IP to 30 per hour", () => {
        process.env.SHAZAM_KEY_ID = cfg.keyId;
        process.env.SHAZAM_PRIVATE_KEY = pem;
        const fixed = () => new Request("http://localhost/api/shazam/token", { headers: { "x-real-ip": "10.8.8.8", "x-mixai-app": "keybpm-android" } });
        for (let i = 0; i < 30; i++) expect(GET(fixed()).status).toBe(200);
        expect(GET(fixed()).status).toBe(429);
    });
});
