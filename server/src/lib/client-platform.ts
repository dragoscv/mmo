/**
 * Client platforms (WP16-50). Sent as `platform` on pairing (`/pair/request`), hub `hello`
 * and device-code sign-in. Unknown strings are kept (sanitised) for forward compatibility,
 * but only the values below get a form factor.
 */

export const CLIENT_PLATFORMS = ["android-tv", "tizen", "web", "android-phone", "ios", "desktop", "android"] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

export type FormFactor = "tv" | "phone" | "web" | "desktop" | "unknown";

const ALIASES: Record<string, ClientPlatform> = {
    "androidtv": "android-tv", "google-tv": "android-tv", "googletv": "android-tv",
    "android_phone": "android-phone", "androidphone": "android-phone",
    "iphone": "ios", "ipad": "ios", "ipados": "ios",
    "samsung-tv": "tizen",
};

/** Lower-cased, trimmed, aliases folded; anything else sanitised to `[a-z0-9._-]{1,32}` or `fallback`. */
export function normalizePlatform(v: unknown, fallback = "unknown"): string {
    if (typeof v !== "string") return fallback;
    const s = v.trim().toLowerCase();
    if ((CLIENT_PLATFORMS as readonly string[]).includes(s)) return s;
    if (ALIASES[s]) return ALIASES[s]!;
    const clean = s.replace(/[^a-z0-9._-]/g, "").slice(0, 32);
    return clean || fallback;
}

export function formFactorOf(platform: string): FormFactor {
    switch (platform) {
        case "android-tv": case "tizen": return "tv";
        case "android-phone": case "ios": case "android": return "phone";
        case "web": case "web-guest": return "web";
        case "desktop": return "desktop";
        default: return "unknown";
    }
}

/**
 * True when the device may be offered as a "Play on …" target. TVs, desktops and web players
 * are targets; phones only when they explicitly advertise the `playback` capability.
 */
export function isPlaybackTarget(d: { platform: string; caps: string[]; guest?: boolean }): boolean {
    if (d.guest) return false;
    const ff = formFactorOf(d.platform);
    if (ff === "phone") return d.caps.includes("playback");
    return true;
}
