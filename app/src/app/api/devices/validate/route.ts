import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { devices, users } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
    const body = await request.json() as { token: string; hostname?: string };

    if (!body.token) {
        return NextResponse.json({ error: "Token required" }, { status: 400 });
    }

    // Find device by token
    const deviceRows = await db
        .select()
        .from(devices)
        .where(eq(devices.token, body.token))
        .limit(1);
    const device = deviceRows[0];

    if (!device) {
        return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    // Get user info
    const userRows = await db
        .select()
        .from(users)
        .where(eq(users.id, device.userId))
        .limit(1);
    const user = userRows[0];

    // Update device status
    await db.update(devices)
        .set({
            status: "online",
            hostname: body.hostname || device.hostname,
            lastSeenAt: new Date(),
        })
        .where(eq(devices.id, device.id));

    return NextResponse.json({
        deviceId: device.id,
        userName: user?.name || null,
        userEmail: user?.email || null,
        userImage: user?.image || null,
    });
}
