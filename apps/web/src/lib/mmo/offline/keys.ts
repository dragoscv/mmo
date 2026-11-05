/**
 * Offline downloads (WP16-42) — keys, cache names and synthetic URLs. Pure, shared by the page code,
 * the service worker (`sw-handlers.ts`) and the static offline shell (`public/offline/downloads.js`
 * mirrors the constants — keep them in sync).
 *
 * Layout in Cache Storage `mixai-offline-v1` (never keyed by a server URL, so tokens never land in a key):
 *   /__offline/<enc key>/m        manifest JSON `{ size, parts, type }` — present only when complete
 *   /__offline/<enc key>/p/<n>    part n of the original file bytes (≤ PART_SIZE each)
 *   /__offline/<enc key>/poster   poster image (optional)
 * The SW answers `/__offline/<enc key>` (what `<video src>` uses) by stitching the parts, with Range support.
 */

export const OFFLINE_CACHE = "mixai-offline-v1";
export const SHELL_CACHE = "mixai-offline-shell-v1";
export const OFFLINE_PREFIX = "/__offline/";
export const DOWNLOADS_ROUTE = "/media/downloads";
export const SHELL_PAGE = "/offline/downloads.html";
export const SHELL_ASSETS: readonly string[] = [SHELL_PAGE, "/offline/downloads.js"];
/** Public files the shell page links (tokens/theme). Cached with it; served from it only for shell documents. */
export const SHELL_DEPS: readonly string[] = ["/globals.css", "/prehydrate.js", "/icon-192.png"];

export const IDB_NAME = "mixai-offline";
export const IDB_VERSION = 1;
export const IDB_STORE = "items";

export type OfflineKind = "movie" | "episode" | "track";
export const OFFLINE_KINDS: readonly OfflineKind[] = ["movie", "episode", "track"];

export interface KeyParts {
    serverId: string;
    profileId: string;
    kind: OfflineKind;
    id: string;
}

const enc = encodeURIComponent;

function dec(s: string): string | null {
    try { return decodeURIComponent(s); } catch { return null; }
}

/** `${serverId}:${profileId}:${kind}:${id}` with each free-form part URI-encoded (so `:` inside stays unambiguous). */
export function buildKey(p: KeyParts): string {
    if (!p.serverId || !p.profileId || !p.id) throw new Error("offline key needs serverId, profileId and id");
    if (!OFFLINE_KINDS.includes(p.kind)) throw new Error(`unknown offline kind ${String(p.kind)}`);
    return `${enc(p.serverId)}:${enc(p.profileId)}:${p.kind}:${enc(p.id)}`;
}

export function parseKey(key: string): KeyParts | null {
    const parts = key.split(":");
    if (parts.length !== 4) return null;
    const [s, pr, kind, id] = parts as [string, string, string, string];
    if (!OFFLINE_KINDS.includes(kind as OfflineKind)) return null;
    const serverId = dec(s);
    const profileId = dec(pr);
    const rawId = dec(id);
    if (!serverId || !profileId || !rawId) return null;
    return { serverId, profileId, kind: kind as OfflineKind, id: rawId };
}

/** Scope = one server + one profile (the downloads list is per active profile). */
export function scopeOf(serverId: string, profileId: string): string {
    return `${enc(serverId)}:${enc(profileId)}`;
}

export function scopeOfKey(key: string): string {
    const i = key.indexOf(":", key.indexOf(":") + 1);
    return i < 0 ? key : key.slice(0, i);
}

export const mediaUrl = (key: string): string => OFFLINE_PREFIX + enc(key);
export const posterUrl = (key: string): string => `${mediaUrl(key)}/poster`;
export const manifestUrl = (key: string): string => `${mediaUrl(key)}/m`;
export const partUrl = (key: string, n: number): string => `${mediaUrl(key)}/p/${n}`;
/** Every cache entry of one download starts with this. */
export const entryPrefix = (key: string): string => `${mediaUrl(key)}/`;

/** `/__offline/<enc key>[/poster]` → key + what is asked. Internal entries (`/m`, `/p/n`) are not served. */
export function parseOfflinePath(pathname: string): { key: string; sub: "media" | "poster" } | null {
    if (!pathname.startsWith(OFFLINE_PREFIX)) return null;
    const rest = pathname.slice(OFFLINE_PREFIX.length);
    const segs = rest.split("/");
    const key = segs[0] ? dec(segs[0]) : null;
    if (!key || !parseKey(key)) return null;
    if (segs.length === 1) return { key, sub: "media" };
    if (segs.length === 2 && segs[1] === "poster") return { key, sub: "poster" };
    return null;
}

/** Query params that carry MMO Server credentials (`?t=&u=` on /video/*, `apiKey` on Subsonic). */
export type AuthParam = "t" | "u" | "apiKey";
const AUTH_PARAMS: readonly AuthParam[] = ["t", "u", "apiKey"];

export interface ServerCreds {
    token: string;
    userId: string;
}

/**
 * Removes credentials from a media URL so the record we persist holds no token. `auth` remembers which
 * params to put back; `creds` are the values found (kept in memory only).
 */
export function stripAuth(url: string): { url: string; auth: AuthParam[]; creds: Partial<ServerCreds> } {
    const u = new URL(url);
    const auth: AuthParam[] = [];
    const creds: Partial<ServerCreds> = {};
    for (const p of AUTH_PARAMS) {
        const v = u.searchParams.get(p);
        if (v === null) continue;
        auth.push(p);
        if (p === "u") creds.userId = v;
        else creds.token = v;
        u.searchParams.delete(p);
    }
    return { url: u.toString(), auth, creds };
}

/** Inverse of `stripAuth` with the current server credentials. */
export function applyAuth(url: string, auth: readonly AuthParam[], creds: ServerCreds): string {
    const u = new URL(url);
    for (const p of auth) {
        const v = p === "u" ? creds.userId : creds.token;
        if (v) u.searchParams.set(p, v);
    }
    return u.toString();
}
