import { describe, expect, it } from "vitest";
import { validateDeviceLanUrl } from "./url-guard.js";

describe("validateDeviceLanUrl", () => {
    it("accepts RFC1918 private addresses", () => {
        expect(validateDeviceLanUrl("http://192.168.1.42:17899")).toBe("http://192.168.1.42:17899/");
        expect(validateDeviceLanUrl("http://10.0.0.5:17899")).toBe("http://10.0.0.5:17899/");
        expect(validateDeviceLanUrl("http://172.16.0.1:17899")).toBe("http://172.16.0.1:17899/");
    });

    it("accepts IPv6 ULA", () => {
        expect(validateDeviceLanUrl("http://[fd00::1]:17899")).toBe("http://[fd00::1]:17899/");
    });

    it("rejects loopback", () => {
        expect(validateDeviceLanUrl("http://127.0.0.1:17899")).toBeNull();
        expect(validateDeviceLanUrl("http://localhost:17899")).toBeNull();
        expect(validateDeviceLanUrl("http://[::1]:17899")).toBeNull();
    });

    it("rejects public + cloud metadata + link-local", () => {
        expect(validateDeviceLanUrl("http://8.8.8.8")).toBeNull();
        expect(validateDeviceLanUrl("http://169.254.169.254")).toBeNull();
        expect(validateDeviceLanUrl("https://muzicai.ro")).toBeNull();
    });

    it("rejects non-http(s) + junk", () => {
        expect(validateDeviceLanUrl("file:///etc/passwd")).toBeNull();
        expect(validateDeviceLanUrl("not a url")).toBeNull();
        expect(validateDeviceLanUrl(123)).toBeNull();
        expect(validateDeviceLanUrl(null)).toBeNull();
    });
});
