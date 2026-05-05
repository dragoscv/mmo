/**
 * POST /api/billing/portal — open the Stripe Customer Portal so the user can
 * manage their subscription, payment method, and invoices.
 */

import { auth } from "@/auth";
import { ensureCustomer, stripe } from "@/lib/stripe";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const customerId = await ensureCustomer(session.user.id);
    const origin = req.headers.get("origin") ?? "https://muzicai.ro";

    const portal = await stripe().billingPortal.sessions.create({
        customer: customerId,
        return_url: `${origin}/settings`,
    });

    return NextResponse.json({ url: portal.url });
}
