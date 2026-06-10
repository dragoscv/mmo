import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireRate } from "@/lib/api-guard";
import { findDeviceByToken } from "@/lib/device-token";

export async function POST(request: NextRequest) {
    // Per-IP rate limit on the bearer-token endpoint to blunt brute-force.
    const blocked = requireRate(request, { bucket: "device-heartbeat", windowMs: 60_000, max: 60 });
    if (blocked) return blocked;
    const body = await request.json() as {
        token: string;
        hostname?: string;
        os?: string;
        version?: string;
    };

    if (!body.token) {
        return NextResponse.json({ error: "Token required" }, { status: 400 });
    }

    // Lookup by token_hash (HMAC-SHA256). Legacy plaintext rows are
    // matched and backfilled-on-hit by `findDeviceByToken` so the
    // 0006 migration completes lazily as devices reconnect.
    const device = await findDeviceByToken(body.token);

    if (!device) {
        return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    await db.update(devices)
        .set({
            status: "online",
            hostname: body.hostname || device.hostname,
            os: body.os || device.os,
            version: body.version || device.version,
            lastSeenAt: new Date(),
        })
        .where(eq(devices.id, device.id));

    return NextResponse.json({ ok: true });
}
