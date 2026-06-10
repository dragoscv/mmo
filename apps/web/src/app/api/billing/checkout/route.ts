/**
 * POST /api/billing/checkout — create a Checkout Session for the current user.
 * Body: { plan: "pro_monthly" | "pro_yearly" }
 * Returns: { url } — redirect the browser to it.
 */

import { auth } from "@/auth";
import { ensureCustomer, PRICE_IDS, stripe } from "@/lib/stripe";
import { requireSessionWithRate } from "@/lib/api-guard";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
    // 10 checkouts/min per user is generous for legitimate flow (one
    // click = one session). Without this, a compromised session could
    // spam Stripe checkout creation — each call costs us an outbound
    // API hit and clutters the customer's Stripe dashboard.
    const guard = await requireSessionWithRate(req, { bucket: "billing-checkout", windowMs: 60_000, max: 10 });
    if (guard.response) return guard.response;
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const { plan } = (await req.json().catch(() => ({}))) as { plan?: string };
    const priceId = plan === "pro_yearly" ? PRICE_IDS.pro_yearly : PRICE_IDS.pro_monthly;
    if (!priceId) {
        return NextResponse.json(
            { error: `Stripe price for ${plan} not configured (set STRIPE_PRICE_${(plan ?? "").toUpperCase()})` },
            { status: 500 },
        );
    }

    const customerId = await ensureCustomer(userId);
    // Pin redirect targets to a server-controlled origin. Reading from
    // the request `Origin` header would let an attacker on evil.com
    // POST a fetch with their own origin and receive a Stripe URL whose
    // success/cancel links point back to evil.com (open-redirect-via-
    // Stripe). Fall back to muzicai.ro when the env var is unset.
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? "https://muzicai.ro";

    const checkout = await stripe().checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${origin}/settings?billing=success`,
        cancel_url: `${origin}/settings?billing=cancelled`,
        allow_promotion_codes: true,
        metadata: { userId },
        subscription_data: { metadata: { userId } },
    });

    return NextResponse.json({ url: checkout.url });
}
