import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Reload the module per-suite so DEVICE_ALLOW_PRIVATE re-reads env.
async function loadGuard() {
    vi.resetModules();
    return await import("./url-guard");
}

describe("isPrivateOrLoopbackHost", () => {
    it("flags loopback names and IPs", async () => {
        const { isPrivateOrLoopbackHost } = await loadGuard();
        expect(isPrivateOrLoopbackHost("localhost")).toBe(true);
        expect(isPrivateOrLoopbackHost("127.0.0.1")).toBe(true);
        expect(isPrivateOrLoopbackHost("127.255.255.254")).toBe(true);
        expect(isPrivateOrLoopbackHost("[::1]")).toBe(true);
    });

    it("flags RFC1918 ranges", async () => {
        const { isPrivateOrLoopbackHost } = await loadGuard();
        expect(isPrivateOrLoopbackHost("10.0.0.1")).toBe(true);
        expect(isPrivateOrLoopbackHost("172.16.0.1")).toBe(true);
        expect(isPrivateOrLoopbackHost("172.31.255.255")).toBe(true);
        expect(isPrivateOrLoopbackHost("192.168.1.1")).toBe(true);
    });

    it("flags AWS/GCP cloud metadata 169.254.169.254", async () => {
        const { isPrivateOrLoopbackHost } = await loadGuard();
        expect(isPrivateOrLoopbackHost("169.254.169.254")).toBe(true);
    });

    it("flags multicast and 0.0.0.0/8", async () => {
        const { isPrivateOrLoopbackHost } = await loadGuard();
        expect(isPrivateOrLoopbackHost("0.0.0.0")).toBe(true);
        expect(isPrivateOrLoopbackHost("224.0.0.1")).toBe(true);
        expect(isPrivateOrLoopbackHost("239.255.255.250")).toBe(true);
    });

    it("does NOT flag normal public IPs / hostnames", async () => {
        const { isPrivateOrLoopbackHost } = await loadGuard();
        expect(isPrivateOrLoopbackHost("8.8.8.8")).toBe(false);
        expect(isPrivateOrLoopbackHost("1.1.1.1")).toBe(false);
        expect(isPrivateOrLoopbackHost("172.32.0.1")).toBe(false); // outside 16-31
        expect(isPrivateOrLoopbackHost("youtube.com")).toBe(false);
    });

    it("flags IPv6 ULA and link-local", async () => {
        const { isPrivateOrLoopbackHost } = await loadGuard();
        expect(isPrivateOrLoopbackHost("[fc00::1]")).toBe(true);
        expect(isPrivateOrLoopbackHost("[fd12:3456::1]")).toBe(true);
        expect(isPrivateOrLoopbackHost("[fe80::1]")).toBe(true);
    });
});

describe("validatePublicHttpUrl", () => {
    it("accepts a valid public https URL", async () => {
        const { validatePublicHttpUrl } = await loadGuard();
        expect(validatePublicHttpUrl("https://youtube.com/watch?v=abc")).toBe(
            "https://youtube.com/watch?v=abc",
        );
    });

    it("rejects non-http(s) protocols", async () => {
        const { validatePublicHttpUrl } = await loadGuard();
        expect(validatePublicHttpUrl("file:///etc/passwd")).toBeNull();
        expect(validatePublicHttpUrl("ftp://example.com/x")).toBeNull();
        expect(validatePublicHttpUrl("javascript:alert(1)")).toBeNull();
    });

    it("rejects private hosts always", async () => {
        const { validatePublicHttpUrl } = await loadGuard();
        expect(validatePublicHttpUrl("http://127.0.0.1/")).toBeNull();
        expect(validatePublicHttpUrl("http://169.254.169.254/latest/meta-data/")).toBeNull();
        expect(validatePublicHttpUrl("http://192.168.1.1/")).toBeNull();
    });

    it("rejects strings starting with `-` (CLI flag injection guard)", async () => {
        const { validatePublicHttpUrl } = await loadGuard();
        expect(validatePublicHttpUrl("-oProxyCommand=...")).toBeNull();
    });

    it("rejects oversized inputs and non-strings", async () => {
        const { validatePublicHttpUrl } = await loadGuard();
        expect(validatePublicHttpUrl("https://" + "a".repeat(3000))).toBeNull();
        expect(validatePublicHttpUrl(null)).toBeNull();
        expect(validatePublicHttpUrl(123)).toBeNull();
        expect(validatePublicHttpUrl("")).toBeNull();
    });
});

describe("validateDeviceApiUrl", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("accepts private hosts in non-production by default", async () => {
        vi.stubEnv("NODE_ENV", "development");
        const { validateDeviceApiUrl } = await loadGuard();
        expect(validateDeviceApiUrl("http://127.0.0.1:7777/")).toBe("http://127.0.0.1:7777/");
        expect(validateDeviceApiUrl("http://192.168.1.50:7777/")).toBe("http://192.168.1.50:7777/");
    });

    it("rejects private hosts in production unless explicitly opted in", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("MMO_ALLOW_PRIVATE_DEVICE_URLS", "");
        const { validateDeviceApiUrl } = await loadGuard();
        expect(validateDeviceApiUrl("http://127.0.0.1:7777/")).toBeNull();
    });

    it("opt-in flag re-enables private hosts in production", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("MMO_ALLOW_PRIVATE_DEVICE_URLS", "1");
        const { validateDeviceApiUrl } = await loadGuard();
        expect(validateDeviceApiUrl("http://10.0.0.5:7777/")).toBe("http://10.0.0.5:7777/");
    });
});
