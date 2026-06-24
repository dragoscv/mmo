/**
 * POST /api/devices/announce — companion heartbeat + command channel.
 * Wire-compatible with the legacy apps/web route so the companion can point
 * at the gateway with no protocol change.
 *
 * Request body (JSON):
 *   { token, lanUrl?, hostname?, os?, version?, results?, tunnelHostnameAck? }
 * Response (JSON):
 *   { ok, name, commands, tunnelBootstrap, lanUrl?|cleared? }
 */

import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { devices } from "../db/schema.js";
import { findDeviceByToken } from "../lib/device-token.js";
import { validateDeviceLanUrl } from "../lib/url-guard.js";
import {
    claimPendingCommands,
    recordCommandResults,
    type IncomingCommandResult,
} from "../lib/device-commands.js";
import { ensureDeviceTunnel } from "../lib/tunnel.js";

interface AnnounceBody {
    token?: string;
    lanUrl?: string | null;
    hostname?: string;
    os?: string;
    version?: string;
    results?: IncomingCommandResult[];
    tunnelHostnameAck?: string | null;
}

async function maybeTunnelBootstrap(
    deviceId: string,
    ack: string | null | undefined,
    lanUrl: string | null,
): Promise<{ tunnelHostname: string; tunnelToken: string } | null> {
    let port: number | undefined;
    if (lanUrl) {
        try { port = Number(new URL(lanUrl).port) || undefined; } catch { /* ignore */ }
    }
    const t = await ensureDeviceTunnel(deviceId, port ? { port } : {});
    if (!t) return null;
    if (ack === t.tunnelHostname) return null;
    return t;
}

export async function handleAnnounce(c: Context) {
    const body = await c.req.json().catch(() => null) as AnnounceBody | null;
    if (!body || typeof body !== "object" || typeof body.token !== "string") {
        return c.json({ error: "Invalid body" }, 400);
    }

    const device = await findDeviceByToken(body.token);
    if (!device) {
        return c.json({ error: "Invalid token" }, 401);
    }

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
        return c.json({ ok: true, cleared: true, name: device.name, commands, tunnelBootstrap });
    }

    if (body.lanUrl !== undefined) {
        const lanUrl = validateDeviceLanUrl(body.lanUrl);
        if (!lanUrl) {
            return c.json({ error: "Invalid lanUrl (must be private RFC1918 / ULA)" }, 400);
        }
        await db.update(devices)
            .set({ ...baseUpdate, lanUrl, lanAnnouncedAt: new Date() })
            .where(eq(devices.id, device.id));
        const commands = await claimPendingCommands(device.id);
        const tunnelBootstrap = await maybeTunnelBootstrap(device.id, body.tunnelHostnameAck, lanUrl);
        return c.json({ ok: true, lanUrl, name: device.name, commands, tunnelBootstrap });
    }

    await db.update(devices)
        .set(baseUpdate)
        .where(eq(devices.id, device.id));
    const commands = await claimPendingCommands(device.id);
    const tunnelBootstrap = await maybeTunnelBootstrap(device.id, body.tunnelHostnameAck, null);
    return c.json({ ok: true, name: device.name, commands, tunnelBootstrap });
}
