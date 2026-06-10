import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { rateLimit } from "@/lib/rate-limit";
import { issueDeviceToken, materializeDeviceToken } from "@/lib/device-token";
import { validateDeviceApiUrl } from "@/lib/url-guard";

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1h
    max: 10,
    name: "device-auto-register",
});

// SSRF guard for `apiUrl` strings the user (or their compromised companion)
// can submit. The web app issues authenticated `fetch(device.apiUrl + ...)`
// calls server-side from /api/audio/device/[id], pingDevice, scan, etc., so
// a hostile apiUrl turns the Next.js process into an SSRF gadget hitting
// internal services with whatever ambient network access it has (cloud
// metadata, k8s API, RDS, neighbouring tenants).
//
// The predicate + escape hatch (MMO_ALLOW_PRIVATE_DEVICE_URLS=1) live in
// `@/lib/url-guard` so download/info and any other route forwarding
// user-supplied URLs share one implementation.


export async function POST(request: NextRequest) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Per-user rate limit. Unbounded auto-register would let a signed-in
    // user spam the devices table (storage exhaustion) and then point
    // dozens of `apiUrl`s at SSRF targets in parallel.
    const limited = registerLimiter.check(session.user.id);
    if (limited) return limited;

    const body = await request.json().catch(() => null) as {
        hostname?: string;
        os?: string;
        port?: number;
        apiUrl?: string;
    } | null;
    if (!body || typeof body !== "object") {
        return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    // Length caps on every user-controlled string we persist.
    const trim = (v: unknown, max: number): string | null => {
        if (v == null) return "";
        if (typeof v !== "string") return null;
        if (v.length > max) return null;
        return v;
    };
    const hostname = trim(body.hostname, 128);
    const osName = trim(body.os, 64);
    if (hostname === null || osName === null) {
        return NextResponse.json({ error: "Field too long" }, { status: 400 });
    }

    const port = typeof body.port === "number" && body.port > 0 && body.port < 65536
        ? body.port : 17899;
    const rawApiUrl = body.apiUrl || `http://localhost:${port}`;
    const apiUrl = validateDeviceApiUrl(rawApiUrl);
    if (!apiUrl) {
        return NextResponse.json({ error: "Invalid apiUrl" }, { status: 400 });
    }

    const finalHostname = hostname || "unknown";

    // Check for existing device with same hostname for this user (avoid duplicates)
    const existingRows = await db
        .select()
        .from(devices)
        .where(and(
            eq(devices.userId, session.user.id),
            eq(devices.hostname, finalHostname)
        ))
        .limit(1);
    const existing = existingRows[0];

    if (existing) {
        // Update and return existing device. Materialize the bearer for the
        // companion (decrypts the at-rest envelope; legacy plaintext rows
        // are upgraded to the new columns inside materializeDeviceToken).
        await db.update(devices)
            .set({
                status: "online",
                apiUrl,
                os: osName || existing.os,
                lastSeenAt: new Date(),
            })
            .where(eq(devices.id, existing.id));

        const plaintextToken = await materializeDeviceToken(existing);
        if (!plaintextToken) {
            return NextResponse.json({ error: "Device token unavailable" }, { status: 500 });
        }
        return NextResponse.json({
            deviceId: existing.id,
            token: plaintextToken,
            userName: session.user.name,
            userEmail: session.user.email,
            userImage: session.user.image,
        });
    }

    // Create new device — issue a fresh bearer; only the hash + ciphertext
    // are persisted (token plaintext column stays null on new rows).
    const issued = issueDeviceToken();
    const deviceId = crypto.randomUUID();
    const deviceName = finalHostname !== "unknown"
        ? finalHostname
        : osName === "win32" ? "Windows PC"
        : osName === "darwin" ? "Mac"
        : osName === "linux" ? "Linux PC"
        : "Device";

    await db.insert(devices).values({
        id: deviceId,
        userId: session.user.id,
        name: deviceName,
        tokenHash: issued.hash,
        tokenEncrypted: issued.encrypted,
        apiUrl,
        status: "online",
        hostname: finalHostname,
        os: osName,
        lastSeenAt: new Date(),
    });

    return NextResponse.json({
        deviceId,
        token: issued.plaintext,
        userName: session.user.name,
        userEmail: session.user.email,
        userImage: session.user.image,
    });
}
