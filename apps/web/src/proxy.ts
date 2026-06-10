import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(request: NextRequest) {
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
    matcher: ["/api/auth/:path*", "/api/companion-auth"],
};
