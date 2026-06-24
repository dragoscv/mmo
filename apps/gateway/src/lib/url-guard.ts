/**
 * SSRF guard for the LAN URL a companion self-announces.
 * Ported verbatim from apps/web/src/lib/url-guard.ts (validateDeviceLanUrl).
 *
 * Must be a private RFC1918 / IPv6 ULA address — never public, never
 * loopback, never cloud-metadata, never link-local.
 */

export function validateDeviceLanUrl(raw: unknown, maxLen = 2048): string | null {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > maxLen) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h === "ip6-localhost" || h === "ip6-loopback") return null;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (v4) {
        const [a, b] = v4.slice(1).map((n) => parseInt(n, 10));
        if (a === 127) return null;                              // loopback
        if (a === 0) return null;                                // 0.0.0.0/8
        if (a === 169 && b === 254) return null;                 // link-local + cloud metadata
        if (a! >= 224) return null;                              // multicast / reserved
        const isPrivate =
            a === 10 ||
            (a === 172 && b! >= 16 && b! <= 31) ||
            (a === 192 && b === 168);
        if (!isPrivate) return null;
        return u.toString();
    }
    if (h.startsWith("[")) {
        const v6 = h.replace(/^\[|\]$/g, "");
        if (v6 === "::1" || v6 === "::") return null;
        if (v6.startsWith("fe80")) return null;                  // link-local
        if (v6.startsWith("fc") || v6.startsWith("fd")) return u.toString(); // ULA
    }
    return null;
}
