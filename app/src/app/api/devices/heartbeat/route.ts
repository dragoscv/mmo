import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
    const body = await request.json() as {
        token: string;
        hostname?: string;
        os?: string;
        version?: string;
    };

    if (!body.token) {
        return NextResponse.json({ error: "Token required" }, { status: 400 });
    }

    const device = db
        .select()
        .from(devices)
        .where(eq(devices.token, body.token))
        .get();

    if (!device) {
        return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    db.update(devices)
        .set({
            status: "online",
            hostname: body.hostname || device.hostname,
            os: body.os || device.os,
            version: body.version || device.version,
            lastSeenAt: new Date().toISOString(),
        })
        .where(eq(devices.id, device.id))
        .run();

    return NextResponse.json({ ok: true });
}
