/**
 * Product entitlements derived from the Stripe-backed subscription state (`lib/stripe.ts`).
 *
 * An entitlement is granted when BOTH hold:
 *   1. its feature flag is on (env var, default OFF — nothing ships enabled), and
 *   2. the user's plan is one of the entitlement's plans and the subscription counts as Pro
 *      (`SubscriptionState.isPro`, which already honours the `past_due` grace period).
 *
 * Definitions live in code (no table, no migration): a new entitlement = one entry here.
 * `decks_pro` is the MixAI Decks Pro tier (ADR-0014 decision 10, tracker WP19-23): prepared,
 * not enabled, not exposed in any UI. See docs/decks/architecture.md "Pro infra".
 * `live_pro` is the MixAI Live Pro tier (ADR-0015 decision 9, tracker WP21-15): voice conversion, plugin
 * sandbox, multiple in-ear mixes. Same contract: flag off by default, paid plans only, no UI yet.
 */

import type { Plan, SubscriptionState } from "./stripe";

export type EntitlementKey = "decks_pro" | "live_pro";

export type EntitlementDefinition = {
    /** Env var that turns the entitlement on; anything but "1"/"true" keeps it off. */
    flag: string;
    /** Paid plans that carry the entitlement once the flag is on. */
    plans: readonly Plan[];
    description: string;
};

export const ENTITLEMENTS: Readonly<Record<EntitlementKey, EntitlementDefinition>> = {
    decks_pro: {
        flag: "MIXAI_FLAG_DECKS_PRO",
        plans: ["pro_monthly", "pro_yearly"],
        description: "MixAI Decks Pro features (stems cloud fallback, AI Transition Designer, …)",
    },
    live_pro: {
        flag: "MIXAI_FLAG_LIVE_PRO",
        plans: ["pro_monthly", "pro_yearly"],
        description: "MixAI Live Pro features (voice conversion, plugin sandbox, multiple in-ear mixes)",
    },
};

type FlagEnv = Readonly<Record<string, string | undefined>>;

/** True when the entitlement's feature flag is switched on. Default: off. */
export function isFlagEnabled(key: EntitlementKey, env: FlagEnv = process.env): boolean {
    const raw = env[ENTITLEMENTS[key].flag]?.trim().toLowerCase();
    return raw === "1" || raw === "true";
}

/** Pure check: does this subscription state grant `key`? */
export function hasEntitlement(
    sub: Pick<SubscriptionState, "plan" | "isPro">,
    key: EntitlementKey,
    env: FlagEnv = process.env,
): boolean {
    if (!isFlagEnabled(key, env)) return false;
    return sub.isPro && ENTITLEMENTS[key].plans.includes(sub.plan);
}

/** Every entitlement this subscription grants (for account/API payloads once enabled). */
export function entitlementsFor(
    sub: Pick<SubscriptionState, "plan" | "isPro">,
    env: FlagEnv = process.env,
): EntitlementKey[] {
    return (Object.keys(ENTITLEMENTS) as EntitlementKey[]).filter((k) => hasEntitlement(sub, k, env));
}
