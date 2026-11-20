import { describe, it, expect, vi } from "vitest";
import { companionPair, matchCompanionByHost, PairError, urlHost, urlPort } from "./companion-pair";

const target = { apiUrl: "http://192.168.100.232:17899/", token: "tok-123" };

function mockFetch(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("companionPair.pending", () => {
    it("GETs /pair/pending with X-Device-Token and returns requests", async () => {
        const f = mockFetch(200, { requests: [{ code: "123456", deviceName: "Living TV", platform: "tizen", createdAt: "a", expiresAt: "b" }] });
        const r = await companionPair.pending(target, f);
        expect(r).toHaveLength(1);
        expect(r[0]!.code).toBe("123456");
        const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
        expect(url).toBe("http://192.168.100.232:17899/pair/pending");
        expect(init.method).toBe("GET");
        expect((init.headers as Record<string, string>)["X-Device-Token"]).toBe("tok-123");
    });
    it("returns [] when the companion omits requests", async () => {
        expect(await companionPair.pending(target, mockFetch(200, {}))).toEqual([]);
    });
    it("accepts the server's `pending` key as well", async () => {
        const r = await companionPair.pending(target, mockFetch(200, { pending: [{ code: "000001", deviceName: "TV", platform: "android-tv", createdAt: "a", expiresAt: "b" }] }));
        expect(r.map((x) => x.code)).toEqual(["000001"]);
    });
    it("maps 401 to unauthorized", async () => {
        await expect(companionPair.pending(target, mockFetch(401, { error: "bad token" })))
            .rejects.toMatchObject({ code: "unauthorized" });
    });
});

describe("companionPair.approve", () => {
    it("POSTs {code} to /pair/approve", async () => {
        const f = mockFetch(200, { ok: true });
        expect(await companionPair.approve(target, "654321", f)).toEqual({ ok: true });
        const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
        expect(url).toBe("http://192.168.100.232:17899/pair/approve");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({ code: "654321" });
    });
    it("rejects a malformed code locally without calling fetch", async () => {
        const f = mockFetch(200, { ok: true });
        await expect(companionPair.approve(target, "12", f)).rejects.toBeInstanceOf(PairError);
        expect(f).not.toHaveBeenCalled();
    });
    it("maps 404 → not_found, 410 → expired, 'expired' message → expired", async () => {
        await expect(companionPair.approve(target, "111111", mockFetch(404, {}))).rejects.toMatchObject({ code: "not_found" });
        await expect(companionPair.approve(target, "111111", mockFetch(410, {}))).rejects.toMatchObject({ code: "expired" });
        await expect(companionPair.approve(target, "111111", mockFetch(400, { error: "code expired" }))).rejects.toMatchObject({ code: "expired" });
    });
    it("maps network failure → unreachable", async () => {
        const f = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
        await expect(companionPair.approve(target, "111111", f)).rejects.toMatchObject({ code: "unreachable" });
    });
});

describe("companionPair.info", () => {
    it("GETs /pair/info without auth", async () => {
        const f = mockFetch(200, { name: "homepi", version: "1", lanUrl: "http://x:1", port: 1, pairingSupported: true, hasToken: true });
        const r = await companionPair.info("http://x:1", f);
        expect(r.name).toBe("homepi");
        const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit | undefined];
        expect(init?.headers).toBeUndefined();
    });
});

describe("url helpers", () => {
    it("extracts host and port", () => {
        expect(urlHost("http://192.168.1.5:17899")).toBe("192.168.1.5");
        expect(urlHost("https://device-abc.mixai.ro")).toBe("device-abc.mixai.ro");
        expect(urlPort("http://192.168.1.5:17899")).toBe(17899);
        expect(urlPort("https://device-abc.mixai.ro")).toBe(443);
        expect(urlHost("nope")).toBeNull();
    });
});

describe("matchCompanionByHost", () => {
    const a = { id: "a", lanUrl: "http://192.168.1.5:17899", apiUrl: "http://localhost:17899" };
    const b = { id: "b", lanUrl: "http://192.168.1.9:17899", apiUrl: null };
    const b2 = { id: "b2", lanUrl: "http://192.168.1.9:18000", apiUrl: null };

    it("matches by lanUrl host", () => {
        expect(matchCompanionByHost([a, b], "192.168.1.9")?.id).toBe("b");
    });
    it("matches by apiUrl host, case-insensitively", () => {
        expect(matchCompanionByHost([a, b], "LOCALHOST")?.id).toBe("a");
    });
    it("uses port as tiebreaker when several share a host", () => {
        expect(matchCompanionByHost([a, b, b2], "192.168.1.9", 18000)?.id).toBe("b2");
        expect(matchCompanionByHost([a, b, b2], "192.168.1.9", 17899)?.id).toBe("b");
    });
    it("falls back to the single companion when nothing matches", () => {
        expect(matchCompanionByHost([a], "10.0.0.1")?.id).toBe("a");
    });
    it("returns null with several companions and no host match", () => {
        expect(matchCompanionByHost([a, b], "10.0.0.1")).toBeNull();
    });
});
