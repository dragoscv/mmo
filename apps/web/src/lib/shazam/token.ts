import { signEs256Jwt } from "@/lib/apple/client-secret";

/**
 * ShazamKit for Android developer token (WP18-17, D69): an ES256 JWT signed with the team's
 * Media Services key (Media ID media.ro.mixai.keybpm). Short-lived (12 h) so a leaked token is
 * worth little; the app caches it and refreshes before expiry.
 */
export const SHAZAM_TOKEN_TTL_SEC = 12 * 60 * 60;
/** Re-sign when less than this is left, so clients never receive a nearly-expired token. */
export const SHAZAM_TOKEN_REFRESH_SEC = 60 * 60;
/** Clients allowed to ask for a token (header `x-mixai-app`). */
export const SHAZAM_APPS = new Set(["keybpm-android", "keybpm-ios"]);

export interface ShazamKeyConfig {
    teamId: string;
    keyId: string;
    privateKey: string;
}

export function shazamKeyConfig(env: NodeJS.ProcessEnv = process.env): ShazamKeyConfig | null {
    const keyId = env.SHAZAM_KEY_ID?.trim();
    const privateKey = env.SHAZAM_PRIVATE_KEY?.trim();
    if (!keyId || !privateKey) return null;
    return { teamId: env.SHAZAM_TEAM_ID?.trim() || env.APPLE_TEAM_ID?.trim() || "S6D533QSV2", keyId, privateKey };
}

export interface ShazamToken {
    token: string;
    /** Unix seconds. */
    expiresAt: number;
}

export function makeShazamToken(cfg: ShazamKeyConfig, nowSec: number): ShazamToken {
    const expiresAt = nowSec + SHAZAM_TOKEN_TTL_SEC;
    return { token: signEs256Jwt(cfg.keyId, { iss: cfg.teamId, iat: nowSec, exp: expiresAt }, cfg.privateKey), expiresAt };
}

let cached: (ShazamToken & { keyId: string }) | null = null;

/** Module-scoped cache: one signature per instance per ~11 h instead of one per request. */
export function currentShazamToken(cfg: ShazamKeyConfig, nowSec: number): ShazamToken {
    if (!cached || cached.keyId !== cfg.keyId || cached.expiresAt - nowSec < SHAZAM_TOKEN_REFRESH_SEC) {
        cached = { ...makeShazamToken(cfg, nowSec), keyId: cfg.keyId };
    }
    return { token: cached.token, expiresAt: cached.expiresAt };
}

export function __resetShazamTokenCache(): void {
    cached = null;
}
