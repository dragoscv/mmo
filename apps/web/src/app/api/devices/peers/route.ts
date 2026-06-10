/**
 * GET /api/devices/peers
 *
 * Returns the signed-in user's other companions' announced LAN URLs.
 * The browser uses this to discover a companion running on a sibling
 * device on the same LAN (e.g. a tablet reaching the desktop companion
 * via http://192.168.1.42:17899).
 *
 * No bearer tokens leak — only the apiUrl/lanUrl + a coarse
 * identification (name, hostname, lastSeen). The peer itself still
 * enforces auth on every route, so leaking the URL doesn't grant
 * access.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { eq } from "drizzle-orm";

// Stale-LAN threshold: 7 days. After that the URL is almost certainly
// pointing at a DHCP lease that's been recycled, so we don't surface it.
const LAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ peers: [] }, { status: 401 });

    const rows = await db.select({
        id: devices.id,
        name: devices.name,
        hostname: devices.hostname,
        os: devices.os,
        apiUrl: devices.apiUrl,
        lanUrl: devices.lanUrl,
        lanAnnouncedAt: devices.lanAnnouncedAt,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
    }).from(devices).where(eq(devices.userId, userId));

    const now = Date.now();
    const peers = rows
        .filter((r) => r.lanUrl)
        .filter((r) => !r.lanAnnouncedAt || (now - r.lanAnnouncedAt.getTime()) < LAN_TTL_MS)
        .map((r) => ({
            id: r.id,
            name: r.name,
            hostname: r.hostname,
            os: r.os,
            lanUrl: r.lanUrl!,
            lanAnnouncedAt: r.lanAnnouncedAt?.toISOString() ?? null,
            status: r.status,
            lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
        }));

    return NextResponse.json({ peers });
}
