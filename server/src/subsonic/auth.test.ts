import { describe, it, expect } from "vitest";
import { authenticate, decodePassword, md5Hex, subsonicToken } from "./auth";
import { SubsonicError } from "./response";

const SECRET = "dev-token-1234";

function code(fn: () => unknown): number | null {
    try { fn(); return null; } catch (e) { return e instanceof SubsonicError ? e.code : -1; }
}

describe("subsonic auth — token math", () => {
    it("md5 matches the Subsonic spec example", () => {
        // From subsonic.org: password "sesame", salt "c19b2d" → 26719a1196d2a940705a59634eb18eab
        expect(subsonicToken("sesame", "c19b2d")).toBe("26719a1196d2a940705a59634eb18eab");
        expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    });

    it("decodes enc: hex passwords", () => {
        expect(decodePassword("enc:736573616d65")).toBe("sesame");
        expect(decodePassword("plain")).toBe("plain");
        expect(decodePassword("enc:zz")).toBe("");
    });
});

describe("subsonic auth — mechanisms", () => {
    it("apiKey = device token", () => {
        expect(authenticate({ apiKey: SECRET }, SECRET)).toBe("mmo");
        expect(code(() => authenticate({ apiKey: "nope" }, SECRET))).toBe(44);
    });

    it("apiKey + u conflict → 43", () => {
        expect(code(() => authenticate({ apiKey: SECRET, u: "x" }, SECRET))).toBe(43);
    });

    it("u + t + s salted token", () => {
        const s = "abc123";
        expect(authenticate({ u: "alice", t: subsonicToken(SECRET, s), s }, SECRET)).toBe("alice");
        expect(code(() => authenticate({ u: "alice", t: subsonicToken("wrong", s), s }, SECRET))).toBe(40);
        expect(code(() => authenticate({ u: "alice", t: "deadbeef" }, SECRET))).toBe(10);
    });

    it("u + p plain and enc:", () => {
        expect(authenticate({ u: "bob", p: SECRET }, SECRET)).toBe("bob");
        expect(authenticate({ u: "bob", p: "enc:" + Buffer.from(SECRET).toString("hex") }, SECRET)).toBe("bob");
        expect(code(() => authenticate({ u: "bob", p: "wrong" }, SECRET))).toBe(40);
    });

    it("missing everything → 10; empty secret never authenticates", () => {
        expect(code(() => authenticate({}, SECRET))).toBe(10);
        expect(code(() => authenticate({ u: "bob" }, SECRET))).toBe(10);
        expect(code(() => authenticate({ u: "bob", p: "" }, ""))).toBe(40);
        expect(code(() => authenticate({ apiKey: "" }, ""))).toBe(44);
    });
});
