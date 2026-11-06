import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hostRoutingEnabled, routeRequest } from "@/lib/host/products";

/** Staging/preview can mount the product hosts under another root (`MIXAI_ROOT_DOMAIN=staging.mixai.ro`). */
const ROOT = process.env.MIXAI_ROOT_DOMAIN?.trim() || undefined;

export function proxy(request: NextRequest) {
    const { pathname, search } = request.nextUrl;
    if (!pathname.startsWith("/api/")) {
        if (!hostRoutingEnabled()) return NextResponse.next();
        // WP17-10 host routing (tv./music./app./dj./apex). Legacy hosts (run.app, localhost) → unchanged.
        const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host");
        const d = routeRequest(host, pathname, search, ROOT);
        if (d.type === "redirect") return NextResponse.redirect(d.url, d.status);
        if (d.type === "rewrite") {
            const url = request.nextUrl.clone();
            url.pathname = d.path;
            return NextResponse.rewrite(url);
        }
        return NextResponse.next();
    }
    const headers = new Headers(request.headers);
    const host = headers.get("host") || "";
    const xfh = headers.get("x-forwarded-host");
    const xfp = headers.get("x-forwarded-proto");

    // VS Code dev tunnel sends: host=localhost:13789, x-forwarded-host=<tunnel>, x-forwarded-proto=https
    // Auth.js can mix host port with x-forwarded-host hostname → https://tunnel:3000
    // Fix: override host to match x-forwarded-host so no stale port leaks through
    if (xfh && xfp && xfh.includes("devtunnels.ms")) {
        headers.set("host", xfh);
        return NextResponse.next({ request: { headers } });
    }

    // Tunnel where only host header is the tunnel URL (no x-forwarded-*)
    if (!xfh && host.includes("devtunnels.ms")) {
        headers.set("x-forwarded-host", host);
        headers.set("x-forwarded-proto", "https");
        headers.set("host", host);
        return NextResponse.next({ request: { headers } });
    }

    // Localhost with stray x-forwarded-proto (no x-forwarded-host)
    // → strip it to prevent Auth.js from generating https://localhost:13789
    if (xfp && !xfh && (host.startsWith("localhost") || host.startsWith("127.0.0.1"))) {
        headers.delete("x-forwarded-proto");
        return NextResponse.next({ request: { headers } });
    }

    return NextResponse.next();
}

export const config = {
    // Auth API (tunnel header fix) + every page path; static assets and Next internals never reach the proxy.
    matcher: [
        "/api/auth/:path*",
        "/api/companion-auth",
        "/((?!api/|_next/|__offline/|fonts/|offline/|.*\\.[a-z0-9]+$).*)",
    ],
};
