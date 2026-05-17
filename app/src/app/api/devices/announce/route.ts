/**
 * POST /api/devices/announce
 *
 * Called by the companion at startup (and after network changes — Wi-Fi
 * roam, VPN toggle) to publish its non-loopback LAN URL. The web app
 * stores it in `devices.lan_url` so the user's other devices (tablet,
 * TV, second laptop) can reach this companion without mDNS / Bonjour
 * support in the browser.
 *
 * Auth: bearer device token. SSRF defence via `validateDeviceLanUrl`
 * — only RFC1918 + IPv6 ULA hosts are accepted.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireRate } from "@/lib/api-guard";
import { findDeviceByToken } from "@/lib/device-token";
import { validateDeviceLanUrl } from "@/lib/url-guard";

export async function POST(request: NextRequest) {
    const blocked = requireRate(request, { bucket: "device-announce", windowMs: 60_000, max: 30 });
    if (blocked) return blocked;

    const body = await request.json().catch(() => null) as {
        token?: string;
        lanUrl?: string | null;
        hostname?: string;
        os?: string;
        version?: string;
    } | null;

    if (!body || typeof body !== "object" || typeof body.token !== "string") {
        return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const device = await findDeviceByToken(body.token);
    if (!device) {
        return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    // The announce loop doubles as our heartbeat: every successful
    // call refreshes `status` + `lastSeenAt`, which is how /devices
    // decides whether to render the green dot. Vercel can't reach the
    // user's LAN to do an active /health probe, so this push-based
    // signal is the only reliable liveness source.
    const baseUpdate = {
        status: "online" as const,
        lastSeenAt: new Date(),
        hostname: typeof body.hostname === "string" && body.hostname.length > 0 && body.hostname.length <= 128
            ? body.hostname : device.hostname,
        os: typeof body.os === "string" && body.os.length > 0 && body.os.length <= 64
            ? body.os : device.os,
        version: typeof body.version === "string" && body.version.length > 0 && body.version.length <= 32
            ? body.version : device.version,
    };

    // Allow `lanUrl: null` to clear a previously-announced LAN URL
    // (companion went headless / VPN-only).
    if (body.lanUrl === null) {
        await db.update(devices)
            .set({ ...baseUpdate, lanUrl: null, lanAnnouncedAt: new Date() })
            .where(eq(devices.id, device.id));
        return NextResponse.json({ ok: true, cleared: true, name: device.name });
    }

    const lanUrl = validateDeviceLanUrl(body.lanUrl);
    if (!lanUrl) {
        return NextResponse.json({ error: "Invalid lanUrl (must be private RFC1918 / ULA)" }, { status: 400 });
    }

    await db.update(devices)
        .set({ ...baseUpdate, lanUrl, lanAnnouncedAt: new Date() })
        .where(eq(devices.id, device.id));

    return NextResponse.json({ ok: true, lanUrl, name: device.name });
}
