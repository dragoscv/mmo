/**
 * LAN servers from the desktop shells (D59, WP17-97/100). An https page (music.mixai.ro inside the Tauri window)
 * cannot fetch an http://192.168.x server, so the shell runs a tiny loopback proxy and tells the page which local
 * URL stands for which LAN server; it also lists servers it discovered with mDNS. Outside the shells: no-ops.
 *
 * Shell commands (remote capability on music.mixai.ro / tv.mixai.ro only):
 *   desktop_lan_proxy {target}  → "http://127.0.0.1:<port>/s/<id>"   (proxy base for an http LAN server)
 *   desktop_lan_servers         → [{name, url}]                       (mDNS `_mmo-companion._tcp`)
 */
import { isTauri, tauriInvoke } from "@/lib/tauri-bridge";

export interface LanServer { name: string; url: string }

export function hasDesktopLan(): boolean {
    return isTauri();
}

/**
 * The URL the page should use for `target` (an http LAN server). Loopback http counts as a potentially trustworthy
 * origin, so an https page may fetch it. Returns null outside the shells or when the shell refuses the target.
 */
export async function desktopServerUrl(target: string): Promise<string | null> {
    if (!isTauri()) return null;
    const r = await tauriInvoke<string>("desktop_lan_proxy", { target }).catch(() => null);
    return typeof r === "string" && /^http:\/\/127\.0\.0\.1:\d+\/s\/[a-z0-9]+$/.test(r) ? r : null;
}

export async function desktopLanServers(): Promise<LanServer[]> {
    if (!isTauri()) return [];
    const r = await tauriInvoke<LanServer[]>("desktop_lan_servers").catch(() => null);
    return Array.isArray(r) ? r.filter((s) => s && typeof s.url === "string" && typeof s.name === "string") : [];
}
