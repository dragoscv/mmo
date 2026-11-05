import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { deleteUserAccount, type DeleteAccountDeps } from "./delete-account";

function deps(over: Partial<DeleteAccountDeps> = {}): DeleteAccountDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        appleRefreshTokens: vi.fn(async () => { calls.push("apple-lookup"); return []; }),
        revokeApple: vi.fn(async () => { calls.push("revoke"); return "revoked" as const; }),
        stripeCustomerId: vi.fn(async () => null),
        deleteStripeCustomer: vi.fn(async () => { calls.push("stripe"); }),
        deleteOrphanRows: vi.fn(async () => { calls.push("orphans"); }),
        deleteUserRow: vi.fn(async () => { calls.push("user"); return 1; }),
        ...over,
    };
}

describe("deleteUserAccount", () => {
    it("revokes every Apple refresh token before deleting the user row", async () => {
        const d = deps({
            appleRefreshTokens: vi.fn(async () => { return ["r1", "r2"]; }),
        });
        const r = await deleteUserAccount("u1", d);
        expect(r.ok).toBe(true);
        expect(d.revokeApple).toHaveBeenCalledTimes(2);
        expect(r.apple).toEqual({ tokens: 2, revoked: 2, failed: 0, unconfigured: false });
        expect(d.calls.indexOf("revoke")).toBeLessThan(d.calls.indexOf("user"));
    });

    it("still deletes the account when Apple revoke and Stripe fail", async () => {
        const d = deps({
            appleRefreshTokens: vi.fn(async () => ["r1"]),
            revokeApple: vi.fn(async () => "failed" as const),
            stripeCustomerId: vi.fn(async () => "cus_1"),
            deleteStripeCustomer: vi.fn(async () => { throw new Error("stripe down"); }),
        });
        const r = await deleteUserAccount("u1", d);
        expect(r).toMatchObject({ ok: true, stripe: "failed", apple: { failed: 1, revoked: 0 } });
        expect(d.deleteUserRow).toHaveBeenCalledWith("u1");
    });

    it("reports unconfigured Apple keys without failing", async () => {
        const d = deps({ appleRefreshTokens: vi.fn(async () => ["r1"]), revokeApple: vi.fn(async () => "unconfigured" as const) });
        const r = await deleteUserAccount("u1", d);
        expect(r.ok).toBe(true);
        expect(r.apple.unconfigured).toBe(true);
    });

    it("deletes non-cascading rows before the user row", async () => {
        const d = deps();
        await deleteUserAccount("u1", d);
        expect(d.calls.indexOf("orphans")).toBeGreaterThanOrEqual(0);
        expect(d.calls.indexOf("orphans")).toBeLessThan(d.calls.indexOf("user"));
    });

    it("deletes the Stripe customer when one exists", async () => {
        const d = deps({ stripeCustomerId: vi.fn(async () => "cus_9") });
        const r = await deleteUserAccount("u1", d);
        expect(d.deleteStripeCustomer).toHaveBeenCalledWith("cus_9");
        expect(r.stripe).toBe("deleted");
    });

    it("returns not_found when no user row was deleted", async () => {
        const r = await deleteUserAccount("ghost", deps({ deleteUserRow: vi.fn(async () => 0) }));
        expect(r).toMatchObject({ ok: false, error: "not_found" });
    });

    it("returns delete_failed when the database delete throws", async () => {
        const r = await deleteUserAccount("u1", deps({ deleteUserRow: vi.fn(async () => { throw new Error("fk"); }) }));
        expect(r).toMatchObject({ ok: false, error: "delete_failed" });
    });
});
