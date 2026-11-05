import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRate } from "@/lib/api-guard";
import { exchangeAppleCode } from "@/lib/apple/server";
import { completeNativeSignIn, jsonNoStore } from "@/lib/native-auth/exchange";
import { appleAudiences, verifyAppleIdentityToken } from "@/lib/native-auth/verify";

/**
 * POST /api/auth/native/apple — Sign in with Apple from the iOS app.
 * Body: {identityToken, nonce (RAW nonce whose SHA-256 the app put in the request),
 *        authorizationCode? (exchanged for a refresh token so account deletion can revoke it),
 *        fullName? (Apple sends the name only on the first consent)}.
 * → 200 {session_token, sessionToken, expires, user} · 400 invalid_request · 401 invalid_token |
 *   nonce_mismatch · 409 link_conflict | email_required · 429 rate_limited.
 * The identity token is verified against Apple's JWKS (iss appleid.apple.com, aud = bundle id).
 */

export const dynamic = "force-dynamic";
// Static segments take precedence over the Auth.js catch-all `api/auth/[...nextauth]`.

const BodySchema = z.object({
    identityToken: z.string().min(20).max(8192),
    nonce: z.string().min(8).max(256),
    authorizationCode: z.string().min(8).max(1024).optional(),
    fullName: z.object({
        givenName: z.string().max(100).nullish(),
        familyName: z.string().max(100).nullish(),
    }).optional(),
});

export async function POST(req: NextRequest) {
    const limited = requireRate(req, { bucket: "native-auth", windowMs: 60_000, max: 20 });
    if (limited) return limited;
    let raw: unknown;
    try { raw = await req.json(); } catch { raw = null; }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) return jsonNoStore({ error: "invalid_request" }, 400);
    const b = parsed.data;
    const name = [b.fullName?.givenName, b.fullName?.familyName].filter(Boolean).join(" ") || null;
    return completeNativeSignIn(
        () => verifyAppleIdentityToken(b.identityToken, { audiences: appleAudiences(), rawNonce: b.nonce }),
        {
            name,
            refreshToken: b.authorizationCode
                ? async () => {
                    const r = await exchangeAppleCode(b.authorizationCode as string);
                    return "refreshToken" in r ? r.refreshToken : null;
                }
                : undefined,
        },
    );
}
