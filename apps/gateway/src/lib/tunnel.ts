/**
 * ensureDeviceTunnel — ported from apps/web/src/actions/devices.ts.
 *
 * Idempotently provisions the per-device Cloudflare Tunnel and returns the
 * bootstrap token the companion needs to run `cloudflared`. Returns null
 * when Cloudflare isn't configured (companion falls back to LAN/queue).
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { devices } from "../db/schema.js";
import {
    createDeviceTunnel,
    getCloudflareConfig,
    updateDeviceTunnelIngress,
} from "./cloudflare.js";
import { decryptDeviceToken, encryptDeviceToken } from "./device-token.js";

// Per-instance memo so the announce/WS hot path doesn't call the CF API on
// every tick. Cloud Run instances are short-lived, so a cold instance just
// re-checks once.
const ingressPortByDevice = new Map<string, number>();
function shouldUpdateIngress(deviceId: string, port: number): boolean {
    return ingressPortByDevice.get(deviceId) !== port;
}
function rememberIngressPort(deviceId: string, port: number): void {
    ingressPortByDevice.set(deviceId, port);
}

export async function ensureDeviceTunnel(
    deviceId: string,
    opts: { port?: number } = {},
): Promise<{ tunnelHostname: string; tunnelToken: string } | null> {
    const cfg = getCloudflareConfig();
    if (!cfg) return null;
    const [row] = await db
        .select({
            id: devices.id,
            tunnelId: devices.tunnelId,
            tunnelHostname: devices.tunnelHostname,
            tunnelTokenEncrypted: devices.tunnelTokenEncrypted,
        })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
    if (!row) return null;
    if (row.tunnelId && row.tunnelHostname && row.tunnelTokenEncrypted) {
        try {
            const decoded = {
                tunnelHostname: row.tunnelHostname,
                tunnelToken: decryptDeviceToken(row.tunnelTokenEncrypted),
            };
            if (opts.port && shouldUpdateIngress(deviceId, opts.port)) {
                try {
                    await updateDeviceTunnelIngress(cfg, {
                        tunnelId: row.tunnelId,
                        hostname: row.tunnelHostname,
                        port: opts.port,
                    });
                    rememberIngressPort(deviceId, opts.port);
                } catch (err) {
                    console.warn("[tunnel] ingress update failed:", err instanceof Error ? err.message : err);
                }
            }
            return decoded;
        } catch { /* fall through and re-provision */ }
    }
    try {
        const t = await createDeviceTunnel(cfg, deviceId, opts);
        await db
            .update(devices)
            .set({
                tunnelId: t.tunnelId,
                tunnelHostname: t.hostname,
                tunnelTokenEncrypted: encryptDeviceToken(t.tunnelToken),
            })
            .where(eq(devices.id, deviceId));
        if (opts.port) rememberIngressPort(deviceId, opts.port);
        return { tunnelHostname: t.hostname, tunnelToken: t.tunnelToken };
    } catch (err) {
        console.warn("[tunnel] ensureDeviceTunnel failed:", err instanceof Error ? err.message : err);
        return null;
    }
}
