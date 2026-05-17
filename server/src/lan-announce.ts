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

// 30 s heartbeat. Doubles as the liveness signal for /devices on the
// web app: Vercel can't reach the user's LAN to do an active probe,
// so this push-based tick is what flips the green dot on/off. Keep
// it well below the web app's 90 s freshness threshold.
const RE_ANNOUNCE_INTERVAL_MS = 30 * 1000;
const SERVICE_NAME = "MMO Companion";
const SERVICE_TYPE = "mmo-companion";

let timer: NodeJS.Timeout | null = null;
let bonjourInstance: Bonjour | null = null;
let bonjourService: Service | null = null;
let lastAnnouncedUrl: string | null = null;
let currentVersion = "0.0.0";
let onDeviceNameCb: ((name: string) => void) | null = null;

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

    try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 8000);
        const res = await fetch(`${webAppUrl}/api/devices/announce`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                token,
                lanUrl,
                hostname: os.hostname(),
                os: process.platform,
                version: currentVersion,
            }),
            signal: ac.signal,
        }).finally(() => clearTimeout(t));
        // 401 = the cloud no longer recognises our token (device row
        // deleted, key rotated, or never inserted because pairing
        // half-failed). Fire the callback so main can wipe state and
        // prompt the user to re-pair instead of looping forever.
        if (res.status === 401 && onAuthInvalidatedCb) {
            try { onAuthInvalidatedCb("announce-401"); } catch { /* ignore */ }
            return;
        }
        // Sync the user-chosen device name back to the companion so the
        // UI / tray can display the same label that shows on /devices.
        if (res.ok && onDeviceNameCb) {
            try {
                const data = await res.json() as { name?: string };
                if (data?.name) onDeviceNameCb(data.name);
            } catch { /* response wasn't JSON; ignore */ }
        }
    } catch {
        // Network down, paired but cloud unreachable — try again next tick.
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
        // Always POST every tick so `lastSeenAt` keeps refreshing on
        // the cloud (that's how /devices flips the green dot on/off).
        // The 30 s tick rate is cheap enough; conditional skips would
        // make the device look offline whenever the URL is stable.
        await postAnnounce(url);
        lastAnnouncedUrl = url;
    };
    // First announce after a short delay so the user's pairing token
    // (set during /auth/callback) is on disk before we POST.
    setTimeout(() => { void tick(); }, 4000);
    timer = setInterval(() => { void tick(); }, RE_ANNOUNCE_INTERVAL_MS);
}

export function stopLanAnnounce(): void {
    if (timer) { clearInterval(timer); timer = null; }
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
