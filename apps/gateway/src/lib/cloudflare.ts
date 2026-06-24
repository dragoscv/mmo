/**
 * Cloudflare Tunnel provisioning client.
 * Ported verbatim from apps/web/src/lib/cloudflare.ts. Keep in sync.
 *
 * Per device: create a remotely-managed tunnel, set ingress to
 * localhost:<port>, CNAME device-<slug>.<base> → <id>.cfargotunnel.com.
 * Helpers return null / throw on misconfig so callers fall back to the
 * announce-queue transport.
 */

const CF_API = "https://api.cloudflare.com/client/v4";

export interface CloudflareConfig {
    apiToken: string;
    accountId: string;
    zoneId: string;
    baseHostname: string;
}

export function getCloudflareConfig(): CloudflareConfig | null {
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

export function deviceHostSlug(deviceId: string): string {
    return deviceId.replace(/-/g, "").slice(0, 12).toLowerCase();
}

export async function createDeviceTunnel(
    cfg: CloudflareConfig,
    deviceId: string,
    opts: { port?: number } = {},
): Promise<ProvisionedTunnel> {
    const port = opts.port ?? 17899;
    const slug = deviceHostSlug(deviceId);
    const hostname = `device-${slug}.${cfg.baseHostname}`;
    const name = `mmo-device-${slug}`;

    const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const created = await createTunnelHandlingCollision(cfg, name, secret);

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
            } catch { /* best-effort */ }
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

export async function updateDeviceTunnelIngress(
    cfg: CloudflareConfig,
    args: { tunnelId: string; hostname: string; port: number },
): Promise<void> {
    await cf<unknown>(
        cfg,
        `/accounts/${cfg.accountId}/cfd_tunnel/${args.tunnelId}/configurations`,
        {
            method: "PUT",
            body: JSON.stringify({
                config: {
                    ingress: [
                        { hostname: args.hostname, service: `http://localhost:${args.port}` },
                        { service: "http_status:404" },
                    ],
                },
            }),
        },
    );
}
