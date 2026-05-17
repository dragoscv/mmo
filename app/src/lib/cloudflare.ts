/**
 * Cloudflare Tunnel provisioning client.
 *
 * Why this exists: the browser at https://muzicai.ro cannot reach the
 * companion at http://192.168.x.x:17899 — mixed-content + Private
 * Network Access kill it. Instead we give every device its own named
 * Cloudflare Tunnel: the companion runs `cloudflared --token <t>` which
 * opens an outbound QUIC connection to the CF edge; the browser fetches
 * https://device-<id>.devices.muzicai.ro which the edge proxies to the
 * companion's localhost:17899. End-to-end ~30-80ms anywhere on the
 * planet, real HTTPS, no LAN games.
 *
 * Flow per device:
 *   1. POST /accounts/{id}/cfd_tunnel              → {id, token}
 *   2. PUT  /accounts/{id}/cfd_tunnel/{id}/configurations → ingress
 *   3. POST /zones/{zid}/dns_records               → CNAME → cfargotunnel
 *
 * Teardown (when device unpaired):
 *   1. DELETE /zones/{zid}/dns_records/{recordId}
 *   2. DELETE /accounts/{id}/cfd_tunnel/{id}
 *
 * All required env vars are documented in app/.env.example.
 * Returns null from helpers when env is unconfigured so the rest of
 * the app gracefully falls back to the announce-queue transport.
 */

const CF_API = "https://api.cloudflare.com/client/v4";

export interface CloudflareConfig {
    apiToken: string;
    accountId: string;
    zoneId: string;
    baseHostname: string; // e.g. "devices.muzicai.ro"
}

export function getCloudflareConfig(): CloudflareConfig | null {
    // Vercel env values pasted via CLI can carry trailing CR/LF; trim
    // before use so the resulting hostname stays a valid URL host.
    const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const zoneId = process.env.CLOUDFLARE_TUNNEL_ZONE_ID?.trim();
    const baseHostname = process.env.CLOUDFLARE_TUNNEL_BASE_HOSTNAME?.trim();
    if (!apiToken || !accountId || !zoneId || !baseHostname) return null;
    return { apiToken, accountId, zoneId, baseHostname };
}

export interface ProvisionedTunnel {
    tunnelId: string;
    tunnelToken: string;
    hostname: string;
    dnsRecordId: string;
}

interface CFEnvelope<T> {
    success: boolean;
    errors: { code: number; message: string }[];
    result: T;
}

async function cf<T>(cfg: CloudflareConfig, path: string, init: RequestInit): Promise<T> {
    const res = await fetch(`${CF_API}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${cfg.apiToken}`,
            "Content-Type": "application/json",
            ...(init.headers ?? {}),
        },
    });
    const body = await res.json().catch(() => null) as CFEnvelope<T> | null;
    if (!res.ok || !body || !body.success) {
        const msg = body?.errors?.map((e) => `[${e.code}] ${e.message}`).join("; ") ?? `HTTP ${res.status}`;
        throw new Error(`Cloudflare API ${init.method ?? "GET"} ${path}: ${msg}`);
    }
    return body.result;
}

/** Generate a URL-safe host fragment from a UUID — first 12 chars of
 *  hex, lowercase. Stable per device so users can bookmark. */
export function deviceHostSlug(deviceId: string): string {
    return deviceId.replace(/-/g, "").slice(0, 12).toLowerCase();
}

/**
 * Create a tunnel + ingress config + DNS record. Companion port default
 * 17899 (companion HTTP server).
 */
