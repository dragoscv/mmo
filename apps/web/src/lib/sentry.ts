/**
 * Optional Sentry shim.
 *
 * If `SENTRY_DSN` is set we lazy-load `@sentry/nextjs` (kept as an
 * optional peer dependency to keep the default install lean) and forward
 * captured exceptions. If not set, the captureException call is a no-op,
 * so importing this module never makes outbound network requests on a
 * self-hosted deployment that doesn't want telemetry.
 *
 * To enable: add SENTRY_DSN to .env, install @sentry/nextjs, and create
 * the standard sentry.client.config.ts / sentry.server.config.ts files.
 * This shim covers everything reachable from logger.ts and arbitrary
 * server actions; the official SDK does the rest (route tracing, etc.).
 */

interface SentryLike {
    captureException(err: unknown, hint?: { extra?: Record<string, unknown> }): void;
}

let _sentry: SentryLike | null | undefined;
let _attempted = false;

async function load(): Promise<SentryLike | null> {
    if (_attempted) return _sentry ?? null;
    _attempted = true;
    if (!process.env.SENTRY_DSN) {
        _sentry = null;
        return null;
    }
    try {
        // Use a literal-string dynamic import so bundlers don't try to
        // resolve `@sentry/nextjs` at build time when it's not installed.
        const mod = (await import(/* webpackIgnore: true */ "@sentry/nextjs" as string).catch(() => null)) as
            | SentryLike
            | null;
        _sentry = mod ?? null;
        return _sentry;
    } catch {
        _sentry = null;
        return null;
    }
}

export function captureException(err: unknown, extra?: Record<string, unknown>): void {
    void load().then((sentry) => {
        try {
            sentry?.captureException(err, extra ? { extra } : undefined);
        } catch {
            // Sentry itself failing must never break the caller.
        }
    });
}
