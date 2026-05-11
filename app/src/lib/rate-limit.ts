/**
 * Lightweight in-memory rate limiter for /api/* routes.
 *
 * Use case: defence-in-depth on a single Vercel/Node instance. NOT a
 * coordinated rate limit across replicas — for that, swap in
 * @upstash/ratelimit or a Redis-backed store. The in-memory variant is
 * deliberately chosen here because:
 *   1. Vercel's Node functions are fairly sticky per region for short
 *      bursts, so per-IP token buckets meaningfully blunt floods.
 *   2. Zero new infra, zero new deps — drop-in for an immediate floor.
 *
 * Algorithm: fixed-window counter per key. Windows are evicted lazily
 * (no timer) so the map can't grow unbounded under sustained traffic
 * (each call cleans one stale entry).
 *
 * Typical use:
 *
 *   import { rateLimit, ipFromRequest } from "@/lib/rate-limit";
 *   const rl = rateLimit({ windowMs: 60_000, max: 30 });
 *   export async function POST(req: Request) {
 *     const limited = rl.check(ipFromRequest(req));
 *     if (limited) return new Response("Too many requests", { status: 429 });
 *     ...
 *   }
 */

interface Bucket {
    count: number;
    expires: number;
}

interface Limiter {
    /** Returns a 429 Response when over budget, otherwise null. */
    check(key: string): Response | null;
}

interface RateLimitOptions {
    /** Window length in ms (e.g. 60_000 for 1 minute). */
    windowMs: number;
    /** Max requests allowed per key per window. */
    max: number;
    /** Optional label included in the 429 body for debugging. */
    name?: string;
}

export function rateLimit(opts: RateLimitOptions): Limiter {
    const buckets = new Map<string, Bucket>();
    return {
        check(key) {
            const now = Date.now();

            // Lazy eviction: pop one expired entry per call. Cheap and
            // amortized — keeps memory bounded under sustained load.
            for (const [k, b] of buckets) {
                if (b.expires <= now) buckets.delete(k);
                break;
            }

            const existing = buckets.get(key);
            if (!existing || existing.expires <= now) {
                buckets.set(key, { count: 1, expires: now + opts.windowMs });
                return null;
            }
            if (existing.count >= opts.max) {
                const retryAfter = Math.ceil((existing.expires - now) / 1000);
                return new Response(
                    JSON.stringify({
                        error: "rate_limited",
                        limit: opts.max,
                        windowMs: opts.windowMs,
                        retryAfterSeconds: retryAfter,
                        bucket: opts.name,
                    }),
                    {
                        status: 429,
                        headers: {
                            "content-type": "application/json",
                            "retry-after": String(retryAfter),
                            "x-ratelimit-limit": String(opts.max),
                            "x-ratelimit-remaining": "0",
                            "x-ratelimit-reset": String(Math.ceil(existing.expires / 1000)),
                        },
                    },
                );
            }
            existing.count += 1;
            return null;
        },
    };
}

/** Best-effort client IP. Falls back to "unknown" so the limiter still
 *  applies a global floor when no header is present (e.g. in dev).
 *
 *  Trust order matters here. `X-Forwarded-For` is set by the *client* and
 *  then appended to by each proxy in the chain, so its leftmost value is
 *  whatever the caller wants it to be — which is the canonical
 *  rate-limit bypass (rotate the header per request to dodge the bucket).
 *  Both Vercel and most reverse proxies inject a separate header
 *  (`x-vercel-forwarded-for` / `x-real-ip`) populated with the *connection*
 *  source, untouched by client input. Prefer those; only fall back to
 *  `X-Forwarded-For` for local dev where no trusted proxy is in front. */
export function ipFromRequest(req: Request): string {
    const vercel = req.headers.get("x-vercel-forwarded-for");
    if (vercel) return vercel.split(",")[0].trim();
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim();
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0].trim();
    return "unknown";
}
