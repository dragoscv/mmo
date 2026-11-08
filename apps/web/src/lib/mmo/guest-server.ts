/**
 * Servers connected WITHOUT a MixAI account (D59, WP17-96/99). The browser pairs itself with Quick Connect
 * (`POST /pair/request` → `GET /pair/poll`, same as the TV apps) and keeps the device token here, so music.mixai.ro
 * and tv.mixai.ro work for store reviewers (demo.mixai.ro) and for people who only run their own server.
 *
 * localStorage `mixai-web:guest-servers` = `{ active: baseUrl | null, servers: GuestServer[] }`. Kept out of the
 * shared `mixai:prefs:v1` blob on purpose (that one is read by prehydrate.js on every surface).
 */
import type { MmoConnection } from "@/actions/mmo";

export const GUEST_SERVERS_KEY = "mixai-web:guest-servers";
export const GUEST_CHANGED_EVENT = "mixai:guest-servers";
export const DEMO_SERVER_URL = "https://demo.mixai.ro";
const MAX_SERVERS = 10;

export interface GuestServer {
    baseUrl: string;
    token: string;
    userId: string;
    name: string;
    pairedAt: number;
}

export interface GuestState {
    active: string | null;
    servers: GuestServer[];
}

const EMPTY: GuestState = { active: null, servers: [] };

/**
 * Normalises what a user typed into a server base URL, or null when it is not one.
 * `demo.mixai.ro` → `https://demo.mixai.ro`; a bare LAN host keeps http + :17899 (only usable from the desktop
 * shells, see `needsDesktopProxy`); paths, queries and trailing slashes are dropped.
 */
export function normalizeServerUrl(input: string): string | null {
    const raw = input.trim();
    if (!raw) return null;
    const isLan = (host: string) =>
        /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|[^.]+\.local$)/i.test(host) || /^[^.]+$/.test(host);
    let withScheme = raw;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
        const host = raw.split(/[/:?#]/)[0] ?? "";
        withScheme = `${isLan(host) ? "http" : "https"}://${raw}`;
    }
    let u: URL;
    try { u = new URL(withScheme); } catch { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname || u.username || u.password) return null;
    if (u.protocol === "http:" && !u.port && isLan(u.hostname)) u.port = "17899";
    return `${u.protocol}//${u.host}`;
}

/** An https page cannot fetch an http server (mixed content) unless a desktop shell proxies it (WP17-97). */
export function needsDesktopProxy(baseUrl: string, pageProtocol: string): boolean {
    return pageProtocol === "https:" && baseUrl.startsWith("http://");
}

export function parseGuestState(raw: string | null): GuestState {
    if (!raw) return EMPTY;
    try {
        const j = JSON.parse(raw) as Partial<GuestState>;
        const servers = Array.isArray(j.servers)
            ? j.servers.filter((s): s is GuestServer =>
                !!s && typeof s.baseUrl === "string" && typeof s.token === "string" && s.token.length > 0)
                .map((s) => ({ baseUrl: s.baseUrl, token: s.token, userId: typeof s.userId === "string" ? s.userId : "",
                    name: typeof s.name === "string" && s.name ? s.name : hostLabel(s.baseUrl), pairedAt: typeof s.pairedAt === "number" ? s.pairedAt : 0 }))
            : [];
        const active = typeof j.active === "string" && servers.some((s) => s.baseUrl === j.active) ? j.active : servers[0]?.baseUrl ?? null;
        return { active, servers };
    } catch {
        return EMPTY;
    }
}

export function hostLabel(baseUrl: string): string {
    try { return new URL(baseUrl).host; } catch { return baseUrl; }
}

/** Adds or refreshes a server (same baseUrl = new token) and makes it active. Newest first, capped. */
export function withServer(state: GuestState, s: GuestServer): GuestState {
    const rest = state.servers.filter((x) => x.baseUrl !== s.baseUrl);
    return { active: s.baseUrl, servers: [s, ...rest].slice(0, MAX_SERVERS) };
}

export function withoutServer(state: GuestState, baseUrl: string): GuestState {
    const servers = state.servers.filter((x) => x.baseUrl !== baseUrl);
    const active = state.active === baseUrl ? servers[0]?.baseUrl ?? null : state.active;
    return { active, servers };
}

export function withActive(state: GuestState, baseUrl: string): GuestState {
    return state.servers.some((s) => s.baseUrl === baseUrl) ? { ...state, active: baseUrl } : state;
}

/** Guest servers as provider connections, active first. `deviceId` is `guest:<host>` (never a DB id). */
export function guestConnections(state: GuestState): MmoConnection[] {
    const order = [...state.servers].sort((a, b) => (a.baseUrl === state.active ? -1 : b.baseUrl === state.active ? 1 : 0));
    return order.map((s) => ({
        baseUrl: s.baseUrl, token: s.token, userId: s.userId, deviceId: `guest:${hostLabel(s.baseUrl)}`, name: s.name, online: true,
    }));
}

export function isGuestConnection(c: Pick<MmoConnection, "deviceId"> | null | undefined): boolean {
    return !!c && c.deviceId.startsWith("guest:");
}

// ─── Browser storage (guarded: SSR, disabled storage) ────────────────────────────────────────────

let cachedRaw: string | null | undefined;
let cachedState: GuestState = EMPTY;

export function readGuestState(): GuestState {
    if (typeof window === "undefined") return EMPTY;
    let raw: string | null = null;
    try { raw = localStorage.getItem(GUEST_SERVERS_KEY); } catch { return EMPTY; }
    if (raw !== cachedRaw) { cachedRaw = raw; cachedState = parseGuestState(raw); }
    return cachedState;
}

export function writeGuestState(state: GuestState): void {
    try {
        if (state.servers.length) localStorage.setItem(GUEST_SERVERS_KEY, JSON.stringify(state));
        else localStorage.removeItem(GUEST_SERVERS_KEY);
    } catch { /* storage disabled */ }
    window.dispatchEvent(new Event(GUEST_CHANGED_EVENT));
}

export function subscribeGuestState(fn: () => void): () => void {
    const onStorage = (e: StorageEvent) => { if (e.key === GUEST_SERVERS_KEY) fn(); };
    window.addEventListener("storage", onStorage);
    window.addEventListener(GUEST_CHANGED_EVENT, fn);
    return () => { window.removeEventListener("storage", onStorage); window.removeEventListener(GUEST_CHANGED_EVENT, fn); };
}

export const EMPTY_GUEST_STATE = EMPTY;
