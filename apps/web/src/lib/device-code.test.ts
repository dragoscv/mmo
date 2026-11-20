import { describe, it, expect } from "vitest";
import {
    USER_CODE_ALPHABET,
    USER_CODE_LENGTH,
    generateUserCode,
    formatUserCode,
    normalizeUserCode,
    isValidUserCode,
    generateDeviceCode,
    hashDeviceCode,
    effectiveStatus,
    canDecide,
    evaluateTokenPoll,
} from "./device-code";

const NOW = new Date("2026-09-18T12:00:00Z");
const future = new Date(NOW.getTime() + 60_000);
const past = new Date(NOW.getTime() - 60_000);

describe("user code generation", () => {
    it("alphabet excludes ambiguous glyphs", () => {
        for (const ch of "0O1I") expect(USER_CODE_ALPHABET).not.toContain(ch);
        expect(USER_CODE_ALPHABET).toHaveLength(32);
    });

    it("generates 8 chars from the alphabet only", () => {
        for (let i = 0; i < 200; i++) {
            const c = generateUserCode();
            expect(c).toHaveLength(USER_CODE_LENGTH);
            for (const ch of c) expect(USER_CODE_ALPHABET).toContain(ch);
            expect(isValidUserCode(c)).toBe(true);
        }
    });

    it("is not trivially constant", () => {
        const set = new Set(Array.from({ length: 50 }, generateUserCode));
        expect(set.size).toBeGreaterThan(40);
    });

    it("formats with a dash and normalizes user input", () => {
        expect(formatUserCode("ABCD2345")).toBe("ABCD-2345");
        expect(normalizeUserCode("abcd-2345")).toBe("ABCD2345");
        expect(normalizeUserCode(" ab cd 23 45 ")).toBe("ABCD2345");
        expect(isValidUserCode(normalizeUserCode("ABC0-2345"))).toBe(false); // 0 not allowed
        expect(isValidUserCode("ABCD234")).toBe(false);
    });
});

describe("device code", () => {
    it("is opaque and hashes deterministically", () => {
        const a = generateDeviceCode();
        const b = generateDeviceCode();
        expect(a).not.toBe(b);
        expect(a.length).toBeGreaterThanOrEqual(40);
        expect(hashDeviceCode(a)).toBe(hashDeviceCode(a));
        expect(hashDeviceCode(a)).toMatch(/^[0-9a-f]{64}$/);
        expect(hashDeviceCode(a)).not.toBe(hashDeviceCode(b));
    });
});

describe("state transitions", () => {
    it("pending past expiry is expired; other states are unchanged", () => {
        expect(effectiveStatus({ status: "pending", expiresAt: past, lastPolledAt: null }, NOW)).toBe("expired");
        expect(effectiveStatus({ status: "pending", expiresAt: future, lastPolledAt: null }, NOW)).toBe("pending");
        expect(effectiveStatus({ status: "approved", expiresAt: past, lastPolledAt: null }, NOW)).toBe("approved");
    });

    it("only a live pending code can be decided", () => {
        expect(canDecide({ status: "pending", expiresAt: future, lastPolledAt: null }, NOW)).toBe(true);
        expect(canDecide({ status: "pending", expiresAt: past, lastPolledAt: null }, NOW)).toBe(false);
        expect(canDecide({ status: "approved", expiresAt: future, lastPolledAt: null }, NOW)).toBe(false);
        expect(canDecide({ status: "denied", expiresAt: future, lastPolledAt: null }, NOW)).toBe(false);
    });

    it("token poll: pending → 428", () => {
        const r = evaluateTokenPoll({ status: "pending", expiresAt: future, lastPolledAt: null }, NOW);
        expect(r).toEqual({ kind: "authorization_pending", httpStatus: 428 });
    });

    it("token poll: polled too fast → slow_down 403", () => {
        const r = evaluateTokenPoll(
            { status: "pending", expiresAt: future, lastPolledAt: new Date(NOW.getTime() - 1000) },
            NOW,
        );
        expect(r).toEqual({ kind: "slow_down", httpStatus: 403 });
    });

    it("token poll: interval-1s tolerance", () => {
        const r = evaluateTokenPoll(
            { status: "pending", expiresAt: future, lastPolledAt: new Date(NOW.getTime() - 4000) },
            NOW,
        );
        expect(r.kind).toBe("authorization_pending");
    });

    it("token poll: denied → 403, expired/consumed → 410, approved → 200", () => {
        expect(evaluateTokenPoll({ status: "denied", expiresAt: future, lastPolledAt: null }, NOW).kind).toBe("access_denied");
        expect(evaluateTokenPoll({ status: "pending", expiresAt: past, lastPolledAt: null }, NOW).httpStatus).toBe(410);
        expect(evaluateTokenPoll({ status: "consumed", expiresAt: future, lastPolledAt: null }, NOW).httpStatus).toBe(410);
        expect(evaluateTokenPoll({ status: "approved", expiresAt: future, lastPolledAt: null }, NOW).httpStatus).toBe(200);
    });
});
