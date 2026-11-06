import type { PlatformKey, SuiteProductKey } from "./products";

/**
 * Where each live platform chip points (WP17-12). Internal routes are host-mapped by the caller; `null` = no
 * destination yet (chip renders as "coming soon"). Store URLs only for published IDs (ADR-0013).
 */
const PLAY_PHONE = "https://play.google.com/store/apps/details?id=ro.mixai.app";

export function platformHref(product: SuiteProductKey, platform: PlatformKey): string | null {
    if (platform === "web") {
        if (product === "tv") return "/media";
        if (product === "music") return "/media/music";
        if (product === "studio") return "/dashboard";
        return null;
    }
    if (product === "tv" && platform === "android") return PLAY_PHONE;
    if (product === "tv" && (platform === "androidTv" || platform === "tizen")) return "/get#tv";
    if (product === "server") return platform === "docker" || platform === "pi" ? "/get#server" : "/get#companion";
    if (product === "studio" && platform === "chrome") return "/get#extension";
    if (product === "studio" || product === "dj") return "/get#native";
    return null;
}
