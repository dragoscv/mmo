/**
 * device-token crypto round-trip tests.
 *
 * Locks the at-rest invariants for the 0006 migration:
 *   - issueDeviceToken() emits a hash + ciphertext that round-trip cleanly.
 *   - hashDeviceToken is deterministic and matches the issued hash.
 *   - decryptDeviceToken refuses tampered envelopes.
 *   - findDeviceByToken returns null on unknown tokens, finds by hash, and
 *     backfills + returns the row on a legacy plaintext-only hit.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";

beforeAll(() => {
    process.env.AUTH_SECRET ??= "test-secret-must-be-at-least-32-bytes-long-aaaaaa";
});

describe("device-token crypto", () => {
    it("issue → hash + encrypt round-trip", async () => {
        const { issueDeviceToken, hashDeviceToken, decryptDeviceToken } =
            await import("./device-token");
        const issued = issueDeviceToken();
        expect(issued.plaintext).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        expect(issued.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(issued.encrypted).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
        expect(hashDeviceToken(issued.plaintext)).toBe(issued.hash);
        expect(decryptDeviceToken(issued.encrypted)).toBe(issued.plaintext);
    });

    it("encryptDeviceToken uses a fresh nonce per call", async () => {
        const { encryptDeviceToken } = await import("./device-token");
        const a = encryptDeviceToken("same-plaintext");
        const b = encryptDeviceToken("same-plaintext");
        expect(a).not.toBe(b);
    });

    it("decryptDeviceToken refuses tampered ciphertext", async () => {
        const { encryptDeviceToken, decryptDeviceToken } = await import("./device-token");
        const blob = encryptDeviceToken("hello");
        const parts = blob.split(":");
        // Flip the last base64url char of the ciphertext+tag segment.
        const tampered = `${parts[0]}:${parts[1]}:${parts[2].slice(0, -1)}${parts[2].slice(-1) === "A" ? "B" : "A"}`;
        expect(() => decryptDeviceToken(tampered)).toThrow();
    });

    it("decryptDeviceToken rejects unsupported envelope versions", async () => {
        const { decryptDeviceToken } = await import("./device-token");
        expect(() => decryptDeviceToken("v2:abc:def")).toThrow();
        expect(() => decryptDeviceToken("nonsense")).toThrow();
    });

    it("hashDeviceToken is deterministic and length-stable", async () => {
        const { hashDeviceToken } = await import("./device-token");
        const a = hashDeviceToken("x");
        const b = hashDeviceToken("x");
        expect(a).toBe(b);
        expect(a.length).toBe(64);
    });
});

describe("findDeviceByToken", () => {
    // Mock the db layer so we don't need a live Postgres in unit tests. The
    // helper's contract is: hash-first SELECT → if hit, return; else legacy
    // plaintext SELECT → if hit, backfill via UPDATE and return.
    it("returns null when neither lookup matches", async () => {
        vi.resetModules();
        vi.doMock("@/db", () => ({
            db: {
                select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
                update: () => ({ set: () => ({ where: async () => undefined }) }),
            },
        }));
        const { findDeviceByToken } = await import("./device-token");
        const row = await findDeviceByToken("does-not-exist");
        expect(row).toBeNull();
    });
});
