import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PushTokenRow } from "@/db/schema";
import { makeAppleClientSecret } from "@/lib/apple/client-secret";
import { fanOut, registerBodySchema, relayBodySchema, toMessage } from "./relay";
import { buildApnsPayload, classifyApns, classifyFcm, createApnsSender, parseServiceAccount, type PushSender } from "./senders";
import { isUndefinedTable } from "./store";

vi.mock("@/db", () => ({ db: {} }));

const row = (id: string, platform: string, environment = "production"): PushTokenRow => ({
    id, userId: "u1", platform, token: `tok-${id}-${"x".repeat(40)}`, environment, deviceName: null, profileId: null,
    liveActivityToken: null, createdAt: new Date(), updatedAt: new Date(), lastUsedAt: null,
});

const validRelay = {
    event: "recording.done", eventId: "3f0c1d7e-8f7a-4c1b-9a8e-0b6a2c4d5e6f", serverId: "dev-1", at: 1762300000000,
    title: "Recording ready", body: "Știrile", deepLink: "mixai://livetv/recordings/7", data: { recordingId: "7" },
};

describe("relay body", () => {
    it("accepts the server README contract", () => {
        expect(relayBodySchema.safeParse(validRelay).success).toBe(true);
    });
    it("rejects unknown events, non-uuid ids and non-mixai deep links", () => {
        expect(relayBodySchema.safeParse({ ...validRelay, event: "spam" }).success).toBe(false);
        expect(relayBodySchema.safeParse({ ...validRelay, eventId: "1" }).success).toBe(false);
        expect(relayBodySchema.safeParse({ ...validRelay, deepLink: "https://evil.example" }).success).toBe(false);
    });
    it("maps to a push message with collapse id and string-able data", () => {
        const m = toMessage(relayBodySchema.parse(validRelay));
        expect(m.collapseId).toBe("recording.done:mixai://livetv/recordings/7");
        expect(m.data).toMatchObject({ recordingId: "7", event: "recording.done", serverId: "dev-1" });
    });
});

describe("register body", () => {
    it("validates platform and token charset", () => {
        expect(registerBodySchema.safeParse({ platform: "ios", token: "a".repeat(64) }).success).toBe(true);
        expect(registerBodySchema.safeParse({ platform: "web", token: "a".repeat(64) }).success).toBe(false);
        expect(registerBodySchema.safeParse({ platform: "android", token: "a b".repeat(20) }).success).toBe(false);
    });
});

describe("error classification", () => {
    it("FCM: UNREGISTERED and 404 are dead, 429/5xx retry", () => {
        expect(classifyFcm(200, "")).toBe("ok");
        expect(classifyFcm(404, '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}')).toBe("dead");
        expect(classifyFcm(400, '{"error":{"status":"INVALID_ARGUMENT","message":"The registration token is not a valid FCM registration token"}}')).toBe("dead");
        expect(classifyFcm(503, "")).toBe("retry");
        expect(classifyFcm(403, "SENDER_ID_MISMATCH")).toBe("error");
    });
    it("APNs: 410 / BadDeviceToken are dead", () => {
        expect(classifyApns(200, undefined)).toBe("ok");
        expect(classifyApns(410, "Unregistered")).toBe("dead");
        expect(classifyApns(400, "BadDeviceToken")).toBe("dead");
        expect(classifyApns(429, "TooManyRequests")).toBe("retry");
        expect(classifyApns(400, "PayloadTooLarge")).toBe("error");
    });
});

describe("fanOut", () => {
    it("routes by platform, collects dead tokens, skips unconfigured senders", async () => {
        const android: PushSender = { send: vi.fn(async (t: string) => (t.includes("a2") ? "dead" : "ok")) };
        const r = await fanOut([row("a1", "android"), row("a2", "android"), row("i1", "ios")], { title: "t", body: "b" }, { android, ios: null });
        expect(r).toMatchObject({ sent: 1, dead: ["a2"], skipped: 1, delivered: ["a1"] });
    });
    it("passes the sandbox flag for sandbox APNs tokens", async () => {
        const ios: PushSender = { send: vi.fn(async () => "ok" as const) };
        await fanOut([row("i1", "ios", "sandbox")], { title: "t", body: "b" }, { android: null, ios });
        expect(ios.send).toHaveBeenCalledWith(expect.any(String), expect.any(Object), { sandbox: true });
    });
});

