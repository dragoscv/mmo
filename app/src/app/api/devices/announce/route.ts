/**
 * POST /api/devices/announce
 *
 * Dual purpose:
 *   1. Heartbeat — sets devices.status=online + lastSeenAt every tick.
 *      Vercel can't probe the user's LAN, so this push is the only
 *      liveness signal for /devices.
 *   2. Command channel — carries pending companion commands (folder
 *      picker, audio enumeration, etc.) in the response, and accepts
 *      results posted from the companion in the request body. See
 *      lib/device-commands.ts for the WHY.
 *
 * Auth: bearer device token. SSRF defence via `validateDeviceLanUrl`.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireRate } from "@/lib/api-guard";
import { findDeviceByToken } from "@/lib/device-token";
import { validateDeviceLanUrl } from "@/lib/url-guard";
import {
    claimPendingCommands,
    recordCommandResults,
    type IncomingCommandResult,
} from "@/lib/device-commands";

export async function POST(request: NextRequest) {
    // Bumped from 30 to 240/min since announce now doubles as a ~3s
    // command poll. Per-device, so multi-device users scale fine.
    const blocked = requireRate(request, { bucket: "device-announce", windowMs: 60_000, max: 240 });
    if (blocked) return blocked;

    const body = await request.json().catch(() => null) as {
        token?: string;
        lanUrl?: string | null;
        hostname?: string;
        os?: string;
        version?: string;
        results?: IncomingCommandResult[];
    } | null;

    if (!body || typeof body !== "object" || typeof body.token !== "string") {
        return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const device = await findDeviceByToken(body.token);
    if (!device) {
        return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    // Persist any command results the companion is reporting BEFORE we
    // hand it new work, so awaiting server actions wake up faster.
    if (Array.isArray(body.results) && body.results.length > 0) {
        await recordCommandResults(device.id, body.results);
    }

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

    if (body.lanUrl === null) {
        await db.update(devices)
            .set({ ...baseUpdate, lanUrl: null, lanAnnouncedAt: new Date() })
            .where(eq(devices.id, device.id));
        const commands = await claimPendingCommands(device.id);
        return NextResponse.json({ ok: true, cleared: true, name: device.name, commands });
    }

    if (body.lanUrl !== undefined) {
        const lanUrl = validateDeviceLanUrl(body.lanUrl);
        if (!lanUrl) {
            return NextResponse.json({ error: "Invalid lanUrl (must be private RFC1918 / ULA)" }, { status: 400 });
        }
        await db.update(devices)
            .set({ ...baseUpdate, lanUrl, lanAnnouncedAt: new Date() })
            .where(eq(devices.id, device.id));
        const commands = await claimPendingCommands(device.id);
        return NextResponse.json({ ok: true, lanUrl, name: device.name, commands });
    }

    // No lanUrl in body — heartbeat + results-only ack.
    await db.update(devices)
        .set(baseUpdate)
        .where(eq(devices.id, device.id));
    const commands = await claimPendingCommands(device.id);
    return NextResponse.json({ ok: true, name: device.name, commands });
}
