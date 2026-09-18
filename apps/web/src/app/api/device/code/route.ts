import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { deviceAuthCodes } from "@/db/schema";
import { requireRate } from "@/lib/api-guard";
import { ipFromRequest } from "@/lib/rate-limit";
import {
    DEVICE_CODE_POLL_INTERVAL_SEC,
    DEVICE_CODE_TTL_SEC,
    formatUserCode,
    generateDeviceCode,
    generateUserCode,
    hashDeviceCode,
} from "@/lib/device-code";

// Step 1 of the device-code login (TV / limited-input). No auth: the TV
// has nothing yet. Rate-limited per IP. See docs/aplicatie/pairing.md.

export const dynamic = "force-dynamic";

const BodySchema = z.object({
    deviceName: z.string().trim().min(1).max(80),
    platform: z.string().trim().min(1).max(40),
    appVersion: z.string().trim().max(40).optional(),
});

export async function POST(request: NextRequest) {
    const limited = requireRate(request, { bucket: "device-code", windowMs: 60_000, max: 10 });
    if (limited) return limited;

    let json: unknown;
    try { json = await request.json(); } catch { json = null; }
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) {
        return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const { deviceName, platform } = parsed.data;

    const deviceCode = generateDeviceCode();
    const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_SEC * 1000);
    const ip = ipFromRequest(request);

    // user_code is unique; retry a few times on the (rare) collision.
    let userCode = "";
    for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateUserCode();
        try {
            await db.insert(deviceAuthCodes).values({
                deviceCodeHash: hashDeviceCode(deviceCode),
                userCode: candidate,
                deviceName,
                platform,
                ip,
                expiresAt,
            });
            userCode = candidate;
            break;
        } catch (e) {
            const code = (e as { code?: string })?.code;
            if (code !== "23505") throw e;
        }
    }
    if (!userCode) {
        return NextResponse.json({ error: "server_error" }, { status: 500 });
    }

    const origin = request.nextUrl.origin;
    return NextResponse.json(
        {
            device_code: deviceCode,
            user_code: formatUserCode(userCode),
            verification_uri: `${origin}/activate`,
            verification_uri_complete: `${origin}/activate?code=${userCode}`,
            expires_in: DEVICE_CODE_TTL_SEC,
            interval: DEVICE_CODE_POLL_INTERVAL_SEC,
        },
        { headers: { "Cache-Control": "no-store" } },
    );
}
