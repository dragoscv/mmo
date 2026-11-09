import { NextResponse } from "next/server";

import { requireRate } from "@/lib/api-guard";
import { SHAZAM_APPS, currentShazamToken, shazamKeyConfig } from "@/lib/shazam/token";

/**
 * GET /api/shazam/token — ShazamKit developer token for MixAI Key & BPM on Android (WP18-17).
 * Anonymous by design (the app has no account): gated by the `x-mixai-app` header and a per-IP
 * rate limit. The token only authorises Shazam catalog matching for our Media ID.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export function GET(request: Request): Response {
    const limited = requireRate(request, { bucket: "shazam-token", windowMs: 60 * 60_000, max: 30 });
    if (limited) return limited;

    const app = request.headers.get("x-mixai-app")?.trim() ?? "";
    if (!SHAZAM_APPS.has(app)) {
        return NextResponse.json({ error: "unknown_app" }, { status: 400, headers: NO_STORE });
    }
    const cfg = shazamKeyConfig();
    if (!cfg) {
        return NextResponse.json({ error: "shazam_not_configured" }, { status: 503, headers: NO_STORE });
    }
    const { token, expiresAt } = currentShazamToken(cfg, Math.floor(Date.now() / 1000));
    return NextResponse.json({ token, expiresAt }, { headers: NO_STORE });
}
