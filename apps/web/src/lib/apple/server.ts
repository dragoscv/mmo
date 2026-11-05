import { makeAppleClientSecret } from "./client-secret";

/**
 * Apple server-to-server calls for Sign in with Apple (env-gated):
 *   APPLE_TEAM_ID (default S6D533QSV2), APPLE_KEY_ID, APPLE_PRIVATE_KEY (.p8 PEM),
 *   AUTH_APPLE_ID (Services ID, web), APPLE_BUNDLE_ID (default ro.mixai.app, native).
 * Without the key every call is a no-op that reports `unconfigured`.
 */

const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
const TIMEOUT_MS = 8000;

export interface AppleKeyConfig {
    teamId: string;
    keyId: string;
    privateKey: string;
}

export function appleKeyConfig(env: NodeJS.ProcessEnv = process.env): AppleKeyConfig | null {
    const keyId = env.APPLE_KEY_ID?.trim();
    const privateKey = env.APPLE_PRIVATE_KEY?.trim();
    if (!keyId || !privateKey) return null;
    return { teamId: env.APPLE_TEAM_ID?.trim() || "S6D533QSV2", keyId, privateKey };
}

export const appleBundleId = (env: NodeJS.ProcessEnv = process.env) => env.APPLE_BUNDLE_ID?.trim() || "ro.mixai.app";

/** Client ids a refresh token may belong to: native bundle id first, then the web Services ID. */
export function appleClientIds(env: NodeJS.ProcessEnv = process.env): string[] {
    return [...new Set([appleBundleId(env), env.AUTH_APPLE_ID?.trim()].filter((v): v is string => !!v))];
}

function secretFor(cfg: AppleKeyConfig, clientId: string): string {
    return makeAppleClientSecret({ ...cfg, clientId, ttlSec: 300 });
}

type FetchLike = typeof fetch;

/** Exchange a native `authorizationCode` for a refresh token (needed later to revoke). */
export async function exchangeAppleCode(
    code: string,
    opts: { fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<{ refreshToken: string | null } | { error: "unconfigured" | "exchange_failed" }> {
    const env = opts.env ?? process.env;
    const cfg = appleKeyConfig(env);
    if (!cfg) return { error: "unconfigured" };
    const clientId = appleBundleId(env);
    try {
        const res = await (opts.fetchImpl ?? fetch)(APPLE_TOKEN_URL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: clientId, client_secret: secretFor(cfg, clientId), code, grant_type: "authorization_code" }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) return { error: "exchange_failed" };
        const j = (await res.json()) as { refresh_token?: string };
        return { refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : null };
    } catch {
        return { error: "exchange_failed" };
    }
}

/**
 * Revoke a Sign in with Apple refresh token (App Store guideline 5.1.1(v): deleting the
 * account must also revoke the Apple credential). We do not record which client id the
 * token was issued to, so try each configured one until Apple accepts.
 */
export async function revokeAppleToken(
    refreshToken: string,
    opts: { fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<"revoked" | "unconfigured" | "failed"> {
    const env = opts.env ?? process.env;
    const cfg = appleKeyConfig(env);
    if (!cfg) return "unconfigured";
    for (const clientId of appleClientIds(env)) {
        try {
            const res = await (opts.fetchImpl ?? fetch)(APPLE_REVOKE_URL, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: clientId,
                    client_secret: secretFor(cfg, clientId),
                    token: refreshToken,
                    token_type_hint: "refresh_token",
                }),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (res.ok) return "revoked";
        } catch { /* try the next client id */ }
    }
    return "failed";
}
