import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, findDeviceByToken, store } = vi.hoisted(() => ({
    auth: vi.fn(async () => null as null | { user: { id: string } }),
    findDeviceByToken: vi.fn(),
    store: {
        claimRelayEvent: vi.fn(),
        tokensForUser: vi.fn(),
        deleteTokensById: vi.fn(async () => {}),
        touchTokens: vi.fn(async () => {}),
        releaseRelayEvent: vi.fn(async () => {}),
        upsertPushToken: vi.fn(async () => {}),
        deletePushToken: vi.fn(async () => 1),
    },
}));
vi.mock("@/auth", () => ({ auth: () => auth() }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/device-token", () => ({ findDeviceByToken: (t: string) => findDeviceByToken(t) }));
vi.mock("@/lib/push-native/store", async () => {
    const actual = await vi.importActual<typeof import("@/lib/push-native/store")>("@/lib/push-native/store");
    return { ...actual, ...store };
});
vi.mock("@/lib/native-auth/session", async () => {
    const actual = await vi.importActual<typeof import("@/lib/native-auth/session")>("@/lib/native-auth/session");
    return { ...actual, resolveUserId: vi.fn(async (req: Request) => (req.headers.get("authorization") === "Bearer good-session-token-123" ? "u1" : null)) };
});

import { PushUnavailableError } from "@/lib/push-native/store";
import { POST as relay } from "./relay/route";
import { DELETE as unregister, POST as register } from "./register/route";

let ip = 0;
function req(url: string, body: unknown, headers: Record<string, string> = {}, method = "POST") {
    ip++;
    return new Request(`http://localhost${url}`, {
        method,
        headers: { "content-type": "application/json", "x-real-ip": `10.0.0.${ip}`, ...headers },
        body: JSON.stringify(body),
    }) as unknown as import("next/server").NextRequest;
}

const relayBody = {
    event: "download.ready", eventId: "3f0c1d7e-8f7a-4c1b-9a8e-0b6a2c4d5e6f", serverId: "dev-1", at: 1,
    title: "Ready", body: "Film", deepLink: "mixai://download/5",
};

beforeEach(() => {
    vi.clearAllMocks();
    findDeviceByToken.mockResolvedValue({ id: "dev-1", userId: "u1" });
    store.claimRelayEvent.mockResolvedValue(true);
    store.tokensForUser.mockResolvedValue([]);
});

describe("POST /api/push/relay", () => {
    it("401 without a device bearer", async () => {
        findDeviceByToken.mockResolvedValue(null);
        const res = await relay(req("/api/push/relay", relayBody));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
    });
    it("403 when serverId is not the authenticated device", async () => {
        const res = await relay(req("/api/push/relay", { ...relayBody, serverId: "other" }, { authorization: "Bearer devtok" }));
        expect(res.status).toBe(403);
    });
    it("400 on an invalid body", async () => {
        const res = await relay(req("/api/push/relay", { event: "x" }, { authorization: "Bearer devtok" }));
        expect(res.status).toBe(400);
    });
    it("202 duplicate on a replayed eventId", async () => {
        store.claimRelayEvent.mockResolvedValue(false);
        const res = await relay(req("/api/push/relay", relayBody, { authorization: "Bearer devtok" }));
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ duplicate: true });
    });
    it("503 push_unavailable while migration 0031 is pending", async () => {
        store.claimRelayEvent.mockRejectedValue(new PushUnavailableError());
        const res = await relay(req("/api/push/relay", relayBody, { authorization: "Bearer devtok" }));
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "push_unavailable" });
    });
    it("200 with zero tokens", async () => {
        const res = await relay(req("/api/push/relay", relayBody, { authorization: "Bearer devtok" }));
        expect(res.status).toBe(200);
        expect(store.tokensForUser).toHaveBeenCalledWith("u1", undefined);
    });
});

describe("/api/push/register", () => {
    const body = { platform: "android", token: "f".repeat(160), deviceName: "S25" };
    it("401 unauthenticated", async () => {
        const res = await register(req("/api/push/register", body));
        expect(res.status).toBe(401);
    });
    it("registers with a native session bearer", async () => {
        const res = await register(req("/api/push/register", body, { authorization: "Bearer good-session-token-123" }));
        expect(res.status).toBe(200);
        expect(store.upsertPushToken).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", platform: "android", environment: "production", deviceName: "S25" }));
    });
    it("503 when the table is missing", async () => {
        store.upsertPushToken.mockRejectedValueOnce(new PushUnavailableError());
        const res = await register(req("/api/push/register", body, { authorization: "Bearer good-session-token-123" }));
        expect(res.status).toBe(503);
    });
    it("DELETE removes the caller's token", async () => {
        const res = await unregister(req("/api/push/register", { token: body.token }, { authorization: "Bearer good-session-token-123" }, "DELETE"));
        expect(res.status).toBe(200);
        expect(store.deletePushToken).toHaveBeenCalledWith("u1", body.token);
    });
});
