/**
 * LAN discovery without mDNS/SSDP (Tizen web apps have neither): learn the
 * TV's own IPv4 + netmask from `webapis.network`, then sweep the /24 with
 * parallel `GET http://<ip>:17899/pair/info` probes (400 ms timeout, 32 at a
 * time). A dev override (`?scanHosts=a,b` or localStorage `mixai.scanHosts`)
 * replaces the sweep with an explicit host list so the sweep can be tested
 * against 127.0.0.1 / a specific server from a desktop browser.
 */
import { DEFAULT_PORT } from "./config";

export interface PairInfo {
    name: string;
    version: string;
    lanUrl: string | null;
    port: number;
    pairingSupported: boolean;
    hasToken: boolean;
}

export interface DiscoveredServer {
    /** `http://<ip>:<port>` — the URL we actually reached. */
    baseUrl: string;
    host: string;
    port: number;
    info: PairInfo | null;
}

export const PROBE_TIMEOUT_MS = 400;
export const PROBE_CONCURRENCY = 32;
export const SCAN_HOSTS_KEY = "mixai.scanHosts";

/** Explicit host list override (dev/test). `null` = do the real sweep. */
export function scanHostsOverride(): string[] | null {
    let raw: string | null = null;
    try {
        raw = new URLSearchParams(window.location.search).get("scanHosts");
        if (!raw) raw = localStorage.getItem(SCAN_HOSTS_KEY);
    } catch { /* file:// or storage disabled */ }
    if (!raw) return null;
    const hosts = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    return hosts.length ? hosts : null;
}

/** The TV's own IPv4 + netmask via the Samsung `webapis.network` API (null on desktop). */
export function localNetwork(): { ip: string; netmask: string } | null {
    try {
        const net = typeof webapis !== "undefined" ? webapis?.network : undefined;
        if (!net) return null;
        const ip = net.getIp();
        if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null;
        let netmask = "255.255.255.0";
        try { const m = net.getSubnetMask?.(); if (m && /^\d+\.\d+\.\d+\.\d+$/.test(m)) netmask = m; } catch { /* keep /24 */ }
        return { ip, netmask };
    } catch {
        return null;
    }
}

/** Hosts in the subnet of `ip`/`netmask`, capped to a /24 (bigger masks are truncated to the TV's /24). */
export function subnetHosts(ip: string, netmask = "255.255.255.0"): string[] {
    const ipN = ip.split(".").map(Number);
    const maskN = netmask.split(".").map(Number);
    if (ipN.length !== 4 || maskN.length !== 4 || ipN.some(isNaN) || maskN.some(isNaN)) return [];
    // Force at least a /24 so the sweep stays at ≤254 probes.
    const mask = maskN.map((m, i) => (i < 3 ? 255 : m));
    const base = ipN.map((o, i) => o & mask[i]!);
    const hostBits = 255 - mask[3]!;
    const out: string[] = [];
    for (let h = 1; h < Math.max(hostBits, 1) + 1 && h < 255; h++) {
        const last = base[3]! + h;
        if (last > 254) break;
        if (last === ipN[3]) continue; // skip ourselves
        out.push(`${base[0]}.${base[1]}.${base[2]}.${last}`);
    }
    return out;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
        return await fetch(url, { signal: ctl.signal, cache: "no-store" });
    } finally {
        clearTimeout(t);
    }
}

export async function fetchPairInfo(baseUrl: string, timeoutMs = 2500): Promise<PairInfo | null> {
    try {
        const res = await fetchWithTimeout(baseUrl + "/pair/info", timeoutMs);
        if (!res.ok) return null;
        const j = (await res.json()) as Partial<PairInfo>;
        if (typeof j.name !== "string" || typeof j.port !== "number") return null;
        return {
            name: j.name,
            version: typeof j.version === "string" ? j.version : "",
            lanUrl: typeof j.lanUrl === "string" ? j.lanUrl : null,
            port: j.port,
            pairingSupported: Boolean(j.pairingSupported),
            hasToken: Boolean(j.hasToken),
        };
    } catch {
        return null;
    }
}

export interface SweepOptions {
    hosts?: string[];
    port?: number;
    timeoutMs?: number;
    concurrency?: number;
    signal?: AbortSignal;
    onFound?: (s: DiscoveredServer) => void;
    onProgress?: (done: number, total: number) => void;
}

/**
 * Probe every host on port 17899. Resolves with all servers found; `onFound`
 * fires as each one answers so the UI can show cards progressively.
 */
export async function sweep(opts: SweepOptions = {}): Promise<DiscoveredServer[]> {
    const port = opts.port ?? DEFAULT_PORT;
    const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
    const concurrency = opts.concurrency ?? PROBE_CONCURRENCY;
    let hosts = opts.hosts;
    if (!hosts) {
        const override = scanHostsOverride();
        if (override) hosts = override;
        else {
            const net = localNetwork();
            hosts = net ? subnetHosts(net.ip, net.netmask) : [];
        }
    }
    const found: DiscoveredServer[] = [];
    let next = 0;
    let done = 0;
    const total = hosts.length;
    const worker = async () => {
        while (next < total && !opts.signal?.aborted) {
            const host = hosts![next++]!;
            const baseUrl = `http://${host}:${port}`;
            const info = await fetchPairInfo(baseUrl, timeoutMs);
            done++;
            opts.onProgress?.(done, total);
            if (info) {
                const s: DiscoveredServer = { baseUrl, host, port, info };
                found.push(s);
                opts.onFound?.(s);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    return found;
}
