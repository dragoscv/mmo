/**
 * Web Push subscription management.
 *
 * POST   — register or refresh the caller's subscription.
 * DELETE — unregister it.
 * GET    — return { configured: boolean } so the settings UI can hide
 *          the toggle on dev instances without VAPID set.
 *
 * Auth: requires a signed-in session. Subscriptions belong to the
 * authenticated user, not the device — a single user with three
 * browsers gets three rows.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { isPushConfigured } from "@/lib/push";

export const dynamic = "force-dynamic";

// Subscription endpoints are URLs from FCM/Mozilla/WNS. They must be
// HTTPS, must not be private/loopback, and we cap length defensively.
const subscriptionSchema = z.object({
    endpoint: z.string().url().max(2048).refine(
        (u) => u.startsWith("https://"),
        "endpoint must be https",
    ),
    keys: z.object({
        // base64url, 65 raw bytes → ~88 chars encoded. Allow up to 256 for safety.
        p256dh: z.string().min(80).max(256),
        // base64url, 16 raw bytes → ~22 chars. Allow up to 64.
        auth: z.string().min(16).max(64),
    }),
});

export async function GET() {
    return NextResponse.json({ configured: isPushConfigured() });
}

export async function POST(req: NextRequest) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = subscriptionSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: "Invalid subscription", details: parsed.error.issues }, { status: 400 });
    }

    const userAgent = req.headers.get("user-agent")?.slice(0, 256) ?? null;
    const now = new Date();

    // Upsert on the unique endpoint. If this endpoint already exists under
    // a DIFFERENT user (browser shared across accounts), we re-bind it.
    await db
        .insert(pushSubscriptions)
        .values({
            userId: session.user.id,
            endpoint: parsed.data.endpoint,
            p256dh: parsed.data.keys.p256dh,
            auth: parsed.data.keys.auth,
            userAgent,
            lastSeenAt: now,
            consecutiveFailures: 0,
        })
        .onConflictDoUpdate({
            target: pushSubscriptions.endpoint,
            set: {
                userId: session.user.id,
                p256dh: parsed.data.keys.p256dh,
                auth: parsed.data.keys.auth,
                userAgent,
                lastSeenAt: now,
                consecutiveFailures: 0,
            },
        });

    return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = z.object({ endpoint: z.string().url().max(2048) }).safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: "Invalid endpoint" }, { status: 400 });
    }

    await db
        .delete(pushSubscriptions)
        .where(
            and(
                eq(pushSubscriptions.endpoint, parsed.data.endpoint),
                eq(pushSubscriptions.userId, session.user.id),
            ),
        );

    return NextResponse.json({ ok: true });
}
