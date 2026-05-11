import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type IceMod = typeof import("./ice-servers");

async function freshImport(): Promise<IceMod> {
    vi.resetModules();
    return await import("./ice-servers");
}

const setBrowserGlobals = () => {
    // ice-servers checks `typeof window === "undefined"` to early-return STUN.
    (globalThis as unknown as { window: object }).window = {};
};

const clearBrowserGlobals = () => {
    delete (globalThis as unknown as { window?: object }).window;
};

describe("fetchIceServers", () => {
    beforeEach(() => {
        setBrowserGlobals();
    });
    afterEach(() => {
        clearBrowserGlobals();
        vi.restoreAllMocks();
    });

    it("returns STUN-only fallback when not in a browser", async () => {
        clearBrowserGlobals();
        const { fetchIceServers } = await freshImport();
        const ice = await fetchIceServers();
        expect(ice.some((s) => String(s.urls).includes("stun.l.google.com"))).toBe(true);
    });

    it("returns servers from /api/turn-credentials", async () => {
        const fakeIce: RTCIceServer[] = [{ urls: "turn:turn.example:3478", username: "u", credential: "c" }];
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ iceServers: fakeIce, ttl: 3600, mode: "turn" }),
        });
        (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

        const { fetchIceServers } = await freshImport();
        const ice = await fetchIceServers();
        expect(fetchMock).toHaveBeenCalledWith("/api/turn-credentials", { credentials: "same-origin" });
        expect(ice).toEqual(fakeIce);
    });

    it("falls back to STUN when /api/turn-credentials errors", async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
        (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
        // silence the warn
        vi.spyOn(console, "warn").mockImplementation(() => { });

        const { fetchIceServers } = await freshImport();
        const ice = await fetchIceServers();
        expect(ice.some((s) => String(s.urls).includes("stun"))).toBe(true);
    });

    it("dedupes concurrent in-flight requests", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ iceServers: [{ urls: "stun:x" }], ttl: 3600, mode: "stun-only" }),
        });
        (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

        const { fetchIceServers } = await freshImport();
        const [a, b, c] = await Promise.all([fetchIceServers(), fetchIceServers(), fetchIceServers()]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    it("invalidateIceServers forces a refetch", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ iceServers: [{ urls: "stun:y" }], ttl: 3600, mode: "stun-only" }),
        });
        (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

        const { fetchIceServers, invalidateIceServers } = await freshImport();
        await fetchIceServers();
        await fetchIceServers(); // cached
        expect(fetchMock).toHaveBeenCalledTimes(1);
        invalidateIceServers();
        await fetchIceServers(); // refetch
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
