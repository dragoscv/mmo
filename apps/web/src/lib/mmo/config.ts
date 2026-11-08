/**
 * How the browser reaches one MMO Server. Resolved server-side from the paired device
 * (`getMmoConnection` in `actions/mmo.ts`: tunnel HTTPS on hosted runtimes, loopback/LAN locally)
 * and handed to client components — the same token the HLS URLs already carry in `?t=`.
 */
export interface ServerConfig {
    /** Base URL without trailing slash. */
    baseUrl: string;
    /** MMO Server device token (`x-device-token` / `?t=`). */
    token: string;
    /** Forwarded as `x-user-id` / `?u=`. */
    userId: string;
    /**
     * Storage scope for per-server browser state (active profile, cached home). "" = the legacy unscoped keys
     * (the account's server, so existing users keep their state); guest/other servers use their host (WP17-99).
     */
    scope?: string;
}

/** `base` for the legacy scope, `base@scope` otherwise. */
export function scopedKey(base: string, scope: string | undefined): string {
    return scope ? `${base}@${scope}` : base;
}
