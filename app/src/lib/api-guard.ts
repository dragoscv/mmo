/**
 * Tiny auth + rate-limit guards for /api/* route handlers.
 *
 * Centralized here so every route gets identical 401/429 shapes and so
 * we don't sprinkle ad-hoc `if (!session) return new Response(..)` all
 * over the codebase. Use these as the FIRST line of every mutating
 * handler:
 *
 *   const guard = await requireSession(req);
 *   if (guard.response) return guard.response;
 *   const userId = guard.userId;
 *
 * `requireSessionWithRate` combines the session check with a per-user
 * rate limit (falls back to per-IP for anonymous traffic so anonymous
 * floods on auth-required endpoints still get blunted).
 */

import { auth } from "@/auth";
import { rateLimit, ipFromRequest } from "@/lib/rate-limit";

interface SessionGuard {
    response: Response | null;
    userId: string | null;
}

const UNAUTH_BODY = JSON.stringify({ error: "unauthorized" });
const UNAUTH_HEADERS = { "content-type": "application/json" } as const;

export async function requireSession(_req: Request): Promise<SessionGuard> {
    const session = await auth();
    if (!session?.user?.id) {
        return {
            response: new Response(UNAUTH_BODY, { status: 401, headers: UNAUTH_HEADERS }),
            userId: null,
        };
    }
    return { response: null, userId: session.user.id };
}

/** Module-scoped limiters per "bucket". Same bucket name → same map → same budget. */
const limiters = new Map<string, ReturnType<typeof rateLimit>>();
function limiterFor(bucket: string, windowMs: number, max: number) {
    const key = `${bucket}:${windowMs}:${max}`;
    let lim = limiters.get(key);
    if (!lim) {
        lim = rateLimit({ windowMs, max, name: bucket });
        limiters.set(key, lim);
    }
    return lim;
}

interface GuardOptions {
    /** Logical name for the bucket (e.g. "analysis", "downloads"). */
    bucket: string;
    /** Window length in ms. Default: 60s. */
    windowMs?: number;
    /** Max calls per window per user (or per IP if anonymous). Default: 30. */
    max?: number;
}

/** Combined session + per-user rate limit. Use for authed mutating routes. */
export async function requireSessionWithRate(
    req: Request,
    opts: GuardOptions,
): Promise<SessionGuard> {
    const guard = await requireSession(req);
    if (guard.response) return guard;
    const lim = limiterFor(opts.bucket, opts.windowMs ?? 60_000, opts.max ?? 30);
    const blocked = lim.check(`u:${guard.userId}`);
    if (blocked) return { response: blocked, userId: null };
    return guard;
}

/** Rate-limit only (no auth check). Use for endpoints that have their
 *  own auth (e.g. device tokens) but still need flood protection. */
export function requireRate(req: Request, opts: GuardOptions): Response | null {
    const lim = limiterFor(opts.bucket, opts.windowMs ?? 60_000, opts.max ?? 60);
    return lim.check(`ip:${ipFromRequest(req)}`);
}