export async function createDeviceTunnel(
    cfg: CloudflareConfig,
    deviceId: string,
    opts: { port?: number } = {},
): Promise<ProvisionedTunnel> {
    const port = opts.port ?? 17899;
    const slug = deviceHostSlug(deviceId);
    const hostname = `device-${slug}.${cfg.baseHostname}`;
    const name = `mmo-device-${slug}`;

    // 1. Create tunnel. We use a remotely-managed tunnel (config_src:
    //    "cloudflare") so we can update ingress via the API later
    //    without touching the companion config file.
    const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const created = await createTunnelHandlingCollision(cfg, name, secret);

    // 2. Set ingress. Order matters — the catch-all 404 must be last.
    await cf<unknown>(
        cfg,
        `/accounts/${cfg.accountId}/cfd_tunnel/${created.id}/configurations`,
        {
            method: "PUT",
            body: JSON.stringify({
                config: {
                    ingress: [
                        { hostname, service: `http://localhost:${port}` },
                        { service: "http_status:404" },
                    ],
                },
            }),
        },
    );

    // 3. CNAME the hostname at our zone. Proxied (orange cloud) so CF
    //    terminates TLS and routes via the tunnel.
    await deleteStaleDnsByName(cfg, hostname);
    const dns = await cf<{ id: string }>(
        cfg,
        `/zones/${cfg.zoneId}/dns_records`,
        {
            method: "POST",
            body: JSON.stringify({
                type: "CNAME",
                name: hostname,
                content: `${created.id}.cfargotunnel.com`,
                proxied: true,
                ttl: 1,
                comment: `mmo-device:${deviceId}`,
            }),
        },
    );

    return { tunnelId: created.id, tunnelToken: created.token, hostname, dnsRecordId: dns.id };
}

/**
 * Create a tunnel; if a tunnel with the same name already exists (CF
 * error 1013), force-delete the orphan and retry. Re-provisioning a
 * device whose DB row was wiped (or whose hostname pattern changed) is
 * the only legitimate path through here, so collision == stale.
 */
async function createTunnelHandlingCollision(
    cfg: CloudflareConfig,
    name: string,
    secret: string,
): Promise<{ id: string; token: string }> {
    try {
        return await cf<{ id: string; token: string }>(
            cfg,
            `/accounts/${cfg.accountId}/cfd_tunnel`,
            {
                method: "POST",
                body: JSON.stringify({ name, tunnel_secret: secret, config_src: "cloudflare" }),
            },
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("[1013]")) throw err;
        // List by name, delete any matches with ?cascade (forces removal
        // even if a stale cloudflared replica is still holding connections).
        const list = await cf<Array<{ id: string }>>(
            cfg,
            `/accounts/${cfg.accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
            { method: "GET" },
        ).catch(() => [] as Array<{ id: string }>);
        for (const t of list) {
            try {
                await cf<unknown>(
                    cfg,
                    `/accounts/${cfg.accountId}/cfd_tunnel/${t.id}?cascade=true`,
                    { method: "DELETE" },
                );
            } catch { /* ignore — best-effort cleanup */ }
        }
        return cf<{ id: string; token: string }>(
            cfg,
            `/accounts/${cfg.accountId}/cfd_tunnel`,
            {
                method: "POST",
                body: JSON.stringify({ name, tunnel_secret: secret, config_src: "cloudflare" }),
            },
        );
    }
}

/** DNS record collisions are common after a stale tunnel cleanup —
 *  the CNAME outlives the tunnel. Remove any matching record before
 *  we recreate so the POST below doesn't 81057 fail. */
async function deleteStaleDnsByName(cfg: CloudflareConfig, hostname: string): Promise<void> {
    const list = await cf<Array<{ id: string }>>(
        cfg,
        `/zones/${cfg.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`,
        { method: "GET" },
    ).catch(() => [] as Array<{ id: string }>);
    for (const r of list) {
        try {
            await cf<unknown>(cfg, `/zones/${cfg.zoneId}/dns_records/${r.id}`, { method: "DELETE" });
        } catch { /* ignore */ }
    }
}

/** Best-effort teardown. Swallows individual errors so a partial state
 *  (e.g. tunnel already deleted manually) still cleans up the rest. */
export async function deleteDeviceTunnel(
    cfg: CloudflareConfig,
    args: { tunnelId: string; dnsRecordId?: string },
): Promise<void> {
    if (args.dnsRecordId) {
        try {
            await cf<unknown>(cfg, `/zones/${cfg.zoneId}/dns_records/${args.dnsRecordId}`, {
                method: "DELETE",
            });
        } catch (err) {
            console.warn("[cloudflare] dns delete failed:", err instanceof Error ? err.message : err);
        }
    }
    try {
        await cf<unknown>(cfg, `/accounts/${cfg.accountId}/cfd_tunnel/${args.tunnelId}`, {
            method: "DELETE",
        });
    } catch (err) {
        console.warn("[cloudflare] tunnel delete failed:", err instanceof Error ? err.message : err);
    }
}
