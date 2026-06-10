/**
 * Direct-to-companion fetch via the per-device Cloudflare Tunnel.
 *
 * Why this beats the announce queue:
 *  - Queue:  browser → Vercel → Postgres insert → companion polls in
 *            up to 750ms → executes → companion POSTs result → next
 *            poll → server action resolves. P50 ≈ 2.5s.
 *  - Direct: browser → CF edge → companion. P50 ≈ 30-80ms anywhere.
 *
 * Auth: `X-Device-Token` header. The plaintext bearer is fetched once
 * per session via `getDeviceBearerForOwner()` and cached in memory
 * (never persisted). Trust boundary is identical to the existing
 * session — XSS on muzicai.ro already grants full device control via
 * the queue-based actions.
 *
 * Returns `null` on ANY failure (network, CORS, 4xx, 5xx, timeout) so
 * the caller falls back to the slow queue path without throwing. The
 * goal is "fast when it works, never broken when it doesn't".
 */

const DEFAULT_TIMEOUT_MS = 5000;

export interface DirectFetchTarget {
    tunnelHostname: string;
    bearer: string;
}

export async function directFetch<T>(
    target: DirectFetchTarget,
    path: string,
    init: RequestInit = {},
    opts: { timeoutMs?: number } = {},
): Promise<T | null> {
    if (!target.tunnelHostname || !target.bearer) return null;
    const url = `https://${target.tunnelHostname}${path}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const t0 = performance.now();
    try {
        const res = await fetch(url, {
            ...init,
            headers: {
                "X-Device-Token": target.bearer,
                Accept: "application/json",
                ...(init.body ? { "Content-Type": "application/json" } : {}),
                ...(init.headers ?? {}),
            },
            signal: ac.signal,
            // Direct tunnel fetches must never carry session cookies;
            // they only need the device token header.
            credentials: "omit",
            cache: "no-store",
        });
        const ms = Math.round(performance.now() - t0);
        if (!res.ok) {
            console.warn(`[direct] ${init.method ?? "GET"} ${path} → ${res.status} in ${ms}ms`);
            return null;
        }
        console.log(`[direct] ${init.method ?? "GET"} ${path} → ok in ${ms}ms`);
        return await res.json() as T;
    } catch (err) {
        const ms = Math.round(performance.now() - t0);
        console.warn(`[direct] ${init.method ?? "GET"} ${path} → fail in ${ms}ms`, err);
        return null;
    } finally {
        clearTimeout(t);
    }
}
