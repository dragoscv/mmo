/** Connection settings persisted in localStorage (survives app restarts on Tizen). */

export interface ServerConfig {
    /** Base URL without trailing slash, e.g. `http://192.168.100.61:17899`. */
    baseUrl: string;
    /** MMO Server device token (`x-device-token`). */
    token: string;
    /** User id forwarded as `x-user-id` / `?u=` (optional — the server falls back to the paired user). */
    userId: string;
}

const KEY = "mixai-tv:server";
export const DEFAULT_PORT = 17899;

export function normalizeBaseUrl(input: string): string {
    let s = input.trim();
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = "http://" + s;
    // Host without port → default MMO Server port.
    const m = /^(https?:\/\/)([^/:]+)(:\d+)?(\/.*)?$/i.exec(s);
    if (m && !m[3]) s = `${m[1]}${m[2]}:${DEFAULT_PORT}`;
    return s.replace(/\/+$/, "");
}

export function loadConfig(): ServerConfig | null {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return null;
        const j = JSON.parse(raw) as Partial<ServerConfig>;
        if (typeof j.baseUrl !== "string" || typeof j.token !== "string") return null;
        return { baseUrl: j.baseUrl, token: j.token, userId: typeof j.userId === "string" ? j.userId : "" };
    } catch {
        return null;
    }
}

export function saveConfig(cfg: ServerConfig): void {
    localStorage.setItem(KEY, JSON.stringify(cfg));
}

export function clearConfig(): void {
    localStorage.removeItem(KEY);
}

// ─── MixAI account session (device-code sign-in on mixai.ro) ─────────────

export interface SessionUser {
    id: string;
    name: string | null;
    image: string | null;
}

export interface Session {
    sessionToken: string;
    /** ISO date from `/api/device/token` (`expires`). */
    expires: string;
    user: SessionUser;
}

const SESSION_KEY = "mixai-tv:session";
const ORIGIN_KEY = "mixai.origin";
export const DEFAULT_ORIGIN = "https://mixai.ro";

/** Web origin for the device-code flow; overridable for dev/tests via `localStorage["mixai.origin"]`. */
export function mixaiOrigin(): string {
    try {
        const v = localStorage.getItem(ORIGIN_KEY)?.trim();
        return v ? v.replace(/\/+$/, "") : DEFAULT_ORIGIN;
    } catch {
        return DEFAULT_ORIGIN;
    }
}

/** Host shown in user-facing messages ("mixai.ro"). */
export function mixaiHost(): string {
    const m = /^https?:\/\/([^/]+)/i.exec(mixaiOrigin());
    return m?.[1] ?? "mixai.ro";
}

export function loadSession(): Session | null {
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const j = JSON.parse(raw) as Partial<Session>;
        if (typeof j.sessionToken !== "string" || !j.user || typeof j.user.id !== "string") return null;
        return {
            sessionToken: j.sessionToken,
            expires: typeof j.expires === "string" ? j.expires : "",
            user: { id: j.user.id, name: j.user.name ?? null, image: j.user.image ?? null },
        };
    } catch {
        return null;
    }
}

export function saveSession(s: Session): void {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function clearSession(): void {
    localStorage.removeItem(SESSION_KEY);
}
