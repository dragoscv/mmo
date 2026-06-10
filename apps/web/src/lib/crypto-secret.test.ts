import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

const TEST_KEY = crypto.randomBytes(32).toString("base64");

async function load() {
    // Re-import after env stub so the module reads the stubbed key on first
    // call (loadKey runs lazily per call, so resetModules isn't strictly
    // required, but we keep it isolated).
    return await import("./crypto-secret");
}

describe("crypto-secret", () => {
    beforeEach(() => {
        vi.stubEnv("MMO_SECRET_KEY", TEST_KEY);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("round-trips an arbitrary string", async () => {
        const { encryptSecret, decryptSecret } = await load();
        const plain = "sk-test-1234567890abcdef";
        const blob = encryptSecret(plain);
        expect(blob.startsWith("v1:")).toBe(true);
        expect(blob.split(":")).toHaveLength(4);
        expect(decryptSecret(blob)).toBe(plain);
    });

    it("produces a different ciphertext each call (random IV)", async () => {
        const { encryptSecret } = await load();
        const a = encryptSecret("same-input");
        const b = encryptSecret("same-input");
        expect(a).not.toBe(b);
    });

    it("rejects tampered ciphertext via GCM auth tag", async () => {
        const { encryptSecret, decryptSecret } = await load();
        const blob = encryptSecret("payload");
        const parts = blob.split(":");
        // Flip a bit in the ciphertext segment.
        const ct = Buffer.from(parts[2], "base64");
        ct[0] ^= 0x01;
        parts[2] = ct.toString("base64");
        expect(() => decryptSecret(parts.join(":"))).toThrow();
    });

    it("rejects malformed blob", async () => {
        const { decryptSecret } = await load();
        expect(() => decryptSecret("not-a-blob")).toThrow(/Malformed/);
        expect(() => decryptSecret("v2:a:b:c")).toThrow(/Malformed/);
    });

    it("requires MMO_SECRET_KEY to be set", async () => {
        vi.stubEnv("MMO_SECRET_KEY", "");
        const { encryptSecret } = await load();
        expect(() => encryptSecret("x")).toThrow(/MMO_SECRET_KEY/);
    });

    it("rejects keys of the wrong length", async () => {
        vi.stubEnv("MMO_SECRET_KEY", Buffer.from("too-short").toString("base64"));
        const { encryptSecret } = await load();
        expect(() => encryptSecret("x")).toThrow(/32 bytes/);
    });

    it("maskSecret hides the middle of a long string", async () => {
        const { maskSecret } = await load();
        expect(maskSecret("sk-abcdef012345WXYZ", 4)).toBe("sk-a…WXYZ");
    });

    it("maskSecret bullets out short strings entirely", async () => {
        const { maskSecret } = await load();
        expect(maskSecret("short", 4)).toBe("•••••");
        expect(maskSecret("")).toBe("");
    });
});
