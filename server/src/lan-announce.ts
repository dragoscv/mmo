/**
 * LAN announce + (optional) mDNS broadcast.
 *
 * Why this exists:
 *  - The web app's loopback discovery (`probe(127.0.0.1) || probe(localhost)`)
 *    only works when the BROWSER runs on the same machine as the
 *    companion. A tablet on the couch hitting muzicai.ro can't reach
 *    `http://127.0.0.1:17899` because that loopback is its own.
 *  - Solution: the companion enumerates its non-loopback IPv4
 *    interfaces, picks a stable one, and POSTs the URL to
 *    `${webAppUrl}/api/devices/announce` using the paired bearer
 *    token. The web app stores it; sibling devices then call
 *    `/api/devices/peers` and probe the LAN URL directly.
 *  - As a bonus we publish an mDNS / Bonjour record
 *    (`_mmo-companion._tcp.local`) so native MMO apps (iOS, Android,
 *    smart-TV shells) can find us without going through the cloud.
 *
 * Re-announces on Wi-Fi changes via the renderer (not yet wired —
 * scheduled on a 5 min timer for now, which is good enough for
 * typical roam events).
 */

import os from "node:os";
import { Bonjour, type Service } from "bonjour-service";
import { getSettings, store } from "./store";
import { executeCommands, type InboundCommand, type OutboundResult } from "./command-worker";
import { startCloudflared } from "./cloudflared";
import { log } from "./logger";

// 3 s heartbeat. The announce loop doubles as:
//   - liveness signal: Vercel uses the lastSeenAt timestamp to render
//     the green dot on /devices (must stay < 90 s to count as online).
//   - command channel: response carries pending device commands (folder
//     picker, audio enumeration, etc.) and request body carries results
//     from the previous batch. See lib/device-commands.ts on the web.
// 3 s is the tradeoff: fast enough that a user clicking "Pick Folder"
// sees the dialog within a couple seconds, slow enough that we don't
// drown Vercel in invocations for an idle device (~20 req/min/device).
const RE_ANNOUNCE_INTERVAL_MS = 3 * 1000;
// When a command was just delivered, re-poll faster for a short burst
// so multi-step flows (pick → kind → watch toggle) feel snappy.
const BURST_INTERVAL_MS = 750;
const BURST_DURATION_MS = 20_000;
const SERVICE_NAME = "MMO Companion";
const SERVICE_TYPE = "mmo-companion";

let timer: NodeJS.Timeout | null = null;
let bonjourInstance: Bonjour | null = null;
let bonjourService: Service | null = null;
let lastAnnouncedUrl: string | null = null;
let currentVersion = "0.0.0";
let onDeviceNameCb: ((name: string) => void) | null = null;
let pendingResults: OutboundResult[] = [];
let burstUntil = 0;

/**
 * Pick the most useful non-loopback IPv4 address. Prefers (in order):
 *   1. The first interface whose name does NOT start with `vEthernet`,
 *      `Loopback`, `vmnet`, `vbox`, `docker`, `WSL`, `Tailscale`,
 *      `utun` (virtual / VPN) so we report the user's real Wi-Fi /
 *      Ethernet IP rather than a Docker bridge.
 *   2. Any IPv4 we can find.
 * Returns null when offline.
 */
export function pickLanAddress(): string | null {
    const blocked = /^(vEthernet|Loopback|vmnet|vbox|docker|WSL|Tailscale|utun|tap)/i;
    const ifaces = os.networkInterfaces();
    const candidates: { name: string; address: string; preferred: boolean }[] = [];
    for (const [name, list] of Object.entries(ifaces)) {
        if (!list) continue;
        for (const entry of list) {
            if (entry.family !== "IPv4") continue;
            if (entry.internal) continue;
            // Skip APIPA / link-local 169.254.* (no actual network).
            if (entry.address.startsWith("169.254.")) continue;
            candidates.push({
                name,
                address: entry.address,
                preferred: !blocked.test(name),
            });
        }
    }
    if (candidates.length === 0) return null;
    const preferred = candidates.find((c) => c.preferred);
    return (preferred ?? candidates[0]).address;
}

/** Build the URL the web app should store: `http://<lan-ip>:<port>`. */
export function buildLanUrl(port: number): string | null {
    const ip = pickLanAddress();
    if (!ip) return null;
    return `http://${ip}:${port}`;
}

/**
 * POST `{ token, lanUrl }` to the paired web app. Best-effort — silent
 * failure when the cloud is unreachable (we'll retry on the next
 * interval) or when the user hasn't paired yet.
 */
