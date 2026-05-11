/**
 * POST /api/billing/portal — open the Stripe Customer Portal so the user can
 * manage their subscription, payment method, and invoices.
 */

import { auth } from "@/auth";
import { ensureCustomer, stripe } from "@/lib/stripe";
import { requireSessionWithRate } from "@/lib/api-guard";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
    const guard = await requireSessionWithRate(req, { bucket: "billing-portal", windowMs: 60_000, max: 10 });
    if (guard.response) return guard.response;
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const customerId = await ensureCustomer(session.user.id);
    // Pin to server-controlled origin (see checkout/route.ts for rationale).
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? "https://muzicai.ro";

    const portal = await stripe().billingPortal.sessions.create({
        customer: customerId,
        return_url: `${origin}/settings`,
    });

    return NextResponse.json({ url: portal.url });
}
