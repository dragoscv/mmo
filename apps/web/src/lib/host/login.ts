/**
 * Central sign-in (WP17-10). OAuth redirect URIs (Google, Apple Services ID) are registered for the apex, so every
 * product host signs in on `https://mixai.ro/login` with an ABSOLUTE callback back to itself; the `.mixai.ro`
 * session cookie then covers the origin host. Pure.
 */
import { hrefFor, isProductDomain, productOrigin, ROOT_DOMAIN, type HostKind, type Product } from "./products";

/**
 * Callback accepted by `/login`: a same-origin path, or (on a product host) an absolute `https://*.mixai.ro` URL.
 * Anything else becomes `/`.
 */
export function safeCallback(raw: string | string[] | undefined, current: HostKind, rootDomain = ROOT_DOMAIN): string {
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (!v) return "/";
    if (v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\")) return v;
    if (current === "legacy") return "/";
    try {
        const u = new URL(v);
        if (u.protocol === "https:" && isProductDomain(u.hostname, rootDomain)) return u.toString();
    } catch { /* not a URL */ }
    return "/";
}

/**
 * Where `/login` on `current` should send the browser instead of rendering, or `null` to render here.
 * Product hosts other than the apex go to the apex login with an absolute callback on their own host.
 */
export function centralLoginUrl(current: HostKind, callback: string, rootDomain = ROOT_DOMAIN): string | null {
    if (current === "legacy" || current === "suite") return null;
    const origin = productOrigin(current as Product, rootDomain);
    let abs = callback;
    if (!/^https:\/\//.test(callback)) {
        const mapped = hrefFor(callback, current, rootDomain);
        abs = /^https:\/\//.test(mapped) ? mapped : `${origin}${mapped}`;
    }
    return `${productOrigin("suite", rootDomain)}/login?callbackUrl=${encodeURIComponent(abs)}`;
}
