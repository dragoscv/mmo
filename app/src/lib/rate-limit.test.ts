import { describe, expect, it } from "vitest";
import { ipFromRequest } from "./rate-limit";

function reqWith(headers: Record<string, string>): Request {
    return new Request("https://example.test/x", { headers });
}

describe("ipFromRequest", () => {
    it("prefers x-vercel-forwarded-for over client-supplied x-forwarded-for", () => {
        // Attacker sends X-Forwarded-For: "1.1.1.1" to bypass per-IP rate-limit.
        // Vercel/proxy injects x-vercel-forwarded-for with the *real* connection IP.
        const ip = ipFromRequest(reqWith({
            "x-forwarded-for": "1.1.1.1",
            "x-vercel-forwarded-for": "9.9.9.9",
        }));
        expect(ip).toBe("9.9.9.9");
    });

    it("prefers x-real-ip over client-supplied x-forwarded-for when no vercel header present", () => {
        const ip = ipFromRequest(reqWith({
            "x-forwarded-for": "1.1.1.1",
            "x-real-ip": "9.9.9.9",
        }));
        expect(ip).toBe("9.9.9.9");
    });

    it("falls back to x-forwarded-for[0] only when no proxy-injected header is present", () => {
        const ip = ipFromRequest(reqWith({
            "x-forwarded-for": "1.1.1.1, 2.2.2.2",
        }));
        expect(ip).toBe("1.1.1.1");
    });

    it("returns 'unknown' when no headers are set", () => {
        const ip = ipFromRequest(reqWith({}));
        expect(ip).toBe("unknown");
    });

    it("trims surrounding whitespace from the picked value", () => {
        const ip = ipFromRequest(reqWith({ "x-real-ip": "  9.9.9.9  " }));
        expect(ip).toBe("9.9.9.9");
    });
});