async function postAnnounce(lanUrl: string | null): Promise<void> {
    const settings = getSettings();
    const webAppUrl = settings.webAppUrl || "https://muzicai.ro";
    const token = store.get("deviceToken") as string | undefined;
    if (!token) return; // not paired yet

    // Drain results from the previous tick. If the POST fails we re-queue.
    const sending = pendingResults;
    pendingResults = [];

    try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 8000);
        const localTunnelHostname = (store.get("tunnelHostname") as string | undefined) || null;
        const res = await fetch(`${webAppUrl}/api/devices/announce`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                token,
                lanUrl,
                hostname: os.hostname(),
                os: process.platform,
                version: currentVersion,
                results: sending.length > 0 ? sending : undefined,
                // ACK lets the server skip resending the secret token
                // on every 3s heartbeat — only sent when missing or stale.
                tunnelHostnameAck: localTunnelHostname,
            }),
            signal: ac.signal,
        }).finally(() => clearTimeout(t));

        if (res.status === 401 && onAuthInvalidatedCb) {
            // Token rejected — surrender the results we tried to send;
            // re-pairing will produce fresh command rows anyway.
            try { onAuthInvalidatedCb("announce-401"); } catch { /* ignore */ }
            return;
        }
        if (!res.ok) {
            // Server error — re-queue results so we don't drop them.
            pendingResults = sending.concat(pendingResults);
            return;
        }

        const data = await res.json().catch(() => null) as {
            name?: string;
            commands?: InboundCommand[];
            tunnelBootstrap?: { tunnelHostname: string; tunnelToken: string } | null;
        } | null;
        if (!data) return;

        if (data.name && onDeviceNameCb) {
            try { onDeviceNameCb(data.name); } catch { /* ignore */ }
        }

        // Persist + start cloudflared when the server hands us a new
        // bootstrap. Idempotent — startCloudflared no-ops if the same
        // token is already running.
        if (data.tunnelBootstrap?.tunnelHostname && data.tunnelBootstrap.tunnelToken) {
            const b = data.tunnelBootstrap;
            const prevHost = store.get("tunnelHostname") as string | undefined;
            store.set("tunnelHostname", b.tunnelHostname);
            store.set("tunnelToken", b.tunnelToken);
            log("info", `[announce] tunnelBootstrap received host=${b.tunnelHostname} (prev=${prevHost ?? "none"})`);
            try { startCloudflared(b.tunnelToken, b.tunnelHostname); }
            catch (err) { log("warn", "[lan-announce] cloudflared start failed:", err); }
        }

        if (Array.isArray(data.commands) && data.commands.length > 0) {
            burstUntil = Date.now() + BURST_DURATION_MS;
            log("info", `[announce] received n=${data.commands.length} kinds=${data.commands.map((c) => c.kind).join(",")}`);
            const t0 = Date.now();
            // Execute sequentially so dialog-based commands don't race.
            const results = await executeCommands(data.commands);
            log("info", `[announce] executed n=${results.length} in ${Date.now() - t0}ms — posting back`);
            pendingResults.push(...results);
            // Trigger an immediate follow-up tick so results reach the
            // awaiting server action without waiting a full interval.
            queueMicrotask(() => { void postAnnounce(lanUrl); });
        }
    } catch (err) {
        // Network down — re-queue so results survive the retry. Surface
        // the underlying cause (undici hides it under `cause`) so this
        // loop's failures are diagnosable: a quietly-broken announce
        // loop is the #1 cause of the queue-based UI actions appearing
        // to "do nothing" for tens of seconds at a time.
        pendingResults = sending.concat(pendingResults);
        const root = (err as { cause?: unknown })?.cause ?? err;
        const code = (root as { code?: string })?.code;
        const msg = root instanceof Error ? `${root.name}: ${root.message}` : String(root);
        log("warn", `[announce] post failed${code ? ` [${code}]` : ""} — ${msg}`);
    }
}

let onAuthInvalidatedCb: ((reason: string) => void) | null = null;

/** Register a callback invoked when /api/devices/announce returns 401.
 *  Set once at startup from main.ts to wire into invalidateLocalPairing. */
export function setOnAuthInvalidated(cb: ((reason: string) => void) | null): void {
    onAuthInvalidatedCb = cb;
}

/** Register a callback invoked when the cloud reports our display name.
 *  Set once at startup so main.ts can persist it for the renderer UI. */
export function setOnDeviceName(cb: ((name: string) => void) | null): void {
    onDeviceNameCb = cb;
}

function startBonjour(port: number, version: string): void {
    if (bonjourInstance) return;
    try {
        bonjourInstance = new Bonjour();
        const hostname = os.hostname();
        bonjourService = bonjourInstance.publish({
            name: `${SERVICE_NAME} (${hostname})`,
            type: SERVICE_TYPE,
            port,
            // TXT record exposes product + version so native discovery
            // clients can sanity-check before talking to us.
            txt: {
                product: "MMOCompanion",
                version,
                api: "/audio/native/probe",
            },
        });
    } catch (err) {
        console.warn("[lan-announce] mDNS publish failed:", err instanceof Error ? err.message : err);
        bonjourInstance = null;
        bonjourService = null;
    }
}

function stopBonjour(): void {
    try { if (bonjourService?.stop) bonjourService.stop(); } catch { /* ignore */ }
    try { bonjourInstance?.destroy(); } catch { /* ignore */ }
    bonjourService = null;
    bonjourInstance = null;
}

/**
 * Start the announce loop. Call once after the HTTP server is
 * listening. Re-call to update the port (stops the previous loop).
 */
export function startLanAnnounce(opts: { port: number; version: string }): void {
    stopLanAnnounce();
    currentVersion = opts.version;
    startBonjour(opts.port, opts.version);

    const tick = async () => {
        const url = buildLanUrl(opts.port);
        await postAnnounce(url);
        lastAnnouncedUrl = url;
    };
    // Self-rescheduling timer so we can shift between burst (post-command)
    // and idle cadences without tearing down setInterval each time.
    const schedule = () => {
        const interval = Date.now() < burstUntil ? BURST_INTERVAL_MS : RE_ANNOUNCE_INTERVAL_MS;
        timer = setTimeout(async () => {
            await tick();
            schedule();
        }, interval);
    };
    // First announce after a short delay so the user's pairing token
    // (set during /auth/callback) is on disk before we POST.
    setTimeout(() => { void tick().then(schedule); }, 4000);
}

export function stopLanAnnounce(): void {
    if (timer) { clearTimeout(timer); timer = null; }
    lastAnnouncedUrl = null;
    stopBonjour();
}

/** Force an immediate re-announce. Called after pairing completes so
 *  the URL lands in the user's account without waiting 5 minutes. */
export async function announceNow(port: number): Promise<void> {
    const url = buildLanUrl(port);
    lastAnnouncedUrl = url;
    await postAnnounce(url);
}
