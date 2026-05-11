/**
 * Server-side URL safety helpers shared across routes that take a
 * user-supplied URL and either fetch it themselves or hand it off to a
 * subprocess (yt-dlp, ffmpeg, scanner). The threat model is SSRF: an
 * attacker-supplied URL pointed at internal infrastructure (cloud
 * metadata 169.254.169.254, k8s API, RDS, neighbouring tenants, the
 * companion on localhost, the sync worker) lets the attacker exfiltrate
 * data, scan internal ports, or bypass network ACLs.
 *
 * Two flavours:
 *   - {@link isPrivateOrLoopbackHost} — predicate, exported for tests.
 *   - {@link validatePublicHttpUrl} — strict: always rejects private,
 *     loopback, link-local, multicast. Used for genuinely-external
 *     fetches like yt-dlp media URLs.
 *   - {@link validateDeviceApiUrl} — same checks but with an opt-in
 *     escape hatch (`MMO_ALLOW_PRIVATE_DEVICE_URLS=1`) for self-hosted
 *     LAN deployments where the companion DOES live on a private IP.
 *     Default-allows in non-production so localhost dev still works.
 */
import "server-only";

const DEVICE_ALLOW_PRIVATE = process.env.MMO_ALLOW_PRIVATE_DEVICE_URLS === "1"
    || process.env.NODE_ENV !== "production";

export function isPrivateOrLoopbackHost(hostname: string): boolean {
    const h = hostname.toLowerCase();
    if (h === "localhost" || h === "ip6-localhost" || h === "ip6-loopback") return true;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (v4) {
        const [a, b] = v4.slice(1).map((n) => parseInt(n, 10));
        if (a === 10) return true;
        if (a === 127) return true;                              // loopback
        if (a === 0) return true;                                // 0.0.0.0/8
        if (a === 169 && b === 254) return true;                 // link-local + cloud metadata
        if (a === 172 && b >= 16 && b <= 31) return true;        // RFC1918 172.16/12
        if (a === 192 && b === 168) return true;                 // RFC1918 192.168/16
        if (a >= 224) return true;                               // multicast / reserved
    }
    if (h.startsWith("[")) {
        const v6 = h.replace(/^\[|\]$/g, "");
        if (v6 === "::1" || v6 === "::") return true;
        if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // ULA
        if (v6.startsWith("fe80")) return true;                       // link-local
    }
    return false;
}

/**
 * Strict validator for URLs we will hand to the public internet
 * (yt-dlp, web scrapers, redirect targets). No private hosts, ever.
 * Returns the canonicalised URL string, or null if rejected.
 */
export function validatePublicHttpUrl(raw: unknown, maxLen = 2048): string | null {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > maxLen) return null;
    // Reject any leading `-` so the value can never be misread as a CLI
    // flag by a downstream subprocess (yt-dlp, ffmpeg). Defence in depth
    // even though we always pass `--` before user URLs.
    if (raw.startsWith("-")) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (isPrivateOrLoopbackHost(u.hostname)) return null;
    return u.toString();
}

/**
 * Validator for device companion URLs we forward bearer tokens to. Same
 * shape but honours {@link DEVICE_ALLOW_PRIVATE} since a self-hosted
 * companion legitimately listens on a private IP.
 */
export function validateDeviceApiUrl(raw: unknown, maxLen = 2048): string | null {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > maxLen) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!DEVICE_ALLOW_PRIVATE && isPrivateOrLoopbackHost(u.hostname)) return null;
    return u.toString();
}
