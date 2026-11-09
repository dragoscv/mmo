import { describe, expect, it } from "vitest";
import { ENTITLEMENTS, entitlementsFor, hasEntitlement, isFlagEnabled } from "./entitlements";

const pro = { plan: "pro_yearly", isPro: true } as const;
const free = { plan: "free", isPro: false } as const;
const lapsed = { plan: "pro_monthly", isPro: false } as const;
const on = { MIXAI_FLAG_DECKS_PRO: "1" };

describe("entitlements", () => {
    it("keeps decks_pro disabled by default, even for Pro subscribers", () => {
        expect(isFlagEnabled("decks_pro", {})).toBe(false);
        expect(hasEntitlement(pro, "decks_pro", {})).toBe(false);
        expect(entitlementsFor(pro, {})).toEqual([]);
    });

    it("treats only 1/true as an enabled flag", () => {
        expect(isFlagEnabled("decks_pro", { MIXAI_FLAG_DECKS_PRO: "TRUE " })).toBe(true);
        expect(isFlagEnabled("decks_pro", { MIXAI_FLAG_DECKS_PRO: "0" })).toBe(false);
        expect(isFlagEnabled("decks_pro", { MIXAI_FLAG_DECKS_PRO: "yes" })).toBe(false);
    });

    it("grants decks_pro to active Pro plans once the flag is on", () => {
        expect(hasEntitlement(pro, "decks_pro", on)).toBe(true);
        expect(entitlementsFor(pro, on)).toEqual(["decks_pro"]);
    });

    it("denies free and lapsed subscriptions with the flag on", () => {
        expect(hasEntitlement(free, "decks_pro", on)).toBe(false);
        expect(hasEntitlement(lapsed, "decks_pro", on)).toBe(false);
    });

    it("maps decks_pro to the paid Stripe plans only", () => {
        expect(ENTITLEMENTS.decks_pro.plans).toEqual(["pro_monthly", "pro_yearly"]);
    });
});
