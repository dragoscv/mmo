/**
 * Auth.js session cookie per host (WP17-10, D41). Pure.
 *
 * On `mixai.ro` and every `*.mixai.ro` host the session cookie is scoped to `.mixai.ro` so one sign-in covers
 * MixAI, TV, Music, Studio and DJ. It also gets a NEW name: the pre-WP17 host-only `__Secure-authjs.session-token`
 * on `mixai.ro` would otherwise shadow (or outlive a sign-out of) the domain cookie with the same name. The cost
 * is one re-login on the apex (owner accepted, 2026-11-06).
 *
 * Any other host (run.app, localhost, LAN) keeps the Auth.js defaults, so store builds and e2e harnesses that set
 * `authjs.session-token` / `__Secure-authjs.session-token` keep working.
 */
import { isProductDomain, normalizeHost, ROOT_DOMAIN } from "./products";

export interface SessionCookie {
    name: string;
    domain?: string;
    secure: boolean;
}

export const PRODUCT_SESSION_COOKIE = "__Secure-mixai.session-token";

export function sessionCookieFor(host: string | null | undefined, secure: boolean, rootDomain = ROOT_DOMAIN): SessionCookie {
    if (isProductDomain(host, rootDomain) && secure) {
        return { name: PRODUCT_SESSION_COOKIE, domain: `.${rootDomain}`, secure: true };
    }
    return { name: secure ? "__Secure-authjs.session-token" : "authjs.session-token", secure };
}

/**
 * Auth.js `cookies` override for a host. Only the session token moves to the shared domain; the PKCE / state /
 * nonce / callback-url / csrf cookies stay host-only (they belong to the origin that started the OAuth flow).
 */
export function authCookiesFor(host: string | null | undefined, secure: boolean, rootDomain = ROOT_DOMAIN) {
    const c = sessionCookieFor(host, secure, rootDomain);
    if (!c.domain) return undefined;
    return {
        sessionToken: {
            name: c.name,
            options: { httpOnly: true, sameSite: "lax" as const, path: "/", secure: true, domain: c.domain },
        },
    };
}

/**
 * Same-site redirect check for the Auth.js `redirect` callback: same origin, or (when the current host is a
 * product host) any `https://*.mixai.ro` origin.
 */
export function isAllowedRedirect(url: string, baseUrl: string, rootDomain = ROOT_DOMAIN): boolean {
    try {
        const target = new URL(url);
        const base = new URL(baseUrl);
        if (target.origin === base.origin) return true;
        return target.protocol === "https:" && isProductDomain(base.hostname, rootDomain) && isProductDomain(target.hostname, rootDomain);
    } catch {
        return false;
    }
}

export { normalizeHost };
