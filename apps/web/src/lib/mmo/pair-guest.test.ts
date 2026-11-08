import { describe, expect, it } from "vitest";
import { PairError, fetchPairInfo, formatPairCode, pollPair, requestPair } from "./pair-guest";

function fake(routes: Record<string, { status: number; body?: unknown } | Error>) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const key = Object.keys(routes).find((k) => url.includes(k));
        const r = key ? routes[key] : { status: 404 };
        if (r instanceof Error) throw r;
        return new Response(r?.body === undefined ? "" : JSON.stringify(r.body), { status: r?.status ?? 404 });
    }) as unknown as typeof fetch;
    return { f, calls };
}

describe("pair-guest", () => {
    it("reads /pair/info and rejects non-MMO servers", async () => {
        const ok = fake({ "/pair/info": { status: 200, body: { name: "demo", version: "3.13.0", pairingSupported: true, hasToken: true } } });
        await expect(fetchPairInfo("https://demo.mixai.ro", ok.f)).resolves.toMatchObject({ name: "demo", hasToken: true });
        const nope = fake({ "/pair/info": { status: 200, body: { hello: 1 } } });
        await expect(fetchPairInfo("https://x.ro", nope.f)).rejects.toMatchObject({ kind: "not-mmo" });
        const down = fake({ "/pair/info": new TypeError("Failed to fetch") });
        await expect(fetchPairInfo("https://x.ro", down.f)).rejects.toBeInstanceOf(PairError);
    });

    it("requests a code as platform web and maps 503 to no-token", async () => {
        const ok = fake({ "/pair/request": { status: 201, body: { code: "123456", secret: "s", expiresAt: 9, qr: "mixai://pair?x", approveUrl: "https://mixai.ro/pair?x" } } });
        const r = await requestPair("https://d.ro", "Chrome on macOS", ok.f);
        expect(r).toEqual({ code: "123456", secret: "s", expiresAt: 9, qr: "mixai://pair?x", approveUrl: "https://mixai.ro/pair?x" });
        expect(JSON.parse(String(ok.calls[0]?.init?.body))).toEqual({ deviceName: "Chrome on macOS", platform: "web" });
        const off = fake({ "/pair/request": { status: 503, body: { error: "x" } } });
        await expect(requestPair("https://d.ro", "n", off.f)).rejects.toMatchObject({ kind: "no-token" });
    });

    it("polls pending → approved, and treats unknown codes as expired", async () => {
        expect(await pollPair("https://d.ro", "1", "s", fake({ "/pair/poll": { status: 200, body: { status: "pending" } } }).f)).toEqual({ status: "pending" });
        expect(await pollPair("https://d.ro", "1", "s", fake({ "/pair/poll": { status: 200, body: { status: "approved", deviceToken: "t", userId: "u" } } }).f))
            .toEqual({ status: "approved", deviceToken: "t", userId: "u" });
        expect(await pollPair("https://d.ro", "1", "s", fake({ "/pair/poll": { status: 200, body: { status: "approved" } } }).f)).toEqual({ status: "pending" });
        expect(await pollPair("https://d.ro", "1", "s", fake({ "/pair/poll": { status: 200, body: { status: "expired" } } }).f)).toEqual({ status: "expired" });
    });

    it("formats 6-digit codes", () => {
        expect(formatPairCode("388726")).toBe("388 726");
        expect(formatPairCode("AB12")).toBe("AB12");
    });
});
