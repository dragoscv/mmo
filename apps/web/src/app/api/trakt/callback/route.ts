import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { saveTraktTokens } from "@/actions/trakt";

/**
 * Trakt OAuth callback. Exchanges the `code` for tokens and stores them
 * in `user_preferences.trakt.tokens`, then redirects back to the page
 * specified by `state` (defaults to /watch/settings).
 */
export async function GET(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "/watch/settings";
    if (!userId) return NextResponse.redirect(new URL("/login?error=trakt-needs-auth", url.origin));
    if (!code) return NextResponse.redirect(new URL(`${state}?trakt=cancelled`, url.origin));

    const clientId = process.env.TRAKT_CLIENT_ID;
    const clientSecret = process.env.TRAKT_CLIENT_SECRET;
    const base = process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL || url.origin;
    if (!clientId || !clientSecret) {
        return NextResponse.redirect(new URL(`${state}?trakt=not-configured`, url.origin));
    }

    try {
        const resp = await fetch("https://api.trakt.tv/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: `${base.replace(/\/$/, "")}/api/trakt/callback`,
                grant_type: "authorization_code",
            }),
            signal: AbortSignal.timeout(6000),
        });
        if (!resp.ok) {
            return NextResponse.redirect(new URL(`${state}?trakt=exchange-failed`, url.origin));
        }
        const j = await resp.json() as { access_token: string; refresh_token: string; expires_in: number; scope?: string };
        await saveTraktTokens(userId, {
            accessToken: j.access_token,
            refreshToken: j.refresh_token,
            expiresIn: j.expires_in,
            scope: j.scope,
        });
        return NextResponse.redirect(new URL(`${state}?trakt=connected`, url.origin));
    } catch {
        return NextResponse.redirect(new URL(`${state}?trakt=error`, url.origin));
    }
}
