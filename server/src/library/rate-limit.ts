/**
 * Tiny in-memory IP-based rate limiter. No external deps — the
 * companion is single-user and runs on localhost, so a simple fixed
 * window per route is sufficient. Built primarily to throttle
 * external-facing flows (TMDB image cache, scraper / subs lookups)
 * so a runaway client can't hammer upstream providers.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";

interface Bucket {
    count: number;
    resetAt: number;
}

interface LimiterOptions {
    /** Window length in ms. Default 60_000 (1 minute). */
    windowMs?: number;
    /** Max requests per window per key. Default 60. */
    max?: number;
    /** Key function — defaults to remote IP. */
    keyFn?: (req: Request) => string;
}

/**
 * Create a rate-limit middleware. Each route gets its own bucket map.
 * Returns 429 with `Retry-After` when the limit is exceeded.
 */
export function rateLimit({ windowMs = 60_000, max = 60, keyFn }: LimiterOptions = {}): RequestHandler {
    const buckets = new Map<string, Bucket>();
    return (req: Request, res: Response, next: NextFunction) => {
        const key = keyFn ? keyFn(req) : (req.ip ?? req.socket.remoteAddress ?? "unknown");
        const now = Date.now();
        let b = buckets.get(key);
        if (!b || b.resetAt <= now) {
            b = { count: 0, resetAt: now + windowMs };
            buckets.set(key, b);
        }
        b.count++;
        res.setHeader("X-RateLimit-Limit", String(max));
        res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - b.count)));
        res.setHeader("X-RateLimit-Reset", String(Math.ceil(b.resetAt / 1000)));
        if (b.count > max) {
            res.setHeader("Retry-After", String(Math.max(1, Math.ceil((b.resetAt - now) / 1000))));
            res.status(429).json({ error: "rate limited" });
            return;
        }
        next();
    };
}
