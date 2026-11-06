/**
 * MixAI product family (ADR-0013) — one list drives the suite landing, the download matrix and the signed-in
 * launcher. `accent` is a design-token custom property (never a hex), `internal` the route the launcher opens
 * (mapped to the product host by `hrefFor`).
 */
import { Clapperboard, Disc3, Headphones, LayoutDashboard, Server, type LucideIcon } from "lucide-react";

export type SuiteProductKey = "tv" | "music" | "studio" | "dj" | "server";

export interface SuiteProduct {
    key: SuiteProductKey;
    icon: LucideIcon;
    accent: string;
    /** Internal route the launcher opens (host-mapped), or an absolute URL. */
    internal: string;
    /** Platforms listed in the download matrix, in display order. */
    platforms: readonly PlatformKey[];
}

export type PlatformKey =
    | "web" | "android" | "ios" | "androidTv" | "fireTv" | "tizen" | "webos" | "appleTv"
    | "windows" | "macos" | "linux" | "docker" | "pi" | "chrome";

export const SUITE_PRODUCTS: readonly SuiteProduct[] = [
    { key: "tv", icon: Clapperboard, accent: "var(--chart-1)", internal: "/media",
        platforms: ["web", "androidTv", "tizen", "android", "ios", "windows", "macos", "linux", "fireTv", "webos", "appleTv"] },
    { key: "music", icon: Headphones, accent: "var(--chart-2)", internal: "/media/music",
        platforms: ["web", "android", "ios", "windows", "macos", "linux"] },
    { key: "studio", icon: LayoutDashboard, accent: "var(--chart-3)", internal: "/dashboard",
        platforms: ["web", "windows", "macos", "linux", "chrome"] },
    { key: "dj", icon: Disc3, accent: "var(--chart-4)", internal: "/dj",
        platforms: ["windows", "macos", "linux"] },
    { key: "server", icon: Server, accent: "var(--chart-5)", internal: "/get",
        platforms: ["windows", "macos", "linux", "docker", "pi"] },
] as const;

/** Platform availability today (D43). `soon` = package built or in review, not yet in a store. */
export const PLATFORM_STATUS: Record<SuiteProductKey, Partial<Record<PlatformKey, "live" | "soon">>> = {
    tv: { web: "live", androidTv: "live", tizen: "live", android: "live", ios: "soon", windows: "soon", macos: "soon", linux: "soon", fireTv: "soon", webos: "soon", appleTv: "soon" },
    music: { web: "live", android: "soon", ios: "soon", windows: "soon", macos: "soon", linux: "soon" },
    studio: { web: "live", windows: "live", macos: "live", linux: "live", chrome: "live" },
    dj: { windows: "live", macos: "live", linux: "live" },
    server: { windows: "live", macos: "live", linux: "live", docker: "live", pi: "live" },
};

/** Best guess of the visitor's platform from the UA (client only; `null` = unknown). */
export function detectPlatform(ua: string): PlatformKey | null {
    const s = ua.toLowerCase();
    if (/tizen/.test(s)) return "tizen";
    if (/web0s|webos/.test(s)) return "webos";
    if (/aft[a-z]/.test(s)) return "fireTv";
    if (/android/.test(s) && /tv|bravia|aftm|googletv/.test(s)) return "androidTv";
    if (/android/.test(s)) return "android";
    if (/iphone|ipad|ipod/.test(s)) return "ios";
    if (/apple ?tv/.test(s)) return "appleTv";
    if (/windows/.test(s)) return "windows";
    if (/mac os x|macintosh/.test(s)) return "macos";
    if (/cros/.test(s)) return "chrome";
    if (/linux/.test(s)) return "linux";
    return null;
}

/** Launcher order: last used first, then the canonical order. */
export function orderByLastUsed(recent: readonly SuiteProductKey[]): SuiteProduct[] {
    const rank = (k: SuiteProductKey) => { const i = recent.indexOf(k); return i < 0 ? 100 + SUITE_PRODUCTS.findIndex((p) => p.key === k) : i; };
    return [...SUITE_PRODUCTS].sort((a, b) => rank(a.key) - rank(b.key));
}
