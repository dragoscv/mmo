/**
 * Companion pairing HTTP client + pure matching helpers.
 *
 * Mirrors the module-private `call()` in `companion-control.ts` but is kept
 * free of `server-only` / `auth` / `db` imports so it can be unit-tested
 * with a mocked `fetch`. The server action in `actions/pair.ts` resolves
 * the device (URL + token) and hands it here.
 *
 * Companion endpoints (MMO Server):
 *   GET  /pair/pending   (X-Device-Token) → { requests: PendingPairRequest[] }
 *   POST /pair/approve   (X-Device-Token) { code } → { ok: true }
 *   GET  /pair/info      (no auth)        → PairInfo
 */

export interface PendingPairRequest {
    code: string;
    deviceName: string;
    platform: string;
    createdAt: string;
    expiresAt: string;
}

export interface PairInfo {
    name: string;
    version: string;
    lanUrl: string;
    port: number;
    pairingSupported: boolean;
    hasToken: boolean;
}

export type PairErrorCode = "not_found" | "unauthorized" | "expired" | "unreachable" | "failed";

export class PairError extends Error {
    constructor(public readonly code: PairErrorCode, message?: string) {
        super(message ?? code);
        this.name = "PairError";
    }
}

export interface CompanionTarget {
    apiUrl: string;
    token: string;
}

export const PAIR_CODE_RE = /^\d{6}$/;

function statusToCode(status: number): PairErrorCode {
    if (status === 401 || status === 403) return "unauthorized";
    if (status === 404) return "not_found";
    if (status === 410) return "expired";
    return "failed";
}

async function call<T>(
    target: CompanionTarget,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
    fetchImpl: typeof fetch = fetch,
): Promise<T> {
    const headers: Record<string, string> = { "X-Device-Token": target.token };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
        res = await fetchImpl(`${target.apiUrl.replace(/\/+$/, "")}${path}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
            cache: "no-store",
        });
    } catch (e) {
        throw new PairError("unreachable", e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) {
        let detail = "";
        try { detail = ((await res.json()) as { error?: string }).error ?? ""; } catch { /* ignore */ }
        // The companion may express "expired" as a 4xx with a message.
        const code = /expire/i.test(detail) ? "expired" : statusToCode(res.status);
        throw new PairError(code, detail || `Companion ${method} ${path} failed (${res.status})`);
    }
    return (await res.json()) as T;
}

export const companionPair = {
    async pending(target: CompanionTarget, fetchImpl?: typeof fetch): Promise<PendingPairRequest[]> {
        // Server ships `{pending:[…]}` (server/src/pair); the original brief said `{requests:[…]}` — accept both.
        const r = await call<{ requests?: PendingPairRequest[]; pending?: PendingPairRequest[] }>(
            target, "GET", "/pair/pending", undefined, 10_000, fetchImpl,
        );
        return r.requests ?? r.pending ?? [];
    },
    async approve(target: CompanionTarget, code: string, fetchImpl?: typeof fetch): Promise<{ ok: true }> {
        if (!PAIR_CODE_RE.test(code)) throw new PairError("not_found", "Invalid code");
        await call<{ ok?: boolean }>(target, "POST", "/pair/approve", { code }, 10_000, fetchImpl);
        return { ok: true };
    },
    async info(apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<PairInfo> {
        const res = await fetchImpl(`${apiUrl.replace(/\/+$/, "")}/pair/info`, {
            signal: AbortSignal.timeout(5_000),
            cache: "no-store",
        });
        if (!res.ok) throw new PairError(statusToCode(res.status));
        return (await res.json()) as PairInfo;
    },
};

/** Hostname (lower-cased, no brackets) of a URL, or null when unparsable. */
export function urlHost(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    } catch {
        return null;
    }
}

/** Port of a URL, honouring scheme defaults, or null when unparsable. */
export function urlPort(url: string | null | undefined): number | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        if (u.port) return Number(u.port);
        return u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : null;
    } catch {
        return null;
    }
}

export interface MatchableDevice {
    id: string;
    lanUrl: string | null;
    apiUrl: string | null;
}

/**
 * Pick the user's companion device whose `lanUrl` / `apiUrl` host matches
 * the host encoded in the TV's QR. Port is a tiebreaker only (the LAN URL
 * may be announced on a different port than the one the QR carries).
 * When nothing matches but the user owns exactly ONE companion, use it.
 */
export function matchCompanionByHost<T extends MatchableDevice>(
    candidates: T[],
    host: string,
    port?: number | null,
): T | null {
    const want = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
    const byHost = candidates.filter((d) => urlHost(d.lanUrl) === want || urlHost(d.apiUrl) === want);
    if (byHost.length === 1) return byHost[0]!;
    if (byHost.length > 1) {
        if (port) {
            const exact = byHost.find((d) => urlPort(d.lanUrl) === port || urlPort(d.apiUrl) === port);
            if (exact) return exact;
        }
        return byHost[0]!;
    }
    return candidates.length === 1 ? candidates[0]! : null;
}
