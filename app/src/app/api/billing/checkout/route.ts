/**
 * POST /api/billing/checkout — create a Checkout Session for the current user.
 * Body: { plan: "pro_monthly" | "pro_yearly" }
 * Returns: { url } — redirect the browser to it.
 */

import { auth } from "@/auth";
import { ensureCustomer, PRICE_IDS, stripe } from "@/lib/stripe";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
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
    const origin = req.headers.get("origin") ?? "https://muzicai.ro";

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
