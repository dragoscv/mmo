import { describe, it, expect } from "vitest";
import { isLoopbackUrl, isHostedRuntime, pickCompanionUrl } from "./companion-url";

describe("isLoopbackUrl", () => {
    it("detects loopback hosts", () => {
        expect(isLoopbackUrl("http://localhost:9876")).toBe(true);
        expect(isLoopbackUrl("http://127.0.0.1:17899")).toBe(true);
        expect(isLoopbackUrl("https://localhost:443")).toBe(true);
    });
    it("rejects non-loopback hosts", () => {
        expect(isLoopbackUrl("http://192.168.1.42:9876")).toBe(false);
        expect(isLoopbackUrl("https://device-abc.muzicai.ro")).toBe(false);
        expect(isLoopbackUrl("http://10.0.0.5:9876")).toBe(false);
    });
});

describe("isHostedRuntime", () => {
    it("is true on Vercel / Cloud Run / Lambda", () => {
        expect(isHostedRuntime({ VERCEL: "1" })).toBe(true);
        expect(isHostedRuntime({ K_SERVICE: "web" })).toBe(true);
        expect(isHostedRuntime({ AWS_LAMBDA_FUNCTION_NAME: "fn" })).toBe(true);
    });
    it("is false locally", () => {
        expect(isHostedRuntime({})).toBe(false);
    });
});

describe("pickCompanionUrl", () => {
    const loopback = "http://localhost:9876";
    const lan = "http://192.168.1.42:9876";

    describe("local runtime (co-located)", () => {
        it("prefers loopback api_url over a flaky LAN url", () => {
            expect(pickCompanionUrl({ apiUrl: loopback, lanUrl: lan }, false)).toBe(loopback);
        });
        it("falls back to lan_url when api_url is not loopback", () => {
            expect(pickCompanionUrl({ apiUrl: lan, lanUrl: lan }, false)).toBe(lan);
        });
        it("uses lan_url when api_url is missing", () => {
            expect(pickCompanionUrl({ apiUrl: null, lanUrl: lan }, false)).toBe(lan);
        });
        it("returns api_url when there is no lan_url", () => {
            expect(pickCompanionUrl({ apiUrl: loopback, lanUrl: null }, false)).toBe(loopback);
        });
    });

    describe("hosted runtime", () => {
        it("never returns a loopback url", () => {
            expect(pickCompanionUrl({ apiUrl: loopback, lanUrl: lan }, true)).toBe(lan);
        });
        it("uses non-loopback api_url when lan_url is loopback", () => {
            expect(pickCompanionUrl({ apiUrl: lan, lanUrl: loopback }, true)).toBe(lan);
        });
        it("returns null when only loopback urls exist", () => {
            expect(pickCompanionUrl({ apiUrl: loopback, lanUrl: loopback }, true)).toBeNull();
            expect(pickCompanionUrl({ apiUrl: loopback, lanUrl: null }, true)).toBeNull();
        });
    });
});
