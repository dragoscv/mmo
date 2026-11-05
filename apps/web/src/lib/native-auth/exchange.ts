import { NextResponse } from "next/server";
import { log } from "@/lib/logger";
import { findOrCreateUserForIdentity, mintSession } from "./session";
import { IdTokenError, type VerifiedIdentity } from "./verify";

/**
 * Shared tail of the native token-exchange routes: verified identity → user → session.
 * Response shape mirrors /api/device/token (`session_token`, `expires`, `user`) and adds
 * camelCase aliases (`sessionToken`) for the newer native clients.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;
export const jsonNoStore = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function completeNativeSignIn(
    verify: () => Promise<VerifiedIdentity>,
    extra: { name?: string | null; refreshToken?: () => Promise<string | null> } = {},
): Promise<NextResponse> {
    let identity: VerifiedIdentity;
    try {
        identity = await verify();
    } catch (e) {
        if (e instanceof IdTokenError) {
            if (e.code === "misconfigured") return jsonNoStore({ error: "provider_unavailable" }, 503);
            return jsonNoStore({ error: e.code }, 401);
        }
        log.warn("[native-auth] verify crashed", {}, e);
        return jsonNoStore({ error: "invalid_token" }, 401);
    }
    const refreshToken = extra.refreshToken ? await extra.refreshToken() : null;
    const found = await findOrCreateUserForIdentity(identity, { name: extra.name ?? null, refreshToken });
    if ("error" in found) return jsonNoStore({ error: found.error }, 409);
    const s = await mintSession(found.userId);
    log.info("[native-auth] signed in", { provider: identity.provider, userId: found.userId, created: found.created });
    return jsonNoStore({
        session_token: s.sessionToken,
        sessionToken: s.sessionToken,
        expires: s.expires.toISOString(),
        user: { id: s.user.id, name: s.user.name, email: s.user.email, image: s.user.image },
        created: found.created,
    });
}
