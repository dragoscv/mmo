/**
 * Quick Connect from the browser (D59, WP17-96) — the requester side, mirrors tv-tizen `lib/pair.ts` and
 * `server/src/pair/router.ts`:
 *   GET  /pair/info                            → {name, version, pairingSupported, hasToken}
 *   POST /pair/request {deviceName, platform}  → 201 {code, secret, expiresAt, qr, approveUrl}
 *   GET  /pair/poll?code&secret                → {status: pending|approved|expired, deviceToken?, userId?}
 */
export interface PairInfo { name: string; version: string | null; pairingSupported: boolean; hasToken: boolean }
export interface PairRequest { code: string; secret: string; expiresAt: number; qr: string; approveUrl: string }
export type PairPoll =
    | { status: "pending" }
    | { status: "expired" }
    | { status: "approved"; deviceToken: string; userId: string | null };

export type PairErrorKind = "unreachable" | "not-mmo" | "no-token" | "http";
export class PairError extends Error {
    constructor(readonly kind: PairErrorKind, message: string) { super(message); }
}

export const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 8000;

type Fetch = typeof fetch;

async function call(f: Fetch, url: string, init?: RequestInit): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        return await f(url, { ...init, signal: ctl.signal, cache: "no-store" });
    } catch (e) {
        throw new PairError("unreachable", e instanceof Error ? e.message : String(e));
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchPairInfo(baseUrl: string, f: Fetch = fetch): Promise<PairInfo> {
    const res = await call(f, `${baseUrl}/pair/info`);
    if (!res.ok) throw new PairError(res.status === 404 ? "not-mmo" : "http", `${res.status}`);
    const j = (await res.json().catch(() => null)) as Partial<PairInfo> | null;
    if (!j || j.pairingSupported !== true) throw new PairError("not-mmo", "no pairing");
    return { name: typeof j.name === "string" ? j.name : "", version: typeof j.version === "string" ? j.version : null, pairingSupported: true, hasToken: j.hasToken !== false };
}

export async function requestPair(baseUrl: string, deviceName: string, f: Fetch = fetch): Promise<PairRequest> {
    const res = await call(f, `${baseUrl}/pair/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceName, platform: "web" }),
    });
    if (res.status === 503) throw new PairError("no-token", "server not initialised");
    if (!res.ok) throw new PairError("http", `${res.status}`);
    const j = (await res.json()) as Partial<PairRequest>;
    if (typeof j.code !== "string" || typeof j.secret !== "string") throw new PairError("not-mmo", "bad pair response");
    return {
        code: j.code, secret: j.secret,
        expiresAt: typeof j.expiresAt === "number" ? j.expiresAt : Date.now() + 5 * 60_000,
        qr: typeof j.qr === "string" ? j.qr : "",
        approveUrl: typeof j.approveUrl === "string" ? j.approveUrl : "",
    };
}

export async function pollPair(baseUrl: string, code: string, secret: string, f: Fetch = fetch): Promise<PairPoll> {
    const q = `code=${encodeURIComponent(code)}&secret=${encodeURIComponent(secret)}`;
    const res = await call(f, `${baseUrl}/pair/poll?${q}`);
    if (res.status === 404 || res.status === 410) return { status: "expired" };
    if (!res.ok) throw new PairError("http", `${res.status}`);
    const j = (await res.json()) as { status?: string; deviceToken?: string; userId?: string | null };
    if (j.status === "approved" && typeof j.deviceToken === "string" && j.deviceToken) {
        return { status: "approved", deviceToken: j.deviceToken, userId: typeof j.userId === "string" ? j.userId : null };
    }
    if (j.status === "expired") return { status: "expired" };
    return { status: "pending" };
}

/** "123456" → "123 456" (how the TV apps and the companion show it). */
export function formatPairCode(code: string): string {
    return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