describe("APNs sender", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    it("is disabled without key env", () => {
        expect(createApnsSender({} as NodeJS.ProcessEnv)).toBeNull();
    });
    it("posts to the sandbox host with topic + ES256 provider token and maps 410 to dead", async () => {
        const post = vi.fn(async () => ({ status: 410, body: '{"reason":"Unregistered"}' }));
        const sender = createApnsSender({ APNS_KEY_ID: "KEY123", APNS_PRIVATE_KEY: pem } as unknown as NodeJS.ProcessEnv, post, () => 1_762_300_000);
        expect(sender).not.toBeNull();
        const out = await sender!.send("abcd", { title: "T", body: "B", deepLink: "mixai://x" }, { sandbox: true });
        expect(out).toBe("dead");
        const [origin, path, headers, body] = post.mock.calls[0] as unknown as [string, string, Record<string, string>, string];
        expect(origin).toBe("https://api.sandbox.push.apple.com");
        expect(path).toBe("/3/device/abcd");
        expect(headers["apns-topic"]).toBe("ro.mixai.app");
        const jwt = headers.authorization.replace(/^bearer /, "");
        const [h, p, s] = jwt.split(".");
        expect(JSON.parse(Buffer.from(h, "base64url").toString())).toMatchObject({ alg: "ES256", kid: "KEY123" });
        expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ iss: "S6D533QSV2", iat: 1_762_300_000 });
        const ok = verify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey(pem), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
        expect(ok).toBe(true);
        expect(JSON.parse(body)).toMatchObject({ aps: { alert: { title: "T", body: "B" } }, deepLink: "mixai://x" });
    });
    it("payload carries flat data", () => {
        expect(JSON.parse(buildApnsPayload({ title: "a", body: "b", data: { n: 1, z: null } }))).toMatchObject({ n: "1" });
    });
});

describe("Apple client secret", () => {
    it("is a verifiable ES256 JWT capped at 6 months", () => {
        const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
        const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\\n");
        const jwt = makeAppleClientSecret({ teamId: "S6D533QSV2", keyId: "K1", clientId: "ro.mixai.web", privateKey: pem, ttlSec: 10 ** 9, nowSec: 1000 });
        const [h, p, s] = jwt.split(".");
        const claims = JSON.parse(Buffer.from(p, "base64url").toString());
        expect(claims).toEqual({ iss: "S6D533QSV2", iat: 1000, exp: 1000 + 15_777_000, aud: "https://appleid.apple.com", sub: "ro.mixai.web" });
        expect(verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))).toBe(true);
    });
});

describe("helpers", () => {
    it("parses service-account JSON raw or base64", () => {
        const sa = { client_email: "a@b", private_key: "k", project_id: "p" };
        expect(parseServiceAccount(JSON.stringify(sa))).toEqual(sa);
        expect(parseServiceAccount(Buffer.from(JSON.stringify(sa)).toString("base64"))).toEqual(sa);
        expect(parseServiceAccount("nope")).toBeNull();
        expect(parseServiceAccount(undefined)).toBeNull();
    });
    it("detects a missing push table (migration pending)", () => {
        expect(isUndefinedTable({ code: "42P01" })).toBe(true);
        expect(isUndefinedTable(new Error("x", { cause: { code: "42P01" } }))).toBe(true);
        expect(isUndefinedTable({ message: 'relation "push_tokens" does not exist' })).toBe(true);
        expect(isUndefinedTable({ code: "23505" })).toBe(false);
    });
});
