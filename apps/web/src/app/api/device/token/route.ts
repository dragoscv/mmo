import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { deviceAuthCodes, devices, sessions, users } from "@/db/schema";
import { requireRate } from "@/lib/api-guard";
import { materializeDeviceToken } from "@/lib/device-token";
import { evaluateTokenPoll, hashDeviceCode } from "@/lib/device-code";

// Step 3 of the device-code login: the TV polls with its device_code.
// On approval we mint an Auth.js `session` row (30 days) exactly like
// /api/auth/desktop-bootstrap and return the user's companions with a
// materialized device token so the TV can talk to them directly.

export const dynamic = "force-dynamic";

const SESSION_DAYS = 30;

const BodySchema = z.object({
    device_code: z.string().min(32).max(128),
});

const NO_STORE = { "Cache-Control": "no-store" } as const;

function err(error: string, status: number) {
    return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function POST(request: NextRequest) {
    const limited = requireRate(request, { bucket: "device-token", windowMs: 60_000, max: 60 });
    if (limited) return limited;

    let json: unknown;
    try { json = await request.json(); } catch { json = null; }
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) return err("invalid_request", 400);

    const hash = hashDeviceCode(parsed.data.device_code);
    const [row] = await db.select().from(deviceAuthCodes)
        .where(eq(deviceAuthCodes.deviceCodeHash, hash)).limit(1);
    if (!row) return err("invalid_grant", 400);

    const now = new Date();
    const outcome = evaluateTokenPoll(row, now);

    // Record the poll (also for slow_down, so a hammering client stays throttled).
    await db.update(deviceAuthCodes).set({ lastPolledAt: now })
        .where(eq(deviceAuthCodes.id, row.id));

    if (outcome.kind !== "approved") return err(outcome.kind, outcome.httpStatus);
    if (!row.userId) return err("access_denied", 403);

    // Atomically consume: only one poller wins even under a race.
    const consumed = await db.update(deviceAuthCodes)
        .set({ status: "consumed" })
        .where(and(eq(deviceAuthCodes.id, row.id), eq(deviceAuthCodes.status, "approved")))
        .returning({ id: deviceAuthCodes.id });
    if (consumed.length === 0) return err("expired_token", 410);

    const sessionToken = randomUUID();
    const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    await db.insert(sessions).values({ sessionToken, userId: row.userId, expires });

    const [user] = await db.select({ id: users.id, name: users.name, image: users.image })
        .from(users).where(eq(users.id, row.userId)).limit(1);

    const deviceRows = await db.select().from(devices).where(eq(devices.userId, row.userId));
    const companions: Array<{
        id: string; name: string; lanUrl: string | null; apiUrl: string;
        tunnelHostname: string | null; token: string;
    }> = [];
    for (const d of deviceRows) {
        const token = await materializeDeviceToken(d);
        if (!token) continue;
        companions.push({
            id: d.id,
            name: d.name,
            lanUrl: d.lanUrl,
            apiUrl: d.apiUrl,
            tunnelHostname: d.tunnelHostname,
            token,
        });
    }

    return NextResponse.json(
        {
            session_token: sessionToken,
            expires: expires.toISOString(),
            user: { id: user?.id ?? row.userId, name: user?.name ?? null, image: user?.image ?? null },
            companions,
        },
        { headers: NO_STORE },
    );
}
