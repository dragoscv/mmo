/**
 * Stripe webhook — keeps the local `subscriptions` table in sync.
 *
 * Configure in Stripe dashboard:
 *   Endpoint URL: https://muzicai.ro/api/billing/webhook
 *   Events: customer.subscription.created
 *           customer.subscription.updated
 *           customer.subscription.deleted
 *           invoice.payment_succeeded
 *           invoice.payment_failed
 *   Signing secret → STRIPE_WEBHOOK_SECRET in Vercel env.
 */

import { db } from "@/db";
import { subscriptions } from "@/db/schema";
import { stripe, PRICE_IDS } from "@/lib/stripe";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import type Stripe from "stripe";

export const runtime = "nodejs";

function priceToPlan(priceId: string | null | undefined): "pro_monthly" | "pro_yearly" | "free" {
    if (priceId === PRICE_IDS.pro_monthly) return "pro_monthly";
    if (priceId === PRICE_IDS.pro_yearly) return "pro_yearly";
    return "free";
}

async function upsertFromSubscription(sub: Stripe.Subscription) {
    const userId = (sub.metadata?.userId ?? "") as string;
    if (!userId) {
        // Fallback: look up via stripe customer id.
        const existing = await db.query.subscriptions.findFirst({
            where: eq(subscriptions.stripeCustomerId, sub.customer as string),
        });
        if (!existing) {
            console.warn("[billing/webhook] subscription event without userId metadata, skipping", sub.id);
            return;
        }
        await db
            .update(subscriptions)
            .set({
                stripeSubscriptionId: sub.id,
                status: sub.status,
                plan: priceToPlan(sub.items.data[0]?.price.id),
                currentPeriodEnd: new Date(getPeriodEnd(sub) * 1000),
                cancelAtPeriodEnd: sub.cancel_at_period_end,
                updatedAt: new Date(),
            })
            .where(eq(subscriptions.userId, existing.userId));
        return;
    }

    await db
        .update(subscriptions)
        .set({
            stripeSubscriptionId: sub.id,
            status: sub.status,
            plan: priceToPlan(sub.items.data[0]?.price.id),
            currentPeriodEnd: new Date(getPeriodEnd(sub) * 1000),
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            updatedAt: new Date(),
        })
        .where(eq(subscriptions.userId, userId));
}

function getPeriodEnd(sub: Stripe.Subscription): number {
    // In newer Stripe API, current_period_end moved to subscription items.
    const item = sub.items.data[0] as { current_period_end?: number } | undefined;
    if (item?.current_period_end) return item.current_period_end;
    const legacy = (sub as unknown as { current_period_end?: number }).current_period_end;
    return legacy ?? 0;
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
    const legacy = (invoice as unknown as { subscription?: string | null }).subscription;
    if (legacy) return legacy;
    const parent = (invoice as unknown as {
        parent?: { subscription_details?: { subscription?: string | null } };
    }).parent;
    return parent?.subscription_details?.subscription ?? null;
}

export async function POST(req: Request) {
    const sig = req.headers.get("stripe-signature");
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!sig || !secret) {
        return NextResponse.json({ error: "Missing signature / secret" }, { status: 400 });
    }
    const body = await req.text();

    let event: Stripe.Event;
    try {
        event = stripe().webhooks.constructEvent(body, sig, secret);
    } catch (err) {
        console.error("[billing/webhook] invalid signature", err);
        return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    switch (event.type) {
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
            await upsertFromSubscription(event.data.object as Stripe.Subscription);
            break;
        case "invoice.payment_succeeded":
        case "invoice.payment_failed": {
            const invoice = event.data.object as Stripe.Invoice;
            const subId = getInvoiceSubscriptionId(invoice);
            if (subId) {
                const sub = await stripe().subscriptions.retrieve(subId);
                await upsertFromSubscription(sub);
            }
            break;
        }
        default:
            // Ignore everything else — we only care about subscription state.
            break;
    }

    return NextResponse.json({ received: true });
}
