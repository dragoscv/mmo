import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRate } from "@/lib/api-guard";
import { completeNativeSignIn, jsonNoStore } from "@/lib/native-auth/exchange";
import { googleAudiences, verifyGoogleIdToken } from "@/lib/native-auth/verify";

/**
 * POST /api/auth/native/google — Google sign-in from the Android app (Credential Manager).
 * Body: {idToken, nonce?}. aud must be AUTH_GOOGLE_ID (the web client the app requests the
 * token for) or one of GOOGLE_NATIVE_CLIENT_IDS. Same responses as /api/auth/native/apple.
 */

export const dynamic = "force-dynamic";

const BodySchema = z.object({
    idToken: z.string().min(20).max(8192),
    nonce: z.string().min(8).max(256).optional(),
});

export async function POST(req: NextRequest) {
    const limited = requireRate(req, { bucket: "native-auth", windowMs: 60_000, max: 20 });
    if (limited) return limited;
    let raw: unknown;
    try { raw = await req.json(); } catch { raw = null; }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) return jsonNoStore({ error: "invalid_request" }, 400);
    const { idToken, nonce } = parsed.data;
    return completeNativeSignIn(() => verifyGoogleIdToken(idToken, { audiences: googleAudiences(), nonce }));
}
