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
import { ensureDeviceTunnel } from "@/actions/devices";

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
        /** Companion echoes the tunnel hostname it currently runs
         *  cloudflared against. Used by the server to decide whether
         *  to include `tunnelBootstrap` in the response (we only send
         *  the secret token when the companion needs it). */
        tunnelHostnameAck?: string | null;
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
        const tunnelBootstrap = await maybeTunnelBootstrap(device.id, body.tunnelHostnameAck, null);
        return NextResponse.json({ ok: true, cleared: true, name: device.name, commands, tunnelBootstrap });
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
        const tunnelBootstrap = await maybeTunnelBootstrap(device.id, body.tunnelHostnameAck, lanUrl);
        return NextResponse.json({ ok: true, lanUrl, name: device.name, commands, tunnelBootstrap });
    }

    // No lanUrl in body — heartbeat + results-only ack.
    await db.update(devices)
        .set(baseUpdate)
        .where(eq(devices.id, device.id));
    const commands = await claimPendingCommands(device.id);
    const tunnelBootstrap = await maybeTunnelBootstrap(device.id, body.tunnelHostnameAck, null);
    return NextResponse.json({ ok: true, name: device.name, commands, tunnelBootstrap });
}

/**
 * Returns the cloudflared bootstrap (token + hostname) the companion
 * should run, OR null when:
 *  - Cloudflare is not configured at all (ensureDeviceTunnel → null);
 *  - The companion has already ACKed the matching hostname (token
 *    already in its electron-store; no point re-sending the secret on
 *    every 3s heartbeat).
 *
 * Provisioning is idempotent so it's safe to call on every heartbeat —
 * if the device row already has tunnel cols set, no CF API calls happen.
 */
async function maybeTunnelBootstrap(
    deviceId: string,
    ack: string | null | undefined,
    lanUrl: string | null,
): Promise<{ tunnelHostname: string; tunnelToken: string } | null> {
    // Extract the port the companion is actually serving on (it can be
    // customised away from the default 17899). Passed into ensureDeviceTunnel
    // so the CF ingress config stays aligned with reality.
    let port: number | undefined;
    if (lanUrl) {
        try { port = Number(new URL(lanUrl).port) || undefined; } catch { /* ignore */ }
    }
    // Always reconcile to a concrete port: fall back to the standard 17899 when
    // the companion didn't include a lanUrl (heartbeat/results-only ticks). This
    // self-heals tunnels created under the old 9876 default whose remote ingress
    // still points at the wrong port → otherwise cloudflared proxies to a closed
    // port and the device shows "offline" (504) forever.
    const t = await ensureDeviceTunnel(deviceId, { port: port ?? 17899 });
    if (!t) return null;
    if (ack === t.tunnelHostname) return null;
    return t;
}
