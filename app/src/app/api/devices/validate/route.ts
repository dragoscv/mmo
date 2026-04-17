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
    const device = db
        .select()
        .from(devices)
        .where(eq(devices.token, body.token))
        .get();

    if (!device) {
        return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    // Get user info
    const user = db
        .select()
        .from(users)
        .where(eq(users.id, device.userId))
        .get();

    // Update device status
    db.update(devices)
        .set({
            status: "online",
            hostname: body.hostname || device.hostname,
            lastSeenAt: new Date().toISOString(),
        })
        .where(eq(devices.id, device.id))
        .run();

    return NextResponse.json({
        deviceId: device.id,
        userName: user?.name || null,
        userEmail: user?.email || null,
        userImage: user?.image || null,
    });
}
