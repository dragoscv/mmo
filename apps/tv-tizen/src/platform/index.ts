/**
 * Platform adapter (WP17-23/25, ADR-0013 D46). One TV-web codebase, several hosts:
 *   tizen   — Samsung Smart Hub widget (webapis / tizen globals)
 *   desktop — MixAI TV desktop (Tauri 2: Windows MSIX, macOS, Linux); native bits via `invoke`
 *   webos   — LG webOS TV (`.ipk`, appinfo.json; webOSTV.js `webOS` global, `PalmSystem` on device)
 *   browser — plain browser (dev, e2e)
 * Screens and libs call these helpers instead of touching `tizen` / `webapis` directly.
 */

export type PlatformKind = "tizen" | "webos" | "desktop" | "browser";

interface TauriInternals { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> }
interface WebOsGlobal {
    deviceInfo?(cb: (info: { modelName?: string; brandName?: string }) => void): void;
    platformBack?(): void;
}

function webos(): WebOsGlobal | null {
    const w = (globalThis as { webOS?: WebOsGlobal }).webOS;
    return w ?? null;
}
function palm(): { platformBack?(): void } | null {
    return (globalThis as { PalmSystem?: { platformBack?(): void } }).PalmSystem ?? null;
}

function tauri(): TauriInternals | null {
    const t = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
    return t && typeof t.invoke === "function" ? t : null;
}

export function platformKind(): PlatformKind {
    if (typeof tizen !== "undefined" && tizen) return "tizen";
    if (tauri()) return "desktop";
    if (webos() || palm() || /web0s|webos/i.test(navigator.userAgent)) return "webos";
    return "browser";
}

/** `platform` sent to `POST /pair/request` (server logs + device list icon). */
export function pairPlatform(): string {
    const k = platformKind();
    return k === "browser" ? "web" : k;
}

// ─── Desktop info, resolved once at boot (`initPlatform`) so callers stay synchronous ───────────

interface DesktopInfo { os: string; host: string; ip: string | null; netmask: string | null }
let desktop: DesktopInfo | null = null;
let lgModel: string | null = null;

/** Call before the first render. Resolves immediately outside Tauri; never throws. */
export async function initPlatform(): Promise<void> {
    const w = webos();
    if (w?.deviceInfo) {
        await new Promise<void>((resolve) => {
            const done = setTimeout(resolve, 800);
            try { w.deviceInfo!((info) => { lgModel = info.modelName ?? null; clearTimeout(done); resolve(); }); } catch { clearTimeout(done); resolve(); }
        });
        return;
    }
    const t = tauri();
    if (!t) return;
    try {
        desktop = await t.invoke<DesktopInfo>("platform_info");
    } catch {
        desktop = { os: "desktop", host: "", ip: null, netmask: null };
    }
}

function tizenModel(): string | null {
    try {
        const t = (globalThis as { tizen?: { systeminfo?: { getCapability(k: string): unknown } } }).tizen;
        const m = t?.systeminfo?.getCapability("http://tizen.org/system/model_name");
        if (typeof m === "string" && m) return m;
    } catch { /* not on Tizen */ }
    try {
        const m = typeof webapis !== "undefined" ? webapis?.productinfo?.getModel() : undefined;
        if (m) return m;
    } catch { /* ignore */ }
    return null;
}

const OS_LABEL: Record<string, string> = { windows: "Windows", macos: "Mac", linux: "Linux" };

/** Short device label for the hub / device list ("Samsung QN90", "Windows PC", "Mac"). */
export function deviceLabel(): string {
    const k = platformKind();
    if (k === "tizen") { const m = tizenModel(); return m ? `Samsung ${m}` : "Samsung TV"; }
    if (k === "desktop") {
        const os = OS_LABEL[desktop?.os ?? ""] ?? "Desktop";
        return desktop?.host ? `${desktop.host} (${os})` : os === "Windows" ? "Windows PC" : os;
    }
    if (k === "webos") return lgModel ? `LG ${lgModel}` : "LG TV";
    return "Browser";
}

/** This device's IPv4 + netmask for the LAN sweep, or `null` when the platform cannot tell. */
export function localNetwork(): { ip: string; netmask: string } | null {
    if (platformKind() === "desktop") {
        return desktop?.ip ? { ip: desktop.ip, netmask: desktop.netmask ?? "255.255.255.0" } : null;
    }
    try {
        const net = typeof webapis !== "undefined" ? webapis?.network : undefined;
        if (!net) return null;
        const ip = net.getIp();
        if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null;
        let netmask = "255.255.255.0";
        try { const m = net.getSubnetMask?.(); if (m && /^\d+\.\d+\.\d+\.\d+$/.test(m)) netmask = m; } catch { /* keep /24 */ }
        return { ip, netmask };
    } catch {
        return null;
    }
}

/** Leaves the app (Tizen exit, desktop window close). */
export function exitApp(): void {
    try {
        if (typeof tizen !== "undefined" && tizen?.application) {
            tizen.application.getCurrentApplication().exit();
            return;
        }
    } catch { /* fallthrough */ }
    // LG: webOS.platformBack() / PalmSystem.platformBack() returns to the launcher (window.close is ignored).
    const lg = webos()?.platformBack ? webos() : palm();
    if (lg?.platformBack) { try { lg.platformBack(); return; } catch { /* fallthrough */ } }
    const t = tauri();
    if (t) { void t.invoke("plugin:window|close", { label: "main" }).catch(() => window.close()); return; }
    window.close();
}

/** Desktop + browser use a mouse: enables hover-to-focus and wheel navigation (focus.ts). */
export function hasPointer(): boolean {
    const k = platformKind();
    return k === "desktop" || k === "browser";
}
