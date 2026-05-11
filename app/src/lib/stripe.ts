/**
 * Stripe server-side client + subscription helpers.
 *
 * Source-of-truth for billing state is the `subscriptions` table; Stripe is
 * authoritative and we keep our row in sync via webhooks (see
 * `app/src/app/api/billing/webhook/route.ts`).
 *
 * Free tier:    1 device sync, no cloud backup quota
 * Pro:          unlimited devices, 50GB cloud backup, priority support
 */

import Stripe from "stripe";
import { db } from "@/db";
import { subscriptions, users } from "@/db/schema";
import { eq } from "drizzle-orm";

const stripeSecret = process.env.STRIPE_SECRET_KEY;

// Lazy: routes that don't touch billing should still build / run without
// Stripe configured. Throws only when actually used.
let _stripe: Stripe | null = null;
export function stripe(): Stripe {
    if (_stripe) return _stripe;
    if (!stripeSecret) {
        throw new Error(
            "STRIPE_SECRET_KEY is not set. Add it to .env.local; see " +
            "https://dashboard.stripe.com/apikeys",
        );
    }
    _stripe = new Stripe(stripeSecret, {
        apiVersion: "2026-04-22.dahlia",
        appInfo: { name: "MMO", url: "https://muzicai.ro" },
    });
    return _stripe;
}

export const PRICE_IDS = {
    pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY ?? "",
    pro_yearly: process.env.STRIPE_PRICE_PRO_YEARLY ?? "",
} as const;

export type Plan = "free" | "pro_monthly" | "pro_yearly";

export type SubscriptionState = {
    plan: Plan;
    status: string;
    isPro: boolean;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
};

const FREE_STATE: SubscriptionState = {
    plan: "free",
    status: "free",
    isPro: false,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
};

/** Returns the user's current subscription state, falling back to free. */
export async function getSubscription(userId: string): Promise<SubscriptionState> {
    const row = await db.query.subscriptions.findFirst({
        where: eq(subscriptions.userId, userId),
    });
    if (!row) return FREE_STATE;
    // Honour the grace period during a failed-payment retry cycle.
    // Stripe transitions to `past_due` while it retries the card (typically
    // 3–4 attempts over ~3 weeks). Bouncing the user out of Pro on the
    // first decline is hostile UX and a known revenue-loss anti-pattern;
    // their access stays until Stripe gives up and emits `unpaid` /
    // `canceled`.
    const PRO_STATUSES = new Set(["active", "trialing", "past_due"]);
    const isPro = row.plan !== "free" && PRO_STATUSES.has(row.status);
    return {
        plan: row.plan as Plan,
        status: row.status,
        isPro,
        currentPeriodEnd: row.currentPeriodEnd,
        cancelAtPeriodEnd: !!row.cancelAtPeriodEnd,
    };
}

/** Server-side gate. Throws a 402-style error usable in Server Actions. */
export class PaywallError extends Error {
    constructor(public feature: string) {
        super(`Feature "${feature}" requires an MMO Pro subscription.`);
        this.name = "PaywallError";
    }
}

export async function requirePro(userId: string, feature: string): Promise<void> {
    const sub = await getSubscription(userId);
    if (!sub.isPro) throw new PaywallError(feature);
}

/** Get-or-create the Stripe customer for this user. */
export async function ensureCustomer(userId: string): Promise<string> {
    const existing = await db.query.subscriptions.findFirst({
        where: eq(subscriptions.userId, userId),
    });
    if (existing) return existing.stripeCustomerId;

    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    const customer = await stripe().customers.create({
        email: user?.email ?? undefined,
        name: user?.name ?? undefined,
        metadata: { userId },
    });

    await db.insert(subscriptions).values({
        userId,
        stripeCustomerId: customer.id,
        status: "incomplete",
        plan: "free",
    });
    return customer.id;
}
