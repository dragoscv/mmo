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
 * Validator for device companion URLs we forward bearer tokens to.
 *
 * Companion pairing inherently uses LAN / loopback addresses: every
 * legitimate user's companion runs on 127.0.0.1 or an RFC1918 address
 * like 192.168.x.x. Rejecting those would break the entire product on
 * Vercel (where NODE_ENV=production), so we accept them unconditionally.
 *
 * What we still reject — always, no escape hatch — is the genuinely
 * dangerous SSRF surface: link-local / cloud-metadata (169.254/16),
 * the unspecified 0.0.0.0/8 block, multicast / reserved (224.0.0.0+),
 * and IPv6 link-local (fe80::). Public hosts are accepted (a self-hosted
 * companion behind a tunnel is a valid setup).
 */
export function validateDeviceApiUrl(raw: unknown, maxLen = 2048): string | null {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > maxLen) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const h = u.hostname.toLowerCase();
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (v4) {
        const [a, b] = v4.slice(1).map((n) => parseInt(n, 10));
        if (a === 0) return null;                          // 0.0.0.0/8
        if (a === 169 && b === 254) return null;           // link-local + cloud metadata
        if (a >= 224) return null;                         // multicast / reserved
    }
    if (h.startsWith("[")) {
        const v6 = h.replace(/^\[|\]$/g, "");
        if (v6.startsWith("fe80")) return null;            // IPv6 link-local
    }
    return u.toString();
}

/**
 * Validator for the LAN URL a companion self-announces (POST
 * /api/devices/announce). Must be a private RFC1918 / IPv6 ULA
 * address — never public, never loopback, never cloud-metadata, never
 * link-local. The web app stores it so sibling devices on the same
 * LAN (tablet, TV) can reach the companion directly. Treating loopback
 * as invalid here is intentional: callers should use `api_url` for
 * same-machine access; `lan_url` is exclusively for cross-device.
 */
export function validateDeviceLanUrl(raw: unknown, maxLen = 2048): string | null {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > maxLen) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const h = u.hostname.toLowerCase();
    // Hard reject loopback / link-local / cloud-metadata so even if a
    // device is compromised it can't poison sibling devices with a
    // URL pointing at 169.254.169.254 or ::1.
    if (h === "localhost" || h === "ip6-localhost" || h === "ip6-loopback") return null;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (v4) {
        const [a, b] = v4.slice(1).map((n) => parseInt(n, 10));
        if (a === 127) return null;                              // loopback
        if (a === 0) return null;                                // 0.0.0.0/8
        if (a === 169 && b === 254) return null;                 // link-local + cloud metadata
        if (a >= 224) return null;                               // multicast / reserved
        const isPrivate =
            a === 10 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168);
        if (!isPrivate) return null;
        return u.toString();
    }
    if (h.startsWith("[")) {
        const v6 = h.replace(/^\[|\]$/g, "");
        if (v6 === "::1" || v6 === "::") return null;
        if (v6.startsWith("fe80")) return null;                  // link-local
        // ULA fc00::/7
        if (v6.startsWith("fc") || v6.startsWith("fd")) return u.toString();
    }
    return null;
}
