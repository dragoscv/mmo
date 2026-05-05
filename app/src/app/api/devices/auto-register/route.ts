import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function POST(request: NextRequest) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await request.json() as {
        hostname?: string;
        os?: string;
        port?: number;
        apiUrl?: string;
    };

    const hostname = body.hostname || "unknown";
    const osName = body.os || "";
    const apiUrl = body.apiUrl || `http://localhost:${body.port || 17899}`;

    // Check for existing device with same hostname for this user (avoid duplicates)
    const existingRows = await db
        .select()
        .from(devices)
        .where(and(
            eq(devices.userId, session.user.id),
            eq(devices.hostname, hostname)
        ))
        .limit(1);
    const existing = existingRows[0];

    if (existing) {
        // Update and return existing device
        await db.update(devices)
            .set({
                status: "online",
                apiUrl,
                os: osName || existing.os,
                lastSeenAt: new Date(),
            })
            .where(eq(devices.id, existing.id));

        return NextResponse.json({
            deviceId: existing.id,
            token: existing.token,
            userName: session.user.name,
            userEmail: session.user.email,
            userImage: session.user.image,
        });
    }

    // Create new device
    const token = crypto.randomUUID() + "-" + crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    const deviceName = hostname !== "unknown"
        ? hostname
        : osName === "win32" ? "Windows PC"
        : osName === "darwin" ? "Mac"
        : osName === "linux" ? "Linux PC"
        : "Device";

    await db.insert(devices).values({
        id: deviceId,
        userId: session.user.id,
        name: deviceName,
        token,
        apiUrl,
        status: "online",
        hostname,
        os: osName,
        lastSeenAt: new Date(),
    });

    return NextResponse.json({
        deviceId,
        token,
        userName: session.user.name,
        userEmail: session.user.email,
        userImage: session.user.image,
    });
}
